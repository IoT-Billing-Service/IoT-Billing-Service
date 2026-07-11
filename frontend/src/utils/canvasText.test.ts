import { describe, it, expect, afterEach } from 'vitest';
import { truncateToWidth, monoCharWidth, clearCharWidthCache } from './canvasText';

describe('truncateToWidth', () => {
  // Use a 10px advance so px ↔ char math is obvious: maxWidth / 10 = maxChars.
  const CW = 10;

  it('returns the text unchanged when it fits', () => {
    expect(truncateToWidth('Device', 100, CW)).toBe('Device'); // 6 chars, fits in 10
    expect(truncateToWidth('Device-12', 90, CW)).toBe('Device-12'); // exactly 9 chars in 9
  });

  it('truncates with an ellipsis when too wide, never exceeding the width', () => {
    // maxChars = floor(50/10) = 5 -> keep 4 chars + ellipsis = 5 cells.
    const out = truncateToWidth('Device-1234', 50, CW);
    expect(out).toBe('Devi…');
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('guarantees the issue-71 invariant: wide labels never overflow the cell', () => {
    // A cell ~68px wide (80 - 12) at 10px advance fits 6 chars. Wide-glyph name
    // that the old slice(0, 8) would have overflowed is now clipped to fit.
    const maxWidth = 68;
    const result = truncateToWidth('WWWWWWWWWWWW', maxWidth, CW);
    expect(result.length * CW).toBeLessThanOrEqual(maxWidth);
    expect(result.endsWith('…')).toBe(true);
  });

  it('collapses to a bare ellipsis when only one cell fits', () => {
    expect(truncateToWidth('Device', 10, CW)).toBe('…'); // maxChars = 1
  });

  it('returns empty for degenerate inputs', () => {
    expect(truncateToWidth('Device', 5, CW)).toBe(''); // maxChars = 0
    expect(truncateToWidth('', 100, CW)).toBe('');
    expect(truncateToWidth('Device', 100, 0)).toBe(''); // charWidth 0
    expect(truncateToWidth('Device', 0, CW)).toBe('');
  });

  it('respects a custom ellipsis', () => {
    expect(truncateToWidth('Device-1234', 50, CW, '..')).toBe('Devi..');
  });
});

describe('monoCharWidth', () => {
  afterEach(() => clearCharWidthCache());

  it('measures once per font string and caches the result', () => {
    let calls = 0;
    const ctx = {
      font: '10px monospace',
      measureText: () => {
        calls++;
        return { width: 6 };
      },
    };

    expect(monoCharWidth(ctx)).toBe(6);
    expect(monoCharWidth(ctx)).toBe(6);
    expect(calls).toBe(1); // second call served from cache

    ctx.font = '12px monospace';
    expect(monoCharWidth(ctx)).toBe(6);
    expect(calls).toBe(2); // new font -> re-measured
  });

  it('does not cache a zero width so it can be re-measured later', () => {
    let width = 0;
    const ctx = {
      font: '10px monospace',
      measureText: () => ({ width }),
    };

    expect(monoCharWidth(ctx)).toBe(0); // font not ready
    width = 6;
    expect(monoCharWidth(ctx)).toBe(6); // re-measured, not stuck on 0
  });
});
