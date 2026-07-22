import {
  createHash,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

/** The only signature algorithm accepted for runtime configuration approvals. */
export const RUNTIME_CONFIG_SIGNATURE_ALGORITHM = 'ed25519' as const;

export interface SignedRuntimeConfiguration<T> {
  keyId: string;
  versionId: string;
  issuedAt: string;
  payload: T;
  signature: string;
  algorithm: typeof RUNTIME_CONFIG_SIGNATURE_ALGORITHM;
}

export type RuntimeConfigurationStatus = 'healthy' | 'drifted' | 'unverified';

export interface RuntimeConfigurationAuditEvent {
  event: 'runtime_config_activated' | 'runtime_config_drift_detected' | 'runtime_config_rejected';
  timestamp: string;
  versionId?: string;
  expectedHash?: string;
  observedHash?: string;
  reason?: string;
}

export interface RuntimeConfigurationAuditorOptions<T> {
  /** Returns the configuration object actually used by the runtime. */
  readActiveConfiguration: () => T;
  /** Authorized Ed25519 public keys, indexed by non-secret key id. */
  authorizedKeys: ReadonlyMap<string, KeyObject | string | Buffer>;
  /** Structured, append-only audit sink. It must not throw or block billing. */
  auditSink?: (event: RuntimeConfigurationAuditEvent) => void;
}

export class RuntimeConfigurationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigurationIntegrityError';
  }
}

/**
 * Canonically serialize JSON-compatible configuration data before hashing or
 * signing. This prevents semantically identical key ordering from producing a
 * different baseline hash. Undefined values are rejected deliberately: config
 * contracts must be explicit and portable across runtimes.
 */
export function canonicalizeConfiguration(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Configuration numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeConfiguration).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const child = record[key];
        if (child === undefined) throw new TypeError(`Configuration field ${key} is undefined`);
        return `${JSON.stringify(key)}:${canonicalizeConfiguration(child)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported configuration value type: ${typeof value}`);
}

export function configurationHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeConfiguration(value)).digest('hex');
}

function signedBytes<T>(envelope: SignedRuntimeConfiguration<T>): Buffer {
  return Buffer.from(
    canonicalizeConfiguration({
      algorithm: envelope.algorithm,
      issuedAt: envelope.issuedAt,
      keyId: envelope.keyId,
      payload: envelope.payload,
      versionId: envelope.versionId,
    }),
    'utf8',
  );
}

/**
 * Holds an in-memory, signed baseline and performs constant-time hash
 * comparisons on the billing path. Signature verification happens only when a
 * new configuration is proposed; periodic scanning is optional and off-path.
 */
export class RuntimeConfigurationAuditor<T> {
  private readonly readActiveConfiguration: () => T;
  private readonly authorizedKeys: ReadonlyMap<string, KeyObject | string | Buffer>;
  private readonly auditSink: (event: RuntimeConfigurationAuditEvent) => void;
  private baselineHash: Buffer | null = null;
  private baselineVersionId: string | null = null;
  private status: RuntimeConfigurationStatus = 'unverified';
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RuntimeConfigurationAuditorOptions<T>) {
    this.readActiveConfiguration = options.readActiveConfiguration;
    this.authorizedKeys = options.authorizedKeys;
    this.auditSink =
      options.auditSink ??
      ((event: RuntimeConfigurationAuditEvent): void => {
        console.info(JSON.stringify(event));
      });
  }

  activate(envelope: SignedRuntimeConfiguration<T>): void {
    const key = this.authorizedKeys.get(envelope.keyId);
    if (key === undefined) this.reject(envelope.versionId, 'unknown configuration signing key');
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64 || !verifySignature(null, signedBytes(envelope), key, signature)) {
      this.reject(envelope.versionId, 'invalid configuration signature');
    }

    this.baselineHash = Buffer.from(configurationHash(envelope.payload), 'hex');
    this.baselineVersionId = envelope.versionId;
    this.status = 'healthy';
    this.auditSink({
      event: 'runtime_config_activated',
      timestamp: new Date().toISOString(),
      versionId: envelope.versionId,
      expectedHash: this.baselineHash.toString('hex'),
    });
  }

  /** A synchronous, allocation-light integrity check for billing operations. */
  assertTrusted(): void {
    if (this.status !== 'healthy' || this.baselineHash === null) {
      throw new RuntimeConfigurationIntegrityError(
        'Billing blocked: runtime configuration is not verified',
      );
    }
    const observedHash = Buffer.from(configurationHash(this.readActiveConfiguration()), 'hex');
    if (
      observedHash.length !== this.baselineHash.length ||
      !timingSafeEqual(observedHash, this.baselineHash)
    ) {
      this.markDrift(observedHash.toString('hex'));
      throw new RuntimeConfigurationIntegrityError(
        'Billing blocked: runtime configuration drift detected',
      );
    }
  }

  /** Scan asynchronously; useful for alerting before the next billing request. */
  scan(): RuntimeConfigurationStatus {
    try {
      this.assertTrusted();
    } catch (error) {
      if (!(error instanceof RuntimeConfigurationIntegrityError)) throw error;
    }
    return this.status;
  }

  start(intervalMs = 1_000): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = setInterval(() => this.scan(), intervalMs);
    this.scanTimer.unref();
  }

  stop(): void {
    if (this.scanTimer !== null) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  getStatus(): { status: RuntimeConfigurationStatus; versionId: string | null } {
    return { status: this.status, versionId: this.baselineVersionId };
  }

  private reject(versionId: string, reason: string): never {
    this.auditSink({
      event: 'runtime_config_rejected',
      timestamp: new Date().toISOString(),
      versionId,
      reason,
    });
    throw new RuntimeConfigurationIntegrityError(`Configuration rejected: ${reason}`);
  }

  private markDrift(observedHash: string): void {
    if (this.status === 'drifted') return;
    this.status = 'drifted';
    this.auditSink({
      event: 'runtime_config_drift_detected',
      timestamp: new Date().toISOString(),
      versionId: this.baselineVersionId ?? undefined,
      expectedHash: this.baselineHash?.toString('hex'),
      observedHash,
    });
  }
}
