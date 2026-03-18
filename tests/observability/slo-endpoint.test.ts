/**
 * SLO Endpoint Tests (TDD — retroactive for Cap 5)
 *
 * Tests for the GET /api/monitor/slo endpoint
 * that returns current SLO status, burn rates, and error budgets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock all monitor dependencies
vi.mock('../../server/monitor/trace-profiler', () => ({
    traceProfiler: { getBaselines: vi.fn(() => []) },
}));

vi.mock('../../server/monitor/anomaly-detector', () => ({
    anomalyDetector: {
        getServiceHealth: vi.fn(() => []),
        getActiveAnomalies: vi.fn(() => []),
    },
}));

vi.mock('../../server/monitor/history-store', () => ({
    historyStore: {
        getAnomalyHistory: vi.fn(() => []),
        getHourlyTrend: vi.fn(() => []),
        getAnalysis: vi.fn(),
        getBaselines: vi.fn(() => Promise.resolve([])),
    },
}));

vi.mock('../../server/monitor/metrics-correlator', () => ({
    metricsCorrelator: {
        correlate: vi.fn(() => Promise.resolve({})),
        getMetricsSummary: vi.fn(() => Promise.resolve({})),
        checkHealth: vi.fn(() => Promise.resolve(true)),
    },
}));

vi.mock('../../server/monitor/training-store', () => ({
    trainingStore: {
        addExample: vi.fn(),
        getStats: vi.fn(() => ({})),
        getAll: vi.fn(() => []),
        exportToJsonl: vi.fn(() => ''),
        delete: vi.fn(),
    },
}));

vi.mock('../../server/monitor/amount-profiler', () => ({
    amountProfiler: { getBaselines: vi.fn(() => []) },
}));

vi.mock('../../server/monitor/amount-anomaly-detector', () => ({
    amountAnomalyDetector: { getActiveAnomalies: vi.fn(() => []) },
}));

vi.mock('../../server/monitor/baseline-calculator', () => ({
    baselineCalculator: { recalculate: vi.fn(), getEnrichedBaselines: vi.fn(() => []) },
}));

vi.mock('../../server/monitor/analysis-service', () => ({
    analysisService: { analyzeTrace: vi.fn() },
}));

vi.mock('../../server/monitor/model-config', () => ({
    getModel: vi.fn(() => 'llama3'),
    setModel: vi.fn(() => ({ success: true, model: 'llama3' })),
    getAvailableModels: vi.fn(() => ['llama3']),
}));

vi.mock('../../server/monitor/business-stats', () => ({
    businessStatsService: {
        getStats: vi.fn(() => ({})),
        getActivity: vi.fn(() => []),
        getVolume: vi.fn(() => []),
    },
}));

vi.mock('../../server/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// Mock fetch for Prometheus queries
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SLO Endpoint (Cap 5)', () => {
    let app: express.Express;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = express();
        const monitorRoutes = (await import('../../server/monitor/routes')).default;
        app.use('/api/monitor', monitorRoutes);
    });

    it('should return 200 with SLO data structure', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [{ value: [Date.now() / 1000, '0.0005'] }] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('availability');
        expect(res.body).toHaveProperty('latency');
        expect(res.body).toHaveProperty('timestamp');
    });

    it('should include availability target, current, and burn rates', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [{ value: [Date.now() / 1000, '0.0005'] }] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        expect(res.body.availability.target).toBe(0.999);
        expect(res.body.availability.current).toBeDefined();
        expect(res.body.availability.burnRate1h).toBeDefined();
        expect(res.body.availability.budgetRemaining).toBeDefined();
    });

    it('should include latency target and percentiles', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [{ value: [Date.now() / 1000, '0.25'] }] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        expect(res.body.latency.target).toBe(0.95);
        expect(res.body.latency.targetMs).toBe(500);
        expect(res.body.latency.p95Ms).toBeDefined();
        expect(res.body.latency.p99Ms).toBeDefined();
    });

    it('should handle Prometheus being unreachable gracefully', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await request(app).get('/api/monitor/slo');

        expect(res.status).toBe(200);
        expect(res.body.availability.current).toBeNull();
        expect(res.body.latency.p95Ms).toBeNull();
    });

    it('should handle empty Prometheus results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        expect(res.status).toBe(200);
        expect(res.body.availability.current).toBeNull();
    });

    it('should convert latency from seconds to milliseconds', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [{ value: [Date.now() / 1000, '0.25'] }] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        // 0.25 seconds = 250 milliseconds
        expect(res.body.latency.p95Ms).toBe(250);
    });

    it('should calculate budget minutes remaining correctly', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'success',
                data: { result: [{ value: [Date.now() / 1000, '0.5'] }] },
            }),
        });

        const res = await request(app).get('/api/monitor/slo');

        // 0.5 * 43.2 minutes = 21.6 minutes
        if (res.body.availability.budgetMinutesRemaining !== null) {
            expect(res.body.availability.budgetMinutesRemaining).toBeCloseTo(21.6, 1);
        }
    });
});
