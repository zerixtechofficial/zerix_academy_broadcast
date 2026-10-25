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
    const r = node.getBoundingClientRect();
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
 * First checks exact containment, then checks a tight tolerance halo (e.g. underlines just below a word).
 */
export function hitTestWordToken(
  localX: number,
  localY: number,
  cache: BlockDomLayoutCache,
  tolerancePx = 6
): { token: CachedTokenBox; rx: number; ry: number } | null {
  // 1. Direct containment (including small horizontal space padding between words on the same line)
  for (let i = 0; i < cache.tokenList.length; i++) {
    const t = cache.tokenList[i];
    if (
      localX >= t.left - 2 &&
      localX <= t.left + t.width + 2 &&
      localY >= t.top - 2 &&
      localY <= t.top + t.height + 2
    ) {
      const rx = Math.max(-0.15, Math.min(1.15, (localX - t.left) / Math.max(1, t.width)));
      const ry = Math.max(-0.25, Math.min(1.25, (localY - t.top) / Math.max(1, t.height)));
      return {
        token: t,
        rx: Math.round(rx * 1000) / 1000,
        ry: Math.round(ry * 1000) / 1000,
      };
    }
  }

  // 2. Halo match (e.g. Teacher draws an underline 3-6px directly under a word)
  let bestToken: CachedTokenBox | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < cache.tokenList.length; i++) {
    const t = cache.tokenList[i];
    const dx =
      localX < t.left ? t.left - localX : localX > t.left + t.width ? localX - (t.left + t.width) : 0;
    const dy =
      localY < t.top ? t.top - localY : localY > t.top + t.height ? localY - (t.top + t.height) : 0;

    if (dx <= tolerancePx && dy <= tolerancePx) {
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestToken = t;
      }
    }
  }

  if (bestToken) {
    const rx = Math.max(-0.2, Math.min(1.2, (localX - bestToken.left) / Math.max(1, bestToken.width)));
    const ry = Math.max(-0.35, Math.min(1.35, (localY - bestToken.top) / Math.max(1, bestToken.height)));
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

  const rawPctX = Math.max(0, Math.min(100, (localX / safeW) * 100));
  const rawPctY = Math.max(0, Math.min(100, (localY / safeH) * 100));
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
    const hit = hitTestWordToken(localX, localY, cache, 7);
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
        Math.abs(currIdx - prevIdx) <= 6
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
 */
export function projectPointToDevicePixels(
  pt: AnchoredStrokePoint,
  cache: BlockDomLayoutCache,
  isPenStroke?: boolean
): { px: number; py: number; tokenBox?: CachedTokenBox } {
  const blockW = Math.max(1, cache.blockRect.width);
  const blockH = Math.max(1, cache.blockRect.height);

  // If freehand pen stroke, map directly to exact percentage to preserve smooth continuous freehand curves
  if (isPenStroke) {
    return {
      px: (pt.x / 100) * blockW,
      py: (pt.y / 100) * blockH,
    };
  }

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

  const projected = points.map((pt) => projectPointToDevicePixels(pt, cache, isPenStroke));
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
      if (lineDiff > avgHeight * 0.65 && curr.tokenBox.left < prev.tokenBox.left) {
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
