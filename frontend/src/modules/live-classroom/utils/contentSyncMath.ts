/**
 * @file contentSyncMath.ts
 * @description Modular Coordinate & Word-Token Synchronization Engine for Content Mode.
 *
 * Architectural Overview:
 * -----------------------
 * On Desktop (e.g., 1280px) vs. Mobile (e.g., 375px full-width responsive view),
 * text paragraphs naturally wrap at different word boundaries. Pure block-percentage
 * coordinates (x%, y%) would land on different words when text reflows on mobile.
 *
 * To guarantee 100% accurate cross-device marking & highlighting:
 * 1. Deterministic Word Tokenization (`tokenizeText`):
 *    Splits every block's `title`, `content`, and `formulaLatex` into deterministic
 *    addressable word tokens (`title:0`, `content:14`, `formula:2`, etc.).
 * 2. Hybrid Hit-Testing (`captureStrokePoint`):
 *    When the Teacher draws with the Pen or Highlighter, each pointer coordinate is
 *    tested against the block's cached word token rects (`[data-token-id]`) and
 *    semantic sub-regions (`header`, `content`, `formula`, `diagram`).
 *    Every point records:
 *      - `x`, `y`: fallback percentage (0..100) relative to the block
 *      - `tokenId`: exact word token ID if over/near a word (`e.g. "content:12"`)
 *      - `rx`, `ry`: normalized (0..1) offset inside that word's bounding box
 *      - `regionId`: semantic container ID (`header` | `content` | `formula` | `diagram`)
 *      - `regionRx`, `regionRy`: normalized (0..1) offset inside that sub-region
 * 3. Line-Wrap-Aware SVG Re-Projection (`buildResponsiveSvgPath`):
 *    On any Student device (Mobile 375px or Desktop 1440px), stroke points are
 *    re-projected using the live DOM rects of `[data-token-id]` and `[data-region-id]`
 *    on that device. If a single stroke crosses two words that wrapped onto different
 *    lines on mobile, the SVG path automatically splits into clean per-line sub-paths
 *    instead of drawing a diagonal line across the paragraph.
 */

export type ContentRegionId = 'header' | 'content' | 'formula' | 'diagram' | 'block';

export interface TextTokenSegment {
  /** Stable identifier within the block, e.g., "content:0", "title:2", "formula:1" */
  tokenId: string | null;
  /** Raw text slice (word or whitespace) */
  text: string;
  /** True if this segment is a non-whitespace word token */
  isWord: boolean;
  /** Zero-based word index within the field */
  wordIndex: number;
}

export interface AnchoredStrokePoint {
  /** Fallback percentage X (0..100) relative to the block container */
  x: number;
  /** Fallback percentage Y (0..100) relative to the block container */
  y: number;
  /** Exact word token ID (`title:i`, `content:i`, `formula:i`) hit by this point */
  tokenId?: string;
  /** Normalized X (0..1) within the hit word token's bounding box */
  rx?: number;
  /** Normalized Y (0..1) within the hit word token's bounding box */
  ry?: number;
  /** Sub-region identifier (`header`, `content`, `formula`, `diagram`) */
  regionId?: ContentRegionId;
  /** Normalized X (0..1) within the sub-region container */
  regionRx?: number;
  /** Normalized Y (0..1) within the sub-region container */
  regionRy?: number;
}

export interface CachedTokenBox {
  tokenId: string;
  /** Left offset relative to block root (in CSS pixels) */
  left: number;
  /** Top offset relative to block root (in CSS pixels) */
  top: number;
  /** Width in CSS pixels */
  width: number;
  /** Height in CSS pixels */
  height: number;
}

export interface CachedRegionBox {
  regionId: ContentRegionId;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BlockDomLayoutCache {
  blockId: string;
  blockRect: DOMRect;
  tokens: Map<string, CachedTokenBox>;
  tokenList: CachedTokenBox[];
  regions: Map<ContentRegionId, CachedRegionBox>;
}

/**
 * Deterministically splits a text string into alternating word and whitespace segments.
 * Identical input text on Teacher Desktop and Student Mobile always yields identical `tokenId`s.
 */
export function tokenizeText(
  text: string | undefined | null,
  prefix: 'title' | 'content' | 'formula'
): TextTokenSegment[] {
  if (!text) return [];
  const rawParts = text.split(/(\s+)/);
  const segments: TextTokenSegment[] = [];
  let wordCounter = 0;

  for (const part of rawParts) {
    if (!part) continue;
    const isWhitespace = /^\s+$/.test(part);
    if (isWhitespace) {
      segments.push({
        tokenId: null,
        text: part,
        isWord: false,
        wordIndex: -1,
      });
    } else {
      const idx = wordCounter++;
      segments.push({
        tokenId: `${prefix}:${idx}`,
        text: part,
        isWord: true,
        wordIndex: idx,
      });
    }
  }

  return segments;
}

/**
 * Deterministically wraps every word inside an HTML string (`block.contentHtml`) in an inline
 * `<span data-token-id="${prefix}:${idx}" class="inline">word</span>` while preserving all
 * HTML tags, attributes, entities (`&nbsp;`), and non-text containers (`<script>`, `<style>`, `<svg>`, `<math>`).
 *
 * This guarantees that raw HTML lesson/topic content rendered via `dangerouslySetInnerHTML`
 * has 100% deterministic `[data-token-id]` word nodes across Teacher Desktop and Student Mobile
 * for exact word-by-word Pen marking and Laser pointer synchronization.
 */
export function tokenizeHtmlContent(
  html: string | undefined | null,
  prefix: 'title' | 'content' | 'formula' = 'content'
): string {
  if (!html || typeof html !== 'string') return '';
  if (html.includes('data-token-id=')) return html;

  const parts = html.split(/(<[^>]+>)/g);
  let wordCounter = 0;
  let skipDepth = 0;

  return parts
    .map((part) => {
      if (!part) return '';
      if (part.startsWith('<') && part.endsWith('>')) {
        const lower = part.toLowerCase();
        if (/^<\s*(script|style|svg|math|textarea)\b/.test(lower) && !/\/>\s*$/.test(lower)) {
          skipDepth++;
        } else if (/^<\s*\/\s*(script|style|svg|math|textarea)\b/.test(lower)) {
          skipDepth = Math.max(0, skipDepth - 1);
        }
        return part;
      }

      if (skipDepth > 0) return part;

      // Split text node by whitespace and HTML non-breaking space entities while preserving separators
      const subParts = part.split(/((?:\s+|(?:&nbsp;|&#160;|&#xa0;)+)+)/gi);
      return subParts
        .map((sub) => {
          if (!sub) return '';
          if (/^(?:\s+|(?:&nbsp;|&#160;|&#xa0;)+)+$/i.test(sub)) {
            return sub;
          }
          const idx = wordCounter++;
          return `<span data-token-id="${prefix}:${idx}" class="inline">${sub}</span>`;
        })
        .join('');
    })
    .join('');
}

export interface ScrollBlockMetric {
  blockId: string;
  topInScroll: number;
  height: number;
}

/**
 * Computes the semantic `(blockId, offsetRatio)` scroll anchor for the presenter's viewport.
 * Smoothly interpolates the reading focal line from the top of the first block (`scrollTop = 0`)
 * to the bottom of the last block (`scrollTop = maxScroll`) so scrolling to the end of content on
 * Desktop always emits `{ blockId: lastBlockId, offsetRatio: 1 }`.
 */
export function computeScrollAnchorForViewport(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  blocks: ScrollBlockMetric[]
): { blockId: string; offsetRatio: number } {
  if (scrollTop <= 8 || blocks.length === 0) {
    return { blockId: 'blk_header', offsetRatio: 0 };
  }

  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const lastBlock = blocks[blocks.length - 1];

  if (maxScroll > 0 && scrollTop >= maxScroll - 6) {
    return { blockId: lastBlock.blockId, offsetRatio: 1 };
  }

  const lastBottom = Math.max(1, lastBlock.topInScroll + Math.max(1, lastBlock.height));
  const scrollProgress = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
  const focusYInScroll = scrollTop + scrollProgress * (lastBottom - maxScroll);

  for (const item of blocks) {
    const height = Math.max(1, item.height);
    if (item.topInScroll + height >= focusYInScroll - 1) {
      const rawRatio = (focusYInScroll - item.topInScroll) / height;
      const offsetRatio = Number(Math.max(0, Math.min(1, rawRatio)).toFixed(4));
      return { blockId: item.blockId, offsetRatio };
    }
  }

  return { blockId: lastBlock.blockId, offsetRatio: 1 };
}

/**
 * Inverse projection of `(anchorBlockId, offsetRatio)` to the follower device's `scrollTop`.
 * Preserves per-block semantic alignment while guaranteeing that `{ blockId: lastBlockId, offsetRatio: 1 }`
 * scrolls all the way to `maxScroll = scrollHeight - clientHeight` on narrow mobile screens.
 */
export function computeFollowerTargetScrollTop(
  anchorBlockId: string | undefined,
  offsetRatio: number,
  clientHeight: number,
  scrollHeight: number,
  blocks: ScrollBlockMetric[]
): number {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll <= 0) return 0;

  if ((!anchorBlockId || anchorBlockId === 'blk_header') && Math.abs(offsetRatio) <= 0.02) {
    return 0;
  }

  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  if (lastBlock && anchorBlockId === lastBlock.blockId && offsetRatio >= 0.98) {
    return maxScroll;
  }

  const targetBlock =
    blocks.find((b) => b.blockId === anchorBlockId) ||
    (anchorBlockId === 'blk_header' ? blocks[0] : null);
  if (!targetBlock) {
    return offsetRatio >= 0.98 ? maxScroll : 0;
  }

  const targetPointInScroll =
    targetBlock.topInScroll + Math.max(1, targetBlock.height) * offsetRatio;
  const lastBottom = lastBlock
    ? Math.max(1, lastBlock.topInScroll + Math.max(1, lastBlock.height))
    : Math.max(1, scrollHeight);
  const docProgress = Math.max(0, Math.min(1, targetPointInScroll / lastBottom));
  const rawScrollTop = targetPointInScroll - docProgress * (lastBottom - maxScroll);

  return Math.max(0, Math.min(maxScroll, rawScrollTop));
}

/**
 * Builds a fast layout cache of all `[data-token-id]` and `[data-region-id]` elements
 * within a block DOM element. Called once on pointerDown or during layout measurement
 * to avoid per-frame `getBoundingClientRect` layout thrashing.
 */
export function measureBlockDomLayout(
  blockId: string,
  blockEl: HTMLElement
): BlockDomLayoutCache {
  const blockRect = blockEl.getBoundingClientRect();
  const safeBlockW = Math.max(1, blockRect.width);
  const safeBlockH = Math.max(1, blockRect.height);

  const tokens = new Map<string, CachedTokenBox>();
  const tokenList: CachedTokenBox[] = [];

  const tokenNodes = blockEl.querySelectorAll<HTMLElement>('[data-token-id]');
  tokenNodes.forEach((node) => {
    const tokenId = node.getAttribute('data-token-id');
    if (!tokenId) return;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const box: CachedTokenBox = {
      tokenId,
      left: r.left - blockRect.left,
      top: r.top - blockRect.top,
      width: r.width,
      height: r.height,
    };
    tokens.set(tokenId, box);
    tokenList.push(box);
  });

  const regions = new Map<ContentRegionId, CachedRegionBox>();
  regions.set('block', {
    regionId: 'block',
    left: 0,
    top: 0,
    width: safeBlockW,
    height: safeBlockH,
  });

  const regionNodes = blockEl.querySelectorAll<HTMLElement>('[data-region-id]');
  regionNodes.forEach((node) => {
    const regionId = node.getAttribute('data-region-id') as ContentRegionId | null;
    if (!regionId) return;
    const targetEl =
      regionId === 'diagram'
        ? (node.querySelector('svg') as Element | null) || node
        : node;
    const r = targetEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    regions.set(regionId, {
      regionId,
      left: r.left - blockRect.left,
      top: r.top - blockRect.top,
      width: r.width,
      height: r.height,
    });
  });

  return {
    blockId,
    blockRect,
    tokens,
    tokenList,
    regions,
  };
}

/**
 * Hit-tests a local coordinate `(localX, localY)` (in CSS pixels relative to block top-left)
 * against the block's word tokens.
 *
 * Line-Aware Asymmetric Vertical Geometry:
 * In multi-line paragraphs (`leading-[1.7]`), the vertical gap between `line1.bottom` and
 * `line2.top` is ~7px. Teachers naturally draw underlines 1-6px below the word on Line 1
 * (`line1.bottom .. line1.bottom + 6px`), which touches the top ascender padding of Line 2.
 * Each word's primary vertical target zone is `[t.top + 1.5, t.top + t.height + 6]` so that
 * underlines drawn below a line ALWAYS bind to the word being underlined on that line and
 * never snap to the top of a word on the line below.
 */
export function hitTestWordToken(
  localX: number,
  localY: number,
  cache: BlockDomLayoutCache,
  tolerancePx = 12
): { token: CachedTokenBox; rx: number; ry: number } | null {
  // 1. Direct containment including each word's immediate underline zone
  for (let i = 0; i < cache.tokenList.length; i++) {
    const t = cache.tokenList[i];
    if (
      localX >= t.left - 3 &&
      localX <= t.left + t.width + 3 &&
      localY >= t.top - 1 &&
      localY <= t.top + t.height + 6
    ) {
      const rx = Math.max(-1.5, Math.min(2.5, (localX - t.left) / Math.max(1, t.width)));
      const ry = Math.max(-1.0, Math.min(2.2, (localY - t.top) / Math.max(1, t.height)));
      return {
        token: t,
        rx: Math.round(rx * 1000) / 1000,
        ry: Math.round(ry * 1000) / 1000,
      };
    }
  }

  // 2. Asymmetric line-aware halo match (inter-word spaces and underlines below text)
  const tolX = Math.max(tolerancePx, 28);
  const tolY = Math.max(tolerancePx, 16);
  let bestToken: CachedTokenBox | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < cache.tokenList.length; i++) {
    const t = cache.tokenList[i];
    const dx =
      localX < t.left ? t.left - localX : localX > t.left + t.width ? localX - (t.left + t.width) : 0;

    const effectiveTop = t.top - 1;
    const effectiveBottom = t.top + t.height + 6;
    const dy =
      localY < effectiveTop
        ? (effectiveTop - localY) * 2.0
        : localY > effectiveBottom
        ? localY - effectiveBottom
        : 0;

    if (dx <= tolX && dy <= tolY) {
      // Weight vertical distance strongly so inter-word spaces stay on the same line
      const dist = dx * dx + (dy * 4.0) * (dy * 4.0);
      if (dist < bestDist) {
        bestDist = dist;
        bestToken = t;
      }
    }
  }

  if (bestToken) {
    const rx = Math.max(-1.5, Math.min(2.5, (localX - bestToken.left) / Math.max(1, bestToken.width)));
    const ry = Math.max(-1.0, Math.min(2.2, (localY - bestToken.top) / Math.max(1, bestToken.height)));
    return {
      token: bestToken,
      rx: Math.round(rx * 1000) / 1000,
      ry: Math.round(ry * 1000) / 1000,
    };
  }

  return null;
}

/**
 * Captures a rich anchored point from a pointer event inside a block.
 */
export function captureStrokePoint(
  clientX: number,
  clientY: number,
  cache: BlockDomLayoutCache,
  liveRect?: DOMRect
): AnchoredStrokePoint {
  const blockRect = liveRect || cache.blockRect;
  const safeW = Math.max(1, blockRect.width);
  const safeH = Math.max(1, blockRect.height);

  const localX = clientX - blockRect.left;
  const localY = clientY - blockRect.top;

  const isWholePageCanvas = cache.blockId === 'blk_page_canvas';
  const minPct = isWholePageCanvas ? -100 : 0;
  const maxPct = isWholePageCanvas ? 200 : 100;
  const rawPctX = Math.max(minPct, Math.min(maxPct, (localX / safeW) * 100));
  const rawPctY = Math.max(minPct, Math.min(maxPct, (localY / safeH) * 100));
  const pctX = Math.round(rawPctX * 10) / 10;
  const pctY = Math.round(rawPctY * 10) / 10;

  const point: AnchoredStrokePoint = {
    x: pctX,
    y: pctY,
  };

  // Check semantic sub-region containment (`diagram`, `formula`, `content`, `header`)
  const priorityRegions: ContentRegionId[] = ['diagram', 'formula', 'content', 'header'];
  for (const regId of priorityRegions) {
    const reg = cache.regions.get(regId);
    if (!reg) continue;
    if (
      localX >= reg.left - 4 &&
      localX <= reg.left + reg.width + 4 &&
      localY >= reg.top - 4 &&
      localY <= reg.top + reg.height + 4
    ) {
      point.regionId = regId;
      point.regionRx =
        Math.round(
          Math.max(0, Math.min(1, (localX - reg.left) / Math.max(1, reg.width))) * 1000
        ) / 1000;
      point.regionRy =
        Math.round(
          Math.max(0, Math.min(1, (localY - reg.top) / Math.max(1, reg.height))) * 1000
        ) / 1000;
      break;
    }
  }

  // Hit-test word tokens (unless inside a pure SVG diagram region)
  if (point.regionId !== 'diagram') {
    const hit = hitTestWordToken(localX, localY, cache, 14);
    if (hit) {
      point.tokenId = hit.token.tokenId;
      point.rx = hit.rx;
      point.ry = hit.ry;
    }
  }

  return point;
}

/**
 * Extracts all unique word `tokenId`s touched by a stroke.
 * Also interpolates intermediate words on the same field if the user swiftly drags
 * horizontally across a phrase so no middle word is skipped during fast pointer movements.
 */
export function extractAnchorTokensFromPoints(
  points: AnchoredStrokePoint[],
  cache?: BlockDomLayoutCache
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const addToken = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt.tokenId) continue;

    // If previous point had a token in the same field (e.g. "content:4" -> "content:7")
    // and they are on roughly the same horizontal line on the author's screen, fill in 5, 6
    if (i > 0 && points[i - 1].tokenId && cache) {
      const prevId = points[i - 1].tokenId!;
      const [prevPrefix, prevIdxStr] = prevId.split(':');
      const [currPrefix, currIdxStr] = pt.tokenId.split(':');
      const prevIdx = Number(prevIdxStr);
      const currIdx = Number(currIdxStr);

      if (
        prevPrefix === currPrefix &&
        !Number.isNaN(prevIdx) &&
        !Number.isNaN(currIdx) &&
        Math.abs(currIdx - prevIdx) > 1 &&
        Math.abs(currIdx - prevIdx) <= 8
      ) {
        const prevBox = cache.tokens.get(prevId);
        const currBox = cache.tokens.get(pt.tokenId);
        if (prevBox && currBox && Math.abs(prevBox.top - currBox.top) < prevBox.height * 0.8) {
          const step = currIdx > prevIdx ? 1 : -1;
          for (let k = prevIdx + step; k !== currIdx; k += step) {
            const midId = `${prevPrefix}:${k}`;
            if (cache.tokens.has(midId)) {
              addToken(midId);
            }
          }
        }
      }
    }

    addToken(pt.tokenId);
  }

  return ordered;
}

/**
 * Resolves a single `AnchoredStrokePoint` into local block pixel coordinates `(px, py)`
 * on the current viewer's device using the viewer's live `BlockDomLayoutCache`.
 *
 * Uses Word-Token Anchoring first (`tokenId`, `rx`, `ry`) so Pen strokes and Laser pointers
 * land on the exact same word and character offset on both Laptop (820px) and Mobile (360px),
 * even when text wraps into additional lines on smaller screens.
 */
export function projectPointToDevicePixels(
  pt: AnchoredStrokePoint,
  cache: BlockDomLayoutCache,
  _isPenStroke?: boolean
): { px: number; py: number; tokenBox?: CachedTokenBox } {
  const blockW = Math.max(1, cache.blockRect.width);
  const blockH = Math.max(1, cache.blockRect.height);

  // 1. Word-token anchored point: maps directly onto the exact same word on this device!
  if (pt.tokenId && typeof pt.rx === 'number' && typeof pt.ry === 'number') {
    const tokenBox = cache.tokens.get(pt.tokenId);
    if (tokenBox) {
      return {
        px: tokenBox.left + pt.rx * tokenBox.width,
        py: tokenBox.top + pt.ry * tokenBox.height,
        tokenBox,
      };
    }
  }

  // 2. Semantic sub-region anchored point (e.g., SVG diagram or formula box)
  if (
    pt.regionId &&
    typeof pt.regionRx === 'number' &&
    typeof pt.regionRy === 'number'
  ) {
    const regionBox = cache.regions.get(pt.regionId);
    if (regionBox) {
      return {
        px: regionBox.left + pt.regionRx * regionBox.width,
        py: regionBox.top + pt.regionRy * regionBox.height,
      };
    }
  }

  // 3. Fallback block percentage
  return {
    px: (pt.x / 100) * blockW,
    py: (pt.y / 100) * blockH,
  };
}

/**
 * Expands horizontal multi-word stroke segments that wrapped across multiple lines on the
 * current viewer's device so that the end of the upper line and the start of the wrapped
 * lower line are cleanly anchored without missing intermediate words.
 */
function expandWrappedTokenPoints(
  points: AnchoredStrokePoint[],
  cache: BlockDomLayoutCache
): AnchoredStrokePoint[] {
  if (points.length < 2 || cache.tokens.size === 0) return points;

  const expanded: AnchoredStrokePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const currPt = points[i];
    expanded.push(currPt);

    if (i >= points.length - 1) continue;
    const nextPt = points[i + 1];
    if (!currPt.tokenId || !nextPt.tokenId || currPt.tokenId === nextPt.tokenId) continue;

    const [currPrefix, currIdxStr] = currPt.tokenId.split(':');
    const [nextPrefix, nextIdxStr] = nextPt.tokenId.split(':');
    const currIdx = Number(currIdxStr);
    const nextIdx = Number(nextIdxStr);

    if (
      currPrefix !== nextPrefix ||
      Number.isNaN(currIdx) ||
      Number.isNaN(nextIdx) ||
      nextIdx <= currIdx ||
      nextIdx - currIdx > 12
    ) {
      continue;
    }

    const currBox = cache.tokens.get(currPt.tokenId);
    const nextBox = cache.tokens.get(nextPt.tokenId);
    if (!currBox || !nextBox) continue;

    const avgH = (currBox.height + nextBox.height) * 0.5;
    const isWrappedOnViewer = Math.abs(nextBox.top - currBox.top) > avgH * 0.6;
    const ryA = typeof currPt.ry === 'number' ? currPt.ry : 0.95;
    const ryB = typeof nextPt.ry === 'number' ? nextPt.ry : 0.95;

    if (isWrappedOnViewer && Math.abs(ryB - ryA) < 0.85) {
      const span = Math.max(1, nextIdx - currIdx);
      for (let k = currIdx; k < nextIdx; k++) {
        const kId = `${currPrefix}:${k}`;
        const kNextId = `${currPrefix}:${k + 1}`;
        const boxK = cache.tokens.get(kId);
        const boxKNext = cache.tokens.get(kNextId);
        if (!boxK || !boxKNext) continue;

        const lineGap = Math.abs(boxKNext.top - boxK.top);
        const localAvgH = (boxK.height + boxKNext.height) * 0.5;
        if (lineGap > localAvgH * 0.6) {
          const tRatio = (k - currIdx + 0.5) / span;
          const interpRy = Math.round((ryA + (ryB - ryA) * tRatio) * 1000) / 1000;

          // Complete stroke to the right edge of the last word before the line wrap
          if (k > currIdx || (typeof currPt.rx === 'number' && currPt.rx < 0.92)) {
            expanded.push({
              x: currPt.x,
              y: currPt.y,
              tokenId: kId,
              rx: 0.98,
              ry: interpRy,
            });
          }

          // Start stroke at the left edge of the first word on the wrapped line
          if (k + 1 < nextIdx || (typeof nextPt.rx === 'number' && nextPt.rx > 0.08)) {
            expanded.push({
              x: nextPt.x,
              y: nextPt.y,
              tokenId: kNextId,
              rx: 0.02,
              ry: interpRy,
            });
          }
        }
      }
    }
  }

  return expanded;
}

/**
 * Builds an SVG `d` path string in pixel space (`viewBox="0 0 blockWidth blockHeight"`)
 * for a stroke on the current device.
 *
 * Line-Wrap Awareness:
 * If two consecutive stroke points are anchored to words that sit on different lines on
 * the current device (e.g. a phrase wrapped onto the next line on a 375px mobile screen),
 * this function breaks the path with a new `M` command so the underline/mark cleanly
 * continues on the next line without drawing a diagonal slash across the screen.
 */
export function buildResponsiveSvgPath(
  points: AnchoredStrokePoint[],
  cache: BlockDomLayoutCache | null | undefined,
  isPenStroke?: boolean
): string {
  if (!points || points.length === 0) return '';

  // Fallback if DOM layout cache is not yet measured
  if (!cache || cache.blockRect.width <= 0) {
    return points
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`)
      .join(' ');
  }

  const workingPoints = expandWrappedTokenPoints(points, cache);
  const projected = workingPoints.map((pt) => projectPointToDevicePixels(pt, cache, isPenStroke));

  // If a stroke is primarily word-anchored, keep any un-tokenized margin points anchored relative to their nearest word-anchored neighbor
  const hasTokenAnchoredPoint = projected.some((p) => Boolean(p.tokenBox));
  if (hasTokenAnchoredPoint && projected.length > 1) {
    const blockW = Math.max(1, cache.blockRect.width);
    const blockH = Math.max(1, cache.blockRect.height);
    for (let i = 0; i < projected.length; i++) {
      if (projected[i].tokenBox || workingPoints[i].regionId === 'diagram') continue;
      // Find nearest neighbor with a tokenBox
      let nearestIdx = -1;
      let minStepDist = Infinity;
      for (let j = 0; j < projected.length; j++) {
        if (projected[j].tokenBox && Math.abs(j - i) < minStepDist) {
          minStepDist = Math.abs(j - i);
          nearestIdx = j;
        }
      }
      if (nearestIdx !== -1) {
        const anchorProj = projected[nearestIdx];
        const anchorPt = workingPoints[nearestIdx];
        const currPt = workingPoints[i];
        projected[i] = {
          px: anchorProj.px + ((currPt.x - anchorPt.x) / 100) * blockW,
          py: anchorProj.py + ((currPt.y - anchorPt.y) / 100) * blockH,
          tokenBox: anchorProj.tokenBox,
        };
      }
    }
  }

  if (projected.length === 1) {
    const p = projected[0];
    return `M ${p.px.toFixed(1)} ${p.py.toFixed(1)} L ${(p.px + 0.5).toFixed(1)} ${(p.py + 0.5).toFixed(1)}`;
  }

  const commands: string[] = [];
  for (let i = 0; i < projected.length; i++) {
    const curr = projected[i];
    if (i === 0) {
      commands.push(`M ${curr.px.toFixed(1)} ${curr.py.toFixed(1)}`);
      continue;
    }

    const prev = projected[i - 1];
    let shouldBreakSubpath = false;

    // Detect if the stroke jumped across a line wrap on this device
    if (prev.tokenBox && curr.tokenBox && prev.tokenBox.tokenId !== curr.tokenBox.tokenId) {
      const lineDiff = Math.abs(curr.tokenBox.top - prev.tokenBox.top);
      const avgHeight = (curr.tokenBox.height + prev.tokenBox.height) * 0.5;
      // If the two words are on different lines AND X jumped backward (line wrap)
      if (lineDiff > avgHeight * 0.6 && curr.tokenBox.left < prev.tokenBox.left + 4) {
        shouldBreakSubpath = true;
      }
    }

    commands.push(
      `${shouldBreakSubpath ? 'M' : 'L'} ${curr.px.toFixed(1)} ${curr.py.toFixed(1)}`
    );
  }

  return commands.join(' ');
}

/**
 * Sanitizes untrusted SVG diagram markup before rendering via `dangerouslySetInnerHTML`.
 * Strips `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, inline `on*`
 * event handlers, and `javascript:` / `vbscript:` / `data:text/html` URIs while preserving
 * valid vector primitives (`<svg>`, `<path>`, `<circle>`, `<rect>`, `<line>`, `<text>`, etc.).
 */
export function sanitizeSvgMarkup(svg: string | undefined | null): string {
  if (!svg || typeof svg !== 'string') return '';

  return svg
    // 1. Strip dangerous container tags and their inner contents
    .replace(/<\s*(script|foreignObject|iframe|object|embed|applet|meta|link)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // 2. Strip self-closing or unclosed dangerous tags
    .replace(/<\s*\/?\s*(script|foreignObject|iframe|object|embed|applet|meta|link)\b[^>]*\/?>/gi, '')
    // 3. Strip all inline event handlers (onload, onerror, onclick, onmouseover, onbegin, etc.)
    .replace(/\s+on[a-zA-Z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // 4. Neutralize javascript:, vbscript:, and data:text/html URIs inside href / xlink:href / src / style
    .replace(
      /(\b(?:xlink:href|href|src|action|formaction)\s*=\s*(?:"|'))\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"']*(?:"|')/gi,
      '$1#"'
    )
    .replace(/(?:javascript|vbscript)\s*:/gi, 'blocked:');
}
