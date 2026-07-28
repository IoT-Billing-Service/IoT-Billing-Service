export type DeviceStatus = 'online' | 'offline' | 'paused' | 'exhausted';
export type DeviceType = 'environmental' | 'power_grid' | 'helium_hotspot';

export interface DePinNode {
  id: string;
  name: string;
  status: DeviceStatus;
  balance: number; // in XLM
  maxEscrowCapacity: number; // in XLM
  totalBilled: number; // in XLM
  lastTelemetryValue: number;
  unit: string;
  type: DeviceType;
  tariffId: string;
  ipAddress: string;
  rentCostPerHour: number; // auto rent deduction
}

export interface VariableTariff {
  id: string;
  name: string;
  baseRatePerPayload: number; // in XLM
  sizeRatePerKB: number; // in XLM
  gasBuffer: number; // in XLM
  carbonCreditStreamingMultiplier: number;
}

export interface TelemetryPayload {
  id: string;
  nodeId: string;
  nodeName: string;
  timestamp: string;
  value: number;
  unit: string;
  payloadSizeKB: number;
  cost: number; // calculated XLM
  zkVerified: boolean;
  rawHex: string;
  isProofInProgress?: boolean;
}

export interface RetryQueueTransaction {
  id: string;
  nodeId: string;
  nodeName: string;
  payload: string;
  cost: number;
  timestamp: string;
  retries: number;
  status: 'buffered' | 'syncing' | 'failed';
  errorReason?: string;
}

export interface SystemMetrics {
  totalNodesOnline: number;
  totalXlmBilled: number;
  totalEscrowLocked: number;
  averageLatencyMs: number;
  zkVerifySuccessCount: number;
  bufferedTxCount: number;
}

// ─── Contract Verification Types ─────────────────────────────────────────────

export type VerificationStatus = 'unverified' | 'pending' | 'partial' | 'verified' | 'failed';
export type NetworkEnvironment = 'mainnet' | 'testnet' | 'futurenet' | 'standalone';

export interface DeployedContract {
  id: string;
  name: string;
  contractAddress: string;
  deployerAddress: string;
  wasmHash: string;
  sourceCodeHash: string | null;
  network: NetworkEnvironment;
  deployedAt: string;
  lastVerifiedAt?: string;
  verificationStatus: VerificationStatus;
  version: string;
  rustcVersion: string;
  sorobanSdkVersion: string;
  wasmSizeBytes: number;
  securityScore: number; // 0-100
  auditReports: ContractAuditReport[];
  functions: ContractFunction[];
  storageEntries: number;
  ledgerSequence: number;
  metadataUri?: string;
}

export interface ContractAuditReport {
  id: string;
  auditor: string;
  date: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  findings: number;
  resolved: number;
  reportUrl?: string;
}

export interface ContractFunction {
  name: string;
  args: string[];
  returns: string;
  visibility: 'public' | 'private' | 'view';
  complexity: 'low' | 'medium' | 'high';
  verified: boolean;
}

export interface VerificationCheck {
  name: string;
  description: string;
  status: 'pass' | 'fail' | 'running' | 'pending';
  detail?: string;
  durationMs: number;
}

export interface VerificationResult {
  contractId: string;
  timestamp: string;
  overallStatus: 'verified' | 'failed' | 'partial';
  checks: VerificationCheck[];
  totalDurationMs: number;
  verifierNode: string;
}
