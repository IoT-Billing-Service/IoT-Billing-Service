import { trace } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';
import { getEnv } from '../../config/env.js';

/**
 * Structured logging with OpenTelemetry semantic conventions (issue #276).
 *
 * Before this, the codebase had no shared logger: ~76 call sites across
 * src/** used raw `console.log`/`console.error` with ad-hoc string
 * interpolation, and a handful of modules (config/runtime_audit.ts,
 * config/index.ts, api/routes/telemetry_websocket.ts) had already
 * independently converged on hand-rolled `console.info(JSON.stringify({
 * event: ..., ... }))` calls. This module formalizes that existing
 * `{ event, ...fields }` convention into one shared logger rather than
 * inventing an unrelated shape, and adds the two things ad-hoc
 * JSON.stringify calls can't give you:
 *
 *  1. Automatic trace/span correlation — every log record emitted while a
 *     span is active carries that span's `trace_id`/`span_id`, so logs
 *     and traces for the same request can be joined in any backend that
 *     understands OTel (or just by grepping a trace ID across both).
 *  2. OTel Logs Data Model field names (`severity_text`, `severity_number`)
 *     and semantic-convention attribute keys for errors
 *     (`exception.type`/`exception.message`/`exception.stacktrace`,
 *     `error.type`) rather than ad-hoc field names that vary by module.
 *
 * This does NOT adopt the full OpenTelemetry Logs SDK/Bridge API
 * (`@opentelemetry/sdk-logs`, `@opentelemetry/api-logs`) — that API is
 * newer/less stable than the tracing API this repo already depends on,
 * and pulling it in is a separate, larger decision (a log *exporter*
 * pipeline, not just a data shape) than what this issue asks for. JSON
 * lines to stdout/stderr, shaped per the Logs Data Model and readable by
 * any log collector that can parse JSON (which is most of them), gets the
 * practical benefit — trace-correlated, semantically-named structured
 * logs — without that larger commitment.
 */

export type LogSeverity = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * OTel Logs Data Model severity numbers:
 * https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 * Each name maps to the first (least-specific) number in its band.
 */
const SEVERITY_NUMBER: Record<LogSeverity, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

export interface LogAttributes {
  [key: string]: unknown;
}

export interface LogRecordShape {
  timestamp: string;
  severity_text: LogSeverity;
  severity_number: number;
  event: string;
  'service.name': string;
  trace_id?: string;
  span_id?: string;
  trace_flags?: string;
  [key: string]: unknown;
}

export interface Logger {
  trace(event: string, attributes?: LogAttributes): void;
  debug(event: string, attributes?: LogAttributes): void;
  info(event: string, attributes?: LogAttributes): void;
  warn(event: string, attributes?: LogAttributes): void;
  /**
   * `error` accepts an optional `Error` in addition to attributes; when
   * given, it's expanded into `exception.type` / `exception.message` /
   * `exception.stacktrace` / `error.type` per semantic conventions rather
   * than requiring every call site to do that expansion by hand.
   */
  error(event: string, error?: unknown, attributes?: LogAttributes): void;
  fatal(event: string, error?: unknown, attributes?: LogAttributes): void;
  /** Returns a new logger that merges `bindings` into every record it emits, without mutating this one. */
  child(bindings: LogAttributes): Logger;
}

const SEVERITY_ORDER: LogSeverity[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function meetsMinSeverity(severity: LogSeverity, minSeverity: LogSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minSeverity);
}

function currentTraceContext(): Pick<LogRecordShape, 'trace_id' | 'span_id' | 'trace_flags'> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags.toString(16).padStart(2, '0'),
  };
}

/** Expands an unknown error value into semantic-convention exception/error attributes. */
function errorAttributes(error: unknown): LogAttributes {
  if (error === undefined) return {};
  if (error instanceof Error) {
    return {
      [ATTR_EXCEPTION_TYPE]: error.name,
      [ATTR_EXCEPTION_MESSAGE]: error.message,
      [ATTR_EXCEPTION_STACKTRACE]: error.stack,
      [ATTR_ERROR_TYPE]: error.name,
    };
  }
  return {
    [ATTR_EXCEPTION_MESSAGE]: String(error),
    [ATTR_ERROR_TYPE]: 'UnknownError',
  };
}

function writeLine(severity: LogSeverity, record: LogRecordShape): void {
  const line = JSON.stringify(record);
  if (severity === 'error' || severity === 'fatal') {
    console.error(line);
  } else if (severity === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

class StructuredLogger implements Logger {
  constructor(
    private readonly serviceName: string,
    private readonly getMinSeverity: () => LogSeverity,
    private readonly bindings: LogAttributes = {},
  ) {}

  private emit(severity: LogSeverity, event: string, attributes?: LogAttributes): void {
    if (!meetsMinSeverity(severity, this.getMinSeverity())) return;

    const record: LogRecordShape = {
      timestamp: new Date().toISOString(),
      severity_text: severity,
      severity_number: SEVERITY_NUMBER[severity],
      event,
      'service.name': this.serviceName,
      ...currentTraceContext(),
      ...this.bindings,
      ...attributes,
    };
    writeLine(severity, record);
  }

  trace(event: string, attributes?: LogAttributes): void {
    this.emit('trace', event, attributes);
  }

  debug(event: string, attributes?: LogAttributes): void {
    this.emit('debug', event, attributes);
  }

  info(event: string, attributes?: LogAttributes): void {
    this.emit('info', event, attributes);
  }

  warn(event: string, attributes?: LogAttributes): void {
    this.emit('warn', event, attributes);
  }

  error(event: string, error?: unknown, attributes?: LogAttributes): void {
    this.emit('error', event, { ...errorAttributes(error), ...attributes });
  }

  fatal(event: string, error?: unknown, attributes?: LogAttributes): void {
    this.emit('fatal', event, { ...errorAttributes(error), ...attributes });
  }

  child(bindings: LogAttributes): Logger {
    return new StructuredLogger(this.serviceName, this.getMinSeverity, {
      ...this.bindings,
      ...bindings,
    });
  }
}

let rootLogger: Logger | null = null;

const DEFAULT_SERVICE_NAME = 'iot-billing-backend';
const DEFAULT_LOG_LEVEL: LogSeverity = 'info';

/**
 * Reads service name / log level from the validated environment when
 * available, falling back to safe defaults otherwise. `getEnv()` throws if
 * *any* required environment variable is missing — appropriate for the
 * app's actual startup path, but wrong for a logger, which must stay
 * usable in contexts that never needed full env validation (a unit test
 * constructing one class in isolation, early startup before env is
 * validated, etc.). A logging call should never be what crashes those.
 */
function resolveLoggerEnv(): { serviceName: string; minSeverity: LogSeverity } {
  try {
    const env = getEnv();
    return { serviceName: env.OTEL_SERVICE_NAME, minSeverity: env.LOG_LEVEL };
  } catch {
    return { serviceName: DEFAULT_SERVICE_NAME, minSeverity: DEFAULT_LOG_LEVEL };
  }
}

/** Shared root logger, bound to OTEL_SERVICE_NAME and LOG_LEVEL from the environment when available. */
export function getLogger(): Logger {
  rootLogger ??= new StructuredLogger(
    resolveLoggerEnv().serviceName,
    () => resolveLoggerEnv().minSeverity,
  );
  return rootLogger;
}

/** Convenience for a logger pre-bound with fields every call site in a module wants attached (e.g. a component name). */
export function createLogger(bindings: LogAttributes): Logger {
  return getLogger().child(bindings);
}

/** Test-only: clears the memoized root logger so tests can construct a fresh one against a mocked env. */
export function resetLoggerForTests(): void {
  rootLogger = null;
}
