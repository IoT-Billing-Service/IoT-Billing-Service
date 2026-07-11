export interface DeviceTelemetry {
  deviceId: string;
  timestamp: number;
  metrics: {
    powerUsage: number;
    signalStrength: number;
    temperature: number;
    batteryLevel: number;
  };
  location?: {
    lat: number;
    lng: number;
  };
  metadata?: Record<string, string>;
}

export interface Transaction {
  hash: string;
  type: 'escrow_deposit' | 'escrow_withdrawal' | 'device_registration' | 'billing_payment';
  status: 'pending' | 'confirmed' | 'failed' | 'retrying';
  amount: string;
  asset: string;
  source: string;
  destination: string;
  timestamp: number;
  memo?: string;
  signature?: string;
  ledger?: number;
}

export interface WalletMetrics {
  publicKey: string;
  balances: AssetBalance[];
  network: 'testnet' | 'mainnet' | 'futurenet';
  isConnected: boolean;
  chainId?: string;
}

export interface AssetBalance {
  asset: string;
  issuer?: string;
  balance: string;
  decimals: number;
}

export interface EscrowBalance {
  totalLocked: string;
  available: string;
  pendingRelease: string;
  asset: string;
  contractId: string;
}

export interface FleetView {
  fleetId: string;
  name: string;
  deviceCount: number;
  activeCount: number;
  totalPowerOutput: number;
  status: 'active' | 'inactive' | 'degraded';
}

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasNextPage: boolean;
}

export interface TelemetryHistoryPoint {
  timestamp: number;
  value: number;
  deviceId?: string;
}

export interface ProcessedHistoryChunk {
  averages: number[];
  totals: number[];
  timestamps: number[];
  startTime: number;
  endTime: number;
}

export interface ChunkedHistoryState {
  data: TelemetryHistoryPoint[];
  isLoading: boolean;
  progress: number;
  error: Error | null;
}

export interface Web3AuthSession {
  nonce: string;
  signedChallenge: string;
  jwt: string;
  expiresAt: number;
  publicKey: string;
}

export interface SorobanEvent {
  contractId: string;
  topic: string;
  topics?: string[];
  data: string;
  ledger: number;
  timestamp: number;
  decoded?: Record<string, unknown>;
}

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface LowBalanceEvent {
  kind: 'LowBalance';
  contractId: string;
  deviceId: string;
  balance: string;
  threshold: string;
  timestamp: number;
}

export interface DeviceSuspendedEvent {
  kind: 'DeviceSuspended';
  contractId: string;
  deviceId: string;
  reason: string;
  timestamp: number;
}

export interface EscrowDisputedEvent {
  kind: 'EscrowDisputed';
  contractId: string;
  escrowId: string;
  amount: string;
  initiator: string;
  timestamp: number;
}

export type DecodedSorobanEvent = LowBalanceEvent | DeviceSuspendedEvent | EscrowDisputedEvent;

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  event: DecodedSorobanEvent;
  timestamp: number;
  dismissed: boolean;
}

// ─── Fleet / Multi-Tenant ────────────────────────────────────────────

export interface FleetDevice {
  deviceId: string;
  fleetId: string;
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'provisioning';
  lastSeen: number;
  metrics: {
    powerUsage: number;
    signalStrength: number;
    temperature: number;
    batteryLevel: number;
    dataRate: number;
  };
  location?: {
    lat: number;
    lng: number;
  };
  metadata?: Record<string, string>;
}

export interface FleetMetricsSummary {
  fleetId: string;
  fleetName: string;
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  degradedDevices: number;
  averagePowerUsage: number;
  totalDataRate: number;
  ingestionFailureCount: number;
  lastUpdated: number;
}

export interface IngestionFailure {
  id: string;
  fleetId: string;
  deviceId: string;
  failedAt: number;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
  resolved: boolean;
  resolvedAt?: number;
}

export interface MetricStreamPoint {
  timestamp: number;
  fleetId: string;
  metricName: string;
  value: number;
  unit: string;
}

export interface SorobanContractPayment {
  transactionHash: string;
  contractId: string;
  type: 'escrow_deposit' | 'escrow_withdrawal' | 'billing_settlement' | 'funding_adjustment';
  amount: string;
  asset: string;
  status: 'pending' | 'confirmed' | 'failed';
  source: string;
  destination: string;
  timestamp: number;
  memo?: string;
  ledger?: number;
  fee?: string;
}

export interface EscrowAccountState {
  contractId: string;
  totalLocked: string;
  available: string;
  pendingRelease: string;
  totalDeposited: string;
  totalWithdrawn: string;
  asset: string;
  lastActivity: number;
  disputeActive: boolean;
}
