import { useState } from 'react';
import { connectWallet } from '../hooks/useWallet';
import type { WalletInfo } from '../hooks/useWallet';

/**
 * Freighter wallet connect button for the operator/device dashboard.
 */
export function WalletConnect() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [status, setStatus] = useState<string>('');

  const handleConnect = async () => {
    setStatus('');
    try {
      const info = await connectWallet();
      setWallet(info);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}
    >
      {wallet ? (
        <span title={`${wallet.network}`}>
          Connected:{' '}
          <code>
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </code>
        </span>
      ) : (
        <button type="button" onClick={handleConnect}>
          Connect Freighter
        </button>
      )}
      {status && <small style={{ color: '#b91c1c' }}>{status}</small>}
    </div>
  );
}
