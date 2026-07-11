import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLatestRequest } from './useLatestRequest';

/** A promise whose resolve/reject can be triggered from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useLatestRequest', () => {
  it('exposes the result of a successful request', async () => {
    const { result } = renderHook(() => useLatestRequest<string>());

    await act(async () => {
      await result.current.run(async () => 'ok');
    });

    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('ignores a stale (out-of-order) response — latest wins', async () => {
    const { result } = renderHook(() => useLatestRequest<string>());
    const first = deferred<string>();
    const second = deferred<string>();

    // Start two requests; the FIRST will resolve LATER than the second.
    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run(() => first.promise);
    });
    act(() => {
      secondRun = result.current.run(() => second.promise);
    });

    // Second (latest) resolves first.
    await act(async () => {
      second.resolve('SECOND');
      await secondRun;
    });
    expect(result.current.data).toBe('SECOND');

    // First (stale) resolves later and must NOT overwrite the latest result.
    await act(async () => {
      first.resolve('FIRST');
      await firstRun;
    });
    expect(result.current.data).toBe('SECOND');
  });

  it('aborts the previous in-flight request when a new one starts', () => {
    const { result } = renderHook(() => useLatestRequest<string>());
    let firstSignal: AbortSignal | undefined;

    act(() => {
      result.current.run((signal) => {
        firstSignal = signal;
        return new Promise<string>(() => {}); // never settles
      });
    });
    expect(firstSignal?.aborted).toBe(false);

    act(() => {
      result.current.run(() => new Promise<string>(() => {}));
    });
    expect(firstSignal?.aborted).toBe(true);
  });

  it('surfaces errors from the latest request', async () => {
    const { result } = renderHook(() => useLatestRequest<string>());

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('boom');
      });
    });

    expect(result.current.error?.message).toBe('boom');
    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('does not surface an AbortError as an error', async () => {
    const { result } = renderHook(() => useLatestRequest<string>());

    await act(async () => {
      await result.current.run(async () => {
        throw new DOMException('Aborted', 'AbortError');
      });
    });

    expect(result.current.error).toBeNull();
  });

  it('cancel() clears the pending state', () => {
    const { result } = renderHook(() => useLatestRequest<string>());

    act(() => {
      result.current.run(() => new Promise<string>(() => {}));
    });
    expect(result.current.isPending).toBe(true);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.isPending).toBe(false);
  });
});
