const revenueForecastService = require('../services/revenueForecastService');
const logger = require('../lib/logger');

/**
 * Scheduled forecast generation job.
 * Runs every 6 hours via node-cron or Kubernetes CronJob.
 */
async function runForecastGeneration() {
  const horizons = [7, 30, 90];
  const granularities = ['daily'];

  for (const granularity of granularities) {
    for (const horizon of horizons) {
      try {
        await revenueForecastService.generateForecast(horizon, granularity);
        logger.info('Scheduled forecast generated', { horizon, granularity });
      } catch (err) {
        logger.error('Scheduled forecast generation failed', { horizon, granularity, error: err.message });
      }
    }
  }
}

// If running directly (e.g., node jobs/forecastGenerationJob.js)
if (require.main === module) {
  runForecastGeneration()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Forecast generation job fatal error', { error: err.message });
      process.exit(1);
    });
}

module.exports = { runForecastGeneration };