import React, { useState, useEffect, useRef } from 'react';
import {
  DeployedContract,
  VerificationCheck,
  VerificationResult,
  VerificationStatus,
} from '../types';
import {
  runVerificationSimulation,
  generateVerificationChecks,
} from '../data/contractVerificationData';
import {
  FileCode,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  Shield,
  ExternalLink,
  Fingerprint,
  ChevronDown,
  ChevronRight,
  Globe,
  Hammer,
} from 'lucide-react';

interface ContractVerifierProps {
  contract: DeployedContract;
  onVerificationComplete?: (result: VerificationResult) => void;
}

export default function ContractVerifier({
  contract,
  onVerificationComplete,
}: ContractVerifierProps) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['functions', 'audit'])
  );
  const checkTimersRef = useRef<NodeJS.Timeout[]>([]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      checkTimersRef.current.forEach(clearInterval);
    };
  }, []);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const runFullVerification = () => {
    setIsVerifying(true);
    setChecks([]);
    setResult(null);

    // Clean up previous timers
    checkTimersRef.current.forEach(clearInterval);
    checkTimersRef.current = [];

    const allChecks = generateVerificationChecks(contract);
    const revealedChecks: VerificationCheck[] = [];

    // Reveal checks one by one with animation
    allChecks.forEach((check, index) => {
      const timer = setTimeout(() => {
        revealedChecks.push(check);
        setChecks([...revealedChecks]);

        if (index === allChecks.length - 1) {
          // All checks complete
          const finalResult = runVerificationSimulation(contract);
          setResult(finalResult);
          setIsVerifying(false);
          onVerificationComplete?.(finalResult);
        }
      }, 300 + index * 350);
      checkTimersRef.current.push(timer);
    });
  };

  const statusBadge = (status: VerificationStatus) => {
    const configs: Record<
      VerificationStatus,
      { icon: React.ReactNode; label: string; className: string }
    > = {
      verified: {
        icon: <CheckCircle2 className="w-4 h-4" />,
        label: 'Verified',
        className: 'bg-emerald-950 text-emerald-400 border-emerald-800/50',
      },
      partial: {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: 'Partial',
        className: 'bg-amber-950 text-amber-400 border-amber-800/50',
      },
      pending: {
        icon: <Clock className="w-4 h-4" />,
        label: 'Pending',
        className: 'bg-blue-950 text-blue-400 border-blue-800/50',
      },
      unverified: {
        icon: <XCircle className="w-4 h-4" />,
        label: 'Unverified',
        className: 'bg-red-950 text-red-400 border-red-800/50',
      },
      failed: {
        icon: <XCircle className="w-4 h-4" />,
        label: 'Failed',
        className: 'bg-red-950 text-red-400 border-red-800/50',
      },
    };
    const config = configs[status] || configs.unverified;
    return (
      <span
        className={`flex items-center gap-1 text-[11px] font-mono font-semibold px-2 py-0.5 rounded border ${config.className}`}
      >
        {config.icon}
        {config.label}
      </span>
    );
  };

  const checkIcon = (status: VerificationCheck['status']) => {
    switch (status) {
      case 'pass':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'fail':
        return <XCircle className="w-4 h-4 text-red-400" />;
      case 'running':
        return (
          <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
        );
      case 'pending':
        return <Clock className="w-4 h-4 text-neutral-600" />;
    }
  };

  const networkIcon = (network: string) => {
    switch (network) {
      case 'mainnet':
        return <Globe className="w-3.5 h-3.5 text-emerald-400" />;
      case 'testnet':
        return <Globe className="w-3.5 h-3.5 text-amber-400" />;
      case 'futurenet':
        return <Globe className="w-3.5 h-3.5 text-blue-400" />;
      default:
        return <Globe className="w-3.5 h-3.5 text-neutral-400" />;
    }
  };

  const securityScoreColor = (score: number) => {
    if (score >= 90) return 'text-emerald-400';
    if (score >= 70) return 'text-amber-400';
    if (score > 0) return 'text-red-400';
    return 'text-neutral-600';
  };

  const overallStatusStyle = result
    ? result.overallStatus === 'verified'
      ? 'border-emerald-800/60 bg-emerald-950/20'
      : result.overallStatus === 'failed'
        ? 'border-red-800/60 bg-red-950/20'
        : 'border-amber-800/60 bg-amber-950/20'
    : 'border-neutral-800 bg-neutral-950';

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-neutral-800">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-950 text-purple-400 rounded-lg border border-purple-800/50">
              <FileCode className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-sans font-semibold text-white text-sm">
                  {contract.name}
                </h3>
                <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded font-mono">
                  v{contract.version}
                </span>
              </div>
              <p className="text-[11px] text-neutral-500 font-mono">
                {contract.contractAddress.substring(0, 12)}...
                {contract.contractAddress.substring(
                  contract.contractAddress.length - 8
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {statusBadge(contract.verificationStatus)}
            <div className="flex items-center gap-1 text-[10px] text-neutral-500 bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
              {networkIcon(contract.network)}
              <span className="capitalize">{contract.network}</span>
            </div>
          </div>
        </div>

        {/* Quick Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-1.5">
            <span className="text-[9px] text-neutral-500 font-mono block">
              Security Score
            </span>
            <span
              className={`text-sm font-mono font-bold ${securityScoreColor(contract.securityScore)}`}
            >
              {contract.securityScore}/100
            </span>
          </div>
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-1.5">
            <span className="text-[9px] text-neutral-500 font-mono block">
              WASM Size
            </span>
            <span className="text-sm font-mono text-white">
              {(contract.wasmSizeBytes / 1024).toFixed(0)} KB
            </span>
          </div>
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-1.5">
            <span className="text-[9px] text-neutral-500 font-mono block">
              Storage
            </span>
            <span className="text-sm font-mono text-white">
              {contract.storageEntries} entries
            </span>
          </div>
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-1.5">
            <span className="text-[9px] text-neutral-500 font-mono block">
              Functions
            </span>
            <span className="text-sm font-mono text-white">
              {contract.functions.length} total
            </span>
          </div>
        </div>

        {/* Verification Button */}
        <button
          onClick={runFullVerification}
          disabled={isVerifying}
          className={`w-full py-2.5 rounded-lg font-mono text-xs font-medium flex items-center justify-center gap-2 transition-all border ${
            isVerifying
              ? 'bg-neutral-800 border-neutral-700 text-neutral-500 cursor-not-allowed'
              : 'bg-purple-950/50 border-purple-800/60 hover:bg-purple-900/60 text-purple-400 hover:text-purple-300 active:scale-[0.98]'
          }`}
        >
          {isVerifying ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Running verification checks...
            </>
          ) : (
            <>
              <Shield className="w-4 h-4" />
              Run Full Contract Verification
            </>
          )}
        </button>
      </div>

      {/* Verification Progress / Results */}
      {(checks.length > 0 || result) && (
        <div className={`p-5 border-b border-neutral-800 ${overallStatusStyle}`}>
          {/* Overall Result Banner */}
          {result && (
            <div
              className={`mb-4 p-3 rounded-lg border flex items-center gap-3 ${
                result.overallStatus === 'verified'
                  ? 'bg-emerald-950/30 border-emerald-800/50'
                  : result.overallStatus === 'failed'
                    ? 'bg-red-950/30 border-red-800/50'
                    : 'bg-amber-950/30 border-amber-800/50'
              }`}
            >
              {result.overallStatus === 'verified' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : result.overallStatus === 'failed' ? (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono font-bold text-white">
                  {result.overallStatus === 'verified'
                    ? 'CONTRACT FULLY VERIFIED'
                    : result.overallStatus === 'failed'
                      ? 'VERIFICATION FAILED'
                      : 'PARTIALLY VERIFIED'}
                </div>
                <div className="text-[10px] text-neutral-400 font-mono">
                  {result.checks.filter((c) => c.status === 'pass').length}/
                  {result.checks.length} checks passed in{' '}
                  {result.totalDurationMs}ms • Verified by{' '}
                  {result.verifierNode}
                </div>
              </div>
              <span className="text-[10px] text-neutral-500 font-mono">
                {new Date(result.timestamp).toLocaleTimeString()}
              </span>
            </div>
          )}

          {/* Individual Checks */}
          <div className="space-y-1.5">
            {checks.map((check, idx) => (
              <div
                key={idx}
                className={`p-2.5 rounded-lg border flex items-start gap-2.5 transition-all duration-300 ${
                  check.status === 'running'
                    ? 'bg-cyan-950/20 border-cyan-800/30'
                    : check.status === 'pass'
                      ? 'bg-neutral-950 border-neutral-800/70'
                      : check.status === 'fail'
                        ? 'bg-red-950/10 border-red-900/30'
                        : 'bg-neutral-950 border-neutral-800/50'
                }`}
              >
                <div className="mt-0.5 shrink-0">{checkIcon(check.status)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-neutral-300 font-medium">
                      {check.name}
                    </span>
                    <span className="text-[9px] text-neutral-500 font-mono">
                      {check.durationMs}ms
                    </span>
                  </div>
                  <p className="text-[10px] text-neutral-400 mt-0.5">
                    {check.description}
                  </p>
                  {check.detail && (
                    <p
                      className={`text-[10px] mt-1 font-mono truncate ${
                        check.status === 'fail'
                          ? 'text-red-400'
                          : check.status === 'pass'
                            ? 'text-emerald-400'
                            : 'text-neutral-500'
                      }`}
                    >
                      {check.detail}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapsible Details */}
      <div className="divide-y divide-neutral-800">
        {/* Functions Section */}
        <div>
          <button
            onClick={() => toggleSection('functions')}
            className="w-full flex items-center justify-between p-4 hover:bg-neutral-850 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Hammer className="w-4 h-4 text-blue-400" />
              <span className="text-xs font-mono font-medium text-white">
                Contract Functions ({contract.functions.length})
              </span>
            </div>
            {expandedSections.has('functions') ? (
              <ChevronDown className="w-4 h-4 text-neutral-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-neutral-500" />
            )}
          </button>
          {expandedSections.has('functions') && (
            <div className="px-4 pb-4 space-y-1">
              {contract.functions.map((fn, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        fn.visibility === 'public'
                          ? 'bg-emerald-400'
                          : fn.visibility === 'private'
                            ? 'bg-red-400'
                            : 'bg-blue-400'
                      }`}
                    />
                    <span className="font-mono text-white truncate">
                      {fn.name}
                    </span>
                    <span className="text-[10px] text-neutral-500 font-mono truncate">
                      ({fn.args.join(', ')}) → {fn.returns}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${
                        fn.complexity === 'high'
                          ? 'bg-red-950 text-red-400 border border-red-800/30'
                          : fn.complexity === 'medium'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800/30'
                            : 'bg-emerald-950 text-emerald-400 border border-emerald-800/30'
                      }`}
                    >
                      {fn.complexity}
                    </span>
                    {fn.verified ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Audit Reports Section */}
        <div>
          <button
            onClick={() => toggleSection('audit')}
            className="w-full flex items-center justify-between p-4 hover:bg-neutral-850 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-purple-400" />
              <span className="text-xs font-mono font-medium text-white">
                Audit Reports ({contract.auditReports.length})
              </span>
              {contract.auditReports.length === 0 && (
                <span className="text-[10px] text-red-400 font-mono">
                  — No audits
                </span>
              )}
            </div>
            {expandedSections.has('audit') ? (
              <ChevronDown className="w-4 h-4 text-neutral-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-neutral-500" />
            )}
          </button>
          {expandedSections.has('audit') && (
            <div className="px-4 pb-4 space-y-1.5">
              {contract.auditReports.length === 0 ? (
                <div className="text-xs text-neutral-500 font-mono p-3 bg-neutral-950 border border-red-900/20 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-400 inline mr-1.5" />
                  No security audits found. This contract has not undergone
                  independent security review.
                </div>
              ) : (
                contract.auditReports.map((report) => (
                  <div
                    key={report.id}
                    className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-white font-medium">
                          {report.auditor}
                        </span>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${
                            report.severity === 'critical'
                              ? 'bg-red-950 text-red-400 border-red-800/30'
                              : report.severity === 'high'
                                ? 'bg-orange-950 text-orange-400 border-orange-800/30'
                                : report.severity === 'medium'
                                  ? 'bg-amber-950 text-amber-400 border-amber-800/30'
                                  : 'bg-blue-950 text-blue-400 border-blue-800/30'
                          }`}
                        >
                          {report.severity}
                        </span>
                      </div>
                      <span className="text-[10px] text-neutral-500 font-mono">
                        {report.date}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-mono">
                      <span className="text-neutral-400">
                        {report.findings} findings
                      </span>
                      <span
                        className={
                          report.resolved === report.findings
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }
                      >
                        {report.resolved} resolved
                      </span>
                      {report.reportUrl && (
                        <a
                          href={report.reportUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" /> Report
                        </a>
                      )}
                    </div>
                    {/* Progress bar */}
                    <div className="mt-2 w-full bg-neutral-900 rounded-full h-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          report.resolved === report.findings
                            ? 'bg-emerald-500'
                            : 'bg-amber-500'
                        }`}
                        style={{
                          width: `${report.findings > 0 ? (report.resolved / report.findings) * 100 : 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* WASM / Technical Details Section */}
        <div>
          <button
            onClick={() => toggleSection('technical')}
            className="w-full flex items-center justify-between p-4 hover:bg-neutral-850 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Fingerprint className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono font-medium text-white">
                Technical Details
              </span>
            </div>
            {expandedSections.has('technical') ? (
              <ChevronDown className="w-4 h-4 text-neutral-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-neutral-500" />
            )}
          </button>
          {expandedSections.has('technical') && (
            <div className="px-4 pb-4 space-y-1.5">
              <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      WASM Hash
                    </span>
                    <span className="text-[10px] text-cyan-400 font-mono truncate block">
                      {contract.wasmHash}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      Source Code Hash
                    </span>
                    <span
                      className={`text-[10px] font-mono truncate block ${
                        contract.sourceCodeHash
                          ? contract.wasmHash === contract.sourceCodeHash
                            ? 'text-emerald-400'
                            : 'text-red-400'
                          : 'text-red-400'
                      }`}
                    >
                      {contract.sourceCodeHash || 'Not available'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      Rust Compiler
                    </span>
                    <span className="text-[10px] text-white font-mono">
                      rustc {contract.rustcVersion}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      Soroban SDK
                    </span>
                    <span className="text-[10px] text-white font-mono">
                      v{contract.sorobanSdkVersion}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      WASM Size
                    </span>
                    <span className="text-[10px] text-white font-mono">
                      {(contract.wasmSizeBytes / 1024).toFixed(1)} KB (
                      {contract.wasmSizeBytes.toLocaleString()} bytes)
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      Ledger Sequence
                    </span>
                    <span className="text-[10px] text-white font-mono">
                      #{contract.ledgerSequence.toLocaleString()}
                    </span>
                  </div>
                </div>
                {contract.metadataUri && (
                  <div>
                    <span className="text-[9px] text-neutral-500 font-mono block">
                      Metadata URI
                    </span>
                    <span className="text-[10px] text-cyan-400 font-mono truncate block">
                      {contract.metadataUri}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
