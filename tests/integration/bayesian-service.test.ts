/**
 * Bayesian Service Integration Test
 *
 * Tests the live Python Bayesian service endpoints.
 * Requires: docker compose up bayesian-service
 *
 * Run: npx vitest run tests/integration/bayesian-service.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.BAYESIAN_SERVICE_URL || 'http://localhost:8100';

async function fetchJSON(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
}

// Skip entire suite if service isn't running
let serviceAvailable = false;

beforeAll(async () => {
    try {
        const res = await fetch(`${BASE_URL}/health`, {
            signal: AbortSignal.timeout(3000),
        });
        serviceAvailable = res.ok;
    } catch {
        serviceAvailable = false;
    }
});

describe('Bayesian Service Integration', () => {
    // ─── Health ─────────────────────────────────────────────────────────

    it('GET /health returns healthy status', async () => {
        if (!serviceAvailable) return;

        const { status, data } = await fetchJSON('GET', '/health');

        expect(status).toBe(200);
        expect(data.status).toBe('healthy');
        expect(typeof data.model_loaded).toBe('boolean');
        expect(typeof data.services_tracked).toBe('number');
    });

    // ─── Training ───────────────────────────────────────────────────────

    it('POST /train fits model from summary statistics', async () => {
        if (!serviceAvailable) return;

        const { status, data } = await fetchJSON('POST', '/train', {
            services: [
                {
                    service_name: 'svc-a',
                    latency: { p50: 10, p95: 40, p99: 100, mean: 15, std_dev: 12, sample_count: 2000 },
                    error_rate: 0.01,
                    error_count: 20,
                    request_count: 2000,
                },
                {
                    service_name: 'svc-b',
                    latency: { p50: 5, p95: 20, p99: 50, mean: 8, std_dev: 6, sample_count: 3000 },
                    error_rate: 0.005,
                    error_count: 15,
                    request_count: 3000,
                },
                {
                    service_name: 'svc-c',
                    latency: { p50: 20, p95: 80, p99: 200, mean: 30, std_dev: 25, sample_count: 1000 },
                    error_rate: 0.03,
                    error_count: 30,
                    request_count: 1000,
                },
            ],
            dependency_graph: {
                nodes: ['svc-a', 'svc-b', 'svc-c'],
                edges: [
                    { parent: 'svc-a', child: 'svc-b', call_count: 3000 },
                    { parent: 'svc-a', child: 'svc-c', call_count: 1000 },
                ],
            },
        });

        expect(status).toBe(200);
        expect(data.status).toBe('trained');
        expect(data.services_modeled).toContain('svc-a');
        expect(data.services_modeled).toContain('svc-b');
        expect(data.services_modeled).toContain('svc-c');
        expect(data.samples_used).toBe(6000);
    });

    // ─── Inference: Normal traffic ──────────────────────────────────────

    it('POST /infer returns low anomaly scores for normal traffic', async () => {
        if (!serviceAvailable) return;

        const { status, data } = await fetchJSON('POST', '/infer', {
            services: [
                {
                    service_name: 'svc-a',
                    latency: { p50: 11, p95: 42, p99: 105, mean: 16, std_dev: 13, sample_count: 100 },
                    error_rate: 0.01,
                    error_count: 1,
                    request_count: 100,
                },
                {
                    service_name: 'svc-b',
                    latency: { p50: 5, p95: 22, p99: 55, mean: 9, std_dev: 7, sample_count: 150 },
                    error_rate: 0.007,
                    error_count: 1,
                    request_count: 150,
                },
            ],
            dependency_graph: {
                nodes: ['svc-a', 'svc-b'],
                edges: [{ parent: 'svc-a', child: 'svc-b', call_count: 150 }],
            },
        });

        expect(status).toBe(200);
        expect(data.model_trained).toBe(true);
        expect(data.results).toHaveLength(2);

        // Normal traffic → low anomaly probability
        for (const result of data.results) {
            expect(result.latency_anomaly_probability).toBeLessThan(0.5);
            expect(result.confidence).toBeGreaterThan(0.3);
        }
    });

    // ─── Inference: Anomalous traffic ───────────────────────────────────

    it('POST /infer detects anomaly for degraded service', async () => {
        if (!serviceAvailable) return;

        const { status, data } = await fetchJSON('POST', '/infer', {
            services: [
                {
                    service_name: 'svc-a',
                    latency: { p50: 50, p95: 200, p99: 500, mean: 80, std_dev: 60, sample_count: 100 },
                    error_rate: 0.1,
                    error_count: 10,
                    request_count: 100,
                },
                {
                    service_name: 'svc-b',
                    latency: { p50: 80, p95: 300, p99: 800, mean: 120, std_dev: 90, sample_count: 100 },
                    error_rate: 0.15,
                    error_count: 15,
                    request_count: 100,
                },
            ],
            dependency_graph: {
                nodes: ['svc-a', 'svc-b'],
                edges: [{ parent: 'svc-a', child: 'svc-b', call_count: 100 }],
            },
        });

        expect(status).toBe(200);

        const svcB = data.results.find((r: any) => r.service === 'svc-b');
        expect(svcB).toBeDefined();
        // svc-b mean went from 8ms to 120ms — should be flagged
        expect(svcB!.latency_anomaly_probability).toBeGreaterThan(0.5);

        // svc-a should list svc-b as root cause
        const svcA = data.results.find((r: any) => r.service === 'svc-a');
        expect(svcA).toBeDefined();
        const rootCauses = svcA!.likely_root_causes;
        expect(rootCauses.length).toBeGreaterThan(0);
        expect(rootCauses[0].service).toBe('svc-b');
    });

    // ─── Inference: Time windows with trend ─────────────────────────────

    it('POST /infer boosts anomaly score for worsening trends', async () => {
        if (!serviceAvailable) return;

        const now = Date.now();

        const { status, data } = await fetchJSON('POST', '/infer', {
            services: [
                {
                    service_name: 'svc-b',
                    latency: { p50: 60, p95: 200, p99: 500, mean: 100, std_dev: 70, sample_count: 50 },
                    error_rate: 0.05,
                    error_count: 3,
                    request_count: 50,
                },
            ],
            dependency_graph: { nodes: ['svc-b'], edges: [] },
            time_windows: [
                {
                    window_name: '5m',
                    start_epoch_ms: now - 300000,
                    end_epoch_ms: now,
                    services: [{
                        service_name: 'svc-b',
                        latency: { p50: 70, p95: 250, p99: 600, mean: 110, std_dev: 80, sample_count: 30 },
                        error_rate: 0.06, error_count: 2, request_count: 30,
                    }],
                },
                {
                    window_name: '15m',
                    start_epoch_ms: now - 900000,
                    end_epoch_ms: now,
                    services: [{
                        service_name: 'svc-b',
                        latency: { p50: 40, p95: 150, p99: 400, mean: 60, std_dev: 45, sample_count: 80 },
                        error_rate: 0.03, error_count: 2, request_count: 80,
                    }],
                },
                {
                    window_name: '1h',
                    start_epoch_ms: now - 3600000,
                    end_epoch_ms: now,
                    services: [{
                        service_name: 'svc-b',
                        latency: { p50: 15, p95: 50, p99: 120, mean: 20, std_dev: 15, sample_count: 200 },
                        error_rate: 0.01, error_count: 2, request_count: 200,
                    }],
                },
            ],
        });

        expect(status).toBe(200);
        const svcB = data.results.find((r: any) => r.service === 'svc-b');
        expect(svcB).toBeDefined();
        // Worsening trend (1h: 20ms → 15m: 60ms → 5m: 110ms) should boost probability
        expect(svcB!.latency_anomaly_probability).toBeGreaterThan(0.6);
    });

    // ─── Validation: Bad request ────────────────────────────────────────

    it('POST /infer rejects malformed request', async () => {
        if (!serviceAvailable) return;

        const res = await fetch(`${BASE_URL}/infer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bad: 'data' }),
        });

        expect(res.status).toBe(422); // Pydantic validation error
    });
});
