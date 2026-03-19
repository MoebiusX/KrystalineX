/**
 * Cap 12: PromQL Proxy API Tests (TDD)
 *
 * Tests for the /api/v1/monitor/query endpoint that proxies
 * PromQL queries to Prometheus for dashboard and programmatic use.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock logger
vi.mock('../../server/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    })),
}));

// Mock errors module
vi.mock('../../server/lib/errors', () => ({
    getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

// Mock all monitor service dependencies
vi.mock('../../server/monitor/trace-profiler', () => ({ traceProfiler: {} }));
vi.mock('../../server/monitor/anomaly-detector', () => ({ anomalyDetector: {} }));
vi.mock('../../server/monitor/history-store', () => ({ historyStore: {} }));
vi.mock('../../server/monitor/metrics-correlator', () => ({ metricsCorrelator: {} }));
vi.mock('../../server/monitor/training-store', () => ({ trainingStore: {} }));
vi.mock('../../server/monitor/amount-profiler', () => ({ amountProfiler: {} }));
vi.mock('../../server/monitor/amount-anomaly-detector', () => ({ amountAnomalyDetector: {} }));
vi.mock('../../server/monitor/topology-service', () => ({
    topologyService: { getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [], updatedAt: '' }), getBlastRadius: vi.fn().mockReturnValue([]) },
}));
vi.mock('../../server/services/transparency-service', () => ({
    transparencyService: { getStatus: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Cap 12: PromQL Proxy API', () => {
    let app: express.Express;
    let monitorRoutes: any;

    beforeAll(async () => {
        process.env.PROMETHEUS_URL = 'http://prometheus:9090';
        const mod = await import('../../server/monitor/routes');
        monitorRoutes = mod.default;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/v1/monitor', monitorRoutes);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('GET /api/v1/monitor/query', () => {
        it('should proxy an instant PromQL query to Prometheus', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    status: 'success',
                    data: {
                        resultType: 'vector',
                        result: [{ metric: { __name__: 'up' }, value: [1710000000, '1'] }],
                    },
                }),
            });

            const res = await request(app)
                .get('/api/v1/monitor/query')
                .query({ q: 'up', type: 'instant' });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('success');
            expect(res.body.data.result).toHaveLength(1);
        });

        it('should proxy a range PromQL query with start/end/step', async () => {
            const now = Math.floor(Date.now() / 1000);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    status: 'success',
                    data: {
                        resultType: 'matrix',
                        result: [{
                            metric: { __name__: 'http_requests_total' },
                            values: [[now - 60, '100'], [now, '150']],
                        }],
                    },
                }),
            });

            const res = await request(app)
                .get('/api/v1/monitor/query')
                .query({
                    q: 'rate(http_requests_total[5m])',
                    type: 'range',
                    start: String(now - 3600),
                    end: String(now),
                    step: '60',
                });

            expect(res.status).toBe(200);
            expect(res.body.data.resultType).toBe('matrix');

            // Verify Prometheus was called with query_range endpoint
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const fetchUrl = mockFetch.mock.calls[0][0];
            expect(fetchUrl).toContain('/api/v1/query_range');
            expect(fetchUrl).toContain('step=60');
        });

        it('should return 400 when query parameter is missing', async () => {
            const res = await request(app)
                .get('/api/v1/monitor/query');

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/query.*required/i);
        });

        it('should handle Prometheus being unreachable', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const res = await request(app)
                .get('/api/v1/monitor/query')
                .query({ q: 'up' });

            expect(res.status).toBe(502);
            expect(res.body.error).toMatch(/prometheus/i);
        });

        it('should handle Prometheus returning error status', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 422,
                statusText: 'Unprocessable Entity',
            });

            const res = await request(app)
                .get('/api/v1/monitor/query')
                .query({ q: 'invalid{{{' });

            expect(res.status).toBe(502);
        });

        it('should use instant query by default when type is not specified', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ status: 'success', data: { result: [] } }),
            });

            await request(app)
                .get('/api/v1/monitor/query')
                .query({ q: 'up' });

            const fetchUrl = mockFetch.mock.calls[0][0];
            expect(fetchUrl).toContain('/api/v1/query?');
            expect(fetchUrl).not.toContain('query_range');
        });

        it('should URL-encode the PromQL query', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ status: 'success', data: { result: [] } }),
            });

            await request(app)
                .get('/api/v1/monitor/query')
                .query({ q: 'rate(http_requests_total{method="GET"}[5m])' });

            const fetchUrl = mockFetch.mock.calls[0][0];
            expect(fetchUrl).toContain(encodeURIComponent('rate(http_requests_total{method="GET"}[5m])'));
        });
    });
});
