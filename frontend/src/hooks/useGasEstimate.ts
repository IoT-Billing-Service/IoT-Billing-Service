'use client';

import { useCallback, useRef, useState } from 'react';
import { TransactionBuilder, Operation, BASE_FEE, Networks, xdr } from '@stellar/stellar-sdk';
import { Server, Api } from '@stellar/stellar-sdk/rpc';
import { SOROBAN_RPC_URL, CACHE_TTL_MS, SIMULATION_TIMEOUT_MS } from '@/utils/sorobanConfig';
import { fromSorobanInt } from '@/utils/currencyFormatter';
import { ErrorDecoder } from '@/utils/errorDecoder';

export interface FeeBreakdown {
  classicFee: string;
  minResourceFee: string;
  refundableFee: string;
  total: string;
  isFallback: boolean;
  timestamp: number;
}

interface CacheEntry {
  key: string;
  data: FeeBreakdown;
  expiresAt: number;
}

const estimateCache = new Map<string, CacheEntry>();

function makeCacheKey(contractId: string, operation: string, amount: string): string {
  return `${contractId}::${operation}::${amount}`;
}

function getCachedEstimate(key: string): FeeBreakdown | null {
  const entry = estimateCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    estimateCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedEstimate(key: string, data: FeeBreakdown): void {
  estimateCache.set(key, { key, data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function computeFallbackEstimate(): FeeBreakdown {
  const baseFeeStroops = 100;
  const numEntries = 3;
  const totalStroops = baseFeeStroops * (1 + numEntries) * 10;
  const totalXlm = Number(fromSorobanInt(totalStroops.toString(), 7));
  return {
    classicFee: (totalXlm * 0.3).toFixed(7),
    minResourceFee: (totalXlm * 0.5).toFixed(7),
    refundableFee: (totalXlm * 0.2).toFixed(7),
    total: totalXlm.toFixed(7),
    isFallback: true,
    timestamp: Date.now(),
  };
}

const errorDecoder = new ErrorDecoder();

export function useGasEstimate() {
  const [feeBreakdown, setFeeBreakdown] = useState<FeeBreakdown | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const estimate = useCallback(
    async (params: {
      contractId: string;
      amount: string;
      asset: string;
      publicKey: string;
      operation: 'escrow_deposit' | 'escrow_withdrawal';
    }) => {
      const { contractId, amount, publicKey, operation } = params;
      if (!amount || !publicKey) return;

      const cacheKey = makeCacheKey(contractId, operation, amount);
      const cached = getCachedEstimate(cacheKey);
      if (cached) {
        setFeeBreakdown(cached);
        setSimulationError(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setEstimating(true);
      setSimulationError(null);

      const timeoutId = setTimeout(() => {
        controller.abort();
      }, SIMULATION_TIMEOUT_MS);

      try {
        const server = new Server(SOROBAN_RPC_URL);
        const account = await server.getAccount(publicKey);

        if (controller.signal.aborted) return;

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.invokeContractFunction({
              contract: contractId,
              function: operation === 'escrow_deposit' ? 'deposit' : 'withdraw',
              args: [xdr.ScVal.scvString(amount)],
            }),
          )
          .setTimeout(30)
          .build();

        if (controller.signal.aborted) return;

        const simResponse = await server.simulateTransaction(tx);

        if (controller.signal.aborted) return;

        if (Api.isSimulationError(simResponse)) {
          throw new Error(simResponse.error);
        }

        if (Api.isSimulationSuccess(simResponse)) {
          const minResourceFeeStr = simResponse.minResourceFee
            ? fromSorobanInt(simResponse.minResourceFee, 7)
            : '0';

          const sorobanTxData = simResponse.transactionData?.build();
          const resourceFee = sorobanTxData?.resourceFee();
          const refundableFeeStroops = resourceFee ? Number(resourceFee) : 0;

          const refundableFeeStr = fromSorobanInt(refundableFeeStroops.toString(), 7);

          const classicFeeStroops = 100;
          const classicFeeStr = fromSorobanInt(classicFeeStroops.toString(), 7);

          const total =
            Number(classicFeeStr) + Number(minResourceFeeStr) + Number(refundableFeeStr);

          const breakdown: FeeBreakdown = {
            classicFee: classicFeeStr,
            minResourceFee: minResourceFeeStr,
            refundableFee: refundableFeeStr,
            total: total.toFixed(7),
            isFallback: false,
            timestamp: Date.now(),
          };

          setCachedEstimate(cacheKey, breakdown);
          setFeeBreakdown(breakdown);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          const fallback = computeFallbackEstimate();
          setCachedEstimate(cacheKey, fallback);
          setFeeBreakdown(fallback);
          return;
        }

        const fallback = computeFallbackEstimate();
        setCachedEstimate(cacheKey, fallback);
        setFeeBreakdown(fallback);

        const raw = err instanceof Error ? err.message : 'Simulation failed';
        setSimulationError(errorDecoder.tryDecode(raw));
      } finally {
        clearTimeout(timeoutId);
        if (!controller.signal.aborted) {
          setEstimating(false);
        }
      }
    },
    [],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setFeeBreakdown(null);
    setEstimating(false);
    setSimulationError(null);
  }, []);

  return { feeBreakdown, estimating, simulationError, estimate, reset };
}
