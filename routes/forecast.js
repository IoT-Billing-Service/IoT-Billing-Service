const express = require('express');
const revenueForecastService = require('../services/revenueForecastService');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { body, query } = require('express-validator');
const logger = require('../lib/logger');

const router = express.Router();

/**
 * GET /api/v1/forecast/revenue
 * Query cached revenue forecasts.
 */
router.get(
  '/revenue',
  authenticate,
  validate([
    query('horizon').optional().isIn(['7', '30', '90']).withMessage('horizon must be 7, 30, or 90'),
    query('granularity').optional().isIn(['daily', 'weekly', 'monthly']).withMessage('granularity must be daily, weekly, or monthly'),
  ]),
  async (req, res, next) => {
    try {
      const horizon = parseInt(req.query.horizon || '30', 10);
      const granularity = req.query.granularity || 'daily';

      const forecast = await revenueForecastService.getForecast(horizon, granularity);

      if (forecast.length === 0) {
        return res.status(404).json({
          ok: false,
          error: 'No forecast available. Run generation first.',
        });
      }

      const totalPredicted = forecast.reduce((sum, f) => sum + parseFloat(f.predicted_revenue), 0);
      const totalLower = forecast.reduce((sum, f) => sum + parseFloat(f.lower_bound), 0);
      const totalUpper = forecast.reduce((sum, f) => sum + parseFloat(f.upper_bound), 0);

      res.json({
        ok: true,
        horizon,
        granularity,
        forecast: forecast.map((f) => ({
          date: f.forecast_date,
          predicted: parseFloat(f.predicted_revenue),
          confidenceInterval: {
            lower: parseFloat(f.lower_bound),
            upper: parseFloat(f.upper_bound),
          },
        })),
        summary: {
          totalPredicted: totalPredicted.toFixed(4),
          totalLower: totalLower.toFixed(4),
          totalUpper: totalUpper.toFixed(4),
        },
        generatedAt: forecast[0]?.generated_at,
        modelVersion: forecast[0]?.model_version,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/forecast/accuracy
 * Compute forecast accuracy metrics over historical data.
 */
router.get(
  '/accuracy',
  authenticate,
  validate([
    query('horizon').optional().isIn(['7', '30', '90']),
    query('daysBack').optional().isInt({ min: 7, max: 365 }),
  ]),
  async (req, res, next) => {
    try {
      const horizon = parseInt(req.query.horizon || '7', 10);
      const daysBack = parseInt(req.query.daysBack || '30', 10);

      const accuracy = await revenueForecastService.computeAccuracy(horizon, daysBack);

      res.json({
        ok: true,
        horizon,
        daysBack,
        accuracy: {
          mape: accuracy.mape != null ? accuracy.mape.toFixed(4) : null,
          rmse: accuracy.rmse != null ? accuracy.rmse.toFixed(4) : null,
          bias: accuracy.bias != null ? accuracy.bias.toFixed(4) : null,
          sampleCount: accuracy.sampleCount,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/forecast/refresh
 * Admin-only: trigger manual forecast recomputation.
 */
router.post(
  '/refresh',
  authenticate,
  authorize('forecast:admin'),
  validate([
    body('horizon').optional().isIn([7, 30, 90]),
    body('granularity').optional().isIn(['daily', 'weekly', 'monthly']),
  ]),
  async (req, res, next) => {
    try {
      const horizon = req.body.horizon || 30;
      const granularity = req.body.granularity || 'daily';

      logger.info('Manual forecast refresh triggered', { actor: req.user.id, horizon, granularity });

      const forecast = await revenueForecastService.generateForecast(horizon, granularity);

      res.json({
        ok: true,
        message: 'Forecast regenerated successfully',
        horizon,
        granularity,
        rowsGenerated: forecast.length,
        generatedAt: forecast[0]?.generated_at,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;