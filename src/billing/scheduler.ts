/**
 * Periodic billing-cycle finalization trigger (issue #42).
 *
 * One of the two finalization paths (the other being event-driven WebSocket
 * ingestion). Runs `onTick` every `intervalMs` (default 60s). Because
 * finalization itself is race-safe ({@link ./finalizer.finalizeBillingCycle}),
 * an overlap between this scheduler and the event path cannot double-finalize a
 * cycle — the scheduler does not need its own cross-pod lock.
 *
 * Implemented with `setInterval` (unref'd, so it never keeps the process alive)
 * rather than pulling in a `node-cron` dependency; swap in node-cron if a cron
 * expression is ever needed. Overlapping ticks are suppressed: if a tick is
 * still running when the next fires, the next is skipped.
 */
export interface BillingCycleSchedulerOptions {
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class BillingCycleScheduler {
  private readonly intervalMs: number;
  private readonly onTick: () => Promise<void>;
  private readonly onError: (err: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(onTick: () => Promise<void>, options: BillingCycleSchedulerOptions = {}) {
    this.onTick = onTick;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onError =
      options.onError ??
      ((err): void => {
        console.error('[billing-scheduler] tick failed:', err);
      });
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one tick now. Returns whether it actually ran (`false` if a previous
   * tick was still in flight). Exposed for tests and manual triggering.
   */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.onTick();
    } catch (err) {
      this.onError(err);
    } finally {
      this.running = false;
    }
    return true;
  }
}
