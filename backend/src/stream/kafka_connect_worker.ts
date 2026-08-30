/**
 * Kafka Connect Sink worker for blockchain event streaming (issue #291).
 *
 * Long-running process that acts as the platform's Kafka Connect runtime for
 * the blockchain event sink. It:
 *
 * 1. Reads the connector config from env (`backend/src/config/env.ts`), when
 *    `KAFKA_CONNECT_SINK_ENABLED=true`.
 * 2. Starts a {@link BlockchainEventSinkTask} backed by the durable Redis
 *    Streams ledger bus (`billing:events`) — the same bus the billing
 *    consumers already watch.
 * 3. Consumes blockchain event envelopes from a Kafka topic (KafkaJS), batches
 *    them into the task's `put()`, then flushes and commits the consumer-group
 *    offset (at-least-once delivery: a crash replays uncommitted records, which
 *    are idempotent because a `LedgerEvent` with the same `sequence` replaces -
 *    not duplicates - the ledger entry upstream).
 *
 * Deployment: see `k8s/kafka-connect-sink-deployment.yaml`. Start as
 * `node dist/stream/kafka_connect_worker.js`.
 */

import {
  Kafka,
  type Consumer,
  type ConsumerConfig,
  type EachBatchPayload,
  type KafkaConfig,
} from 'kafkajs';
import { getEnv } from '../config/env.js';
import { LedgerEventBus, LEDGER_STREAM_KEY } from '../core/blockchain/ledger_event_bus.js';
import { BlockchainEventSinkTask } from './kafka_connect/sink_task.js';
import type { SinkRecord, LedgerSinkTarget, LedgerEvent } from './kafka_connect/types.js';
import { BlockchainEventSinkConnector } from './kafka_connect/connector.js';
import { setKafkaConnectBacklog } from '../api/metrics/prometheus.js';

/** Adapter that lets the durable Redis Streams event bus serve as a sink target. */
class LedgerBusSink implements LedgerSinkTarget {
  readonly bus: LedgerEventBus;
  constructor(bus: LedgerEventBus) {
    this.bus = bus;
  }
  async publish(event: LedgerEvent): Promise<string> {
    return this.bus.publish(event);
  }
}

function buildKafkaConfig(env: ReturnType<typeof getEnv>): KafkaConfig {
  const config: KafkaConfig = {
    clientId: env.KAFKA_CLIENT_ID,
    brokers: env.KAFKA_BROKERS.split(',')
      .map((b) => b.trim())
      .filter(Boolean),
    ssl: env.KAFKA_SSL || undefined,
  };
  if (env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD) {
    config.sasl = {
      mechanism: 'scram-sha-256',
      username: env.KAFKA_SASL_USERNAME,
      password: env.KAFKA_SASL_PASSWORD,
    };
  }
  return config;
}

function kafkaJsMessageToSinkRecord(
  topic: string,
  partition: number,
  message: {
    key?: Buffer | null;
    value?: Buffer | null;
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
    timestamp?: string;
    offset: string;
  },
): SinkRecord {
  const headers = Object.entries(message.headers ?? {}).map(([key, value]) => {
    const single = Array.isArray(value) ? value[0] : value;
    return { key, value: single ?? null };
  });
  return {
    topic,
    partition,
    offset: BigInt(message.offset),
    key: message.key ?? null,
    value: message.value ? message.value : null,
    headers,
    timestamp: message.timestamp,
  };
}

export interface WorkerOptions {
  /** Override env-derived Kafka consumer config (tests). */
  consumerOverrides?: Partial<ConsumerConfig>;
  /** Allow callers to supply an existing consumer instead of connecting one. */
  consumer?: Consumer;
  /** Sink target override (tests). Defaults to the Redis Streams ledger bus. */
  sink?: LedgerBusSink | LedgerSinkTarget;
}

/** Runtime wiring for the Kafka Connect sink worker. */
export class KafkaConnectSinkWorker {
  private readonly consumer: Consumer;
  private readonly task: BlockchainEventSinkTask;
  private readonly _topic: string;
  private _stopped = false;

  constructor(options: WorkerOptions = {}) {
    const env = getEnv();
    this._topic = env.KAFKA_BLOCKCHAIN_EVENTS_TOPIC;

    // Durable sink target.
    const sink: LedgerSinkTarget = options.sink ?? new LedgerBusSink(new LedgerEventBus());
    this.task = new BlockchainEventSinkTask({
      target: sink,
      taskId: env.KAFKA_CONNECT_SINK_TASK_ID,
      verifyPublicKeyPem: env.KAFKA_CONNECT_VERIFY_PUBLIC_KEY || undefined,
    });

    this.consumer =
      options.consumer ??
      createConsumer(buildKafkaConfig(env), {
        groupId: env.KAFKA_GROUP_ID,
        ...options.consumerOverrides,
      });
  }

  get taskId(): string {
    return this.task.taskId;
  }

  /** Kafka topic the worker subscribes to. */
  get topicKey(): string {
    return this._topic;
  }

  /** Connect, subscribe, and begin consuming. Resolves once running. */
  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this._topic, fromBeginning: false });
    await this.consumer.run({
      autoCommit: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat }: EachBatchPayload) => {
        const messages = batch.messages ?? [];
        if (messages.length === 0) return;
        const records = messages.map((m) =>
          kafkaJsMessageToSinkRecord(batch.topic, batch.partition, m),
        );
        setKafkaConnectBacklog(String(batch.partition), records.length);
        await this.task.put(records);
        await this.task.flush();
        // Commit offsets so a crash replays exactly the uncommitted window
        // (at-least-once; a replay is safe because publishing a ledger event
        // with the same `sequence` is idempotent for the ledger continuity
        // invariant).
        for (const message of messages) {
          // resolveOffset() records the position for a future commit.
          resolveOffset(message.offset);
        }
        await this.consumer.commitOffsets([
          {
            topic: batch.topic,
            partition: batch.partition,
            offset: messages[messages.length - 1].offset,
          },
        ]);
        setKafkaConnectBacklog(String(batch.partition), 0);
        await heartbeat();
      },
    });
  }

  /** Stop consuming and release the consumer. Idempotent. */
  async stop(): Promise<void> {
    if (this._stopped) return;
    this._stopped = true;
    await this.task.flush();
    await this.task.stop();
    await this.consumer.disconnect().catch(() => undefined);
  }
}

function createConsumer(kafkaConfig: KafkaConfig, consumerConfig: ConsumerConfig): Consumer {
  return new Kafka(kafkaConfig).consumer(consumerConfig);
}

/** Validate connector config and construct a worker. Throws {@link ConfigException}. */
export function buildSinkWorker(): KafkaConnectSinkWorker {
  const env = getEnv();
  const connector = new BlockchainEventSinkConnector();
  connector.start({
    brokers: env.KAFKA_BROKERS,
    clientId: env.KAFKA_CLIENT_ID,
    groupId: env.KAFKA_GROUP_ID,
    topic: env.KAFKA_BLOCKCHAIN_EVENTS_TOPIC,
    'verify-public-key': env.KAFKA_CONNECT_VERIFY_PUBLIC_KEY || undefined,
  });
  return new KafkaConnectSinkWorker();
}

/**
 * Process entrypoint. Reads env; exits cleanly when the sink is disabled so
 * the process can be used as a no-op container default. Returns the worker
 * (for tests) and never resolves, keeping the process alive until a signal.
 */
export async function main(): Promise<KafkaConnectSinkWorker> {
  const env = getEnv();
  if (!env.KAFKA_CONNECT_SINK_ENABLED) {
    console.warn('[kafka-connect-sink] disabled (KAFKA_CONNECT_SINK_ENABLED=false), exiting');
    process.exitCode = 0;
    const worker = new KafkaConnectSinkWorker();
    return worker;
  }

  const worker = buildSinkWorker();

  const shutdown = (signal: string) => {
    console.log(`[kafka-connect-sink] received ${signal}, shutting down`);
    void worker.stop().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.start();
  console.log(
    `[kafka-connect-sink] running: topic=${getEnv().KAFKA_BLOCKCHAIN_EVENTS_TOPIC} ` +
      `group=${getEnv().KAFKA_GROUP_ID} stream=${LEDGER_STREAM_KEY}`,
  );
  return worker;
}

// Only start automatically when run directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined && /kafka_connect_worker(\.js|\.ts)$/.test(process.argv[1]);
if (isMain) {
  void main().catch((err: unknown) => {
    console.error('[kafka-connect-sink] fatal', String(err));
    process.exit(1);
  });
}
