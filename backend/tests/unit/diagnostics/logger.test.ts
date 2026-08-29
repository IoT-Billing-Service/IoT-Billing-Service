/**
 * Tests for the structured logger with OpenTelemetry semantic conventions
 * (issue #276).
 *
 * Covers:
 * - Every record is valid JSON with the OTel-Logs-Data-Model fields
 *   (timestamp, severity_text, severity_number, event, service.name)
 * - LOG_LEVEL filters out records below the configured minimum severity
 * - error()/fatal() expand an Error into exception.type/exception.message
 *   and other semantic-convention attributes
 * - child() merges bound fields into every record without mutating the parent
 * - trace_id/span_id are attached when called inside an active OTel span,
 *   and omitted otherwise
 * - severity routes to the right console method (info/debug/trace -> log,
 *   warn -> warn, error/fatal -> error)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { clearEnvCache } from '../../../src/config/env.js';
import { getLogger, createLogger, resetLoggerForTests } from '../../../src/core/diagnostics/logger.js';

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  TIMESCALEDB_URL: 'postgresql://user:pass@localhost:5433/testdb',
  REDIS_URL: 'redis://localhost:6379',
  SOROBAN_RPC_URL: 'https://soroban-rpc.example.com',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  JWT_SECRET: 'super-secret-jwt-key-at-least-32-chars!!',
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  Object.assign(process.env, REQUIRED_ENV, overrides);
}

function lastLoggedRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('console method was never called');
  return JSON.parse(call[0] as string);
}

describe('structured logger (issue #276)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setEnv({ OTEL_SERVICE_NAME: 'test-service', LOG_LEVEL: 'trace' });
    clearEnvCache();
    resetLoggerForTests();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    clearEnvCache();
    resetLoggerForTests();
  });

  it('emits a JSON record with the OTel Logs Data Model fields', () => {
    getLogger().info('device_registered', { deviceId: 'dev-1' });

    const record = lastLoggedRecord(logSpy);
    expect(record).toMatchObject({
      severity_text: 'info',
      severity_number: 9,
      event: 'device_registered',
      'service.name': 'test-service',
      deviceId: 'dev-1',
    });
    expect(typeof record.timestamp).toBe('string');
    expect(new Date(record.timestamp as string).toString()).not.toBe('Invalid Date');
  });

  it('routes info/debug/trace to console.log', () => {
    getLogger().info('a');
    getLogger().debug('b');
    getLogger().trace('c');
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('routes warn to console.warn', () => {
    getLogger().warn('rate_limit_approaching', { remaining: 5 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = lastLoggedRecord(warnSpy);
    expect(record.severity_text).toBe('warn');
  });

  it('routes error and fatal to console.error', () => {
    getLogger().error('payment_failed');
    getLogger().fatal('db_unreachable');
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('suppresses records below the configured LOG_LEVEL', () => {
    setEnv({ LOG_LEVEL: 'warn' });
    clearEnvCache();
    resetLoggerForTests();

    getLogger().info('should_be_suppressed');
    getLogger().debug('should_be_suppressed');
    getLogger().warn('should_appear');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('expands an Error into exception.*/error.type attributes on error()', () => {
    const err = new Error('connection refused');
    err.name = 'ConnectionError';

    getLogger().error('webhook_delivery_failed', err, { webhookId: 'wh-1' });

    const record = lastLoggedRecord(errorSpy);
    expect(record['exception.type']).toBe('ConnectionError');
    expect(record['exception.message']).toBe('connection refused');
    expect(typeof record['exception.stacktrace']).toBe('string');
    expect(record['error.type']).toBe('ConnectionError');
    expect(record.webhookId).toBe('wh-1');
  });

  it('handles a non-Error value passed to error()', () => {
    getLogger().error('unexpected_throw', 'a raw string was thrown');
    const record = lastLoggedRecord(errorSpy);
    expect(record['exception.message']).toBe('a raw string was thrown');
    expect(record['error.type']).toBe('UnknownError');
  });

  it('omits exception fields entirely when error() is called with no error', () => {
    getLogger().error('generic_failure', undefined, { reason: 'timeout' });
    const record = lastLoggedRecord(errorSpy);
    expect(record['exception.type']).toBeUndefined();
    expect(record.reason).toBe('timeout');
  });

  it('child() merges bound fields into every record without mutating the parent', () => {
    const child = createLogger({ component: 'webhook_service' });
    child.info('dispatched');

    const record = lastLoggedRecord(logSpy);
    expect(record.component).toBe('webhook_service');

    getLogger().info('root_call');
    const rootRecord = lastLoggedRecord(logSpy);
    expect(rootRecord.component).toBeUndefined();
  });

  it('a call-site attribute overrides a bound field of the same name', () => {
    const child = createLogger({ deviceId: 'default-device' });
    child.info('reading_ingested', { deviceId: 'dev-42' });

    const record = lastLoggedRecord(logSpy);
    expect(record.deviceId).toBe('dev-42');
  });

  describe('trace correlation', () => {
    it('omits trace_id/span_id when there is no active span', () => {
      getLogger().info('no_span_here');
      const record = lastLoggedRecord(logSpy);
      expect(record.trace_id).toBeUndefined();
      expect(record.span_id).toBeUndefined();
    });

    it('attaches trace_id/span_id from the active span', () => {
      const contextManager = new AsyncHooksContextManager().enable();
      context.setGlobalContextManager(contextManager);
      const provider = new BasicTracerProvider();
      trace.setGlobalTracerProvider(provider);
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const spanContext = span.spanContext();

      context.with(trace.setSpan(context.active(), span), () => {
        getLogger().info('inside_a_span');
      });
      span.end();

      const record = lastLoggedRecord(logSpy);
      expect(record.trace_id).toBe(spanContext.traceId);
      expect(record.span_id).toBe(spanContext.spanId);
      expect(typeof record.trace_flags).toBe('string');

      trace.disable();
      context.disable();
    });
  });
});
