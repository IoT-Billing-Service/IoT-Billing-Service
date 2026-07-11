import BigNumber from 'bignumber.js';

// Configure BigNumber for banker's rounding (round-half-to-even)
BigNumber.config({
  ROUNDING_MODE: BigNumber.ROUND_HALF_EVEN,
});

export type AssetFormatter = {
  fromSorobanInt(raw: string | bigint): string;
  toSorobanInt(display: string | number): string;
  format(amount: string | number, decimals?: number): string;
};

/**
 * Factory to create a formatter for a specific asset decimal precision.
 * Precomputes divisor and multiplier for performance.
 */
export function createAssetFormatter(decimals: number): AssetFormatter {
  const divisor = new BigNumber(10).pow(decimals);
  const multiplier = new BigNumber(10).pow(decimals);

  return {
    fromSorobanInt(raw: string | bigint): string {
      const value = new BigNumber(raw.toString());
      return value.div(divisor).toFixed(decimals);
    },
    toSorobanInt(display: string | number): string {
      const value = new BigNumber(display);
      return value.times(multiplier).integerValue().toString();
    },
    format(amount: string | number, fmtDecimals: number = 2): string {
      try {
        const value = new BigNumber(amount);
        if (value.isNaN()) return '0.00';
        return value.toFormat(fmtDecimals);
      } catch {
        return '0.00';
      }
    },
  };
}

// Default formatter using Soroban's native 7-decimal assets.
export const defaultFormatter = createAssetFormatter(7);

// Backwards‑compatible helpers (retain original signatures).
export function fromSorobanInt(raw: string | bigint, decimals: number = 7): string {
  return createAssetFormatter(decimals).fromSorobanInt(raw);
}

export function toSorobanInt(display: string | number, decimals: number = 7): string {
  return createAssetFormatter(decimals).toSorobanInt(display);
}

export function formatCurrency(amount: string | number, decimals: number = 2): string {
  return defaultFormatter.format(amount, decimals);
}

export function formatCompact(amount: string | number): string {
  const value = new BigNumber(amount);
  if (value.isNaN()) return '0';
  if (value.isLessThan(1000)) return value.toFormat(2);
  if (value.isLessThan(1_000_000)) return value.dividedBy(1000).toFormat(1) + 'K';
  if (value.isLessThan(1_000_000_000)) return value.dividedBy(1_000_000).toFormat(1) + 'M';
  return value.dividedBy(1_000_000_000).toFormat(1) + 'B';
}

export function compareBalances(a: string, b: string): number {
  return new BigNumber(a).comparedTo(new BigNumber(b)) ?? 0;
}

/**
 * Aggregate an array of balances with individual decimal definitions.
 * Each balance object must contain `amount` (string|number) and `decimals`.
 */
export function formatAggregate(balances: { amount: string | number; decimals: number }[]): string {
  if (balances.length === 0) return '0';
  const maxDecimals = Math.max(...balances.map((b) => b.decimals));
  const commonMultiplier = new BigNumber(10).pow(maxDecimals);
  let total = new BigNumber(0);
  balances.forEach(({ amount, decimals }) => {
    const formatter = createAssetFormatter(decimals);
    const sorobanInt = new BigNumber(formatter.toSorobanInt(amount));
    const adjusted = sorobanInt.times(new BigNumber(10).pow(maxDecimals - decimals));
    total = total.plus(adjusted);
  });
  return total.dividedBy(commonMultiplier).toFixed(maxDecimals);
}
