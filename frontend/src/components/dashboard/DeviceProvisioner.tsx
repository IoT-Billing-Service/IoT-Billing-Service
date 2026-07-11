'use client';

import { useState, useMemo } from 'react';

interface DeviceProvisionerProps {
  walletAddress: string;
  onComplete?: (sessionId: string) => void;
}

export function DeviceProvisioner({ walletAddress, onComplete }: DeviceProvisionerProps) {
  const [sessionId] = useState(() =>
    Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join(''),
  );
  const [step, setStep] = useState<'generate' | 'scan' | 'verify' | 'complete'>('generate');
  const [createdAt] = useState(() => Date.now());

  const qrPayload = useMemo(() => {
    const payload = {
      version: 1,
      wallet: walletAddress,
      session: sessionId,
      createdAt,
    };
    return JSON.stringify(payload);
  }, [walletAddress, sessionId, createdAt]);

  const handleGenerate = () => {
    setStep('scan');
    setTimeout(() => {
      setStep('verify');
      setTimeout(() => {
        setStep('complete');
        onComplete?.(sessionId);
      }, 2000);
    }, 3000);
  };

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
      <h3 className="mb-4 text-lg font-semibold text-green-400">Device Provisioning</h3>

      {step === 'generate' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Generate a secure QR code to pair your hardware device with this wallet.
          </p>
          <button
            onClick={handleGenerate}
            className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
          >
            Generate Commissioning QR
          </button>
        </div>
      )}

      {step === 'scan' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">Scan this QR code with your device imaging tool.</p>
          <div className="flex justify-center">
            <div className="h-48 w-48 rounded border border-gray-600 bg-white p-2">
              <div className="flex h-full w-full items-center justify-center bg-gray-100 text-center text-xs text-gray-500">
                [QR Code Placeholder]
                <br />
                {qrPayload.slice(0, 40)}...
              </div>
            </div>
          </div>
          <p className="text-center text-xs text-gray-500">Session: {sessionId.slice(0, 12)}...</p>
        </div>
      )}

      {(step === 'verify' || step === 'complete') && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className={step === 'complete' ? 'text-green-400' : 'text-yellow-400'}>
              {step === 'complete' ? '✓' : '⟳'}
            </span>
            <span className="text-gray-300">
              {step === 'complete'
                ? 'Device provisioned successfully'
                : 'Verifying device handshake...'}
            </span>
          </div>
          {step === 'complete' && (
            <p className="text-xs text-gray-500">
              Session ID: <code className="text-green-300">{sessionId}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
