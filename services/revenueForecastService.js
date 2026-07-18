const crypto = require('crypto');
const knex = require('../db/knex');
const redis = require('../lib/redis');
const logger = require('../lib/logger');

const SIGNING_KEY = process.env.REVENUE_SIGNING_KEY;
if (!SIGNING_KEY) {
  throw new Error('REVENUE_SIGNING_KEY is required for cryptographic verification');
}

const MODEL_VERSION = 'holt-winters-v1';
const SEASONAL_PERIOD = 7; // Weekly seasonality
const CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * Canonical JSON stringifier for deterministic signing.
 */
function canonicalStringify(obj) {
  const sorted = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

/**
 * Sign a revenue record with HMAC-SHA256.
 */
function signRecord(record) {
  const payload = { ...record };
  delete payload.signature;
  delete payload.id;
  const canonical = canonicalStringify(payload);
  return crypto.createHmac('sha256', SIGNING_KEY).update(canonical).digest();
}

/**
 * Verify a revenue record signature.
 */
function verifyRecord(record) {
  const expected = signRecord(record);
  return crypto.timingSafeEqual(expected, record.signature);
}

/**
 * Holt-Winters Triple Exponential Smoothing (additive).
 * @param {number[]} series - Historical revenue values
 * @param {number} horizon - Number of periods to forecast
 * @returns {{forecast: number[], level: number, trend: number, seasonal: number[]}}
 */
function holtWinters(series, horizon) {
  const n = series.length;
  if (n < SEASONAL_PERIOD * 2) {
    // Not enough data — fall back to simple linear regression
    return linearRegressionForecast(series, horizon);
  }

  const alpha = 0.3;
  const beta = 0.1;
  const gamma = 0.1;

  // Initialize seasonal components
  const seasonal = new Array(SEASONAL_PERIOD).fill(0);
  for (let i = 0; i < SEASONAL_PERIOD; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i; j < n; j += SEASONAL_PERIOD) {
      sum += series[j];
      count++;
    }
    seasonal[i] = count > 0 ? sum / count : 0;
  }

  const seasonalMean = seasonal.reduce((a, b) => a + b, 0) / SEASONAL_PERIOD;
  for (let i = 0; i < SEASONAL_PERIOD; i++) {
    seasonal[i] -= seasonalMean;
  }

  let level = series.slice(0, SEASONAL_PERIOD).reduce((a, b) => a + b, 0) / SEASONAL_PERIOD;
  let trend = 0;
  for (let i = SEASONAL_PERIOD; i < Math.min(n, SEASONAL_PERIOD * 2); i++) {
    trend += (series[i] - series[i - SEASONAL_PERIOD]) / SEASONAL_PERIOD;
  }
  trend /= Math.min(SEASONAL_PERIOD, n - SEASONAL_PERIOD);

  // Smoothing
  for (let i = 0; i < n; i++) {
    const s = seasonal[i % SEASONAL_PERIOD];
    const prevLevel = level;
    level = alpha * (series[i] - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[i % SEASONAL_PERIOD] = gamma * (series[i] - level) + (1 - gamma) * s;
  }

  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const f = level + h * trend + seasonal[(n + h - 1) % SEASONAL_PERIOD];
    forecast.push(Math.max(0, f)); // Revenue cannot be negative
  }

  return { forecast, level, trend, seasonal };
}

/**
 * Simple linear regression fallback.
 */
function linearRegressionForecast(series, horizon) {
  const n = series.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += series[i];
    sumXY += i * series[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Math.max(0, intercept + slope * (n + h - 1)));
  }
  return { forecast, level: intercept, trend: slope, seasonal: [] };
}

/**
 * Compute confidence intervals using standard deviation of residuals.
 */
function computeConfidenceIntervals(series, forecast, level, trend, seasonal) {
  const n = series.length;
  const fitted = [];
  for (let i = 0; i < n; i++) {
    const s = seasonal[i % SEASONAL_PERIOD] || 0;
    fitted.push(level + trend * i + s);
  }

  const residuals = series.map((v, i) => v - fitted[i]);
  const meanResidual = residuals.reduce((a, b) => a + b, 0) / n;
  const variance = residuals.reduce((a, b) => a + (b - meanResidual) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // 95% confidence = 1.96 * stdDev, scaled by horizon distance
  const lower = forecast.map((f, i) => Math.max(0, f - 1.96 * stdDev * Math.sqrt(1 + (i + 1) / n)));
  const upper = forecast.map((f, i) => f + 1.96 * stdDev * Math.sqrt(1 + (i + 1) / n));

  return { lower, upper };
}

class RevenueForecastService {
  /**
   * Aggregate raw billing transactions into revenue snapshots.
   * This is called by the hourly materialized-view refresh job.
   */
  async aggregateRevenue(date, granularity = 'daily') {
    const startOf = granularity === 'daily'
      ? date
      : granularity === 'weekly'
        ? knex.raw('date_trunc(\'week\', ?::date)', [date])
        : knex.raw('date_trunc(\'month\', ?::date)', [date]);

    const result = await knex('billing_transactions')
      .whereRaw('DATE(created_at) = ?', [date])
      .select(
        knex.raw('SUM(amount) as total_revenue'),
        knex.raw('COUNT(*) as transaction_count'),
        knex.raw('COUNT(DISTINCT device_id) as device_count')
      )
      .first();

    const totalRevenue = parseFloat(result.total_revenue || 0);
    const txCount = parseInt(result.transaction_count || 0, 10);
    const deviceCount = parseInt(result.device_count || 0, 10);

    const record = {
      snapshot_date: date,
      granularity,
      total_revenue: totalRevenue.toFixed(4),
      transaction_count: txCount,
      device_count: deviceCount,
      avg_ticket_size: txCount > 0 ? (totalRevenue / txCount).toFixed(4) : '0.0000',
      metadata: JSON.stringify({ source: 'billing_transactions' }),
      created_at: new Date().toISOString(),
    };

    record.signature = signRecord(record);

    await knex('revenue_snapshots')
      .insert(record)
      .onConflict(['snapshot_date', 'granularity'])
      .merge();

    return record;
  }

  /**
   * Generate forecasts for a given horizon.
   * @param {number} horizonDays - 7, 30, or 90
   * @param {string} granularity - 'daily' | 'weekly' | 'monthly'
   */
  async generateForecast(horizonDays = 30, granularity = 'daily') {
    const startTime = Date.now();

    // Fetch historical snapshots
    const historyDays = Math.max(90, SEASONAL_PERIOD * 3);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - historyDays);

    const snapshots = await knex('revenue_snapshots')
      .where('granularity', granularity)
      .where('snapshot_date', '>=', startDate.toISOString().split('T')[0])
      .orderBy('snapshot_date', 'asc')
      .select('snapshot_date', 'total_revenue', 'signature');

    // Verify signatures before using data
    for (const snap of snapshots) {
      if (!verifyRecord(snap)) {
        logger.error('Revenue snapshot signature verification failed', { date: snap.snapshot_date });
        throw new Error(`Data integrity violation: snapshot ${snap.snapshot_date} has invalid signature`);
      }
    }

    const series = snapshots.map((s) => parseFloat(s.total_revenue));
    if (series.length < 2) {
      throw new Error('Insufficient historical data for forecasting');
    }

    const { forecast, level, trend, seasonal } = holtWinters(series, horizonDays);
    const { lower, upper } = computeConfidenceIntervals(series, forecast, level, trend, seasonal);

    const baseDate = new Date();
    const records = [];

    for (let i = 0; i < horizonDays; i++) {
      const forecastDate = new Date(baseDate);
      forecastDate.setDate(forecastDate.getDate() + i + 1);

      const record = {
        forecast_date: forecastDate.toISOString().split('T')[0],
        horizon_days: horizonDays,
        predicted_revenue: forecast[i].toFixed(4),
        lower_bound: lower[i].toFixed(4),
        upper_bound: upper[i].toFixed(4),
        model_version: MODEL_VERSION,
        generated_at: new Date().toISOString(),
      };
      record.signature = signRecord(record);
      records.push(record);
    }

    // Bulk insert with conflict resolution
    await knex('revenue_forecasts')
      .insert(records)
      .onConflict(['forecast_date', 'horizon_days'])
      .merge();

    // Audit log
    await knex('revenue_forecast_audits').insert({
      action: 'generate',
      actor: 'forecast-service',
      payload: JSON.stringify({ horizonDays, granularity, modelVersion: MODEL_VERSION, inputRows: series.length }),
    });

    // Cache the result
    const cacheKey = `forecast:${granularity}:${horizonDays}`;
    await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(records));

    const duration = Date.now() - startTime;
    logger.info('Forecast generated', { horizonDays, granularity, durationMs: duration, rows: records.length });

    return records;
  }

  /**
   * Query cached or DB forecasts.
   */
  async getForecast(horizonDays = 30, granularity = 'daily') {
    const cacheKey = `forecast:${granularity}:${horizonDays}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const records = await knex('revenue_forecasts')
      .where('horizon_days', horizonDays)
      .where('forecast_date', '>=', new Date().toISOString().split('T')[0])
      .orderBy('forecast_date', 'asc')
      .select('*');

    // Verify signatures
    for (const rec of records) {
      if (!verifyRecord(rec)) {
        logger.error('Forecast signature verification failed', { date: rec.forecast_date });
        throw new Error(`Data integrity violation: forecast ${rec.forecast_date} has invalid signature`);
      }
    }

    if (records.length > 0) {
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(records));
    }

    return records;
  }

  /**
   * Compute forecast accuracy (MAPE, RMSE, bias) over a lookback window.
   */
  async computeAccuracy(horizonDays = 7, daysBack = 30) {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - horizonDays);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - daysBack);

    const forecasts = await knex('revenue_forecasts')
      .where('horizon_days', horizonDays)
      .whereBetween('forecast_date', [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]])
      .select('forecast_date', 'predicted_revenue');

    const actuals = await knex('revenue_snapshots')
      .where('granularity', 'daily')
      .whereBetween('snapshot_date', [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]])
      .select('snapshot_date', 'total_revenue');

    const actualMap = new Map(actuals.map((a) => [a.snapshot_date, parseFloat(a.total_revenue)]));

    let mapeSum = 0;
    let rmseSum = 0;
    let biasSum = 0;
    let count = 0;

    for (const f of forecasts) {
      const actual = actualMap.get(f.forecast_date);
      if (actual == null) continue;

      const predicted = parseFloat(f.predicted_revenue);
      const error = actual - predicted;

      mapeSum += Math.abs(error) / (actual || 1); // Avoid div by zero
      rmseSum += error * error;
      biasSum += error;
      count++;
    }

    if (count === 0) {
      return { mape: null, rmse: null, bias: null, sampleCount: 0 };
    }

    return {
      mape: (mapeSum / count) * 100,
      rmse: Math.sqrt(rmseSum / count),
      bias: biasSum / count,
      sampleCount: count,
    };
  }
}

module.exports = new RevenueForecastService();