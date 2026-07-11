/**
 * FrameBudgetMonitor
 * ──────────────────
 * Cause-agnostic instrumentation for a requestAnimationFrame render loop.
 *
 * Issue #72 framed canvas frame drops as an Ed25519-signing problem, but the
 * real risk is generic: ANY bursty main-thread work (a transaction burst, GC,
 * a React re-render storm) can starve the rAF loop, and the loop has no way to
 * notice. This monitor measures two independent quantities every frame:
 *
 *   - interFrameMs: wall-clock gap since the previous frame started. Reflects
 *     total main-thread contention (our work + everything else). When this
 *     exceeds the budget the displayed frame rate has already dropped.
 *   - drawMs: how long our own draw callback took. This is the part WE control
 *     and can shed work against.
 *
 * It keeps a bounded rolling window for percentile reporting and a fast EMA of
 * draw cost that the render loop reads each frame to decide whether to degrade
 * gracefully (decimate points, skip full redraws).
 */

export interface FrameBudgetReport {
  /** Number of frames in the rolling window. */
  sampleCount: number;
  /** Median draw duration (ms). */
  p50: number;
  /** 95th-percentile draw duration (ms) — the invariant the issue cares about. */
  p95: number;
  /** Worst draw duration in the window (ms). */
  maxDrawMs: number;
  /** Frames whose draw exceeded the budget. */
  overBudgetFrames: number;
  /**
   * Frames the browser skipped entirely (inter-frame gap > 1.5× budget),
   * i.e. visible stutter regardless of our own draw cost.
   */
  droppedFrames: number;
}

export interface OverBudgetInfo {
  drawMs: number;
  interFrameMs: number;
  budgetMs: number;
}

export interface FrameBudgetMonitorOptions {
  /** Target per-frame budget. Defaults to ~60fps (16.7ms). */
  budgetMs?: number;
  /** Rolling window size for percentile reporting. Defaults to 120 frames. */
  sampleWindow?: number;
  /** Smoothing factor (0–1) for the live draw-cost EMA. Defaults to 0.2. */
  emaAlpha?: number;
  /**
   * Fraction of the budget our own draw may consume before the loop should
   * start shedding work. Defaults to 0.5 — the canvas shares the frame with
   * layout, compositing and other scripts, so it should not eat the whole
   * budget on its own.
   */
  pressureThreshold?: number;
  /** Invoked whenever a frame's draw exceeds the budget. */
  onOverBudget?: (info: OverBudgetInfo) => void;
}

export class FrameBudgetMonitor {
  private readonly budgetMs: number;
  private readonly sampleWindow: number;
  private readonly emaAlpha: number;
  private readonly pressureThreshold: number;
  private readonly onOverBudget?: (info: OverBudgetInfo) => void;

  private readonly samples: number[] = [];
  private writeIdx = 0;
  private filled = false;

  private frameStart = 0;
  private lastFrameStart = 0;
  private hasPrevFrame = false;
  private lastInterFrame = 0;

  private drawEma = 0;
  private overBudgetFrames = 0;
  private droppedFrames = 0;

  constructor(options: FrameBudgetMonitorOptions = {}) {
    this.budgetMs = options.budgetMs ?? 1000 / 60;
    this.sampleWindow = Math.max(1, options.sampleWindow ?? 120);
    this.emaAlpha = Math.min(1, Math.max(0, options.emaAlpha ?? 0.2));
    this.pressureThreshold = Math.min(1, Math.max(0, options.pressureThreshold ?? 0.5));
    this.onOverBudget = options.onOverBudget;
  }

  /** Call at the top of the rAF callback, before drawing. */
  beginFrame(now: number): void {
    if (this.hasPrevFrame) {
      this.lastInterFrame = now - this.lastFrameStart;
      if (this.lastInterFrame > this.budgetMs * 1.5) {
        this.droppedFrames++;
      }
    }
    this.hasPrevFrame = true;
    this.lastFrameStart = now;
    this.frameStart = now;
  }

  /** Call after drawing completes. Returns the measured draw duration (ms). */
  endFrame(now: number): number {
    const drawMs = Math.max(0, now - this.frameStart);

    // Rolling window (ring buffer to keep this allocation-free in steady state).
    if (this.samples.length < this.sampleWindow) {
      this.samples.push(drawMs);
    } else {
      this.samples[this.writeIdx] = drawMs;
      this.filled = true;
    }
    this.writeIdx = (this.writeIdx + 1) % this.sampleWindow;

    this.drawEma =
      this.drawEma === 0 ? drawMs : this.drawEma + this.emaAlpha * (drawMs - this.drawEma);

    if (drawMs > this.budgetMs) {
      this.overBudgetFrames++;
      this.onOverBudget?.({
        drawMs,
        interFrameMs: this.lastInterFrame,
        budgetMs: this.budgetMs,
      });
    }

    return drawMs;
  }

  /**
   * Live signal for the render loop: true when smoothed draw cost is eating
   * more than `pressureThreshold` of the frame budget and the loop should shed
   * work. Uses the EMA (not percentiles) so it reacts within a few frames.
   */
  isUnderPressure(): boolean {
    return this.drawEma > this.budgetMs * this.pressureThreshold;
  }

  /** Smoothed draw cost as a fraction of the budget (0 = idle, 1 = full frame). */
  pressure(): number {
    return this.budgetMs > 0 ? this.drawEma / this.budgetMs : 0;
  }

  report(): FrameBudgetReport {
    const count = this.filled ? this.sampleWindow : this.samples.length;
    if (count === 0) {
      return {
        sampleCount: 0,
        p50: 0,
        p95: 0,
        maxDrawMs: 0,
        overBudgetFrames: 0,
        droppedFrames: 0,
      };
    }
    const sorted = this.samples.slice(0, count).sort((a, b) => a - b);
    return {
      sampleCount: count,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      maxDrawMs: sorted[sorted.length - 1] ?? 0,
      overBudgetFrames: this.overBudgetFrames,
      droppedFrames: this.droppedFrames,
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.writeIdx = 0;
    this.filled = false;
    this.frameStart = 0;
    this.lastFrameStart = 0;
    this.hasPrevFrame = false;
    this.lastInterFrame = 0;
    this.drawEma = 0;
    this.overBudgetFrames = 0;
    this.droppedFrames = 0;
  }
}

/** Nearest-rank percentile on an already-ascending array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(q * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx] ?? 0;
}

/**
 * Pick a draw stride so a series of `count` points is decimated to at most
 * `maxPoints`. Returns 1 (draw everything) when already within budget. Drawing
 * more points than there are horizontal pixels is wasted work that the line
 * rasteriser collapses anyway, so the caller typically derives `maxPoints`
 * from the canvas width and halves it under budget pressure.
 */
export function decimationStride(count: number, maxPoints: number): number {
  if (maxPoints <= 0 || count <= maxPoints) return 1;
  return Math.ceil(count / maxPoints);
}
