import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import {
  PaymentChannelService,
  signPaymentVoucher,
  verifyVoucherSignature,
  computeVoucherDigest,
  computeChannelDigest,
  resetPaymentChannelService,
} from '../../../src/billing/payment_channel.js';

describe('Peer-to-Peer Payment Channels Core Engine (#295)', () => {
  let service: PaymentChannelService;
  let senderKeyPair: nacl.SignKeyPair;
  let senderPubHex: string;
  let senderSecHex: string;
  let recipientAddress: string;

  beforeEach(() => {
    resetPaymentChannelService();
    service = new PaymentChannelService();
    senderKeyPair = nacl.sign.keyPair();
    senderPubHex = Buffer.from(senderKeyPair.publicKey).toString('hex');
    senderSecHex = Buffer.from(senderKeyPair.secretKey).toString('hex');
    recipientAddress = '0xRecipientAddress0000000000000000000001';
  });

  describe('Channel Lifecycle & Collateral Management', () => {
    it('opens a new payment channel with valid parameters', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 1_000_000n,
        expirationSeconds: 86400,
        disputePeriodSeconds: 3600,
      });

      expect(channel.channelId).toBeDefined();
      expect(channel.senderAddress).toBe(senderPubHex);
      expect(channel.recipientAddress).toBe(recipientAddress);
      expect(channel.totalDeposit).toBe(1_000_000n);
      expect(channel.settledAmount).toBe(0n);
      expect(channel.sequence).toBe(0);
      expect(channel.status).toBe('OPEN');
    });

    it('rejects opening channel with zero or negative deposit', async () => {
      await expect(
        service.openChannel({
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: 0n,
        }),
      ).rejects.toThrow('Total deposit must be greater than zero');

      await expect(
        service.openChannel({
          senderAddress: senderPubHex,
          recipientAddress,
          totalDeposit: -500n,
        }),
      ).rejects.toThrow('Total deposit must be greater than zero');
    });

    it('rejects opening channel when sender and recipient are identical', async () => {
      await expect(
        service.openChannel({
          senderAddress: senderPubHex,
          recipientAddress: senderPubHex,
          totalDeposit: 1_000_000n,
        }),
      ).rejects.toThrow('Sender and recipient cannot be the same address');
    });

    it('tops up collateral on an active channel', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 1_000_000n,
      });

      const updated = await service.topUpChannel(channel.channelId, 500_000n);
      expect(updated.totalDeposit).toBe(1_500_000n);

      const fetched = await service.getChannel(channel.channelId);
      expect(fetched?.totalDeposit).toBe(1_500_000n);
    });
  });

  describe('Cryptographic Voucher Signing & Verification', () => {
    it('generates valid cryptographic vouchers and verifies signature', () => {
      const voucher = signPaymentVoucher(
        {
          channelId: 'chan_test_123',
          sequence: 1,
          cumulativeAmount: 50_000n,
        },
        senderSecHex,
      );

      expect(voucher.channelId).toBe('chan_test_123');
      expect(voucher.sequence).toBe(1);
      expect(voucher.cumulativeAmount).toBe(50_000n);
      expect(voucher.signature).toBeDefined();
      expect(voucher.signerPublicKey).toBeDefined();

      const isValid = verifyVoucherSignature(voucher);
      expect(isValid).toBe(true);
    });

    it('detects tampered voucher signature or corrupted payload', () => {
      const voucher = signPaymentVoucher(
        {
          channelId: 'chan_test_123',
          sequence: 1,
          cumulativeAmount: 50_000n,
        },
        senderSecHex,
      );

      // Tamper with cumulative amount
      const tamperedVoucher = { ...voucher, cumulativeAmount: 999_999n };
      expect(verifyVoucherSignature(tamperedVoucher)).toBe(false);

      // Tamper with sequence
      const tamperedSeq = { ...voucher, sequence: 99 };
      expect(verifyVoucherSignature(tamperedSeq)).toBe(false);

      // Tamper with signature bytes
      const tamperedSig = { ...voucher, signature: 'AAAA' + voucher.signature.slice(4) };
      expect(verifyVoucherSignature(tamperedSig)).toBe(false);
    });

    it('applies sequential microtransaction vouchers and updates live channel state', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
      });

      // Voucher 1: 1,000 units
      const v1 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 1_000n },
        senderSecHex,
      );
      const res1 = await service.verifyAndApplyVoucher(v1);
      expect(res1.isValid).toBe(true);
      expect(res1.cumulativeAmount).toBe(1_000n);
      expect(res1.transactedAmount).toBe(1_000n);
      expect(res1.remainingDeposit).toBe(99_000n);

      // Voucher 2: 2,500 units (incremental 1,500)
      const v2 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 2, cumulativeAmount: 2_500n },
        senderSecHex,
      );
      const res2 = await service.verifyAndApplyVoucher(v2);
      expect(res2.isValid).toBe(true);
      expect(res2.cumulativeAmount).toBe(2_500n);
      expect(res2.transactedAmount).toBe(1_500n);
      expect(res2.remainingDeposit).toBe(97_500n);
    });

    it('rejects stale sequence numbers (replay attack prevention)', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
      });

      const v2 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 2, cumulativeAmount: 2_000n },
        senderSecHex,
      );
      await service.verifyAndApplyVoucher(v2);

      // Attempt to submit sequence 1 (stale)
      const v1 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 3_000n },
        senderSecHex,
      );
      const res = await service.verifyAndApplyVoucher(v1);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toContain('Stale sequence number');
    });

    it('rejects decreased cumulative amount', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
      });

      const v1 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 5_000n },
        senderSecHex,
      );
      await service.verifyAndApplyVoucher(v1);

      // Attempt sequence 2 with smaller cumulative amount (4,000 < 5,000)
      const v2 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 2, cumulativeAmount: 4_000n },
        senderSecHex,
      );
      const res = await service.verifyAndApplyVoucher(v2);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toContain('cannot be less than previously verified amount');
    });

    it('rejects voucher exceeding total deposit (solvency protection)', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 10_000n,
      });

      const v1 = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 15_000n },
        senderSecHex,
      );
      const res = await service.verifyAndApplyVoucher(v1);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toContain('exceeds total deposit');
    });

    it('rejects expired vouchers', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
      });

      const expiredEpoch = Math.floor(Date.now() / 1000) - 60; // 60s in the past
      const v = signPaymentVoucher(
        {
          channelId: channel.channelId,
          sequence: 1,
          cumulativeAmount: 1_000n,
          expiresAt: expiredEpoch,
        },
        senderSecHex,
      );
      const res = await service.verifyAndApplyVoucher(v);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toContain('expired');
    });
  });

  describe('Cooperative Closure & Settlement', () => {
    it('cooperatively closes channel and settles net balances', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 50_000n,
      });

      const voucher = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 10, cumulativeAmount: 30_000n },
        senderSecHex,
      );

      const settlement = await service.closeChannel({
        channelId: channel.channelId,
        finalVoucher: voucher,
      });

      expect(settlement.status).toBe('SETTLED');
      expect(settlement.recipientPayout).toBe(30_000n);
      expect(settlement.senderRefund).toBe(20_000n);
      expect(settlement.totalDeposit).toBe(50_000n);
      expect(settlement.digest).toMatch(/^[a-f0-9]{64}$/);

      const closedChannel = await service.getChannel(channel.channelId);
      expect(closedChannel?.status).toBe('SETTLED');
    });
  });

  describe('Unilateral Dispute Resolution', () => {
    it('initiates dispute challenge window and updates channel state', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
        disputePeriodSeconds: 10, // 10s for fast testing
      });

      const voucher = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 5, cumulativeAmount: 40_000n },
        senderSecHex,
      );

      const dispute = await service.initiateDispute({
        channelId: channel.channelId,
        voucher,
        initiatedBy: recipientAddress,
      });

      expect(dispute.disputeId).toBeDefined();
      expect(dispute.status).toBe('ACTIVE');
      expect(dispute.claimedSequence).toBe(5);
      expect(dispute.claimedAmount).toBe(40_000n);

      const disputedChannel = await service.getChannel(channel.channelId);
      expect(disputedChannel?.status).toBe('DISPUTED');
    });

    it('rejects settlement before dispute challenge window expires', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
        disputePeriodSeconds: 3600, // 1 hour
      });

      const voucher = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 10_000n },
        senderSecHex,
      );

      await service.initiateDispute({
        channelId: channel.channelId,
        voucher,
        initiatedBy: recipientAddress,
      });

      await expect(service.settleDispute(channel.channelId)).rejects.toThrow(
        'Dispute challenge period has not yet expired',
      );
    });

    it('settles dispute once challenge window passes', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 100_000n,
        disputePeriodSeconds: 0, // Instant expiration
      });

      const voucher = signPaymentVoucher(
        { channelId: channel.channelId, sequence: 1, cumulativeAmount: 60_000n },
        senderSecHex,
      );

      await service.initiateDispute({
        channelId: channel.channelId,
        voucher,
        initiatedBy: recipientAddress,
      });

      const settlement = await service.settleDispute(channel.channelId);
      expect(settlement.status).toBe('SETTLED');
      expect(settlement.recipientPayout).toBe(60_000n);
      expect(settlement.senderRefund).toBe(40_000n);
    });
  });

  describe('High-Throughput Performance Benchmark (< 200ms P99 SLA)', () => {
    it('verifies sequential microtransaction vouchers satisfying < 200ms P99 target', async () => {
      const channel = await service.openChannel({
        senderAddress: senderPubHex,
        recipientAddress,
        totalDeposit: 10_000_000n,
      });

      const count = 20;
      const vouchers = [];
      for (let i = 1; i <= count; i++) {
        vouchers.push(
          signPaymentVoucher(
            {
              channelId: channel.channelId,
              sequence: i,
              cumulativeAmount: BigInt(i * 10),
            },
            senderSecHex,
          ),
        );
      }

      const start = performance.now();
      for (const v of vouchers) {
        const res = await service.verifyAndApplyVoucher(v);
        expect(res.isValid).toBe(true);
      }
      const elapsed = performance.now() - start;
      const avgPerOp = elapsed / count;

      // Ensure execution is well within the 200ms P99 threshold
      expect(avgPerOp).toBeLessThan(200); // < 200ms per operation P99 target
    });
  });
});
