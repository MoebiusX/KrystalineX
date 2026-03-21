/**
 * Web Vitals Reporter
 *
 * Shared function for reporting Web Vital metrics as OTEL spans.
 * Used by the browser OTEL setup (client/src/lib/otel.ts).
 *
 * Extracted to shared/ so it can be unit-tested without browser APIs.
 */

import type { Tracer } from '@opentelemetry/api';

export interface WebVitalMetric {
    name: string;
    value: number;
    rating: 'good' | 'needs-improvement' | 'poor';
    id: string;
    delta: number;
    entries: unknown[];
    navigationType: string;
}

/**
 * Report a Web Vital metric as an OTEL span.
 */
export function reportWebVital(tracer: Tracer, metric: WebVitalMetric): void {
    const span = tracer.startSpan(`web-vital.${metric.name}`);
    span.setAttribute('web_vital.name', metric.name);
    span.setAttribute('web_vital.value', metric.value);
    span.setAttribute('web_vital.rating', metric.rating);
    span.setAttribute('web_vital.id', metric.id);
    span.setAttribute('web_vital.delta', metric.delta);
    span.setAttribute('web_vital.navigation_type', metric.navigationType);
    span.end();
}
