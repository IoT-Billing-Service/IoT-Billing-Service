/**
 * Typed persistence errors for the telemetry ingestion pipeline (issue #292).
 *
 * The retry machinery needs to distinguish permanent failures (retrying can
 * never succeed — e.g. the device no longer exists) from transient failures
 * (retrying may succeed once the underlying condition clears — e.g. a DB
 * connection blip). These classes carry that classification explicitly
 * instead of relying on string matching against error messages.
 */

/** Base class for permanent (non-retryable) ingestion persistence failures. */
export class PermanentIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentIngestionError';
  }
}

/** Thrown when the device serial does not exist in the device registry. */
export class DeviceNotFoundError extends PermanentIngestionError {
  constructor(deviceId: string) {
    super(`Device not found: ${deviceId}`);
    this.name = 'DeviceNotFoundError';
  }
}

/** Thrown when the device exists but is disabled. */
export class DeviceDisabledError extends PermanentIngestionError {
  constructor(deviceId: string) {
    super(`Device disabled: ${deviceId}`);
    this.name = 'DeviceDisabledError';
  }
}

/**
 * Thrown when the digest of a queued ingestion job no longer matches the
 * stored digest — the queued payload was tampered with. Never retried.
 */
export class PayloadIntegrityError extends PermanentIngestionError {
  constructor(jobId: string) {
    super(`Queued ingestion payload integrity check failed for job ${jobId}`);
    this.name = 'PayloadIntegrityError';
  }
}

/**
 * Classify an arbitrary thrown value. Returns `true` when the failure is
 * permanent and must not be retried.
 */
export function isPermanentIngestionError(err: unknown): boolean {
  return err instanceof PermanentIngestionError;
}
