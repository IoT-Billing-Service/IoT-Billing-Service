import { FrameBudgetMonitor, decimationStride } from '../utils/frameBudget';
import { TelemetryBuffer } from '../components/dashboard/telemetryBuffer';

type WorkerMessage =
  | { type: 'init'; payload: CanvasInitPayload }
  | { type: 'appendBatch'; payload: { values: number[] } }
  | { type: 'draw'; payload: { now: number } }
  | { type: 'resize'; payload: { width: number; height: number; dpr: number } }
  | {
      type: 'updateConfig';
      payload: {
        metric: string;
        color: string;
        isLoading: boolean;
        totalTimeRange?: { start: number; end: number };
        pendingRange?: { start: number; end: number } | null;
      };
    };

interface CanvasInitPayload {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
  metric: string;
  color: string;
  isLoading: boolean;
  totalTimeRange?: { start: number; end: number };
  pendingRange?: { start: number; end: number } | null;
}

const CAPACITY = 10_000;
const FULL_REDRAW_MS = 500;
const RATE_WARN_THRESHOLD = 3_000;

class CanvasRenderWorker {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private metric = 'Telemetry';
  private color = '#5ec962';
  private isLoading = false;
  private totalTimeRange?: { start: number; end: number };
  private pendingRange?: { start: number; end: number } | null = null;
  private readonly buffer = new TelemetryBuffer(CAPACITY);
  private readonly monitor = new FrameBudgetMonitor({
    budgetMs: 1000 / 60,
    pressureThreshold: 0.5,
  });
  private lastFullRedraw = 0;
  private lastStatsSent = 0;
  private pendingMessageCount = 0;
  private hasReportedRateWarning = false;

  private sendReady(): void {
    self.postMessage({ type: 'ready' });
  }

  private sendFrameStats(): void {
    const report = this.monitor.report();
    self.postMessage({
      type: 'frameStats',
      payload: {
        sampleCount: report.sampleCount,
        p95: report.p95,
        overBudgetFrames: report.overBudgetFrames,
        droppedFrames: report.droppedFrames,
      },
    });
  }

  private resize(width: number, height: number, dpr: number): void {
    if (!this.canvas) return;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    if (!this.ctx) return;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clearCanvas(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  private drawLoadingState(): void {
    if (!this.ctx) return;
    this.ctx.fillStyle = '#a0a0a0';
    this.ctx.globalAlpha = 0.65;
    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('Waiting for telemetry…', this.width / 2, this.height / 2);
    this.ctx.globalAlpha = 1;
  }

  private drawPendingOverlay(): void {
    if (!this.ctx || !this.pendingRange || !this.totalTimeRange) return;
    const totalSpan = this.totalTimeRange.end - this.totalTimeRange.start || 1;
    const pendingStartRatio = (this.pendingRange.start - this.totalTimeRange.start) / totalSpan;
    const pendingEndRatio = (this.pendingRange.end - this.totalTimeRange.start) / totalSpan;
    const padding = 20;
    const x = padding + pendingStartRatio * (this.width - 2 * padding);
    const w = Math.max(2, (pendingEndRatio - pendingStartRatio) * (this.width - 2 * padding));

    this.ctx.save();
    this.ctx.fillStyle = '#a0a0a0';
    this.ctx.globalAlpha = 0.15;
    this.ctx.fillRect(x, padding, w, this.height - 2 * padding);
    this.ctx.strokeStyle = '#a0a0a0';
    this.ctx.globalAlpha = 0.4;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.strokeRect(x, padding, w, this.height - 2 * padding);
    this.ctx.setLineDash([]);
    this.ctx.globalAlpha = 1;
    this.ctx.restore();
  }

  private drawFrame(now: number): void {
    if (!this.ctx) return;
    if (!this.canvas) return;

    this.monitor.beginFrame(now);
    this.buffer.swapDisplayBuffer();
    const snapshot = this.buffer.readDisplaySnapshot();
    if (!snapshot.stable) {
      this.monitor.endFrame(performance.now());
      this.pendingMessageCount += 1;
      if (!this.hasReportedRateWarning && this.pendingMessageCount > RATE_WARN_THRESHOLD) {
        self.postMessage({
          type: 'error',
          payload: 'Telemetry worker is falling behind incoming telemetry rate.',
        });
        this.hasReportedRateWarning = true;
      }
      return;
    }

    const count = snapshot.count;
    const start = snapshot.start;
    const values = snapshot.buffer;
    const padding = 20;
    const fullRedraw = now - this.lastFullRedraw >= FULL_REDRAW_MS;
    const widthCap = Math.max(50, Math.floor(this.width));
    const maxPoints = fullRedraw ? widthCap : Math.max(50, Math.floor(widthCap / 2));
    const underPressure = this.monitor.isUnderPressure();
    const effectiveMaxPoints = underPressure ? Math.max(50, Math.floor(maxPoints / 2)) : maxPoints;
    const stride = decimationStride(count, effectiveMaxPoints);

    this.clearCanvas();

    if (count < 2) {
      if (this.isLoading) {
        this.drawLoadingState();
      }
      if (this.pendingRange && this.totalTimeRange) {
        this.drawPendingOverlay();
      }
      this.monitor.endFrame(performance.now());
      if (fullRedraw) {
        this.lastFullRedraw = now;
      }
      if (performance.now() - this.lastStatsSent > 1000) {
        this.sendFrameStats();
        this.lastStatsSent = performance.now();
      }
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++) {
      const value = values[(start + i) % CAPACITY] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    const range = max - min || 1;

    this.ctx.beginPath();
    this.ctx.strokeStyle = this.color;
    this.ctx.lineWidth = 2;

    let firstPoint = true;
    for (let i = 0; i < count; i += stride) {
      const idx = (start + i) % CAPACITY;
      const value = values[idx] ?? 0;
      const x = padding + (i / (count - 1)) * (this.width - 2 * padding);
      const y = this.height - padding - ((value - min) / range) * (this.height - 2 * padding);
      if (firstPoint) {
        this.ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    if (stride > 1 && count > 1) {
      const lastIdx = (start + count - 1) % CAPACITY;
      const lastValue = values[lastIdx] ?? 0;
      const x = padding + ((count - 1) / (count - 1)) * (this.width - 2 * padding);
      const y = this.height - padding - ((lastValue - min) / range) * (this.height - 2 * padding);
      this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();

    if (this.pendingRange && this.totalTimeRange) {
      this.drawPendingOverlay();
    }

    const latestValue = values[(start + count - 1) % CAPACITY] ?? 0;
    this.ctx.fillStyle = this.color;
    this.ctx.font = '12px monospace';
    this.ctx.fillText(`${this.metric}: ${latestValue.toFixed(2)}`, padding, 20);

    if (fullRedraw) {
      this.lastFullRedraw = now;
    }

    const drawMs = this.monitor.endFrame(performance.now());
    if (drawMs > 30) {
      this.ctx.imageSmoothingEnabled = false;
    }

    const nowMs = performance.now();
    if (nowMs - this.lastStatsSent > 1000) {
      this.sendFrameStats();
      this.lastStatsSent = nowMs;
    }
  }

  public handleMessage(event: MessageEvent<WorkerMessage>): void {
    const { type, payload } = event.data;
    switch (type) {
      case 'init': {
        this.canvas = payload.canvas;
        const context = this.canvas.getContext('2d');
        if (!context) {
          self.postMessage({
            type: 'error',
            payload: 'Unable to obtain OffscreenCanvas 2D context.',
          });
          return;
        }
        this.ctx = context;
        this.metric = payload.metric;
        this.color = payload.color;
        this.isLoading = payload.isLoading;
        this.totalTimeRange = payload.totalTimeRange;
        this.pendingRange = payload.pendingRange;
        this.resize(payload.width, payload.height, payload.dpr);
        this.sendReady();
        break;
      }
      case 'appendBatch': {
        if (!Array.isArray(payload.values)) return;
        this.buffer.appendBatch(payload.values);
        break;
      }
      case 'draw': {
        this.drawFrame(payload.now);
        break;
      }
      case 'resize': {
        this.resize(payload.width, payload.height, payload.dpr);
        break;
      }
      case 'updateConfig': {
        this.metric = payload.metric;
        this.color = payload.color;
        this.isLoading = payload.isLoading;
        this.totalTimeRange = payload.totalTimeRange;
        this.pendingRange = payload.pendingRange;
        break;
      }
      default:
        break;
    }
  }
}

const worker = new CanvasRenderWorker();

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  worker.handleMessage(event);
};
