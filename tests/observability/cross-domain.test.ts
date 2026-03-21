/**
 * Cap 13: Cross-Domain Correlation Tests (TDD)
 *
 * Tests for:
 * - POST /api/v1/monitor/events — deployment event recording
 * - GET /api/v1/monitor/events — deployment event querying
 * - Deployment-anomaly correlation in metrics-correlator
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

describe('Cap 13: Cross-Domain Correlation', () => {
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

    describe('POST /api/v1/monitor/events', () => {
        it('should record a deployment event', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/events')
                .send({
                    type: 'deployment',
                    version: '2.3.0',
                    commit: 'abc123',
                    deployer: 'ci-bot',
                    environment: 'production',
                });

            expect(res.status).toBe(201);
            expect(res.body.id).toBeDefined();
            expect(res.body.type).toBe('deployment');
        });

        it('should return 400 when required fields are missing', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/events')
                .send({ type: 'deployment' }); // missing version

            expect(res.status).toBe(400);
            expect(res.body.error).toBeDefined();
        });

        it('should accept non-deployment event types', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/events')
                .send({
                    type: 'config_change',
                    description: 'Updated rate limits',
                    deployer: 'admin',
                });

            expect(res.status).toBe(201);
            expect(res.body.type).toBe('config_change');
        });
    });

    describe('GET /api/v1/monitor/events', () => {
        it('should return recent deployment events', async () => {
            // First, record an event
            await request(app)
                .post('/api/v1/monitor/events')
                .send({
                    type: 'deployment',
                    version: '2.3.1',
                    commit: 'def456',
                    deployer: 'ci-bot',
                });

            const res = await request(app)
                .get('/api/v1/monitor/events');

            expect(res.status).toBe(200);
            expect(res.body.events).toBeInstanceOf(Array);
            expect(res.body.events.length).toBeGreaterThan(0);
        });

        it('should filter events by type', async () => {
            await request(app)
                .post('/api/v1/monitor/events')
                .send({ type: 'deployment', version: '1.0.0', commit: 'aaa', deployer: 'bot' });
            await request(app)
                .post('/api/v1/monitor/events')
                .send({ type: 'config_change', description: 'test', deployer: 'admin' });

            const res = await request(app)
                .get('/api/v1/monitor/events')
                .query({ type: 'deployment' });

            expect(res.status).toBe(200);
            expect(res.body.events.every((e: any) => e.type === 'deployment')).toBe(true);
        });
    });

    describe('Deployment-anomaly correlation', () => {
        it('should find events near a given timestamp', async () => {
            // Record a deployment
            const deployRes = await request(app)
                .post('/api/v1/monitor/events')
                .send({
                    type: 'deployment',
                    version: '3.0.0',
                    commit: 'xyz789',
                    deployer: 'ci',
                });

            const deployTime = new Date(deployRes.body.timestamp).getTime();

            // Query events near that timestamp (±10 min)
            const res = await request(app)
                .get('/api/v1/monitor/events')
                .query({
                    near: String(deployTime),
                    window: '600000', // 10 min in ms
                });

            expect(res.status).toBe(200);
            expect(res.body.events.length).toBeGreaterThan(0);
        });
    });
});
