/**
 * Peer-to-Peer Payment Channels REST API Routes (issue #295).
 *
 * Exposes endpoints for managing high-frequency IoT microtransaction payment channels,
 * verifying signed payment vouchers, topping up collateral, cooperative closing,
 * and dispute resolution.
 *
 * Routes:
 *   POST /api/v1/payment-channels/open           — Open a new payment channel.
 *   POST /api/v1/payment-channels/voucher/sign   — Sign a microtransaction voucher (client/testing helper).
 *   POST /api/v1/payment-channels/voucher/verify — Cryptographically verify and record a voucher.
 *   POST /api/v1/payment-channels/top-up         — Add collateral to an active channel.
 *   POST /api/v1/payment-channels/close          — Cooperatively close and settle a channel.
 *   POST /api/v1/payment-channels/dispute        — Initiate unilateral dispute challenge.
 *   POST /api/v1/payment-channels/settle         — Finalize expired dispute settlement.
 *   GET  /api/v1/payment-channels/:channelId     — Get live channel state.
 *   GET  /api/v1/payment-channels                — List payment channels by filter.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  getPaymentChannelService,
  signPaymentVoucher,
  computeChannelDigest,
  type PaymentVoucher,
  type PaymentChannelStatus,
  type PaymentChannelState,
} from '../../billing/payment_channel.js';

export interface OpenChannelBody {
  senderAddress: string;
  recipientAddress: string;
  totalDeposit: string | number;
  expirationSeconds?: number;
  disputePeriodSeconds?: number;
  channelId?: string;
}

export interface SignVoucherBody {
  channelId: string;
  sequence: number;
  cumulativeAmount: string | number;
  secretKey: string;
  nonce?: string;
  expiresAt?: number;
}

export interface VerifyVoucherBody {
  channelId: string;
  sequence: number;
  cumulativeAmount: string | number;
  nonce: string;
  expiresAt: number;
  signature: string;
  signerPublicKey: string;
}

export interface TopUpBody {
  channelId: string;
  additionalDeposit: string | number;
}

export interface CloseChannelBody {
  channelId: string;
  finalVoucher?: {
    channelId: string;
    sequence: number;
    cumulativeAmount: string | number;
    nonce: string;
    expiresAt: number;
    signature: string;
    signerPublicKey: string;
  };
}

export interface DisputeBody {
  channelId: string;
  initiatedBy: string;
  voucher: {
    channelId: string;
    sequence: number;
    cumulativeAmount: string | number;
    nonce: string;
    expiresAt: number;
    signature: string;
    signerPublicKey: string;
  };
}

export interface SettleBody {
  channelId: string;
}

function serializeChannel(channel: PaymentChannelState): Record<string, unknown> {
  return {
    id: channel.id,
    channelId: channel.channelId,
    senderAddress: channel.senderAddress,
    recipientAddress: channel.recipientAddress,
    totalDeposit: channel.totalDeposit.toString(),
    settledAmount: channel.settledAmount.toString(),
    sequence: channel.sequence,
    status: channel.status,
    disputePeriodSeconds: channel.disputePeriodSeconds,
    disputeExpiresAt: channel.disputeExpiresAt ? channel.disputeExpiresAt.toISOString() : null,
    expiresAt: channel.expiresAt.toISOString(),
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
    digest: computeChannelDigest(channel),
  };
}

export function registerPaymentChannelRoutes(app: FastifyInstance, prisma?: PrismaClient): void {
  const service = getPaymentChannelService(prisma);

  /**
   * POST /api/v1/payment-channels/open
   */
  app.post<{ Body: OpenChannelBody }>(
    '/api/v1/payment-channels/open',
    async (request: FastifyRequest<{ Body: OpenChannelBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.senderAddress || !body.recipientAddress) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'senderAddress and recipientAddress are required',
        });
      }

      let totalDeposit: bigint;
      try {
        totalDeposit = BigInt(body.totalDeposit);
        if (totalDeposit <= 0n) throw new Error();
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'totalDeposit must be a positive integer or numeric string',
        });
      }

      try {
        const channel = await service.openChannel({
          senderAddress: body.senderAddress,
          recipientAddress: body.recipientAddress,
          totalDeposit,
          expirationSeconds: body.expirationSeconds,
          disputePeriodSeconds: body.disputePeriodSeconds,
          channelId: body.channelId,
        });

        return reply.status(201).send(serializeChannel(channel));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to open payment channel';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * POST /api/v1/payment-channels/voucher/sign
   */
  app.post<{ Body: SignVoucherBody }>(
    '/api/v1/payment-channels/voucher/sign',
    async (request: FastifyRequest<{ Body: SignVoucherBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.channelId || body.sequence === undefined || !body.secretKey) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId, sequence, and secretKey are required',
        });
      }

      let cumulativeAmount: bigint;
      try {
        cumulativeAmount = BigInt(body.cumulativeAmount);
        if (cumulativeAmount < 0n) throw new Error();
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'cumulativeAmount must be a non-negative integer or numeric string',
        });
      }

      try {
        const voucher = signPaymentVoucher(
          {
            channelId: body.channelId,
            sequence: body.sequence,
            cumulativeAmount,
            nonce: body.nonce,
            expiresAt: body.expiresAt,
          },
          body.secretKey,
        );

        return reply.send({
          ...voucher,
          cumulativeAmount: voucher.cumulativeAmount.toString(),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to sign voucher';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * POST /api/v1/payment-channels/voucher/verify
   */
  app.post<{ Body: VerifyVoucherBody }>(
    '/api/v1/payment-channels/voucher/verify',
    async (request: FastifyRequest<{ Body: VerifyVoucherBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (
        !body.channelId ||
        body.sequence === undefined ||
        !body.signature ||
        !body.signerPublicKey
      ) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId, sequence, signature, and signerPublicKey are required',
        });
      }

      let cumulativeAmount: bigint;
      try {
        cumulativeAmount = BigInt(body.cumulativeAmount);
        if (cumulativeAmount < 0n) throw new Error();
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'cumulativeAmount must be a non-negative integer or numeric string',
        });
      }

      const voucher: PaymentVoucher = {
        channelId: body.channelId,
        sequence: body.sequence,
        cumulativeAmount,
        nonce: body.nonce,
        expiresAt: body.expiresAt,
        signature: body.signature,
        signerPublicKey: body.signerPublicKey,
      };

      const result = await service.verifyAndApplyVoucher(voucher);

      const status = result.isValid ? 200 : 400;
      return reply.status(status).send({
        isValid: result.isValid,
        channelId: result.channelId,
        sequence: result.sequence,
        cumulativeAmount: result.cumulativeAmount.toString(),
        transactedAmount: result.transactedAmount.toString(),
        remainingDeposit: result.remainingDeposit.toString(),
        verifiedAt: result.verifiedAt,
        digest: result.digest,
        ...(result.errorReason && { errorReason: result.errorReason }),
      });
    },
  );

  /**
   * POST /api/v1/payment-channels/top-up
   */
  app.post<{ Body: TopUpBody }>(
    '/api/v1/payment-channels/top-up',
    async (request: FastifyRequest<{ Body: TopUpBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.channelId || body.additionalDeposit === undefined) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId and additionalDeposit are required',
        });
      }

      let additionalDeposit: bigint;
      try {
        additionalDeposit = BigInt(body.additionalDeposit);
        if (additionalDeposit <= 0n) throw new Error();
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'additionalDeposit must be a positive integer or numeric string',
        });
      }

      try {
        const channel = await service.topUpChannel(body.channelId, additionalDeposit);
        return reply.send(serializeChannel(channel));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to top up channel';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * POST /api/v1/payment-channels/close
   */
  app.post<{ Body: CloseChannelBody }>(
    '/api/v1/payment-channels/close',
    async (request: FastifyRequest<{ Body: CloseChannelBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.channelId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId is required',
        });
      }

      let finalVoucher: PaymentVoucher | undefined;
      if (body.finalVoucher) {
        finalVoucher = {
          channelId: body.finalVoucher.channelId,
          sequence: body.finalVoucher.sequence,
          cumulativeAmount: BigInt(body.finalVoucher.cumulativeAmount),
          nonce: body.finalVoucher.nonce,
          expiresAt: body.finalVoucher.expiresAt,
          signature: body.finalVoucher.signature,
          signerPublicKey: body.finalVoucher.signerPublicKey,
        };
      }

      try {
        const result = await service.closeChannel({
          channelId: body.channelId,
          finalVoucher,
        });

        return reply.send({
          channelId: result.channelId,
          status: result.status,
          recipientPayout: result.recipientPayout.toString(),
          senderRefund: result.senderRefund.toString(),
          totalDeposit: result.totalDeposit.toString(),
          finalSequence: result.finalSequence,
          settledAt: result.settledAt,
          digest: result.digest,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to close payment channel';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * POST /api/v1/payment-channels/dispute
   */
  app.post<{ Body: DisputeBody }>(
    '/api/v1/payment-channels/dispute',
    async (request: FastifyRequest<{ Body: DisputeBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.channelId || !body.voucher || !body.initiatedBy) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId, initiatedBy, and voucher are required',
        });
      }

      const voucher: PaymentVoucher = {
        channelId: body.voucher.channelId,
        sequence: body.voucher.sequence,
        cumulativeAmount: BigInt(body.voucher.cumulativeAmount),
        nonce: body.voucher.nonce,
        expiresAt: body.voucher.expiresAt,
        signature: body.voucher.signature,
        signerPublicKey: body.voucher.signerPublicKey,
      };

      try {
        const result = await service.initiateDispute({
          channelId: body.channelId,
          voucher,
          initiatedBy: body.initiatedBy,
        });

        return reply.send({
          disputeId: result.disputeId,
          channelId: result.channelId,
          claimedSequence: result.claimedSequence,
          claimedAmount: result.claimedAmount.toString(),
          challengeDeadline: result.challengeDeadline.toISOString(),
          status: result.status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to initiate dispute';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * POST /api/v1/payment-channels/settle
   */
  app.post<{ Body: SettleBody }>(
    '/api/v1/payment-channels/settle',
    async (request: FastifyRequest<{ Body: SettleBody }>, reply: FastifyReply) => {
      const body = request.body;
      if (!body.channelId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'channelId is required',
        });
      }

      try {
        const result = await service.settleDispute(body.channelId);
        return reply.send({
          channelId: result.channelId,
          status: result.status,
          recipientPayout: result.recipientPayout.toString(),
          senderRefund: result.senderRefund.toString(),
          totalDeposit: result.totalDeposit.toString(),
          finalSequence: result.finalSequence,
          settledAt: result.settledAt,
          digest: result.digest,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to settle payment channel';
        return reply.status(400).send({
          error: 'Bad Request',
          message,
        });
      }
    },
  );

  /**
   * GET /api/v1/payment-channels/:channelId
   */
  app.get<{ Params: { channelId: string } }>(
    '/api/v1/payment-channels/:channelId',
    async (request: FastifyRequest<{ Params: { channelId: string } }>, reply: FastifyReply) => {
      const channel = await service.getChannel(request.params.channelId);
      if (!channel) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Payment channel ${request.params.channelId} not found`,
        });
      }
      return reply.send(serializeChannel(channel));
    },
  );

  /**
   * GET /api/v1/payment-channels
   */
  app.get<{
    Querystring: {
      senderAddress?: string;
      recipientAddress?: string;
      status?: PaymentChannelStatus;
    };
  }>('/api/v1/payment-channels', async (request, reply) => {
    const channels = await service.listChannels(request.query);
    return reply.send({
      channels: channels.map(serializeChannel),
      total: channels.length,
      retrievedAt: new Date().toISOString(),
    });
  });
}
