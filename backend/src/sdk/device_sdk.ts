/**
 * Platform-neutral client for device attestation and signed telemetry.
 *
 * The SDK deliberately receives a signer from the host application. Private
 * keys can therefore remain in WebCrypto, a native keystore, or secure device
 * hardware instead of being copied into this package.
 */

export interface Ed25519Signer {
  readonly publicKeyHex: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface PowSolution {
  nonce: string;
  difficulty: number;
}

export interface TelemetryInput {
  deviceId: string;
  metrics: Record<string, number | string>;
  proof: string;
  powSolution: PowSolution;
  timestamp?: number;
  nonce?: string;
}

export interface AttestationInput {
  deviceId: string;
  certSerial: string;
  /**
   * PEM-encoded device leaf certificate for PKI hardware identity binding
   * (issue #294). Required when the server is configured with PKI_CA_CERT_PEMS.
   */
  certPem?: string;
  timestamp?: number;
  nonce?: string;
}

export interface ApiResult {
  success: boolean;
  errorCode?: string;
  reason?: string;
  deviceId?: string;
  recordsWritten?: number;
  attestedAt?: string;
  messageDigest?: string;
  /** SHA-256 fingerprint of the device certificate (issue #294 — PKI binding). */
  certFingerprint?: string;
  /** SPIFFE URI from the device certificate SAN (issue #294). */
  spiffeUri?: string;
  /** Certificate expiry ISO-8601 timestamp (issue #294). */
  certExpiresAt?: string;
  /** True when the certificate is within the expiry warning window (issue #294). */
  certExpiryWarning?: boolean;
}

export type FetchLike = (input: string, init?: RequestInitLike) => Promise<ResponseLike>;

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface DeviceSdkOptions {
  baseUrl: string;
  signer: Ed25519Signer;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;

interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

interface HostRuntime {
  fetch?: FetchLike;
  AbortController?: new () => AbortControllerLike;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues === undefined) {
    throw new Error('Secure randomness is required to generate request nonces');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function asResult(value: unknown): ApiResult {
  if (value === null || typeof value !== 'object' || !('success' in value)) {
    throw new Error('Invalid response from IoT Billing Service');
  }
  return value as ApiResult;
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class DeviceSdk {
  private readonly baseUrl: string;
  private readonly signer: Ed25519Signer;
  private readonly request: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: DeviceSdkOptions) {
    if (!/^[0-9a-f]{64}$/i.test(options.signer.publicKeyHex)) {
      throw new Error('signer.publicKeyHex must be a 32-byte hexadecimal public key');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.signer = options.signer;
    const host = globalThis as typeof globalThis & HostRuntime;
    this.request =
      options.fetch ??
      ((input, init) => {
        if (host.fetch === undefined) throw new Error('A fetch implementation is required');
        return host.fetch(input, init);
      });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async submitTelemetry(input: TelemetryInput): Promise<ApiResult> {
    const unsignedPayload = {
      deviceId: input.deviceId,
      timestamp: input.timestamp ?? Date.now(),
      nonce: input.nonce ?? randomNonce(),
      metrics: input.metrics,
    };
    const signature = await this.sign(unsignedPayload);
    return this.post('/ingest', {
      payload: { ...unsignedPayload, signature },
      publicKey: this.signer.publicKeyHex,
      proof: input.proof,
      powSolution: input.powSolution,
    });
  }

  async attest(input: AttestationInput): Promise<ApiResult> {
    const timestamp = input.timestamp ?? Date.now();
    const nonce = input.nonce ?? randomNonce();
    const message = [
      input.deviceId,
      this.signer.publicKeyHex,
      nonce,
      timestamp,
      input.certSerial,
    ].join('|');
    const signature = bytesToHex(await this.signMessage(encodeUtf8(message)));
    return this.post('/attestation', {
      deviceId: input.deviceId,
      publicKey: this.signer.publicKeyHex,
      nonce,
      timestamp,
      certSerial: input.certSerial,
      signature,
      // Include PEM certificate when provided (issue #294 — PKI binding)
      ...(input.certPem !== undefined && { certPem: input.certPem }),
    });
  }

  private async sign(payload: object): Promise<string> {
    const signature = await this.signMessage(encodeUtf8(JSON.stringify(payload)));
    return bytesToHex(signature);
  }

  private signMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.signer.sign(message).then((signature) => {
      if (signature.byteLength !== 64) {
        throw new Error('Ed25519 signer must return a 64-byte signature');
      }
      return signature;
    });
  }

  private async post(path: string, body: object): Promise<ApiResult> {
    for (let attempt = 0; ; attempt++) {
      const host = globalThis as typeof globalThis & HostRuntime;
      const controller =
        host.AbortController === undefined ? undefined : new host.AbortController();
      const timer = setTimeout(() => controller?.abort(), this.timeoutMs);
      try {
        const response = await this.request(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
        if (!response.ok && shouldRetry(response.status) && attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
          continue;
        }
        return asResult(await response.json());
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
