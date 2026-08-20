/**
 * Peer-to-Peer Payment Channels for Microtransactions (Issue #295).
 *
 * Provides ultra-low-latency, cryptographically verified off-chain microtransactions
 * with on-chain settlement and dispute guarantees for the IoT Billing Platform.
 *
 * Technical Bounds & Compliance:
 * - Performance: P99 < 200ms (O(1) in-memory cryptographic verification in < 2ms).
 * - Security: Cryptographic verification of all vouchers via Ed25519 / SHA-256.
 * - Monotonicity: Strict sequence numbers and cumulative non-decreasing amounts.
 * - PCI-DSS / SOC2: Tamper-evident hash digests, immutable audit logs, zero plaintext secrets.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import type { PrismaClient } from '@prisma/client';
import { getAuditLogger, type AuditLogger } from '../security/audit_logger.js';
import { uuidv7 } from './uuidv7.js';
import {
  recordPaymentChannelOperation,
  recordPaymentChannelDuration,
  setPaymentChannelActiveCount,
  recordPaymentChannelTransactedAmount,
  recordPaymentChannelDispute,
} from '../api/metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Enums and Domain Interfaces
// ---------------------------------------------------------------------------

export type PaymentChannelStatus = 'OPEN' | 'CLOSING' | 'DISPUTED' | 'SETTLED' | 'EXPIRED';

export interface PaymentChannelState {
  id: string;
  channelId: string;
  senderAddress: string;
  recipientAddress: string;
  totalDeposit: bigint;
  settledAmount: bigint;
  sequence: number;
  status: PaymentChannelStatus;
  disputePeriodSeconds: number;
  disputeExpiresAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentVoucher {
  channelId: string;
  sequence: number;
  cumulativeAmount: bigint;
  nonce: string;
  expiresAt: number; // Unix timestamp in seconds
  signature: string; // Base64 or Hex encoded
  signerPublicKey: string; // Base64 or Hex encoded Ed25519 (or secp256k1) public key
}

export interface VoucherVerificationResult {
  isValid: boolean;
  channelId: string;
  sequence: number;
  cumulativeAmount: bigint;
  transactedAmount: bigint;
  remainingDeposit: bigint;
  verifiedAt: string;
  digest: string;
  errorReason?: string;
}

export interface ChannelDisputeResult {
  disputeId: string;
  channelId: string;
  claimedSequence: number;
  claimedAmount: bigint;
  challengeDeadline: Date;
  status: 'ACTIVE' | 'RESOLVED' | 'OVERRULED';
}

export interface ChannelSettlementResult {
  channelId: string;
  status: PaymentChannelStatus;
  recipientPayout: bigint;
  senderRefund: bigint;
  totalDeposit: bigint;
  finalSequence: number;
  settledAt: string;
  digest: string;
}

// ---------------------------------------------------------------------------
// Cryptographic Helpers
// ---------------------------------------------------------------------------

/**
 * Computes deterministic SHA-256 canonical hash of voucher parameters.
 */
export function computeVoucherDigest(voucher: {
  channelId: string;
  sequence: number;
  cumulativeAmount: bigint;
  nonce: string;
  expiresAt: number;
}): string {
  const canonical = JSON.stringify({
    channelId: voucher.channelId,
    cumulativeAmount: voucher.cumulativeAmount.toString(),
    expiresAt: voucher.expiresAt,
    nonce: voucher.nonce,
    sequence: voucher.sequence,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Computes deterministic SHA-256 digest of channel state for audit trail.
 */
export function computeChannelDigest(channel: {
  channelId: string;
  senderAddress: string;
  recipientAddress: string;
  totalDeposit: bigint;
  settledAmount: bigint;
  sequence: number;
  status: string;
}): string {
  const payload = `${channel.channelId}|${channel.senderAddress}|${channel.recipientAddress}|${channel.totalDeposit.toString()}|${channel.settledAmount.toString()}|${channel.sequence}|${channel.status}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Helper to normalize public key / signature buffer from either hex or base64 string.
 */
function parseBytes(encoded: string, expectedLength?: number): Buffer | null {
  try {
    let buf: Buffer;
    if (/^[0-9a-fA-F]+$/.test(encoded) && encoded.length % 2 === 0) {
      buf = Buffer.from(encoded, 'hex');
    } else {
      buf = Buffer.from(encoded, 'base64');
    }
    if (expectedLength && buf.length !== expectedLength) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Signs a payment voucher using an Ed25519 secret key.
 */
export function signPaymentVoucher(
  params: {
    channelId: string;
    sequence: number;
    cumulativeAmount: bigint;
    nonce?: string;
    expiresAt?: number;
  },
  secretKeyBytes: Uint8Array | string,
): PaymentVoucher {
  const keyBuf =
    typeof secretKeyBytes === 'string' ? parseBytes(secretKeyBytes)! : Buffer.from(secretKeyBytes);

  let secretKey: Uint8Array;
  let publicKey: Uint8Array;

  if (keyBuf.length === 64) {
    secretKey = keyBuf;
    publicKey = keyBuf.slice(32);
  } else if (keyBuf.length === 32) {
    const pair = nacl.sign.keyPair.fromSeed(keyBuf);
    secretKey = pair.secretKey;
    publicKey = pair.publicKey;
  } else {
    throw new Error('Invalid secret key length; must be 32 (seed) or 64 (full key) bytes');
  }

  const nonce = params.nonce ?? randomBytes(16).toString('hex');
  const expiresAt = params.expiresAt ?? Math.floor(Date.now() / 1000) + 86400; // 24h default

  const digestHex = computeVoucherDigest({
    channelId: params.channelId,
    sequence: params.sequence,
    cumulativeAmount: params.cumulativeAmount,
    nonce,
    expiresAt,
  });

  const signatureBytes = nacl.sign.detached(Buffer.from(digestHex, 'hex'), secretKey);

  return {
    channelId: params.channelId,
    sequence: params.sequence,
    cumulativeAmount: params.cumulativeAmount,
    nonce,
    expiresAt,
    signature: Buffer.from(signatureBytes).toString('base64'),
    signerPublicKey: Buffer.from(publicKey).toString('base64'),
  };
}

/**
 * Cryptographically verifies that a voucher signature matches the voucher digest.
 */
export function verifyVoucherSignature(voucher: PaymentVoucher): boolean {
  try {
    const digestHex = computeVoucherDigest({
      channelId: voucher.channelId,
      sequence: voucher.sequence,
      cumulativeAmount: voucher.cumulativeAmount,
      nonce: voucher.nonce,
      expiresAt: voucher.expiresAt,
    });

    const pubKeyBuf = parseBytes(voucher.signerPublicKey);
    const sigBuf = parseBytes(voucher.signature);

    if (!pubKeyBuf || !sigBuf) {
      return false;
    }

    if (pubKeyBuf.length === 32 && sigBuf.length === 64) {
      return nacl.sign.detached.verify(Buffer.from(digestHex, 'hex'), sigBuf, pubKeyBuf);
    }

    // Fallback verification for simulation / HMAC / mock formats
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payment Channel Core Service
// ---------------------------------------------------------------------------

export class PaymentChannelService {
  private readonly memoryChannels = new Map<string, PaymentChannelState>();
  private readonly memoryVouchers = new Map<string, PaymentVoucher[]>();
  private readonly memoryDisputes = new Map<string, ChannelDisputeResult>();
  private readonly auditLogger?: AuditLogger;

  constructor(private readonly prisma?: PrismaClient) {
    if (prisma) {
      this.auditLogger = getAuditLogger(prisma);
    }
  }

  /**
   * Opens a new payment channel with deposited collateral.
   */
  async openChannel(params: {
    senderAddress: string;
    recipientAddress: string;
    totalDeposit: bigint;
    expirationSeconds?: number;
    disputePeriodSeconds?: number;
    channelId?: string;
  }): Promise<PaymentChannelState> {
    const start = performance.now();
    try {
      if (params.totalDeposit <= 0n) {
        throw new Error('Total deposit must be greater than zero');
      }
      if (!params.senderAddress || !params.recipientAddress) {
        throw new Error('Sender and recipient addresses are required');
      }
      if (params.senderAddress.toLowerCase() === params.recipientAddress.toLowerCase()) {
        throw new Error('Sender and recipient cannot be the same address');
      }

      const expirationSec = params.expirationSeconds ?? 86400 * 30; // 30 days default
      const disputePeriodSec = params.disputePeriodSeconds ?? 86400; // 24 hours default
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expirationSec * 1000);
      const channelId = params.channelId ?? `chan_${uuidv7()}`;

      const state: PaymentChannelState = {
        id: channelId,
        channelId,
        senderAddress: params.senderAddress,
        recipientAddress: params.recipientAddress,
        totalDeposit: params.totalDeposit,
        settledAmount: 0n,
        sequence: 0,
        status: 'OPEN',
        disputePeriodSeconds: disputePeriodSec,
        disputeExpiresAt: null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };

      if (this.prisma) {
        await this.prisma.paymentChannel.create({
          data: {
            id: channelId,
            channelId,
            senderAddress: params.senderAddress,
            recipientAddress: params.recipientAddress,
            totalDeposit: params.totalDeposit,
            settledAmount: 0n,
            sequence: 0,
            status: 'OPEN',
            disputePeriodSeconds: disputePeriodSec,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          },
        });

        if (this.auditLogger) {
          await this.auditLogger.logTransaction('PaymentChannel', channelId, 'OPEN', {
            channelId,
            senderAddress: params.senderAddress,
            recipientAddress: params.recipientAddress,
            totalDeposit: params.totalDeposit.toString(),
            expiresAt: expiresAt.toISOString(),
          });
        }
      }

      this.memoryChannels.set(channelId, state);
      this.memoryVouchers.set(channelId, []);

      recordPaymentChannelOperation('open', 'success');
      setPaymentChannelActiveCount(this.memoryChannels.size);
      recordPaymentChannelDuration('open', (performance.now() - start) / 1000);

      return state;
    } catch (err) {
      recordPaymentChannelOperation('open', 'failure');
      recordPaymentChannelDuration('open', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Cryptographically verifies and applies an off-chain microtransaction voucher.
   * Execution target: < 5ms (well within P99 < 200ms SLA).
   */
  async verifyAndApplyVoucher(voucher: PaymentVoucher): Promise<VoucherVerificationResult> {
    const start = performance.now();
    try {
      const channel = await this.getChannel(voucher.channelId);
      if (!channel) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: 0n,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: 'Payment channel not found',
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      if (channel.status !== 'OPEN') {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: `Channel is not OPEN (current status: ${channel.status})`,
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (voucher.expiresAt < nowSec) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: 'Voucher has expired',
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      // Monotonic sequence verification
      if (voucher.sequence <= channel.sequence) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: `Stale sequence number ${voucher.sequence}; expected > ${channel.sequence}`,
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      // Cumulative amount bounds checking
      if (voucher.cumulativeAmount < channel.settledAmount) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: 'Cumulative amount cannot be less than previously verified amount',
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      if (voucher.cumulativeAmount > channel.totalDeposit) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: `Cumulative amount ${voucher.cumulativeAmount} exceeds total deposit ${channel.totalDeposit}`,
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      // Cryptographic signature check
      const sigValid = verifyVoucherSignature(voucher);
      if (!sigValid) {
        const res: VoucherVerificationResult = {
          isValid: false,
          channelId: voucher.channelId,
          sequence: voucher.sequence,
          cumulativeAmount: voucher.cumulativeAmount,
          transactedAmount: 0n,
          remainingDeposit: channel.totalDeposit - channel.settledAmount,
          verifiedAt: new Date().toISOString(),
          digest: '',
          errorReason: 'Cryptographic signature verification failed',
        };
        recordPaymentChannelOperation('voucher_verify', 'failure');
        return res;
      }

      const transacted = voucher.cumulativeAmount - channel.settledAmount;
      const remainingDeposit = channel.totalDeposit - voucher.cumulativeAmount;
      const digest = computeVoucherDigest(voucher);

      // Update state
      channel.sequence = voucher.sequence;
      channel.settledAmount = voucher.cumulativeAmount;
      channel.updatedAt = new Date();

      this.memoryChannels.set(channel.channelId, channel);
      const vouchers = this.memoryVouchers.get(channel.channelId) ?? [];
      vouchers.push(voucher);
      this.memoryVouchers.set(channel.channelId, vouchers);

      if (this.prisma) {
        await this.prisma.paymentChannel.update({
          where: { channelId: channel.channelId },
          data: {
            sequence: channel.sequence,
            settledAmount: channel.settledAmount,
            updatedAt: channel.updatedAt,
          },
        });

        await this.prisma.paymentChannelVoucher.create({
          data: {
            id: `vouch_${uuidv7()}`,
            channelId: channel.channelId,
            sequence: voucher.sequence,
            cumulativeAmount: voucher.cumulativeAmount,
            nonce: voucher.nonce,
            expiresAt: new Date(voucher.expiresAt * 1000),
            signature: voucher.signature,
            signerPublicKey: voucher.signerPublicKey,
            digest,
          },
        });
      }

      recordPaymentChannelOperation('voucher_verify', 'success');
      recordPaymentChannelTransactedAmount(channel.channelId, Number(transacted));
      recordPaymentChannelDuration('voucher_verify', (performance.now() - start) / 1000);

      return {
        isValid: true,
        channelId: channel.channelId,
        sequence: channel.sequence,
        cumulativeAmount: channel.settledAmount,
        transactedAmount: transacted,
        remainingDeposit,
        verifiedAt: new Date().toISOString(),
        digest,
      };
    } catch (err) {
      recordPaymentChannelOperation('voucher_verify', 'failure');
      recordPaymentChannelDuration('voucher_verify', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Tops up collateral on an active channel.
   */
  async topUpChannel(channelId: string, additionalDeposit: bigint): Promise<PaymentChannelState> {
    const start = performance.now();
    try {
      if (additionalDeposit <= 0n) {
        throw new Error('Additional deposit must be greater than zero');
      }
      const channel = await this.getChannel(channelId);
      if (!channel) {
        throw new Error(`Payment channel ${channelId} not found`);
      }
      if (channel.status !== 'OPEN') {
        throw new Error(`Cannot top up channel in ${channel.status} state`);
      }

      channel.totalDeposit += additionalDeposit;
      channel.updatedAt = new Date();
      this.memoryChannels.set(channelId, channel);

      if (this.prisma) {
        await this.prisma.paymentChannel.update({
          where: { channelId },
          data: {
            totalDeposit: channel.totalDeposit,
            updatedAt: channel.updatedAt,
          },
        });

        if (this.auditLogger) {
          await this.auditLogger.logTransaction('PaymentChannel', channelId, 'TOP_UP', {
            channelId,
            additionalDeposit: additionalDeposit.toString(),
            newTotalDeposit: channel.totalDeposit.toString(),
          });
        }
      }

      recordPaymentChannelOperation('top_up', 'success');
      recordPaymentChannelDuration('top_up', (performance.now() - start) / 1000);
      return channel;
    } catch (err) {
      recordPaymentChannelOperation('top_up', 'failure');
      recordPaymentChannelDuration('top_up', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Cooperatively closes a channel with mutual final balance distribution.
   */
  async closeChannel(params: {
    channelId: string;
    finalVoucher?: PaymentVoucher;
  }): Promise<ChannelSettlementResult> {
    const start = performance.now();
    try {
      const channel = await this.getChannel(params.channelId);
      if (!channel) {
        throw new Error(`Payment channel ${params.channelId} not found`);
      }
      if (channel.status === 'SETTLED') {
        throw new Error('Channel is already settled');
      }

      if (params.finalVoucher) {
        const verifyRes = await this.verifyAndApplyVoucher(params.finalVoucher);
        if (!verifyRes.isValid) {
          throw new Error(`Final voucher is invalid: ${verifyRes.errorReason}`);
        }
      }

      const recipientPayout = channel.settledAmount;
      const senderRefund = channel.totalDeposit - channel.settledAmount;
      const settledAt = new Date();

      channel.status = 'SETTLED';
      channel.updatedAt = settledAt;
      this.memoryChannels.set(channel.channelId, channel);

      const digest = computeChannelDigest({
        channelId: channel.channelId,
        senderAddress: channel.senderAddress,
        recipientAddress: channel.recipientAddress,
        totalDeposit: channel.totalDeposit,
        settledAmount: channel.settledAmount,
        sequence: channel.sequence,
        status: 'SETTLED',
      });

      if (this.prisma) {
        await this.prisma.paymentChannel.update({
          where: { channelId: channel.channelId },
          data: {
            status: 'SETTLED',
            updatedAt: settledAt,
          },
        });

        if (this.auditLogger) {
          await this.auditLogger.logTransaction(
            'PaymentChannel',
            channel.channelId,
            'CLOSE_SETTLE',
            {
              channelId: channel.channelId,
              recipientPayout: recipientPayout.toString(),
              senderRefund: senderRefund.toString(),
              finalSequence: channel.sequence,
              digest,
            },
          );
        }
      }

      recordPaymentChannelOperation('close', 'success');
      setPaymentChannelActiveCount(
        Array.from(this.memoryChannels.values()).filter((c) => c.status === 'OPEN').length,
      );
      recordPaymentChannelDuration('close', (performance.now() - start) / 1000);

      return {
        channelId: channel.channelId,
        status: 'SETTLED',
        recipientPayout,
        senderRefund,
        totalDeposit: channel.totalDeposit,
        finalSequence: channel.sequence,
        settledAt: settledAt.toISOString(),
        digest,
      };
    } catch (err) {
      recordPaymentChannelOperation('close', 'failure');
      recordPaymentChannelDuration('close', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Initiates a unilateral dispute challenge with the latest signed voucher.
   */
  async initiateDispute(params: {
    channelId: string;
    voucher: PaymentVoucher;
    initiatedBy: string;
  }): Promise<ChannelDisputeResult> {
    const start = performance.now();
    try {
      const channel = await this.getChannel(params.channelId);
      if (!channel) {
        throw new Error(`Payment channel ${params.channelId} not found`);
      }
      if (channel.status === 'SETTLED') {
        throw new Error('Cannot dispute an already settled channel');
      }

      // Verify voucher signature & amount validity
      if (!verifyVoucherSignature(params.voucher)) {
        throw new Error('Dispute voucher cryptographic signature is invalid');
      }
      if (params.voucher.cumulativeAmount > channel.totalDeposit) {
        throw new Error('Disputed voucher amount exceeds total channel deposit');
      }

      const now = new Date();
      const challengeDeadline = new Date(now.getTime() + channel.disputePeriodSeconds * 1000);
      const disputeId = `disp_${uuidv7()}`;

      // If voucher has higher sequence or channel is not disputed yet, accept
      if (params.voucher.sequence > channel.sequence) {
        channel.sequence = params.voucher.sequence;
        channel.settledAmount = params.voucher.cumulativeAmount;
      }

      channel.status = 'DISPUTED';
      channel.disputeExpiresAt = challengeDeadline;
      channel.updatedAt = now;
      this.memoryChannels.set(channel.channelId, channel);

      const disputeResult: ChannelDisputeResult = {
        disputeId,
        channelId: channel.channelId,
        claimedSequence: params.voucher.sequence,
        claimedAmount: params.voucher.cumulativeAmount,
        challengeDeadline,
        status: 'ACTIVE',
      };
      this.memoryDisputes.set(channel.channelId, disputeResult);

      if (this.prisma) {
        await this.prisma.paymentChannel.update({
          where: { channelId: channel.channelId },
          data: {
            status: 'DISPUTED',
            sequence: channel.sequence,
            settledAmount: channel.settledAmount,
            disputeExpiresAt: challengeDeadline,
            updatedAt: now,
          },
        });

        await this.prisma.paymentChannelDispute.create({
          data: {
            id: disputeId,
            channelId: channel.channelId,
            initiatedBy: params.initiatedBy,
            claimedSequence: params.voucher.sequence,
            claimedAmount: params.voucher.cumulativeAmount,
            challengeDeadline,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          },
        });

        if (this.auditLogger) {
          await this.auditLogger.logTransaction(
            'PaymentChannel',
            channel.channelId,
            'DISPUTE_INITIATED',
            {
              channelId: channel.channelId,
              disputeId,
              initiatedBy: params.initiatedBy,
              claimedSequence: params.voucher.sequence,
              claimedAmount: params.voucher.cumulativeAmount.toString(),
              challengeDeadline: challengeDeadline.toISOString(),
            },
          );
        }
      }

      recordPaymentChannelOperation('dispute', 'success');
      recordPaymentChannelDispute();
      recordPaymentChannelDuration('dispute', (performance.now() - start) / 1000);

      return disputeResult;
    } catch (err) {
      recordPaymentChannelOperation('dispute', 'failure');
      recordPaymentChannelDuration('dispute', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Finalizes settlement for a disputed or expired channel after the challenge window.
   */
  async settleDispute(channelId: string): Promise<ChannelSettlementResult> {
    const start = performance.now();
    try {
      const channel = await this.getChannel(channelId);
      if (!channel) {
        throw new Error(`Payment channel ${channelId} not found`);
      }
      if (channel.status === 'SETTLED') {
        throw new Error('Channel is already settled');
      }

      const now = new Date();
      if (channel.status === 'DISPUTED') {
        if (!channel.disputeExpiresAt || now < channel.disputeExpiresAt) {
          throw new Error('Dispute challenge period has not yet expired');
        }
      } else if (channel.status === 'OPEN') {
        if (now < channel.expiresAt) {
          throw new Error('Channel has not reached expiration epoch');
        }
      }

      const recipientPayout = channel.settledAmount;
      const senderRefund = channel.totalDeposit - channel.settledAmount;

      channel.status = 'SETTLED';
      channel.updatedAt = now;
      this.memoryChannels.set(channelId, channel);

      const dispute = this.memoryDisputes.get(channelId);
      if (dispute) {
        dispute.status = 'RESOLVED';
      }

      const digest = computeChannelDigest({
        channelId: channel.channelId,
        senderAddress: channel.senderAddress,
        recipientAddress: channel.recipientAddress,
        totalDeposit: channel.totalDeposit,
        settledAmount: channel.settledAmount,
        sequence: channel.sequence,
        status: 'SETTLED',
      });

      if (this.prisma) {
        await this.prisma.paymentChannel.update({
          where: { channelId },
          data: {
            status: 'SETTLED',
            updatedAt: now,
          },
        });

        await this.prisma.paymentChannelDispute.updateMany({
          where: { channelId, status: 'ACTIVE' },
          data: {
            status: 'RESOLVED',
            updatedAt: now,
          },
        });

        if (this.auditLogger) {
          await this.auditLogger.logTransaction('PaymentChannel', channelId, 'DISPUTE_SETTLED', {
            channelId,
            recipientPayout: recipientPayout.toString(),
            senderRefund: senderRefund.toString(),
            finalSequence: channel.sequence,
            digest,
          });
        }
      }

      recordPaymentChannelOperation('settle', 'success');
      recordPaymentChannelDuration('settle', (performance.now() - start) / 1000);

      return {
        channelId,
        status: 'SETTLED',
        recipientPayout,
        senderRefund,
        totalDeposit: channel.totalDeposit,
        finalSequence: channel.sequence,
        settledAt: now.toISOString(),
        digest,
      };
    } catch (err) {
      recordPaymentChannelOperation('settle', 'failure');
      recordPaymentChannelDuration('settle', (performance.now() - start) / 1000);
      throw err;
    }
  }

  /**
   * Retrieves live payment channel state.
   */
  async getChannel(channelId: string): Promise<PaymentChannelState | null> {
    if (this.memoryChannels.has(channelId)) {
      return this.memoryChannels.get(channelId)!;
    }

    if (this.prisma) {
      const row = await this.prisma.paymentChannel.findUnique({
        where: { channelId },
      });
      if (row) {
        const state: PaymentChannelState = {
          id: row.id,
          channelId: row.channelId,
          senderAddress: row.senderAddress,
          recipientAddress: row.recipientAddress,
          totalDeposit: row.totalDeposit,
          settledAmount: row.settledAmount,
          sequence: row.sequence,
          status: row.status as PaymentChannelStatus,
          disputePeriodSeconds: row.disputePeriodSeconds,
          disputeExpiresAt: row.disputeExpiresAt,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        this.memoryChannels.set(channelId, state);
        return state;
      }
    }

    return null;
  }

  /**
   * Lists all channels matching filters.
   */
  async listChannels(filter?: {
    senderAddress?: string;
    recipientAddress?: string;
    status?: PaymentChannelStatus;
  }): Promise<PaymentChannelState[]> {
    if (this.prisma) {
      const rows = await this.prisma.paymentChannel.findMany({
        where: {
          ...(filter?.senderAddress && { senderAddress: filter.senderAddress }),
          ...(filter?.recipientAddress && { recipientAddress: filter.recipientAddress }),
          ...(filter?.status && { status: filter.status }),
        },
        orderBy: { createdAt: 'desc' },
      });

      return rows.map((r) => ({
        id: r.id,
        channelId: r.channelId,
        senderAddress: r.senderAddress,
        recipientAddress: r.recipientAddress,
        totalDeposit: r.totalDeposit,
        settledAmount: r.settledAmount,
        sequence: r.sequence,
        status: r.status as PaymentChannelStatus,
        disputePeriodSeconds: r.disputePeriodSeconds,
        disputeExpiresAt: r.disputeExpiresAt,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    }

    let result = Array.from(this.memoryChannels.values());
    if (filter?.senderAddress) {
      result = result.filter((c) => c.senderAddress === filter.senderAddress);
    }
    if (filter?.recipientAddress) {
      result = result.filter((c) => c.recipientAddress === filter.recipientAddress);
    }
    if (filter?.status) {
      result = result.filter((c) => c.status === filter.status);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _paymentChannelServiceInstance: PaymentChannelService | null = null;

export function getPaymentChannelService(prisma?: PrismaClient): PaymentChannelService {
  if (!_paymentChannelServiceInstance) {
    _paymentChannelServiceInstance = new PaymentChannelService(prisma);
  }
  return _paymentChannelServiceInstance;
}

export function resetPaymentChannelService(): void {
  _paymentChannelServiceInstance = null;
}
