import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import nacl from 'tweetnacl';
import {
  registerAttestationRoutes,
  getAttestationService,
  resetAttestationService,
} from '../../src/api/routes/attestation.js';
import { buildAttestationMessage } from '../../src/core/crypto/attestation.js';

describe('attestation routes', () => {
  beforeEach(() => {
    resetAttestationService();
  });

  it('accepts a valid attestation request after lazy initialization', async () => {
    const app = Fastify();
    registerAttestationRoutes(app);

    const service = getAttestationService();
    const registry = (service as unknown as { certRegistry: { add: (cert: { serial: string; model: string; batch: string; revoked: boolean }) => void } }).certRegistry;
    registry.add({ serial: 'CERT-TEST-1', model: 'MTR-1', batch: 'BATCH-1', revoked: false });

    const keyPair = nacl.sign.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');
    const nonce = 'nonce-123';
    const timestamp = Date.now();
    const certSerial = 'CERT-TEST-1';
    const message = buildAttestationMessage({
      deviceId: 'device-1',
      publicKey,
      nonce,
      timestamp,
      certSerial,
    });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), keyPair.secretKey)).toString('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/attestation',
      payload: {
        deviceId: 'device-1',
        publicKey,
        nonce,
        timestamp,
        certSerial,
        signature,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, deviceId: 'device-1' });
  });
});
