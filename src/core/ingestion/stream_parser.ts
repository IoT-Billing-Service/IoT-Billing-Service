import { Buffer } from 'node:buffer';

const HEADER_SIZE = 8;
const METRICS_ENTRY_SIZE = 12;

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
 * Helper to generate a sliding window ACK message for WebSocket clients.
 */
export const AckProtocol = {
  createAckMessage(sequence: number): string {
    return JSON.stringify({ type: 'ack', seq: sequence });
  }
};
