import { redis } from '../../config/redis';
import {
  BroadcastPacket,
  ContentStroke,
  ContentSyncState,
  LaserPointerState,
} from '../../types/broadcast.types';
import { RoomManager } from '../room/room.manager';

export class ContentEngine {
  public static VIRTUAL_PAGE_WIDTH = 800;

  private static stateKey(sessionId: string): string {
    return `room:${sessionId}:content_state`;
  }

  private static strokesKey(sessionId: string, lessonId: string): string {
    return `room:${sessionId}:content_strokes:${lessonId}`;
  }

  /**
   * Calculates content scale factor for any screen width (Formula A).
   */
  public static calculateContentScale(deviceWidth: number): number {
    return Math.max(0.1, deviceWidth / this.VIRTUAL_PAGE_WIDTH);
  }

  /**
   * Maps student screen coordinate from virtual page space (Formula A).
   */
  public static virtualToStudentScreen(
    Xv: number,
    Yv: number,
    blockTopStudent: number,
    scaleContent: number
  ): { xScreen: number; yScreen: number } {
    return {
      xScreen: Xv * scaleContent,
      yScreen: (blockTopStudent + Yv) * scaleContent,
    };
  }

  /**
   * Retrieves active content sync state including saved strokes for activeLessonId.
   */
  public static async getState(sessionId: string): Promise<ContentSyncState> {
    let state: ContentSyncState = {
      sessionId,
      activeLessonId: '',
      activeTopicId: '',
      activeBlockId: 'blk_header',
      blockOffsetRatio: 0,
      penStrokes: [],
      laserPointer: { x: 0, y: 0, active: false },
    };

    const raw = await redis.get(this.stateKey(sessionId));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.activeLessonId === 'les_ohms_law' || parsed.activeLessonId === '1') {
          parsed.activeLessonId = '';
        }
        if (parsed.activeTopicId === 'top_resistance') {
          parsed.activeTopicId = '';
        }
        state = { ...state, ...parsed };
      } catch {
        // Fallback
      }
    }

    if (!state.activeLessonId) {
      try {
        const ctxRaw = await redis.get(`room:${sessionId}:context`);
        if (ctxRaw) {
          const ctx = JSON.parse(ctxRaw);
          if (ctx.lessonId && ctx.lessonId !== 'les_ohms_law' && ctx.lessonId !== '1') {
            state.activeLessonId = String(ctx.lessonId);
          }
          if (!state.activeTopicId && ctx.topicId && ctx.topicId !== 'top_resistance') {
            state.activeTopicId = String(ctx.topicId);
          }
        }
      } catch {
        // Ignore context fallback errors
      }
    }

    const strokes = state.activeLessonId
      ? await this.getStrokes(sessionId, state.activeLessonId)
      : [];
    state.penStrokes = strokes;

    return state;
  }

  /**
   * Broadcasts teacher scroll position (Block-ID Anchoring) and records in ring buffer.
   */
  public static async updateScroll(
    sessionId: string,
    activeBlockId: string,
    blockOffsetRatio: number,
    authorId?: string
  ): Promise<BroadcastPacket> {
    const clampedRatio = Math.max(-0.5, Math.min(1.5, blockOffsetRatio));
    const current = await this.getState(sessionId);
    const updatedAt = Date.now();

    const updated: ContentSyncState = {
      ...current,
      activeBlockId,
      blockOffsetRatio: clampedRatio,
      scrollAuthorId: authorId,
      scrollUpdatedAt: updatedAt,
    };

    await redis.set(this.stateKey(sessionId), JSON.stringify(updated));

    return await RoomManager.appendPacket(sessionId, 'CONTENT_SCROLL_SYNC', {
      activeBlockId,
      blockOffsetRatio: clampedRatio,
      authorId,
      updatedAt,
    });
  }

  /**
   * Broadcasts navigation state change (switching lesson or topic) and records in ring buffer.
   */
  public static async updateNavigation(
    sessionId: string,
    activeLessonId: string,
    activeTopicId: string
  ): Promise<BroadcastPacket> {
    const current = await this.getState(sessionId);
    const strokes = await this.getStrokes(sessionId, activeLessonId);
    const updated: ContentSyncState = {
      ...current,
      activeLessonId,
      activeTopicId,
      activeBlockId: 'blk_header',
      blockOffsetRatio: 0,
      penStrokes: strokes,
    };

    await redis.set(this.stateKey(sessionId), JSON.stringify(updated));

    try {
      const snapRaw = await redis.get(`room:${sessionId}:snapshot`);
      if (snapRaw) {
        const snap = JSON.parse(snapRaw);
        if (snap.sessionContext) {
          if (activeLessonId) snap.sessionContext.lessonId = activeLessonId;
          snap.sessionContext.topicId = activeTopicId ?? '';
        }
        snap.contentState = updated;
        await redis.set(`room:${sessionId}:snapshot`, JSON.stringify(snap));
      }
      const ctxRaw = await redis.get(`room:${sessionId}:context`);
      if (ctxRaw) {
        const ctx = JSON.parse(ctxRaw);
        if (activeLessonId) ctx.lessonId = activeLessonId;
        ctx.topicId = activeTopicId ?? '';
        await redis.set(`room:${sessionId}:context`, JSON.stringify(ctx));
      }
    } catch {
      // Ignore snapshot sync errors
    }

    return await RoomManager.appendPacket(sessionId, 'NAV_STATE_CHANGE', {
      activeLessonId,
      activeTopicId,
      penStrokes: strokes,
    });
  }

  /**
   * Records a freehand pen or highlighter stroke (with word-level `anchorTokens` & `tokenId` points)
   * and appends to the room's sequence ring buffer.
   */
  public static async addStroke(
    sessionId: string,
    stroke: ContentStroke
  ): Promise<BroadcastPacket> {
    const current = await this.getState(sessionId);
    const strokesKey = this.strokesKey(sessionId, current.activeLessonId);

    await redis.rpush(strokesKey, JSON.stringify(stroke));

    return await RoomManager.appendPacket(sessionId, 'CONTENT_STROKE_ADD', stroke);
  }

  /**
   * Deletes an individual stroke by ID (Eraser tool in Content Mode).
   */
  public static async deleteStroke(
    sessionId: string,
    lessonId: string,
    strokeId: string
  ): Promise<BroadcastPacket> {
    const strokesKey = this.strokesKey(sessionId, lessonId);
    const currentStrokes = await this.getStrokes(sessionId, lessonId);
    const remaining = currentStrokes.filter((s) => s.id !== strokeId);

    await redis.del(strokesKey);
    if (remaining.length > 0) {
      await redis.rpush(strokesKey, ...remaining.map((s) => JSON.stringify(s)));
    }

    return await RoomManager.appendPacket(sessionId, 'CONTENT_STROKE_DELETE', {
      lessonId,
      strokeId,
    });
  }

  /**
   * Clears pen strokes for current lesson.
   */
  public static async clearStrokes(
    sessionId: string,
    lessonId: string
  ): Promise<BroadcastPacket> {
    const strokesKey = this.strokesKey(sessionId, lessonId);
    await redis.del(strokesKey);

    return await RoomManager.appendPacket(sessionId, 'CONTENT_STROKES_CLEAR', { lessonId });
  }

  /**
   * Gets all saved strokes for a lesson.
   */
  public static async getStrokes(sessionId: string, lessonId: string): Promise<ContentStroke[]> {
    const strokesKey = this.strokesKey(sessionId, lessonId);
    const raw = await redis.lrange(strokesKey, 0, -1);
    return raw.map((r) => JSON.parse(r));
  }

  /**
   * Updates ephemeral laser pointer position without polluting the 500-item ring buffer.
   */
  public static async updateLaser(sessionId: string, laser: LaserPointerState): Promise<void> {
    await redis.set(`room:${sessionId}:content_laser`, JSON.stringify(laser), 'EX', 60);
  }
}
