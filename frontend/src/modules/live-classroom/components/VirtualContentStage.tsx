'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  Send,
  MousePointer,
  Compass,
  BookOpen,
} from 'lucide-react';
import {
  AnchoredStrokePoint,
  BlockDomLayoutCache,
  buildResponsiveSvgPath,
  captureStrokePoint,
  extractAnchorTokensFromPoints,
  hitTestWordToken,
  measureBlockDomLayout,
  projectPointToDevicePixels,
  sanitizeSvgMarkup,
  TextTokenSegment,
  tokenizeText,
} from '../utils/contentSyncMath';

export interface LessonBlock {
  blockId: string;
  type: 'heading' | 'concept' | 'formula' | 'problem' | 'diagram';
  title?: string;
  content: string;
  formulaLatex?: string;
  svgDiagram?: string;
}

interface VirtualContentStageProps {
  role: 'teacher' | 'student';
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
  onSendBlockToWhiteboard: (block: LessonBlock) => void;
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

  // When active tool changes away from laser, clear teacher laser coordinates and trail
  useEffect(() => {
    if (activeTool !== 'laser') {
      setTeacherLaserCoord(null);
      setLaserTrail([]);
      if (role === 'teacher') {
        onLaserMove({ blockId: '', x: 0, y: 0, active: false });
      }
    }
  }, [activeTool, role, onLaserMove]);

  // Student Remote Laser / Cursor Sync: calculates accurate sheet-relative coordinates and generates Excalidraw decaying trail
  useEffect(() => {
    if (role !== 'student' || !laserPointer.active) {
      if (!laserPointer.active) {
        setRemoteLaserCoord(null);
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
      const cache = blockLayouts[laserPointer.blockId!];
      if (cache && laserPointer.tokenId && typeof laserPointer.rx === 'number') {
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
    // Only generate decaying laser trail for student if teacher was actively dragging in laser mode
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
  }, [role, laserPointer, blockLayouts]);

  // Student Viewport Auto-Scroll Sync to Teacher's Cursor Position & Active Block:
  // In Mobile Landscape mode, screen height is very short (~300px) so only ONE section/box fits at a time.
  // When Teacher points to or focuses on a section with their cursor/laser, this ensures the student's
  // mobile landscape viewport smoothly scrolls to frame THAT specific box or content only.
  // In Portrait mode or Desktop, it smoothly scrolls when the focused box is not already fully visible.
  useEffect(() => {
    if (role !== 'student' || !followTeacher || !laserPointer.active) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const targetBlockId = laserPointer.blockId;
    if (!targetBlockId) return;

    const viewportHeight = container.clientHeight;
    const isLandscape =
      typeof window !== 'undefined' &&
      (window.innerWidth > window.innerHeight || viewportHeight <= 480);

    // If teacher's cursor is in blk_header, scroll to exact top 0 so heading is 100% visible
    if (targetBlockId === 'blk_header') {
      if (lastTargetBlockIdRef.current !== 'blk_header') {
        lastTargetBlockIdRef.current = 'blk_header';
        isProgrammaticScrollRef.current = true;
        if (programmaticScrollTimeoutRef.current) window.clearTimeout(programmaticScrollTimeoutRef.current);
        programmaticScrollTimeoutRef.current = window.setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 1200);

        container.scrollTo({
          top: 0,
          behavior: 'smooth',
        });
        setIsOutOfSync(false);
      }
      return;
    }

    const targetBlock = blockRefs.current[targetBlockId];
    if (!targetBlock) return;

    const containerRect = container.getBoundingClientRect();
    const blockRect = targetBlock.getBoundingClientRect();
    const relativeBlockTop = blockRect.top - containerRect.top + container.scrollTop;
    const blockHeight = Math.max(1, targetBlock.offsetHeight);

    const now = Date.now();
    const hasBlockChanged = lastTargetBlockIdRef.current !== targetBlockId;
    const blockTopInViewport = relativeBlockTop - container.scrollTop;
    const blockBottomInViewport = relativeBlockTop + blockHeight - container.scrollTop;

    if (isLandscape) {
      // In Mobile Landscape: only ONE section fits at a time.
      // Smoothly scroll and frame THAT box or content only.
      if (hasBlockChanged || now - lastCursorScrollTimeRef.current > 350) {
        let targetScrollTop = relativeBlockTop - 10;
        if (blockHeight > viewportHeight) {
          // If block is taller than short landscape viewport, keep cursor comfortably centered in view
          const relCursorYInBlock = ((laserPointer.y || 0) / 100) * blockHeight;
          const desiredScroll = relativeBlockTop + relCursorYInBlock - viewportHeight / 2;
          const minScroll = relativeBlockTop - 10;
          const maxScroll = relativeBlockTop + blockHeight - viewportHeight + 10;
          targetScrollTop = Math.max(minScroll, Math.min(maxScroll, desiredScroll));
        }

        const scrollDiff = Math.abs(container.scrollTop - targetScrollTop);
        if (hasBlockChanged || scrollDiff > 24) {
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
        }
      }
    } else {
      // In Portrait mode or Desktop:
      // If block is already comfortably visible, keep view steady without unnecessary jumping.
      const isBlockComfortablyVisible =
        blockTopInViewport >= 10 && blockBottomInViewport <= viewportHeight - 10;

      if (!isBlockComfortablyVisible && (hasBlockChanged || now - lastCursorScrollTimeRef.current > 500)) {
        lastTargetBlockIdRef.current = targetBlockId;
        lastCursorScrollTimeRef.current = now;

        const targetScrollTop = relativeBlockTop - 16;
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
      } else if (hasBlockChanged) {
        lastTargetBlockIdRef.current = targetBlockId;
      }
    }
  }, [
    role,
    followTeacher,
    laserPointer.active,
    laserPointer.blockId,
    laserPointer.y,
  ]);

  // Student scroll sync to Teacher's (blockId, offsetRatio)
  useEffect(() => {
    if (role !== 'student' || !followTeacher) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const anchorBlockId = contentState.scrollAnchor?.blockId;
    const offsetRatio = contentState.scrollAnchor?.offsetRatio || 0;

    // If teacher is at top showing heading (blk_header) with near-zero offset (or no anchor),
    // scroll to exact top 0 so in mobile phone content heading is 100% visible and not scrolled below heading
    if ((anchorBlockId === 'blk_header' || !anchorBlockId) && offsetRatio <= 0.05) {
      if (programmaticScrollTimeoutRef.current) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
      isProgrammaticScrollRef.current = true;
      programmaticScrollTimeoutRef.current = window.setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 1200);

      container.scrollTo({
        top: 0,
        behavior: 'smooth',
      });

      setIsOutOfSync(false);
      return;
    }

    const targetBlock =
      (anchorBlockId && blockRefs.current[anchorBlockId]) ||
      (anchorBlockId === 'blk_header' ? blockRefs.current['blk_header'] : null);
    if (!targetBlock) return;

    if (programmaticScrollTimeoutRef.current) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    isProgrammaticScrollRef.current = true;
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 1200);

    const containerRect = container.getBoundingClientRect();
    const blockRect = targetBlock.getBoundingClientRect();
    const relativeTop = blockRect.top - containerRect.top + container.scrollTop;
    const blockHeight = Math.max(1, targetBlock.offsetHeight);
    const targetScrollTop =
      relativeTop + blockHeight * offsetRatio - 20;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth',
    });

    setIsOutOfSync(false);
  }, [
    role,
    followTeacher,
    contentState.scrollAnchor?.blockId,
    contentState.scrollAnchor?.offsetRatio,
  ]);

  // Teacher: emit initial scroll anchor on mount so students sync immediately to heading
  useEffect(() => {
    if (role === 'teacher' && !hasEmittedInitialScrollRef.current) {
      hasEmittedInitialScrollRef.current = true;
      const timer = window.setTimeout(() => {
        const container = scrollContainerRef.current;
        if (container && container.scrollTop <= 20) {
          onScrollSync('blk_header', 0);
        }
      }, 500);
      return () => window.clearTimeout(timer);
    }
  }, [role, onScrollSync]);

  // User manual scroll intent helper: tracks active user gestures (wheel, touch, pointer) on all devices
  const handleUserScrollIntent = useCallback(() => {
    if (role !== 'student') return;
    isUserScrollingRef.current = true;
    if (userScrollTimeoutRef.current) {
      window.clearTimeout(userScrollTimeoutRef.current);
    }
    userScrollTimeoutRef.current = window.setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 400);
  }, [role]);

  // Scroll listener:
  // - For Teacher: computes top visible blockId + offsetRatio and broadcasts to students
  // - For Student: checks if student is in sync with teacher's anchor; only shows Follow Teacher if out of sync
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (role === 'student') {
      const anchorBlockId = contentState.scrollAnchor?.blockId;
      const offsetRatio = contentState.scrollAnchor?.offsetRatio || 0;
      let teacherTargetScrollTop = 0;
      if ((anchorBlockId === 'blk_header' || !anchorBlockId) && offsetRatio <= 0.05) {
        teacherTargetScrollTop = 0;
      } else {
        const targetBlock =
          (anchorBlockId && blockRefs.current[anchorBlockId]) ||
          (anchorBlockId === 'blk_header' ? blockRefs.current['blk_header'] : null);
        if (targetBlock) {
          const containerRect = container.getBoundingClientRect();
          const blockRect = targetBlock.getBoundingClientRect();
          const relativeTop = blockRect.top - containerRect.top + container.scrollTop;
          const blockHeight = Math.max(1, targetBlock.offsetHeight);
          teacherTargetScrollTop =
            relativeTop + blockHeight * offsetRatio - 20;
        }
      }
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

      // If student was out-of-sync but scrolled back within 40px of teacher, re-lock and hide button
      if (!followTeacher && scrollDiff <= 40) {
        setIsOutOfSync(false);
        onToggleFollow(true);
      }
      return;
    }

    const now = Date.now();
    if (now - lastScrollEmitRef.current < 60) return;
    lastScrollEmitRef.current = now;

    // If teacher is at top (scrollTop <= 15), anchor to heading directly
    if (container.scrollTop <= 15) {
      lastMatchedBlockIdRef.current = 'blk_header';
      lastOffsetRatioRef.current = 0;
      onScrollSync('blk_header', 0);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    let matchedBlockId = lastMatchedBlockIdRef.current || 'blk_header';
    let offsetRatio = lastOffsetRatioRef.current || 0;
    let found = false;

    const allElements: { blockId: string; el: HTMLElement | null }[] = [
      { blockId: 'blk_header', el: blockRefs.current['blk_header'] },
      ...blocks.map((block) => ({ blockId: block.blockId, el: blockRefs.current[block.blockId] })),
    ];

    for (const item of allElements) {
      const el = item.el;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const relativeTop = rect.top - containerTop;
      const height = Math.max(1, rect.height);

      if (relativeTop + height > 28) {
        matchedBlockId = item.blockId;
        const offsetPx = Math.max(0, 28 - relativeTop);
        offsetRatio = Math.min(1, Math.max(0, offsetPx / height));
        found = true;
        break;
      }
    }

    // If teacher is scrolled down past all measured tops (e.g. at the bottom of the page),
    // default to the last content block rather than reverting to blk_header
    if (!found && container.scrollTop > 30) {
      if (blocks.length > 0) {
        matchedBlockId = blocks[blocks.length - 1].blockId;
        offsetRatio = 1;
      }
    }

    lastMatchedBlockIdRef.current = matchedBlockId;
    lastOffsetRatioRef.current = offsetRatio;
    onScrollSync(matchedBlockId, Number(offsetRatio.toFixed(3)));
  }, [role, followTeacher, onToggleFollow, blocks, onScrollSync, contentState.scrollAnchor]);

  // Erase strokes near a pointer coordinate or matching a touched word token
  const eraseStrokeAtPointer = useCallback(
    (
      blockId: string,
      clientX: number,
      clientY: number,
      cache: BlockDomLayoutCache,
      liveRect?: DOMRect
    ) => {
      const blockStrokes = contentState.penStrokes.filter((s) => s.blockId === blockId);
      if (blockStrokes.length === 0) return;

      const rect = liveRect || cache.blockRect;
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const pt = captureStrokePoint(clientX, clientY, cache, rect);

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
          const proj = projectPointToDevicePixels(sp, cache, stroke.tool === 'pen');
          const distPx = Math.hypot(proj.px - localX, proj.py - localY);
          if (distPx <= 22) {
            onDeleteStroke(stroke.id);
            break;
          }
        }
      }
    },
    [contentState.penStrokes, onDeleteStroke]
  );

  // Pointer handlers on each block for Pen and Eraser
  const handleBlockPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    blockId: string
  ) => {
    if (role !== 'teacher' || activeTool === 'cursor' || activeTool === 'laser') return;
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
    if (role !== 'teacher' || activeTool === 'cursor' || activeTool === 'laser') return;
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

      // Broadcast active block and pen pointer to sync mobile landscape view to this block
      const now = Date.now();
      if (now - lastLaserEmitRef.current >= 30) {
        lastLaserEmitRef.current = now;
        const blockRelX = Math.max(0, Math.min(100, ((e.clientX - liveRect.left) / Math.max(1, liveRect.width)) * 100));
        const blockRelY = Math.max(0, Math.min(100, ((e.clientY - liveRect.top) / Math.max(1, liveRect.height)) * 100));
        onLaserMove({
          blockId,
          x: Math.round(blockRelX * 10) / 10,
          y: Math.round(blockRelY * 10) / 10,
          active: true,
          tool: 'pen',
          isDragging: true,
        });
      }
    }
  };

  const handleBlockPointerUp = (
    e: React.PointerEvent<HTMLDivElement>,
    blockId: string
  ) => {
    if (role !== 'teacher') return;
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
    if (role !== 'teacher') return;
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
    } else if (activeTool === 'cursor') {
      setTeacherLaserCoord({ x: sheetX, y: sheetY, active: true, tool: 'cursor' });
    } else if (activeTool === 'pen') {
      setTeacherLaserCoord({ x: sheetX, y: sheetY, active: true, tool: 'pen' });
    }

    if (now - lastLaserEmitRef.current >= 30) {
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

      if (targetBlockEl && targetBlockId) {
        const bRect = targetBlockEl.getBoundingClientRect();
        blockRelX = Math.max(0, Math.min(100, ((e.clientX - bRect.left) / Math.max(1, bRect.width)) * 100));
        blockRelY = Math.max(0, Math.min(100, ((e.clientY - bRect.top) / Math.max(1, bRect.height)) * 100));
        const cache = blockLayouts[targetBlockId] || measureBlockDomLayout(targetBlockId, targetBlockEl);
        const hit = hitTestWordToken(e.clientX - bRect.left, e.clientY - bRect.top, cache, 6);
        if (hit) {
          tokenId = hit.token.tokenId;
          rx = hit.rx;
          ry = hit.ry;
        }
      }

      const sheetXPct = Math.round(((sheetX / Math.max(1, sheetRect.width)) * 100) * 10) / 10;
      const sheetYPct = Math.round(((sheetY / Math.max(1, sheetRect.height)) * 100) * 10) / 10;
      const sheetYPx = Math.round(sheetY);

      onLaserMove({
        blockId: targetBlockId,
        x: targetBlockEl ? Math.round(blockRelX * 10) / 10 : 0,
        y: targetBlockEl ? Math.round(blockRelY * 10) / 10 : 0,
        active: true,
        isDragging: isDragging && activeTool === 'laser',
        tool: activeTool,
        tokenId,
        rx,
        ry,
        sheetXPct,
        sheetYPct,
        sheetYPx,
      } as any);
    }
  };

  const handleSheetPointerUp = useCallback(() => {
    if (role === 'teacher') {
      const sheetEl = pageSheetRef.current;
      if (!sheetEl) return;
      const sheetRect = sheetEl.getBoundingClientRect();
      const currentCoord = teacherLaserCoord;
      if (currentCoord && currentCoord.active) {
        const sheetXPct = Math.round(((currentCoord.x / Math.max(1, sheetRect.width)) * 100) * 10) / 10;
        const sheetYPct = Math.round(((currentCoord.y / Math.max(1, sheetRect.height)) * 100) * 10) / 10;
        onLaserMove({
          blockId: undefined,
          x: 0,
          y: 0,
          active: true,
          isDragging: false,
          tool: activeTool,
          sheetXPct,
          sheetYPct,
          sheetYPx: Math.round(currentCoord.y),
        } as any);
      }
    }
  }, [role, activeTool, teacherLaserCoord, onLaserMove]);

  // Listen for global pointerup so drag release anywhere on window clears isDragging
  useEffect(() => {
    if (role !== 'teacher') return;
    window.addEventListener('pointerup', handleSheetPointerUp);
    return () => window.removeEventListener('pointerup', handleSheetPointerUp);
  }, [role, handleSheetPointerUp]);

  const handleSheetPointerLeave = () => {
    if (role === 'teacher') {
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
      if (isHighlighted && info?.highlightedColor) {
        style.backgroundColor = hexToRgba(info.highlightedColor, 0.42);
        style.boxShadow = `0 0 0 2px ${hexToRgba(info.highlightedColor, 0.35)}`;
        style.borderRadius = '3px';
      } else if (isMarked && info?.markedColor) {
        style.backgroundColor = hexToRgba(info.markedColor, 0.14);
        style.borderBottom = `2px solid ${info.markedColor}`;
        style.borderRadius = '2px';
      }

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

  return (
    <div
      ref={outerContainerRef}
      data-active-content-tool={role === 'teacher' ? activeTool : 'cursor'}
      className="relative flex-1 h-full flex flex-col bg-slate-50 overflow-hidden select-none"
    >
      {/* Floating Teacher Annotation Pill — Mobile Bottom Thumb-Zone & Desktop Top Bar (Toggled via Top Bar Icon or Ctrl+T) */}
      {role === 'teacher' && isToolboxVisible && (
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
                onLaserMove({ blockId: '', x: 0, y: 0, active: false });
              }}
              className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                activeTool === 'cursor'
                  ? 'bg-[#12a3ff] text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Pointer / Scroll"
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
          </div>
        </div>
      )}

      {/* Student Follow Teacher Floating Button at Bottom (shown ONLY when student and teacher are not in sync) */}
      {role === 'student' && !followTeacher && isOutOfSync && (
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

      {/* Main Scrollable Viewport: Full-bleed on mobile (px-0 py-0), centered card on desktop */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchStart={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={(e) => {
          if (role === 'student' && e.pointerType !== 'mouse') {
            handleUserScrollIntent();
          }
        }}
        data-testid="content-scroll-container"
        className="flex-1 overflow-y-auto overflow-x-hidden px-0 py-0 sm:py-6 sm:px-4 flex justify-center items-start"
      >
        {/* Full-Width Responsive Content Sheet (100% width on mobile, max 820px on desktop) */}
        <div
          ref={pageSheetRef}
          data-testid="virtual-content-sheet"
          onPointerMove={handleSheetPointerMove}
          onPointerDown={handleSheetPointerMove}
          onPointerUp={handleSheetPointerUp}
          onPointerLeave={handleSheetPointerLeave}
          className="relative w-full max-w-[820px] bg-white sm:border border-slate-200 sm:rounded-2xl shadow-xs px-2.5 pt-3.5 pb-16 sm:p-7 min-h-full sm:min-h-[900px]"
        >
          {/* Clean Lesson Header with Full Freehand Pen, Marking, Eraser & Laser Support */}
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

            const headerLayoutCache = blockLayouts[headerBlockId];
            const headerSvgWidth = Math.max(100, Math.round(headerLayoutCache?.blockRect.width || 760));
            const headerSvgHeight = Math.max(40, Math.round(headerLayoutCache?.blockRect.height || 80));

            const lessonTitleSegments = tokenizeText(lessonTitle, 'title');
            const topicTitleSegments = tokenizeText(topicTitle, 'content');
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
                className={`relative pb-3.5 mb-3.5 sm:pb-5 sm:mb-6 border-b border-slate-200 flex items-start sm:items-center justify-between gap-2 select-none ${
                  role === 'teacher' && activeTool !== 'cursor' && activeTool !== 'laser'
                    ? 'cursor-crosshair touch-none'
                    : 'cursor-default'
                }`}
              >
                <div className="min-w-0 flex-1 relative z-1">
                  <div
                    data-region-id="header"
                    className="flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold uppercase tracking-wider text-[#12a3ff] mb-1"
                  >
                    <BookOpen className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {renderTokenizedText(
                        lessonTitleSegments,
                        headerTokenAnnotationMap,
                        isLaserOnHeader ? laserPointer.tokenId : undefined
                      )}
                    </span>
                  </div>
                  <h1
                    data-region-id="content"
                    className="text-lg sm:text-2xl font-bold text-slate-900 tracking-tight leading-snug break-words"
                  >
                    {renderTokenizedText(
                      topicTitleSegments,
                      headerTokenAnnotationMap,
                      isLaserOnHeader ? laserPointer.tokenId : undefined
                    )}
                  </h1>
                </div>

                <div className="text-right shrink-0 hidden sm:block">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
                    Word-Synced Responsive Stage
                  </span>
                </div>

                {/* SVG Vector Drawing Overlay for Header */}
                <svg
                  viewBox={`0 0 ${headerSvgWidth} ${headerSvgHeight}`}
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

          {/* Structured Lesson Blocks with Block-ID & Word-Token Anchoring */}
          <div className="space-y-3 sm:space-y-5">
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

              const layoutCache = blockLayouts[block.blockId];
              const svgWidth = Math.max(100, Math.round(layoutCache?.blockRect.width || 760));
              const svgHeight = Math.max(60, Math.round(layoutCache?.blockRect.height || 180));

              const titleSegments = tokenizeText(block.title, 'title');
              const contentSegments = tokenizeText(block.content, 'content');
              const formulaSegments = tokenizeText(block.formulaLatex, 'formula');

              const isLaserOnBlock =
                laserPointer.active && laserPointer.blockId === block.blockId;
              const isTeacherAnchor =
                contentState.scrollAnchor.blockId === block.blockId;

              // Compute laser pointer position (word-token anchored if pointing at a word)
              let laserPositionStyle: React.CSSProperties | null = null;
              if (isLaserOnBlock) {
                if (layoutCache && layoutCache.blockRect.width > 0) {
                  const projected = projectPointToDevicePixels(
                    {
                      x: laserPointer.x,
                      y: laserPointer.y,
                      tokenId: laserPointer.tokenId,
                      rx: laserPointer.rx,
                      ry: laserPointer.ry,
                      regionId: laserPointer.regionId,
                      regionRx: laserPointer.regionRx,
                      regionRy: laserPointer.regionRy,
                    },
                    layoutCache
                  );
                  laserPositionStyle = {
                    left: `${projected.px}px`,
                    top: `${projected.py}px`,
                  };
                } else {
                  laserPositionStyle = {
                    left: `${laserPointer.x}%`,
                    top: `${laserPointer.y}%`,
                  };
                }
              }

              return (
                <div
                  key={block.blockId}
                  data-block-id={block.blockId}
                  ref={(el) => {
                    blockRefs.current[block.blockId] = el;
                  }}
                  onPointerDown={(e) => handleBlockPointerDown(e, block.blockId)}
                  onPointerMove={(e) => handleBlockPointerMove(e, block.blockId)}
                  onPointerUp={(e) => handleBlockPointerUp(e, block.blockId)}
                  className={`group relative rounded-xl p-3 sm:p-5 border transition-all ${
                    isTeacherAnchor
                      ? 'bg-white border-[#12a3ff]/40 ring-1 ring-[#12a3ff]/15 shadow-xs'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  } ${
                    role === 'teacher' && activeTool !== 'cursor'
                      ? 'cursor-crosshair touch-none'
                      : 'cursor-default'
                  }`}
                >
                  {/* Block Header & Teacher "Send to Whiteboard" Action */}
                  <div
                    data-region-id="header"
                    className="flex items-start sm:items-center justify-between gap-2 mb-2.5"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                      <span
                        className={`px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider rounded-md border shrink-0 ${getBlockBadgeStyle(
                          block.type
                        )}`}
                      >
                        {block.type}
                      </span>
                      {block.title && (
                        <h3 className="text-[15px] sm:text-base font-bold text-slate-900 leading-snug break-words">
                          {renderTokenizedText(
                            titleSegments,
                            tokenAnnotationMap,
                            isLaserOnBlock ? laserPointer.tokenId : undefined
                          )}
                        </h3>
                      )}
                    </div>

                    {role === 'teacher' && (
                      <button
                        type="button"
                        data-testid={`send-to-wb-${block.blockId}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSendBlockToWhiteboard(block);
                        }}
                        className="opacity-95 group-hover:opacity-100 flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-lg bg-sky-50 hover:bg-[#12a3ff] text-[#12a3ff] hover:text-white border border-sky-200 hover:border-[#12a3ff] text-xs font-semibold transition-all shadow-2xs shrink-0"
                      >
                        <Send className="w-3 h-3 shrink-0" />
                        <span>Send to Whiteboard</span>
                      </button>
                    )}
                  </div>

                  {/* Block Body Text with Deterministic Word Spans */}
                  {block.content && (
                    <p
                      data-region-id="content"
                      className="text-slate-700 text-[15px] sm:text-[15.5px] leading-[1.7] whitespace-pre-line break-words"
                    >
                      {renderTokenizedText(
                        contentSegments,
                        tokenAnnotationMap,
                        isLaserOnBlock ? laserPointer.tokenId : undefined
                      )}
                    </p>
                  )}

                  {/* Formula Box */}
                  {block.formulaLatex && (
                    <div
                      data-region-id="formula"
                      className="mt-3 sm:mt-4 p-3 sm:p-4 rounded-xl bg-slate-50 border border-slate-200 font-mono text-sm sm:text-base text-slate-900 text-center tracking-wide shadow-2xs overflow-x-auto"
                    >
                      {renderTokenizedText(
                        formulaSegments,
                        tokenAnnotationMap,
                        isLaserOnBlock ? laserPointer.tokenId : undefined
                      )}
                    </div>
                  )}

                  {/* SVG Diagram Box (Full-Width Aspect-Preserving on Mobile & Desktop) */}
                  {block.svgDiagram && (
                    <div
                      data-region-id="diagram"
                      className="mt-3 sm:mt-4 p-2 sm:p-4 rounded-xl bg-slate-50 border border-slate-200 flex justify-center items-center overflow-hidden [&>svg]:w-full [&>svg]:h-auto [&>svg]:max-h-[260px] [&>svg]:block"
                      dangerouslySetInnerHTML={{ __html: sanitizeSvgMarkup(block.svgDiagram) }}
                    />
                  )}

                  {/* Word-Anchored & Region-Anchored SVG Vector Overlay */}
                  <svg
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
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

          {/* Live Teacher Cursor (Select / Pen tool): Exact cursor tracking across all content blocks */}
          {role === 'student' && remoteLaserCoord?.active && laserPointer.tool !== 'laser' && (
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
                Teacher
              </div>
            </div>
          )}

          {/* Glowing Solid Laser Dot: Pointing EXACTLY at Cursor Position (Zero Offset, Solid Color, No Pulse) */}
          {((role === 'teacher' && activeTool === 'laser' && teacherLaserCoord?.active)
            ? teacherLaserCoord
            : (role === 'student' && remoteLaserCoord?.active && laserPointer.tool === 'laser')
            ? remoteLaserCoord
            : null) && (
            <div
              data-testid="content-laser-dot"
              className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${((role === 'teacher' ? teacherLaserCoord : remoteLaserCoord)!).x}px`,
                top: `${((role === 'teacher' ? teacherLaserCoord : remoteLaserCoord)!).y}px`,
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
