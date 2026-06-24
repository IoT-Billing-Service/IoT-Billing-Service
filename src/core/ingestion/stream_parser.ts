import { Buffer } from 'node:buffer';

const HEADER_SIZE = 8;
const METRICS_ENTRY_SIZE = 12;
export const MAX_PARTIAL_MESSAGE_SIZE = 64 * 1024;
export const MESSAGE_TIMEOUT_MS = 30_000;
export const MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const TELEMETRY_MESSAGE_TERMINATOR = 0x00;

export interface ProtocolViolationEvent {
  connectionId: string;
  deviceId: string;
  reason: 'partial_message_too_large' | 'partial_message_timeout';
  bufferBytes: number;
  chunkBytes?: number;
  limitBytes: number;
}

export interface FragmentReassemblyResult {
  messages: Buffer[];
  closed: boolean;
  closeCode?: number;
  violation?: ProtocolViolationEvent;
}

export interface FragmentReassemblerOptions {
  connectionId: string;
  deviceId: string;
  maxPartialMessageSize?: number;
  messageTimeoutMs?: number;
  onProtocolViolation?: (event: ProtocolViolationEvent) => void;
  onClose?: (code: number, reason: string) => void;
  onBufferSizeChange?: (deviceId: string, bytes: number) => void;
}

export interface ParsedMetric {
  metricId: number;
  value: number;
}

export interface ParsedTelemetryFrame {
  deviceId: string;
  sequenceNumber: number;
  timestamp: number;
  metrics: ParsedMetric[];
}

export class TelemetryStreamParser {
  private buffer: Buffer;
  private offset: number;

  constructor(data: Buffer) {
    this.buffer = data;
    this.offset = 0;
  }

  parseFrame(): ParsedTelemetryFrame | null {
    if (this.offset + HEADER_SIZE > this.buffer.length) return null;

    const deviceIdLen = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    const deviceId = this.buffer.toString('utf-8', this.offset, this.offset + deviceIdLen);
    this.offset += deviceIdLen;

    const sequenceNumber = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    const timestamp = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;

    const metricsCount = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;

    const metrics: ParsedMetric[] = [];
    for (let i = 0; i < metricsCount; i++) {
      if (this.offset + METRICS_ENTRY_SIZE > this.buffer.length) break;
      const metricId = this.buffer.readUInt16BE(this.offset);
      this.offset += 2;
      const value = this.buffer.readDoubleBE(this.offset);
      this.offset += 8;
      metrics.push({ metricId, value });
    }

    return { deviceId, sequenceNumber, timestamp, metrics };
  }

  hasMore(): boolean {
    return this.offset < this.buffer.length;
  }

  reset(): void {
    this.offset = 0;
  }
}

/**
 * Reassembles MTU-sized WebSocket fragments into null-terminated telemetry
 * messages while enforcing a hard per-device memory ceiling.
 */
export class TelemetryFragmentReassembler {
  private readonly connectionId: string;
  private readonly deviceId: string;
  private readonly maxPartialMessageSize: number;
  private readonly messageTimeoutMs: number;
  private readonly onProtocolViolation?: (event: ProtocolViolationEvent) => void;
  private readonly onClose?: (code: number, reason: string) => void;
  private readonly onBufferSizeChange?: (deviceId: string, bytes: number) => void;
  private buffer = Buffer.alloc(0);
  private timeoutHandle?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: FragmentReassemblerOptions) {
    this.connectionId = options.connectionId;
    this.deviceId = options.deviceId;
    this.maxPartialMessageSize = options.maxPartialMessageSize ?? MAX_PARTIAL_MESSAGE_SIZE;
    this.messageTimeoutMs = options.messageTimeoutMs ?? MESSAGE_TIMEOUT_MS;
    this.onProtocolViolation = options.onProtocolViolation;
    this.onClose = options.onClose;
    this.onBufferSizeChange = options.onBufferSizeChange;
  }

  append(chunk: Buffer): FragmentReassemblyResult {
    if (this.closed) {
      return { messages: [], closed: true, closeCode: MESSAGE_TOO_BIG_CLOSE_CODE };
    }

    if (this.buffer.length + chunk.length > this.maxPartialMessageSize) {
      const violation = this.resetForViolation('partial_message_too_large', chunk.length);
      this.closed = true;
      this.onClose?.(MESSAGE_TOO_BIG_CLOSE_CODE, 'Telemetry partial message exceeded 64KB');
      return {
        messages: [],
        closed: true,
        closeCode: MESSAGE_TOO_BIG_CLOSE_CODE,
        violation,
      };
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.publishBufferSize();
    this.armTimeoutIfNeeded();

    const messages: Buffer[] = [];
    let terminatorIndex = this.buffer.indexOf(TELEMETRY_MESSAGE_TERMINATOR);
    while (terminatorIndex !== -1) {
      messages.push(this.buffer.subarray(0, terminatorIndex));
      this.buffer = this.buffer.subarray(terminatorIndex + 1);
      terminatorIndex = this.buffer.indexOf(TELEMETRY_MESSAGE_TERMINATOR);
    }

    this.publishBufferSize();
    if (this.buffer.length === 0) {
      this.clearTimeout();
    } else {
      this.armTimeoutIfNeeded();
    }

    return { messages, closed: false };
  }

  getBufferedBytes(): number {
    return this.buffer.length;
  }

  dispose(): void {
    this.clearTimeout();
    this.buffer = Buffer.alloc(0);
    this.publishBufferSize();
  }

  private armTimeoutIfNeeded(): void {
    if (this.buffer.length === 0 || this.timeoutHandle !== undefined) return;

    this.timeoutHandle = setTimeout(() => {
      this.resetForViolation('partial_message_timeout');
    }, this.messageTimeoutMs);
    this.timeoutHandle.unref();
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== undefined) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private resetForViolation(
    reason: ProtocolViolationEvent['reason'],
    chunkBytes?: number,
  ): ProtocolViolationEvent {
    const event: ProtocolViolationEvent = {
      connectionId: this.connectionId,
      deviceId: this.deviceId,
      reason,
      bufferBytes: this.buffer.length,
      chunkBytes,
      limitBytes: this.maxPartialMessageSize,
    };
    this.clearTimeout();
    this.buffer = Buffer.alloc(0);
    this.publishBufferSize();
    this.onProtocolViolation?.(event);
    console.warn('ProtocolViolation', event);
    return event;
  }

  private publishBufferSize(): void {
    this.onBufferSizeChange?.(this.deviceId, this.buffer.length);
  }
}

/**
 * Helper to generate a sliding window ACK message for WebSocket clients.
 */
export const AckProtocol = {
  createAckMessage(sequence: number): string {
    return JSON.stringify({ type: 'ack', seq: sequence });
  },
};
