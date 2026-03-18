// Browser OpenTelemetry SDK Initialization
// Creates spans for fetch() requests and exports to OTEL collector

import { trace } from '@opentelemetry/api';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// Flag to control whether browser OTEL is active
let otelEnabled = false;
let provider: WebTracerProvider | null = null;

export function initBrowserOtel(): void {
    if (provider) {
        console.log('[OTEL] Browser instrumentation already initialized');
        return;
    }

    console.log('[OTEL] Initializing browser OpenTelemetry...');

    // Create resource with service name using OTEL v2 API
    const resource = resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: 'kx-wallet',
        [SemanticResourceAttributes.SERVICE_NAMESPACE]: 'krystalinex',
        [SemanticResourceAttributes.SERVICE_VERSION]: import.meta.env.VITE_APP_VERSION || '1.0.0',
        'deployment.environment': import.meta.env.MODE || 'development',
    });

    // Configure OTLP exporter to send traces to the OTEL collector (with CORS)
    // The OTLP exporter requires an absolute URL - resolve relative paths using window.location.origin
    const rawOtelUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL || 'http://localhost:4319';
    const otelCollectorUrl = rawOtelUrl.startsWith('/')
        ? `${window.location.origin}${rawOtelUrl}`
        : rawOtelUrl;
    console.log('[OTEL] Collector URL:', `${otelCollectorUrl}/v1/traces`);
    const exporter = new OTLPTraceExporter({
        url: `${otelCollectorUrl}/v1/traces`,
        headers: {},
    });

    // Create the tracer provider with resource and span processors (OTEL v2 API)
    provider = new WebTracerProvider({
        resource,
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    // Register the provider globally with zone context manager
    // This makes trace.getTracer() from @opentelemetry/api use this provider
    provider.register({
        contextManager: new ZoneContextManager(),
    });

    // Verify the global trace API is using our provider
    const testTracer = trace.getTracer('test-tracer');
    console.log('[OTEL] Global tracer registered:', !!testTracer);

    // Register fetch instrumentation
    registerInstrumentations({
        instrumentations: [
            new FetchInstrumentation({
                // Only instrument API calls, not static assets
                ignoreUrls: [
                    /\/assets\//,
                    /\.(js|css|png|jpg|svg|ico|woff|woff2)$/,
                    /\/otel\//,         // Don't trace OTEL collector
                    /\/grafana\//,      // Don't trace Grafana
                    /\/jaeger\//,       // Don't trace Jaeger
                    /\/prometheus\//,   // Don't trace Prometheus
                ],
                // Propagate trace context to ALL API origins including same-origin (Vite proxy)
                propagateTraceHeaderCorsUrls: [
                    /localhost:5173/,   // Vite dev server (same-origin proxy)
                    /localhost:8000/,   // Kong Gateway
                    /localhost:5000/,   // Payment API direct
                    /^\/api\//,         // Relative /api paths
                    /krystaline\.io/,   // Production domain
                ],
                // Add useful attributes to spans
                applyCustomAttributesOnSpan: (span, request, _result) => {
                    if (request instanceof Request) {
                        span.setAttribute('http.url', request.url || '');
                    }
                },
            }),
        ],
    });

    otelEnabled = true;
    console.log('[OTEL] Browser instrumentation initialized - service.name: react-client');
}

export function isOtelEnabled(): boolean {
    return otelEnabled;
}

export function getTracer() {
    if (!provider) {
        throw new Error('OTEL not initialized - call initBrowserOtel() first');
    }
    return provider.getTracer('react-client');
}
