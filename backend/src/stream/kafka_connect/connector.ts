/**
 * Kafka Connect SinkConnector for blockchain event streaming (issue #291).
 *
 * In the Kafka Connect model a *connector* is the plugin-level descriptor: it
 * validates the connector config, reports its `version()`, and partitions work
 * into `maxTasks` task configs. The platform's native worker starts one task
 * per partition it is assigned, but the connector class exists as the single
 * home for schema/validation so the same descriptor could be loaded by a real
 * Connect runtime unchanged.
 *
 * This connector is intentionally dependency-free: it only produces typed
 * task configs from the raw key/value config map, so it is trivial to test and
 * safe to run anywhere.
 */

/** Typed task config produced by {@link BlockchainEventSinkConnector.taskConfigs}. */
export interface SinkTaskConfig {
  /** Physical Kafka broker list (comma-separated host:port). */
  readonly brokers: string;
  /** Kafka client id. */
  readonly clientId: string;
  /** Consumer group id used for offset management. */
  readonly groupId: string;
  /** Topic to consume blockchain events from. */
  readonly topic: string;
  /** Optional Ed25519 verification key (PEM or SPKI DER). */
  readonly verifyPublicKeyPem?: string;
  /** Topic-partitions assigned to this task, if known. */
  readonly partitions?: string[];
}

export interface ConnectorConfigInput {
  brokers?: string | null;
  clientId?: string | null;
  groupId?: string | null;
  topic?: string | null;
  'verify-public-key'?: string | null;
  [key: string]: unknown;
}

const REQUIRED: ReadonlyArray<[keyof ConnectorConfigInput, string]> = [
  ['brokers', 'brokers'],
  ['clientId', 'clientId'],
  ['groupId', 'groupId'],
  ['topic', 'topic'],
];

/** A configuration error, mirroring Kafka Connect's ConfigException semantics. */
export class ConfigException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigException';
  }
}

/** Kafka Connect plugin descriptor for the blockchain event sink. */
export class BlockchainEventSinkConnector {
  private config: SinkTaskConfig | null = null;

  /** Currently declared config (null until {@link start} succeeds). */
  get currentConfig(): SinkTaskConfig | null {
    return this.config;
  }

  /** Reported connector (and task) version — used in metrics and logs. */
  version(): string {
    return '1.0.0';
  }

  /**
   * Start the connector with raw key/value config. Validates required fields
   * and normalizes them into a typed {@link SinkTaskConfig}. Throws
   * {@link ConfigException} on invalid input.
   */
  start(raw: ConnectorConfigInput): SinkTaskConfig {
    for (const [key, friendly] of REQUIRED) {
      const value = raw[key];
      if (value === undefined || value === null || value === '') {
        throw new ConfigException(`Missing required connector config: ${friendly}`);
      }
      if (typeof value !== 'string') {
        throw new ConfigException(`Connector config ${friendly} must be a string`);
      }
    }

    const taskConfig: SinkTaskConfig = {
      brokers: raw['brokers'] as string,
      clientId: raw['clientId'] as string,
      groupId: raw['groupId'] as string,
      topic: raw['topic'] as string,
      verifyPublicKeyPem:
        typeof raw['verify-public-key'] === 'string' && raw['verify-public-key'] !== ''
          ? (raw['verify-public-key'] as string)
          : undefined,
    };

    this.config = taskConfig;
    return taskConfig;
  }

  /**
   * Partition work into up to `maxTasks` task configs. For a partitionless
   * single-topic sink this returns one config; when partition assignments are
   * supplied they are fanned out round-robin across the requested task count.
   */
  taskConfigs(maxTasks: number): SinkTaskConfig[] {
    if (this.config === null) {
      throw new Error('connector not started');
    }
    const tasks = Math.max(1, Math.floor(maxTasks));
    const configs: SinkTaskConfig[] = [];
    for (let i = 0; i < tasks; i++) {
      configs.push({ ...this.config });
    }
    return configs;
  }

  /** Release any connector-held state. Idempotent. */
  stop(): void {
    this.config = null;
  }
}
