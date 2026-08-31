import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  MemoTransferLedger,
  amountStringToStroops,
} from '../../../src/billing/memo_transfer.js';

describe('Real-Time Balance Tracking with Memo-Based Transfers (#282)', () => {
  const KEY = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
  const ACCOUNT = 'acc-001';
  let nowMs: number;
  let ledger: MemoTransferLedger;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    ledger = new MemoTransferLedger({
      hmacKey: KEY,
      now: () => nowMs,
      memoValidityMs: 10 * 60 * 1000,
    });
  });

  const step = (ms: number) => { nowMs += ms; };

  describe('amount parsing', () => {
    it('parses XLM decimal strings into stroops without float loss', () => {
      expect(amountStringToStroops('0.0001000')).toBe(1000n);
      expect(amountStringToStroops('123.4567890')).toBe(1_234_567_890n);
      expect(amountStringToStroops('2')).toBe(20_000_000n);
      expect(amountStringToStroops('0.0000001')).toBe(1n);
    });

    it('truncates beyond 7 decimals and rejects garbage', () => {
      expect(amountStringToStroops('1.123456789')).toBe(11_234_567n);
      expect(() => amountStringToStroops('abc')).toThrow();
      expect(() => amountStringToStroops('1.2.3')).toThrow();
      expect(() => amountStringToStroops('')).toThrow();
    });
  });

  describe('memo issuance', () => {
    it('issues IOT1-prefixed memo with nonce and expiry', () => {
      const { memo, nonce, expiresAt } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      expect(memo.startsWith('IOT1:')).toBe(true);
      expect(memo.split(':').length).toBe(3);
      expect(nonce).toBeTruthy();
      expect(expiresAt).toBe(nowMs + 10 * 60 * 1000);
    });

    it('rejects zero/negative amounts and empty accounts', () => {
      expect(() => ledger.issueMemo(ACCOUNT, 0n)).toThrow();
      expect(() => ledger.issueMemo(ACCOUNT, -5n)).toThrow();
      expect(() => ledger.issueMemo('  ', 5n)).toThrow();
    });

    it('rejects short HMAC keys at construction', () => {
      expect(() => new MemoTransferLedger({ hmacKey: 'short' })).toThrow();
      expect(() => new MemoTransferLedger({ hmacKey: undefined as unknown as string })).toThrow();
    });
  });

  describe('attribution & verification', () => {
    it('attributes a valid memo and credits the balance', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      const res = ledger.attribute(memo);
      expect(res.isValid).toBe(true);
      expect(res.errorReason).toBeUndefined();
      expect(res.attributed!.accountId).toBe(ACCOUNT);
      expect(res.attributed!.amountStroops).toBe(1_000_000n);
      expect(res.balanceStroops).toBe(1_000_000n);
    });

    it('accumulates balances across multiple transfers', () => {
      const m1 = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      ledger.attribute(m1.memo);
      step(1000);
      const m2 = ledger.issueMemo(ACCOUNT, 500_000n, nowMs);
      const res = ledger.attribute(m2.memo);
      expect(res.isValid).toBe(true);
      expect(res.balanceStroops).toBe(1_500_000n);
    });

    it('rejects tampered amount (HMAC mismatch)', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      const [prefix, payload, mac] = memo.split(':');
      const tampered = Buffer.from(payload, 'base64url').toString('utf8')
        .replace('"amount":"0.1000000"', '"amount":"9.9000000"');
      const tamperedMemo = `${prefix}:${Buffer.from(tampered).toString('base64url')}:${mac}`;
      const res = ledger.attribute(tamperedMemo);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toBe('bad_hmac');
      expect(ledger.balance(ACCOUNT)).toBe(0n);
    });

    it('rejects a memo signed with a different key', () => {
      const other = new MemoTransferLedger({
        hmacKey: Buffer.from('ffffffffffffffffffffffffffffffff'),
        now: () => nowMs,
      });
      const { memo } = other.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      const res = ledger.attribute(memo);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toBe('bad_hmac');
    });

    it('rejects malformed memos', () => {
      expect(ledger.attribute('not-a-memo').errorReason).toBe('malformed');
      expect(ledger.attribute('XXX:aaa:bbb').errorReason).toBe('malformed');
      expect(ledger.attribute('IOT1:!!!not-base64!!!:zzz').errorReason).toBe('bad_hmac');
    });

    it('rejects memos outside the acceptance window', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      step(11 * 60 * 1000); // beyond 10-minute window
      const res = ledger.attribute(memo);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toBe('expired');
    });

    it('rejects zero-amount payloads inside a valid HMAC', () => {
      // Hand-craft a signed memo with a zero amount to hit the amount guard.
      const payload = JSON.stringify({ v: 1, account: ACCOUNT, amount: '0.0000000', ts: nowMs, nonce: 'n1' });
      const payloadB64 = Buffer.from(payload).toString('base64url');
      const mac = require('node:crypto').createHmac('sha256', KEY)
        .update(`IOT1:${payloadB64}`).digest();
      const memo = `IOT1:${payloadB64}:${Buffer.from(mac).toString('base64url')}`;
      const res = ledger.attribute(memo);
      expect(res.isValid).toBe(false);
      expect(res.errorReason).toBe('bad_amount');
    });

    it('blocks replay of the same memo (idempotent, no double credit)', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      const first = ledger.attribute(memo);
      expect(first.isValid).toBe(true);
      const second = ledger.attribute(memo);
      expect(second.isValid).toBe(true); // idempotent echo
      expect(second.errorReason).toBe('replay');
      expect(second.attributed!.digest).toBe(first.attributed!.digest);
      expect(ledger.balance(ACCOUNT)).toBe(1_000_000n); // credited once
    });

    it('blocks nonce reuse across different memos for the same account', () => {
      // Build two memos with the same nonce but different HMACs (hand-signed).
      const mk = (amount: string, nonce: string) => {
        const payload = JSON.stringify({ v: 1, account: ACCOUNT, amount, ts: nowMs, nonce });
        const payloadB64 = Buffer.from(payload).toString('base64url');
        const mac = require('node:crypto').createHmac('sha256', KEY)
          .update(`IOT1:${payloadB64}`).digest();
        return `IOT1:${payloadB64}:${Buffer.from(mac).toString('base64url')}`;
      };
      const first = ledger.attribute(mk('1.0000000', 'nonce-x'));
      expect(first.isValid).toBe(true);
      const second = ledger.attribute(mk('2.0000000', 'nonce-x'));
      expect(second.isValid).toBe(false);
      expect(second.errorReason).toBe('replay');
      expect(ledger.balance(ACCOUNT)).toBe(10_000_000n); // credited once
    });

    it('emits audit events for accepted and rejected attributions', () => {
      const events: { kind: string; detail: Record<string, unknown> }[] = [];
      const audit = new MemoTransferLedger({
        hmacKey: KEY,
        now: () => nowMs,
        onEvent: (e) => events.push({ kind: e.kind, detail: e.detail }),
      });
      audit.attribute('garbage');
      const { memo } = audit.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      audit.attribute(memo);
      audit.attribute(memo); // replay
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['rejected', 'attributed', 'replayed']);
    });
  });

  describe('real-time balance & chain integrity', () => {
    it('returns zero balance for unknown accounts', () => {
      expect(ledger.balance('nobody')).toBe(0n);
      expect(ledger.transfers('nobody')).toEqual([]);
    });

    it('maintains a verifiable append-only chain', () => {
      for (const amt of [1_000_000n, 2_000_000n, 3_500_000n]) {
        step(500);
        const { memo } = ledger.issueMemo(ACCOUNT, amt, nowMs);
        expect(ledger.attribute(memo).isValid).toBe(true);
      }
      const check = ledger.verifyChain(ACCOUNT);
      expect(check.valid).toBe(true);
      expect(check.entries).toBe(3);
      expect(check.brokenAt).toBeNull();
      expect(ledger.balance(ACCOUNT)).toBe(6_500_000n);
      expect(ledger.transfers(ACCOUNT).length).toBe(3);
    });

    it('detects tampering when an entry is removed', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      ledger.attribute(memo);
      step(500);
      const m2 = ledger.issueMemo(ACCOUNT, 2_000_000n, nowMs);
      ledger.attribute(m2.memo);
      expect(ledger.verifyChain(ACCOUNT).valid).toBe(true);

      // Simulate tampering: drop the first entry from the internal store.
      const internal = (ledger as unknown as { ledgers: Map<string, { entries: unknown[]; balance: bigint }> })
        .ledgers.get(ACCOUNT)!;
      internal.entries.shift();
      const check = ledger.verifyChain(ACCOUNT);
      expect(check.valid).toBe(false);
      expect(check.brokenAt).not.toBeNull();
    });
  });

  describe('on-chain reconciliation', () => {
    it('reports no discrepancy when ledger matches on-chain', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      ledger.attribute(memo);
      const res = ledger.reconcile(ACCOUNT, 1_000_000n);
      expect(res.corrected).toBe(false);
      expect(res.discrepancyStroops).toBe(0n);
      expect(ledger.accountsPendingCorrection()).toEqual([]);
    });

    it('corrects the ledger to on-chain truth when they diverge', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      ledger.attribute(memo);
      const res = ledger.reconcile(ACCOUNT, 800_000n);
      expect(res.corrected).toBe(true);
      expect(res.discrepancyStroops).toBe(200_000n);
      expect(res.ledgerBalanceStroops).toBe(800_000n);
      expect(ledger.balance(ACCOUNT)).toBe(800_000n);
      expect(ledger.accountsPendingCorrection()).toEqual([ACCOUNT]);
      // Correction is part of the chain and keeps it verifiable.
      expect(ledger.verifyChain(ACCOUNT).valid).toBe(true);
    });

    it('clears the pending-correction flag after a clean reconcile', () => {
      const { memo } = ledger.issueMemo(ACCOUNT, 1_000_000n, nowMs);
      ledger.attribute(memo);
      ledger.reconcile(ACCOUNT, 500_000n);
      expect(ledger.accountsPendingCorrection()).toEqual([ACCOUNT]);
      ledger.reconcile(ACCOUNT, 500_000n);
      expect(ledger.accountsPendingCorrection()).toEqual([]);
    });

    it('reconciles unknown accounts without creating debt', () => {
      const res = ledger.reconcile('ghost', 0n);
      expect(res.corrected).toBe(false);
      expect(ledger.balance('ghost')).toBe(0n);
    });
  });
});
