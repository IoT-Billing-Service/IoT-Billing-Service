import type {
  DecodedSorobanEvent,
  NotificationSeverity,
  LowBalanceEvent,
  DeviceSuspendedEvent,
  EscrowDisputedEvent,
} from '@/types';

type DecoderFn = (topics: string[], data: Record<string, unknown>) => DecodedSorobanEvent;

const DECODERS: Record<string, DecoderFn> = {
  LowBalance: (topics, data): LowBalanceEvent => ({
    kind: 'LowBalance',
    contractId: String(topics[1] ?? ''),
    deviceId: String(data.deviceId ?? ''),
    balance: String(data.balance ?? '0'),
    threshold: String(data.threshold ?? '0'),
    timestamp: Number(data.timestamp ?? 0),
  }),
  DeviceSuspended: (topics, data): DeviceSuspendedEvent => ({
    kind: 'DeviceSuspended',
    contractId: String(topics[1] ?? ''),
    deviceId: String(data.deviceId ?? ''),
    reason: String(data.reason ?? ''),
    timestamp: Number(data.timestamp ?? 0),
  }),
  EscrowDisputed: (topics, data): EscrowDisputedEvent => ({
    kind: 'EscrowDisputed',
    contractId: String(topics[1] ?? ''),
    escrowId: String(data.escrowId ?? ''),
    amount: String(data.amount ?? '0'),
    initiator: String(data.initiator ?? ''),
    timestamp: Number(data.timestamp ?? 0),
  }),
};

const SEVERITY: Record<DecodedSorobanEvent['kind'], NotificationSeverity> = {
  LowBalance: 'warning',
  DeviceSuspended: 'critical',
  EscrowDisputed: 'critical',
};

const TITLE: Record<DecodedSorobanEvent['kind'], string> = {
  LowBalance: 'Low Balance Warning',
  DeviceSuspended: 'Device Suspended',
  EscrowDisputed: 'Escrow Dispute',
};

export function decodeSorobanEvent(
  topics: string[],
  data: Record<string, unknown>,
): DecodedSorobanEvent | null {
  const eventName = topics[0];
  if (!eventName) return null;
  const decoder = DECODERS[eventName];
  return decoder ? decoder(topics, data) : null;
}

export function getEventSeverity(kind: DecodedSorobanEvent['kind']): NotificationSeverity {
  return SEVERITY[kind];
}

export function getEventTitle(kind: DecodedSorobanEvent['kind']): string {
  return TITLE[kind];
}

export function buildNotificationMessage(event: DecodedSorobanEvent): string {
  switch (event.kind) {
    case 'LowBalance':
      return `Device ${event.deviceId} balance (${event.balance}) is below threshold ${event.threshold}`;
    case 'DeviceSuspended':
      return `Device ${event.deviceId} has been suspended: ${event.reason}`;
    case 'EscrowDisputed':
      return `Escrow ${event.escrowId} disputed for ${event.amount} by ${event.initiator}`;
  }
}
