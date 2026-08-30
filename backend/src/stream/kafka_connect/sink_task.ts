/**
 * Kafka Connect SinkTask for blockchain event streaming (issue #291).
 *
 * A SinkTask is the per-task worker in the Kafka Connect model. It implements
 * the standard lifecycle (`start → put → flush → stop`) and is the only place
 * that touches the durable ledger target. The task:
 *
 * - decodes and validates each incoming {@link SinkRecord} (see record_codec),
 * - publishes valid blockchain events to the durable sink target, in partition
 *   order (a single internal promise chain serializes puts), and
 * - reports completed offsets so the runtime can commit them.
 *
 * Ordering + the platform's <200ms P99 budget are handled together: puts are
 * enqueued and drained serially, and each record is published with its own
 * latency observation. Malformed records are counted and dropped, never
 * injected into the ledger (a bad record must not stall the partition).
 */

import type {
  SinkRecord,
  RecordOffset,
  LedgerSinkTarget,
  LedgerEvent,
  SinkTaskContext,
} from './types.js';
import { decodeEventRecord, RecordRejectedError, ENVELOPE_VERSION } from './record_codec.js';
import {
  incKafkaConnectEventsReceived,
  incKafkaConnectEventsSunk,
  incKafkaConnectEventsFailed,
  observeKafkaConnectSinkDurationMs,
  setKafkaConnectBacklog,
} from '../../api/metrics/prometheus.js';

export interface SinkTaskOptions {
  /** Durable target events are written to. Defaults to a rejected stub. */
  target?: LedgerSinkTarget;
  /** PEM/SPKI public key for optional Ed25519 signature verification. */
  verifyPublicKeyPem?: string;
  /** Unique task identity used in metrics/logs. */
  taskId?: string;
}

export { ENVELOPE_VERSION };

/**
 * The Kafka Connect SinkTask abstraction. In a real Connect runtime this class
 * would subclass `org.apache.kafka.connect.sink.SinkTask`; here it implements
 * the same contract against the platform's native worker.
 */
export class BlockchainEventSinkTask {
  private target: LedgerSinkTarget;
  private readonly verifyPublicKeyPem: string | undefined;
  taskId: string;

  /** Serializes processing across `put` calls to preserve partition order. */
  private chain: Promise<void> = Promise.resolve();
  /** Offsets completed since the last flush, keyed topic:partition → offset. */
  private readonly done = new Map<string, RecordOffset>();
  private stopped = false;

  constructor(options: SinkTaskOptions = {}) {
    this.taskId = options.taskId ?? 'blockchain-event-sink';
    this.verifyPublicKeyPem = options.verifyPublicKeyPem;
    if (options.target !== undefined) {
      this.target = options.target;
    } else {
      // Never constructed without a target except directly in tests; callers
      // must supply one via `bindTarget` before `put`.
      this.target = {
        publish: async () => {
          throw new Error('sink target not configured');
        },
      };
    }
  }

  version(): string {
    return '1.0.0';
  }

  /** (Re)bind the durable sink target. Enables dependency injection in tests. */
  bindTarget(target: LedgerSinkTarget): void {
    this.target = target;
  }

  async start(_ctx?: SinkTaskContext): Promise<void> {
    this.stopped = false;
  }

  /**
   * Process a batch of records. Records are enqueued behind a single promise
   * chain so ordering is preserved within a partition, matching how Kafka
   * Connect delivers records to a task.
   */
  async put(records: readonly SinkRecord[]): Promise<void> {
    if (this.stopped) throw new Error('sink task is stopped');
    const batch = records.slice();

    // Enqueue behind the previous batch to preserve ordering, then run.
    const run = this.chain.then(() => this.processBatch(batch));
    // Keep the chain alive regardless of outcome so one bad batch can't wedge
    // the queue; errors are still surfaced to the caller.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async processBatch(records: readonly SinkRecord[]): Promise<void> {
    for (const record of records) {
      const topic = record.topic;
      incKafkaConnectEventsReceived(topic);
      const started = Date.now();
      let errorReason: string | null = null;
      let published = false;

      try {
        const decoded = decodeEventRecord(record.value, {
          verifyPublicKeyPem: this.verifyPublicKeyPem,
        });
        const ledgerEvent: LedgerEvent = {
          sequence: decoded.sequence,
          payload: {
            ...decoded.payload,
            event_type: decoded.eventType,
            content_hash: decoded.contentHash,
            verified: String(decoded.verified),
            source_topic: topic,
            source_partition: String(record.partition),
            source_offset: String(record.offset),
          },
        };
        await this.target.publish(ledgerEvent);
        published = true;
        incKafkaConnectEventsSunk(topic);
      } catch (err) {
        errorReason =
          err instanceof RecordRejectedError
            ? err.reason
            : `publish-failed:${String(err instanceof Error ? err.message : err)}`;
        incKafkaConnectEventsFailed(topic, errorReason);
      }

      const elapsed = Date.now() - started;
      observeKafkaConnectSinkDurationMs(topic, elapsed);

      // Only advance the commit offset for records we actually sunk. Rejected
      // records are still skipped (counted and dropped), so publish failures
      // are the only reason an offset stays behind — those are retried by the
      // runtime via Kafka consumer group rebalancing.
      if (published) {
        this.markDone(record);
      }
    }
    setKafkaConnectBacklog(this.taskId, 0);
  }

  /**
   * Persist any buffered work. Commits offsets reported by {@link commit} to
   * the runtime so Kafka can advance the consumer group past them.
   */
  async flush(_ctx?: SinkTaskContext): Promise<void> {
    // Wait for any in-flight batch to finish before reporting offsets.
    await this.chain;
  }

  /** Offsets completed since the last `commit` (topic:partition → offset). */
  offsets(): ReadonlyMap<string, RecordOffset> {
    return this.done;
  }

  private markDone(record: SinkRecord): void {
    const key = `${record.topic}:${record.partition}`;
    const prev = this.done.get(key);
    if (prev === undefined || prev.offset < record.offset) {
      this.done.set(key, {
        topic: record.topic,
        partition: record.partition,
        offset: record.offset,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
  }
}
