# Zerix Academy Live Broadcast Studio — Architectural Rules & Locked Invariants (`AGENTS.md`)

> **CRITICAL DIRECTIVE (LOCKED ARCHITECTURE RULE)**:
> Both **Content Tab Synchronization & Marking** (Laser, Pen, Highlighter, Eraser, Scroll Sync) and **Whiteboard Synchronization** are **100% finalized, tested, and locked in production**.
> When asked to fix unrelated bugs or add new features in the future, **DO NOT modify, refactor, or regress** any of the locked mechanisms below unless the user explicitly asks to change that specific behavior.

---

## 1. Locked Content Tab Architecture & Invariants

### 1.1 Responsive Reading Box & Viewport Contract
- **File**: `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
- **Rule**: The content sheet (`data-testid="virtual-content-sheet"`, `data-block-id="blk_page_canvas"`) MUST remain:
  - **Mobile Phones (`< 768px`)**: `w-full max-w-full min-w-0` (100% full width).
  - **Tablet / Laptop / Desktop (`>= 768px`)**: `md:w-[720px] lg:w-[860px] xl:w-[960px] max-w-4xl lg:max-w-5xl xl:max-w-6xl`.
- **Never** remove `overscroll-y-contain` or re-add Tailwind `scroll-smooth` to `scrollContainerRef` (`data-testid="content-scroll-container"`), because native CSS smooth scrolling conflicts with 60fps programmatic `requestAnimationFrame` scroll interpolation on mobile browsers.

### 1.2 Word-by-Word Tokenization & Block-Scoped Token IDs
- **Files**:
  - `frontend/src/modules/live-classroom/utils/contentSyncMath.ts`
  - `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
- **Invariants**:
  1. Every word across the entire Content Tab is wrapped in a deterministic `<span data-token-id="...">`:
     - Plain text & LaTeX formulas via `tokenizeText(text, prefix)` (`title`, `subheader`, `content`, `formula`).
     - Raw HTML curriculum content (`block.contentHtml`) via `tokenizeHtmlContent(html, 'content')`, covering `<h1>`–`<h6>`, `<p>`, `<li>`, `<td>`, `<th>`, `<dt>`, `<dd>`, `<summary>`, `<aside>`, `<figcaption>`, `<blockquote>`, etc.
  2. **Block-Scoped Token IDs**:
     - `measureBlockDomLayout(blockId, blockEl)` scopes token IDs as `${blockId}::${rawTokenId}` when `blockId === 'blk_page_canvas'` using `extractTokenBlockScope` and `stripTokenBlockScope`.
     - This prevents token ID collisions (`content:0`, `title:0`, `subheader:0`) across `blk_header`, `blk_subheader`, and `blocks.map` (`blk_1`, `blk_2`, ...).
  3. **Memoization for Selection Stability**:
     - `memoizedBlockContentMap`, `tokenizedHeaderSegments`, and `tokenizedSubheaderSegments` MUST stay memoized with `useMemo` so pointer/laser/scroll updates never recreate `{ __html }` objects or wipe browser text selection.
     - Word-level attributes (`data-marked`, `data-highlighted`, `data-stroke-ids`, `data-laser-target`) inside `.content-html-fragment` are synchronized via the dedicated `useEffect` in `VirtualContentStage.tsx` without resetting `innerHTML`.

### 1.3 Laser Pointer in Content Tab (LOCKED — DO NOT TOUCH)
- **Files**:
  - `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
  - `frontend/src/modules/live-classroom/utils/contentSyncMath.ts`
- **Invariants**:
  - Local teacher laser dot uses exact local cursor coordinates (`teacherLaserCoord`: `clientX - sheetRect.left`, `clientY - sheetRect.top`) with zero lag.
  - Remote follower laser position resolves via `resolveLaserTargetPosition`:
    1. Exact word token projection (`tokenId` + `rx`, `ry` on `[data-token-id]`).
    2. Semantic sub-region projection (`regionId` + `regionRx`, `regionRy`).
    3. Block-relative percentage (`x`, `y`).
    4. Whole-sheet fallback (`sheetXPct`, `sheetYPct`).
  - Excalidraw-style decaying laser trail (`data-testid="content-laser-trail"`) decays smoothly over 650ms via `requestAnimationFrame`.

### 1.4 Pen Tool & Cross-Device Line-Locking (LOCKED — DO NOT TOUCH)
- **Files**:
  - `frontend/src/modules/live-classroom/utils/contentSyncMath.ts`
  - `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
- **Invariants (Preventing Long Vertical/Diagonal Lines on Mobile)**:
  1. **Active-Stroke Line Locking (`preferredLineTop`)**:
     - During an active pointer drag (`handleBlockPointerMove`), `preferredLineTop` is resolved from the stroke's active token box (`tokenBox.top`) and passed into `captureStrokePoint(..., preferredLineTop)` -> `hitTestWordToken(..., preferredLineTop)`.
     - Step 0 of `hitTestWordToken` locks slight upward/downward hand drift on Laptop (`[t.top - max(7, 0.42*H), t.top + H + max(12, 0.55*H)]`) to tokens on the same line (`Math.abs(t.top - preferredLineTop) <= t.height * 0.55`), preventing accidental jumps to the line above or below (which on Mobile wraps 2–3 lines away).
  2. **Non-Overlapping Vertical Hit Zones**:
     - Step 1 of `hitTestWordToken` uses `localY >= t.top + 1.5` and `localY <= t.top + t.height + Math.max(6, Math.min(12, t.height * 0.28))`, and Step 2 applies a `* 3.5` upward distance penalty so underlines drawn below Line 1 never snap to Line 2.
  3. **Cross-Line Spike Repair & Subpath Breaking (`buildResponsiveSvgPath`)**:
     - Isolated 1-point cross-line token index spikes (`Math.abs(prevIdx - nextIdx) <= 2` while `currIdx` jumps `>= 4` tokens away) are repaired to `prev.tokenId` in `cleanedInputPoints`.
     - Un-tokenized points adjacent to tokenized points are bounded by word height (`anchorH * 3.5` horizontally, `anchorH * 0.35` vertically) instead of multiplying by full mobile block height.
     - `shouldBreakSubpath` emits a clean `M` move command whenever two consecutive tokens sit on different lines (`Math.abs(curr.tokenBox.top - prev.tokenBox.top) > avgHeight * 0.6`), regardless of whether `curr.tokenBox.left` is less than or greater than `prev.tokenBox.left`, or whenever `Math.abs(curr.py - prev.py) > refHeight * 1.15`.

### 1.5 Dedicated Highlighter Tool with Color Options (LOCKED — DO NOT TOUCH)
- **Files**:
  - `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
  - `frontend/src/modules/live-classroom/hooks/useBroadcastSocket.ts`
  - `frontend/src/modules/live-classroom/styles/learning-content.css`
- **Invariants**:
  - Floating toolbar order: **Select** (`content-tool-cursor`) -> **Pen** (`content-tool-pen`) -> **Highlighter** (`content-tool-highlighter`) -> **Laser** (`content-tool-laser`) -> **Eraser** (`content-tool-eraser`) -> **Color Swatches** (shown for both `pen` and `highlighter`: `['#ef4444', '#12a3ff', '#10b981', '#f59e0b', '#eab308', '#0f172a']`) -> **Clear** (`content-clear-strokes-btn`, teacher only).
  - When `activeTool === 'highlighter'`, strokes are recorded with `tool: 'highlighter'`.
  - Any word token touched by a `highlighter` stroke receives `highlightedColor` in `TokenAnnotationInfo`, rendering inline word highlight + solid bottom underline (`backgroundColor: hexToRgba(color, 0.24)`, `borderBottom: 2.5px solid ${color}`, `borderRadius: '3px'`, `paddingBottom: '1px'`) on both React-rendered token spans (`renderTokenizedText`) and HTML fragment token spans (`.content-html-fragment [data-token-id]`).
  - In all 4 SVG annotation overlays (`blk_page_canvas`, `blk_header`, `blk_subheader`, and `block.blockId`), if `stroke.tool === 'highlighter'` and the stroke has word tokens (`hasWordTokens`), the `<path>` is skipped (`return null`) so Highlighter cleanly highlights and underlines words without drawing freehand SVG lines over text.
  - Keep the comment `/* Word highlighting with underline commented out as of now — using Pen SVG marking only ... */` intact in `renderTokenizedText` for backward compatibility with Suite 9 tests.

### 1.6 SVG Annotation Overlay CSS Protection & Tool Cursors
- **File**: `frontend/src/modules/live-classroom/styles/learning-content.css`
- **Invariants**:
  - `.content-main-container svg:not([data-annotation-overlay="true"])` applies `height: auto` ONLY to content diagrams, while `svg[data-annotation-overlay="true"]` enforces `width: 100% !important; height: 100% !important; max-height: none !important; margin: 0 !important;` so block SVG overlays never collapse on mobile when block height > width.
  - `.content-main-container summary` and `.content-main-container .mcq-option` MUST stay `display: block` (not `display: flex`) so tokenized `[data-token-id]` spans inside them remain inline and do not split into separate flex columns.
  - Tool cursors: `cursor` -> normal/text selection, `pen` / `highlighter` / `eraser` -> `crosshair`, `laser` -> `none`.

### 1.7 Smooth 60fps Mobile Follower Scroll Synchronization
- **File**: `frontend/src/modules/live-classroom/components/VirtualContentStage.tsx`
- **Invariants**:
  - Follower scroll synchronization uses `smoothScrollFollowerTo(container, targetScrollTop)` driven by `requestAnimationFrame` (`scrollAnimFrameRef`, `scrollTargetTopRef`) with exponential damping (`diff * 0.28`), plus edge-locking (`atBottom` / `atTop` / `progressRatio`) via `computeScrollEngineTargetTop`.

---

## 2. Locked Whiteboard Architecture & Invariants

- **Files**:
  - `frontend/src/modules/live-classroom/components/ExcalidrawStage.tsx`
  - `frontend/src/modules/live-classroom/LearningSessionLayout.tsx`
  - `frontend/src/modules/live-classroom/hooks/useBroadcastSocket.ts`
- **Invariants (DO NOT BREAK)**:
  1. Default whiteboard font is **Comic Sans** (`fontFamily: 5`).
  2. Bidirectional synchronization of Excalidraw scene elements, camera/zoom/scroll (`WHITEBOARD_CAMERA_UPDATE`), laser pointer, and collaborator cursors works across **Primary Host Teacher**, **Co-Host**, and **Students granted board access (`hasBoardAccess`)**.
  3. Students never see the global "Clear" button on Whiteboard or Content Tab.
  4. Stored whiteboard artifacts strip temporary Content Mode strokes and `isDeleted` Excalidraw elements via `sanitizeWhiteboardElementsForStorage`.

---

## 3. Mandatory Verification Gate Before Completing Any Task

Before finishing any code change or bug fix in this repository, you MUST run and pass all three checks in `/var/www/html/broadcast/frontend`:

```bash
cd /var/www/html/broadcast/frontend && npx tsc --noEmit && pnpm test && npx next build
```

- All unit and integration suites in `frontend/tests/phase2.test.ts` (Suites 1–19, 52+ tests) MUST pass with `0` failures.
