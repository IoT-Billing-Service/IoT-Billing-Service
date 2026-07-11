import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorDecoder, SorobanHostFuncError, isRetryableError } from './errorDecoder';

describe('ErrorDecoder', () => {
  let decoder: ErrorDecoder;

  beforeEach(() => {
    decoder = new ErrorDecoder();
  });

  describe('tryDecode', () => {
    it('handles null and undefined', () => {
      expect(decoder.tryDecode(null)).toBe('An unknown error occurred. Please try again.');
      expect(decoder.tryDecode(undefined)).toBe('An unknown error occurred. Please try again.');
      expect(decoder.tryDecode('')).toBe('An unknown error occurred. Please try again.');
    });

    it('decodes Stellar error codes', () => {
      expect(decoder.tryDecode('tx_bad_seq')).toContain('sequence number');
      expect(decoder.tryDecode('tx_insufficient_fee')).toContain('fees');
      expect(decoder.tryDecode('tx_failed')).toContain('Transaction execution failed');
      expect(decoder.tryDecode('contract_not_found')).toContain('contract was not found');
    });

    it('decodes RPC error codes', () => {
      expect(decoder.tryDecode('-32000')).toContain('RPC server is unavailable');
      expect(decoder.tryDecode('-32603')).toContain('Internal RPC error');
    });

    it('decodes Soroban host function errors', () => {
      expect(decoder.tryDecode(SorobanHostFuncError.StorageError)).toContain(
        'storage read exceeded',
      );
      expect(decoder.tryDecode(SorobanHostFuncError.CpuLimitExceeded)).toContain(
        'CPU instruction limit',
      );
      expect(decoder.tryDecode(SorobanHostFuncError.ContractError)).toContain(
        'contract returned an error',
      );
    });

    it('decodes generic error strings via fallback patterns', () => {
      expect(decoder.tryDecode('insufficient funds')).toContain('Insufficient balance');
      expect(decoder.tryDecode('request timed out')).toContain('timed out');
      expect(decoder.tryDecode('user denied')).toContain('rejected');
      expect(decoder.tryDecode('network error')).toContain('Network connection error');
    });

    it('handles RPC-style error objects', () => {
      const rpcError = { code: '-32001', message: 'rate limit' };
      expect(decoder.tryDecode(rpcError)).toContain('Resource exhaustion');
    });

    it('handles Soroban RPC error objects with contract results', () => {
      const sorobanError = {
        code: -32002,
        message: 'simulation failed',
        data: {
          contractResults: [{ error: SorobanHostFuncError.StorageError }],
        },
      };
      expect(decoder.tryDecode(sorobanError)).toContain('storage read exceeded');
    });

    it('handles Soroban RPC error objects with txResult', () => {
      const errorWithTxResult = {
        data: {
          txResult: { result: 'tx_bad_seq' },
        },
      };
      expect(decoder.tryDecode(errorWithTxResult)).toContain('sequence number');
    });

    it('extracts message from error objects', () => {
      const objError = { message: 'insufficient funds for operation' };
      expect(decoder.tryDecode(objError)).toContain('Insufficient balance');
    });

    it('falls back to generic unhandled error', () => {
      const result = decoder.tryDecode('some_completely_unknown_error_code');
      expect(result).toContain('Unhandled error');
    });
  });

  describe('registerContractErrors', () => {
    it('resolves per-contract error codes', () => {
      decoder.registerContractErrors('0x1234', {
        100: 'Custom contract error: insufficient liquidity.',
      });

      const error = { code: 100, contractId: '0x1234' };
      expect(decoder.tryDecode(error)).toBe('Custom contract error: insufficient liquidity.');
    });

    it('falls back to host error map for unknown contract codes', () => {
      decoder.registerContractErrors('0x1234', {
        99: 'Custom error',
      });

      const error = { code: SorobanHostFuncError.StorageError, contractId: '0x1234' };
      expect(decoder.tryDecode(error)).toContain('storage read exceeded');
    });
  });

  describe('simulation error patterns', () => {
    it('decodes budget exceeded simulation errors', () => {
      expect(decoder.tryDecode('hostError: budget exceeded during execution')).toContain(
        'budget exceeded',
      );
    });

    it('decodes CPU limit simulation errors', () => {
      expect(decoder.tryDecode('hostError: cpu limit reached')).toContain('CPU instruction');
    });

    it('decodes contract not found errors', () => {
      expect(decoder.tryDecode('contract CABCDE... was not found')).toContain('Contract not found');
    });

    it('decodes sequence mismatch errors', () => {
      expect(decoder.tryDecode('sequence number mismatch')).toContain('Sequence number mismatch');
    });

    it('decodes footprint overlap errors', () => {
      expect(decoder.tryDecode('footprint overlap detected')).toContain('footprint overlaps');
    });

    it('decodes expired entry errors', () => {
      expect(decoder.tryDecode('expired ledger entry referenced')).toContain(
        'expired ledger entry',
      );
    });

    it('decodes restoration required errors', () => {
      expect(decoder.tryDecode('restore is required before submission')).toContain(
        'restoration is required',
      );
    });

    it('decodes classic fee exceeded errors', () => {
      expect(decoder.tryDecode('classic fee exceeds the maximum')).toContain(
        'classic (inclusion) fee',
      );
    });
  });

  describe('isRetryableError', () => {
    it('returns true for retryable codes', () => {
      expect(isRetryableError('tx_bad_seq')).toBe(true);
      expect(isRetryableError('-32000')).toBe(true);
    });

    it('returns false for non-retryable codes', () => {
      expect(isRetryableError('tx_failed')).toBe(false);
      expect(isRetryableError('contract_error')).toBe(false);
    });
  });
});
