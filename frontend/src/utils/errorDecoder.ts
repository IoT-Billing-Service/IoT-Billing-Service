import { t } from '@/utils/i18n';

export enum SorobanHostFuncError {
  UnknownError = 0,
  ContractError = 1,
  ValueError = 2,
  AccessError = 3,
  StorageError = 4,
  XdrError = 5,
  UnexpectedTypeError = 6,
  ReadOnlyError = 7,
  ObjectError = 8,
  CryptoError = 9,
  CpuLimitExceeded = 10,
  LinearMemoryLimitExceeded = 11,
  ArithError = 12,
  UnexpectedDataError = 13,
  ReentryError = 14,
  BudgetExceeded = 15,
  NetworkConfigError = 16,
  LedgerUpgradeError = 17,
}

const SOROBAN_HOST_ERROR_MAP: Record<number, string> = {
  [SorobanHostFuncError.UnknownError]: t(
    'soroban.host.unknown',
    'Unknown Soroban host error. Contact support.',
  ),
  [SorobanHostFuncError.ContractError]: t(
    'soroban.host.contract',
    'The contract returned an error during execution.',
  ),
  [SorobanHostFuncError.ValueError]: t(
    'soroban.host.value',
    'Invalid value passed to a host function. Check parameter types.',
  ),
  [SorobanHostFuncError.AccessError]: t(
    'soroban.host.access',
    'Access denied to the requested storage entry.',
  ),
  [SorobanHostFuncError.StorageError]: t(
    'soroban.host.storage',
    'Contract storage read exceeded the per-ledger limit.',
  ),
  [SorobanHostFuncError.XdrError]: t(
    'soroban.host.xdr',
    'Failed to decode XDR in the host function.',
  ),
  [SorobanHostFuncError.UnexpectedTypeError]: t(
    'soroban.host.type',
    'Unexpected SCVal type encountered during execution.',
  ),
  [SorobanHostFuncError.ReadOnlyError]: t(
    'soroban.host.readonly',
    'Attempted to write to read-only storage.',
  ),
  [SorobanHostFuncError.ObjectError]: t(
    'soroban.host.object',
    'Invalid object handle referenced in the host.',
  ),
  [SorobanHostFuncError.CryptoError]: t(
    'soroban.host.crypto',
    'Cryptographic operation failed in the host.',
  ),
  [SorobanHostFuncError.CpuLimitExceeded]: t(
    'soroban.host.cpu',
    'Contract exceeded the CPU instruction limit.',
  ),
  [SorobanHostFuncError.LinearMemoryLimitExceeded]: t(
    'soroban.host.memory',
    'Contract exceeded the linear memory limit.',
  ),
  [SorobanHostFuncError.ArithError]: t(
    'soroban.host.arith',
    'Arithmetic overflow or underflow in contract execution.',
  ),
  [SorobanHostFuncError.UnexpectedDataError]: t(
    'soroban.host.data',
    'Unexpected data format from the Soroban host.',
  ),
  [SorobanHostFuncError.ReentryError]: t(
    'soroban.host.reentry',
    'Reentrant call detected and blocked by the host.',
  ),
  [SorobanHostFuncError.BudgetExceeded]: t(
    'soroban.host.budget',
    'Contract resource budget was exceeded.',
  ),
  [SorobanHostFuncError.NetworkConfigError]: t(
    'soroban.host.network',
    'Network configuration error in the host environment.',
  ),
  [SorobanHostFuncError.LedgerUpgradeError]: t(
    'soroban.host.ledger',
    'Ledger upgrade operation failed in the host.',
  ),
};

const STELLAR_ERROR_MAP: Record<string, string> = {
  tx_bad_seq: t(
    'stellar.tx_bad_seq',
    'Transaction sequence number mismatch. Refresh your wallet and try again.',
  ),
  tx_insufficient_fee: t(
    'stellar.tx_insufficient_fee',
    'Network fees are too low for current congestion. Increase the fee budget.',
  ),
  tx_failed: t(
    'stellar.tx_failed',
    'Transaction execution failed on the Soroban network. Check contract parameters.',
  ),
  tx_too_late: t(
    'stellar.tx_too_late',
    'Transaction submission timed out. The network slot has expired.',
  ),
  op_underfunded: t(
    'stellar.op_underfunded',
    'Insufficient balance for this operation, including required fees.',
  ),
  op_low_reserve: t(
    'stellar.op_low_reserve',
    'Insufficient native asset reserve. Maintain minimum XLM balance.',
  ),
  op_malformed: t(
    'stellar.op_malformed',
    'Operation parameters are malformed. Verify all inputs before retrying.',
  ),
  op_bad_auth: t(
    'stellar.op_bad_auth',
    'Authorization verification failed. Wallet keys may not match the signer.',
  ),
  contract_not_found: t(
    'stellar.contract_not_found',
    'The target Soroban contract was not found on this network. Verify contract ID.',
  ),
  contract_error: t(
    'stellar.contract_error',
    'The Soroban contract returned an error during execution. Check contract logs.',
  ),
  fee_insufficient: t(
    'stellar.fee_insufficient',
    'The fee submitted is below the network minimum for this transaction type.',
  ),
  bad_sponsorship: t(
    'stellar.bad_sponsorship',
    'Sponsorship configuration is invalid. Contact your contract administrator.',
  ),
};

const RPC_ERROR_MAP: Record<string, string> = {
  '-32000': t(
    'rpc.unavailable',
    'RPC server is unavailable. Check your connection to the Stellar RPC endpoint.',
  ),
  '-32001': t(
    'rpc.resource_exhausted',
    'Resource exhaustion on RPC. Throttle request rate or upgrade your endpoint plan.',
  ),
  '-32002': t(
    'rpc.simulation_failed',
    'Transaction simulation failed. The contract call parameters may be invalid.',
  ),
  '-32601': t(
    'rpc.method_not_found',
    'Method not found on RPC. Your Stellar SDK version may be outdated.',
  ),
  '-32603': t(
    'rpc.internal_error',
    'Internal RPC error. The node encountered an unexpected condition.',
  ),
};

const SIMULATION_ERROR_PATTERNS: [RegExp, string][] = [
  [
    /hostError.*budget exceeded/i,
    t(
      'simulation.budget',
      'Contract budget exceeded during simulation. Reduce the operation scope.',
    ),
  ],
  [
    /hostError.*cpu limit/i,
    t(
      'simulation.cpu',
      'CPU instruction limit reached during simulation. Try a simpler transaction.',
    ),
  ],
  [
    /hostError.*linear memory/i,
    t(
      'simulation.memory',
      'Linear memory limit exceeded during simulation. Try a smaller payload.',
    ),
  ],
  [
    /contract.*not found/i,
    t(
      'simulation.contract_not_found',
      'Contract not found on network. Verify the contract ID and network.',
    ),
  ],
  [
    /insufficient.*resource/i,
    t(
      'simulation.insufficient_resource',
      'Insufficient resources allocated for simulation. Increase the fee budget.',
    ),
  ],
  [
    /sequence.*mismatch/i,
    t('simulation.seq_mismatch', 'Sequence number mismatch. Refresh and try again.'),
  ],
  [
    /footprint.*overlap/i,
    t(
      'simulation.footprint_overlap',
      'Ledger entry footprint overlaps with an existing transaction. Wait and retry.',
    ),
  ],
  [
    /expired.*entry/i,
    t(
      'simulation.expired_entry',
      'Simulation referenced an expired ledger entry. The contract state may need restoration.',
    ),
  ],
  [
    /restore.*required/i,
    t(
      'simulation.restore_required',
      'Ledger entry restoration is required before this transaction can be simulated.',
    ),
  ],
  [
    /classic.*fee.*exceed/i,
    t(
      'simulation.classic_fee_exceeded',
      'The classic (inclusion) fee exceeds the configured maximum. Increase the fee cap.',
    ),
  ],
];

export class ErrorDecoder {
  private contractRegistries: Map<string, Record<number, string>>;

  constructor() {
    this.contractRegistries = new Map();
  }

  registerContractErrors(contractId: string, map: Record<number, string>): void {
    this.contractRegistries.set(contractId, map);
  }

  tryDecode(raw: unknown): string {
    if (raw === null || raw === undefined || raw === '') {
      return t('error.unknown', 'An unknown error occurred. Please try again.');
    }

    if (typeof raw === 'object') {
      const asObj = raw as Record<string, unknown>;
      return this.tryDecodeObject(asObj);
    }

    if (typeof raw === 'string') {
      return this.tryDecodeString(raw);
    }

    if (typeof raw === 'number') {
      return this.tryDecodeSorobanHost(raw) ?? this.fallback(String(raw));
    }

    return this.fallback(String(raw));
  }

  private tryDecodeObject(obj: Record<string, unknown>): string {
    const sorobanResult = this.tryDecodeSorobanRpc(obj);
    if (sorobanResult) return sorobanResult;

    const code = obj.code;
    if (typeof code === 'string') {
      const rpcMatch = RPC_ERROR_MAP[code];
      if (rpcMatch) return rpcMatch;
    }

    if (typeof code === 'number') {
      const contractId = typeof obj.contractId === 'string' ? obj.contractId : undefined;
      const hostMatch = this.tryDecodeSorobanHost(code, contractId);
      if (hostMatch) return hostMatch;
    }

    const errorStr = obj.error;
    if (typeof errorStr === 'string') {
      const simMatch = this.tryDecodeSimulationError(errorStr);
      if (simMatch) return simMatch;
    }

    const msg = obj.message;
    if (typeof msg === 'string') {
      return this.tryDecodeString(msg);
    }

    return this.fallback(JSON.stringify(obj));
  }

  private tryDecodeSorobanRpc(obj: Record<string, unknown>): string | null {
    const data = obj.data;
    if (!data || typeof data !== 'object') return null;

    const dataObj = data as Record<string, unknown>;
    const contractResults = dataObj.contractResults;

    if (Array.isArray(contractResults) && contractResults.length > 0) {
      for (const result of contractResults) {
        if (result && typeof result === 'object') {
          const resultObj = result as Record<string, unknown>;
          const errorVal = resultObj.error;
          if (typeof errorVal === 'number') {
            const hostMatch = this.tryDecodeSorobanHost(errorVal);
            if (hostMatch) return hostMatch;
          }
          if (typeof errorVal === 'string') {
            const stellarMatch = STELLAR_ERROR_MAP[errorVal];
            if (stellarMatch) return stellarMatch;
          }
        }
      }
    }

    const txResult = dataObj.txResult;
    if (txResult && typeof txResult === 'object') {
      const txResultObj = txResult as Record<string, unknown>;
      const resultStr = txResultObj.result;
      if (typeof resultStr === 'string') {
        const stellarMatch = STELLAR_ERROR_MAP[resultStr];
        if (stellarMatch) return stellarMatch;

        const rpcMatch = RPC_ERROR_MAP[resultStr];
        if (rpcMatch) return rpcMatch;
      }
    }

    return null;
  }

  private tryDecodeSorobanHost(code: number, contractId?: string): string | null {
    if (contractId) {
      const registry = this.contractRegistries.get(contractId);
      const contractMsg = registry?.[code];
      if (contractMsg) return contractMsg;
    }

    return SOROBAN_HOST_ERROR_MAP[code] ?? null;
  }

  private tryDecodeString(raw: string): string {
    const stellarMatch = STELLAR_ERROR_MAP[raw];
    if (stellarMatch) return stellarMatch;

    const rpcMatch = RPC_ERROR_MAP[raw];
    if (rpcMatch) return rpcMatch;

    const hostCode = Number(raw);
    if (!Number.isNaN(hostCode)) {
      const hostMatch = this.tryDecodeSorobanHost(hostCode);
      if (hostMatch) return hostMatch;
    }

    const simMatch = this.tryDecodeSimulationError(raw);
    if (simMatch) return simMatch;

    return this.tryDecodeGeneric(raw);
  }

  private tryDecodeSimulationError(raw: string): string | null {
    for (const [pattern, message] of SIMULATION_ERROR_PATTERNS) {
      if (pattern.test(raw)) {
        return message;
      }
    }
    return null;
  }

  private tryDecodeGeneric(raw: string): string {
    const lower = raw.toLowerCase();

    if (lower.includes('insufficient')) {
      return t('error.insufficient', 'Insufficient balance or allowance for this transaction.');
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return t('error.timeout', 'Request timed out. Check your network connection and try again.');
    }
    if (lower.includes('denied') || lower.includes('rejected')) {
      return t('error.rejected', 'Transaction was rejected by the user or wallet.');
    }
    if (lower.includes('network') || lower.includes('connection')) {
      return t('error.network', 'Network connection error. Please check your internet connection.');
    }

    return this.fallback(raw);
  }

  private fallback(raw: string): string {
    const truncated = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
    return t(
      'error.unhandled',
      `Unhandled error: ${truncated}. Contact support with this message.`,
    );
  }
}

const defaultDecoder = new ErrorDecoder();

export function decodeError(raw: string): string {
  return defaultDecoder.tryDecode(raw);
}

export function isRetryableError(raw: string): boolean {
  const retryableCodes = ['tx_bad_seq', 'tx_too_late', 'fee_insufficient', '-32000', '-32001'];
  return retryableCodes.includes(raw);
}
