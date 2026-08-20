import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import { registerPaymentChannelRoutes } from '../../src/api/routes/payment_channel.js';
import {
  resetPaymentChannelService,
  signPaymentVoucher,
} from '../../src/billing/payment_channel.js';

describe('Payment Channel REST API Routes (#295)', () => {
  let app: FastifyInstance;
  let senderKeyPair: nacl.SignKeyPair;
  let senderPubHex: string;
  let senderSecHex: string;
  let recipientAddress: string;

  beforeEach(async () => {
    resetPaymentChannelService();
    senderKeyPair = nacl.sign.keyPair();
    senderPubHex = Buffer.from(senderKeyPair.publicKey).toString('hex');
    senderSecHex = Buffer.from(senderKeyPair.secretKey).toString('hex');
    recipientAddress = '0xRecipientAddress0000000000000000000002';

    app = Fastify();
    registerPaymentChannelRoutes(app);
    await app.ready();
  });

  describe('POST /api/v1/payment-channels/open', () => {
    it('opens a new channel successfully', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '5000000',
          expirationSeconds: 86400,
          disputePeriodSeconds: 3600,
        },
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.channelId).toBeDefined();
      expect(json.senderAddress).toBe(senderPubHex);
      expect(json.recipientAddress).toBe(recipientAddress);
      expect(json.totalDeposit).toBe('5000000');
      expect(json.status).toBe('OPEN');
      expect(json.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 400 when missing required fields or negative deposit', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          totalDeposit: '-1000',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Bad Request');
    });
  });

  describe('POST /api/v1/payment-channels/voucher/sign', () => {
    it('signs a microtransaction voucher', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/voucher/sign',
        payload: {
          channelId: 'chan_test_999',
          sequence: 1,
          cumulativeAmount: '25000',
          secretKey: senderSecHex,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.channelId).toBe('chan_test_999');
      expect(json.sequence).toBe(1);
      expect(json.cumulativeAmount).toBe('25000');
      expect(json.signature).toBeDefined();
      expect(json.signerPublicKey).toBeDefined();
    });
  });

  describe('POST /api/v1/payment-channels/voucher/verify', () => {
    it('verifies and records a valid signed voucher', async () => {
      // First open channel
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '100000',
        },
      });
      const channel = openRes.json();

      const voucher = signPaymentVoucher(
        {
          channelId: channel.channelId,
          sequence: 1,
          cumulativeAmount: 15_000n,
        },
        senderSecHex,
      );

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/voucher/verify',
        payload: {
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount.toString(),
          nonce: voucher.nonce,
          expiresAt: voucher.expiresAt,
          signature: voucher.signature,
          signerPublicKey: voucher.signerPublicKey,
        },
      });

      expect(verifyRes.statusCode).toBe(200);
      const json = verifyRes.json();
      expect(json.isValid).toBe(true);
      expect(json.cumulativeAmount).toBe('15000');
      expect(json.transactedAmount).toBe('15000');
      expect(json.remainingDeposit).toBe('85000');
      expect(json.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 400 when verifying tampered signature', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '100000',
        },
      });
      const channel = openRes.json();

      const voucher = signPaymentVoucher(
        {
          channelId: channel.channelId,
          sequence: 1,
          cumulativeAmount: 15_000n,
        },
        senderSecHex,
      );

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/voucher/verify',
        payload: {
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: '999999', // Tampered amount
          nonce: voucher.nonce,
          expiresAt: voucher.expiresAt,
          signature: voucher.signature,
          signerPublicKey: voucher.signerPublicKey,
        },
      });

      expect(verifyRes.statusCode).toBe(400);
      expect(verifyRes.json().isValid).toBe(false);
    });
  });

  describe('POST /api/v1/payment-channels/top-up', () => {
    it('tops up channel deposit collateral', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '100000',
        },
      });
      const channel = openRes.json();

      const topUpRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/top-up',
        payload: {
          channelId: channel.channelId,
          additionalDeposit: '50000',
        },
      });

      expect(topUpRes.statusCode).toBe(200);
      expect(topUpRes.json().totalDeposit).toBe('150000');
    });
  });

  describe('POST /api/v1/payment-channels/close', () => {
    it('cooperatively closes channel and settles payout', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '100000',
        },
      });
      const channel = openRes.json();

      const voucher = signPaymentVoucher(
        {
          channelId: channel.channelId,
          sequence: 1,
          cumulativeAmount: 70_000n,
        },
        senderSecHex,
      );

      const closeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/close',
        payload: {
          channelId: channel.channelId,
          finalVoucher: {
            channelId: voucher.channelId,
            sequence: voucher.sequence,
            cumulativeAmount: voucher.cumulativeAmount.toString(),
            nonce: voucher.nonce,
            expiresAt: voucher.expiresAt,
            signature: voucher.signature,
            signerPublicKey: voucher.signerPublicKey,
          },
        },
      });

      expect(closeRes.statusCode).toBe(200);
      const json = closeRes.json();
      expect(json.status).toBe('SETTLED');
      expect(json.recipientPayout).toBe('70000');
      expect(json.senderRefund).toBe('30000');
    });
  });

  describe('GET /api/v1/payment-channels/:channelId', () => {
    it('returns 404 for non-existent channel', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/payment-channels/non_existent_chan_id',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns channel state and list by query params', async () => {
      const openRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payment-channels/open',
        payload: {
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: '250000',
        },
      });
      const channel = openRes.json();

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/payment-channels/${channel.channelId}`,
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().channelId).toBe(channel.channelId);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/payment-channels?senderAddress=${senderPubHex}`,
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().total).toBeGreaterThanOrEqual(1);
    });
  });
});
