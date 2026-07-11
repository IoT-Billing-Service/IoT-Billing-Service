/**
 * canvasText
 * ──────────
 * Width-aware label fitting for monospace canvas text.
 *
 * Issue #71 framed device-label overflow as an OffscreenCanvas/Web-Worker font
 * mismatch (Inter measured differently in a worker than on the main thread).
 * The real FleetCanvasGrid has no worker rendering and no Inter — it draws on
 * the main thread in `monospace`. That collapses the problem: in a monospace
 * font every glyph shares the same advance width, so label fitting is exact
 * integer arithmetic — measure one glyph, then `floor(maxWidth / charWidth)`.
 *
 * The current code truncates by a fixed character count (`name.slice(0, 8)`),
 * which overflows the cell for wide glyphs and under-fills for narrow ones, and
 * never shows an ellipsis. These helpers fix that without a per-label
 * `measureText` (which would itself regress the per-frame draw cost).
 */

const charWidthCache = new Map<string, number>();

/**
 * Advance width (px) of a single glyph for the context's current font, cached
 * per `ctx.font` string. Valid for monospace fonts, where every glyph shares
 * this advance. Zero results (e.g. font not yet ready) are not cached so a
 * later call can re-measure.
 */
export function monoCharWidth(ctx: {
  font: string;
  measureText: (text: string) => { width: number };
}): number {
  const cached = charWidthCache.get(ctx.font);
  if (cached !== undefined) return cached;
  const width = ctx.measureText('0').width;
  if (width > 0) charWidthCache.set(ctx.font, width);
  return width;
}

/** Clears the per-font advance-width cache (test/teardown helper). */
export function clearCharWidthCache(): void {
  charWidthCache.clear();
}

/**
 * Truncate `text` so it fits within `maxWidth` px when rendered in a monospace
 * font whose glyph advance is `charWidth`, appending `ellipsis` when clipped.
 * Pure arithmetic — no canvas required — so it is exact and unit-testable.
 *
 * The ellipsis occupies one monospace cell, so a clipped result keeps
 * `maxChars - 1` source characters plus the ellipsis, never exceeding maxWidth.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  charWidth: number,
  ellipsis = '…',
): string {
  if (!text || charWidth <= 0 || maxWidth <= 0) return '';

  const maxChars = Math.floor(maxWidth / charWidth);
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return ellipsis;

  return text.slice(0, maxChars - 1) + ellipsis;
}
