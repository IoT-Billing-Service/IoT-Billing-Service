import type { TelemetryPayload } from '../types';
import { ArrowDownCircle, Coins, Cpu, HardDrive, ShieldAlert, ShieldCheck } from 'lucide-react';

interface TelemetryFeedProps {
  payloads: TelemetryPayload[];
  onClear: () => void;
}

export default function TelemetryFeed({ payloads, onClear }: TelemetryFeedProps) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6" id="telemetry-feed-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-emerald-950 text-emerald-400 rounded-lg border border-emerald-800/50">
            <Cpu className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="font-sans font-medium text-white tracking-tight text-base">On-Chain Metering Ledger Stream</h3>
            <p className="text-xs text-neutral-400 font-mono">Real-Time Ingestion (mTLS Gateway Verified)</p>
          </div>
        </div>

        <button
          onClick={onClear}
          className="text-[11px] font-mono text-neutral-500 hover:text-white transition-colors bg-neutral-950 px-2 py-1 rounded border border-neutral-800"
        >
          CLEAR LOGS
        </button>
      </div>

      <p className="text-xs text-neutral-400 mb-6 leading-relaxed">
        This is the decrypted telemetry stream as validated by the mTLS Gateway and recorded via Soroban smart contract micro-debits. Devices with invalid signatures or out-of-bounds ZK proofs will trigger automated tariff escrow pauses.
      </p>

      {/* Real-time Ledger Stream List */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden flex flex-col h-[320px]">
        {/* Table Headers */}
        <div className="grid grid-cols-12 px-4 py-2 bg-neutral-950 border-b border-neutral-900 text-[10px] font-mono text-neutral-500 uppercase tracking-wider sticky top-0">
          <div className="col-span-2">Time / Node</div>
          <div className="col-span-3">Telemetry Data</div>
          <div className="col-span-2 text-center">ZK Range Proof</div>
          <div className="col-span-3">Raw Decrypted Hex</div>
          <div className="col-span-2 text-right">Debit (XLM)</div>
        </div>

        {/* Scrollable Payload Stream */}
        <div className="flex-1 overflow-y-auto divide-y divide-neutral-900" id="ledger-stream-container">
          {payloads.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-neutral-600 font-mono text-xs py-12">
              <ArrowDownCircle className="w-8 h-8 animate-bounce text-neutral-700" />
              <span>Awaiting telemetry broadcast stream...</span>
            </div>
          ) : (
            payloads.map((payload) => (
              <div
                key={payload.id}
                className="grid grid-cols-12 px-4 py-3 text-[11px] font-mono items-center hover:bg-neutral-900/40 transition-colors"
              >
                {/* Time & Node */}
                <div className="col-span-2 flex flex-col">
                  <span className="text-neutral-500 text-[10px]">{payload.timestamp}</span>
                  <span className="text-white font-semibold truncate max-w-[100px]" title={payload.nodeId}>
                    {payload.nodeId}
                  </span>
                </div>

                {/* Metering Data */}
                <div className="col-span-3 flex items-center gap-2">
                  <div className="text-white font-bold bg-neutral-900 px-2 py-1 rounded border border-neutral-800/80 flex items-center gap-1">
                    <span className="text-emerald-400">{payload.value.toFixed(1)}</span>
                    <span className="text-neutral-500 text-[9px]">{payload.unit}</span>
                  </div>
                  <span className="text-neutral-500 text-[9px] flex items-center gap-0.5">
                    <HardDrive className="w-2.5 h-2.5" />
                    {payload.payloadSizeKB}KB
                  </span>
                </div>

                {/* ZK Range-Proof status */}
                <div className="col-span-2 flex justify-center">
                  {payload.zkVerified ? (
                    <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-900/50 px-2 py-0.5 rounded-full">
                      <ShieldCheck className="w-3 h-3" />
                      VERIFIED
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[9px] font-bold text-rose-400 bg-rose-950/40 border border-rose-900/50 px-2 py-0.5 rounded-full">
                      <ShieldAlert className="w-3 h-3" />
                      BYPASSED
                    </span>
                  )}
                </div>

                {/* Raw Encrypted Hex */}
                <div className="col-span-3">
                  <span className="text-[10px] text-neutral-500 bg-neutral-900/80 border border-neutral-800 px-2 py-0.5 rounded select-all font-mono truncate block max-w-[160px]" title={payload.rawHex}>
                    {payload.rawHex}
                  </span>
                </div>

                {/* XLM Micro-payment Debit */}
                <div className="col-span-2 text-right flex flex-col items-end">
                  <span className="text-cyan-400 font-bold flex items-center gap-0.5">
                    <Coins className="w-3 h-3 text-cyan-500" />
                    -{payload.cost.toFixed(5)}
                  </span>
                  <span className="text-[8px] text-neutral-500">XLM Debited</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
