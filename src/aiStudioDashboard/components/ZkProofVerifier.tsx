import { useState } from 'react';
import { Shield, Sparkles, CheckCircle2, AlertCircle, RefreshCw, ChevronRight } from 'lucide-react';
import { generateRandomHex } from '../data/initialData';

interface ZkProofVerifierProps {
  onVerifySuccess: () => void;
}

export default function ZkProofVerifier({ onVerifySuccess }: ZkProofVerifierProps) {
  const [telemetryValue, setTelemetryValue] = useState<number>(24.5);
  const [lowerBound, setLowerBound] = useState<number>(15.0);
  const [upperBound, setUpperBound] = useState<number>(35.0);
  const [isProving, setIsProving] = useState<boolean>(false);
  const [proofResult, setProofResult] = useState<{
    status: 'idle' | 'success' | 'failed';
    proofHash: string;
    computationTimeMs: number;
    steps: { name: string; status: 'pending' | 'success' | 'failed' }[];
  }>({
    status: 'idle',
    proofHash: '',
    computationTimeMs: 0,
    steps: [
      { name: 'Compute Polynomial Commitments', status: 'pending' },
      { name: 'Generate Fiat-Shamir Challenge', status: 'pending' },
      { name: 'Build Bulletproofs Range Statement', status: 'pending' },
      { name: 'Verify Proof on Soroban Host VM', status: 'pending' },
    ],
  });

  const runProofGeneration = () => {
    setIsProving(true);
    setProofResult(prev => ({
      ...prev,
      status: 'idle',
      steps: prev.steps.map(s => ({ ...s, status: 'pending' })),
    }));

    // Check if within bounds
    const isValid = telemetryValue >= lowerBound && telemetryValue <= upperBound;
    const steps = [
      'Compute Polynomial Commitments',
      'Generate Fiat-Shamir Challenge',
      'Build Bulletproofs Range Statement',
      'Verify Proof on Soroban Host VM',
    ];

    let currentStepIndex = 0;

    const interval = setInterval(() => {
      if (currentStepIndex < steps.length) {
        setProofResult(prev => {
          const updatedSteps = [...prev.steps];
          // If the telemetry value is out of bounds, the Bulletproof generation or Soroban VM verification should fail
          const stepFailed = !isValid && currentStepIndex === 2; // Fail at range proof generation step
          const stepName = steps[currentStepIndex] ?? 'Unknown step';

          updatedSteps[currentStepIndex] = {
            name: stepName,
            status: stepFailed ? 'failed' : 'success',
          };
          return {
            ...prev,
            steps: updatedSteps,
          };
        });

        if (!isValid && currentStepIndex === 2) {
          // Break early on failure
          clearInterval(interval);
          setIsProving(false);
          setProofResult(prev => ({
            ...prev,
            status: 'failed',
            proofHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
            computationTimeMs: 42 + currentStepIndex * 15,
          }));
          return;
        }

        currentStepIndex++;
      } else {
        clearInterval(interval);
        setIsProving(false);
        const finalStatus = isValid ? 'success' : 'failed';
        setProofResult(prev => ({
          ...prev,
          status: finalStatus,
          proofHash: generateRandomHex(64),
          computationTimeMs: 98,
        }));
        if (isValid) {
          onVerifySuccess();
        }
      }
    }, 400);
  };

  const isValueValid = telemetryValue >= lowerBound && telemetryValue <= upperBound;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6" id="zk-proof-verifier-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-cyan-950 text-cyan-400 rounded-lg border border-cyan-800/50">
            <Shield className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="font-sans font-medium text-white tracking-tight text-base">ZK Range-Proof Telemetry Gateway</h3>
            <p className="text-xs text-neutral-400 font-mono">Proof-of-Correctness Generator (Bulletproofs)</p>
          </div>
        </div>
        <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800/60 px-2 py-0.5 rounded font-mono uppercase">
          Zero-Knowledge API
        </span>
      </div>

      <p className="text-xs text-neutral-400 mb-6 leading-relaxed">
        Hardware nodes generate an encrypted proof showing telemetry falls within valid contractual tariff limits (e.g., operational safe boundaries). The Soroban ledger verifies the proof without decrypting exact high-fidelity telemetry, shielding local corporate assets.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Interactive Controls */}
        <div className="space-y-4">
          <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800 space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 font-sans">Simulated Telemetry Value</span>
              <span className={`font-mono font-bold ${isValueValid ? 'text-emerald-400' : 'text-amber-500'}`}>
                {telemetryValue.toFixed(1)}°C
              </span>
            </div>
            <input
              type="range"
              min="5"
              max="45"
              step="0.1"
              value={telemetryValue}
              onChange={(e) => setTelemetryValue(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              id="telemetry-slider"
            />

            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-[10px] text-neutral-500 font-mono uppercase mb-1">Contract Lower Limit</label>
                <div className="flex items-center justify-between bg-neutral-900 border border-neutral-800 px-2 py-1 rounded">
                  <button 
                    onClick={() => setLowerBound(Math.max(5, lowerBound - 1))}
                    className="text-neutral-400 hover:text-white font-mono text-xs px-1"
                  >
                    -
                  </button>
                  <span className="text-xs text-white font-mono font-semibold">{lowerBound}°C</span>
                  <button 
                    onClick={() => setLowerBound(Math.min(telemetryValue, lowerBound + 1))}
                    className="text-neutral-400 hover:text-white font-mono text-xs px-1"
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-neutral-500 font-mono uppercase mb-1">Contract Upper Limit</label>
                <div className="flex items-center justify-between bg-neutral-900 border border-neutral-800 px-2 py-1 rounded">
                  <button 
                    onClick={() => setUpperBound(Math.max(telemetryValue, upperBound - 1))}
                    className="text-neutral-400 hover:text-white font-mono text-xs px-1"
                  >
                    -
                  </button>
                  <span className="text-xs text-white font-mono font-semibold">{upperBound}°C</span>
                  <button 
                    onClick={() => setUpperBound(Math.min(45, upperBound + 1))}
                    className="text-neutral-400 hover:text-white font-mono text-xs px-1"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={runProofGeneration}
            disabled={isProving}
            className={`w-full py-2.5 px-4 rounded-lg font-sans font-medium text-xs flex items-center justify-center gap-2 border transition-all ${
              isProving
                ? 'bg-neutral-800 border-neutral-700 text-neutral-400 cursor-not-allowed'
                : 'bg-cyan-950 border-cyan-800 hover:bg-cyan-900 text-cyan-400 active:scale-[0.98]'
            }`}
            id="generate-proof-button"
          >
            {isProving ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {isProving ? 'Compiling Bulletproof Range Proof...' : 'Generate & Verify ZK Range Proof'}
          </button>
        </div>

        {/* Cryptographic Execution Terminal */}
        <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800 font-mono text-xs flex flex-col justify-between h-[190px]">
          <div className="space-y-1.5">
            <div className="text-[10px] text-neutral-500 uppercase border-b border-neutral-900 pb-1 flex justify-between">
              <span>Verifier Log Terminal</span>
              <span className="text-cyan-500">AES-256 / Bulletproofs</span>
            </div>

            <div className="space-y-1 pt-1">
              {proofResult.steps.map((step, idx) => (
                <div key={idx} className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 text-neutral-400">
                    <ChevronRight className="w-3 h-3 text-neutral-600" />
                    {step.name}
                  </span>
                  {step.status === 'success' && (
                    <span className="text-emerald-400 font-bold">✔ OK</span>
                  )}
                  {step.status === 'failed' && (
                    <span className="text-red-400 font-bold">✘ FAIL</span>
                  )}
                  {step.status === 'pending' && (
                    <span className="text-neutral-600 animate-pulse">● WAITING</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-neutral-900 pt-2 flex items-center gap-2 min-h-[44px]">
            {proofResult.status === 'success' && (
              <div className="flex items-start gap-2 text-emerald-400 w-full">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="overflow-hidden">
                  <div className="font-bold text-[11px]">RANGE PROOF VERIFIED SUCCESSFULLY</div>
                  <div className="text-[9px] text-neutral-500 truncate">{proofResult.proofHash}</div>
                </div>
                <span className="text-[10px] text-neutral-400 shrink-0 font-sans ml-auto">{proofResult.computationTimeMs}ms</span>
              </div>
            )}
            {proofResult.status === 'failed' && (
              <div className="flex items-start gap-2 text-red-400 w-full">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-bold text-[11px]">VERIFICATION REJECTED: VALUE OUT OF BOUNDS</div>
                  <div className="text-[9px] text-neutral-500">Rent deducted but transaction billing rejected.</div>
                </div>
              </div>
            )}
            {proofResult.status === 'idle' && !isProving && (
              <div className="text-neutral-500 text-[11px] text-center w-full py-1">
                Await parameters inputs... Click generate above.
              </div>
            )}
            {isProving && (
              <div className="text-cyan-400/80 text-[11px] flex items-center justify-center gap-2 w-full">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>Executing cryptographic constraint solver...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
