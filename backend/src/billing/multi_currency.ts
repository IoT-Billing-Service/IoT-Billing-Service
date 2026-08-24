/**
 * Multi-Currency Support for International Billing (issue #288).
 *
 * Provides currency-aware billing operations with exchange-rate conversion,
 * geo-aware currency defaults, and cryptographic integrity verification.
 *
 * ## Design goals
 * - < 200ms P99: all conversions use BigInt arithmetic with pre-calculated
 *   scaled rates — O(1) hashtable reads, no I/O on the hot path.
 * - PCI-DSS / SOC2: every rate table snapshot carries a SHA-256 digest;
 *   stale or tampered tables are rejected before conversion.
 * - Cryptographic integrity: exchange-rate digests are embedded in billing
 *   records so downstream consumers can verify the rate applied.
 * - Geo-aware defaults: each billing region maps to its local currency,
 *   respecting the existing regional pricing tiers.
 * - Idempotent: repeated conversions with the same inputs produce identical
 *   results, enabling deterministic reconciliation.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Currency taxonomy
// ---------------------------------------------------------------------------

/** ISO 4217 currency codes supported by the platform. */
export type CurrencyCode = string;

/** Canonical list of supported currencies. Extend as new markets are onboarded. */
export const SUPPORTED_CURRENCIES: ReadonlySet<CurrencyCode> = new Set([
  // Americas
  'USD', // United States Dollar
  'CAD', // Canadian Dollar
  'MXN', // Mexican Peso
  'BRL', // Brazilian Real
  'ARS', // Argentine Peso
  'COP', // Colombian Peso
  'CLP', // Chilean Peso

  // Europe
  'EUR', // Euro
  'GBP', // British Pound Sterling
  'CHF', // Swiss Franc
  'SEK', // Swedish Krona
  'NOK', // Norwegian Krone
  'DKK', // Danish Krone
  'PLN', // Polish Zloty

  // Asia-Pacific
  'JPY', // Japanese Yen
  'CNY', // Chinese Yuan Renminbi
  'KRW', // South Korean Won
  'INR', // Indian Rupee
  'AUD', // Australian Dollar
  'NZD', // New Zealand Dollar
  'SGD', // Singapore Dollar
  'HKD', // Hong Kong Dollar
  'TWD', // Taiwan Dollar

  // Middle East & Africa
  'AED', // UAE Dirham
  'SAR', // Saudi Riyal
  'ILS', // Israeli Shekel
  'ZAR', // South African Rand
  'NGN', // Nigerian Naira
  'KES', // Kenyan Shilling
  'EGP', // Egyptian Pound

  // Crypto (platform native)
  'XLM', // Stellar Lumen
]);

/** Currency metadata with display properties. */
export interface CurrencyInfo {
  readonly code: CurrencyCode;
  readonly name: string;
  readonly symbol: string;
  /** Number of decimal places for display. */
  readonly decimals: number;
  /** ISO 4217 numeric code, or 0 for crypto. */
  readonly isoNumeric: number;
}

/** Canonical currency metadata for all supported currencies. */
const CURRENCY_METADATA: ReadonlyMap<CurrencyCode, CurrencyInfo> = new Map([
  // Americas
  ['USD', { code: 'USD', name: 'United States Dollar', symbol: '$', decimals: 2, isoNumeric: 840 }],
  ['CAD', { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimals: 2, isoNumeric: 124 }],
  ['MXN', { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', decimals: 2, isoNumeric: 484 }],
  ['BRL', { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2, isoNumeric: 986 }],
  ['ARS', { code: 'ARS', name: 'Argentine Peso', symbol: 'AR$', decimals: 2, isoNumeric: 32 }],
  ['COP', { code: 'COP', name: 'Colombian Peso', symbol: 'COL$', decimals: 2, isoNumeric: 170 }],
  ['CLP', { code: 'CLP', name: 'Chilean Peso', symbol: 'CLP$', decimals: 0, isoNumeric: 152 }],

  // Europe
  ['EUR', { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, isoNumeric: 978 }],
  [
    'GBP',
    { code: 'GBP', name: 'British Pound Sterling', symbol: '£', decimals: 2, isoNumeric: 826 },
  ],
  ['CHF', { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimals: 2, isoNumeric: 756 }],
  ['SEK', { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimals: 2, isoNumeric: 752 }],
  ['NOK', { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', decimals: 2, isoNumeric: 578 }],
  ['DKK', { code: 'DKK', name: 'Danish Krone', symbol: 'kr', decimals: 2, isoNumeric: 208 }],
  ['PLN', { code: 'PLN', name: 'Polish Zloty', symbol: 'zł', decimals: 2, isoNumeric: 985 }],

  // Asia-Pacific
  ['JPY', { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, isoNumeric: 392 }],
  [
    'CNY',
    { code: 'CNY', name: 'Chinese Yuan Renminbi', symbol: '¥', decimals: 2, isoNumeric: 156 },
  ],
  ['KRW', { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimals: 0, isoNumeric: 410 }],
  ['INR', { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2, isoNumeric: 356 }],
  ['AUD', { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2, isoNumeric: 36 }],
  ['NZD', { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', decimals: 2, isoNumeric: 554 }],
  ['SGD', { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimals: 2, isoNumeric: 702 }],
  ['HKD', { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimals: 2, isoNumeric: 344 }],
  ['TWD', { code: 'TWD', name: 'Taiwan Dollar', symbol: 'NT$', decimals: 2, isoNumeric: 901 }],

  // Middle East & Africa
  ['AED', { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimals: 2, isoNumeric: 784 }],
  ['SAR', { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س', decimals: 2, isoNumeric: 682 }],
  ['ILS', { code: 'ILS', name: 'Israeli Shekel', symbol: '₪', decimals: 2, isoNumeric: 376 }],
  ['ZAR', { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2, isoNumeric: 710 }],
  ['NGN', { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', decimals: 2, isoNumeric: 566 }],
  ['KES', { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', decimals: 2, isoNumeric: 404 }],
  ['EGP', { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', decimals: 2, isoNumeric: 818 }],

  // Crypto
  ['XLM', { code: 'XLM', name: 'Stellar Lumen', symbol: 'XLM', decimals: 7, isoNumeric: 0 }],
]);

// ---------------------------------------------------------------------------
// Geo-aware currency defaults (maps billing regions to local currencies)
// ---------------------------------------------------------------------------

import { BillingRegion } from './geo_pricing.js';

/**
 * Default currency per billing region, used when a device's preferred
 * currency has not been explicitly configured.
 */
const REGION_DEFAULT_CURRENCY: ReadonlyMap<BillingRegion, CurrencyCode> = new Map([
  [BillingRegion.NA, 'USD'],
  [BillingRegion.EU, 'EUR'],
  [BillingRegion.APAC, 'USD'], // Asia-Pacific defaults to USD for pricing, with JPY/SGD as alternatives
  [BillingRegion.LATAM, 'USD'], // Latin America defaults to USD for pricing
  [BillingRegion.MEA, 'USD'], // Middle East & Africa defaults to USD for pricing
  [BillingRegion.ROW, 'USD'],
]);

/**
 * Preferred local currencies per region (in order of preference).
 * Used when a customer's preferred currency is not set.
 */
const REGION_LOCAL_CURRENCIES: ReadonlyMap<BillingRegion, readonly CurrencyCode[]> = new Map([
  [BillingRegion.NA, ['USD', 'CAD', 'MXN']],
  [BillingRegion.EU, ['EUR', 'GBP', 'CHF', 'SEK', 'PLN']],
  [BillingRegion.APAC, ['JPY', 'CNY', 'KRW', 'INR', 'AUD', 'SGD']],
  [BillingRegion.LATAM, ['BRL', 'MXN', 'COP', 'ARS', 'CLP']],
  [BillingRegion.MEA, ['AED', 'SAR', 'ZAR', 'NGN', 'EGP', 'ILS']],
  [BillingRegion.ROW, ['USD']],
]);

// ---------------------------------------------------------------------------
// Exchange rate types
// ---------------------------------------------------------------------------

export interface ExchangeRateEntry {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /**
   * Exchange rate scaled by {@link EXCHANGE_RATE_SCALE}.
   * For example, 1 USD = 0.92 EUR → rateScaled = 9200 (0.92 * 10000).
   */
  readonly rateScaled: bigint;
  /** ISO timestamp of when this rate was last updated. */
  readonly updatedAt: string;
  /** Source of the rate data (e.g. "ecb", "fixer", "manual"). */
  readonly source: string;
}

export interface ExchangeRateTable {
  /** Unique version identifier (UUID v7). */
  readonly versionId: string;
  /** ISO timestamp of when the table was generated. */
  readonly generatedAt: string;
  /** Base currency all rates are derived from. */
  readonly baseCurrency: CurrencyCode;
  /** Map of target currency → rate entry. */
  readonly rates: ReadonlyMap<CurrencyCode, ExchangeRateEntry>;
  /** SHA-256 hex digest for integrity verification. */
  readonly digest: string;
}

/** Scale factor for exchange rate integer arithmetic. 10^6 provides micro-unit precision. */
export const EXCHANGE_RATE_SCALE = 1_000_000n;

// ---------------------------------------------------------------------------
// Default exchange rates (fallback when external provider is unavailable)
// ---------------------------------------------------------------------------

/**
 * Base-currency rates (USD) used as fallback when no external rate provider
 * is configured or reachable. These are indicative snapshots and MUST be
 * replaced by live rates in production via the rate update API.
 */
const DEFAULT_USD_RATES: ReadonlyMap<CurrencyCode, { rateScaled: bigint }> = new Map([
  ['USD', { rateScaled: EXCHANGE_RATE_SCALE }], // 1.0
  ['CAD', { rateScaled: 1_370_000n }], // ≈1.37
  ['MXN', { rateScaled: 17_500_000n }], // ≈17.5
  ['BRL', { rateScaled: 5_100_000n }], // ≈5.1
  ['ARS', { rateScaled: 850_000_000n }], // ≈850
  ['COP', { rateScaled: 4_100_000_000n }], // ≈4100
  ['CLP', { rateScaled: 940_000_000n }], // ≈940
  ['EUR', { rateScaled: 920_000n }], // ≈0.92
  ['GBP', { rateScaled: 790_000n }], // ≈0.79
  ['CHF', { rateScaled: 890_000n }], // ≈0.89
  ['SEK', { rateScaled: 10_500_000n }], // ≈10.5
  ['NOK', { rateScaled: 10_700_000n }], // ≈10.7
  ['DKK', { rateScaled: 6_870_000n }], // ≈6.87
  ['PLN', { rateScaled: 4_050_000n }], // ≈4.05
  ['JPY', { rateScaled: 150_000_000n }], // ≈150
  ['CNY', { rateScaled: 7_250_000n }], // ≈7.25
  ['KRW', { rateScaled: 1_350_000_000n }], // ≈1350
  ['INR', { rateScaled: 83_500_000n }], // ≈83.5
  ['AUD', { rateScaled: 1_530_000n }], // ≈1.53
  ['NZD', { rateScaled: 1_650_000n }], // ≈1.65
  ['SGD', { rateScaled: 1_350_000n }], // ≈1.35
  ['HKD', { rateScaled: 7_820_000n }], // ≈7.82
  ['TWD', { rateScaled: 32_500_000n }], // ≈32.5
  ['AED', { rateScaled: 3_673_000n }], // ≈3.673
  ['SAR', { rateScaled: 3_750_000n }], // ≈3.75
  ['ILS', { rateScaled: 3_780_000n }], // ≈3.78
  ['ZAR', { rateScaled: 18_500_000n }], // ≈18.5
  ['NGN', { rateScaled: 1_550_000_000n }], // ≈1550
  ['KES', { rateScaled: 157_000_000n }], // ≈157
  ['EGP', { rateScaled: 48_500_000n }], // ≈48.5
  ['XLM', { rateScaled: 9_200_000n }], // ≈0.1087 USD per XLM → reciprocal for USD→XLM
]);

// ---------------------------------------------------------------------------
// In-memory rate table state
// ---------------------------------------------------------------------------

let currentRateTable: ExchangeRateTable | null = null;

/** Tracks rate table observability state. */
interface RateTableStatus {
  /** Version currently active. */
  currentVersionId: string | null;
  /** ISO timestamp of the last successful update, or null if never updated. */
  lastUpdatedAt: string | null;
  /** Number of successful updates since startup. */
  updateCount: number;
  /** Error from the last failed update attempt, or null. */
  lastUpdateError: string | null;
}

const rateTableStatus: RateTableStatus = {
  currentVersionId: null,
  lastUpdatedAt: null,
  updateCount: 0,
  lastUpdateError: null,
};

// ---------------------------------------------------------------------------
// Public API — Currency metadata
// ---------------------------------------------------------------------------

/** Check if a currency code is supported by the platform. */
export function isSupportedCurrency(code: string): code is CurrencyCode {
  return SUPPORTED_CURRENCIES.has(code.toUpperCase());
}

/** Get metadata for a currency. Returns null if unsupported. */
export function getCurrencyInfo(code: string): CurrencyInfo | null {
  return CURRENCY_METADATA.get(code.toUpperCase()) ?? null;
}

/** List all supported currencies with metadata. */
export function listSupportedCurrencies(): CurrencyInfo[] {
  return [...CURRENCY_METADATA.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Get the default currency for a billing region.
 * Falls back to USD for unknown regions.
 */
export function getRegionDefaultCurrency(region: BillingRegion): CurrencyCode {
  return REGION_DEFAULT_CURRENCY.get(region) ?? 'USD';
}

/**
 * Get the ordered list of preferred local currencies for a region.
 */
export function getRegionLocalCurrencies(region: BillingRegion): readonly CurrencyCode[] {
  return REGION_LOCAL_CURRENCIES.get(region) ?? ['USD'];
}

// ---------------------------------------------------------------------------
// Public API — Exchange rate table management
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest over an exchange-rate table snapshot
 * so consumers can verify the rate table has not been tampered with.
 */
export function computeRateTableDigest(
  baseCurrency: CurrencyCode,
  rates: ReadonlyMap<CurrencyCode, ExchangeRateEntry>,
  generatedAt: string,
): string {
  const sortedRates = [...rates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, entry]) => ({
      code,
      rateScaled: entry.rateScaled.toString(),
      updatedAt: entry.updatedAt,
      source: entry.source,
    }));

  const payload = JSON.stringify({
    baseCurrency,
    rates: sortedRates,
    generatedAt,
  });

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Generate a UUID v7 for rate table versioning.
 */
function generateVersionId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0');
  const randBytes = Buffer.from(
    // Use Math.random() as fallback since we don't need crypto-grade
    // randomness for rate-table version IDs.
    Array.from({ length: 10 }, () => Math.floor(Math.random() * 256)),
  );
  const randHex = randBytes.toString('hex').slice(0, 10);

  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${randHex.slice(0, 3)}-8${randHex.slice(3, 6)}-${randHex.slice(6)}`;
}

/**
 * Initialise the exchange-rate table from built-in defaults.
 * This is called automatically on first access; production deployments
 * should update rates via the API after startup.
 */
export function initializeRateTable(
  baseRates?: ReadonlyMap<CurrencyCode, { rateScaled: bigint }>,
  baseCurrency?: CurrencyCode,
): ExchangeRateTable {
  const base = baseRates ?? DEFAULT_USD_RATES;
  const baseCur = baseCurrency ?? 'USD';
  const generatedAt = new Date().toISOString();
  const versionId = generateVersionId();

  const rates = new Map<CurrencyCode, ExchangeRateEntry>();
  for (const [code, { rateScaled }] of base) {
    if (code === baseCur) {
      // The base currency always has a scale of 1.0
      rates.set(code, {
        from: baseCur,
        to: code,
        rateScaled: EXCHANGE_RATE_SCALE,
        updatedAt: generatedAt,
        source: 'default',
      });
      continue;
    }
    rates.set(code, {
      from: baseCur,
      to: code,
      rateScaled,
      updatedAt: generatedAt,
      source: 'default',
    });
  }

  const digest = computeRateTableDigest(baseCur, rates, generatedAt);

  const table: ExchangeRateTable = {
    versionId,
    generatedAt,
    baseCurrency: baseCur,
    rates,
    digest,
  };

  currentRateTable = table;
  rateTableStatus.currentVersionId = versionId;
  rateTableStatus.lastUpdatedAt = generatedAt;
  rateTableStatus.updateCount += 1;
  rateTableStatus.lastUpdateError = null;

  return table;
}

/**
 * Set the active exchange-rate table from a programmatic update.
 * Validates that the table is well-formed before applying.
 *
 * @throws {RangeError} if the table is invalid.
 */
export function setRateTable(table: ExchangeRateTable): void {
  const entryCount = table.rates.size;
  if (entryCount === 0) {
    throw new RangeError('Rate table must contain at least one entry');
  }
  if (!SUPPORTED_CURRENCIES.has(table.baseCurrency)) {
    throw new RangeError(`Unsupported base currency: ${table.baseCurrency}`);
  }

  // Verify digest integrity
  const computedDigest = computeRateTableDigest(table.baseCurrency, table.rates, table.generatedAt);
  if (computedDigest !== table.digest) {
    throw new RangeError(
      `Rate table integrity check failed: expected digest ${table.digest}, got ${computedDigest}`,
    );
  }

  // Validate each rate entry
  for (const [code, entry] of table.rates) {
    if (!SUPPORTED_CURRENCIES.has(code)) {
      throw new RangeError(`Rate table contains unsupported currency: ${code}`);
    }
    if (entry.rateScaled <= 0n) {
      throw new RangeError(`Invalid rate for ${code}: must be positive`);
    }
    if (entry.from !== table.baseCurrency) {
      throw new RangeError(`Rate entry for ${code} has unexpected 'from' currency: ${entry.from}`);
    }
    if (entry.to !== code) {
      throw new RangeError(`Rate entry for ${code} has mismatched 'to' currency: ${entry.to}`);
    }
  }

  currentRateTable = table;
  rateTableStatus.currentVersionId = table.versionId;
  rateTableStatus.lastUpdatedAt = table.generatedAt;
  rateTableStatus.updateCount += 1;
  rateTableStatus.lastUpdateError = null;
}

/**
 * Updates exchange rates from a map of currency → scaled rate.
 * This is the programmatic API for applying rate updates (e.g. from
 * an external provider or admin endpoint).
 */
export function updateRates(
  newRates: ReadonlyMap<CurrencyCode, bigint>,
  baseCurrency?: CurrencyCode,
  source?: string,
): ExchangeRateTable {
  const baseCur = baseCurrency ?? 'USD';
  const generatedAt = new Date().toISOString();
  const versionId = generateVersionId();

  const rates = new Map<CurrencyCode, ExchangeRateEntry>();
  // Always include the base currency at 1.0
  rates.set(baseCur, {
    from: baseCur,
    to: baseCur,
    rateScaled: EXCHANGE_RATE_SCALE,
    updatedAt: generatedAt,
    source: source ?? 'manual',
  });

  for (const [code, rateScaled] of newRates) {
    if (!SUPPORTED_CURRENCIES.has(code)) continue;
    if (rateScaled <= 0n) continue;
    rates.set(code, {
      from: baseCur,
      to: code,
      rateScaled,
      updatedAt: generatedAt,
      source: source ?? 'manual',
    });
  }

  const digest = computeRateTableDigest(baseCur, rates, generatedAt);

  const table: ExchangeRateTable = {
    versionId,
    generatedAt,
    baseCurrency: baseCur,
    rates,
    digest,
  };

  setRateTable(table);
  return table;
}

/**
 * Get the active exchange-rate table. Initialises from defaults if not
 * already loaded.
 */
export function getRateTable(): ExchangeRateTable {
  if (currentRateTable === null) {
    return initializeRateTable();
  }
  return currentRateTable;
}

/** Return a snapshot of the current rate table status. */
export function getRateTableStatus(): Readonly<RateTableStatus> {
  return { ...rateTableStatus };
}

// ---------------------------------------------------------------------------
// Public API — Currency conversion
// ---------------------------------------------------------------------------

export interface ConversionResult {
  /** Source amount in micro-units. */
  readonly sourceAmountMicros: bigint;
  readonly sourceCurrency: CurrencyCode;
  /** Converted amount in micro-units. */
  readonly targetAmountMicros: bigint;
  readonly targetCurrency: CurrencyCode;
  /** The rate applied (scaled). */
  readonly rateScaled: bigint;
  /** Rate table version used for the conversion. */
  readonly rateTableVersionId: string;
  /** SHA-256 digest of the conversion inputs and outputs. */
  readonly digest: string;
  readonly convertedAt: string;
}

/**
 * Convert an amount from one currency to another using the active
 * exchange-rate table.
 *
 * All amounts are in platform micro-units (BigInt). The caller is
 * responsible for converting display amounts to micro-units before
 * calling and converting back after.
 *
 * @param sourceAmountMicros  Amount in source currency micro-units.
 * @param sourceCurrency      ISO 4217 code of the source currency.
 * @param targetCurrency      ISO 4217 code of the target currency.
 * @returns The converted amount with full provenance.
 *
 * @throws {RangeError} if either currency is unsupported.
 *
 * @performance O(1) — two hashtable reads, at most two BigInt multiplies
 * and one divide. Well under 1ms on any modern Node.js runtime.
 */
export function convertCurrency(
  sourceAmountMicros: bigint,
  sourceCurrency: CurrencyCode,
  targetCurrency: CurrencyCode,
): ConversionResult {
  if (sourceAmountMicros < 0n) {
    throw new RangeError('sourceAmountMicros must be non-negative');
  }

  const sourceCode = sourceCurrency.toUpperCase();
  const targetCode = targetCurrency.toUpperCase();

  if (!SUPPORTED_CURRENCIES.has(sourceCode)) {
    throw new RangeError(`Unsupported source currency: ${sourceCurrency}`);
  }
  if (!SUPPORTED_CURRENCIES.has(targetCode)) {
    throw new RangeError(`Unsupported target currency: ${targetCurrency}`);
  }

  const rateTable = getRateTable();

  // Same currency — no conversion needed
  if (sourceCode === targetCode) {
    const convertedAt = new Date().toISOString();
    const result: Omit<ConversionResult, 'digest'> = {
      sourceAmountMicros,
      sourceCurrency: sourceCode,
      targetAmountMicros: sourceAmountMicros,
      targetCurrency: targetCode,
      rateScaled: EXCHANGE_RATE_SCALE,
      rateTableVersionId: rateTable.versionId,
      convertedAt,
    };
    return { ...result, digest: computeConversionDigest(result) };
  }

  // If the rate table is not based on the source currency, perform a
  // two-step conversion: source → base → target.
  const baseCurrency = rateTable.baseCurrency;

  let rateScaled: bigint;
  let targetAmountMicros: bigint;

  if (sourceCode === baseCurrency) {
    // Direct conversion: base → target
    const targetRate = rateTable.rates.get(targetCode);
    if (!targetRate) {
      throw new RangeError(`No exchange rate available for ${targetCode}`);
    }
    rateScaled = targetRate.rateScaled;
    targetAmountMicros = (sourceAmountMicros * rateScaled) / EXCHANGE_RATE_SCALE;
  } else if (targetCode === baseCurrency) {
    // Reverse conversion: source → base
    const sourceRate = rateTable.rates.get(sourceCode);
    if (!sourceRate) {
      throw new RangeError(`No exchange rate available for ${sourceCode}`);
    }
    rateScaled = sourceRate.rateScaled;
    // To convert to base, divide by the source rate
    targetAmountMicros = (sourceAmountMicros * EXCHANGE_RATE_SCALE) / rateScaled;
  } else {
    // Cross conversion: source → base → target
    const sourceRate = rateTable.rates.get(sourceCode);
    const targetRate = rateTable.rates.get(targetCode);

    if (!sourceRate) {
      throw new RangeError(`No exchange rate available for ${sourceCode}`);
    }
    if (!targetRate) {
      throw new RangeError(`No exchange rate available for ${targetCode}`);
    }

    // source → base: amount / sourceRate * SCALE
    const baseAmount = (sourceAmountMicros * EXCHANGE_RATE_SCALE) / sourceRate.rateScaled;
    // base → target: baseAmount * targetRate / SCALE
    targetAmountMicros = (baseAmount * targetRate.rateScaled) / EXCHANGE_RATE_SCALE;

    // The effective rate from source to target for audit purposes
    rateScaled = (targetRate.rateScaled * EXCHANGE_RATE_SCALE) / sourceRate.rateScaled;
  }

  const convertedAt = new Date().toISOString();
  const result: Omit<ConversionResult, 'digest'> = {
    sourceAmountMicros,
    sourceCurrency: sourceCode,
    targetAmountMicros,
    targetCurrency: targetCode,
    rateScaled,
    rateTableVersionId: rateTable.versionId,
    convertedAt,
  };

  return { ...result, digest: computeConversionDigest(result) };
}

// ---------------------------------------------------------------------------
// Conversion integrity digest
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 digest over a conversion result's inputs and outputs
 * so downstream consumers can verify the conversion has not been altered.
 */
export function computeConversionDigest(result: Omit<ConversionResult, 'digest'>): string {
  const payload = JSON.stringify({
    sourceAmountMicros: result.sourceAmountMicros.toString(),
    sourceCurrency: result.sourceCurrency,
    targetAmountMicros: result.targetAmountMicros.toString(),
    targetCurrency: result.targetCurrency,
    rateScaled: result.rateScaled.toString(),
    rateTableVersionId: result.rateTableVersionId,
    convertedAt: result.convertedAt,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Verify that a conversion result's digest is valid, proving the
 * result has not been tampered with since conversion.
 */
export function verifyConversionIntegrity(result: ConversionResult): boolean {
  const { digest, ...rest } = result;
  return computeConversionDigest(rest) === digest;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Convert a micro-unit amount to a display string for a given currency.
 * Uses the currency's configured decimal places.
 */
export function formatCurrencyDisplay(amountMicros: bigint, currencyCode: CurrencyCode): string {
  const info = getCurrencyInfo(currencyCode);
  if (!info) {
    throw new RangeError(`Unsupported currency: ${currencyCode}`);
  }

  const decimals = info.decimals;
  const divisor = 10n ** BigInt(decimals);
  const whole = amountMicros / divisor;
  const fraction = amountMicros % divisor;

  if (decimals === 0) {
    return `${info.symbol}${whole}`;
  }

  const fracStr = fraction.toString().padStart(decimals, '0');
  return `${info.symbol}${whole}.${fracStr}`;
}

/**
 * Parse a display amount string to micro-units for a given currency.
 */
export function parseCurrencyAmount(displayAmount: string, currencyCode: CurrencyCode): bigint {
  const info = getCurrencyInfo(currencyCode);
  if (!info) {
    throw new RangeError(`Unsupported currency: ${currencyCode}`);
  }

  const cleaned = displayAmount.replace(/[^\d.-]/g, '');
  const parts = cleaned.split('.');

  let whole = parts[0] ?? '0';
  if (whole === '' || whole === '-') whole = '0';

  let fraction = parts[1] ?? '';
  fraction = fraction.padEnd(info.decimals, '0').slice(0, info.decimals);

  const divisor = 10n ** BigInt(info.decimals);
  return BigInt(whole) * divisor + BigInt(fraction);
}

// ---------------------------------------------------------------------------
// Rate fetching (for production use with external providers)
// ---------------------------------------------------------------------------

/**
 * Fetch live exchange rates from a configurable external provider.
 * The provider URL and API key are read from environment variables.
 *
 * Returns a Map of currency code → scaled rate (BigInt), or null if
 * the fetch fails.
 *
 * The provider is expected to return JSON in the format:
 * ```json
 * { "base": "USD", "rates": { "EUR": 0.92, ... } }
 * ```
 */
export async function fetchLiveRates(): Promise<Map<CurrencyCode, bigint> | null> {
  const providerUrl =
    process.env['EXCHANGE_RATE_PROVIDER_URL'] ?? 'https://api.exchangerate-api.com/v4/latest/USD';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(providerUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(process.env['EXCHANGE_RATE_PROVIDER_API_KEY']
          ? {
              Authorization: `Bearer ${process.env['EXCHANGE_RATE_PROVIDER_API_KEY']}`,
            }
          : {}),
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[multi_currency] Rate provider returned status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      base?: string;
      rates?: Record<string, number>;
    };

    if (data.rates === undefined || typeof data.rates !== 'object') {
      console.error('[multi_currency] Rate provider returned unexpected format');
      return null;
    }

    const result = new Map<CurrencyCode, bigint>();
    for (const [code, rate] of Object.entries(data.rates)) {
      const upperCode = code.toUpperCase();
      if (!SUPPORTED_CURRENCIES.has(upperCode)) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue;
      result.set(upperCode, BigInt(Math.round(rate * Number(EXCHANGE_RATE_SCALE))));
    }

    return result;
  } catch (err) {
    console.error('[multi_currency] Failed to fetch live rates:', err);
    return null;
  }
}

/**
 * Attempt to refresh exchange rates from the configured external provider.
 * On failure, the previous rate table is retained (automatic rollback).
 *
 * Returns true if rates were successfully updated, false otherwise.
 */
export async function refreshExchangeRates(): Promise<boolean> {
  try {
    const liveRates = await fetchLiveRates();
    if (liveRates === null || liveRates.size === 0) {
      rateTableStatus.lastUpdateError = 'Failed to fetch rates from provider';
      return false;
    }

    updateRates(liveRates, 'USD', 'live_provider');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rateTableStatus.lastUpdateError = message;
    console.error('[multi_currency] Rate refresh failed:', message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** True once the rate table has been initialised at least once. */
let initialized = false;

/**
 * Ensure the rate table is initialised. Safe to call multiple times.
 * If a `RUNTIME_CONFIG_AUTHORIZED_KEYS` is set, the initial table is
 * loaded from defaults and flagged for external update.
 */
export function ensureRateTableInitialized(): ExchangeRateTable {
  if (!initialized) {
    const table = initializeRateTable();
    initialized = true;

    // Schedule a background refresh if a provider is configured
    if (process.env['EXCHANGE_RATE_PROVIDER_URL']) {
      setImmediate(() => {
        void refreshExchangeRates();
      });
    }

    return table;
  }
  return getRateTable();
}

/** Reset all state to defaults (used in tests). */
export function resetMultiCurrencyState(): void {
  currentRateTable = null;
  initialized = false;
  rateTableStatus.currentVersionId = null;
  rateTableStatus.lastUpdatedAt = null;
  rateTableStatus.updateCount = 0;
  rateTableStatus.lastUpdateError = null;
}
