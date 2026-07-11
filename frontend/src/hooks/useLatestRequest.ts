'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useLatestRequest
 * ────────────────
 * Race-safe single-flight async runner. Running a new request aborts the
 * previous in-flight one (its `AbortSignal` fires) and guarantees that only the
 * latest request settles state — out-of-order or stale responses are ignored.
 *
 * This is the canonical "latest query wins" pattern (issue #61's blueprint #1):
 * the codebase already implements it ad-hoc in several hooks (WalletProvider's
 * `connect`, `useGasEstimate`, `useChunkedHistory`). This consolidates it into
 * one tested primitive so the next input-driven fetch — a device search, a
 * filter, a typeahead — is race-safe for free instead of re-deriving the
 * AbortController + version-guard bookkeeping each time.
 */

export interface LatestRequestState<T> {
  data: T | undefined;
  error: Error | null;
  isPending: boolean;
}

export interface UseLatestRequest<T> extends LatestRequestState<T> {
  /**
   * Start a new request. Aborts any previous in-flight request, then runs
   * `factory` with a fresh `AbortSignal`. Resolves with the result when this
   * call is still the latest, or `undefined` if it was superseded/aborted.
   */
  run: (factory: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  /** Abort the in-flight request without starting a new one. */
  cancel: () => void;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function useLatestRequest<T>(): UseLatestRequest<T> {
  const [state, setState] = useState<LatestRequestState<T>>({
    data: undefined,
    error: null,
    isPending: false,
  });

  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (mountedRef.current) {
      setState((prev) => ({ ...prev, isPending: false }));
    }
  }, []);

  const run = useCallback(async (factory: (signal: AbortSignal) => Promise<T>) => {
    // Abort the previous in-flight request — latest wins.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;

    if (mountedRef.current) {
      setState((prev) => ({ ...prev, isPending: true, error: null }));
    }

    const isStale = () => requestId !== requestIdRef.current || controller.signal.aborted;

    try {
      const result = await factory(controller.signal);
      if (isStale()) return undefined;
      if (mountedRef.current) {
        setState({ data: result, error: null, isPending: false });
      }
      return result;
    } catch (err) {
      if (isStale() || isAbortError(err)) return undefined;
      const error = err instanceof Error ? err : new Error(String(err));
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, error, isPending: false }));
      }
      return undefined;
    }
  }, []);

  return { ...state, run, cancel };
}
