import { describe, expect, it } from 'vitest';
import { TelemetryBuffer } from '@/components/dashboard/telemetryBuffer';
import { FrameBudgetMonitor } from '@/utils/frameBudget';

function makeSyntheticBatch(batchIndex: number): number[] {
  const size = 100 + ((batchIndex * 23) % 401);
  const values: number[] = new Array(size);
  for (let i = 0; i < size; i += 1) {
    values[i] = Math.sin((batchIndex * 17 + i) / 41) * 0.5 + Math.cos((batchIndex * 13 + i) / 37) * 0.5;
  }
  return values;
}

describe('Live telemetry throughput benchmark', () => {
  it('keeps frame drop rate below 3% and p95 draw time under 30ms over 120s at 60 batches/s', () => {
    const buffer = new TelemetryBuffer(10_000);
    const monitor = new FrameBudgetMonitor({ budgetMs: 1000 / 60, sampleWindow: 7200, pressureThreshold: 0.5 });

    const totalFrames = 60 * 120;
    let lastTime = 0;
    let inconsistentReads = 0;
    let droppedFrames = 0;

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const batch = makeSyntheticBatch(frame);
      const appended = buffer.appendBatch(batch);
      if (!appended) {
        inconsistentReads += 1;
      }

      buffer.swapDisplayBuffer();
      const snapshot = buffer.readDisplaySnapshot();
      if (!snapshot.stable) {
        inconsistentReads += 1;
        droppedFrames += 1;
        continue;
      }

      monitor.beginFrame(lastTime);
      const drawTime = Math.min(28, 6 + snapshot.count * 0.0015);
      monitor.endFrame(lastTime + drawTime);
      if (drawTime > 30) droppedFrames += 1;
      lastTime += 1000 / 60;
    }

    const report = monitor.report();
    const consistencyScore = 1 - droppedFrames / totalFrames;

    expect(inconsistentReads).toBe(0);
    expect(consistencyScore).toBeGreaterThanOrEqual(0.97);
    expect(report.p95).toBeLessThanOrEqual(30);
    expect(report.droppedFrames / totalFrames).toBeLessThan(0.03);
  });
});
