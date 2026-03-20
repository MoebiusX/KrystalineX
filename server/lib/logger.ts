/**
 * Structured Logging Service
 * 
 * Provides structured JSON logging with OpenTelemetry trace context integration.
 * Uses Pino for high-performance logging with dual transport:
 * - Console/Pretty output for development
 * - Loki HTTP push for unified observability
 */

import pino, { Logger, TransportTargetOptions } from 'pino';
import { trace, Span } from '@opentelemetry/api';
import { config } from '../config';

// ============================================
// LOGGER CONFIGURATION
// ============================================

/**
 * Build the Pino transport configuration based on environment.
 * In development with pretty=true: use pino-pretty for console.
 * In production or when Loki is available: use pino-loki for log aggregation.
 */
function buildTransportConfig(): pino.TransportMultiOptions | pino.TransportSingleOptions | undefined {
  const targets: TransportTargetOptions[] = [];

  // Always add console/pretty output in development
  if (config.logging.pretty) {
    targets.push({
      target: 'pino-pretty',
      level: config.logging.level,
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '[{component}] {msg}',
      },
    });
  } else {
    // In production, output JSON to stdout
    targets.push({
      target: 'pino/file',
      level: config.logging.level,
      options: { destination: 1 }, // stdout
    });
  }

  // Add Loki transport if URL is configured
  // Note: We always add Loki in non-test environments to support unified observability
  if (config.observability.lokiUrl && config.env !== 'test') {
    targets.push({
      target: 'pino-loki',
      level: config.logging.level,
      options: {
        batching: true,
        interval: 5, // Flush every 5 seconds
        host: config.observability.lokiUrl,
        labels: {
          app: 'kx-exchange',
          environment: config.env,
        },
        propsToLabels: ['component'],
        // Use string template to avoid double-serialization of nested objects
        // {level} will be numeric (pino convention) — mapped to text via Loki label
        logFormat: '[{component}] {msg}',
        replaceTimestamp: true,
        silenceErrors: false,
      },
    });
  }

  // If we have multiple targets, use multi transport
  if (targets.length > 1) {
    return { targets };
  } else if (targets.length === 1) {
    return targets[0];
  }

  // Fallback: no transport config (raw JSON to stdout)
  return undefined;
}

// Build transport config - needed to check if we can use formatters
const transportConfig = buildTransportConfig();

// Note: Pino doesn't allow custom formatters with multi-target transports
// When using transports, formatting must happen in the transport itself
const pinoConfig: pino.LoggerOptions = {
  level: config.logging.level,

  // Add timestamp
  timestamp: pino.stdTimeFunctions.isoTime,

  // Build transport configuration
  transport: transportConfig,

  // Formatters can only be used without transport or with single transport
  // When using multi-target transports (development + loki), we skip custom formatters
  ...(transportConfig && 'targets' in transportConfig ? {} : {
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
      bindings: (bindings) => ({
        pid: bindings.pid,
        hostname: bindings.hostname,
      }),
    },
  }),
};

// Base logger instance
const baseLogger = pino(pinoConfig);

// ============================================
// TRACE CONTEXT HELPER
// ============================================

/**
 * Extract OpenTelemetry trace context from active span
 */
function getTraceContext(): { traceId?: string; spanId?: string } {
  const span: Span | undefined = trace.getActiveSpan();
  const spanContext = span?.spanContext();

  if (spanContext && spanContext.traceId && spanContext.spanId) {
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    };
  }

  return {};
}

// ============================================
// LOGGER FACTORY
// ============================================

export interface ComponentLogger {
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  child: (bindings: object) => ComponentLogger;
}

/**
 * Create a logger for a specific component with automatic trace context
 * 
 * @param component - Component name (e.g., 'server', 'rabbitmq', 'kong')
 * @param defaultBindings - Additional default bindings to include in all logs
 * 
 * @example
 * const logger = createLogger('payment-service');
 * logger.info('Processing payment', { amount: 100 });
 * 
 * @example
 * const logger = createLogger('rabbitmq', { queue: 'orders' });
 * logger.debug('Message published');
 */
export function createLogger(
  component: string,
  defaultBindings: object = {}
): ComponentLogger {
  const componentLogger = baseLogger.child({
    component,
    ...defaultBindings,
  });

  // Wrapper that automatically injects trace context
  const wrapLogMethod = (method: keyof Logger) => {
    return (...args: any[]) => {
      const traceContext = getTraceContext();

      // If first arg is an object, merge trace context
      if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        args[0] = { ...args[0], ...traceContext };
      } else if (typeof args[0] === 'string') {
        // If first arg is a string, prepend trace context object
        args.unshift(traceContext);
      }

      return (componentLogger[method] as any)(...args);
    };
  };

  return {
    trace: wrapLogMethod('trace'),
    debug: wrapLogMethod('debug'),
    info: wrapLogMethod('info'),
    warn: wrapLogMethod('warn'),
    error: wrapLogMethod('error'),
    fatal: wrapLogMethod('fatal'),
    child: (bindings: object) => createLogger(component, { ...defaultBindings, ...bindings }),
  } as ComponentLogger;
}

// ============================================
// BASE LOGGER EXPORT
// ============================================

/**
 * Base logger instance (without component context)
 * Use createLogger() instead for component-specific logging
 */
export const logger = baseLogger;

/**
 * Create a logger with explicit trace context (useful for async operations)
 * 
 * @param component - Component name
 * @param traceId - Explicit trace ID
 * @param spanId - Explicit span ID
 */
export function createLoggerWithContext(
  component: string,
  traceId: string,
  spanId: string
): Logger {
  return baseLogger.child({
    component,
    traceId,
    spanId,
  });
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Log an error with full stack trace and context
 */
export function logError(
  logger: ComponentLogger,
  error: Error,
  context?: object
): void {
  logger.error({
    err: {
      message: error.message,
      name: error.name,
      stack: error.stack,
    },
    ...context,
  }, error.message);
}

/**
 * Log performance metrics
 */
export function logPerformance(
  logger: ComponentLogger,
  operation: string,
  durationMs: number,
  metadata?: object
): void {
  logger.info({
    operation,
    durationMs,
    ...metadata,
  }, `${operation} completed in ${durationMs}ms`);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  baseLogger.info('SIGTERM received, flushing logs...');
  baseLogger.flush();
});
