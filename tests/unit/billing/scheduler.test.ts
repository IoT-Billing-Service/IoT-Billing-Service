import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BillingCycleScheduler } from '../../../src/billing/scheduler.js';

describe('BillingCycleScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTick on the configured interval', async () => {
    let ticks = 0;
    const scheduler = new BillingCycleScheduler(
      () => {
        ticks += 1;
        return Promise.resolve();
      },
      { intervalMs: 1000 },
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    scheduler.stop();
    expect(ticks).toBe(3);
  });

  it('skips a tick if the previous one is still running (no overlap)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const scheduler = new BillingCycleScheduler(
      async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active -= 1;
      },
      { intervalMs: 1000 },
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3000); // 3 interval boundaries, first still in flight
    expect(maxConcurrent).toBe(1);
    release();
    scheduler.stop();
  });

  it('routes tick errors to onError instead of throwing', async () => {
    const onError = vi.fn();
    const scheduler = new BillingCycleScheduler(() => Promise.reject(new Error('boom')), {
      intervalMs: 1000,
      onError,
    });
    const ran = await scheduler.tick();
    expect(ran).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('stop() is idempotent and start() does not double-schedule', async () => {
    let ticks = 0;
    const scheduler = new BillingCycleScheduler(
      () => {
        ticks += 1;
        return Promise.resolve();
      },
      { intervalMs: 1000 },
    );
    scheduler.start();
    scheduler.start(); // no-op
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    scheduler.stop(); // no-op
    expect(ticks).toBe(1);
  });
});
