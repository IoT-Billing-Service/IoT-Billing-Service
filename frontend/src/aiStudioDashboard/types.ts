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
