/**
 * Cap 14: Self-Healing & Auto-Remediation Tests (TDD)
 *
 * Tests for:
 * - Alertmanager webhook handler for automated remediation
 * - Kill switch (AUTO_REMEDIATION_ENABLED env var)
 * - Safe action execution and audit logging
 * - Individual action enable/disable flags
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock logger
const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
};

vi.mock('../../server/lib/logger', () => ({
    createLogger: vi.fn(() => mockLogger),
}));

describe('Cap 14: Self-Healing & Auto-Remediation', () => {
    let app: express.Express;
    let remediationRouter: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();
        process.env.AUTO_REMEDIATION_ENABLED = 'true';

        const mod = await import('../../server/monitor/auto-remediation');
        remediationRouter = mod.default;

        app = express();
        app.use(express.json());
        app.use('/api/v1/monitor', remediationRouter);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.AUTO_REMEDIATION_ENABLED;
    });

    describe('POST /api/v1/monitor/webhook/remediation', () => {
        const alertPayload = (alertname: string, status = 'firing') => ({
            alerts: [{
                status,
                labels: { alertname, severity: 'critical', service: 'kx-exchange' },
                annotations: { summary: 'Test alert' },
                startsAt: new Date().toISOString(),
            }],
        });

        it('should process a known alert and execute remediation', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('HighMemoryUsage'));

            expect(res.status).toBe(200);
            expect(res.body.processed).toBe(1);
            expect(res.body.actions).toHaveLength(1);
            expect(res.body.actions[0].alertname).toBe('HighMemoryUsage');
            expect(res.body.actions[0].status).toBe('executed');
        });

        it('should skip when AUTO_REMEDIATION_ENABLED is not true', async () => {
            process.env.AUTO_REMEDIATION_ENABLED = 'false';

            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('HighMemoryUsage'));

            expect(res.status).toBe(200);
            expect(res.body.skipped).toBe(true);
        });

        it('should skip unknown alert types gracefully', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('SomeUnknownAlert'));

            expect(res.status).toBe(200);
            expect(res.body.processed).toBe(1);
            expect(res.body.actions).toHaveLength(1);
            expect(res.body.actions[0].status).toBe('no_action');
        });

        it('should skip resolved alerts (only act on firing)', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('HighMemoryUsage', 'resolved'));

            expect(res.status).toBe(200);
            expect(res.body.actions[0].status).toBe('skipped_resolved');
        });

        it('should handle multiple alerts in a single webhook', async () => {
            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send({
                    alerts: [
                        {
                            status: 'firing',
                            labels: { alertname: 'HighMemoryUsage', severity: 'warning' },
                            annotations: {},
                            startsAt: new Date().toISOString(),
                        },
                        {
                            status: 'firing',
                            labels: { alertname: 'UnknownAlert', severity: 'info' },
                            annotations: {},
                            startsAt: new Date().toISOString(),
                        },
                    ],
                });

            expect(res.status).toBe(200);
            expect(res.body.processed).toBe(2);
            expect(res.body.actions).toHaveLength(2);
        });

        it('should handle action execution failure gracefully', async () => {
            // Send a known action that we can test error handling for
            const res = await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('DatabaseConnectionsHigh'));

            // Should still return 200 even if the action fails internally
            expect(res.status).toBe(200);
            expect(res.body.processed).toBe(1);
        });

        it('should log all remediation actions', async () => {
            await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send(alertPayload('HighMemoryUsage'));

            expect(mockLogger.info).toHaveBeenCalled();
        });
    });

    describe('GET /api/v1/monitor/remediation/history', () => {
        it('should return remediation action history', async () => {
            // First execute a remediation
            await request(app)
                .post('/api/v1/monitor/webhook/remediation')
                .send({
                    alerts: [{
                        status: 'firing',
                        labels: { alertname: 'HighMemoryUsage', severity: 'critical' },
                        annotations: { summary: 'Memory alert' },
                        startsAt: new Date().toISOString(),
                    }],
                });

            const res = await request(app)
                .get('/api/v1/monitor/remediation/history');

            expect(res.status).toBe(200);
            expect(res.body.actions).toBeInstanceOf(Array);
            expect(res.body.actions.length).toBeGreaterThan(0);
            expect(res.body.actions[0]).toHaveProperty('alertname');
            expect(res.body.actions[0]).toHaveProperty('timestamp');
        });
    });

    describe('GET /api/v1/monitor/remediation/actions', () => {
        it('should list all available remediation actions', async () => {
            const res = await request(app)
                .get('/api/v1/monitor/remediation/actions');

            expect(res.status).toBe(200);
            expect(res.body.actions).toBeInstanceOf(Array);
            expect(res.body.actions.length).toBeGreaterThan(0);
            expect(res.body.actions[0]).toHaveProperty('alertname');
            expect(res.body.actions[0]).toHaveProperty('description');
            expect(res.body.enabled).toBe(true);
        });
    });
});
