import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRenderLoop } from './useRenderLoop';

describe('useRenderLoop (animation-frame mode)', () => {
  let rafCb: ((t: number) => void) | null;
  let rafCount: number;
  let cancelSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rafCb = null;
    rafCount = 0;
    cancelSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      rafCb = cb;
      return ++rafCount;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Invoke the currently-scheduled frame callback with timestamp `t`. */
  const frame = (t: number) => {
    const cb = rafCb;
    rafCb = null;
    cb?.(t);
  };

  it('draws each frame while visible', () => {
    const draw = vi.fn();
    renderHook(() => useRenderLoop({ draw, prefersReducedMotion: false, isVisible: () => true }));

    frame(16);
    expect(draw).toHaveBeenCalledWith(16);
    frame(32);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('skips drawing while hidden but keeps the loop alive', () => {
    const draw = vi.fn();
    let visible = false;
    renderHook(() =>
      useRenderLoop({ draw, prefersReducedMotion: false, isVisible: () => visible }),
    );

    frame(16);
    expect(draw).not.toHaveBeenCalled();
    expect(rafCb).not.toBeNull(); // rescheduled

    visible = true;
    frame(32);
    expect(draw).toHaveBeenCalledWith(32);
  });

  it('calls onResumeAfterHidden when the frame gap exceeds the threshold', () => {
    const draw = vi.fn();
    const onResume = vi.fn();
    renderHook(() =>
      useRenderLoop({
        draw,
        prefersReducedMotion: false,
        isVisible: () => true,
        onResumeAfterHidden: onResume,
      }),
    );

    frame(1000); // first frame: no previous timestamp, no resume
    expect(onResume).not.toHaveBeenCalled();
    frame(1000 + 6000); // 6s gap > 5s threshold
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('cancels the frame on unmount', () => {
    const { unmount } = renderHook(() =>
      useRenderLoop({ draw: vi.fn(), prefersReducedMotion: false, isVisible: () => true }),
    );
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});

describe('useRenderLoop (reduced-motion mode)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drives draw on an interval when visible, and stops on unmount', () => {
    const draw = vi.fn();
    const { unmount } = renderHook(() =>
      useRenderLoop({
        draw,
        prefersReducedMotion: true,
        isVisible: () => true,
        reducedMotionIntervalMs: 100,
      }),
    );

    vi.advanceTimersByTime(100);
    expect(draw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(draw).toHaveBeenCalledTimes(2);

    unmount();
    vi.advanceTimersByTime(300);
    expect(draw).toHaveBeenCalledTimes(2); // no more draws after unmount
  });
});
