/**
 * Core types for the Kafka Connect Sink (issue #291).
 *
 * This module mirrors the small slice of the Apache Kafka Connect Sink API
 * that this platform relies on, expressed in TypeScript. Kafka Connect Sink
 * connectors follow a fixed lifecycle:
 *
 *   Connector.start(config) → taskConfigs() → SinkTask.start(ctx)
 *   → put(Collection<SinkRecord>) → flush(offsets) → stop()
 *
 * The Kafka Connect runtime owns task placement and offset commit; a SinkTask
 * only ever *receives* records and reports processed offsets. We reproduce
 * that contract here so the blockchain event sink can be ported to a real
 * Connect runtime unchanged, while remaining runnable on the platform's native
 * worker (see {@link ../kafka_connect_worker.ts}).
 */

/** A Kafka message that has been delivered to the sink, after KafkaJS mapping. */
export interface SinkRecord {
  /** Topic the record was read from. */
  readonly topic: string;
  /** Partition the record was read from. */
  readonly partition: number;
  /** Absolute offset of the record within its partition. */
  readonly offset: bigint;
  /** Optional record key (bytes). */
  readonly key?: Buffer | string | null;
  /** The record value (bytes). For blockchain events this is a JSON envelope. */
  readonly value?: Buffer | string | null;
  /** Record headers, if any. */
  readonly headers: ReadonlyArray<{ key: string; value: Buffer | string | null }>;
  /** Producer timestamp if present (ms since Unix epoch). */
  readonly timestamp?: string | number | null;
}

/**
 * A topic-partition-offset gauge that the task reports as it completes work.
 * The runtime uses this to drive manual offset commits (at-least-once semantics).
 */
export interface RecordOffset {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
}

/** Streamable byte-like value (what the codec accepts). */
export type ByteInput = Buffer | string | null | undefined;

/**
 * The durable sink target a task writes blockchain events to. The platform's
 * canonical choice is the Redis Streams ledger bus (`LedgerEventBus`), but the
 * sink only depends on `publish`, so an in-memory fake can drive tests without
 * a broker.
 */
export interface LedgerSinkTarget {
  publish(event: LedgerEvent): Promise<string>;
}

/** A blockchain ledger event as accepted by the sink target (see {@link LedgerEventBus}). */
export interface LedgerEvent {
  /** Monotonic ledger sequence number (continuity invariant: last_seq + 1). */
  sequence: number;
  /** String-keyed payload (Redis Stream fields are string-typed). */
  payload: Record<string, string>;
}

/** Lifecycle/processing context handed to a {@link SinkTask}. */
export interface SinkTaskContext {
  /** Human-readable task id (e.g. `host:partition`), used in metrics. */
  readonly taskId: string;
  /** Commits offsets to the consumer group for already-sunk records. */
  readonly commitOffset: (offsets: RecordOffset) => Promise<void>;
}
