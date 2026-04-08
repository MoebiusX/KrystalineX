/**
 * Bayesian Inference Module — Unit Tests
 *
 * Tests feature extraction, client, and inference orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../server/monitor/topology-service', () => ({
    topologyService: {
        getGraph: vi.fn(async () => ({
            nodes: ['kx-exchange', 'kx-matcher', 'kx-wallet'],
            edges: [
                { parent: 'kx-exchange', child: 'kx-matcher', callCount: 3000 },
                { parent: 'kx-exchange', child: 'kx-wallet', callCount: 1500 },
            ],
            updatedAt: new Date().toISOString(),
        })),
    },
}));

vi.mock('../../server/monitor/trace-profiler', () => ({
    traceProfiler: {
        getBaselines: vi.fn(() => [
            {
                service: 'kx-exchange',
                operation: 'POST /api/orders',
                spanKey: 'kx-exchange:POST /api/orders',
                mean: 18.3,
                stdDev: 15.1,
                variance: 228.01,
                p50: 12.5,
                p95: 45.2,
                p99: 120.0,
                min: 2.0,
                max: 500.0,
                sampleCount: 5000,
                lastUpdated: new Date(),
            },
            {
                service: 'kx-matcher',
                operation: 'match_order',
                spanKey: 'kx-matcher:match_order',
                mean: 12.0,
                stdDev: 10.0,
                variance: 100.0,
                p50: 8.0,
                p95: 25.0,
                p99: 80.0,
                min: 1.0,
                max: 300.0,
                sampleCount: 3000,
                lastUpdated: new Date(),
            },
        ]),
    },
}));

vi.mock('../../server/config', () => ({
    config: {
        observability: {
            jaegerUrl: 'http://localhost:16686',
        },
    },
}));

vi.mock('../../server/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })),
}));

// ─── Tests: Feature Extraction ──────────────────────────────────────────────

describe('Feature Extraction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts service metrics from baselines', async () => {
        const { extractFeaturesFromBaselines } = await import(
            '../../server/bayesian/feature-extractor'
        );

        const result = extractFeaturesFromBaselines();

        expect(result.services).toHaveLength(2);

        const exchange = result.services.find(
            (s) => s.service_name === 'kx-exchange'
        );
        expect(exchange).toBeDefined();
        expect(exchange!.latency.mean).toBeCloseTo(18.3, 1);
        expect(exchange!.latency.p50).toBeCloseTo(12.5, 1);
        expect(exchange!.latency.p95).toBeCloseTo(45.2, 1);
        expect(exchange!.latency.sample_count).toBe(5000);
        expect(exchange!.request_count).toBe(5000);

        const matcher = result.services.find(
            (s) => s.service_name === 'kx-matcher'
        );
        expect(matcher).toBeDefined();
        expect(matcher!.latency.mean).toBeCloseTo(12.0, 1);
    });

    it('builds dependency graph from baselines', async () => {
        const { extractFeaturesFromBaselines } = await import(
            '../../server/bayesian/feature-extractor'
        );

        const result = extractFeaturesFromBaselines();

        expect(result.dependency_graph.nodes).toContain('kx-exchange');
        expect(result.dependency_graph.nodes).toContain('kx-matcher');
    });
});

// ─── Tests: Type Definitions ────────────────────────────────────────────────

describe('Type Contracts', () => {
    it('ServiceMetrics has all required fields', async () => {
        const types = await import('../../server/bayesian/types');

        // Type-level check: create a valid object
        const metrics: typeof types extends { ServiceMetrics: infer T }
            ? never
            : import('../../server/bayesian/types').ServiceMetrics = {
            service_name: 'test',
            latency: {
                p50: 10,
                p95: 50,
                p99: 100,
                mean: 20,
                std_dev: 15,
                sample_count: 1000,
            },
            error_rate: 0.05,
            error_count: 50,
            request_count: 1000,
        };

        expect(metrics.service_name).toBe('test');
        expect(metrics.latency.p50).toBe(10);
        expect(metrics.error_rate).toBe(0.05);
    });

    it('InferResponse has expected structure', () => {
        // Validate the expected response shape matches spec
        const response: import('../../server/bayesian/types').InferResponse = {
            results: [
                {
                    service: 'checkout',
                    latency_anomaly_probability: 0.87,
                    error_anomaly_probability: 0.12,
                    likely_root_causes: [
                        {
                            service: 'database',
                            probability: 0.65,
                            evidence: 'high latency',
                        },
                    ],
                    confidence: 0.91,
                    posterior_latency_mean: 2.5,
                    posterior_latency_std: 0.8,
                    posterior_error_rate: 0.02,
                },
            ],
            model_trained: true,
            inference_time_ms: 3.21,
        };

        expect(response.results).toHaveLength(1);
        expect(response.results[0].latency_anomaly_probability).toBe(0.87);
        expect(response.results[0].likely_root_causes).toHaveLength(1);
        expect(response.model_trained).toBe(true);
    });
});

// ─── Tests: Client ──────────────────────────────────────────────────────────

describe('BayesianClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('constructs with default URL', async () => {
        const { BayesianClient } = await import(
            '../../server/bayesian/client'
        );

        const client = new BayesianClient();
        // Should not throw on construction
        expect(client).toBeDefined();
    });

    it('constructs with custom URL', async () => {
        const { BayesianClient } = await import(
            '../../server/bayesian/client'
        );

        const client = new BayesianClient('http://custom:9999');
        expect(client).toBeDefined();
    });

    it('marks unavailable on ECONNREFUSED', async () => {
        const { BayesianClient } = await import(
            '../../server/bayesian/client'
        );

        // Use a port that's definitely not listening
        const client = new BayesianClient('http://localhost:19999', 2000);

        const available = await client.isAvailable();
        expect(available).toBe(false);
    });
});

// ─── Tests: Inference Orchestrator ──────────────────────────────────────────

describe('BayesianInference', () => {
    it('returns empty insights when service unavailable', async () => {
        const { BayesianInference } = await import(
            '../../server/bayesian/inference'
        );

        const engine = new BayesianInference();
        const insights = await engine.runCycle();

        expect(insights).toEqual([]);
    });

    it('getLatestInsights returns empty array initially', async () => {
        const { BayesianInference } = await import(
            '../../server/bayesian/inference'
        );

        const engine = new BayesianInference();
        expect(engine.getLatestInsights()).toEqual([]);
    });
});
