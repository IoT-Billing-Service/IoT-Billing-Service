import { DePinNode, VariableTariff } from '../types';

export const INITIAL_TARIFFS: VariableTariff[] = [
  {
    id: 'TARIFF-ENV-STD',
    name: 'Standard Environmental (Clean Air)',
    baseRatePerPayload: 0.002,
    sizeRatePerKB: 0.001,
    gasBuffer: 0.0005,
    carbonCreditStreamingMultiplier: 1.2, // 20% bonus in carbon offsets
  },
  {
    id: 'TARIFF-GRID-PREM',
    name: 'Premium Microgrid Feed (High Freq)',
    baseRatePerPayload: 0.008,
    sizeRatePerKB: 0.002,
    gasBuffer: 0.0015,
    carbonCreditStreamingMultiplier: 1.5, // 50% bonus for renewable dispatch alignment
  },
  {
    id: 'TARIFF-WIFI-VOL',
    name: 'Helium Dense Volume Router',
    baseRatePerPayload: 0.001,
    sizeRatePerKB: 0.006,
    gasBuffer: 0.0008,
    carbonCreditStreamingMultiplier: 1.0,
  },
];

export const INITIAL_NODES: DePinNode[] = [
  {
    id: 'DePIN-ENV-081',
    name: 'Munich Air Quality Sensor',
    status: 'online',
    balance: 45.25,
    maxEscrowCapacity: 150.0,
    totalBilled: 12.84,
    lastTelemetryValue: 22.4, // Celsius
    unit: '°C',
    type: 'environmental',
    tariffId: 'TARIFF-ENV-STD',
    ipAddress: '192.168.10.81',
    rentCostPerHour: 0.015,
  },
  {
    id: 'DePIN-GRID-102',
    name: 'Berlin Solar Dispatch Grid',
    status: 'online',
    balance: 112.80,
    maxEscrowCapacity: 300.0,
    totalBilled: 84.15,
    lastTelemetryValue: 845.2, // kW dispatch
    unit: 'kW',
    type: 'power_grid',
    tariffId: 'TARIFF-GRID-PREM',
    ipAddress: '10.0.12.102',
    rentCostPerHour: 0.045,
  },
  {
    id: 'DePIN-WIFI-540',
    name: 'Hamburg High-Throughput Helium Node',
    status: 'online',
    balance: 8.45, // dangerously low, close to auto-pause
    maxEscrowCapacity: 100.0,
    totalBilled: 91.55,
    lastTelemetryValue: 142.8, // Mbps bandwidth demand
    unit: 'Mbps',
    type: 'helium_hotspot',
    tariffId: 'TARIFF-WIFI-VOL',
    ipAddress: '172.16.42.5',
    rentCostPerHour: 0.02,
  },
];

// Hex generator utility for simulation
export function generateRandomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '0x';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}
