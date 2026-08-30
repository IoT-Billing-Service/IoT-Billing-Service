/**
 * Kafka Connect Sink for blockchain event streaming (issue #291).
 *
 * Public surface for the connector module. Import from
 * `../stream/kafka_connect/index.js` to avoid reaching into individual files.
 */

export * from './types.js';
export * from './record_codec.js';
export * from './connector.js';
export * from './sink_task.js';
