import { describe, it, expect, vi } from 'vitest';
import { FrameBudgetMonitor, decimationStride } from './frameBudget';

describe('decimationStride', () => {
  it('draws everything when within budget', () => {
    expect(decimationStride(100, 2000)).toBe(1);
    expect(decimationStride(2000, 2000)).toBe(1);
  });

  it('decimates proportionally when over the point cap', () => {
    expect(decimationStride(10_000, 2000)).toBe(5);
    expect(decimationStride(6000, 2000)).toBe(3);
  });

  it('is safe for degenerate inputs', () => {
    expect(decimationStride(10_000, 0)).toBe(1);
    expect(decimationStride(0, 2000)).toBe(1);
  });
});

describe('FrameBudgetMonitor', () => {
  /** Feed one frame with an exact draw duration by controlling begin/end times. */
  function frame(m: FrameBudgetMonitor, startMs: number, drawMs: number) {
    m.beginFrame(startMs);
    m.endFrame(startMs + drawMs);
  }

  it('reports percentiles over the rolling window', () => {
    const m = new FrameBudgetMonitor({ budgetMs: 16, sampleWindow: 100 });
    let t = 0;
    // 90 cheap frames (2ms) + 10 expensive frames (20ms).
    for (let i = 0; i < 90; i++) {
      frame(m, t, 2);
      t += 16;
    }
    for (let i = 0; i < 10; i++) {
      frame(m, t, 20);
      t += 16;
    }

    const report = m.report();
    expect(report.sampleCount).toBe(100);
    expect(report.p50).toBe(2);
    expect(report.p95).toBe(20);
    expect(report.maxDrawMs).toBe(20);
  });

  it('counts over-budget frames and invokes the callback', () => {
    const onOverBudget = vi.fn();
    const m = new FrameBudgetMonitor({ budgetMs: 16, onOverBudget });

    frame(m, 0, 5); // within budget
    frame(m, 16, 25); // over budget

    expect(onOverBudget).toHaveBeenCalledTimes(1);
    expect(onOverBudget).toHaveBeenCalledWith(
      expect.objectContaining({ drawMs: 25, budgetMs: 16 }),
    );
    expect(m.report().overBudgetFrames).toBe(1);
  });

  it('detects dropped frames from inter-frame stalls (the issue-72 scenario)', () => {
    // Simulate a burst of synchronous main-thread work stalling the loop:
    // frames that should arrive every ~16ms instead arrive 30ms apart.
    const m = new FrameBudgetMonitor({ budgetMs: 16 });
    m.beginFrame(0);
    m.endFrame(2);
    m.beginFrame(30); // 30ms gap > 1.5 * 16 => dropped
    m.endFrame(32);
    m.beginFrame(60); // another 30ms gap => dropped
    m.endFrame(62);

    expect(m.report().droppedFrames).toBe(2);
  });

  it('signals pressure when draw cost dominates the budget, then recovers', () => {
    const m = new FrameBudgetMonitor({ budgetMs: 16, pressureThreshold: 0.5 });

    // Sustained 12ms draws (> 8ms = 50% of budget) => under pressure.
    let t = 0;
    frame(m, t, 12);
    t += 16;
    expect(m.isUnderPressure()).toBe(true);

    // Many cheap 1ms draws pull the EMA back below threshold => recovered.
    for (let i = 0; i < 50; i++) {
      frame(m, t, 1);
      t += 16;
    }
    expect(m.isUnderPressure()).toBe(false);
  });

  it('keeps p95 within budget once decimation sheds work under load', () => {
    // Model the loop: draw cost is proportional to points plotted. Without a
    // cap, 10k points blow the 16ms budget; the width/pressure cap keeps it in.
    const budgetMs = 16;
    const msPerPoint = 16 / 8000; // 10k raw points would cost ~20ms
    const widthPx = 600;
    const m = new FrameBudgetMonitor({ budgetMs });

    let t = 0;
    for (let i = 0; i < 120; i++) {
      const rawCount = 10_000;
      const maxPoints = m.isUnderPressure()
        ? Math.floor(Math.min(2000, widthPx) / 2)
        : Math.min(2000, widthPx);
      const stride = decimationStride(rawCount, maxPoints);
      const plotted = Math.ceil(rawCount / stride);
      frame(m, t, plotted * msPerPoint);
      t += 16;
    }

    expect(m.report().p95).toBeLessThanOrEqual(budgetMs);
  });

  it('reset clears all accumulated state', () => {
    const m = new FrameBudgetMonitor({ budgetMs: 16 });
    frame(m, 0, 25);
    expect(m.report().overBudgetFrames).toBe(1);
    m.reset();
    const report = m.report();
    expect(report.sampleCount).toBe(0);
    expect(report.overBudgetFrames).toBe(0);
    expect(m.isUnderPressure()).toBe(false);
  });
});
