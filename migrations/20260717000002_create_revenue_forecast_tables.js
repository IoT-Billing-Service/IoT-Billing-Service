/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Revenue snapshots (aggregated historical data)
  await knex.schema.createTable('revenue_snapshots', (table) => {
    table.bigIncrements('id').primary();
    table.date('snapshot_date').notNullable();
    table.string('granularity', 10).notNullable(); // daily, weekly, monthly
    table.decimal('total_revenue', 18, 4).notNullable().defaultTo(0);
    table.integer('transaction_count').notNullable().defaultTo(0);
    table.integer('device_count').notNullable().defaultTo(0);
    table.decimal('avg_ticket_size', 18, 4).notNullable().defaultTo(0);
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.binary('signature').notNullable();

    table.unique(['snapshot_date', 'granularity']);
    table.index(['snapshot_date', 'granularity'], 'idx_revenue_snapshots_lookup');
    table.index(['created_at'], 'idx_revenue_snapshots_created');
  });

  // Revenue forecasts (prediction output)
  await knex.schema.createTable('revenue_forecasts', (table) => {
    table.bigIncrements('id').primary();
    table.date('forecast_date').notNullable();
    table.integer('horizon_days').notNullable(); // 7, 30, 90
    table.decimal('predicted_revenue', 18, 4).notNullable();
    table.decimal('lower_bound', 18, 4).notNullable();
    table.decimal('upper_bound', 18, 4).notNullable();
    table.string('model_version', 32).notNullable().defaultTo('holt-winters-v1');
    table.timestamp('generated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.binary('signature').notNullable();

    table.unique(['forecast_date', 'horizon_days']);
    table.index(['forecast_date', 'horizon_days'], 'idx_revenue_forecasts_lookup');
    table.index(['generated_at'], 'idx_revenue_forecasts_generated');
  });

  // Audit log for forecast access (SOC2)
  await knex.schema.createTable('revenue_forecast_audits', (table) => {
    table.bigIncrements('id').primary();
    table.string('action', 32).notNullable(); // generate, query, refresh
    table.string('actor', 128).notNullable(); // service account or user id
    table.jsonb('payload').defaultTo('{}');
    table.string('ip_address', 45);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['created_at'], 'idx_forecast_audits_created');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('revenue_forecast_audits');
  await knex.schema.dropTableIfExists('revenue_forecasts');
  await knex.schema.dropTableIfExists('revenue_snapshots');
};