import { BackpressureController } from './backpressure.js';

export enum IngestionState {
  PENDING = 'PENDING',
  TENTATIVE = 'TENTATIVE',
  SETTLED = 'SETTLED',
  ROLLED_BACK = 'ROLLED_BACK',
  RECONCILING = 'RECONCILING',
  FAILED = 'FAILED',
  GAP_DETECTED = 'GAP_DETECTED',
}

export interface StateTransition {
  from: IngestionState;
  to: IngestionState;
  timestamp: number;
  reason: string;
}

const VALID_TRANSITIONS: Record<IngestionState, IngestionState[]> = {
  [IngestionState.PENDING]: [
    IngestionState.TENTATIVE,
    IngestionState.FAILED,
    IngestionState.GAP_DETECTED,
  ],
  [IngestionState.TENTATIVE]: [
    IngestionState.SETTLED,
    IngestionState.ROLLED_BACK,
    IngestionState.FAILED,
    IngestionState.GAP_DETECTED,
  ],
  [IngestionState.SETTLED]: [],
  [IngestionState.ROLLED_BACK]: [IngestionState.RECONCILING],
  [IngestionState.RECONCILING]: [IngestionState.PENDING, IngestionState.FAILED],
  [IngestionState.FAILED]: [],
  [IngestionState.GAP_DETECTED]: [IngestionState.PENDING, IngestionState.FAILED],
};

const AUTO_RESYNC_TIMEOUT = 60000;
export const TOTAL_CONNECTION_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENT_CONNECTIONS = 1000;
export const PER_CONNECTION_MEMORY_BUDGET_BYTES =
  TOTAL_CONNECTION_MEMORY_BUDGET_BYTES / MAX_CONCURRENT_CONNECTIONS;

export interface ConnectionBudgetOptions {
  totalMemoryBudgetBytes?: number;
  maxConnections?: number;
  backpressure?: BackpressureController;
}

export class ConnectionBudgetTracker {
  private readonly perConnectionBudgetBytes: number;
  private readonly backpressure?: BackpressureController;
  private readonly bufferBytesByConnection = new Map<string, number>();

  constructor(options: ConnectionBudgetOptions = {}) {
    const totalMemoryBudgetBytes =
      options.totalMemoryBudgetBytes ?? TOTAL_CONNECTION_MEMORY_BUDGET_BYTES;
    const maxConnections = options.maxConnections ?? MAX_CONCURRENT_CONNECTIONS;
    this.perConnectionBudgetBytes = Math.floor(totalMemoryBudgetBytes / maxConnections);
    this.backpressure = options.backpressure;
  }

  updateConnectionBuffer(connectionId: string, bufferBytes: number): boolean {
    this.bufferBytesByConnection.set(connectionId, bufferBytes);
    if (bufferBytes > this.perConnectionBudgetBytes) {
      this.backpressure?.shedConnection(connectionId);
      return false;
    }
    return true;
  }

  releaseConnection(connectionId: string): void {
    this.bufferBytesByConnection.delete(connectionId);
  }

  getConnectionBufferBytes(connectionId: string): number {
    return this.bufferBytesByConnection.get(connectionId) ?? 0;
  }

  getTotalBufferBytes(): number {
    let total = 0;
    for (const bytes of this.bufferBytesByConnection.values()) {
      total += bytes;
    }
    return total;
  }

  getPerConnectionBudgetBytes(): number {
    return this.perConnectionBudgetBytes;
  }
}

export class IngestionStateMachine {
  private state: IngestionState;
  private history: StateTransition[] = [];
  private deviceId: string;
  private resyncTimer?: ReturnType<typeof setTimeout>;

  constructor(deviceId: string, initialState: IngestionState = IngestionState.PENDING) {
    this.deviceId = deviceId;
    this.state = initialState;

    if (this.state === IngestionState.GAP_DETECTED) {
      this.startResyncTimer();
    }
  }

  transition(to: IngestionState, reason: string): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      return false;
    }

    if (this.state === IngestionState.GAP_DETECTED && to !== IngestionState.GAP_DETECTED) {
      this.clearResyncTimer();
    }

    this.history.push({
      from: this.state,
      to,
      timestamp: Date.now(),
      reason,
    });
    this.state = to;

    if (this.state === IngestionState.GAP_DETECTED) {
      this.startResyncTimer();
    }
    return true;
  }

  private startResyncTimer(): void {
    this.clearResyncTimer();
    this.resyncTimer = setTimeout(() => {
      this.triggerAutoResync();
    }, AUTO_RESYNC_TIMEOUT);
    // don't hold the event loop
    this.resyncTimer.unref();
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== undefined) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  private triggerAutoResync(): void {
    // In a real environment, this might trigger a local event or a service call.
    // As instructed by the blueprint, it triggers POST /api/v1/device/{device_id}/resync
    // Since we are inside the core, we can use a fetch call to localhost, or emit an event.
    // Using fetch to standard API port (assuming 3000 locally, but realistically we would
    // mock this in testing. We'll use a globally defined fetch to avoid hard-coupling).
    fetch(`http://localhost:3000/api/v1/device/${this.deviceId}/resync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'auto_resync_timeout' }),
    }).catch((err: unknown) => {
      console.error(`Failed to trigger auto-resync for ${this.deviceId}:`, err);
    });
  }

  dispose(): void {
    this.clearResyncTimer();
  }

  getState(): IngestionState {
    return this.state;
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  canTransitionTo(state: IngestionState): boolean {
    return VALID_TRANSITIONS[this.state].includes(state);
  }
}
