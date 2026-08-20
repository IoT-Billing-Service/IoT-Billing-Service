import { describe, expect, it, vi } from 'vitest';
import { DeviceSdk, type FetchLike } from '../../../src/sdk/device_sdk.js';

const signer = {
  publicKeyHex: 'ab'.repeat(32),
  sign: vi.fn(async (message: Uint8Array) => new Uint8Array(message.slice(0, 64))),
};

function response(status: number, body: object) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('DeviceSdk', () => {
  it('creates a server-compatible signed telemetry envelope', async () => {
    let requestBody: Record<string, any> | undefined;
    const fetch: FetchLike = async (_url, init) => {
      requestBody = JSON.parse(init?.body ?? '{}');
      return response(200, { success: true, deviceId: 'meter-1', recordsWritten: 1 });
    };

    const result = await new DeviceSdk({
      baseUrl: 'https://billing.test/',
      signer,
      fetch,
    }).submitTelemetry({
      deviceId: 'meter-1',
      timestamp: 1_700_000_000_000,
      nonce: 'nonce-1',
      metrics: { kwh: 4.2 },
      proof: 'proof',
      powSolution: { nonce: 'pow-1', difficulty: 1 },
    });

    expect(result.success).toBe(true);
    expect(requestBody?.publicKey).toBe(signer.publicKeyHex);
    expect(requestBody?.payload).toMatchObject({ deviceId: 'meter-1', nonce: 'nonce-1' });
    expect(requestBody?.payload.signature).toBeTypeOf('string');
    expect(signer.sign).toHaveBeenCalledWith(
      new TextEncoder().encode(
        JSON.stringify({
          deviceId: 'meter-1',
          timestamp: 1_700_000_000_000,
          nonce: 'nonce-1',
          metrics: { kwh: 4.2 },
        }),
      ),
    );
  });

  it('retries transient responses but returns application errors', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(503, { success: false }))
      .mockResolvedValueOnce(
        response(401, { success: false, errorCode: 'ERR_SIGNATURE_MISMATCH' }),
      );
    const sdk = new DeviceSdk({ baseUrl: 'https://billing.test', signer, fetch, maxRetries: 1 });

    const result = await sdk.attest({
      deviceId: 'meter-1',
      certSerial: 'cert-1',
      timestamp: 1,
      nonce: 'n',
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.errorCode).toBe('ERR_SIGNATURE_MISMATCH');
  });
});
