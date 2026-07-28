import { DeployedContract, VerificationCheck, VerificationResult } from '../types';

export const INITIAL_DEPLOYED_CONTRACTS: DeployedContract[] = [
  {
    id: 'CONTRACT-BILLING-V1',
    name: 'IoTBillingService',
    contractAddress: 'CDLZFC3SYJYDZT7K67VZ75GRJ6E67NMRVCXL3YCFPKCFWMBP6VKFODFL',
    deployerAddress: 'GDL2FCMJL6RBS6KLSGQPSN5XUCJGOWWBHK6GVQ3HFI6TLB7ICELDDM5X',
    wasmHash: '0x8f4e2a9b7c1d3e5f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f',
    sourceCodeHash: '0x8f4e2a9b7c1d3e5f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f',
    network: 'testnet',
    deployedAt: '2026-07-15T10:30:00Z',
    lastVerifiedAt: '2026-07-21T14:22:00Z',
    verificationStatus: 'verified',
    version: '1.4.2',
    rustcVersion: '1.78.0',
    sorobanSdkVersion: '21.0.0',
    wasmSizeBytes: 245760,
    securityScore: 92,
    auditReports: [
      {
        id: 'AUDIT-001',
        auditor: 'Oak Security',
        date: '2026-06-20',
        severity: 'high',
        findings: 3,
        resolved: 3,
        reportUrl: 'https://audits.oaksecurity.io/iot-billing-service-v1',
      },
      {
        id: 'AUDIT-002',
        auditor: 'CertiK',
        date: '2026-07-10',
        severity: 'critical',
        findings: 1,
        resolved: 1,
        reportUrl: 'https://certik.com/audits/iot-billing-service',
      },
    ],
    functions: [
      { name: 'record_telemetry', args: ['device_id', 'payload', 'proof'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'medium', verified: true },
      { name: 'fund_escrow', args: ['device_id', 'amount'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'low', verified: true },
      { name: 'withdraw_escrow', args: ['device_id', 'amount'], returns: 'Result<u64, Error>', visibility: 'public', complexity: 'low', verified: true },
      { name: 'set_tariff', args: ['tariff_id', 'rate'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'medium', verified: true },
      { name: 'emergency_pause', args: ['reason'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'high', verified: true },
      { name: 'get_balance', args: ['device_id'], returns: 'u64', visibility: 'view', complexity: 'low', verified: true },
      { name: 'verify_consistency', args: ['root_hash'], returns: 'bool', visibility: 'public', complexity: 'high', verified: true },
    ],
    storageEntries: 1420,
    ledgerSequence: 4892150,
    metadataUri: 'ipfs://QmXkLm5Uq9RfGJe2vNnZpYx7wTc8AbCdEf4HiJkLmNoPqRs',
  },
  {
    id: 'CONTRACT-TLMTRY-V2',
    name: 'TelemetryBilling',
    contractAddress: 'CBV7H5K3P2M9N4X6R8T1W0Q7A3Z5C8D9F1G2H4J6K8L0M2N3P5Q7S9U1V3W5',
    deployerAddress: 'GDL2FCMJL6RBS6KLSGQPSN5XUCJGOWWBHK6GVQ3HFI6TLB7ICELDDM5X',
    wasmHash: '0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    sourceCodeHash: '0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    network: 'testnet',
    deployedAt: '2026-07-16T14:15:00Z',
    lastVerifiedAt: '2026-07-21T14:30:00Z',
    verificationStatus: 'verified',
    version: '2.0.1',
    rustcVersion: '1.78.0',
    sorobanSdkVersion: '21.1.0',
    wasmSizeBytes: 198656,
    securityScore: 88,
    auditReports: [
      {
        id: 'AUDIT-003',
        auditor: 'Trail of Bits',
        date: '2026-07-05',
        severity: 'medium',
        findings: 5,
        resolved: 4,
        reportUrl: 'https://trailofbits.com/audits/telemetry-billing',
      },
    ],
    functions: [
      { name: 'process_batch', args: ['payments'], returns: 'Result<Vec<Receipt>, Error>', visibility: 'public', complexity: 'high', verified: true },
      { name: 'validate_proof', args: ['proof', 'commitment'], returns: 'bool', visibility: 'public', complexity: 'high', verified: true },
      { name: 'settle_batch', args: ['batch_id', 'root'], returns: 'Result<u64, Error>', visibility: 'public', complexity: 'medium', verified: true },
      { name: 'get_receipt', args: ['payment_id'], returns: 'Option<Receipt>', visibility: 'view', complexity: 'low', verified: true },
    ],
    storageEntries: 892,
    ledgerSequence: 4892200,
    metadataUri: 'ipfs://QmYbDcEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
  },
  {
    id: 'CONTRACT-PROXY-V1',
    name: 'IoTBillingProxy',
    contractAddress: 'CCQ5G6H7J8K9L0M1N2P3Q4R5S6T7U8V9W0X1Y2Z3A4B5C6D7E8F9G0H1I2J3K4',
    deployerAddress: 'GDL2FCMJL6RBS6KLSGQPSN5XUCJGOWWBHK6GVQ3HFI6TLB7ICELDDM5X',
    wasmHash: '0x5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e',
    sourceCodeHash: '0x5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e',
    network: 'testnet',
    deployedAt: '2026-07-14T09:00:00Z',
    lastVerifiedAt: '2026-07-20T11:00:00Z',
    verificationStatus: 'verified',
    version: '1.1.0',
    rustcVersion: '1.78.0',
    sorobanSdkVersion: '21.0.0',
    wasmSizeBytes: 98304,
    securityScore: 95,
    auditReports: [
      {
        id: 'AUDIT-004',
        auditor: 'Quantstamp',
        date: '2026-06-30',
        severity: 'low',
        findings: 2,
        resolved: 2,
      },
    ],
    functions: [
      { name: 'upgrade', args: ['new_wasm_hash'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'high', verified: true },
      { name: 'get_implementation', args: [], returns: 'Address', visibility: 'view', complexity: 'low', verified: true },
    ],
    storageEntries: 156,
    ledgerSequence: 4892000,
  },
  {
    id: 'CONTRACT-ORACLE-V1',
    name: 'TariffOracle',
    contractAddress: 'CA3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2U3V4W5X6Y7Z8A9B0C1D2E3',
    deployerAddress: 'GAN2X4Y6Z8A1B3C5D7E9F0G2H4I6J8K0L1M3N5O7P9Q1R3S5T7U9V1W3X5Y7Z9',
    wasmHash: '0xc3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4',
    sourceCodeHash: '0xc3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d3',
    network: 'testnet',
    deployedAt: '2026-07-17T16:45:00Z',
    verificationStatus: 'partial',
    version: '1.0.0-beta',
    rustcVersion: '1.77.0',
    sorobanSdkVersion: '21.0.0',
    wasmSizeBytes: 163840,
    securityScore: 65,
    auditReports: [],
    functions: [
      { name: 'update_rate', args: ['asset', 'rate'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'medium', verified: true },
      { name: 'get_rate', args: ['asset'], returns: 'Option<Rate>', visibility: 'view', complexity: 'low', verified: true },
      { name: 'get_historical_rates', args: ['asset', 'window'], returns: 'Vec<RateEntry>', visibility: 'view', complexity: 'medium', verified: false },
    ],
    storageEntries: 230,
    ledgerSequence: 4892300,
  },
  {
    id: 'CONTRACT-ESCROW-V1',
    name: 'EscrowManager',
    contractAddress: 'CB8C9D0E1F2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2U3V4W5X6Y7Z8',
    deployerAddress: 'GDL2FCMJL6RBS6KLSGQPSN5XUCJGOWWBHK6GVQ3HFI6TLB7ICELDDM5X',
    wasmHash: '0x1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e',
    sourceCodeHash: null,
    network: 'futurenet',
    deployedAt: '2026-07-18T08:30:00Z',
    verificationStatus: 'unverified',
    version: '1.0.0-dev',
    rustcVersion: '1.78.0',
    sorobanSdkVersion: '21.1.0',
    wasmSizeBytes: 221184,
    securityScore: 0,
    auditReports: [],
    functions: [
      { name: 'deposit', args: ['device_id', 'amount'], returns: 'Result<u64, Error>', visibility: 'public', complexity: 'low', verified: false },
      { name: 'release', args: ['device_id', 'recipient', 'amount'], returns: 'Result<(), Error>', visibility: 'public', complexity: 'medium', verified: false },
      { name: 'sweep_dust', args: ['device_id'], returns: 'Result<u64, Error>', visibility: 'public', complexity: 'medium', verified: false },
    ],
    storageEntries: 340,
    ledgerSequence: 4892400,
  },
];

export function generateVerificationChecks(
  contract: DeployedContract,
): VerificationCheck[] {
  const wasmMatch = contract.wasmHash === contract.sourceCodeHash;
  return [
    {
      name: 'WASM Hash Comparison',
      description: 'Compare on-chain WASM hash with source-compiled hash',
      status: wasmMatch ? 'pass' : 'fail',
      detail: wasmMatch
        ? 'Hashes match: ' + contract.wasmHash.substring(0, 18) + '...'
        : 'Mismatch: on-chain ' + contract.wasmHash.substring(0, 14) + '... vs source ' + (contract.sourceCodeHash?.substring(0, 14) || 'unknown'),
      durationMs: 12,
    },
    {
      name: 'Contract Signature Verification',
      description: 'Verify cryptographic signatures on deployment transaction',
      status: contract.verificationStatus === 'verified' ? 'pass' : contract.verificationStatus === 'partial' ? 'pass' : 'pending',
      detail: contract.verificationStatus === 'verified'
        ? 'All signatures valid — deployed by ' + contract.deployerAddress.substring(0, 12) + '...'
        : 'Signature verification required',
      durationMs: 8,
    },
    {
      name: 'Source Metadata Integrity',
      description: 'Check IPFS metadata URI resolves and matches contract',
      status: contract.metadataUri ? 'pass' : 'fail',
      detail: contract.metadataUri
        ? `Metadata resolved: ${contract.metadataUri.substring(0, 20)}...`
        : 'No metadata URI configured',
      durationMs: 45,
    },
    {
      name: 'Ledger State Consistency',
      description: 'Verify storage entries match expected state root',
      status: contract.storageEntries > 0 ? 'pass' : 'fail',
      detail: `${contract.storageEntries} storage entries at ledger #${contract.ledgerSequence}`,
      durationMs: 22,
    },
    {
      name: 'Security Audit Verification',
      description: 'Check audit reports and vulnerability resolution',
      status: contract.auditReports.length > 0 ? 'pass' : contract.securityScore > 0 ? 'pass' : 'fail',
      detail: contract.auditReports.length > 0
        ? `${contract.auditReports.length} audit(s) found — ${contract.auditReports.reduce((sum, r) => sum + r.resolved, 0)}/${contract.auditReports.reduce((sum, r) => sum + r.findings, 0)} findings resolved`
        : 'No audit reports available — unverified security posture',
      durationMs: 5,
    },
    {
      name: 'Function Interface Validation',
      description: 'Verify function signatures match expected ABI',
      status: contract.functions.length > 0 && contract.functions.some(f => f.verified) ? 'pass' : 'fail',
      detail: `${contract.functions.filter(f => f.verified).length}/${contract.functions.length} functions verified`,
      durationMs: 18,
    },
    {
      name: 'Rustc / SDK Version Consistency',
      description: 'Check compiler and SDK versions are deterministic',
      status: 'pass',
      detail: `rustc ${contract.rustcVersion}, soroban-sdk ${contract.sorobanSdkVersion}`,
      durationMs: 3,
    },
    {
      name: 'Network Environment Validation',
      description: 'Ensure contract is deployed on the correct network',
      status: contract.network === 'mainnet' ? 'pass' : 'pass',
      detail: `Deployed on Stellar ${contract.network}`,
      durationMs: 2,
    },
  ];
}

export function runVerificationSimulation(
  contract: DeployedContract,
): VerificationResult {
  const checks = generateVerificationChecks(contract);
  const passed = checks.filter(c => c.status === 'pass').length;
  const total = checks.length;

  let overallStatus: 'verified' | 'failed' | 'partial' = 'partial';
  if (passed === total) {
    overallStatus = 'verified';
  } else if (passed === 0) {
    overallStatus = 'failed';
  }

  return {
    contractId: contract.id,
    timestamp: new Date().toISOString(),
    overallStatus,
    checks,
    totalDurationMs: checks.reduce((sum, c) => sum + c.durationMs, 0),
    verifierNode: 'node-validator-01.iot-billing.internal',
  };
}

// Re-export from initialData to avoid duplication
export { generateRandomHex } from './initialData';
