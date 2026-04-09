/**
 * Monitor Routes Tests
 * 
 * Tests for the monitoring API endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock all dependencies
vi.mock('../../server/monitor/trace-profiler', () => ({
    traceProfiler: {
        getBaselines: vi.fn(() => [
            { service: 'kx-wallet', operation: 'transfer', mean: 100, stdDev: 20, sampleCount: 500 }
        ])
    }
}));

vi.mock('../../server/monitor/anomaly-detector', () => ({
    anomalyDetector: {
        getServiceHealth: vi.fn(() => [
            { service: 'kx-wallet', status: 'healthy', anomalyCount: 0 }
        ]),
        getActiveAnomalies: vi.fn(() => [])
    }
}));

vi.mock('../../server/monitor/history-store', () => ({
    historyStore: {
        getAnomalyHistory: vi.fn(() => []),
        getHourlyTrend: vi.fn(() => []),
        getAnalysis: vi.fn(() => undefined),
        getBaselines: vi.fn(() => Promise.resolve([
            { service: 'kx-wallet', operation: 'transfer', mean: 100, stdDev: 20, sampleCount: 500 }
        ]))
    }
}));

vi.mock('../../server/monitor/metrics-correlator', () => ({
    metricsCorrelator: {
        correlate: vi.fn(() => Promise.resolve({
            anomalyId: 'test',
            service: 'kx-wallet',
            metrics: {},
            insights: [],
            healthy: true
        })),
        getMetricsSummary: vi.fn(() => Promise.resolve({ services: [] })),
        checkHealth: vi.fn(() => Promise.resolve(true))
    }
}));

vi.mock('../../server/monitor/training-store', () => ({
    trainingStore: {
        addExample: vi.fn((ex) => ({ id: 'train_1', timestamp: new Date().toISOString(), ...ex })),
        getStats: vi.fn(() => ({ totalExamples: 10, goodExamples: 8, badExamples: 2 })),
        getAll: vi.fn(() => []),
        exportToJsonl: vi.fn(() => ''),
        delete: vi.fn(() => true)
    }
}));

vi.mock('../../server/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }))
}));

// Mock analysis-service and baseline-calculator for dynamic imports
vi.mock('../../server/monitor/analysis-service', () => ({
    analysisService: {
        analyzeAnomaly: vi.fn(() => Promise.resolve({
            traceId: 'test',
            summary: 'Test analysis',
            possibleCauses: [],
            recommendations: [],
            confidence: 'medium',
            analyzedAt: new Date()
        }))
    }
}));

vi.mock('../../server/monitor/baseline-calculator', () => ({
    baselineCalculator: {
        recalculate: vi.fn(() => Promise.resolve({
            success: true,
            baselinesCount: 100,
            duration: 5000,
            message: 'Recalculation complete'
        })),
        getAllBaselines: vi.fn(() => []),
        getStatus: vi.fn(() => ({
            isCalculating: false,
            lastCalculation: null,
            baselineCount: 0
        }))
    }
}));

// Mock fetch for trace routes
global.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
    status: 200
})) as any;

import monitorRoutes from '../../server/monitor/routes';
import { anomalyDetector } from '../../server/monitor/anomaly-detector';
import { traceProfiler } from '../../server/monitor/trace-profiler';
import { historyStore } from '../../server/monitor/history-store';
import { metricsCorrelator } from '../../server/monitor/metrics-correlator';
import { trainingStore } from '../../server/monitor/training-store';

describe('Monitor Routes', () => {
    let app: express.Express;

    beforeEach(() => {
        vi.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/monitor', monitorRoutes);
    });

    // ============================================
    // Health Endpoint
    // ============================================
    describe('GET /api/monitor/health', () => {
        it('should return health status', async () => {
            const response = await request(app).get('/api/monitor/health');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('status');
            expect(response.body).toHaveProperty('services');
        });

        it('should return healthy status when no critical services', async () => {
            (anomalyDetector.getServiceHealth as any).mockReturnValue([
                { service: 'kx-wallet', status: 'healthy' }
            ]);

            const response = await request(app).get('/api/monitor/health');

            expect(response.body.status).toBe('healthy');
        });

        it('should return critical status when service is critical', async () => {
            (anomalyDetector.getServiceHealth as any).mockReturnValue([
                { service: 'kx-wallet', status: 'critical' }
            ]);

            const response = await request(app).get('/api/monitor/health');

            expect(response.body.status).toBe('critical');
        });

        it('should return warning status when service is warning', async () => {
            (anomalyDetector.getServiceHealth as any).mockReturnValue([
                { service: 'kx-wallet', status: 'warning' }
            ]);

            const response = await request(app).get('/api/monitor/health');

            expect(response.body.status).toBe('warning');
        });
    });

    // ============================================
    // Baselines Endpoint
    // ============================================
    describe('GET /api/monitor/baselines', () => {
        it('should return baselines', async () => {
            const response = await request(app).get('/api/monitor/baselines');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('baselines');
            expect(response.body).toHaveProperty('spanCount');
        });

        it('should sort baselines by sample count', async () => {
            (traceProfiler.getBaselines as any).mockReturnValue([
                { service: 'svc1', sampleCount: 100 },
                { service: 'svc2', sampleCount: 500 },
                { service: 'svc3', sampleCount: 250 }
            ]);

            const response = await request(app).get('/api/monitor/baselines');

            expect(response.body.baselines[0].sampleCount).toBe(500);
        });
    });

    // ============================================
    // Anomalies Endpoint
    // ============================================
    describe('GET /api/monitor/anomalies', () => {
        it('should return active anomalies', async () => {
            const response = await request(app).get('/api/monitor/anomalies');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('active');
            expect(response.body).toHaveProperty('recentCount');
        });
    });

    // ============================================
    // History Endpoint
    // ============================================
    describe('GET /api/monitor/history', () => {
        it('should return anomaly history', async () => {
            const response = await request(app).get('/api/monitor/history');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('anomalies');
            expect(response.body).toHaveProperty('hourlyTrend');
            expect(response.body).toHaveProperty('totalCount');
        });

        it('should accept hours query parameter', async () => {
            await request(app).get('/api/monitor/history?hours=48');

            expect(historyStore.getAnomalyHistory).toHaveBeenCalledWith(
                expect.objectContaining({ hours: 48 })
            );
        });

        it('should accept service query parameter', async () => {
            await request(app).get('/api/monitor/history?service=kx-wallet');

            expect(historyStore.getAnomalyHistory).toHaveBeenCalledWith(
                expect.objectContaining({ service: 'kx-wallet' })
            );
        });
    });

    // ============================================
    // Analyze Endpoint
    // ============================================
    describe('POST /api/monitor/analyze', () => {
        it('should return 400 without traceId', async () => {
            const response = await request(app)
                .post('/api/monitor/analyze')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body.error).toContain('traceId');
        });

        it('should return cached analysis if available', async () => {
            (historyStore.getAnalysis as any).mockReturnValue({
                traceId: 'cached',
                summary: 'Cached analysis'
            });

            const response = await request(app)
                .post('/api/monitor/analyze')
                .send({ traceId: 'test-trace' });

            expect(response.status).toBe(200);
            expect(response.body.summary).toBe('Cached analysis');
        });

        it('should analyze new trace', async () => {
            (historyStore.getAnalysis as any).mockReturnValue(undefined);

            const response = await request(app)
                .post('/api/monitor/analyze')
                .send({ traceId: 'new-trace' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('processing');
            expect(response.body.traceId).toBe('new-trace');
        });
    });

    // ============================================
    // Trace Endpoint
    // ============================================
    describe('GET /api/monitor/trace/:traceId', () => {
        it('should fetch trace from Jaeger', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: [{ traceID: 'test' }] })
            });

            const response = await request(app).get('/api/monitor/trace/test-trace-id');

            expect(response.status).toBe(200);
        });

        it('should return 404 for non-existent trace', async () => {
            (global.fetch as any).mockResolvedValue({
                ok: false,
                status: 404
            });

            const response = await request(app).get('/api/monitor/trace/nonexistent');

            expect(response.status).toBe(404);
        });

        it('should handle fetch errors', async () => {
            (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

            const response = await request(app).get('/api/monitor/trace/error-trace');

            expect(response.status).toBe(500);
        });
    });

    // ============================================
    // Recalculate Endpoint
    // ============================================
    describe('POST /api/monitor/recalculate', () => {
        it('should trigger baseline recalculation', async () => {
            const response = await request(app).post('/api/monitor/recalculate');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('success');
        });
    });

    // ============================================
    // Time Baselines Endpoint
    // ============================================
    describe('GET /api/monitor/time-baselines', () => {
        it('should return time-aware baselines', async () => {
            const response = await request(app).get('/api/monitor/time-baselines');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('baselines');
            expect(response.body).toHaveProperty('count');
        });
    });

    // ============================================
    // Correlate Endpoint
    // ============================================
    describe('POST /api/monitor/correlate', () => {
        it('should return 400 without required fields', async () => {
            const response = await request(app)
                .post('/api/monitor/correlate')
                .send({});

            expect(response.status).toBe(400);
        });

        it('should return correlated metrics', async () => {
            const response = await request(app)
                .post('/api/monitor/correlate')
                .send({
                    anomalyId: 'anom-1',
                    service: 'kx-wallet',
                    timestamp: new Date().toISOString()
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('service');
        });

        it('should handle correlation errors', async () => {
            (metricsCorrelator.correlate as any).mockRejectedValue(new Error('Prometheus down'));

            const response = await request(app)
                .post('/api/monitor/correlate')
                .send({
                    service: 'kx-wallet',
                    timestamp: new Date().toISOString()
                });

            expect(response.status).toBe(500);
        });
    });

    // ============================================
    // Metrics Summary Endpoint
    // ============================================
    describe('GET /api/monitor/metrics/summary', () => {
        it('should return metrics summary', async () => {
            const response = await request(app).get('/api/monitor/metrics/summary');

            expect(response.status).toBe(200);
        });

        it('should handle errors', async () => {
            (metricsCorrelator.getMetricsSummary as any).mockRejectedValue(new Error('Failed'));

            const response = await request(app).get('/api/monitor/metrics/summary');

            expect(response.status).toBe(500);
        });
    });

    // ============================================
    // Metrics Health Endpoint
    // ============================================
    describe('GET /api/monitor/metrics/health', () => {
        it('should return healthy when Prometheus is up', async () => {
            (metricsCorrelator.checkHealth as any).mockResolvedValue(true);

            const response = await request(app).get('/api/monitor/metrics/health');

            expect(response.status).toBe(200);
            expect(response.body.prometheus).toBe('healthy');
        });

        it('should return unreachable when Prometheus is down', async () => {
            (metricsCorrelator.checkHealth as any).mockResolvedValue(false);

            const response = await request(app).get('/api/monitor/metrics/health');

            expect(response.body.prometheus).toBe('unreachable');
        });
    });

    // ============================================
    // Training: Rate Endpoint
    // ============================================
    describe('POST /api/monitor/training/rate', () => {
        it('should return 400 for missing fields', async () => {
            const response = await request(app)
                .post('/api/monitor/training/rate')
                .send({});

            expect(response.status).toBe(400);
        });

        it('should return 400 for invalid rating', async () => {
            const response = await request(app)
                .post('/api/monitor/training/rate')
                .send({
                    anomaly: { id: '1' },
                    prompt: 'test',
                    completion: 'test',
                    rating: 'invalid'
                });

            expect(response.status).toBe(400);
        });

        it('should add training example', async () => {
            const response = await request(app)
                .post('/api/monitor/training/rate')
                .send({
                    anomaly: { id: '1', service: 'svc' },
                    prompt: 'Analyze...',
                    completion: 'Analysis...',
                    rating: 'good'
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.example).toBeDefined();
        });
    });

    // ============================================
    // Training: Stats Endpoint
    // ============================================
    describe('GET /api/monitor/training/stats', () => {
        it('should return training stats', async () => {
            const response = await request(app).get('/api/monitor/training/stats');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('totalExamples');
        });
    });

    // ============================================
    // Training: Examples Endpoint
    // ============================================
    describe('GET /api/monitor/training/examples', () => {
        it('should return all examples', async () => {
            const response = await request(app).get('/api/monitor/training/examples');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('examples');
        });
    });

    // ============================================
    // Training: Export Endpoint
    // ============================================
    describe('GET /api/monitor/training/export', () => {
        it('should export as JSONL', async () => {
            const response = await request(app).get('/api/monitor/training/export');

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('jsonl');
        });
    });

    // ============================================
    // Training: Delete Endpoint
    // ============================================
    describe('DELETE /api/monitor/training/:id', () => {
        it('should delete example', async () => {
            const response = await request(app).delete('/api/monitor/training/train_1');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });
    });
});
