import { redis } from '../../config/redis';
import { TeacherCam, WhiteboardCursorState } from '../../types/broadcast.types';
import { RoomManager } from '../room/room.manager';

export interface ExcalidrawDeltaBroadcast {
  elements: any[];
  appState?: any;
}

export class WhiteboardEngine {
  private static sessionSyncLocks = new Map<string, Promise<any>>();

  private static async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionSyncLocks.get(sessionId) || Promise.resolve();
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const chainedLock = previous.then(() => currentLock).catch(() => currentLock);
    this.sessionSyncLocks.set(sessionId, chainedLock);

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseLock();
      if (this.sessionSyncLocks.get(sessionId) === chainedLock) {
        this.sessionSyncLocks.delete(sessionId);
      }
    }
  }

  private static elementsKey(sessionId: string): string {
    return `room:${sessionId}:excalidraw_elements`;
  }

  private static filesKey(sessionId: string): string {
    return `room:${sessionId}:excalidraw_files`;
  }

  private static cameraKey(sessionId: string): string {
    return `room:${sessionId}:teacher_cam`;
  }

  private static cursorKey(sessionId: string): string {
    return `room:${sessionId}:whiteboard_cursor`;
  }

  /**
   * Calculates auto-fit scale and effective zoom for student viewport (Formula B).
   */
  public static calculateStudentZoom(
    teacherCam: TeacherCam,
    studentViewport: { Ws: number; Hs: number },
    studentZoomMultiplier = 1.0
  ): { Zautofit: number; Zeffective: number; Wworld: number; Hworld: number } {
    const Wworld = teacherCam.Wt / Math.max(teacherCam.Zt, 0.001);
    const Hworld = teacherCam.Ht / Math.max(teacherCam.Zt, 0.001);

    const Zautofit = Math.min(
      studentViewport.Ws / Math.max(Wworld, 1),
      studentViewport.Hs / Math.max(Hworld, 1)
    );

    const clampedMultiplier = Math.min(Math.max(studentZoomMultiplier, 0.5), 3.0);
    const Zeffective = Zautofit * clampedMultiplier;

    return { Zautofit, Zeffective, Wworld, Hworld };
  }

  /**
   * Version-Map Delta Sync: Merges incoming elements into Redis dictionary,
   * keeping only newer versions (element.version > existing.version).
   */
  public static async syncElements(
    sessionId: string,
    incomingElements: any[]
  ): Promise<any[]> {
    if (!Array.isArray(incomingElements) || incomingElements.length === 0) {
      return [];
    }

    return this.withSessionLock(sessionId, async () => {
      const key = this.elementsKey(sessionId);
      const elementIds = incomingElements.map((el) => String(el.id));
      const existingRaw = await redis.hmget(key, ...elementIds);

      const deltaElements: any[] = [];
      const pipeline = redis.pipeline();

      incomingElements.forEach((incoming, idx) => {
        const existingJson = existingRaw[idx];
        let shouldUpdate = false;

        if (!existingJson) {
          shouldUpdate = true;
        } else {
          try {
            const existing = JSON.parse(existingJson);
            const incomingVer = incoming.version ?? 0;
            const existingVer = existing.version ?? 0;
            const isNewerVersion = incomingVer > existingVer;
            const isSameVersionModified =
              incomingVer === existingVer &&
              ((incoming.versionNonce ?? 0) !== (existing.versionNonce ?? 0) ||
                (incoming.index ?? null) !== (existing.index ?? null));
            const isCriticalTransition =
              (Boolean(incoming.isDeleted) && !Boolean(existing.isDeleted)) ||
              (!existing.fileId && Boolean(incoming.fileId));

            if (isNewerVersion || isSameVersionModified || isCriticalTransition) {
              shouldUpdate = true;
              if (incomingVer <= existingVer) {
                incoming = {
                  ...incoming,
                  version: existingVer + 1,
                };
              }
            }
          } catch {
            shouldUpdate = true;
          }
        }

        if (shouldUpdate) {
          deltaElements.push(incoming);
          pipeline.hset(key, String(incoming.id), JSON.stringify(incoming));
        }
      });

      if (deltaElements.length > 0) {
        await pipeline.exec();
        // Record broadcast packet in ring buffer
        await RoomManager.appendPacket(sessionId, 'WHITEBOARD_ELEMENTS_DELTA', {
          elements: deltaElements,
        });
      }

      return deltaElements;
    });
  }

  /**
   * Clears all whiteboard elements and files for a room.
   */
  public static async clearElements(sessionId: string): Promise<void> {
    await redis.del(this.elementsKey(sessionId), this.filesKey(sessionId));
    await RoomManager.appendPacket(sessionId, 'WHITEBOARD_CLEAR', {});
  }

  /**
   * Syncs binary files (images) for Excalidraw image elements.
   */
  public static async syncFiles(
    sessionId: string,
    files: Record<string, any>
  ): Promise<Record<string, any>> {
    if (!files || typeof files !== 'object') return {};
    const entries = Object.entries(files);
    if (entries.length === 0) return {};

    const key = this.filesKey(sessionId);
    const pipeline = redis.pipeline();
    const synced: Record<string, any> = {};

    for (const [fileId, fileData] of entries) {
      if (fileId && fileData?.dataURL) {
        synced[fileId] = fileData;
        pipeline.hset(key, fileId, JSON.stringify(fileData));
      }
    }

    if (Object.keys(synced).length > 0) {
      await pipeline.exec();
      await RoomManager.appendPacket(sessionId, 'WHITEBOARD_FILES_DELTA', {
        files: synced,
      });
    }
    return synced;
  }

  /**
   * Retrieves all binary files (images) for a room.
   */
  public static async getAllFiles(sessionId: string): Promise<Record<string, any>> {
    const key = this.filesKey(sessionId);
    const all = await redis.hgetall(key);
    if (!all) return {};

    const result: Record<string, any> = {};
    for (const [fileId, raw] of Object.entries(all)) {
      try {
        result[fileId] = JSON.parse(raw);
      } catch {
        // ignore malformed entry
      }
    }
    return result;
  }

  /**
   * Layer priority helper so background shapes always sort before text when fractional index ties.
   */
  private static getLayerTypePriority(type?: string): number {
    if (type === 'frame') return 0;
    if (type === 'rectangle' || type === 'diamond' || type === 'ellipse' || type === 'image') {
      return 1;
    }
    if (type === 'line' || type === 'arrow' || type === 'freedraw') return 2;
    if (type === 'text') return 3;
    return 2;
  }

  /**
   * Deterministically orders Excalidraw elements retrieved from Redis HGETALL:
   * 1. Sorts by Excalidraw fractional index in strict ASCII code-unit order ('0'..'9' < 'A'..'Z' < 'a'..'z').
   * 2. Enforces group layer invariant: within any shared groupId (e.g. injected or copy-pasted formula boxes),
   *    background shapes (rectangle/diamond/ellipse) always appear before text elements so solid fills never hide text.
   */
  public static sortElementsForScene(elements: any[]): any[] {
    if (!Array.isArray(elements) || elements.length <= 1) return elements || [];

    const sorted = [...elements].sort((a, b) => {
      const idxA = typeof a?.index === 'string' && a.index.length > 0 ? a.index : null;
      const idxB = typeof b?.index === 'string' && b.index.length > 0 ? b.index : null;

      // If both elements belong to the exact same group, always place shape containers before text
      const grpA = Array.isArray(a?.groupIds) && a.groupIds.length > 0 ? a.groupIds[0] : null;
      const grpB = Array.isArray(b?.groupIds) && b.groupIds.length > 0 ? b.groupIds[0] : null;
      if (grpA && grpA === grpB) {
        const prioA = this.getLayerTypePriority(a?.type);
        const prioB = this.getLayerTypePriority(b?.type);
        if (prioA !== prioB) return prioA - prioB;
      }

      if (idxA && idxB && idxA !== idxB) {
        return idxA < idxB ? -1 : 1;
      }

      const prioA = this.getLayerTypePriority(a?.type);
      const prioB = this.getLayerTypePriority(b?.type);
      if (prioA !== prioB) return prioA - prioB;

      const upA = typeof a?.updated === 'number' ? a.updated : 0;
      const upB = typeof b?.updated === 'number' ? b.updated : 0;
      if (upA !== upB) return upA - upB;

      return String(a?.id || '') < String(b?.id || '') ? -1 : 1;
    });

    // Group pass: guarantee that for any shared groupId, all non-text shapes in that group precede text elements
    const groupTexts = new Map<string, any[]>();
    const groupHasShape = new Set<string>();
    for (const el of sorted) {
      const gid = Array.isArray(el?.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      if (gid && (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse')) {
        groupHasShape.add(gid);
      }
    }

    const result: any[] = [];
    const remainingShapesInGroup = new Map<string, number>();
    for (const el of sorted) {
      const gid = Array.isArray(el?.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      if (gid && groupHasShape.has(gid) && el.type !== 'text') {
        remainingShapesInGroup.set(gid, (remainingShapesInGroup.get(gid) || 0) + 1);
      }
    }

    for (const el of sorted) {
      const gid = Array.isArray(el?.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      if (gid && groupHasShape.has(gid)) {
        if (el.type === 'text' && (remainingShapesInGroup.get(gid) || 0) > 0) {
          // Defer this grouped text until its group's shape container has been pushed
          const list = groupTexts.get(gid) || [];
          list.push(el);
          groupTexts.set(gid, list);
          continue;
        }
        result.push(el);
        if (el.type !== 'text') {
          const left = (remainingShapesInGroup.get(gid) || 1) - 1;
          remainingShapesInGroup.set(gid, left);
          if (left <= 0 && groupTexts.has(gid)) {
            result.push(...(groupTexts.get(gid) || []));
            groupTexts.delete(gid);
          }
        }
      } else {
        result.push(el);
      }
    }

    for (const deferred of groupTexts.values()) {
      result.push(...deferred);
    }

    return result;
  }

  /**
   * Retrieves all current whiteboard elements for a room in deterministic z-index order.
   */
  public static async getAllElements(sessionId: string): Promise<any[]> {
    const key = this.elementsKey(sessionId);
    const all = await redis.hgetall(key);
    if (!all) return [];

    const parsed = Object.values(all)
      .map((str: any) => {
        try {
          return JSON.parse(str);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return this.sortElementsForScene(parsed);
  }

  /**
   * Updates teacher camera position and broadcasts to room.
   */
  public static async updateTeacherCam(
    sessionId: string,
    cam: TeacherCam
  ): Promise<TeacherCam> {
    const key = this.cameraKey(sessionId);
    await redis.set(key, JSON.stringify(cam));

    await RoomManager.appendPacket(sessionId, 'TEACHER_CAM_UPDATE', cam);
    return cam;
  }

  /**
   * Gets latest teacher camera.
   */
  public static async getTeacherCam(sessionId: string): Promise<TeacherCam> {
    const key = this.cameraKey(sessionId);
    const raw = await redis.get(key);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // Fallback
      }
    }
    return { Cx: 640, Cy: 360, Zt: 1.0, Wt: 1280, Ht: 720 };
  }

  /**
   * Updates teacher live cursor (Lx, Ly) on Excalidraw canvas (Formula B.5).
   */
  public static async updateTeacherCursor(
    sessionId: string,
    cursor: WhiteboardCursorState
  ): Promise<WhiteboardCursorState> {
    const key = this.cursorKey(sessionId);
    await redis.set(key, JSON.stringify(cursor));
    return cursor;
  }

  /**
   * Gets latest teacher cursor on Excalidraw canvas.
   */
  public static async getTeacherCursor(sessionId: string): Promise<WhiteboardCursorState> {
    const key = this.cursorKey(sessionId);
    const raw = await redis.get(key);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // Fallback
      }
    }
    return { Lx: 0, Ly: 0, active: false };
  }

  /**
   * Word-wraps a string to a maximum character width per line so Excalidraw text elements
   * stay neatly bounded inside their container rectangle.
   */
  private static wrapTextLines(text: string, maxChars = 48): string {
    const paragraphs = text.split('\n');
    const wrappedParagraphs = paragraphs.map((para) => {
      if (para.length <= maxChars) return para;
      const words = para.split(/\s+/);
      const lines: string[] = [];
      let currentLine = '';

      for (const word of words) {
        if (!currentLine) {
          currentLine = word;
        } else if (currentLine.length + 1 + word.length <= maxChars) {
          currentLine += ` ${word}`;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines.join('\n');
    });

    return wrappedParagraphs.join('\n');
  }

  /**
   * Injects content block into Excalidraw canvas at teacher's camera center (Cx, Cy)
   * using crisp Light Theme colors and automatic multi-line wrapping.
   */
  public static async injectContentBlockAsExcalidraw(
    sessionId: string,
    block: {
      blockId: string;
      title?: string;
      content?: string;
      formulaLatex?: string;
      type: string;
    }
  ): Promise<any[]> {
    const cam = await this.getTeacherCam(sessionId);
    const existingElements = await this.getAllElements(sessionId);
    const existingInjectedBoxes = existingElements.filter(
      (e) => !e.isDeleted && String(e.id || '').startsWith('inj_box_')
    );
    const cascadeOffset = (existingInjectedBoxes.length % 5) * 28;

    const now = Date.now();
    const containerId = `inj_box_${block.blockId}_${now}`;
    const textId = `inj_txt_${block.blockId}_${now}`;

    const rawTitle = (block.title || block.type || 'Concept Block').toUpperCase();
    const rawBody = `${
      block.formulaLatex ? `Formula: ${block.formulaLatex}\n` : ''
    }${block.content ? block.content.slice(0, 260) : ''}`;

    const wrappedBody = this.wrapTextLines(rawBody, 48);
    const displayText = `${this.wrapTextLines(rawTitle, 44)}\n\n${wrappedBody}`;
    const lineCount = displayText.split('\n').length;

    const width = 500;
    const height = Math.max(190, Math.min(340, lineCount * 22 + 48));
    const x = Math.round((cam.Cx || 640) - width / 2 + cascadeOffset);
    const y = Math.round((cam.Cy || 360) - height / 2 + cascadeOffset);

    const boxElement = {
      id: containerId,
      type: 'rectangle',
      x,
      y,
      width,
      height,
      angle: 0,
      strokeColor: '#12a3ff',
      backgroundColor: '#f0f9ff',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [`grp_${containerId}`],
      frameId: null,
      roundness: { type: 3 },
      seed: Math.floor(Math.random() * 100000),
      version: 2,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
    };

    const textElement = {
      id: textId,
      type: 'text',
      x: x + 20,
      y: y + 20,
      width: width - 40,
      height: height - 40,
      angle: 0,
      strokeColor: '#0f172a',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [`grp_${containerId}`],
      frameId: null,
      roundness: null,
      seed: Math.floor(Math.random() * 100000),
      version: 2,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
      boundElements: null,
      updated: now + 1,
      link: null,
      locked: false,
      text: displayText,
      fontSize: 16,
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: displayText,
      lineHeight: 1.25,
      autoResize: true,
    };

    const elements = [boxElement, textElement];
    await this.syncElements(sessionId, elements);

    return elements;
  }
}
