/**
 * Feature Extraction Pipeline
 *
 * Transforms raw OTEL traces (from Jaeger) into structured features
 * suitable for the Bayesian inference service.
 *
 * Produces:
 *   A) Service-level metrics (latency distributions, error rates, volume)
 *   B) Dependency graph (from trace parent/child relationships)
 *   C) Time-windowed features (sliding windows: 5m, 15m, 1h)
 */

import type { JaegerTrace, JaegerSpan, SpanBaseline } from '../monitor/types';
import type {
    ServiceMetrics,
    LatencyDistribution,
    BayesianDependencyGraph,
    BayesianServiceEdge,
    TimeWindow,
    SpanRecord,
} from './types';
import { topologyService } from '../monitor/topology-service';
import { traceProfiler } from '../monitor/trace-profiler';
import { config } from '../config';
import { createLogger } from '../lib/logger';

const logger = createLogger('bayesian-feature-extractor');
const JAEGER_API_URL = config.observability.jaegerUrl;

const MONITORED_SERVICES = [
    'kx-wallet',
    'api-gateway',
    'kx-exchange',
    'kx-matcher',
];

// Time window definitions (name → lookback ms)
const TIME_WINDOWS: Record<string, number> = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract a complete feature set for Bayesian training or inference.
 */
export async function extractFeatures(): Promise<{
    services: ServiceMetrics[];
    dependency_graph: BayesianDependencyGraph;
    time_windows: TimeWindow[];
    spans: SpanRecord[];
}> {
    const [traces, graph] = await Promise.all([
        fetchRecentTraces('1h'),
        extractDependencyGraph(),
    ]);

    const spans = flattenTraces(traces);
    const services = aggregateServiceMetrics(spans);
    const timeWindows = await extractTimeWindows();

    logger.info({
        servicesCount: services.length,
        spansCount: spans.length,
        nodesCount: graph.nodes.length,
        edgesCount: graph.edges.length,
    }, 'Feature extraction complete');

    return {
        services,
        dependency_graph: graph,
        time_windows: timeWindows,
        spans: spans.map(toSpanRecord),
    };
}

/**
 * Extract features using only existing profiler baselines (no Jaeger fetch).
 * Faster path for inference when baselines are already populated.
 */
export function extractFeaturesFromBaselines(): {
    services: ServiceMetrics[];
    dependency_graph: BayesianDependencyGraph;
} {
    const baselines = traceProfiler.getBaselines();
    const services = baselinesAsServiceMetrics(baselines);

    // Use cached topology
    const graph = extractDependencyGraphSync();

    return { services, dependency_graph: graph };
}

// ─── Service-Level Metrics ──────────────────────────────────────────────────

interface ParsedSpan {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    service: string;
    operation: string;
    durationMs: number;
    isError: boolean;
    timestampMs: number;
}

function flattenTraces(traces: JaegerTrace[]): ParsedSpan[] {
    const spans: ParsedSpan[] = [];

    for (const trace of traces) {
        for (const span of trace.spans) {
            const process = trace.processes[span.processID];
            if (!process) continue;

            const parentRef = span.references.find(r => r.refType === 'CHILD_OF');
            const isError = span.tags.some(
                t => (t.key === 'error' && t.value === true) ||
                     (t.key === 'otel.status_code' && t.value === 'ERROR') ||
                     (t.key === 'http.status_code' && Number(t.value) >= 500)
            );

            spans.push({
                traceId: trace.traceID,
                spanId: span.spanID,
                parentSpanId: parentRef?.spanID ?? null,
                service: process.serviceName,
                operation: span.operationName,
                durationMs: span.duration / 1000,
                isError,
                timestampMs: span.startTime / 1000,
            });
        }
    }

    return spans;
}

function aggregateServiceMetrics(spans: ParsedSpan[]): ServiceMetrics[] {
    const grouped = new Map<string, ParsedSpan[]>();

    for (const span of spans) {
        const existing = grouped.get(span.service);
        if (existing) {
            existing.push(span);
        } else {
            grouped.set(span.service, [span]);
        }
    }

    const results: ServiceMetrics[] = [];

    for (const [service, svcSpans] of Array.from(grouped.entries())) {
        const durations = svcSpans.map((s: ParsedSpan) => s.durationMs).sort((a: number, b: number) => a - b);
        const errorCount = svcSpans.filter((s: ParsedSpan) => s.isError).length;
        const n = durations.length;

        if (n === 0) continue;

        const mean = durations.reduce((a: number, b: number) => a + b, 0) / n;
        const variance = durations.reduce((sum: number, d: number) => sum + (d - mean) ** 2, 0) / n;
        const stdDev = Math.sqrt(variance);

        const latency: LatencyDistribution = {
            p50: durations[Math.floor(n * 0.5)] ?? 0,
            p95: durations[Math.floor(n * 0.95)] ?? 0,
            p99: durations[Math.floor(n * 0.99)] ?? 0,
            mean: round(mean),
            std_dev: round(stdDev),
            sample_count: n,
        };

        results.push({
            service_name: service,
            latency,
            error_rate: round(n > 0 ? errorCount / n : 0, 6),
            error_count: errorCount,
            request_count: n,
        });
    }

    return results;
}

/**
 * Convert existing SpanBaseline objects to ServiceMetrics.
 * Groups baselines by service and merges operations.
 */
function baselinesAsServiceMetrics(baselines: SpanBaseline[]): ServiceMetrics[] {
    const grouped = new Map<string, SpanBaseline[]>();

    for (const b of baselines) {
        const existing = grouped.get(b.service);
        if (existing) {
            existing.push(b);
        } else {
            grouped.set(b.service, [b]);
        }
    }

    const results: ServiceMetrics[] = [];

    for (const [service, ops] of Array.from(grouped.entries())) {
        // Aggregate across operations: weighted mean by sample count
        let totalSamples = 0;
        let weightedMean = 0;
        let weightedP50 = 0;
        let weightedP95 = 0;
        let weightedP99 = 0;
        let weightedVar = 0;

        for (const op of ops) {
            totalSamples += op.sampleCount;
            weightedMean += op.mean * op.sampleCount;
            weightedP50 += op.p50 * op.sampleCount;
            weightedP95 += op.p95 * op.sampleCount;
            weightedP99 += op.p99 * op.sampleCount;
            weightedVar += op.variance * op.sampleCount;
        }

        if (totalSamples === 0) continue;

        const mean = weightedMean / totalSamples;
        const variance = weightedVar / totalSamples;

        results.push({
            service_name: service,
            latency: {
                p50: round(weightedP50 / totalSamples),
                p95: round(weightedP95 / totalSamples),
                p99: round(weightedP99 / totalSamples),
                mean: round(mean),
                std_dev: round(Math.sqrt(variance)),
                sample_count: totalSamples,
            },
            error_rate: 0, // Baselines don't track errors
            error_count: 0,
            request_count: totalSamples,
        });
    }

    return results;
}

// ─── Dependency Graph ───────────────────────────────────────────────────────

async function extractDependencyGraph(): Promise<BayesianDependencyGraph> {
    try {
        const graph = await topologyService.getGraph();
        return {
            nodes: graph.nodes,
            edges: graph.edges.map(e => ({
                parent: e.parent,
                child: e.child,
                call_count: e.callCount,
            })),
        };
    } catch (err) {
        logger.warn({ err }, 'Failed to get dependency graph from topology service');
        return { nodes: [], edges: [] };
    }
}

function extractDependencyGraphSync(): BayesianDependencyGraph {
    // topologyService caches the graph — this is safe to call synchronously
    // if the cache is populated. Falls back to empty if not.
    try {
        const baselines = traceProfiler.getBaselines();
        const services = Array.from(new Set(baselines.map(b => b.service)));
        return { nodes: services, edges: [] };
    } catch {
        return { nodes: [], edges: [] };
    }
}

// ─── Time-Windowed Features ─────────────────────────────────────────────────

async function extractTimeWindows(): Promise<TimeWindow[]> {
    const windows: TimeWindow[] = [];
    const now = Date.now();

    for (const [name, lookbackMs] of Object.entries(TIME_WINDOWS)) {
        try {
            const traces = await fetchRecentTraces(name);
            const spans = flattenTraces(traces);
            const services = aggregateServiceMetrics(spans);

            windows.push({
                window_name: name,
                start_epoch_ms: now - lookbackMs,
                end_epoch_ms: now,
                services,
            });
        } catch (err) {
            logger.debug({ err, window: name }, 'Failed to extract time window');
        }
    }

    return windows;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchRecentTraces(lookback: string): Promise<JaegerTrace[]> {
    const traces: JaegerTrace[] = [];
    const seen = new Set<string>();

    for (const service of MONITORED_SERVICES) {
        try {
            const url = `${JAEGER_API_URL}/api/traces?service=${service}&lookback=${lookback}&limit=50`;
            const response = await fetch(url);
            if (!response.ok) continue;

            const data = await response.json() as { data?: JaegerTrace[] };
            for (const trace of data.data ?? []) {
                if (!seen.has(trace.traceID)) {
                    seen.add(trace.traceID);
                    traces.push(trace);
                }
            }
        } catch {
            // Jaeger unavailable — skip silently
        }
    }

    return traces;
}

function toSpanRecord(span: ParsedSpan): SpanRecord {
    return {
        trace_id: span.traceId,
        span_id: span.spanId,
        parent_span_id: span.parentSpanId,
        service_name: span.service,
        operation_name: span.operation,
        duration_ms: round(span.durationMs),
        status: span.isError ? 'ERROR' : 'OK',
        timestamp: span.timestampMs,
    };
}

function round(n: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round(n * factor) / factor;
}
