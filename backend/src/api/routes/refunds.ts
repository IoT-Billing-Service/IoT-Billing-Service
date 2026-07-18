/**
 * Refund API routes.
 *
 * `POST   /api/refunds`          — Request a refund
 * `GET    /api/refunds/:id`      — Get refund status
 * `GET    /api/refunds/account/:accountId` — List refunds for an account
 * `POST   /api/refunds/:id/process` — Trigger on-chain processing
 *
 * ## Error mapping
 *
 * | Error code                    | HTTP status | Description                        |
 * |-------------------------------|-------------|------------------------------------|
 * | `SUCCESS`                     | 200         | Refund processed successfully      |
 * | `ERR_REFUND_ALREADY_EXISTS`   | 409         | Duplicate idempotency key          |
 * | `ERR_BILLING_RECORD_NOT_FOUND`| 404         | Billing record does not exist      |
 * | `ERR_BILLING_RECORD_NOT_SETTLED` | 422      | Record must be settled first       |
 * | `ERR_REFUND_NOT_FOUND`        | 404         | Refund does not exist              |
 * | `ERR_ON_CHAIN_SUBMISSION_FAILED` | 502     | Soroban tx submission failed       |
 * | `ERR_ON_CHAIN_VERIFICATION_FAILED` | 502   | On-chain verification failed       |
 * | `ERR_INTERNAL`                | 500         | Unexpected server error            |
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RefundService, REFUND_ERROR_CODES } from '../../refund/refund_service.js';
import { isRefundState } from '../../refund/state_machine.js';

// ── HTTP status mapping ────────────────────────────────────────────────────────

const ERROR_TO_HTTP_STATUS: Record<string, number> = {
  [REFUND_ERROR_CODES.ALREADY_EXISTS]: 409,
  [REFUND_ERROR_CODES.BILLING_RECORD_NOT_FOUND]: 404,
  [REFUND_ERROR_CODES.BILLING_RECORD_NOT_SETTLED]: 422,
  [REFUND_ERROR_CODES.BILLING_RECORD_ALREADY_REFUNDED]: 409,
  [REFUND_ERROR_CODES.NOT_FOUND]: 404,
  [REFUND_ERROR_CODES.INVALID_STATE]: 422,
  [REFUND_ERROR_CODES.ON_CHAIN_SUBMISSION_FAILED]: 502,
  [REFUND_ERROR_CODES.ON_CHAIN_VERIFICATION_FAILED]: 502,
  [REFUND_ERROR_CODES.MAX_RETRIES_EXCEEDED]: 502,
  [REFUND_ERROR_CODES.INTERNAL_ERROR]: 500,
};

function statusForError(errorCode: string | undefined): number {
  if (errorCode === undefined) return 500;
  return ERROR_TO_HTTP_STATUS[errorCode] ?? 500;
}

// ── Request/Response schemas ───────────────────────────────────────────────────

interface RefundRequestBody {
  billingRecordId: string;
  accountId: string;
  amount: string;
  reason?: string;
  idempotencyKey: string;
}

interface RefundStatusParams {
  id: string;
}

interface AccountRefundsParams {
  accountId: string;
}

interface RefundProcessParams {
  id: string;
}

// ── Route registration ─────────────────────────────────────────────────────────

let refundService: RefundService | null = null;

function getRefundService(): RefundService {
  if (refundService === null) {
    throw new Error('Refund service not initialized. Call initRefundService first.');
  }
  return refundService;
}

/**
 * Initialise the refund service and its dependencies.
 * Call this once during server startup.
 */
export function initRefundService(service: RefundService): RefundService {
  refundService = service;
  return refundService;
}

/**
 * Reset the refund service singleton (for testing).
 */
export function resetRefundService(): void {
  refundService = null;
}

export function registerRefundRoutes(app: FastifyInstance): void {
  /**
   * POST /api/refunds
   *
   * Request a refund for a billing record.
   */
  app.post<{ Body: RefundRequestBody }>(
    '/api/refunds',
    {
      schema: {
        body: {
          type: 'object',
          required: ['billingRecordId', 'accountId', 'amount', 'idempotencyKey'],
          properties: {
            billingRecordId: { type: 'string' },
            accountId: { type: 'string' },
            amount: { type: 'string' },
            reason: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RefundRequestBody }>, reply: FastifyReply) => {
      const { billingRecordId, accountId, amount, reason, idempotencyKey } = request.body;

      const svc = getRefundService();
      const result = await svc.requestRefund({
        billingRecordId,
        accountId,
        amount: BigInt(amount),
        reason,
        idempotencyKey,
      });

      const httpStatus = result.success ? 201 : statusForError(result.errorCode);

      return reply.status(httpStatus).send({
        success: result.success,
        refund: result.refund,
        errorCode: result.errorCode,
        reason: result.reason,
      });
    },
  );

  /**
   * POST /api/refunds/:id/process
   *
   * Trigger on-chain processing for a pending refund.
   */
  app.post<{ Params: RefundProcessParams }>(
    '/api/refunds/:id/process',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: RefundProcessParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      const svc = getRefundService();
      const result = await svc.processRefund(id);

      const httpStatus = result.success ? 200 : statusForError(result.errorCode);

      return reply.status(httpStatus).send({
        success: result.success,
        refund: result.refund,
        errorCode: result.errorCode,
        reason: result.reason,
      });
    },
  );

  /**
   * GET /api/refunds/:id
   *
   * Get refund status including on-chain verification details.
   */
  app.get<{ Params: RefundStatusParams }>(
    '/api/refunds/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: RefundStatusParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      const svc = getRefundService();
      const result = await svc.getRefundStatus(id);

      if (result === null) {
        return reply.status(404).send({
          success: false,
          errorCode: REFUND_ERROR_CODES.NOT_FOUND,
          reason: `Refund not found: ${id}`,
        });
      }

      return reply.status(200).send({
        success: true,
        refund: result.refund,
        onChainStatus: result.onChainStatus,
      });
    },
  );

  /**
   * GET /api/refunds/account/:accountId
   *
   * List all refunds for an account.
   */
  app.get<{ Params: AccountRefundsParams }>(
    '/api/refunds/account/:accountId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: AccountRefundsParams }>,
      reply: FastifyReply,
    ) => {
      const { accountId } = request.params;

      const svc = getRefundService();
      const refunds = await svc.getAccountRefunds(accountId);

      return reply.status(200).send({
        success: true,
        refunds,
        total: refunds.length,
      });
    },
  );
}
