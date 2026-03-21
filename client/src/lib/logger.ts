/**
 * Browser Structured Logger
 *
 * Mirrors the server's createLogger() API using pino's browser bundle.
 * Auto-injects OpenTelemetry traceId/spanId when an active span exists.
 */

import pino from 'pino';
import { trace } from '@opentelemetry/api';

function getTraceContext(): { traceId?: string; spanId?: string } {
  try {
    const span = trace.getActiveSpan();
    const ctx = span?.spanContext();
    if (ctx?.traceId && ctx?.spanId) {
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    }
  } catch {
    // OTEL not initialized yet
  }
  return {};
}

const browser: pino.LoggerOptions['browser'] = {
  asObject: true,
  write: {
    trace: (o: any) => console.debug(fmt(o)),
    debug: (o: any) => console.debug(fmt(o)),
    info: (o: any) => console.info(fmt(o)),
    warn: (o: any) => console.warn(fmt(o)),
    error: (o: any) => console.error(fmt(o)),
    fatal: (o: any) => console.error(fmt(o)),
  },
};

function fmt(o: Record<string, any>): string {
  const { component, msg, traceId, spanId, level, time, ...rest } = o;
  const prefix = component ? `[${component}]` : '';
  const tid = traceId ? ` tid=${traceId.slice(0, 8)}` : '';
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${prefix}${tid} ${msg || ''}${extra}`;
}

const baseLogger = pino({ browser, level: 'debug' });

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

export function createLogger(
  component: string,
  defaultBindings: object = {}
): ComponentLogger {
  const child = baseLogger.child({ component, ...defaultBindings });

  const wrapLogMethod = (method: string) => {
    return (...args: any[]) => {
      const traceContext = getTraceContext();
      if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        args[0] = { ...args[0], ...traceContext };
      } else if (typeof args[0] === 'string') {
        args.unshift(traceContext);
      }
      return (child as any)[method](...args);
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
