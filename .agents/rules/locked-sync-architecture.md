---
trigger: always_on
description: Enforces locked Content Tab (Laser, Pen line-locking, Highlighter with colors, 60fps Mobile Scroll Sync) and Whiteboard synchronization invariants so unrelated bug fixes never break them.
---

# Locked Content Tab & Whiteboard Synchronization Rule

1. **DO NOT TOUCH LOCKED SYNC & MARKING ARCHITECTURE**:
   - Both **Content Tab Synchronization & Marking** (`VirtualContentStage.tsx`, `contentSyncMath.ts`, `learning-content.css`, `useBroadcastSocket.ts`) and **Whiteboard Synchronization** (`ExcalidrawStage.tsx`, `LearningSessionLayout.tsx`) are finalized and locked.
   - When fixing other bugs or adding unrelated features, **never** modify or remove:
     - **Laser Pointer** in Content Tab (`teacherLaserCoord`, `resolveLaserTargetPosition`, `content-laser-trail`).
     - **Pen Tool Line-Locking & Cross-Line Spike Guard** (`preferredLineTop` in `hitTestWordToken` and `captureStrokePoint`, `cleanedInputPoints` and `shouldBreakSubpath` in `buildResponsiveSvgPath`).
     - **Dedicated Highlighter Tool (`content-tool-highlighter`) & Color Palette** right after Pen tool (`content-tool-pen`), applying word-by-word highlight + solid bottom underline (`backgroundColor: hexToRgba(color, 0.24)`, `borderBottom: 2.5px solid ${color}`) on `[data-token-id]` spans and skipping freehand SVG `<path>` when word tokens are anchored.
     - **Block-Scoped Word Tokenization** (`tokenizeText`, `tokenizeHtmlContent`, `extractTokenBlockScope`, `stripTokenBlockScope`) and `useMemo` HTML/token memoization (`memoizedBlockContentMap`).
     - **SVG Overlay CSS Protection** (`.content-main-container svg:not([data-annotation-overlay="true"])` and `svg[data-annotation-overlay="true"] { height: 100% !important }`).
     - **60fps Mobile Scroll Sync** (`smoothScrollFollowerTo`, `computeScrollEngineTargetTop`, no `scroll-smooth` class on `scrollContainerRef`) and responsive reading box width (`w-full` on mobile, `md:w-[720px] lg:w-[860px] xl:w-[960px]` on larger screens).
     - **Whiteboard Sync** (Comic Sans default font `fontFamily: 5`, bidirectional scene/camera/laser/cursor sync across Host, Co-Host, and board-permitted Students).

2. **MANDATORY VERIFICATION GATE**:
   - Always run `cd /var/www/html/broadcast/frontend && npx tsc --noEmit && pnpm test && npx next build` and ensure all 52+ tests in `tests/phase2.test.ts` pass before concluding any task.
