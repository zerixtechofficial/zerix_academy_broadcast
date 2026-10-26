'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import {
  ExcalidrawElementState,
  WhiteboardCameraState,
  WhiteboardCursorState,
} from '../hooks/useBroadcastSocket';
import { Trash2 } from 'lucide-react';
import { StudentWhiteboardControls } from './StudentWhiteboardControls';

let cachedRestoreElements: ((els: any[], local: any, opts?: any) => any[]) | null = null;

const Excalidraw = dynamic(
  async () => {
    const mod = await import('@excalidraw/excalidraw');
    if (mod.restoreElements) {
      cachedRestoreElements = mod.restoreElements as any;
    }
    return mod.Excalidraw;
  },
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-white text-slate-500 text-sm font-medium">
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 shadow-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-[#12a3ff] animate-ping" />
          <span>Loading Excalidraw Studio...</span>
        </div>
      </div>
    ),
  }
);

interface LaserTrailPoint {
  x: number;
  y: number;
  t: number;
}

interface ElementSignature {
  sceneVersion: number;
  sceneVersionNonce: number;
  sourceVersionNonce: number;
  outgoingVersion: number;
  isDeleted: boolean;
  index?: string | null;
  snapshot: ExcalidrawElementState;
}

function getLayerTypePriority(type?: string): number {
  if (type === 'frame') return 0;
  if (type === 'rectangle' || type === 'diamond' || type === 'ellipse' || type === 'image') {
    return 1;
  }
  if (type === 'line' || type === 'arrow' || type === 'freedraw') return 2;
  if (type === 'text') return 3;
  return 2;
}

function getDeterministicNonce(el: any): number {
  if (typeof el?.versionNonce === 'number' && el.versionNonce !== 0) {
    return el.versionNonce;
  }
  if (typeof el?.seed === 'number' && el.seed !== 0) {
    return el.seed + (el?.version ?? 1);
  }
  let hash = 2166136261;
  const str = `${el?.id || ''}:${el?.version ?? 1}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0) || 1;
}

interface ExcalidrawStageProps {
  role: 'teacher' | 'student';
  currentUserId?: string;
  isHostTeacher?: boolean;
  canEditWhiteboard?: boolean;
  elements: ExcalidrawElementState[];
  files?: Record<string, any>;
  camera: WhiteboardCameraState;
  whiteboardCursor?: WhiteboardCursorState;
  isRoughPad?: boolean;
  roughPadElements?: ExcalidrawElementState[];
  followTeacher: boolean;
  onToggleFollow: (follow: boolean) => void;
  studentZoomMultiplier: number;
  onChangeZoomMultiplier: (updater: (prev: number) => number) => void;
  onElementsDiff: (changed: ExcalidrawElementState[]) => void;
  onFilesDiff?: (files: Record<string, any>) => void;
  onClearBoard?: () => void;
  onCameraUpdate: (camera: WhiteboardCameraState) => void;
  onCursorMove?: (cursor: WhiteboardCursorState) => void;
  onCopyToRoughPad?: (copiedElements: ExcalidrawElementState[]) => void;
  onUpdateRoughPad?: (elements: ExcalidrawElementState[]) => void;
  onSwitchToLiveBoard?: () => void;
}

const LASER_TRAIL_DURATION_MS = 900;

/**
 * Default font family for all Excalidraw text tools & injected elements:
 * 5 = FONT_FAMILY.ComicShanns (Comic Sans / Comic Shanns in @excalidraw/excalidraw v0.18.0)
 */
export const DEFAULT_WHITEBOARD_FONT_FAMILY = 5;

export const ExcalidrawStage: React.FC<ExcalidrawStageProps> = ({
  role,
  currentUserId,
  isHostTeacher,
  canEditWhiteboard,
  elements,
  files = {},
  camera,
  whiteboardCursor,
  isRoughPad = false,
  roughPadElements = [],
  followTeacher,
  onToggleFollow,
  studentZoomMultiplier,
  onChangeZoomMultiplier,
  onElementsDiff,
  onFilesDiff,
  onClearBoard,
  onCameraUpdate,
  onCursorMove,
  onCopyToRoughPad,
  onUpdateRoughPad,
  onSwitchToLiveBoard,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const excalidrawApiRef = useRef<any>(null);
  const restoreElementsRef = useRef<((els: any[], local: any) => any[]) | null>(null);

  const [apiReady, setApiReady] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const viewportSizeRef = useRef({ width: 1280, height: 720 });
  const [copiedToast, setCopiedToast] = useState(false);
  const [activeToolType, setActiveToolType] = useState<string>('selection');
  const activeToolTypeRef = useRef<string>('selection');

  // Keep latest callback props in refs so Excalidraw handlers have stable function references
  const onElementsDiffRef = useRef(onElementsDiff);
  const onFilesDiffRef = useRef(onFilesDiff);
  const onClearBoardRef = useRef(onClearBoard);
  const onCameraUpdateRef = useRef(onCameraUpdate);
  const onCursorMoveRef = useRef(onCursorMove);
  const onUpdateRoughPadRef = useRef(onUpdateRoughPad);
  const onToggleFollowRef = useRef(onToggleFollow);
  const followTeacherRef = useRef(followTeacher);
  const lastAppliedTeacherViewRef = useRef<{ scrollX: number; scrollY: number; zoom: number } | null>(
    null
  );
  const studentDragPanStartRef = useRef<{
    clientX: number;
    clientY: number;
    scrollX: number;
    scrollY: number;
    zoom: number;
    hasPanned: boolean;
  } | null>(null);

  useEffect(() => {
    onElementsDiffRef.current = onElementsDiff;
    onFilesDiffRef.current = onFilesDiff;
    onClearBoardRef.current = onClearBoard;
    onCameraUpdateRef.current = onCameraUpdate;
    onCursorMoveRef.current = onCursorMove;
    onUpdateRoughPadRef.current = onUpdateRoughPad;
    onToggleFollowRef.current = onToggleFollow;
    followTeacherRef.current = followTeacher;
  });

  // Per-element signature map for O(1) delta sync (detects edits, erases, and Undo/Redo)
  const elementSigMapRef = useRef<Map<string, ElementSignature>>(new Map());
  // Known binary file IDs for Image tool & clipboard paste sync
  const knownFileIdsRef = useRef<Set<string>>(new Set());
  // Tracks which (elementId:fileId) pairs have had their binary file bound & decoded into the active Excalidraw scene
  const sceneSyncedImageKeysRef = useRef<Set<string>>(new Set());
  // Tracks last pointer position on document so Ctrl+V paste knows if cursor is over Excalidraw canvas
  const lastPointerPosRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });
  // Active timers for post-paste / async image initialization polling
  const postPasteTimersRef = useRef<number[]>([]);
  // Guard to prevent programmatic updateScene calls from echoing back into onElementsDiff
  const isApplyingRemoteRef = useRef<boolean>(false);
  const releaseApplyingRemoteTimerRef = useRef<number | null>(null);
  const beginApplyingRemote = useCallback(() => {
    isApplyingRemoteRef.current = true;
    if (releaseApplyingRemoteTimerRef.current !== null) {
      window.clearTimeout(releaseApplyingRemoteTimerRef.current);
      releaseApplyingRemoteTimerRef.current = null;
    }
  }, []);
  const endApplyingRemote = useCallback(() => {
    if (releaseApplyingRemoteTimerRef.current !== null) {
      window.clearTimeout(releaseApplyingRemoteTimerRef.current);
    }
    releaseApplyingRemoteTimerRef.current = window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
      releaseApplyingRemoteTimerRef.current = null;
    }, 0);
  }, []);

  // Active local pointer / drawing state to prevent remote sync from interrupting an in-progress stroke or shape drag
  const isPointerDownRef = useRef<boolean>(false);
  const pendingRemoteSyncRef = useRef<boolean>(false);
  const [remoteSyncTick, setRemoteSyncTick] = useState<number>(0);

  const isUserActivelyInteracting = useCallback((api: any): boolean => {
    if (isPointerDownRef.current) return true;
    // If Excalidraw's WYSIWYG text editor textarea is mounted inside the canvas wrapper, user is actively typing text
    if (wrapperRef.current?.querySelector('.excalidraw-wysiwyg, textarea')) {
      return true;
    }
    // Also treat pending clipboard/dropped image initialization (fileId === null) as active interaction
    // so remote updateScene calls never replace the in-flight image element reference before getDataURL resolves.
    const sceneEls = api?.getSceneElements?.() || [];
    if (
      Array.isArray(sceneEls) &&
      sceneEls.some((el: any) => el && el.type === 'image' && !el.fileId && !el.isDeleted)
    ) {
      return true;
    }
    const appState = api?.getAppState?.();
    if (!appState) return false;
    return Boolean(
      appState.draggingElement ||
        appState.newElement ||
        appState.resizingElement ||
        appState.editingElement ||
        appState.editingTextElement ||
        appState.multiElement ||
        appState.selectionElement
    );
  }, []);

  // Camera & cursor throttle state for Teacher / Collaborator with Whiteboard access
  const lastCameraEmitRef = useRef<number>(0);
  const trailingCameraTimerRef = useRef<number | null>(null);
  const suppressRemoteCameraEchoUntilRef = useRef<number>(0);
  const lastEmittedCameraRef = useRef<WhiteboardCameraState>({
    centerX: 640,
    centerY: 360,
    zoom: 1,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  const lastCursorEmitRef = useRef<number>(0);

  // Local view state (scrollX, scrollY, zoom) for accurate world-to-screen overlays
  const [localViewState, setLocalViewState] = useState({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });

  // Teacher local laser pointer state & decaying world-coordinate trail
  const [teacherLocalCursor, setTeacherLocalCursor] = useState<{
    x: number;
    y: number;
    active: boolean;
  }>({ x: 0, y: 0, active: false });
  const [laserTrail, setLaserTrail] = useState<LaserTrailPoint[]>([]);

  // Smooth camera center for Formula B.5 cursor-follow lerp when M_student > 1.0
  const smoothedCenterRef = useRef<{ x: number; y: number }>({
    x: camera.centerX || 640,
    y: camera.centerY || 360,
  });

  const isEditable = isRoughPad || (canEditWhiteboard ?? role === 'teacher');
  const effectiveIsHostTeacher = isHostTeacher ?? role === 'teacher';

  // Load Excalidraw's restoreElements helper on client mount
  useEffect(() => {
    let mounted = true;
    import('@excalidraw/excalidraw')
      .then((mod) => {
        if (mounted && mod.restoreElements) {
          restoreElementsRef.current = mod.restoreElements as any;
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Helper to emit Teacher / Collaborator camera with leading + trailing throttle
  const emitTeacherCamera = useCallback(
    (scrollX: number, scrollY: number, zoomVal: number, w: number, h: number) => {
      if (
        !isEditable ||
        isRoughPad ||
        isApplyingRemoteRef.current ||
        Date.now() < suppressRemoteCameraEchoUntilRef.current
      ) {
        return;
      }
      const safeZoom = Math.max(0.1, zoomVal || 1);
      const safeW = Math.max(240, w || viewportSizeRef.current.width || 1280);
      const safeH = Math.max(200, h || viewportSizeRef.current.height || 720);

      const centerX = Math.round((-scrollX + safeW / (2 * safeZoom)) * 10) / 10;
      const centerY = Math.round((-scrollY + safeH / (2 * safeZoom)) * 10) / 10;
      const roundedZoom = Math.round(safeZoom * 1000) / 1000;
      const roundedW = Math.round(safeW);
      const roundedH = Math.round(safeH);

      const prev = lastEmittedCameraRef.current;
      const hasChanged =
        Math.abs(centerX - prev.centerX) > 1.0 ||
        Math.abs(centerY - prev.centerY) > 1.0 ||
        Math.abs(roundedZoom - prev.zoom) > 0.005 ||
        Math.abs(roundedW - prev.viewportWidth) > 2 ||
        Math.abs(roundedH - prev.viewportHeight) > 2;

      if (!hasChanged) return;

      const nextCam: WhiteboardCameraState = {
        centerX,
        centerY,
        zoom: roundedZoom,
        viewportWidth: roundedW,
        viewportHeight: roundedH,
      };

      const now = Date.now();
      const elapsed = now - lastCameraEmitRef.current;

      if (elapsed >= 40) {
        if (trailingCameraTimerRef.current) {
          window.clearTimeout(trailingCameraTimerRef.current);
          trailingCameraTimerRef.current = null;
        }
        lastCameraEmitRef.current = now;
        lastEmittedCameraRef.current = nextCam;
        onCameraUpdateRef.current(nextCam);
      } else {
        if (trailingCameraTimerRef.current) {
          window.clearTimeout(trailingCameraTimerRef.current);
        }
        trailingCameraTimerRef.current = window.setTimeout(() => {
          lastCameraEmitRef.current = Date.now();
          lastEmittedCameraRef.current = nextCam;
          onCameraUpdateRef.current(nextCam);
          trailingCameraTimerRef.current = null;
        }, 45 - elapsed);
      }
    },
    [isEditable, isRoughPad]
  );

  // Measure wrapper container dimensions for Formula B viewport aspect-ratio auto-fit & call api.refresh()
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const nextW = Math.round(rect.width);
        const nextH = Math.round(rect.height);
        const changed =
          viewportSizeRef.current.width !== nextW || viewportSizeRef.current.height !== nextH;
        if (changed) {
          viewportSizeRef.current = { width: nextW, height: nextH };
          setViewportSize({ width: nextW, height: nextH });
          // Refresh Excalidraw canvas offsets whenever container resizes (e.g., sidebar collapse or responsive resize)
          if (excalidrawApiRef.current?.refresh) {
            excalidrawApiRef.current.refresh();
          }
        }
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    window.addEventListener('resize', updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Emit initial & resized Host Teacher camera so Co-Hosts & Students in responsive mode always have exact Teacher viewport bounds
  useEffect(() => {
    if (!effectiveIsHostTeacher || !isEditable || isRoughPad || !apiReady) return;
    const api = excalidrawApiRef.current;
    if (!api) return;
    const appState = api.getAppState?.() || {};
    const scrollX = appState.scrollX ?? 0;
    const scrollY = appState.scrollY ?? 0;
    const zoomVal = appState.zoom?.value ?? 1;
    emitTeacherCamera(scrollX, scrollY, zoomVal, viewportSize.width, viewportSize.height);
  }, [
    effectiveIsHostTeacher,
    isEditable,
    isRoughPad,
    apiReady,
    viewportSize.width,
    viewportSize.height,
    emitTeacherCamera,
  ]);

  // Serialize a single Excalidraw element preserving all tool properties (Shapes, Arrows, Freedraw, Text, Images, Frames)
  // Rounds all stroke/element coordinates (x, y, width, height, points) to 1 decimal place (Math.round(val * 10) / 10) before emitting
  const serializeElement = useCallback(
    (el: any, overrideVersion?: number): ExcalidrawElementState => {
      const roundCoord = (val: unknown): number =>
        typeof val === 'number' && Number.isFinite(val) ? Math.round(val * 10) / 10 : 0;

      const copy: ExcalidrawElementState = {
        ...el,
        id: el.id,
        type: el.type,
        x: roundCoord(el.x ?? 0),
        y: roundCoord(el.y ?? 0),
        width: roundCoord(el.width ?? 0),
        height: roundCoord(el.height ?? 0),
        angle: el.angle ?? 0,
        strokeColor: el.strokeColor ?? '#0f172a',
        backgroundColor: el.backgroundColor ?? 'transparent',
        fillStyle: el.fillStyle ?? 'solid',
        strokeWidth: el.strokeWidth ?? 2,
        strokeStyle: el.strokeStyle ?? 'solid',
        roughness: el.roughness ?? 0,
        opacity: el.opacity ?? 100,
        groupIds: Array.isArray(el.groupIds) ? [...el.groupIds] : [],
        frameId: el.frameId ?? null,
        roundness: el.roundness ? { ...el.roundness } : null,
        seed: el.seed ?? 1,
        version: overrideVersion ?? el.version ?? 1,
        versionNonce: getDeterministicNonce(el),
        index: el.index ?? null,
        isDeleted: Boolean(el.isDeleted),
        boundElements: Array.isArray(el.boundElements)
          ? el.boundElements.map((b: any) => ({ ...b }))
          : null,
        updated: el.updated ?? Date.now(),
        link: el.link ?? null,
        locked: Boolean(el.locked),
      };

      if (el.type === 'text') {
        copy.text = el.text ?? el.originalText ?? '';
        copy.originalText = el.originalText ?? el.text ?? '';
        copy.fontSize = el.fontSize ?? 18;
        copy.fontFamily = el.fontFamily ?? DEFAULT_WHITEBOARD_FONT_FAMILY;
        copy.textAlign = el.textAlign || 'left';
        copy.verticalAlign = el.verticalAlign || 'top';
        copy.lineHeight = el.lineHeight ?? 1.25;
        copy.containerId = el.containerId ?? null;
        copy.autoResize = el.autoResize ?? true;
      }

      if (el.type === 'image') {
        copy.fileId = el.fileId ?? null;
        copy.status = el.fileId
          ? el.status === 'error'
            ? 'error'
            : 'saved'
          : el.status || 'pending';
        copy.scale =
          Array.isArray(el.scale) && el.scale.length === 2
            ? [Number(el.scale[0]) || 1, Number(el.scale[1]) || 1]
            : [1, 1];
        copy.crop = el.crop ? { ...el.crop } : null;
      }

      if (Array.isArray(el.points)) {
        copy.points = el.points.map((pt: any) =>
          Array.isArray(pt)
            ? pt.map((coord: any, idx: number) =>
                idx < 2 && typeof coord === 'number' && Number.isFinite(coord)
                  ? Math.round(coord * 10) / 10
                  : coord
              )
            : pt
        );
      }
      if (Array.isArray(el.lastCommittedPoint)) {
        copy.lastCommittedPoint = el.lastCommittedPoint.map((coord: any, idx: number) =>
          idx < 2 && typeof coord === 'number' && Number.isFinite(coord)
            ? Math.round(coord * 10) / 10
            : coord
        );
      }
      if (Array.isArray(el.pressures)) {
        copy.pressures = [...el.pressures];
      }
      if (el.startBinding !== undefined) {
        copy.startBinding = el.startBinding ? { ...el.startBinding } : null;
      }
      if (el.endBinding !== undefined) {
        copy.endBinding = el.endBinding ? { ...el.endBinding } : null;
      }
      return copy;
    },
    []
  );

  // Normalize elements so injected content blocks, copy-pasted formula boxes & remote deltas
  // satisfy Excalidraw v0.18 schema and strictly preserve z-order (background boxes BEFORE text)
  // and fractional index invariants across Redis HGETALL / socket sync.
  const normalizeForExcalidraw = useCallback((rawElements: ExcalidrawElementState[]) => {
    if (!Array.isArray(rawElements) || rawElements.length === 0) return [];

    // 1. Identify groups that contain both a shape container and a text element (e.g. injected or copy-pasted formula boxes)
    const groupHasShape = new Set<string>();
    const groupHasText = new Set<string>();
    for (const item of rawElements) {
      if (!item || !item.id) continue;
      const gid = Array.isArray(item.groupIds) && item.groupIds.length > 0 ? item.groupIds[0] : null;
      if (gid) {
        if (item.type === 'rectangle' || item.type === 'diamond' || item.type === 'ellipse') {
          groupHasShape.add(gid);
        } else if (item.type === 'text') {
          groupHasText.add(gid);
        }
      }
    }

    // 2. Sort rawElements by Excalidraw fractional index (ASCII code-unit order) while guaranteeing
    //    that within any shared group, shapes always sort before text elements.
    const sortedRaw = [...rawElements].sort((a, b) => {
      const grpA = Array.isArray(a?.groupIds) && a.groupIds.length > 0 ? a.groupIds[0] : null;
      const grpB = Array.isArray(b?.groupIds) && b.groupIds.length > 0 ? b.groupIds[0] : null;
      if (grpA && grpA === grpB) {
        const prioA = getLayerTypePriority(a?.type);
        const prioB = getLayerTypePriority(b?.type);
        if (prioA !== prioB) return prioA - prioB;
      }

      const idxA = typeof a?.index === 'string' && a.index.length > 0 ? a.index : null;
      const idxB = typeof b?.index === 'string' && b.index.length > 0 ? b.index : null;
      if (idxA && idxB && idxA !== idxB) {
        return idxA < idxB ? -1 : 1;
      }

      const prioA = getLayerTypePriority(a?.type);
      const prioB = getLayerTypePriority(b?.type);
      if (prioA !== prioB) return prioA - prioB;

      const upA = typeof a?.updated === 'number' ? a.updated : 0;
      const upB = typeof b?.updated === 'number' ? b.updated : 0;
      if (upA !== upB) return upA - upB;

      return String(a?.id || '') < String(b?.id || '') ? -1 : 1;
    });

    // 3. Enforce Group Layer Invariant across the sorted array: if any grouped text element
    //    precedes its group's shape container, defer the text until right after the shape container.
    const deferredGroupTexts = new Map<string, ExcalidrawElementState[]>();
    const remainingShapesInGroup = new Map<string, number>();
    for (const el of sortedRaw) {
      const gid = Array.isArray(el?.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      if (gid && groupHasShape.has(gid) && groupHasText.has(gid) && el.type !== 'text') {
        remainingShapesInGroup.set(gid, (remainingShapesInGroup.get(gid) || 0) + 1);
      }
    }

    const groupOrderedRaw: ExcalidrawElementState[] = [];
    for (const el of sortedRaw) {
      const gid = Array.isArray(el?.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      if (gid && groupHasShape.has(gid) && groupHasText.has(gid)) {
        if (el.type === 'text' && (remainingShapesInGroup.get(gid) || 0) > 0) {
          const list = deferredGroupTexts.get(gid) || [];
          list.push(el);
          deferredGroupTexts.set(gid, list);
          continue;
        }
        groupOrderedRaw.push(el);
        if (el.type !== 'text') {
          const left = (remainingShapesInGroup.get(gid) || 1) - 1;
          remainingShapesInGroup.set(gid, left);
          if (left <= 0 && deferredGroupTexts.has(gid)) {
            groupOrderedRaw.push(...(deferredGroupTexts.get(gid) || []));
            deferredGroupTexts.delete(gid);
          }
        }
      } else {
        groupOrderedRaw.push(el);
      }
    }
    for (const deferred of Array.from(deferredGroupTexts.values())) {
      groupOrderedRaw.push(...deferred);
    }

    const rawMap = new Map<string, ExcalidrawElementState>();
    for (const item of groupOrderedRaw) {
      if (item && item.id) {
        rawMap.set(item.id, item);
      }
    }

    const prepared = groupOrderedRaw.map((el) => {
      const gid = Array.isArray(el.groupIds) && el.groupIds.length > 0 ? el.groupIds[0] : null;
      const isGroupedFormulaPair = Boolean(
        (gid && groupHasShape.has(gid) && groupHasText.has(gid)) ||
          String(el.id || '').startsWith('inj_box_') ||
          String(el.id || '').startsWith('inj_txt_')
      );

      // For grouped formula boxes (injected or copy-pasted), keep text & box as a clean group
      // with containerId=null so Excalidraw renders the full multi-line formula text on top of the box
      // without bound-text clipping or fractional index collisions.
      let cleanedBoundElements: any[] | null = null;
      if (Array.isArray(el.boundElements) && el.boundElements.length > 0) {
        const validBounds = el.boundElements.filter((b: any) => {
          if (!b || !b.id) return false;
          if (b.type === 'text') {
            if (isGroupedFormulaPair) return false;
            const targetText = rawMap.get(b.id);
            return Boolean(targetText && targetText.containerId === el.id);
          }
          return rawMap.has(b.id);
        });
        cleanedBoundElements = validBounds.length > 0 ? validBounds : null;
      }

      const validContainerId =
        !isGroupedFormulaPair &&
        el.type === 'text' &&
        el.containerId &&
        rawMap.has(el.containerId)
          ? el.containerId
          : null;

      const resolvedText = el.type === 'text' ? (el.text ?? el.originalText ?? '') : undefined;

      const copy: Record<string, any> = {
        ...el,
        version: el.version ?? 1,
        versionNonce: getDeterministicNonce(el),
        isDeleted: Boolean(el.isDeleted),
        fillStyle: el.fillStyle || 'solid',
        strokeWidth: el.strokeWidth ?? 2,
        strokeStyle: el.strokeStyle || 'solid',
        roughness: el.roughness ?? 0,
        opacity: el.opacity ?? 100,
        angle: el.angle ?? 0,
        seed: el.seed ?? 1,
        groupIds: Array.isArray(el.groupIds) ? el.groupIds : [],
        frameId: el.frameId ?? null,
        roundness: el.roundness ?? null,
        boundElements: cleanedBoundElements,
        updated: el.updated ?? Date.now(),
        link: el.link ?? null,
        locked: Boolean(el.locked),
        ...(el.type === 'text'
          ? {
              text: resolvedText,
              originalText: el.originalText ?? resolvedText ?? '',
              fontSize: el.fontSize ?? 18,
              fontFamily: el.fontFamily ?? DEFAULT_WHITEBOARD_FONT_FAMILY,
              textAlign: el.textAlign || 'left',
              verticalAlign: el.verticalAlign || 'top',
              lineHeight: el.lineHeight ?? 1.25,
              containerId: validContainerId,
              autoResize: el.autoResize ?? true,
            }
          : {}),
        ...(el.type === 'freedraw'
          ? {
              points: Array.isArray(el.points) ? el.points : [[0, 0]],
              pressures: Array.isArray(el.pressures) ? el.pressures : [],
              simulatePressure: el.simulatePressure ?? true,
            }
          : {}),
        ...(el.type === 'line' || el.type === 'arrow'
          ? {
              points: Array.isArray(el.points)
                ? el.points
                : [
                    [0, 0],
                    [el.width || 100, el.height || 0],
                  ],
              startBinding: el.startBinding ?? null,
              endBinding: el.endBinding ?? null,
              startArrowhead: el.startArrowhead ?? null,
              endArrowhead: el.endArrowhead ?? (el.type === 'arrow' ? 'arrow' : null),
              elbowed: Boolean(el.elbowed),
            }
          : {}),
        ...(el.type === 'image'
          ? {
              fileId: el.fileId ?? null,
              status: el.fileId ? (el.status === 'error' ? 'error' : 'saved') : 'pending',
              scale: Array.isArray(el.scale) ? el.scale : [1, 1],
              crop: el.crop ?? null,
            }
          : {}),
      };

      // Strip any stale fractional index so restoreElements generates strictly monotonic indices
      // matching our sorted & group-layered order.
      delete copy.index;
      return copy;
    });

    // 4. Ensure any native bound text element (containerId !== null) is placed immediately after its container
    const boundTextsByContainer = new Map<string, any[]>();
    const nonBoundElements: any[] = [];
    for (const item of prepared) {
      if (item.type === 'text' && item.containerId) {
        const list = boundTextsByContainer.get(item.containerId) || [];
        list.push(item);
        boundTextsByContainer.set(item.containerId, list);
      } else {
        nonBoundElements.push(item);
      }
    }

    const ordered: any[] = [];
    for (const item of nonBoundElements) {
      ordered.push(item);
      const boundTexts = boundTextsByContainer.get(item.id);
      if (boundTexts) {
        ordered.push(...boundTexts);
        boundTextsByContainer.delete(item.id);
      }
    }
    for (const orphanTexts of Array.from(boundTextsByContainer.values())) {
      ordered.push(...orphanTexts);
    }

    const restoreFn = restoreElementsRef.current || cachedRestoreElements;
    if (restoreFn) {
      try {
        const srcVersionById = new Map<string, { version: number; versionNonce: number }>();
        for (const item of ordered) {
          if (item && item.id) {
            srcVersionById.set(item.id, {
              version: item.version ?? 1,
              versionNonce: item.versionNonce ?? getDeterministicNonce(item),
            });
          }
        }
        const restored = restoreFn(ordered, null, { repairBindings: true });
        // Restore original version and versionNonce because Excalidraw's internal syncInvalidIndices
        // inside restoreElements calls mutateElement(), which increments version++ and randomizes versionNonce.
        for (const rEl of restored) {
          if (rEl && rEl.id) {
            const orig = srcVersionById.get(rEl.id);
            if (orig) {
              rEl.version = orig.version;
              rEl.versionNonce = orig.versionNonce;
            }
          }
        }
        return restored;
      } catch {
        return ordered;
      }
    }
    return ordered;
  }, []);

  // Ensure binary image files are bound to Excalidraw's imageCache AFTER the corresponding image elements
  // exist in the scene, and invalidate Excalidraw's WeakMap elementWithCanvasCache once HTMLImageElement decodes.
  const syncFilesWithScene = useCallback(
    (api: any, filesMap?: Record<string, any>) => {
      if (!api || !filesMap || typeof api.addFiles !== 'function') return;

      // Record all valid incoming fileIds as known so local onChange never re-broadcasts remote files
      const validFilesById = new Map<string, any>();
      for (const [fileId, fileData] of Object.entries(filesMap)) {
        if (fileId && fileData?.dataURL) {
          knownFileIdsRef.current.add(fileId);
          validFilesById.set(fileId, {
            id: fileData.id || fileId,
            dataURL: fileData.dataURL,
            mimeType: fileData.mimeType || 'image/png',
            created: fileData.created || Date.now(),
          });
        }
      }

      if (validFilesById.size === 0) return;

      const sceneEls =
        api.getSceneElementsIncludingDeleted?.() || api.getSceneElements?.() || [];
      const filesToBind: any[] = [];
      const newlySyncedFileIds = new Set<string>();

      for (const el of sceneEls) {
        if (!el || el.isDeleted || el.type !== 'image' || !el.fileId) continue;
        const fileData = validFilesById.get(el.fileId);
        if (!fileData) continue;
        const syncKey = `${el.id}:${el.fileId}`;
        if (!sceneSyncedImageKeysRef.current.has(syncKey)) {
          sceneSyncedImageKeysRef.current.add(syncKey);
          if (!newlySyncedFileIds.has(el.fileId)) {
            newlySyncedFileIds.add(el.fileId);
            filesToBind.push(fileData);
          }
        }
      }

      if (filesToBind.length === 0) return;

      // 1. Register files with Excalidraw now that the image elements are present in this.scene
      api.addFiles(filesToBind);

      // 2. Decode each dataURL in a browser Image; once decoded, clone the matching image elements in the scene
      // so Excalidraw's WeakMap ShapeCache (elementWithCanvasCache) evicts any placeholder and paints the bitmap.
      for (const fileData of filesToBind) {
        const targetFileId = fileData.id;
        const img = new window.Image();
        img.onload = () => {
          window.requestAnimationFrame(() => {
            const currentApi = excalidrawApiRef.current;
            if (!currentApi) return;
            try {
              currentApi.addFiles([fileData]);
              // If user is actively dragging/drawing on an editable board, avoid replacing scene elements mid-stroke
              if (isEditable && isUserActivelyInteracting(currentApi)) return;
              const currentEls =
                currentApi.getSceneElementsIncludingDeleted?.() ||
                currentApi.getSceneElements?.() ||
                [];
              let touched = false;
              const refreshed = currentEls.map((el: any) => {
                if (el && !el.isDeleted && el.type === 'image' && el.fileId === targetFileId) {
                  touched = true;
                  return {
                    ...el,
                    status: 'saved',
                  };
                }
                return el;
              });
              if (touched) {
                beginApplyingRemote();
                currentApi.updateScene({ elements: refreshed });
                endApplyingRemote();
              }
            } catch {
              // Ignore transient errors if component unmounted
            }
          });
        };
        img.src = fileData.dataURL;
      }
    },
    [isEditable, isUserActivelyInteracting, beginApplyingRemote, endApplyingRemote]
  );

  // Ensure Excalidraw's internal viewModeEnabled & canvas bounding offsets immediately update
  // whenever a Student or Co-Teacher is granted or revoked Whiteboard edit access.
  useEffect(() => {
    const api = excalidrawApiRef.current;
    if (!api || !apiReady) return;
    beginApplyingRemote();
    api.updateScene({
      appState: {
        viewModeEnabled: !isEditable,
        currentItemFontFamily: DEFAULT_WHITEBOARD_FONT_FAMILY,
      },
    });
    endApplyingRemote();
    if (typeof api.refresh === 'function') {
      api.refresh();
    }
    const timer = window.setTimeout(() => {
      try {
        excalidrawApiRef.current?.refresh?.();
      } catch {}
    }, 60);
    return () => window.clearTimeout(timer);
  }, [isEditable, apiReady, beginApplyingRemote, endApplyingRemote]);

  // Sync incoming BinaryFiles (for Excalidraw Insert Image tool & clipboard pasted images)
  useEffect(() => {
    const api = excalidrawApiRef.current;
    if (!api || !apiReady || !files) return;
    syncFilesWithScene(api, files);
  }, [files, apiReady, syncFilesWithScene]);

  // Sync incoming elements into Excalidraw instance (Teacher, Student Live Board, or Student Rough Pad)
  useEffect(() => {
    const api = excalidrawApiRef.current;
    if (!api || !apiReady) return;

    const sourceElements = isRoughPad ? roughPadElements : elements;
    const currentSceneEls =
      api.getSceneElementsIncludingDeleted?.() || api.getSceneElements?.() || [];
    const activeCurrentEls = currentSceneEls.filter((e: any) => !e.isDeleted);

    // Handle remote Clear Board (sourceElements is empty while scene has elements)
    if (sourceElements.length === 0) {
      // Never wipe an in-progress stroke or open WYSIWYG text editor on an initially empty board
      if (isEditable && isUserActivelyInteracting(api)) {
        pendingRemoteSyncRef.current = true;
        return;
      }
      if (activeCurrentEls.length > 0 || elementSigMapRef.current.size > 0) {
        elementSigMapRef.current.clear();
        sceneSyncedImageKeysRef.current.clear();
        beginApplyingRemote();
        api.updateScene({ elements: [] });
        endApplyingRemote();
      }
      return;
    }

    // Check if any incoming element is genuinely from a remote collaborator (or initial load)
    // and strictly newer than (or unknown to) our local signature map.
    // Self-echoes of local drawing frames are ignored so we never call updateScene mid-drag.
    let hasRemoteChanges = false;
    let newestInjectedRect: any = null;

    for (const el of sourceElements) {
      if (!el || !el.id) continue;
      const knownSig = elementSigMapRef.current.get(el.id);
      const incomingVersion = el.version ?? 1;
      const incomingNonce = getDeterministicNonce(el);
      const incomingDeleted = Boolean(el.isDeleted);

      if (!knownSig) {
        if (incomingDeleted) {
          const serialized = serializeElement(el, incomingVersion);
          elementSigMapRef.current.set(el.id, {
            sceneVersion: incomingVersion,
            sceneVersionNonce: incomingNonce,
            sourceVersionNonce: incomingNonce,
            outgoingVersion: incomingVersion,
            isDeleted: true,
            index: el.index ?? null,
            snapshot: serialized,
          });
          continue;
        }
        hasRemoteChanges = true;
        if (
          typeof el.id === 'string' &&
          (el.id.startsWith('inj_box_') || el.id.startsWith('wb_rect_'))
        ) {
          newestInjectedRect = el;
        }
      } else if (incomingVersion > knownSig.outgoingVersion) {
        hasRemoteChanges = true;
      } else if (
        el.type === 'image' &&
        (el.fileId ?? null) !== (knownSig.snapshot.fileId ?? null)
      ) {
        hasRemoteChanges = true;
      } else if (
        incomingVersion === knownSig.outgoingVersion &&
        (incomingDeleted !== knownSig.isDeleted ||
          (!isRoughPad &&
            incomingNonce !== knownSig.sceneVersionNonce &&
            incomingNonce !== knownSig.sourceVersionNonce))
      ) {
        hasRemoteChanges = true;
      }
    }

    // On a read-only student board, also detect if any active scene element was removed in a snapshot
    if (!hasRemoteChanges && !isEditable && !isRoughPad) {
      const sourceActiveIds = new Set(
        sourceElements.filter((e) => e && e.id && !e.isDeleted).map((e) => e.id)
      );
      for (const curEl of activeCurrentEls) {
        if (curEl?.id && !sourceActiveIds.has(curEl.id)) {
          hasRemoteChanges = true;
          break;
        }
      }
    }

    if (!hasRemoteChanges) {
      return;
    }

    // Never call api.updateScene({ elements }) while the local user is actively dragging/drawing
    // on an editable board, as Excalidraw's active draggingElement / newElement reference would be severed.
    // Instead, defer applying the remote update until pointerUp / interaction end.
    if (isEditable && isUserActivelyInteracting(api)) {
      pendingRemoteSyncRef.current = true;
      return;
    }
    pendingRemoteSyncRef.current = false;

    // On an editable board, merge incoming remote elements with any newer local elements in the scene
    let elementsToNormalize = sourceElements;
    if (isEditable && !isRoughPad && currentSceneEls.length > 0) {
      const mergedMap = new Map<string, ExcalidrawElementState>();
      for (const srcEl of sourceElements) {
        if (srcEl && srcEl.id) {
          mergedMap.set(srcEl.id, srcEl);
        }
      }
      for (const localEl of currentSceneEls) {
        if (!localEl || !localEl.id) continue;
        const localSig = elementSigMapRef.current.get(localEl.id);
        const localOutVer = Math.max(localEl.version ?? 1, localSig?.outgoingVersion ?? 0);
        const existingSrc = mergedMap.get(localEl.id);
        if (!existingSrc) {
          if (!localEl.isDeleted) {
            mergedMap.set(localEl.id, serializeElement(localEl, localOutVer));
          }
        } else if (localOutVer > (existingSrc.version ?? 1)) {
          mergedMap.set(localEl.id, serializeElement(localEl, localOutVer));
        }
      }
      elementsToNormalize = Array.from(mergedMap.values());
    }

    const sourceNonceMap = new Map<string, { nonce: number; version: number }>();
    for (const el of elementsToNormalize) {
      if (el && el.id) {
        sourceNonceMap.set(el.id, {
          nonce: getDeterministicNonce(el),
          version: el.version ?? 1,
        });
      }
    }

    const normalized = normalizeForExcalidraw(elementsToNormalize);

    beginApplyingRemote();
    const nextAppState: Record<string, any> | undefined =
      role === 'teacher' && !isRoughPad && newestInjectedRect
        ? {
            scrollX:
              -(newestInjectedRect.x + (newestInjectedRect.width || 620) / 2) +
              (viewportSizeRef.current.width || 1000) / 2,
            scrollY:
              -(newestInjectedRect.y + (newestInjectedRect.height || 260) / 2) +
              (viewportSizeRef.current.height || 700) / 2,
          }
        : undefined;

    api.updateScene({
      elements: normalized,
      ...(nextAppState ? { appState: nextAppState } : {}),
    });

    // Immediately bind any already-received binary files to the newly updated scene elements
    if (files) {
      syncFilesWithScene(api, files);
    }

    if (nextAppState && role === 'teacher' && !isRoughPad) {
      emitTeacherCamera(
        nextAppState.scrollX,
        nextAppState.scrollY,
        1.0,
        viewportSizeRef.current.width || 1000,
        viewportSizeRef.current.height || 700
      );
    }

    const updatedSceneEls =
      api.getSceneElementsIncludingDeleted?.() || api.getSceneElements?.() || normalized;
    for (const el of updatedSceneEls) {
      if (!el || !el.id) continue;
      const prevSig = elementSigMapRef.current.get(el.id);
      const srcInfo = sourceNonceMap.get(el.id);
      const serialized = serializeElement(el);
      const sceneVersion = el.version ?? 1;
      const sceneVersionNonce = getDeterministicNonce(el);
      const sourceVersionNonce =
        srcInfo?.nonce ?? prevSig?.sourceVersionNonce ?? sceneVersionNonce;
      const outgoingVersion = Math.max(
        serialized.version,
        srcInfo?.version ?? 0,
        prevSig?.outgoingVersion ?? 0
      );
      elementSigMapRef.current.set(el.id, {
        sceneVersion,
        sceneVersionNonce,
        sourceVersionNonce,
        outgoingVersion,
        isDeleted: Boolean(serialized.isDeleted),
        index: el.index ?? null,
        snapshot: serialized,
      });
    }

    endApplyingRemote();
  }, [
    elements,
    roughPadElements,
    files,
    isRoughPad,
    isEditable,
    role,
    apiReady,
    remoteSyncTick,
    isUserActivelyInteracting,
    normalizeForExcalidraw,
    serializeElement,
    emitTeacherCamera,
    syncFilesWithScene,
    beginApplyingRemote,
    endApplyingRemote,
  ]);

  // Formula B: Live Board Camera Sync (Host, Co-Host & Students) + Custom Zoom Multiplier + Cursor Edge Follow
  useEffect(() => {
    if (isRoughPad || !followTeacher) return;
    const isOwnCamera = Boolean(
      currentUserId && camera.authorId && camera.authorId === currentUserId
    );
    // An editor who authored the latest camera update does not re-apply their own camera
    if (isEditable && isOwnCamera) return;

    const api = excalidrawApiRef.current;
    if (!api || !apiReady) return;
    // Do not interrupt a user who is actively dragging/panning or drawing on the live board
    if (isPointerDownRef.current || (isEditable && isUserActivelyInteracting(api))) return;

    const Ws = Math.max(240, viewportSize.width);
    const Hs = Math.max(200, viewportSize.height);

    // Formula B.2: Active presenter visible world area
    const teacherZoom = Math.max(0.1, camera.zoom || 1);
    const W_teacher_visible = Math.max(240, (camera.viewportWidth || 1280) / teacherZoom);
    const H_teacher_visible = Math.max(200, (camera.viewportHeight || 720) / teacherZoom);

    // Formula B.3: Auto-fit zoom ratio so 100% of presenter's visible area fits inside follower's screen
    const Z_autofit = Math.min(Ws / W_teacher_visible, Hs / H_teacher_visible);

    // Formula B.4: Effective zoom including custom zoom multiplier M_student
    const Z_effective = Math.min(5.0, Math.max(0.1, Z_autofit * studentZoomMultiplier));

    let targetCx = camera.centerX ?? 640;
    let targetCy = camera.centerY ?? 360;

    // Formula B.5: When remote collaborator cursor is near viewport edge, smoothly lerp camera center toward (Lx, Ly)
    const isRemoteCursor = Boolean(
      whiteboardCursor?.active &&
        (!currentUserId || !whiteboardCursor.userId || whiteboardCursor.userId !== currentUserId)
    );
    if (isRemoteCursor && whiteboardCursor) {
      const studentVisibleWorldW = Ws / Z_effective;
      const studentVisibleWorldH = Hs / Z_effective;
      const prevCenter = smoothedCenterRef.current;

      const dx = whiteboardCursor.x - prevCenter.x;
      const dy = whiteboardCursor.y - prevCenter.y;
      const marginX = studentVisibleWorldW * 0.3;
      const marginY = studentVisibleWorldH * 0.3;

      if (Math.abs(dx) > marginX || Math.abs(dy) > marginY) {
        const alpha = 0.25;
        targetCx = prevCenter.x + (whiteboardCursor.x - prevCenter.x) * alpha;
        targetCy = prevCenter.y + (whiteboardCursor.y - prevCenter.y) * alpha;
      }
    }

    smoothedCenterRef.current = { x: targetCx, y: targetCy };

    // Convert world center (targetCx, targetCy) to Excalidraw scrollX, scrollY:
    // In Excalidraw: screenX = (worldX + scrollX) * zoom => Ws/2 = (targetCx + scrollX) * Z_effective
    const scrollX = Ws / (2 * Z_effective) - targetCx;
    const scrollY = Hs / (2 * Z_effective) - targetCy;

    lastAppliedTeacherViewRef.current = { scrollX, scrollY, zoom: Z_effective };

    const currentAppState = api.getAppState?.() || {};
    const curScrollX = currentAppState.scrollX ?? 0;
    const curScrollY = currentAppState.scrollY ?? 0;
    const curZoom = currentAppState.zoom?.value ?? 1;

    if (
      Math.abs(curScrollX - scrollX) > 0.5 ||
      Math.abs(curScrollY - scrollY) > 0.5 ||
      Math.abs(curZoom - Z_effective) > 0.002
    ) {
      suppressRemoteCameraEchoUntilRef.current = Date.now() + 350;
      lastEmittedCameraRef.current = {
        centerX: Math.round(targetCx * 10) / 10,
        centerY: Math.round(targetCy * 10) / 10,
        zoom: Math.round(Z_effective * 1000) / 1000,
        viewportWidth: Math.round(Ws),
        viewportHeight: Math.round(Hs),
      };
      beginApplyingRemote();
      api.updateScene({
        appState: {
          scrollX,
          scrollY,
          zoom: { value: Z_effective as any },
          viewBackgroundColor: '#ffffff',
          theme: 'light',
        },
      });
      endApplyingRemote();
    }
    setLocalViewState((prev) => {
      if (
        Math.abs(prev.scrollX - scrollX) > 0.5 ||
        Math.abs(prev.scrollY - scrollY) > 0.5 ||
        Math.abs(prev.zoom - Z_effective) > 0.002
      ) {
        return { scrollX, scrollY, zoom: Z_effective };
      }
      return prev;
    });
  }, [
    role,
    currentUserId,
    isRoughPad,
    isEditable,
    followTeacher,
    camera,
    whiteboardCursor,
    studentZoomMultiplier,
    viewportSize,
    apiReady,
    isUserActivelyInteracting,
    beginApplyingRemote,
    endApplyingRemote,
  ]);

  // Append incoming remote collaborator laser points to the decaying laser trail ONLY when button === 'down' (dragging)
  useEffect(() => {
    if (isRoughPad) return;
    const isSelfCursor = Boolean(
      currentUserId && whiteboardCursor?.userId && whiteboardCursor.userId === currentUserId
    );
    if (isSelfCursor) return;

    if (
      whiteboardCursor?.active &&
      whiteboardCursor.tool === 'laser' &&
      whiteboardCursor.button === 'down'
    ) {
      const now = Date.now();
      setLaserTrail((prev) => {
        const fresh = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
        const last = fresh[fresh.length - 1];
        if (last && Math.hypot(last.x - whiteboardCursor.x, last.y - whiteboardCursor.y) < 1.5) {
          return fresh;
        }
        return [...fresh.slice(-64), { x: whiteboardCursor.x, y: whiteboardCursor.y, t: now }];
      });
    } else {
      setLaserTrail((prev) => (prev.length > 0 ? [] : prev));
    }
  }, [isRoughPad, isEditable, activeToolType, currentUserId, whiteboardCursor]);

  // Prune expired laser trail points smoothly
  useEffect(() => {
    if (laserTrail.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setLaserTrail((prev) => {
        const filtered = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [laserTrail.length]);

  // Sync any newly added binary files from either onChange(sceneFiles) or api.getFiles()
  // (Crucial for Ctrl+V pasted / dropped images where Excalidraw populates api.getFiles() asynchronously)
  const syncLocalFilesFromApi = useCallback(
    (sceneFilesOverride?: Record<string, any>) => {
      if (!isEditable || isRoughPad || isApplyingRemoteRef.current || !onFilesDiffRef.current) {
        return;
      }

      const apiFiles = excalidrawApiRef.current?.getFiles?.() || {};
      const combinedFiles: Record<string, any> = {
        ...(sceneFilesOverride || {}),
        ...apiFiles,
      };

      const deltaFiles: Record<string, any> = {};
      let hasNewFile = false;

      for (const [fileId, fileObj] of Object.entries(combinedFiles)) {
        if (fileId && fileObj?.dataURL && !knownFileIdsRef.current.has(fileId)) {
          knownFileIdsRef.current.add(fileId);
          deltaFiles[fileId] = {
            id: fileObj.id || fileId,
            dataURL: fileObj.dataURL,
            mimeType: fileObj.mimeType || 'image/png',
            created: fileObj.created || Date.now(),
          };
          hasNewFile = true;
        }
      }

      if (hasNewFile) {
        onFilesDiffRef.current(deltaFiles);
      }
    },
    [isEditable, isRoughPad]
  );

  // Reusable helper to inspect local scene elements and emit any new/modified/deleted deltas
  const flushLocalSceneDiffs = useCallback(
    (sceneElementsOverride?: readonly any[]) => {
      if (!isEditable || isApplyingRemoteRef.current) return;

      // Always flush any newly populated binary files (e.g. from async paste/drop image initialization)
      // BEFORE emitting the image element delta that references those fileIds.
      syncLocalFilesFromApi();

      const apiElements = excalidrawApiRef.current?.getSceneElementsIncludingDeleted?.();
      const allElements =
        apiElements && apiElements.length > 0
          ? apiElements
          : sceneElementsOverride || apiElements || [];

      // Detect native "Clear canvas" action (restricted strictly to Teacher on Live Board)
      if (
        role === 'teacher' &&
        isEditable &&
        !isRoughPad &&
        allElements.length === 0 &&
        elementSigMapRef.current.size > 0
      ) {
        elementSigMapRef.current.clear();
        sceneSyncedImageKeysRef.current.clear();
        onClearBoardRef.current?.();
        return;
      }

      // Detect modified, newly created, erased, or Undo/Redo restored elements
      const changed: ExcalidrawElementState[] = [];
      const seenIds = new Set<string>();

      const roundCoord = (val: unknown): number =>
        typeof val === 'number' && Number.isFinite(val) ? Math.round(val * 10) / 10 : 0;

      for (const el of allElements) {
        if (!el || !el.id) continue;
        seenIds.add(el.id);

        // Do not broadcast uninitialized placeholder image elements (fileId: null, 100x100) created
        // synchronously by Excalidraw's pasteFromClipboard before async initializeImage() resolves.
        if (el.type === 'image' && !el.fileId && !el.isDeleted) {
          continue;
        }

        const prevSig = elementSigMapRef.current.get(el.id);

        // Do not broadcast newly created empty placeholder text elements while the user has just opened
        // the WYSIWYG text editor and hasn't typed any text yet.
        if (
          el.type === 'text' &&
          !el.isDeleted &&
          !prevSig &&
          (!el.text || String(el.text).trim().length === 0)
        ) {
          continue;
        }

        const isDeleted = Boolean(el.isDeleted);
        const sceneVersion = el.version ?? 1;
        const sceneVersionNonce = getDeterministicNonce(el);
        const currentIndex = el.index ?? null;
        const pointsLen = Array.isArray(el.points) ? el.points.length : 0;
        const prevPointsLen = Array.isArray(prevSig?.snapshot?.points)
          ? prevSig.snapshot.points.length
          : 0;

        const hasChanged =
          !prevSig ||
          sceneVersion !== prevSig.sceneVersion ||
          sceneVersionNonce !== prevSig.sceneVersionNonce ||
          currentIndex !== (prevSig.index ?? null) ||
          isDeleted !== prevSig.isDeleted ||
          roundCoord(el.x ?? 0) !== prevSig.snapshot.x ||
          roundCoord(el.y ?? 0) !== prevSig.snapshot.y ||
          roundCoord(el.width ?? 0) !== prevSig.snapshot.width ||
          roundCoord(el.height ?? 0) !== prevSig.snapshot.height ||
          (el.angle ?? 0) !== (prevSig.snapshot.angle ?? 0) ||
          (el.strokeColor ?? '#0f172a') !== (prevSig.snapshot.strokeColor ?? '#0f172a') ||
          (el.backgroundColor ?? 'transparent') !==
            (prevSig.snapshot.backgroundColor ?? 'transparent') ||
          (el.opacity ?? 100) !== (prevSig.snapshot.opacity ?? 100) ||
          (el.link ?? null) !== (prevSig.snapshot.link ?? null) ||
          pointsLen !== prevPointsLen ||
          (el.type === 'text' && (el.text ?? '') !== (prevSig.snapshot.text ?? '')) ||
          (el.type === 'image' &&
            ((el.fileId ?? null) !== (prevSig.snapshot.fileId ?? null) ||
              (el.status ?? 'saved') !== (prevSig.snapshot.status ?? 'saved')));

        if (hasChanged) {
          // Ensure outgoing version always monotonically increases even on Undo/Redo
          const outgoingVersion = prevSig
            ? Math.max(
                sceneVersion,
                prevSig.outgoingVersion + (sceneVersion <= prevSig.outgoingVersion ? 1 : 0)
              )
            : sceneVersion;

          const serialized = serializeElement(el, outgoingVersion);
          const sourceVersionNonce = getDeterministicNonce(serialized);
          elementSigMapRef.current.set(el.id, {
            sceneVersion,
            sceneVersionNonce,
            sourceVersionNonce,
            outgoingVersion,
            isDeleted,
            index: currentIndex,
            snapshot: serialized,
          });
          changed.push(serialized);
        }
      }

      // Detect elements removed completely from scene array by Undo (Ctrl+Z) or discarded 0-size drag
      for (const [id, sig] of Array.from(elementSigMapRef.current.entries())) {
        if (!seenIds.has(id) && !sig.isDeleted) {
          const nextVer = sig.outgoingVersion + 1;
          const nextNonce = sig.sceneVersionNonce + 1;
          const tombstone: ExcalidrawElementState = {
            ...sig.snapshot,
            isDeleted: true,
            version: nextVer,
            versionNonce: nextNonce,
            updated: Date.now(),
          };
          elementSigMapRef.current.set(id, {
            sceneVersion: sig.sceneVersion,
            sceneVersionNonce: nextNonce,
            sourceVersionNonce: nextNonce,
            outgoingVersion: nextVer,
            isDeleted: true,
            snapshot: tombstone,
          });
          changed.push(tombstone);
        }
      }

      if (isRoughPad) {
        if (changed.length > 0 && onUpdateRoughPadRef.current) {
          const allActive = allElements
            .filter((e: any) => !e.isDeleted)
            .map((e: any) => serializeElement(e));
          onUpdateRoughPadRef.current(allActive);
        }
        return;
      }

      // Live board: emit element delta diff for Teacher, Authorized Co-Teacher, or Authorized Student
      if (isEditable && !isRoughPad && changed.length > 0) {
        onElementsDiffRef.current(changed);
      }
    },
    [isEditable, isRoughPad, serializeElement, syncLocalFilesFromApi]
  );

  // Schedule multi-pass post-paste / async image initialization checks so that when Excalidraw's
  // async initializeImage() finishes resizeImageFile + getDataURL (or mutates cached fileId with informMutation=false),
  // both the binary file and finalized image element are guaranteed to broadcast immediately.
  const schedulePostPasteOrImageSync = useCallback(() => {
    if (postPasteTimersRef.current.length > 0) {
      postPasteTimersRef.current.forEach((id) => window.clearTimeout(id));
      postPasteTimersRef.current = [];
    }
    const delays = [30, 90, 200, 450, 900, 1800];
    postPasteTimersRef.current = delays.map((ms) =>
      window.setTimeout(() => {
        syncLocalFilesFromApi();
        flushLocalSceneDiffs();
        if (pendingRemoteSyncRef.current && !isPointerDownRef.current) {
          const api = excalidrawApiRef.current;
          if (api && !isUserActivelyInteracting(api)) {
            pendingRemoteSyncRef.current = false;
            setRemoteSyncTick((t) => t + 1);
          }
        }
      }, ms)
    );
  }, [syncLocalFilesFromApi, flushLocalSceneDiffs, isUserActivelyInteracting]);

  useEffect(() => {
    return () => {
      if (postPasteTimersRef.current.length > 0) {
        postPasteTimersRef.current.forEach((id) => window.clearTimeout(id));
        postPasteTimersRef.current = [];
      }
    };
  }, []);

  // Capture-phase clipboard paste & drag-drop support on the Excalidraw stage:
  // 1. Ensures .excalidraw is focused and Excalidraw's lastViewportPosition is over <canvas> before
  //    Excalidraw's bubble-phase pasteFromClipboard runs (fixing ignored Ctrl+V after switching windows/tabs).
  // 2. Handles rich HTML clipboard <img src="data:image/..."> fallback when clipboardData.files is empty.
  // 3. Triggers schedulePostPasteOrImageSync() so pasted images, media, SVG, and text always broadcast.
  useEffect(() => {
    if (!isEditable) return;

    const handleDocPointerMove = (e: PointerEvent) => {
      lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleDocPasteCapture = (e: ClipboardEvent) => {
      const root = wrapperRef.current;
      if (!root || !isEditable) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const targetEl = e.target as HTMLElement | null;

      // Do not interfere if the user is pasting into an input/textarea outside the whiteboard (e.g. Chat / Polls)
      const isEditingInput = (el: HTMLElement | null) => {
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        return (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          Boolean(el.isContentEditable)
        );
      };

      if (isEditingInput(activeEl) || isEditingInput(targetEl)) {
        // If it's Excalidraw's own WYSIWYG text editor, let Excalidraw handle it and schedule sync
        if (
          (activeEl && root.contains(activeEl)) ||
          (targetEl && root.contains(targetEl))
        ) {
          schedulePostPasteOrImageSync();
        }
        return;
      }

      // Ensure .excalidraw container holds focus so Excalidraw's pasteFromClipboard does not abort
      const excalidrawContainer = root.querySelector('.excalidraw') as HTMLElement | null;
      if (excalidrawContainer && !excalidrawContainer.contains(activeEl)) {
        excalidrawContainer.focus({ preventScroll: true });
      }

      // Ensure Excalidraw's internal lastViewportPosition is over our <canvas> element
      const elAtPointer =
        lastPointerPosRef.current.x >= 0 && lastPointerPosRef.current.y >= 0
          ? document.elementFromPoint(lastPointerPosRef.current.x, lastPointerPosRef.current.y)
          : null;
      const isPointerOnCanvas =
        elAtPointer instanceof HTMLCanvasElement && root.contains(elAtPointer);

      if (!isPointerOnCanvas) {
        const canvasEl =
          (root.querySelector('canvas.interactive') as HTMLCanvasElement | null) ||
          (root.querySelector('canvas') as HTMLCanvasElement | null);
        if (canvasEl) {
          const rect = canvasEl.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            lastPointerPosRef.current = { x: centerX, y: centerY };
            document.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: centerX,
                clientY: centerY,
                bubbles: true,
              })
            );
          }
        }
      }

      // Fallback for HTML-only copied images (<img src="data:image/...">) when clipboardData.files & text/plain are empty
      const cd = e.clipboardData;
      if (cd) {
        const hasFiles =
          (cd.files && cd.files.length > 0) ||
          (cd.items && Array.from(cd.items).some((item) => item.kind === 'file'));
        const plainText = (cd.getData('text/plain') || '').trim();
        const htmlText = cd.getData('text/html') || '';
        if (!hasFiles && !plainText && htmlText.includes('<img')) {
          const match = htmlText.match(/<img[^>]+src=["'](data:image\/[^"']+)["']/i);
          if (match && match[1]) {
            const dataURL = match[1];
            const mimeMatch = dataURL.match(/^data:(image\/[a-zA-Z0-9+.-]+);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            const api = excalidrawApiRef.current;
            if (api && typeof api.addFiles === 'function') {
              const img = new window.Image();
              img.onload = () => {
                const fileId = `img_paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const now = Date.now();
                const fileData = {
                  id: fileId,
                  dataURL,
                  mimeType,
                  created: now,
                };
                api.addFiles([fileData]);
                const appState = api.getAppState?.() || {};
                const zoom = appState.zoom?.value || 1;
                const scrollX = appState.scrollX || 0;
                const scrollY = appState.scrollY || 0;
                const vpW = viewportSizeRef.current.width || 1280;
                const vpH = viewportSizeRef.current.height || 720;
                const worldCenterX = vpW / (2 * zoom) - scrollX;
                const worldCenterY = vpH / (2 * zoom) - scrollY;
                const maxDim = 480;
                const natW = Math.max(40, img.naturalWidth || 300);
                const natH = Math.max(40, img.naturalHeight || 200);
                const scaleRatio = Math.min(1, maxDim / Math.max(natW, natH));
                const w = Math.round(natW * scaleRatio);
                const h = Math.round(natH * scaleRatio);
                const newImgEl: ExcalidrawElementState = {
                  id: `el_${now}_${Math.random().toString(36).slice(2, 7)}`,
                  type: 'image',
                  x: Math.round(worldCenterX - w / 2),
                  y: Math.round(worldCenterY - h / 2),
                  width: w,
                  height: h,
                  angle: 0,
                  strokeColor: 'transparent',
                  backgroundColor: 'transparent',
                  fillStyle: 'solid',
                  strokeWidth: 1,
                  strokeStyle: 'solid',
                  roughness: 0,
                  opacity: 100,
                  groupIds: [],
                  frameId: null,
                  roundness: null,
                  seed: Math.floor(Math.random() * 1000000) + 1,
                  version: 1,
                  versionNonce: Math.floor(Math.random() * 1000000000) + 1,
                  isDeleted: false,
                  boundElements: null,
                  updated: now,
                  link: null,
                  locked: false,
                  fileId,
                  status: 'saved',
                  scale: [1, 1],
                  crop: null,
                };
                const existing =
                  api.getSceneElementsIncludingDeleted?.() || api.getSceneElements?.() || [];
                const normalized = normalizeForExcalidraw([
                  ...existing.map((el: any) => serializeElement(el)),
                  newImgEl,
                ]);
                api.updateScene({ elements: normalized });
                schedulePostPasteOrImageSync();
              };
              img.src = dataURL;
            }
          }
        }
      }

      schedulePostPasteOrImageSync();
    };

    const handleDocDrop = () => {
      schedulePostPasteOrImageSync();
    };

    document.addEventListener('pointermove', handleDocPointerMove, {
      capture: true,
      passive: true,
    });
    document.addEventListener('paste', handleDocPasteCapture, { capture: true });
    document.addEventListener('drop', handleDocDrop, { capture: true });

    return () => {
      document.removeEventListener('pointermove', handleDocPointerMove, { capture: true });
      document.removeEventListener('paste', handleDocPasteCapture, { capture: true });
      document.removeEventListener('drop', handleDocDrop, { capture: true });
    };
  }, [isEditable, normalizeForExcalidraw, serializeElement, schedulePostPasteOrImageSync]);

  // Track native pointerdown / pointerup on the Excalidraw canvas so we:
  // 1. Know when the user is mid-drag (preventing remote sync from calling updateScene mid-stroke)
  // 2. Always flush finalized element dimensions immediately after pointerup
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;

    const handlePointerDownCapture = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('canvas')) {
        isPointerDownRef.current = true;
      }
    };

    const handlePointerEnd = () => {
      if (!isPointerDownRef.current) return;
      isPointerDownRef.current = false;
      window.setTimeout(() => {
        flushLocalSceneDiffs();
        if (pendingRemoteSyncRef.current) {
          pendingRemoteSyncRef.current = false;
          setRemoteSyncTick((t) => t + 1);
        }
      }, 16);
    };

    const handleTextCommitOrKeyUp = () => {
      window.setTimeout(() => {
        flushLocalSceneDiffs();
        if (pendingRemoteSyncRef.current && !isPointerDownRef.current) {
          const api = excalidrawApiRef.current;
          if (api && !isUserActivelyInteracting(api)) {
            pendingRemoteSyncRef.current = false;
            setRemoteSyncTick((t) => t + 1);
          }
        }
      }, 25);
    };

    root.addEventListener('pointerdown', handlePointerDownCapture, { capture: true });
    root.addEventListener('keyup', handleTextCommitOrKeyUp, { capture: true });
    root.addEventListener('focusout', handleTextCommitOrKeyUp, { capture: true });
    window.addEventListener('pointerup', handlePointerEnd, { capture: true });
    window.addEventListener('pointercancel', handlePointerEnd, { capture: true });
    window.addEventListener('blur', handlePointerEnd);

    return () => {
      root.removeEventListener('pointerdown', handlePointerDownCapture, { capture: true });
      root.removeEventListener('keyup', handleTextCommitOrKeyUp, { capture: true });
      root.removeEventListener('focusout', handleTextCommitOrKeyUp, { capture: true });
      window.removeEventListener('pointerup', handlePointerEnd, { capture: true });
      window.removeEventListener('pointercancel', handlePointerEnd, { capture: true });
      window.removeEventListener('blur', handlePointerEnd);
    };
  }, [flushLocalSceneDiffs, isUserActivelyInteracting]);

  // Handle Excalidraw onChange (Teacher element diffs, deletions, Undo/Redo, Image files, Camera)
  const handleExcalidrawChange = useCallback(
    (sceneElements: readonly any[], appState: any, sceneFiles?: Record<string, any>) => {
      const zoomVal = appState?.zoom?.value ?? 1;
      const scrollX = appState?.scrollX ?? 0;
      const scrollY = appState?.scrollY ?? 0;
      const currentTool = appState?.activeTool?.type || 'selection';

      if (activeToolTypeRef.current !== currentTool) {
        activeToolTypeRef.current = currentTool;
        setActiveToolType(currentTool);
      }

      setLocalViewState((prev) => {
        if (
          Math.abs(prev.scrollX - scrollX) > 0.5 ||
          Math.abs(prev.scrollY - scrollY) > 0.5 ||
          Math.abs(prev.zoom - zoomVal) > 0.002
        ) {
          return { scrollX, scrollY, zoom: zoomVal };
        }
        return prev;
      });

      // Detect when student manually pans, scrolls, or zooms the canvas while following teacher
      if (
        role === 'student' &&
        !isRoughPad &&
        followTeacherRef.current &&
        !isApplyingRemoteRef.current
      ) {
        const baseView = lastAppliedTeacherViewRef.current || localViewState;
        if (
          baseView &&
          (Math.abs(scrollX - baseView.scrollX) > 1.5 ||
            Math.abs(scrollY - baseView.scrollY) > 1.5 ||
            Math.abs(zoomVal - baseView.zoom) > 0.005)
        ) {
          followTeacherRef.current = false;
          onToggleFollowRef.current(false);
        }
      }

      if (!isEditable) {
        return;
      }

      if (isApplyingRemoteRef.current) return;

      // Sync newly added binary files (Insert Image tool & clipboard pasted / dropped images)
      syncLocalFilesFromApi(sceneFiles);

      // If any image element in the scene is still awaiting async fileId initialization (from paste/drop),
      // schedule follow-up sync passes so its finalized fileId, dataURL, and dimensions broadcast as soon as ready.
      if (
        Array.isArray(sceneElements) &&
        sceneElements.some(
          (el: any) =>
            el &&
            !el.isDeleted &&
            el.type === 'image' &&
            (!el.fileId || !knownFileIdsRef.current.has(el.fileId))
        )
      ) {
        schedulePostPasteOrImageSync();
      }

      flushLocalSceneDiffs(sceneElements);

      // If a remote update arrived while the user was editing text or multi-point line and that interaction just ended, apply it
      if (
        pendingRemoteSyncRef.current &&
        !isPointerDownRef.current &&
        !Boolean(
          appState?.draggingElement ||
            appState?.newElement ||
            appState?.resizingElement ||
            appState?.editingElement ||
            appState?.editingTextElement ||
            appState?.multiElement ||
            appState?.selectionElement
        )
      ) {
        pendingRemoteSyncRef.current = false;
        setRemoteSyncTick((t) => t + 1);
      }

      // Live board collaborator (Host, Co-Host, or Student with WB access): emit camera center & viewport dimensions
      if (isEditable && !isRoughPad) {
        const w = appState?.width || viewportSizeRef.current.width || 1280;
        const h = appState?.height || viewportSizeRef.current.height || 720;
        emitTeacherCamera(scrollX, scrollY, zoomVal, w, h);
      }
    },
    [
      role,
      isEditable,
      isRoughPad,
      syncLocalFilesFromApi,
      schedulePostPasteOrImageSync,
      flushLocalSceneDiffs,
      emitTeacherCamera,
    ]
  );

  // Broadcast Teacher / Collaborator pointer / laser world coordinates (Lx, Ly) & record laser trail
  const handlePointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number; tool: 'pointer' | 'laser' };
      button: 'down' | 'up';
    }) => {
      if (payload.button === 'down') {
        isPointerDownRef.current = true;
      } else if (payload.button === 'up' && isPointerDownRef.current) {
        isPointerDownRef.current = false;
        window.setTimeout(() => {
          flushLocalSceneDiffs();
          if (pendingRemoteSyncRef.current) {
            pendingRemoteSyncRef.current = false;
            setRemoteSyncTick((t) => t + 1);
          }
        }, 16);
      }

      if (!isEditable || isRoughPad) return;

      const worldX = Math.round(payload.pointer.x * 10) / 10;
      const worldY = Math.round(payload.pointer.y * 10) / 10;
      const effectiveTool: 'pointer' | 'laser' =
        payload.pointer.tool === 'laser' || activeToolTypeRef.current === 'laser'
          ? 'laser'
          : 'pointer';

      if (effectiveTool === 'laser') {
        setTeacherLocalCursor({ x: worldX, y: worldY, active: true });
        if (payload.button === 'down') {
          const now = Date.now();
          setLaserTrail((prev) => {
            const fresh = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
            const last = fresh[fresh.length - 1];
            if (last && Math.hypot(last.x - worldX, last.y - worldY) < 1.5) {
              return fresh;
            }
            return [...fresh.slice(-64), { x: worldX, y: worldY, t: now }];
          });
        } else {
          setLaserTrail((prev) => (prev.length > 0 ? [] : prev));
        }
      } else {
        setTeacherLocalCursor((prev) => (prev.active ? { ...prev, active: false } : prev));
        setLaserTrail((prev) => (prev.length > 0 ? [] : prev));
      }

      if (!onCursorMoveRef.current) return;
      const now = Date.now();
      if (now - lastCursorEmitRef.current < 25) return;
      lastCursorEmitRef.current = now;

      onCursorMoveRef.current({
        x: worldX,
        y: worldY,
        tool: effectiveTool,
        button: payload.button,
        active: true,
      });
    },
    [isEditable, isRoughPad, flushLocalSceneDiffs]
  );

  // Clear entire Whiteboard for Teacher ONLY (or Student Personal Rough Pad).
  // Students on the shared Live Board must NEVER be given a Clear button or permitted to clear the board.
  const canClearWhiteboard = isEditable && (role === 'teacher' || isRoughPad);

  const handleClearTeacherBoard = useCallback(() => {
    if (role !== 'teacher' && !isRoughPad) return;
    const api = excalidrawApiRef.current;
    if (!api) return;
    elementSigMapRef.current.clear();
    sceneSyncedImageKeysRef.current.clear();
    beginApplyingRemote();
    api.updateScene({ elements: [] });
    endApplyingRemote();
    if (isRoughPad) {
      onUpdateRoughPadRef.current?.([]);
    } else {
      onClearBoardRef.current?.();
    }
  }, [role, isRoughPad, beginApplyingRemote, endApplyingRemote]);

  // Mount a dedicated slot inside Excalidraw's bottom-docked toolbar (.App-toolbar)
  // so the "Clear" button lives exclusively inside the toolbar pill (Teacher / RoughPad only).
  const [toolbarClearSlot, setToolbarClearSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!canClearWhiteboard || !apiReady) {
      setToolbarClearSlot(null);
      return;
    }
    const root = wrapperRef.current;
    if (!root) return;

    const ensureToolbarSlot = () => {
      const toolbarRow =
        (root.querySelector('.App-toolbar > .Stack_horizontal') as HTMLElement | null) ||
        (root.querySelector('.App-toolbar') as HTMLElement | null);
      if (!toolbarRow) return;

      let slot = toolbarRow.querySelector('.wb-toolbar-clear-slot') as HTMLElement | null;
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'wb-toolbar-clear-slot flex items-center shrink-0';
        toolbarRow.appendChild(slot);
      }
      setToolbarClearSlot((prev) => (prev === slot ? prev : slot));
    };

    ensureToolbarSlot();
    const observer = new MutationObserver(() => {
      ensureToolbarSlot();
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [canClearWhiteboard, apiReady]);

  // Stable Excalidraw API callback: wait one tick after mount so Excalidraw's internal
  // initializeScene(initialData) microtask completes before apiReady triggers updateScene.
  const handleExcalidrawAPI = useCallback(
    (api: any) => {
      if (!api) return;
      if (excalidrawApiRef.current !== api) {
        excalidrawApiRef.current = api;
        if (typeof window !== 'undefined' && !isRoughPad) {
          (window as any).__EXCALIDRAW_API__ = api;
        }
        window.setTimeout(() => {
          setApiReady(true);
        }, 25);
      }
    },
    [isRoughPad]
  );

  // Stable initialData object: keep initialDataRef.current.elements updated with normalized
  // elements until Excalidraw mounts (apiReady === true) so initializeScene never overwrites
  // the canvas with an empty array.
  const initialDataRef = useRef<any>({
    elements: [],
    appState: {
      viewBackgroundColor: '#ffffff',
      currentItemStrokeColor: '#0f172a',
      currentItemBackgroundColor: 'transparent',
      currentItemFontFamily: DEFAULT_WHITEBOARD_FONT_FAMILY,
      theme: 'light',
    },
  });
  if (!apiReady) {
    const initSource = isRoughPad ? roughPadElements : elements;
    initialDataRef.current.elements = normalizeForExcalidraw(initSource);
  }

  // Stable scroll change handler
  const handleScrollChange = useCallback(
    (scrollX: number, scrollY: number, zoom: any) => {
      const zVal = zoom?.value ?? 1;
      setLocalViewState((prev) => {
        if (
          Math.abs(prev.scrollX - scrollX) > 0.5 ||
          Math.abs(prev.scrollY - scrollY) > 0.5 ||
          Math.abs(prev.zoom - zVal) > 0.002
        ) {
          return { scrollX, scrollY, zoom: zVal };
        }
        return prev;
      });
      if (isEditable && !isRoughPad) {
        emitTeacherCamera(
          scrollX,
          scrollY,
          zVal,
          viewportSizeRef.current.width,
          viewportSizeRef.current.height
        );
      } else if (
        !isEditable &&
        !isRoughPad &&
        followTeacherRef.current &&
        !isApplyingRemoteRef.current &&
        Date.now() >= suppressRemoteCameraEchoUntilRef.current
      ) {
        const baseView = lastAppliedTeacherViewRef.current || localViewState;
        if (
          baseView &&
          (Math.abs(scrollX - baseView.scrollX) > 1.5 ||
            Math.abs(scrollY - baseView.scrollY) > 1.5 ||
            Math.abs(zVal - baseView.zoom) > 0.005)
        ) {
          followTeacherRef.current = false;
          onToggleFollowRef.current(false);
        }
      }
    },
    [isEditable, isRoughPad, emitTeacherCamera, localViewState]
  );

  // Follower canvas pan/scroll gestures: moving canvas while following unlocks followTeacher
  // and reveals the bottom "Follow Teacher" button; clicking "Follow Teacher" re-locks and hides it.
  const handleStudentWrapperWheel = useCallback(() => {
    if (!isEditable && !isRoughPad && followTeacherRef.current) {
      followTeacherRef.current = false;
      onToggleFollowRef.current(false);
    }
  }, [isEditable, isRoughPad]);

  const handleStudentPointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((role !== 'student' && isEditable) || isRoughPad) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          '[data-prevent-nav-toggle="true"], button, .App-toolbar, .App-menu, input, textarea'
        )
      ) {
        return;
      }
      if (!isEditable || activeToolTypeRef.current === 'hand') {
        const api = excalidrawApiRef.current;
        const appState = api?.getAppState?.() || {};
        studentDragPanStartRef.current = {
          clientX: e.clientX,
          clientY: e.clientY,
          scrollX: appState.scrollX ?? localViewState.scrollX ?? 0,
          scrollY: appState.scrollY ?? localViewState.scrollY ?? 0,
          zoom: appState.zoom?.value ?? localViewState.zoom ?? 1,
          hasPanned: false,
        };
      }
    },
    [role, isRoughPad, isEditable, localViewState.scrollX, localViewState.scrollY, localViewState.zoom]
  );

  const handleStudentPointerMoveCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = studentDragPanStartRef.current;
      if (!drag || isRoughPad) return;
      const dx = e.clientX - drag.clientX;
      const dy = e.clientY - drag.clientY;
      if (!drag.hasPanned && Math.hypot(dx, dy) < 5) return;

      drag.hasPanned = true;
      isPointerDownRef.current = true;
      if (!isEditable && followTeacherRef.current) {
        followTeacherRef.current = false;
        onToggleFollowRef.current(false);
      }

      if (!isEditable) {
        const api = excalidrawApiRef.current;
        if (api) {
          const safeZoom = Math.max(0.1, drag.zoom || 1);
          const nextScrollX = drag.scrollX + dx / safeZoom;
          const nextScrollY = drag.scrollY + dy / safeZoom;
          beginApplyingRemote();
          api.updateScene({
            appState: {
              scrollX: nextScrollX,
              scrollY: nextScrollY,
            },
          });
          endApplyingRemote();
          setLocalViewState((prev) => ({
            ...prev,
            scrollX: nextScrollX,
            scrollY: nextScrollY,
          }));
        }
      }
    },
    [isRoughPad, isEditable, beginApplyingRemote, endApplyingRemote]
  );

  const handleStudentPointerUpCapture = useCallback(() => {
    if (studentDragPanStartRef.current) {
      studentDragPanStartRef.current = null;
      isPointerDownRef.current = false;
    }
  }, []);

  // Stable UIOptions object
  const uiOptions = useMemo(
    () => ({
      canvasActions: {
        toggleTheme: false,
        changeViewBackgroundColor: false,
        clearCanvas: false,
        loadScene: false,
        saveToActiveFile: false,
        export: false as const,
        saveAsImage: false,
      },
    }),
    []
  );

  const handleCopyBoardToRoughPad = () => {
    if (!onCopyToRoughPad) return;
    const activeElements = elements
      .filter((e) => !e.isDeleted)
      .map((e) => ({
        ...e,
        version: (e.version || 1) + 1,
      }));
    onCopyToRoughPad(activeElements);
    setCopiedToast(true);
    window.setTimeout(() => setCopiedToast(false), 2000);
  };

  // Compute screen coordinates for Remote Collaborator Live Cursor (visible to Students AND Teachers/Co-Hosts)
  const isRemoteCollaboratorCursor =
    !isRoughPad &&
    Boolean(whiteboardCursor?.active) &&
    (!currentUserId || !whiteboardCursor?.userId || whiteboardCursor.userId !== currentUserId);

  const teacherCursorScreen =
    isRemoteCollaboratorCursor && whiteboardCursor
      ? {
          left: (whiteboardCursor.x + localViewState.scrollX) * localViewState.zoom,
          top: (whiteboardCursor.y + localViewState.scrollY) * localViewState.zoom,
          isLaser: whiteboardCursor.tool === 'laser',
          teacherName: whiteboardCursor.teacherName || 'Collaborator',
        }
      : null;

  // Compute screen coordinates for Local Editor's own Laser dot when Laser tool is active
  const teacherSelfLaserScreen =
    isEditable && activeToolType === 'laser' && teacherLocalCursor.active
      ? {
          left: (teacherLocalCursor.x + localViewState.scrollX) * localViewState.zoom,
          top: (teacherLocalCursor.y + localViewState.scrollY) * localViewState.zoom,
        }
      : null;

  // Build smooth SVG polyline segments for the decaying Laser Trail (world -> screen projected)
  const showLaserTrail =
    !isRoughPad &&
    laserTrail.length >= 2 &&
    ((isEditable && activeToolType === 'laser') ||
      (isRemoteCollaboratorCursor && whiteboardCursor?.tool === 'laser'));

  return (
    <div
      ref={wrapperRef}
      data-role={role}
      onWheel={handleStudentWrapperWheel}
      onPointerDownCapture={handleStudentPointerDownCapture}
      onPointerMoveCapture={handleStudentPointerMoveCapture}
      onPointerUpCapture={handleStudentPointerUpCapture}
      onPointerCancelCapture={handleStudentPointerUpCapture}
      className={`excalidraw-wrapper w-full h-full flex-1 relative overflow-hidden bg-white select-none ${
        !isEditable && !isRoughPad ? 'excalidraw-wrapper--student-live' : ''
      }`}
    >
      {/* Official @excalidraw/excalidraw Canvas */}
      <Excalidraw
        excalidrawAPI={handleExcalidrawAPI}
        theme="light"
        viewModeEnabled={!isEditable}
        initialData={initialDataRef.current}
        onChange={handleExcalidrawChange}
        onPointerUpdate={handlePointerUpdate}
        onScrollChange={handleScrollChange}
        UIOptions={uiOptions}
      />

      {/* Portal Clear Button Directly Inside Excalidraw's Bottom Toolbar Pill (Teacher / RoughPad ONLY) */}
      {canClearWhiteboard &&
        toolbarClearSlot &&
        createPortal(
          <>
            <div className="App-toolbar__divider" />
            <button
              type="button"
              data-testid="whiteboard-clear-btn"
              data-prevent-nav-toggle="true"
              onClick={handleClearTeacherBoard}
              title="Clear Whiteboard Canvas"
              className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 h-8 sm:h-9 rounded-lg text-[11px] sm:text-xs font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-600 active:bg-rose-100 transition-colors cursor-pointer shrink-0 select-none"
            >
              <Trash2 className="w-3 sm:w-3.5 h-3 sm:h-3.5 text-rose-500 shrink-0" />
              <span>Clear</span>
            </button>
          </>,
          toolbarClearSlot
        )}

      {/* World-Coordinate Decaying SVG Laser Trail Overlay (Teacher & Student Responsive Sync) */}
      {showLaserTrail && (
        <svg
          className="pointer-events-none absolute inset-0 z-25 w-full h-full overflow-visible"
          width={viewportSize.width}
          height={viewportSize.height}
        >
          <defs>
            <filter id="laser-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {laserTrail.map((pt, idx) => {
            if (idx === 0) return null;
            const prev = laserTrail[idx - 1];
            const age = Date.now() - pt.t;
            const life = Math.max(0, 1 - age / LASER_TRAIL_DURATION_MS);
            if (life <= 0.02) return null;

            const x1 = (prev.x + localViewState.scrollX) * localViewState.zoom;
            const y1 = (prev.y + localViewState.scrollY) * localViewState.zoom;
            const x2 = (pt.x + localViewState.scrollX) * localViewState.zoom;
            const y2 = (pt.y + localViewState.scrollY) * localViewState.zoom;

            return (
              <g key={`${pt.t}-${idx}`}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="rgba(244, 63, 94, 0.35)"
                  strokeWidth={Math.max(4, 10 * life)}
                  strokeLinecap="round"
                />
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#f43f5e"
                  strokeOpacity={Math.min(1, life * 1.15)}
                  strokeWidth={Math.max(1.5, 4.5 * life)}
                  strokeLinecap="round"
                  filter="url(#laser-glow)"
                />
              </g>
            );
          })}
        </svg>
      )}

      {/* Teacher Local Glowing Laser Dot (Provides instant feedback on hover & drag when Laser tool is active) */}
      {teacherSelfLaserScreen &&
        teacherSelfLaserScreen.left >= 0 &&
        teacherSelfLaserScreen.top >= 0 &&
        teacherSelfLaserScreen.left <= viewportSize.width &&
        teacherSelfLaserScreen.top <= viewportSize.height && (
          <div
            className="pointer-events-none absolute left-0 top-0 z-30"
            style={{
              transform: `translate3d(${teacherSelfLaserScreen.left}px, ${teacherSelfLaserScreen.top}px, 0)`,
            }}
          >
            <div className="relative -translate-x-1/2 -translate-y-1/2">
              <div className="w-4 h-4 rounded-full bg-rose-500 shadow-[0_0_18px_6px_rgba(244,63,94,0.75)] ring-2 ring-white" />
            </div>
          </div>
        )}

      {/* Student / Co-Teacher / Rough Pad Responsive Floating HUD */}
      <StudentWhiteboardControls
        role={role}
        isRoughPad={isRoughPad}
        isEditable={isEditable}
        followTeacher={followTeacher}
        studentZoomMultiplier={studentZoomMultiplier}
        copiedToast={copiedToast}
        onToggleFollow={onToggleFollow}
        onChangeZoomMultiplier={onChangeZoomMultiplier}
        onCopyToRoughPad={
          onCopyToRoughPad ? handleCopyBoardToRoughPad : undefined
        }
        onSwitchToLiveBoard={onSwitchToLiveBoard}
      />

      {/* Teacher Live Laser / Pointer Overlay on Student Live Board (Formula B.5) */}
      {teacherCursorScreen &&
        teacherCursorScreen.left >= -24 &&
        teacherCursorScreen.top >= -24 &&
        teacherCursorScreen.left <= viewportSize.width + 24 &&
        teacherCursorScreen.top <= viewportSize.height + 24 && (
          <div
            className="pointer-events-none absolute left-0 top-0 z-30 transition-transform duration-75 ease-out"
            style={{
              transform: `translate3d(${teacherCursorScreen.left}px, ${teacherCursorScreen.top}px, 0)`,
            }}
          >
            <div className="relative -translate-x-1/2 -translate-y-1/2">
              {teacherCursorScreen.isLaser ? (
                <>
                  <span className="absolute -inset-2 rounded-full bg-rose-500/35 animate-ping" />
                  <div className="w-4 h-4 rounded-full bg-rose-500 shadow-[0_0_20px_7px_rgba(244,63,94,0.8)] ring-2 ring-white" />
                </>
              ) : (
                <div className="w-3.5 h-3.5 rounded-full bg-[#12a3ff] shadow-[0_0_10px_2px_rgba(18,163,255,0.45)] ring-2 ring-white" />
              )}
              <span
                className={`absolute left-4 top-2 px-2 py-0.5 rounded-full text-white text-[10px] font-semibold whitespace-nowrap shadow-sm ${
                  teacherCursorScreen.isLaser ? 'bg-rose-600/95' : 'bg-slate-900/90'
                }`}
              >
                {teacherCursorScreen.isLaser ? '🔴 Teacher Laser' : teacherCursorScreen.teacherName}
              </span>
            </div>
          </div>
        )}
    </div>
  );
};
