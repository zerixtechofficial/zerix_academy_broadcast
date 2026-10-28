'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import '../styles/learning-content.css';
import {
  ContentModeState,
  ContentStroke,
  LaserPointerState,
} from '../hooks/useBroadcastSocket';
import {
  PenTool,
  Highlighter,
  Eraser,
  Sparkles,
  Trash2,
  MousePointer,
  Compass,
  BookOpen,
} from 'lucide-react';
import {
  AnchoredStrokePoint,
  BlockDomLayoutCache,
  buildResponsiveSvgPath,
  captureStrokePoint,
  computeFollowerTargetScrollTop,
  computeScrollAnchorForViewport,
  extractAnchorTokensFromPoints,
  hitTestWordToken,
  measureBlockDomLayout,
  projectPointToDevicePixels,
  sanitizeSvgMarkup,
  ScrollBlockMetric,
  TextTokenSegment,
  tokenizeHtmlContent,
  tokenizeText,
} from '../utils/contentSyncMath';

export interface LessonBlock {
  blockId: string;
  type: 'heading' | 'concept' | 'formula' | 'problem' | 'diagram';
  title?: string;
  content: string;
  contentHtml?: string;
  formulaLatex?: string;
  svgDiagram?: string;
  topicId?: string;
  topicTitle?: string;
}

interface VirtualContentStageProps {
  role: 'teacher' | 'student';
  currentUserId?: string;
  isHostTeacher?: boolean;
  canEditContent?: boolean;
  lessonTitle: string;
  topicTitle: string;
  blocks: LessonBlock[];
  contentState: ContentModeState;
  laserPointer: LaserPointerState;
  isToolboxVisible?: boolean;
  followTeacher: boolean;
  onToggleFollow: (follow: boolean) => void;
  onScrollSync: (blockId: string, offsetRatio: number) => void;
  onAddStroke: (stroke: ContentStroke) => void;
  onDeleteStroke: (strokeId: string) => void;
  onClearStrokes: () => void;
  onLaserMove: (laser: LaserPointerState) => void;
  onSendBlockToWhiteboard?: (block: LessonBlock) => void;
}

interface TokenAnnotationInfo {
  highlightedColor?: string;
  markedColor?: string;
  strokeIds: string[];
}

/**
 * Helper to convert a hex color (e.g. `#ef4444` or `#facc15`) to an `rgba(...)` string.
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || '#facc15').replace('#', '');
  if (clean.length !== 6) {
    return `rgba(250, 204, 21, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16) || 250;
  const g = parseInt(clean.slice(2, 4), 16) || 204;
  const b = parseInt(clean.slice(4, 6), 16) || 21;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const VirtualContentStage: React.FC<VirtualContentStageProps> = ({
  role,
  currentUserId,
  isHostTeacher,
  canEditContent,
  lessonTitle,
  topicTitle,
  blocks,
  contentState,
  laserPointer,
  isToolboxVisible = true,
  followTeacher,
  onToggleFollow,
  onScrollSync,
  onAddStroke,
  onDeleteStroke,
  onClearStrokes,
  onLaserMove,
  onSendBlockToWhiteboard,
}) => {
  const canAnnotate = canEditContent ?? role === 'teacher';
  const effectiveIsHostTeacher = isHostTeacher ?? role === 'teacher';
  const isRemoteLaser = Boolean(
    laserPointer.active &&
      (!currentUserId || !laserPointer.authorId || laserPointer.authorId !== currentUserId)
  );
  const outerContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageSheetRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Cached DOM layouts per blockId for O(1) word-token & sub-region coordinate projection
  const [blockLayouts, setBlockLayouts] = useState<Record<string, BlockDomLayoutCache>>({});
  const activeDrawCacheRef = useRef<BlockDomLayoutCache | null>(null);

  // Content tools: select (cursor), pen, laser, eraser
  const [activeTool, setActiveTool] = useState<'cursor' | 'pen' | 'eraser' | 'laser'>('cursor');
  const [penColor, setPenColor] = useState<string>('#ef4444');
  const [activeDrawingBlockId, setActiveDrawingBlockId] = useState<string | null>(null);
  const [currentPoints, setCurrentPoints] = useState<AnchoredStrokePoint[]>([]);
  const [currentAnchorTokens, setCurrentAnchorTokens] = useState<string[]>([]);
  const activeDrawingBlockIdRef = useRef<string | null>(null);
  const currentPointsRef = useRef<AnchoredStrokePoint[]>([]);

  // Excalidraw-Style Laser Trail & Exact Cursor Tracking
  const LASER_TRAIL_DURATION_MS = 850;
  const [laserTrail, setLaserTrail] = useState<{ x: number; y: number; t: number }[]>([]);
  const [teacherLaserCoord, setTeacherLaserCoord] = useState<{ x: number; y: number; active: boolean; tool?: 'cursor' | 'laser' | 'pen' | 'eraser' } | null>(null);
  const [remoteLaserCoord, setRemoteLaserCoord] = useState<{ x: number; y: number; active: boolean; tool?: 'cursor' | 'laser' | 'pen' | 'eraser' } | null>(null);

  const isProgrammaticScrollRef = useRef<boolean>(false);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef<boolean>(false);
  const userScrollTimeoutRef = useRef<number | null>(null);
  const [isOutOfSync, setIsOutOfSync] = useState<boolean>(false);
  const lastLaserEmitRef = useRef<number>(0);
  const lastEmittedLaserRef = useRef<LaserPointerState | null>(null);
  const lastScrollEmitRef = useRef<number>(0);
  const lastMatchedBlockIdRef = useRef<string>('blk_header');
  const lastOffsetRatioRef = useRef<number>(0);
  const hasEmittedInitialScrollRef = useRef<boolean>(false);
  const lastTargetBlockIdRef = useRef<string | null>(null);
  const lastCursorScrollTimeRef = useRef<number>(0);
  const idlePointerTimerRef = useRef<number | null>(null);

  /**
   * Re-measures all rendered block DOM layouts (`[data-token-id]` and `[data-region-id]`)
   * whenever the viewport width, orientation, or lesson content changes.
   * This allows freehand strokes, word highlights, and laser coordinates to project
   * onto the exact corresponding words on any device width (375px Mobile vs 1280px Desktop).
   */
  const measureAllBlocksLayout = useCallback(() => {
    const nextLayouts: Record<string, BlockDomLayoutCache> = {};
    for (const [blockId, el] of Object.entries(blockRefs.current)) {
      if (el) {
        nextLayouts[blockId] = measureBlockDomLayout(blockId, el);
      }
    }
    setBlockLayouts(nextLayouts);
  }, []);

  /**
   * Returns a fresh `BlockDomLayoutCache` for `blockId`, synchronously measuring the live
   * DOM node if the cache is not yet populated or if the block's rendered dimensions changed.
   */
  const getFreshBlockLayout = useCallback(
    (blockId: string): BlockDomLayoutCache | undefined => {
      const cached = blockLayouts[blockId];
      const liveEl = blockRefs.current[blockId];
      if (!liveEl) return cached;
      const liveRect = liveEl.getBoundingClientRect();
      if (
        !cached ||
        cached.blockRect.width <= 0 ||
        Math.abs(cached.blockRect.width - liveRect.width) > 1.5 ||
        Math.abs(cached.blockRect.height - liveRect.height) > 1.5 ||
        (cached.tokens.size === 0 && liveEl.querySelector('[data-token-id]') !== null)
      ) {
        if (liveRect.width > 0 && liveRect.height > 0) {
          return measureBlockDomLayout(blockId, liveEl);
        }
      }
      return cached;
    },
    [blockLayouts]
  );

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      measureAllBlocksLayout();
    });
    const timerId = window.setTimeout(measureAllBlocksLayout, 100);

    const observer = new ResizeObserver(() => {
      measureAllBlocksLayout();
    });

    if (outerContainerRef.current) observer.observe(outerContainerRef.current);
    if (pageSheetRef.current) observer.observe(pageSheetRef.current);
    Object.values(blockRefs.current).forEach((el) => {
      if (el) observer.observe(el);
    });
    if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => {
        measureAllBlocksLayout();
      }).catch(() => {});
    }
    window.addEventListener('resize', measureAllBlocksLayout);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      observer.disconnect();
      window.removeEventListener('resize', measureAllBlocksLayout);
    };
  }, [blocks, measureAllBlocksLayout]);

  // Ensure layout cache is populated whenever new strokes arrive
  useEffect(() => {
    if (contentState.penStrokes.length > 0 && Object.keys(blockLayouts).length === 0) {
      measureAllBlocksLayout();
    }
  }, [contentState.penStrokes.length, blockLayouts, measureAllBlocksLayout]);

  // Decaying laser trail timer: smoothly animates fading trail and prunes expired points (Excalidraw physics)
  useEffect(() => {
    if (laserTrail.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setLaserTrail((prev) => {
        if (prev.length === 0) return prev;
        const fresh = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
        if (fresh.length === 0 && prev.length === 0) return prev;
        return [...fresh];
      });
    }, 35);
    return () => window.clearInterval(interval);
  }, [laserTrail.length]);

  // When active tool changes away from laser, clear local laser coordinates and trail;
  // when active tool is not 'cursor' (select), clear any active browser text selection immediately
  useEffect(() => {
    if (canAnnotate && activeTool !== 'cursor') {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
    }
    if (activeTool !== 'laser') {
      setTeacherLaserCoord(null);
      setLaserTrail([]);
      if (canAnnotate) {
        onLaserMove({ blockId: '', x: 0, y: 0, active: false });
      }
    }
  }, [activeTool, canAnnotate, onLaserMove]);

  // Remote Laser / Cursor Sync (Host, Co-Host & Students): calculates accurate word/region-anchored coordinates and generates Excalidraw decaying trail
  useEffect(() => {
    if (!isRemoteLaser) {
      setRemoteLaserCoord(null);
      if (!teacherLaserCoord?.active) {
        setLaserTrail([]);
      }
      return;
    }
    const sheetEl = pageSheetRef.current;
    if (!sheetEl) return;
    const sheetRect = sheetEl.getBoundingClientRect();

    let targetX = 0;
    let targetY = 0;

    const targetBlock = laserPointer.blockId ? blockRefs.current[laserPointer.blockId] : null;
    if (targetBlock) {
      const bRect = targetBlock.getBoundingClientRect();
      const cache = getFreshBlockLayout(laserPointer.blockId!);
      if (cache && cache.blockRect.width > 0) {
        const proj = projectPointToDevicePixels(laserPointer as any, cache);
        targetX = bRect.left - sheetRect.left + proj.px;
        targetY = bRect.top - sheetRect.top + proj.py;
      } else {
        targetX = bRect.left - sheetRect.left + (laserPointer.x / 100) * bRect.width;
        targetY = bRect.top - sheetRect.top + (laserPointer.y / 100) * bRect.height;
      }
    } else if (typeof (laserPointer as any).sheetXPct === 'number') {
      targetX = ((laserPointer as any).sheetXPct / 100) * sheetRect.width;
      if (typeof (laserPointer as any).sheetYPct === 'number') {
        targetY = ((laserPointer as any).sheetYPct / 100) * sheetRect.height;
      } else {
        targetY = (laserPointer as any).sheetYPx || 0;
      }
    }

    const now = Date.now();
    setRemoteLaserCoord({ x: targetX, y: targetY, active: true, tool: laserPointer.tool || 'cursor' });
    // Only generate decaying laser trail for followers if remote collaborator was actively dragging in laser mode
    if ((laserPointer as any).isDragging && laserPointer.tool === 'laser') {
      setLaserTrail((prev) => {
        const fresh = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
        const last = fresh[fresh.length - 1];
        if (last && Math.hypot(last.x - targetX, last.y - targetY) < 1.5) {
          return fresh;
        }
        return [...fresh.slice(-64), { x: targetX, y: targetY, t: now }];
      });
    }
  }, [isRemoteLaser, teacherLaserCoord?.active, laserPointer, blockLayouts, getFreshBlockLayout]);

  // Viewport Auto-Scroll Sync to Remote Collaborator's Cursor/Pen Position (Host, Co-Host & Students):
  // IMPORTANT: If the exact point being marked or pointed to is ALREADY visible inside the viewer's
  // viewport (e.g. on a second Laptop at the same scroll position), do NOT scroll or yank the block to
  // the top of the screen! Only adjust scroll smoothly if the remote point is actually off-screen
  // (e.g. on a smaller mobile screen where wrapped text pushed the target point below/above the fold).
  useEffect(() => {
    if (!followTeacher || !isRemoteLaser) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const targetBlockId = laserPointer.blockId;
    if (!targetBlockId) return;

    const targetBlock = blockRefs.current[targetBlockId];
    if (!targetBlock) return;

    const viewportHeight = Math.max(1, container.clientHeight);
    const containerRect = container.getBoundingClientRect();
    const blockRect = targetBlock.getBoundingClientRect();
    const relativeBlockTop = blockRect.top - containerRect.top + container.scrollTop;
    const blockHeight = Math.max(1, targetBlock.offsetHeight || blockRect.height);

    const cache = getFreshBlockLayout(targetBlockId);
    let pointYInBlock = ((laserPointer.y || 0) / 100) * blockHeight;
    if (cache && cache.blockRect.width > 0) {
      const proj = projectPointToDevicePixels(laserPointer as any, cache);
      pointYInBlock = proj.py;
    }

    const pointYInScroll = relativeBlockTop + pointYInBlock;
    const pointYInViewport = pointYInScroll - container.scrollTop;
    const edgeMargin = Math.min(32, Math.max(12, viewportHeight * 0.08));

    // If the exact remote pointer/pen position is already comfortably visible in the viewport,
    // keep the screen position steady and DO NOT jump the section to the top!
    if (pointYInViewport >= edgeMargin && pointYInViewport <= viewportHeight - edgeMargin) {
      lastTargetBlockIdRef.current = targetBlockId;
      return;
    }

    const now = Date.now();
    const hasBlockChanged = lastTargetBlockIdRef.current !== targetBlockId;
    if (!hasBlockChanged && now - lastCursorScrollTimeRef.current < 400) {
      return;
    }

    let targetScrollTop = container.scrollTop;
    if (pointYInViewport > viewportHeight - edgeMargin) {
      targetScrollTop = pointYInScroll - viewportHeight * 0.65;
    } else if (pointYInViewport < edgeMargin) {
      targetScrollTop = Math.max(0, pointYInScroll - viewportHeight * 0.35);
    }

    if (Math.abs(container.scrollTop - targetScrollTop) <= 12) {
      lastTargetBlockIdRef.current = targetBlockId;
      return;
    }

    lastTargetBlockIdRef.current = targetBlockId;
    lastCursorScrollTimeRef.current = now;

    isProgrammaticScrollRef.current = true;
    if (programmaticScrollTimeoutRef.current) window.clearTimeout(programmaticScrollTimeoutRef.current);
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 1000);

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth',
    });
    setIsOutOfSync(false);
  }, [
    followTeacher,
    isRemoteLaser,
    laserPointer,
    getFreshBlockLayout,
  ]);

  const collectScrollBlockMetrics = useCallback(
    (container: HTMLElement): ScrollBlockMetric[] => {
      const containerTop = container.getBoundingClientRect().top;
      const allElements: { blockId: string; el: HTMLElement | null }[] = [
        { blockId: 'blk_header', el: blockRefs.current['blk_header'] },
        ...blocks.map((block) => ({
          blockId: block.blockId,
          el: blockRefs.current[block.blockId],
        })),
      ];
      const metrics: ScrollBlockMetric[] = [];
      for (const item of allElements) {
        if (!item.el) continue;
        const rect = item.el.getBoundingClientRect();
        const topInScroll = rect.top - containerTop + container.scrollTop;
        const height = Math.max(1, item.el.offsetHeight || rect.height);
        metrics.push({ blockId: item.blockId, topInScroll, height });
      }
      return metrics;
    },
    [blocks]
  );

  // Scroll sync to Presenter's (blockId, offsetRatio) across Host, Co-Host & Students
  useEffect(() => {
    const isOwnScroll = Boolean(
      currentUserId &&
        contentState.scrollAnchor?.authorId &&
        contentState.scrollAnchor.authorId === currentUserId
    );
    if (!followTeacher || (canAnnotate && isOwnScroll)) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const anchorBlockId = contentState.scrollAnchor?.blockId;
    const offsetRatio = contentState.scrollAnchor?.offsetRatio || 0;

    // If presenter is at top showing heading (blk_header) with near-zero offset (or no anchor),
    // scroll to exact top 0 so in mobile phone content heading is 100% visible
    if ((anchorBlockId === 'blk_header' || !anchorBlockId) && Math.abs(offsetRatio) <= 0.02) {
      if (container.scrollTop <= 3) {
        setIsOutOfSync(false);
        return;
      }
      if (programmaticScrollTimeoutRef.current) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
      isProgrammaticScrollRef.current = true;
      programmaticScrollTimeoutRef.current = window.setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 1000);

      container.scrollTo({
        top: 0,
        behavior: 'smooth',
      });

      setIsOutOfSync(false);
      return;
    }

    const metrics = collectScrollBlockMetrics(container);
    if (metrics.length === 0) return;

    const targetScrollTop = computeFollowerTargetScrollTop(
      anchorBlockId,
      offsetRatio,
      container.clientHeight,
      container.scrollHeight,
      metrics
    );

    if (Math.abs(container.scrollTop - targetScrollTop) <= 3) {
      setIsOutOfSync(false);
      return;
    }

    if (programmaticScrollTimeoutRef.current) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    isProgrammaticScrollRef.current = true;
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 1000);

    container.scrollTo({
      top: targetScrollTop,
      behavior: 'smooth',
    });

    setIsOutOfSync(false);
  }, [
    currentUserId,
    canAnnotate,
    followTeacher,
    collectScrollBlockMetrics,
    contentState.scrollAnchor?.blockId,
    contentState.scrollAnchor?.offsetRatio,
    contentState.scrollAnchor?.authorId,
    contentState.scrollAnchor?.updatedAt,
  ]);

  // Host Teacher: emit initial scroll anchor on mount so Co-Hosts & Students sync immediately to heading
  useEffect(() => {
    if (effectiveIsHostTeacher && !hasEmittedInitialScrollRef.current) {
      hasEmittedInitialScrollRef.current = true;
      const timer = window.setTimeout(() => {
        const container = scrollContainerRef.current;
        if (container && container.scrollTop <= 20) {
          onScrollSync('blk_header', 0);
        }
      }, 500);
      return () => window.clearTimeout(timer);
    }
  }, [effectiveIsHostTeacher, onScrollSync]);

  // User manual scroll intent helper: tracks active user gestures (wheel, touch, pointer) on all devices
  const handleUserScrollIntent = useCallback(() => {
    isUserScrollingRef.current = true;
    if (userScrollTimeoutRef.current) {
      window.clearTimeout(userScrollTimeoutRef.current);
    }
    userScrollTimeoutRef.current = window.setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 400);
  }, []);

  // Scroll listener:
  // - For Collaborators with Board/Content Access (Host, Co-Host, or Student with Board Access): computes top visible blockId + exact continuous offsetRatio and broadcasts to room
  // - For View-Only Students: checks if student is in sync with presenter's anchor; only shows Follow Teacher if out of sync
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (!canAnnotate) {
      const anchorBlockId = contentState.scrollAnchor?.blockId;
      const offsetRatio = contentState.scrollAnchor?.offsetRatio || 0;
      const metrics = collectScrollBlockMetrics(container);
      const teacherTargetScrollTop = computeFollowerTargetScrollTop(
        anchorBlockId,
        offsetRatio,
        container.clientHeight,
        container.scrollHeight,
        metrics
      );
      const scrollDiff = Math.abs(container.scrollTop - teacherTargetScrollTop);

      // Only mark out-of-sync and unlock followTeacher if user actively wheeled/touched and scrolled away > 75px
      if (isUserScrollingRef.current && !isProgrammaticScrollRef.current) {
        if (scrollDiff > 75) {
          setIsOutOfSync(true);
          if (followTeacher) {
            onToggleFollow(false);
          }
        }
      }

      // If student was out-of-sync but scrolled back within 40px of presenter, re-lock and hide button
      if (!followTeacher && scrollDiff <= 40) {
        setIsOutOfSync(false);
        onToggleFollow(true);
      }
      return;
    }

    // Do not echo programmatic scroll updates (triggered by remote CONTENT_SCROLL_SYNC or cursor auto-scroll) back to the server
    if (isProgrammaticScrollRef.current) return;

    const now = Date.now();
    if (now - lastScrollEmitRef.current < 60) return;
    lastScrollEmitRef.current = now;

    const metrics = collectScrollBlockMetrics(container);
    const { blockId: matchedBlockId, offsetRatio } = computeScrollAnchorForViewport(
      container.scrollTop,
      container.clientHeight,
      container.scrollHeight,
      metrics
    );

    lastMatchedBlockIdRef.current = matchedBlockId;
    lastOffsetRatioRef.current = offsetRatio;
    onScrollSync(matchedBlockId, Number(offsetRatio.toFixed(4)));
  }, [
    canAnnotate,
    followTeacher,
    onToggleFollow,
    collectScrollBlockMetrics,
    onScrollSync,
    contentState.scrollAnchor,
  ]);

  // Erase strokes near a pointer coordinate or matching a touched word token across all content blocks and full-page canvas
  const eraseStrokeAtPointer = useCallback(
    (
      blockId: string,
      clientX: number,
      clientY: number,
      cache: BlockDomLayoutCache,
      liveRect?: DOMRect
    ) => {
      if (contentState.penStrokes.length === 0) return;

      const candidateBlockIds = Array.from(
        new Set([
          blockId,
          'blk_page_canvas',
          'blk_header',
          ...contentState.penStrokes.map((s) => s.blockId),
        ])
      );

      for (const candBlockId of candidateBlockIds) {
        const blockStrokes = contentState.penStrokes.filter((s) => s.blockId === candBlockId);
        if (blockStrokes.length === 0) continue;

        const candEl = blockRefs.current[candBlockId];
        const candRect =
          candBlockId === blockId && liveRect
            ? liveRect
            : candEl?.getBoundingClientRect() || cache.blockRect;
        const candCache =
          candBlockId === blockId
            ? cache
            : getFreshBlockLayout(candBlockId) ||
              (candEl ? measureBlockDomLayout(candBlockId, candEl) : cache);

        const localX = clientX - candRect.left;
        const localY = clientY - candRect.top;
        const pt = captureStrokePoint(clientX, clientY, candCache, candRect);

        for (const stroke of blockStrokes) {
          // 1. Check if pointer hit a word token that belongs to this stroke
          if (
            pt.tokenId &&
            ((Array.isArray(stroke.anchorTokens) &&
              stroke.anchorTokens.includes(pt.tokenId)) ||
              stroke.points.some((p: any) => p.tokenId === pt.tokenId))
          ) {
            onDeleteStroke(stroke.id);
            continue;
          }

          // 2. Check pixel proximity to projected points of this stroke on this device
          for (const sp of stroke.points) {
            const proj = projectPointToDevicePixels(sp, candCache, stroke.tool === 'pen');
            const distPx = Math.hypot(proj.px - localX, proj.py - localY);
            if (distPx <= 22) {
              onDeleteStroke(stroke.id);
              break;
            }
          }
        }
      }
    },
    [contentState.penStrokes, onDeleteStroke, getFreshBlockLayout]
  );

  // Pointer handlers on each block for Pen and Eraser
  const handleBlockPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    blockId: string
  ) => {
    if (!canAnnotate || activeTool === 'cursor') return;
    // Prevent native text selection whenever any non-cursor tool (pen, laser, eraser) is active
    e.preventDefault();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
    if (activeTool === 'laser') return;
    const blockEl = blockRefs.current[blockId];
    if (!blockEl) return;

    const liveRect = blockEl.getBoundingClientRect();
    const cache = measureBlockDomLayout(blockId, blockEl);
    cache.blockRect = liveRect;
    activeDrawCacheRef.current = cache;
    setBlockLayouts((prev) => ({ ...prev, [blockId]: cache }));

    if (activeTool === 'eraser') {
      e.stopPropagation();
      eraseStrokeAtPointer(blockId, e.clientX, e.clientY, cache, liveRect);
      activeDrawingBlockIdRef.current = blockId;
      setActiveDrawingBlockId(blockId);
      return;
    }

    if (activeTool === 'pen') {
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic or non-capturable pointer event
      }
      const pt = captureStrokePoint(e.clientX, e.clientY, cache, liveRect);
      activeDrawingBlockIdRef.current = blockId;
      currentPointsRef.current = [pt];
      setActiveDrawingBlockId(blockId);
      setCurrentPoints([pt]);
      setCurrentAnchorTokens(pt.tokenId ? [pt.tokenId] : []);
    }
  };

  const handleBlockPointerMove = (
    e: React.PointerEvent<HTMLDivElement>,
    blockId: string
  ) => {
    if (!canAnnotate || activeTool === 'cursor' || activeTool === 'laser') return;
    const blockEl = blockRefs.current[blockId];
    if (!blockEl) return;

    const liveRect = blockEl.getBoundingClientRect();
    const cache =
      activeDrawCacheRef.current?.blockId === blockId
        ? activeDrawCacheRef.current
        : blockLayouts[blockId] || measureBlockDomLayout(blockId, blockEl);
    cache.blockRect = liveRect;

    if (
      activeTool === 'eraser' &&
      (activeDrawingBlockIdRef.current === blockId ||
        activeDrawingBlockId === blockId ||
        e.buttons === 1)
    ) {
      eraseStrokeAtPointer(blockId, e.clientX, e.clientY, cache, liveRect);
      return;
    }

    if (
      activeTool === 'pen' &&
      (activeDrawingBlockIdRef.current === blockId || activeDrawingBlockId === blockId)
    ) {
      const pt = captureStrokePoint(e.clientX, e.clientY, cache, liveRect);
      const next = [...currentPointsRef.current, pt];
      currentPointsRef.current = next;
      setCurrentPoints(next);
      setCurrentAnchorTokens(extractAnchorTokensFromPoints(next, cache));

      // Broadcast active block and word/region-anchored pen pointer so remote screens track exact pen position
      const now = Date.now();
      if (now - lastLaserEmitRef.current >= 30) {
        lastLaserEmitRef.current = now;
        onLaserMove({
          blockId,
          x: pt.x,
          y: pt.y,
          active: true,
          tool: 'pen',
          isDragging: true,
          tokenId: pt.tokenId,
          rx: pt.rx,
          ry: pt.ry,
          regionId: pt.regionId,
          regionRx: pt.regionRx,
          regionRy: pt.regionRy,
        });
      }
    }
  };

  const handleBlockPointerUp = (
    e: React.PointerEvent<HTMLDivElement>,
    blockId: string
  ) => {
    if (!canAnnotate) return;
    if (activeTool === 'eraser') {
      activeDrawingBlockIdRef.current = null;
      setActiveDrawingBlockId(null);
      return;
    }

    if (
      activeTool === 'pen' &&
      (activeDrawingBlockIdRef.current === blockId || activeDrawingBlockId === blockId)
    ) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore if not captured
      }
      const pointsToCommit =
        currentPointsRef.current.length > 0 ? currentPointsRef.current : currentPoints;
      if (pointsToCommit.length >= 1) {
        const cache = activeDrawCacheRef.current || blockLayouts[blockId];
        const finalTokens = extractAnchorTokensFromPoints(pointsToCommit, cache);

        const rawPoints: AnchoredStrokePoint[] =
          pointsToCommit.length === 1
            ? [
                pointsToCommit[0],
                {
                  ...pointsToCommit[0],
                  x: Math.min(100, Math.round((pointsToCommit[0].x + 0.6) * 10) / 10),
                  rx:
                    typeof pointsToCommit[0].rx === 'number'
                      ? Math.min(1, pointsToCommit[0].rx + 0.2)
                      : undefined,
                },
              ]
            : pointsToCommit;

        const normalizedPoints: AnchoredStrokePoint[] = rawPoints.map((pt) => ({
          ...pt,
          x: Math.round(pt.x * 10) / 10,
          y: Math.round(pt.y * 10) / 10,
        }));

        const stroke: ContentStroke = {
          id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          blockId,
          color: penColor,
          width: 3,
          tool: 'pen',
          opacity: 1,
          anchorTokens: finalTokens,
          points: normalizedPoints,
        };
        onAddStroke(stroke);
      }
      activeDrawingBlockIdRef.current = null;
      currentPointsRef.current = [];
      setActiveDrawingBlockId(null);
      setCurrentPoints([]);
      setCurrentAnchorTokens([]);
    }
  };

  // Sheet-Wide Cursor & Laser Pointer Handlers: tracks exact cursor coordinates across the entire content sheet
  const handleSheetPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canAnnotate) return;
    if (activeTool !== 'cursor' && (e.type === 'pointerdown' || e.buttons === 1)) {
      if (e.type === 'pointerdown') {
        e.preventDefault();
      }
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
    }

    // When Select/Cursor tool is active, never interrupt native text selection or trigger state updates during drag selection
    if (activeTool === 'cursor') {
      if (e.type === 'pointerdown' || e.buttons === 1) {
        return;
      }
      const activeSel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (activeSel && !activeSel.isCollapsed && activeSel.toString().length > 0) {
        return;
      }
    }

    const sheetEl = pageSheetRef.current;
    if (!sheetEl) return;
    const sheetRect = sheetEl.getBoundingClientRect();
    const sheetX = e.clientX - sheetRect.left;
    const sheetY = e.clientY - sheetRect.top;

    const isDragging = e.buttons === 1;
    const now = Date.now();

    // Reset idle pointer timer whenever teacher moves cursor
    if (idlePointerTimerRef.current) {
      window.clearTimeout(idlePointerTimerRef.current);
      idlePointerTimerRef.current = null;
    }
    // Auto-mark cursor inactive after 4s of complete inactivity
    idlePointerTimerRef.current = window.setTimeout(() => {
      onLaserMove({ blockId: '', x: 0, y: 0, active: false, isDragging: false, tool: activeTool });
    }, 4000);

    // Only generate decaying laser trail line behind the cursor when DRAGGING in laser mode
    if (activeTool === 'laser') {
      if (isDragging) {
        setLaserTrail((prev) => {
          const fresh = prev.filter((pt) => now - pt.t < LASER_TRAIL_DURATION_MS);
          const last = fresh[fresh.length - 1];
          if (last && Math.hypot(last.x - sheetX, last.y - sheetY) < 1.5) {
            return fresh;
          }
          return [...fresh.slice(-64), { x: sheetX, y: sheetY, t: now }];
        });
      }
      setTeacherLaserCoord({ x: sheetX, y: sheetY, active: true, tool: 'laser' });
    } else if (activeTool === 'pen') {
      setTeacherLaserCoord({ x: sheetX, y: sheetY, active: true, tool: 'pen' });
    }

    // In cursor mode, throttle background hover sync to 120ms and avoid forced layout thrashing
    const throttleMs = activeTool === 'cursor' ? 120 : 30;
    if (now - lastLaserEmitRef.current >= throttleMs) {
      lastLaserEmitRef.current = now;
      let targetBlockEl =
        (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-block-id]') as HTMLElement) ||
        null;
      let targetBlockId = targetBlockEl?.getAttribute('data-block-id') || undefined;

      // Fallback: search all blockRefs by vertical position if pointer is in margin/gap
      if (!targetBlockEl) {
        const allEntries = [
          { id: 'blk_header', el: blockRefs.current['blk_header'] },
          ...blocks.map((b) => ({ id: b.blockId, el: blockRefs.current[b.blockId] })),
        ];
        for (const entry of allEntries) {
          if (!entry.el) continue;
          const r = entry.el.getBoundingClientRect();
          if (e.clientY >= r.top - 12 && e.clientY <= r.bottom + 12) {
            targetBlockId = entry.id;
            targetBlockEl = entry.el;
            break;
          }
        }
      }

      let blockRelX = 0;
      let blockRelY = 0;
      let tokenId: string | undefined;
      let rx: number | undefined;
      let ry: number | undefined;
      let regionId: any;
      let regionRx: number | undefined;
      let regionRy: number | undefined;

      if (targetBlockEl && targetBlockId) {
        const bRect = targetBlockEl.getBoundingClientRect();
        const cache =
          activeTool === 'cursor'
            ? blockLayouts[targetBlockId]
            : getFreshBlockLayout(targetBlockId) || measureBlockDomLayout(targetBlockId, targetBlockEl);
        if (cache) {
          const captured = captureStrokePoint(e.clientX, e.clientY, cache, bRect);
          blockRelX = captured.x;
          blockRelY = captured.y;
          tokenId = captured.tokenId;
          rx = captured.rx;
          ry = captured.ry;
          regionId = captured.regionId;
          regionRx = captured.regionRx;
          regionRy = captured.regionRy;
        } else {
          blockRelX = ((e.clientX - bRect.left) / Math.max(1, bRect.width)) * 100;
          blockRelY = ((e.clientY - bRect.top) / Math.max(1, bRect.height)) * 100;
        }
      }

      const sheetXPct = Math.round(((sheetX / Math.max(1, sheetRect.width)) * 100) * 10) / 10;
      const sheetYPct = Math.round(((sheetY / Math.max(1, sheetRect.height)) * 100) * 10) / 10;
      const sheetYPx = Math.round(sheetY);

      const emittedPayload: LaserPointerState = {
        blockId: targetBlockId,
        x: targetBlockEl ? Math.round(blockRelX * 10) / 10 : 0,
        y: targetBlockEl ? Math.round(blockRelY * 10) / 10 : 0,
        active: true,
        isDragging: isDragging && activeTool === 'laser',
        tool: activeTool,
        tokenId,
        rx,
        ry,
        regionId,
        regionRx,
        regionRy,
        sheetXPct,
        sheetYPct,
        sheetYPx,
      } as any;
      lastEmittedLaserRef.current = emittedPayload;
      onLaserMove(emittedPayload);
    }
  };

  const handleSheetPointerUp = useCallback(() => {
    if (canAnnotate && activeTool !== 'cursor') {
      const sheetEl = pageSheetRef.current;
      if (!sheetEl) return;
      const sheetRect = sheetEl.getBoundingClientRect();
      const currentCoord = teacherLaserCoord;
      if (currentCoord && currentCoord.active) {
        const sheetXPct = Math.round(((currentCoord.x / Math.max(1, sheetRect.width)) * 100) * 10) / 10;
        const sheetYPct = Math.round(((currentCoord.y / Math.max(1, sheetRect.height)) * 100) * 10) / 10;
        const prevPayload = lastEmittedLaserRef.current;
        onLaserMove({
          ...(prevPayload || {}),
          blockId: prevPayload?.blockId,
          x: prevPayload?.x ?? 0,
          y: prevPayload?.y ?? 0,
          tokenId: prevPayload?.tokenId,
          rx: prevPayload?.rx,
          ry: prevPayload?.ry,
          regionId: prevPayload?.regionId,
          regionRx: prevPayload?.regionRx,
          regionRy: prevPayload?.regionRy,
          active: true,
          isDragging: false,
          tool: activeTool,
          sheetXPct,
          sheetYPct,
          sheetYPx: Math.round(currentCoord.y),
        } as any);
      }
    }
  }, [canAnnotate, activeTool, teacherLaserCoord, onLaserMove]);

  // Listen for global pointerup so drag release anywhere on window clears isDragging
  useEffect(() => {
    if (!canAnnotate) return;
    window.addEventListener('pointerup', handleSheetPointerUp);
    return () => window.removeEventListener('pointerup', handleSheetPointerUp);
  }, [canAnnotate, handleSheetPointerUp]);

  const handleSheetPointerLeave = () => {
    if (canAnnotate) {
      if (idlePointerTimerRef.current) {
        window.clearTimeout(idlePointerTimerRef.current);
        idlePointerTimerRef.current = null;
      }
      setTeacherLaserCoord(null);
      onLaserMove({ blockId: '', x: 0, y: 0, active: false, isDragging: false, tool: activeTool });
    }
  };

  const getBlockBadgeStyle = (type: LessonBlock['type']) => {
    switch (type) {
      case 'heading':
        return 'bg-sky-50 text-[#12a3ff] border-sky-200';
      case 'formula':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      case 'problem':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'diagram':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  /**
   * Renders deterministic word token `<span>` elements for any text field (`title`, `content`, `formula`).
   * Words that are part of a Teacher's Highlighter or Pen stroke receive exact word-level
   * highlighting/marking on both Desktop and Mobile viewports regardless of line wrapping.
   */
  const renderTokenizedText = (
    segments: TextTokenSegment[],
    tokenAnnotationMap: Map<string, TokenAnnotationInfo>,
    activeLaserTokenId?: string
  ) => {
    return segments.map((seg, idx) => {
      if (!seg.isWord || !seg.tokenId) {
        return <React.Fragment key={`ws_${idx}`}>{seg.text}</React.Fragment>;
      }

      const info = tokenAnnotationMap.get(seg.tokenId);
      const isHighlighted = Boolean(info?.highlightedColor);
      const isMarked = Boolean(info?.markedColor);
      const isLaserTarget = activeLaserTokenId === seg.tokenId;

      const style: React.CSSProperties = {};
      /* Word highlighting with underline commented out as of now — using Pen SVG marking only
      if (isHighlighted && info?.highlightedColor) {
        style.backgroundColor = hexToRgba(info.highlightedColor, 0.42);
        style.boxShadow = `0 0 0 2px ${hexToRgba(info.highlightedColor, 0.35)}`;
        style.borderRadius = '3px';
      } else if (isMarked && info?.markedColor) {
        style.backgroundColor = hexToRgba(info.markedColor, 0.14);
        style.borderBottom = `2px solid ${info.markedColor}`;
        style.borderRadius = '2px';
      }
      */

      return (
        <span
          key={seg.tokenId}
          data-token-id={seg.tokenId}
          data-highlighted={isHighlighted ? 'true' : undefined}
          data-marked={isMarked ? 'true' : undefined}
          data-stroke-ids={info?.strokeIds?.length ? info.strokeIds.join(',') : undefined}
          style={style}
          className="inline transition-colors duration-75"
        >
          {seg.text}
        </span>
      );
    });
  };

  // Interactive MCQ radio button grading matching /learn page behavior
  useEffect(() => {
    const sheetEl = pageSheetRef.current;
    if (!sheetEl) return;

    const handleMcqChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target && target.type === 'radio') {
        const questionEl = target.closest('.mcq-question') as HTMLElement | null;
        if (!questionEl) return;

        const correctOption = questionEl.getAttribute('data-correct')?.trim().toLowerCase();
        const selectedOption = target.value?.trim().toLowerCase();

        const labels = questionEl.querySelectorAll('.mcq-options label');
        labels.forEach((lbl) => {
          lbl.classList.remove('correct-selected', 'wrong-selected');
        });

        const selectedLabel = target.closest('label');
        if (selectedLabel && correctOption) {
          if (selectedOption === correctOption) {
            selectedLabel.classList.add('correct-selected');
          } else {
            selectedLabel.classList.add('wrong-selected');
          }
        }

        const answerBox = questionEl.querySelector('.answer-box') as HTMLElement | null;
        if (answerBox) {
          answerBox.style.display = 'block';
        }
      }
    };

    sheetEl.addEventListener('change', handleMcqChange);
    return () => {
      sheetEl.removeEventListener('change', handleMcqChange);
    };
  }, [blocks]);

  const isSelectionEnabled = !canAnnotate || activeTool === 'cursor';

  // Pre-memoize tokenized HTML, text segments, and SVG markup per block so pointer/scroll/laser re-renders
  // never re-run HTML tokenization or recreate dangerouslySetInnerHTML objects (which would wipe browser text selection and cause frame lag)
  const tokenizedHeaderSegments = useMemo(
    () => tokenizeText(topicTitle || lessonTitle, 'content'),
    [topicTitle, lessonTitle]
  );

  const memoizedBlockContentMap = useMemo(() => {
    const map = new Map<
      string,
      {
        htmlObj?: { __html: string };
        svgObj?: { __html: string };
        titleSegments: TextTokenSegment[];
        contentSegments: TextTokenSegment[];
        formulaSegments: TextTokenSegment[];
      }
    >();
    for (const block of blocks) {
      map.set(block.blockId, {
        htmlObj: block.contentHtml
          ? { __html: tokenizeHtmlContent(block.contentHtml, 'content') }
          : undefined,
        svgObj: block.svgDiagram
          ? { __html: sanitizeSvgMarkup(block.svgDiagram) }
          : undefined,
        titleSegments: tokenizeText(block.title, 'title'),
        contentSegments: tokenizeText(block.content, 'content'),
        formulaSegments: tokenizeText(block.formulaLatex, 'formula'),
      });
    }
    return map;
  }, [blocks]);

  // Block native browser selectstart event whenever activeTool is not 'cursor'
  useEffect(() => {
    const el = outerContainerRef.current;
    if (!el || isSelectionEnabled) return;
    const preventSelect = (e: Event) => {
      e.preventDefault();
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
    };
    el.addEventListener('selectstart', preventSelect);
    return () => el.removeEventListener('selectstart', preventSelect);
  }, [isSelectionEnabled]);

  return (
    <div
      ref={outerContainerRef}
      data-selection-enabled={isSelectionEnabled ? 'true' : 'false'}
      data-active-content-tool={canAnnotate ? activeTool : 'cursor'}
      className={`relative flex-1 h-full flex flex-col bg-[#f8fafc] overflow-hidden ${
        isSelectionEnabled ? 'select-text' : 'select-none'
      }`}
    >
      {/* Floating Teacher / Collaborator Annotation Pill — Mobile Bottom Thumb-Zone & Desktop Top Bar (Toggled via Top Bar Icon or Ctrl+T) */}
      {canAnnotate && isToolboxVisible && (
        <div
          data-prevent-nav-toggle="true"
          className="pointer-events-none absolute bottom-2.5 sm:bottom-auto sm:top-3 left-1/2 -translate-x-1/2 z-30 max-w-[98vw]"
        >
          <div className="pointer-events-auto max-w-full min-w-0 flex items-center gap-0.5 sm:gap-1.5 px-1 sm:px-3 py-1 sm:py-1.5 rounded-full bg-white/95 backdrop-blur-md border border-slate-200 shadow-lg overflow-x-auto no-scrollbar">
            <button
              type="button"
              data-testid="content-tool-cursor"
              onClick={() => {
                setActiveTool('cursor');
                setTeacherLaserCoord(null);
                onLaserMove({ blockId: '', x: 0, y: 0, active: false });
              }}
              className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                activeTool === 'cursor'
                  ? 'bg-[#12a3ff] text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Select / Copy Text & Scroll"
            >
              <MousePointer className="w-3 sm:w-3.5 h-3 sm:h-3.5 shrink-0" />
              <span>Select</span>
            </button>

            <button
              type="button"
              data-testid="content-tool-pen"
              onClick={() => {
                setActiveTool('pen');
                onLaserMove({ blockId: '', x: 0, y: 0, active: false });
              }}
              className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                activeTool === 'pen'
                  ? 'bg-[#12a3ff] text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Annotate / Mark Words with Pen"
            >
              <PenTool className="w-3 sm:w-3.5 h-3 sm:h-3.5 shrink-0" />
              <span>Pen</span>
            </button>

            <button
              type="button"
              data-testid="content-tool-laser"
              onClick={() => setActiveTool('laser')}
              className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                activeTool === 'laser'
                  ? 'bg-rose-500 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Live Laser Pointer"
            >
              <Sparkles className="w-3 sm:w-3.5 h-3 sm:h-3.5 shrink-0" />
              <span>Laser</span>
            </button>

            <button
              type="button"
              data-testid="content-tool-eraser"
              onClick={() => {
                setActiveTool('eraser');
                onLaserMove({ blockId: '', x: 0, y: 0, active: false });
              }}
              className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                activeTool === 'eraser'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Click or Drag over a marked word or stroke to erase it"
            >
              <Eraser className="w-3 sm:w-3.5 h-3 sm:h-3.5 shrink-0" />
              <span>Eraser</span>
            </button>

            {activeTool === 'pen' && (
              <>
                <div className="h-3.5 w-px bg-slate-200 mx-0.5 shrink-0" />
                <div className="flex items-center gap-1 shrink-0">
                  {['#ef4444', '#12a3ff', '#10b981', '#f59e0b', '#0f172a'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPenColor(c)}
                      className={`w-3.5 sm:w-4 h-3.5 sm:h-4 rounded-full border transition-transform shrink-0 ${
                        penColor === c
                          ? 'scale-125 border-slate-900 ring-2 ring-slate-300'
                          : 'border-slate-300 opacity-80 hover:opacity-100'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </>
            )}

            {role === 'teacher' && (
              <>
                <div className="h-3.5 w-px bg-slate-200 mx-0.5 shrink-0" />

                <button
                  type="button"
                  data-testid="content-clear-strokes-btn"
                  onClick={onClearStrokes}
                  className="flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors whitespace-nowrap shrink-0"
                  title="Clear All Page Annotations"
                >
                  <Trash2 className="w-3 sm:w-3.5 h-3 sm:h-3.5 shrink-0" />
                  <span>Clear</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Follower "Follow Teacher" Floating Button at Bottom (shown ONLY when view-only follower and presenter are not in sync) */}
      {!canAnnotate && !followTeacher && isOutOfSync && (
        <div
          data-prevent-nav-toggle="true"
          className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 select-none animate-in fade-in slide-in-from-bottom-3 duration-200"
        >
          <button
            type="button"
            data-testid="follow-teacher-btn"
            onClick={() => {
              isProgrammaticScrollRef.current = true;
              setIsOutOfSync(false);
              onToggleFollow(true);
            }}
            className="pointer-events-auto flex items-center gap-2 px-5 py-2.5 rounded-full text-xs sm:text-sm font-semibold bg-[#12a3ff] hover:bg-[#0d8de0] active:scale-95 text-white shadow-xl ring-2 ring-white/90 transition-all cursor-pointer"
          >
            <Compass className="w-4 h-4 shrink-0" />
            <span>Follow Teacher</span>
          </button>
        </div>
      )}

      {/* Main Scrollable Viewport matching /learn page layout (Whole-Page Pen, Laser & Eraser Canvas) */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchStart={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={(e) => {
          if (role === 'student' && !canAnnotate && e.pointerType !== 'mouse') {
            handleUserScrollIntent();
          }
          handleSheetPointerMove(e);
          if (canAnnotate && (activeTool === 'pen' || activeTool === 'eraser')) {
            handleBlockPointerDown(e, 'blk_page_canvas');
          }
        }}
        onPointerMove={(e) => {
          handleSheetPointerMove(e);
          if (canAnnotate && (activeTool === 'pen' || activeTool === 'eraser')) {
            handleBlockPointerMove(e, activeDrawingBlockIdRef.current || 'blk_page_canvas');
          }
        }}
        onPointerUp={(e) => {
          handleSheetPointerUp();
          if (canAnnotate && (activeTool === 'pen' || activeTool === 'eraser')) {
            handleBlockPointerUp(e, activeDrawingBlockIdRef.current || 'blk_page_canvas');
          }
        }}
        onPointerLeave={handleSheetPointerLeave}
        data-testid="content-scroll-container"
        className={`flex-1 w-full min-w-0 overflow-y-auto overflow-x-hidden scroll-smooth px-2.5 py-3 sm:px-5 sm:py-5 md:px-6 lg:px-8 ${
          canAnnotate && isToolboxVisible ? 'sm:pt-14 pb-16 sm:pb-8' : 'pb-10'
        } flex justify-center items-start ${
          canAnnotate && activeTool !== 'cursor' && activeTool !== 'laser'
            ? 'cursor-crosshair touch-none'
            : canAnnotate && activeTool === 'laser'
            ? 'cursor-none'
            : 'cursor-auto'
        }`}
      >
        {/* Full-Width Responsive Content Sheet matching /learn page container across Mobile, Tablet, Laptop & Desktop */}
        <div
          ref={(el) => {
            pageSheetRef.current = el;
            blockRefs.current['blk_page_canvas'] = el;
          }}
          data-block-id="blk_page_canvas"
          data-testid="virtual-content-sheet"
          className={`relative w-full min-w-0 max-w-4xl lg:max-w-5xl xl:max-w-6xl space-y-3.5 sm:space-y-5 pb-16 min-h-full ${
            canAnnotate && activeTool !== 'cursor' && activeTool !== 'laser'
              ? 'cursor-crosshair touch-none'
              : 'cursor-auto'
          }`}
        >
          {/* Whole-Page SVG Vector Overlay for freehand strokes drawn anywhere on the Content Tab page */}
          {(() => {
            const pageCanvasId = 'blk_page_canvas';
            const pageCanvasStrokes = contentState.penStrokes.filter(
              (s) => s.blockId === pageCanvasId
            );
            const isDrawingOnPageCanvas =
              activeDrawingBlockId === pageCanvasId && currentPoints.length > 0;
            const allPageCanvasStrokes: ContentStroke[] = isDrawingOnPageCanvas
              ? [
                  ...pageCanvasStrokes,
                  {
                    id: 'temp-active-page-stroke',
                    blockId: pageCanvasId,
                    color: penColor,
                    width: 3,
                    tool: 'pen',
                    opacity: 1,
                    anchorTokens: currentAnchorTokens,
                    points: currentPoints,
                  },
                ]
              : pageCanvasStrokes;

            if (allPageCanvasStrokes.length === 0) return null;

            const pageLayoutCache = getFreshBlockLayout(pageCanvasId);
            const pageSvgWidth = Math.max(
              100,
              Number((pageLayoutCache?.blockRect.width || 896).toFixed(2))
            );
            const pageSvgHeight = Math.max(
              200,
              Number((pageLayoutCache?.blockRect.height || 680).toFixed(2))
            );

            return (
              <svg
                data-testid="whole-page-content-svg-overlay"
                viewBox={`0 0 ${pageSvgWidth} ${pageSvgHeight}`}
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 w-full h-full overflow-visible z-20"
              >
                {allPageCanvasStrokes.map((stroke) => {
                  const dPath = buildResponsiveSvgPath(
                    stroke.points || [],
                    pageLayoutCache,
                    stroke.tool === 'pen'
                  );
                  if (!dPath) return null;
                  return (
                    <path
                      key={stroke.id}
                      data-stroke-id={stroke.id}
                      d={dPath}
                      fill="none"
                      stroke={stroke.color}
                      strokeOpacity={stroke.opacity ?? 0.92}
                      strokeWidth={stroke.width || 3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
              </svg>
            );
          })()}
          {/* Topic / Lesson Title Header matching /learn page */}
          {(() => {
            const headerBlockId = 'blk_header';
            const headerStrokes = contentState.penStrokes.filter(
              (s) => s.blockId === headerBlockId
            );
            const isDrawingInHeader =
              activeDrawingBlockId === headerBlockId && currentPoints.length > 0;
            const allHeaderStrokes: ContentStroke[] = isDrawingInHeader
              ? [
                  ...headerStrokes,
                  {
                    id: 'temp-active-stroke',
                    blockId: headerBlockId,
                    color: penColor,
                    width: 3,
                    tool: 'pen',
                    opacity: 1,
                    anchorTokens: currentAnchorTokens,
                    points: currentPoints,
                  },
                ]
              : headerStrokes;

            const headerTokenAnnotationMap = new Map<string, TokenAnnotationInfo>();
            for (const s of allHeaderStrokes) {
              const touchedTokens = new Set<string>();
              if (Array.isArray(s.anchorTokens)) {
                for (const tid of s.anchorTokens) if (tid) touchedTokens.add(tid);
              }
              if (Array.isArray(s.points)) {
                for (const pt of s.points) if (pt?.tokenId) touchedTokens.add(pt.tokenId);
              }
              touchedTokens.forEach((tid) => {
                const existing = headerTokenAnnotationMap.get(tid) || { strokeIds: [] };
                existing.markedColor = s.color || '#ef4444';
                if (s.id && s.id !== 'temp-active-stroke' && !existing.strokeIds.includes(s.id)) {
                  existing.strokeIds.push(s.id);
                }
                headerTokenAnnotationMap.set(tid, existing);
              });
            }

            const headerLayoutCache =
              allHeaderStrokes.length > 0 ? getFreshBlockLayout(headerBlockId) : blockLayouts[headerBlockId];
            const headerSvgWidth = Math.max(100, Number((headerLayoutCache?.blockRect.width || 760).toFixed(2)));
            const headerSvgHeight = Math.max(40, Number((headerLayoutCache?.blockRect.height || 80).toFixed(2)));

            const topicTitleSegments = tokenizedHeaderSegments;
            const isLaserOnHeader =
              laserPointer.active && laserPointer.blockId === headerBlockId;

            return (
              <div
                data-block-id={headerBlockId}
                ref={(el) => {
                  blockRefs.current[headerBlockId] = el;
                }}
                onPointerDown={(e) => handleBlockPointerDown(e, headerBlockId)}
                onPointerMove={(e) => handleBlockPointerMove(e, headerBlockId)}
                onPointerUp={(e) => handleBlockPointerUp(e, headerBlockId)}
                className={`relative space-y-2 ${
                  isSelectionEnabled ? 'select-text' : 'select-none'
                } ${
                  canAnnotate && activeTool !== 'cursor' && activeTool !== 'laser'
                    ? 'cursor-crosshair touch-none'
                    : 'cursor-default'
                }`}
              >
                <div className="min-w-0 flex-1 relative z-1 space-y-1.5 sm:space-y-2 px-0.5">
                  <h1
                    data-region-id="content"
                    className="text-lg sm:text-xl md:text-2xl lg:text-[26px] font-extrabold text-slate-900 tracking-tight leading-snug break-words"
                  >
                    {renderTokenizedText(
                      topicTitleSegments,
                      headerTokenAnnotationMap,
                      isLaserOnHeader ? laserPointer.tokenId : undefined
                    )}
                  </h1>
                  <div className="h-[2.5px] w-12 bg-[#22c55e] rounded-full" />
                </div>

                {/* SVG Vector Drawing Overlay for Header */}
                <svg
                  viewBox={`0 0 ${headerSvgWidth} ${headerSvgHeight}`}
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 w-full h-full overflow-visible z-10"
                >
                  {allHeaderStrokes.map((stroke) => {
                    const dPath = buildResponsiveSvgPath(stroke.points || [], headerLayoutCache, stroke.tool === 'pen');
                    if (!dPath) return null;
                    return (
                      <path
                        key={stroke.id}
                        data-stroke-id={stroke.id}
                        d={dPath}
                        fill="none"
                        stroke={stroke.color}
                        strokeOpacity={stroke.opacity ?? 0.92}
                        strokeWidth={stroke.width || 3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                </svg>
              </div>
            );
          })()}

          {/* Main Content Card matching /learn page (.content-main-container) */}
          <div className="w-full min-w-0 bg-white rounded-xl sm:rounded-2xl p-3 sm:p-5 md:p-6 lg:p-7 space-y-3.5 sm:space-y-4 shadow-xs border border-slate-200/90 overflow-hidden">
            <div className="flex items-start sm:items-center gap-2 text-[#2563eb] font-extrabold text-sm sm:text-base break-words">
              <BookOpen className="w-4 h-4 sm:w-5 sm:h-5 shrink-0 mt-0.5 sm:mt-0" />
              <span className="min-w-0 break-words">{topicTitle || lessonTitle}</span>
            </div>

            {blocks.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-8 text-center text-sm text-slate-500">
                No content available for this topic.
              </div>
            ) : (
              <div
                data-active-content-tool={canAnnotate ? activeTool : 'cursor'}
                data-selection-enabled={isSelectionEnabled ? 'true' : 'false'}
                className={`content-main-container text-slate-800 space-y-3 ${
                  isSelectionEnabled ? 'select-text' : 'select-none'
                }`}
              >
                {blocks.map((block) => {
                  const blockStrokes = contentState.penStrokes.filter(
                    (s) => s.blockId === block.blockId
                  );
                  const isDrawingHere =
                    activeDrawingBlockId === block.blockId && currentPoints.length > 0;

                  const allBlockStrokes: ContentStroke[] = isDrawingHere
                    ? [
                        ...blockStrokes,
                        {
                          id: 'temp-active-stroke',
                          blockId: block.blockId,
                          color: penColor,
                          width: 3,
                          tool: 'pen',
                          opacity: 1,
                          anchorTokens: currentAnchorTokens,
                          points: currentPoints,
                        },
                      ]
                    : blockStrokes;

                  // Build per-word token annotation map for deterministic word-level highlight/mark sync
                  const tokenAnnotationMap = new Map<string, TokenAnnotationInfo>();
                  for (const s of allBlockStrokes) {
                    const isHighlighter = s.tool === 'highlighter';
                    const touchedTokens = new Set<string>();

                    if (Array.isArray(s.anchorTokens)) {
                      for (const tid of s.anchorTokens) {
                        if (tid) touchedTokens.add(tid);
                      }
                    }
                    if (Array.isArray(s.points)) {
                      for (const pt of s.points) {
                        if (pt?.tokenId) touchedTokens.add(pt.tokenId);
                      }
                    }

                    touchedTokens.forEach((tid) => {
                      const existing = tokenAnnotationMap.get(tid) || { strokeIds: [] };
                      if (isHighlighter) {
                        existing.highlightedColor = s.color || '#facc15';
                      } else {
                        existing.markedColor = s.color || '#ef4444';
                      }
                      if (s.id && s.id !== 'temp-active-stroke' && !existing.strokeIds.includes(s.id)) {
                        existing.strokeIds.push(s.id);
                      }
                      tokenAnnotationMap.set(tid, existing);
                    });
                  }

                  const layoutCache =
                    allBlockStrokes.length > 0
                      ? getFreshBlockLayout(block.blockId)
                      : blockLayouts[block.blockId];
                  const svgWidth = Math.max(100, Number((layoutCache?.blockRect.width || 760).toFixed(2)));
                  const svgHeight = Math.max(40, Number((layoutCache?.blockRect.height || 120).toFixed(2)));

                  const memoizedBlock = memoizedBlockContentMap.get(block.blockId);
                  const titleSegments = memoizedBlock?.titleSegments || [];
                  const contentSegments = memoizedBlock?.contentSegments || [];
                  const formulaSegments = memoizedBlock?.formulaSegments || [];

                  const isLaserOnBlock =
                    laserPointer.active && laserPointer.blockId === block.blockId;
                  const isTeacherAnchor =
                    contentState.scrollAnchor.blockId === block.blockId;

                  return (
                    <div
                      key={block.blockId}
                      data-block-id={block.blockId}
                      data-testid={`content-block-${block.blockId}`}
                      ref={(el) => {
                        blockRefs.current[block.blockId] = el;
                      }}
                      onPointerDown={(e) => handleBlockPointerDown(e, block.blockId)}
                      onPointerMove={(e) => handleBlockPointerMove(e, block.blockId)}
                      onPointerUp={(e) => handleBlockPointerUp(e, block.blockId)}
                      className={`section-block relative transition-all rounded-lg ${
                        isTeacherAnchor ? 'ring-1 ring-[#12a3ff]/20' : ''
                      } ${isSelectionEnabled ? 'select-text' : 'select-none'} ${
                        canAnnotate && activeTool !== 'cursor'
                          ? 'cursor-crosshair touch-none'
                          : 'cursor-auto'
                      }`}
                    >
                      {block.contentHtml && memoizedBlock?.htmlObj ? (
                        <div
                          data-region-id="content"
                          className="content-html-fragment"
                          dangerouslySetInnerHTML={memoizedBlock.htmlObj}
                        />
                      ) : (
                        <section data-region-id="content">
                          {block.title && (
                            <h3 data-region-id="header">
                              {renderTokenizedText(
                                titleSegments,
                                tokenAnnotationMap,
                                isLaserOnBlock ? laserPointer.tokenId : undefined
                              )}
                            </h3>
                          )}

                          {block.content && (
                            <p className="whitespace-pre-line break-words">
                              {renderTokenizedText(
                                contentSegments,
                                tokenAnnotationMap,
                                isLaserOnBlock ? laserPointer.tokenId : undefined
                              )}
                            </p>
                          )}

                          {block.formulaLatex && (
                            <div
                              data-region-id="formula"
                              className="formula-box font-mono text-sm sm:text-base overflow-x-auto"
                            >
                              {renderTokenizedText(
                                formulaSegments,
                                tokenAnnotationMap,
                                isLaserOnBlock ? laserPointer.tokenId : undefined
                              )}
                            </div>
                          )}

                          {block.svgDiagram && memoizedBlock?.svgObj && (
                            <div
                              data-region-id="diagram"
                              className="diagram-box flex justify-center items-center overflow-hidden [&>svg]:w-full [&>svg]:h-auto [&>svg]:max-h-[260px] [&>svg]:block"
                              dangerouslySetInnerHTML={memoizedBlock.svgObj}
                            />
                          )}
                        </section>
                      )}

                      {/* Word-Anchored & Region-Anchored SVG Vector Overlay */}
                      <svg
                        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                        preserveAspectRatio="none"
                        className="pointer-events-none absolute inset-0 w-full h-full overflow-visible z-10"
                      >
                        {allBlockStrokes.map((stroke) => {
                          const isHighlighter = stroke.tool === 'highlighter';
                          const dPath = buildResponsiveSvgPath(stroke.points || [], layoutCache, stroke.tool === 'pen');
                          if (!dPath) return null;

                          return (
                            <path
                              key={stroke.id}
                              data-stroke-id={stroke.id}
                              d={dPath}
                              fill="none"
                              stroke={stroke.color}
                              strokeOpacity={
                                stroke.opacity ?? (isHighlighter ? 0.32 : 0.92)
                              }
                              strokeWidth={
                                isHighlighter ? 16 : stroke.width || 3
                              }
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{
                                mixBlendMode: isHighlighter ? 'multiply' : 'normal',
                              }}
                            />
                          );
                        })}
                      </svg>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Excalidraw-Style Decaying Laser Trail Across the Entire Content Stage */}
          {laserTrail.length > 1 && (
            <svg
              data-testid="content-laser-trail"
              className="pointer-events-none absolute inset-0 z-30 w-full h-full overflow-visible"
              width="100%"
              height="100%"
            >
              <defs>
                <filter id="content-laser-glow" x="-50%" y="-50%" width="200%" height="200%">
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

                return (
                  <g key={`trail-${pt.t}-${idx}`}>
                    <line
                      x1={prev.x}
                      y1={prev.y}
                      x2={pt.x}
                      y2={pt.y}
                      stroke="rgba(239, 68, 68, 0.45)"
                      strokeWidth={Math.max(4, 9 * life)}
                      strokeLinecap="round"
                    />
                    <line
                      x1={prev.x}
                      y1={prev.y}
                      x2={pt.x}
                      y2={pt.y}
                      stroke="#ef4444"
                      strokeOpacity={Math.min(1, life * 1.2)}
                      strokeWidth={Math.max(2, 4.5 * life)}
                      strokeLinecap="round"
                      filter="url(#content-laser-glow)"
                    />
                  </g>
                );
              })}
            </svg>
          )}

          {/* Live Remote Collaborator Cursor (Select / Pen tool): Exact cursor tracking across all content blocks for Host, Co-Host & Students */}
          {isRemoteLaser && remoteLaserCoord?.active && laserPointer.tool !== 'laser' && (
            <div
              data-testid="teacher-content-cursor"
              className="pointer-events-none absolute z-40 transition-transform duration-75"
              style={{
                left: `${remoteLaserCoord.x}px`,
                top: `${remoteLaserCoord.y}px`,
                transform: 'translate3d(0, 0, 0)',
              }}
            >
              <svg
                className="w-4 h-4 -rotate-45 drop-shadow-md text-[#12a3ff]"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="white"
                strokeWidth="1.5"
              >
                <path d="M3 3l7 18 3-7 7-3L3 3z" />
              </svg>
              <div className="ml-3.5 -mt-2 px-1.5 py-0.5 rounded-md bg-[#12a3ff] text-white text-[10px] font-semibold shadow-md whitespace-nowrap">
                {laserPointer.authorName || 'Teacher'}
              </div>
            </div>
          )}

          {/* Glowing Solid Laser Dot: Pointing EXACTLY at Cursor Position (Zero Offset, Solid Color, No Pulse) */}
          {((canAnnotate && activeTool === 'laser' && teacherLaserCoord?.active)
            ? teacherLaserCoord
            : (isRemoteLaser && remoteLaserCoord?.active && laserPointer.tool === 'laser')
            ? remoteLaserCoord
            : null) && (
            <div
              data-testid="content-laser-dot"
              className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(((canAnnotate && activeTool === 'laser' && teacherLaserCoord?.active) ? teacherLaserCoord : remoteLaserCoord)!).x}px`,
                top: `${(((canAnnotate && activeTool === 'laser' && teacherLaserCoord?.active) ? teacherLaserCoord : remoteLaserCoord)!).y}px`,
              }}
            >
              <div className="w-4 h-4 rounded-full bg-[#ef4444] shadow-[0_0_14px_4px_rgba(239,68,68,0.75)] ring-2 ring-white" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
