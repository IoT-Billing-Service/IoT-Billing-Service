export interface BillingAnalyticsPoint {
  date: string; // ISO date, YYYY-MM-DD
  usageKwh: number;
  amountXlm: number;
  activeDevices: number;
}

export interface BillingAnalyticsResponse {
  from: string;
  to: string;
  totalUsageKwh: number;
  totalAmountXlm: number;
  points: BillingAnalyticsPoint[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Deterministic pseudo-random generator seeded by day index, so repeated
 * requests for the same range return stable data instead of different
 * numbers every time (keeps the Playwright assertion reliable).
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function generateMockAnalytics(from: Date, to: Date): BillingAnalyticsResponse {
  const dayCount = Math.max(1, daysBetween(from, to) + 1);
  const points: BillingAnalyticsPoint[] = [];

  let totalUsageKwh = 0;
  let totalAmountXlm = 0;

  for (let i = 0; i < dayCount; i++) {
    const day = new Date(from.getTime() + i * MS_PER_DAY);
    const r = seededRandom(i + 1);

    const usageKwh = 40 + r * 30 + (i / dayCount) * 15;
    const amountXlm = usageKwh * (2.1 + seededRandom(i + 100) * 0.4);
    const activeDevices = Math.round(900 + r * 400);

    totalUsageKwh += usageKwh;
    totalAmountXlm += amountXlm;

    points.push({
      date: toDateOnly(day),
      usageKwh: Math.round(usageKwh * 100) / 100,
      amountXlm: Math.round(amountXlm * 100) / 100,
      activeDevices,
    });
  }

  return {
    from: toDateOnly(from),
    to: toDateOnly(to),
    totalUsageKwh: Math.round(totalUsageKwh * 100) / 100,
    totalAmountXlm: Math.round(totalAmountXlm * 100) / 100,
    points,
  };
}
