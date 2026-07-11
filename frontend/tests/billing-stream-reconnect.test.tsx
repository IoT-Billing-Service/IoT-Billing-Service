import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useBillingStream } from '../src/hooks/useBillingStream';

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(message: string) {
    this.sent.push(message);
    const parsed = JSON.parse(message);
    if (parsed.type === 'ping') {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'pong' }) } as MessageEvent), 0);
    }
  }

  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

function BillingStreamConsumer() {
  useBillingStream(() => undefined);
  return null;
}

describe('useBillingStream reconnection', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    window.__IOT_BILLING_AUTH_SESSION__ = {
      jwt: 'old.jwt',
      publicKey: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      expiresAt: Date.now() + 60_000,
      nonce: '',
      signedChallenge: '',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            jwt: 'new.jwt',
            publicKey: window.__IOT_BILLING_AUTH_SESSION__?.publicKey,
            expiresAt: Date.now() + 900_000,
            nonce: '',
            signedChallenge: '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/auth/validate') && init?.method === 'HEAD') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__IOT_BILLING_AUTH_SESSION__;
    delete window.__IOT_BILLING_PUBLIC_KEY__;
  });

  it('refreshes and reconnects within five seconds after a 4001 auth close', async () => {
    render(<BillingStreamConsumer />);
    await waitFor(() => expect(sockets.length).toBe(1));

    const startedAt = performance.now();
    sockets[0]!.close(4001);

    await waitFor(() => expect(sockets.length).toBe(2), { timeout: 5_000 });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(sockets[1]!.url).toContain('token=new.jwt');
  });

  it('preemptively refreshes when the stream reports a token nearing expiry', async () => {
    render(<BillingStreamConsumer />);
    await waitFor(() => expect(sockets.length).toBe(1));

    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'token_expiring', expires_in: 120 }) } as MessageEvent);

    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]!.url).toContain('token=new.jwt');
  });
});
