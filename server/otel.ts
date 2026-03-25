// Register ESM loader hooks so import-in-the-middle can intercept
// built-in modules (http, etc.) for proper context propagation.
// Must run before the main module's imports are resolved.
import { register } from 'node:module';
register('import-in-the-middle/hook.mjs', import.meta.url);

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { SimpleSpanProcessor, BatchSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import os from 'os';

// Only enable verbose OTEL logging in development with DEBUG flag
const OTEL_DEBUG = process.env.NODE_ENV !== 'production' && process.env.OTEL_DEBUG === 'true';

// Store traces for local visualization
export const traces: any[] = [];

// Clear traces function for proper isolation
export function clearTraces() {
  traces.length = 0;
}

// Custom trace collector for demo visualization
class TraceCollector implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    spans.forEach(span => {
      // Show only business-critical spans (authentic OpenTelemetry data)
      const httpMethod = span.attributes?.['http.method'];
      const spanName = span.name || '';
      const component = span.attributes?.['component'];

      // Skip GET requests - they're UI polling noise
      if (httpMethod === 'GET') {
        return;
      }

      // Only show business operations: POST/DELETE requests, Kong Gateway, AMQP operations
      const isBusinessSpan = httpMethod === 'POST' || httpMethod === 'DELETE' ||
        component === 'api-gateway' ||
        spanName.includes('kong') ||
        spanName.includes('amqp') ||
        spanName.includes('rabbitmq') ||
        span.attributes?.['messaging.system'] === 'rabbitmq' ||
        span.attributes?.['http.url']?.toString().includes(':8000') || // Kong Gateway requests
        span.kind === 3 || // Client spans (outgoing requests)
        span.kind === 4;   // Producer spans (message publishing)

      if (!isBusinessSpan) {
        return;
      }

      // Debug logging only when OTEL_DEBUG is enabled
      const operation = span.attributes?.['messaging.operation'] || httpMethod || spanName;
      if (OTEL_DEBUG) {
        console.log(`[OTEL] Capturing span: ${spanName} | Operation: ${operation} | TraceID: ${span.spanContext().traceId} | Service: ${span.attributes?.['service.name']}`);
      }

      // Show attributes for debugging span capture
      if (OTEL_DEBUG && (span.attributes?.['messaging.system'] || spanName.includes('amqp') || spanName.includes('rabbitmq'))) {
        console.log(`[OTEL] RabbitMQ span captured:`, {
          name: span.name,
          messaging: {
            system: span.attributes?.['messaging.system'],
            operation: span.attributes?.['messaging.operation'],
            destination: span.attributes?.['messaging.destination']
          }
        });
      }

      const traceData = {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId || null,
        name: span.name,
        kind: span.kind,
        status: span.status,
        startTime: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1000000),
        endTime: span.endTime ? new Date(span.endTime[0] * 1000 + span.endTime[1] / 1000000) : null,
        duration: span.endTime ? (span.endTime[0] - span.startTime[0]) * 1000 + (span.endTime[1] - span.startTime[1]) / 1000000 : null,
        attributes: span.attributes,
        serviceName: span.resource?.attributes?.[SemanticResourceAttributes.SERVICE_NAME] || 'payment-api',
        events: span.events || []
      };

      // Only add if this span doesn't already exist to prevent duplicates
      const existingSpan = traces.find(t => t.traceId === traceData.traceId && t.spanId === traceData.spanId);
      if (!existingSpan) {
        traces.push(traceData);
        if (OTEL_DEBUG) {
          console.log(`[OTEL] Stored span in traces array. Total traces: ${traces.length}`);
        }
      }

      // Keep only last 100 traces
      if (traces.length > 100) {
        traces.shift();
      }
    });

    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const traceCollector = new TraceCollector();

// Configure Jaeger OTLP exporter - use env var for K8s, fallback to localhost for dev
const jaegerEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const jaegerExporter = new OTLPTraceExporter({
  url: `${jaegerEndpoint}/v1/traces`,
  headers: {},
});

// Resource attributes for service identification (aligned across environments)
const serviceResource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: 'kx-exchange',
  [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
  [SemanticResourceAttributes.SERVICE_NAMESPACE]: 'krystalinex',
  'deployment.environment': process.env.NODE_ENV || 'development',
  'service.instance.id': os.hostname(),
});

// Initialize OpenTelemetry SDK with multiple exporters
const sdk = new NodeSDK({
  resource: serviceResource,
  spanProcessors: [
    new SimpleSpanProcessor(traceCollector),     // For local UI (immediate)
    new BatchSpanProcessor(jaegerExporter)        // For Jaeger (batched for efficiency)
  ],
  instrumentations: [getNodeAutoInstrumentations({
    // Disable fs instrumentation to reduce noise
    '@opentelemetry/instrumentation-fs': {
      enabled: false,
    },
    // Enable AMQP instrumentation for RabbitMQ spans
    '@opentelemetry/instrumentation-amqplib': {
      enabled: true,
    },
    // Enable HTTP instrumentation for Kong proxy spans
    '@opentelemetry/instrumentation-http': {
      enabled: true,
      ignoreOutgoingRequestHook: (request) => {
        // Exclude internal monitoring traffic to prevent self-referential
        // anomaly detection loops (detector polls Jaeger → creates span →
        // Jaeger stores span → detector flags its own slow poll as anomaly)
        const path = request.path || '';
        const host = (request.hostname || request.host || '') + ':' + (request.port || '');
        if (/\/api\/traces|\/api\/services|\/v1\/traces|jaeger/.test(path)) return true;
        if (/:16686|:4318|:4317/.test(host)) return true;
        if (/\/metrics/.test(path) || /:9090/.test(host)) return true;
        return false;
      },
    },
    // Suppress undici instrumentation — it duplicates HTTP client spans
    // and creates unfiltered monitoring-loop spans via fetch()
    '@opentelemetry/instrumentation-undici': {
      enabled: false,
    },
  })],
});

// Start the SDK
sdk.start();

export { sdk };