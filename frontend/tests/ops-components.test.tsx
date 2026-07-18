import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FleetStatusCard } from '../../src/components/ops/FleetStatusCard';
import { BillingOverviewCard } from '../../src/components/ops/BillingOverviewCard';
import { SystemHealthCard } from '../../src/components/ops/SystemHealthCard';
import { IngestionHealthCard } from '../../src/components/ops/IngestionHealthCard';
import { DashboardHeader } from '../../src/components/ops/DashboardHeader';
import type { SystemHealthSnapshot } from '../../src/components/ops/useDashboardData';

// ── FleetStatusCard ───────────────────────────────────────────────────────────

describe('FleetStatusCard', () => {
  it('renders device counts', () => {
    render(
      <FleetStatusCard devices={{ total: 100, enabled: 90, disabled: 10 }} />,
    );

    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('shows Healthy status when online rate >= 90%', () => {
    render(
      <FleetStatusCard devices={{ total: 100, enabled: 95, disabled: 5 }} />,
    );
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('shows Degraded status when online rate is 70-89%', () => {
    render(
      <FleetStatusCard devices={{ total: 100, enabled: 75, disabled: 25 }} />,
    );
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('shows Critical status when online rate < 70%', () => {
    render(
      <FleetStatusCard devices={{ total: 100, enabled: 50, disabled: 50 }} />,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('renders Fleet Status heading', () => {
    render(
      <FleetStatusCard devices={{ total: 0, enabled: 0, disabled: 0 }} />,
    );
    expect(screen.getByText('Fleet Status')).toBeInTheDocument();
  });

  it('handles zero devices', () => {
    render(
      <FleetStatusCard devices={{ total: 0, enabled: 0, disabled: 0 }} />,
    );
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});

// ── BillingOverviewCard ───────────────────────────────────────────────────────

describe('BillingOverviewCard', () => {
  const defaultBilling = {
    totalRecords: 500,
    pending: 10,
    settled: 490,
    totalUsageAmount: '5000000',
    settledUsageAmount: '4900000',
  };

  const defaultCycles = {
    total: 50,
    open: 2,
    finalizing: 1,
    finalized: 3,
    settled: 44,
  };

  it('renders billing record counts', () => {
    render(
      <BillingOverviewCard billing={defaultBilling} cycles={defaultCycles} />,
    );

    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('490')).toBeInTheDocument();
  });

  it('renders cycle pipeline stages', () => {
    render(
      <BillingOverviewCard billing={defaultBilling} cycles={defaultCycles} />,
    );

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Finalizing')).toBeInTheDocument();
    expect(screen.getByText('Finalized')).toBeInTheDocument();
    expect(screen.getByText('Settled')).toBeInTheDocument();
  });

  it('renders Billing Overview heading', () => {
    render(
      <BillingOverviewCard billing={defaultBilling} cycles={defaultCycles} />,
    );
    expect(screen.getByText('Billing Overview')).toBeInTheDocument();
  });

  it('renders settlement rate', () => {
    render(
      <BillingOverviewCard billing={defaultBilling} cycles={defaultCycles} />,
    );
    expect(screen.getByText('Settlement Rate')).toBeInTheDocument();
    expect(screen.getByText('98%')).toBeInTheDocument();
  });

  it('handles zero records', () => {
    render(
      <BillingOverviewCard
        billing={{
          totalRecords: 0,
          pending: 0,
          settled: 0,
          totalUsageAmount: '0',
          settledUsageAmount: '0',
        }}
        cycles={defaultCycles}
      />,
    );
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});

// ── SystemHealthCard ──────────────────────────────────────────────────────────

describe('SystemHealthCard', () => {
  const healthyHealth: SystemHealthSnapshot = {
    eventLoopLagMs: 5.2,
    gcPause: { p50: 2, p99: 15, count: 100 },
    dbPool: { total: 20, active: 8, idle: 12, waiting: 0 },
    ledgerSync: { lag: 0, lastSyncedSequence: 12345, latestPolledSequence: 12347 },
    circuitBreaker: { state: 0, queueDepth: 0 },
    ingestionQueueDepth: 50,
    uptimeSeconds: 86400,
    timestamp: Date.now(),
  };

  it('renders System Health heading', () => {
    render(<SystemHealthCard health={healthyHealth} />);
    expect(screen.getByText('System Health')).toBeInTheDocument();
  });

  it('shows healthy event loop lag', () => {
    render(<SystemHealthCard health={healthyHealth} />);
    expect(screen.getByText('5.2ms')).toBeInTheDocument();
  });

  it('shows healthy GC pause', () => {
    render(<SystemHealthCard health={healthyHealth} />);
    expect(screen.getByText('15ms')).toBeInTheDocument();
  });

  it('shows DB pool stats', () => {
    render(<SystemHealthCard health={healthyHealth} />);
    expect(screen.getByText('8/20 active')).toBeInTheDocument();
  });

  it('shows ledger in sync', () => {
    render(<SystemHealthCard health={healthyHealth} />);
    expect(screen.getByText('In sync')).toBeInTheDocument();
  });

  it('shows loading state when health is undefined', () => {
    render(<SystemHealthCard health={undefined} />);
    expect(screen.getByText('Loading system metrics...')).toBeInTheDocument();
  });

  it('shows unhealthy event loop', () => {
    const unhealthy = {
      ...healthyHealth,
      eventLoopLagMs: 250,
    };
    render(<SystemHealthCard health={unhealthy} />);
    expect(screen.getByText('250.0ms')).toBeInTheDocument();
  });

  it('shows open circuit breaker', () => {
    const cbOpen = {
      ...healthyHealth,
      circuitBreaker: { state: 2, queueDepth: 50 },
    };
    render(<SystemHealthCard health={cbOpen} />);
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });
});

// ── IngestionHealthCard ───────────────────────────────────────────────────────

describe('IngestionHealthCard', () => {
  const healthyHealth: SystemHealthSnapshot = {
    eventLoopLagMs: 5,
    gcPause: { p50: 1, p99: 10, count: 50 },
    dbPool: { total: 20, active: 5, idle: 15, waiting: 0 },
    ledgerSync: { lag: 0, lastSyncedSequence: 100, latestPolledSequence: 100 },
    circuitBreaker: { state: 0, queueDepth: 0 },
    ingestionQueueDepth: 50,
    uptimeSeconds: 3600,
    timestamp: Date.now(),
  };

  it('renders Ingestion Pipeline heading', () => {
    render(<IngestionHealthCard health={healthyHealth} />);
    expect(screen.getByText('Ingestion Pipeline')).toBeInTheDocument();
  });

  it('shows Healthy status for low queue depth', () => {
    render(<IngestionHealthCard health={healthyHealth} />);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('shows Backpressure for high queue depth', () => {
    const backpressure = {
      ...healthyHealth,
      ingestionQueueDepth: 1500,
    };
    render(<IngestionHealthCard health={backpressure} />);
    expect(screen.getByText('Backpressure')).toBeInTheDocument();
  });

  it('shows queue depth value', () => {
    render(<IngestionHealthCard health={healthyHealth} />);
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('shows Low pressure label', () => {
    render(<IngestionHealthCard health={healthyHealth} />);
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('shows Critical pressure for very high queue depth', () => {
    const critical = {
      ...healthyHealth,
      ingestionQueueDepth: 2000,
    };
    render(<IngestionHealthCard health={critical} />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('handles undefined health', () => {
    render(<IngestionHealthCard health={undefined} />);
    expect(screen.getByText('Ingestion Pipeline')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

// ── DashboardHeader ───────────────────────────────────────────────────────────

describe('DashboardHeader', () => {
  it('renders heading', () => {
    render(
      <DashboardHeader lastUpdated={null} onRefresh={() => {}} isRefreshing={false} />,
    );
    expect(screen.getByText('Operational Dashboard')).toBeInTheDocument();
  });

  it('shows PCI-DSS / SOC2 badge', () => {
    render(
      <DashboardHeader lastUpdated={null} onRefresh={() => {}} isRefreshing={false} />,
    );
    expect(screen.getByText('PCI-DSS / SOC2')).toBeInTheDocument();
  });

  it('shows last updated time', () => {
    const date = new Date('2024-01-15T12:30:00');
    render(
      <DashboardHeader lastUpdated={date} onRefresh={() => {}} isRefreshing={false} />,
    );
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    render(
      <DashboardHeader lastUpdated={null} onRefresh={() => {}} isRefreshing={false} />,
    );
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('disables refresh button when refreshing', () => {
    render(
      <DashboardHeader lastUpdated={null} onRefresh={() => {}} isRefreshing={true} />,
    );
    const button = screen.getByText('Refresh').closest('button');
    expect(button).toBeDisabled();
  });
});
