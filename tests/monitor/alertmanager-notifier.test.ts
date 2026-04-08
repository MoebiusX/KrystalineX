/**
 * Alertmanager Notifier — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
    fireAnomalyAlert,
    enrichAlertWithAnalysis,
    resolveAnomalyAlert,
    getActiveAlertCount,
} from '../../server/monitor/alertmanager-notifier';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('fireAnomalyAlert', () => {
    it('sends a firing alert to Alertmanager for SEV1', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await fireAnomalyAlert({
            traceId: 'trace-123',
            service: 'krystalinex',
            operation: 'POST /api/orders',
            duration: 2500,
            expectedMean: 200,
            deviation: 15.3,
            severity: 1,
            severityName: 'Critical',
            timestamp: new Date('2024-01-15T10:00:00Z'),
        });

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/api/v2/alerts');
        expect(opts.method).toBe('POST');

        const body = JSON.parse(opts.body);
        expect(body).toHaveLength(1);
        expect(body[0].labels.alertname).toBe('AnomalyDetected');
        expect(body[0].labels.service).toBe('krystalinex');
        expect(body[0].labels.severity).toBe('critical');
        expect(body[0].labels.traceId).toBe('trace-123');
        expect(body[0].annotations.summary).toContain('2500ms');
        expect(body[0].annotations.summary).toContain('15.3σ');
    });

    it('ignores SEV4+ anomalies (only sends SEV1-3)', async () => {
        await fireAnomalyAlert({
            traceId: 'trace-456',
            service: 'svc',
            operation: 'op',
            duration: 100,
            expectedMean: 50,
            deviation: 3,
            severity: 4,
            severityName: 'Minor',
            timestamp: new Date(),
        });

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps SEV2 to warning severity', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await fireAnomalyAlert({
            traceId: 'trace-789',
            service: 'svc',
            operation: 'op',
            duration: 500,
            expectedMean: 100,
            deviation: 8,
            severity: 2,
            severityName: 'Major',
            timestamp: new Date(),
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body[0].labels.severity).toBe('warning');
    });

    it('handles Alertmanager connection failure gracefully', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        // Should not throw
        await fireAnomalyAlert({
            traceId: 'trace-err',
            service: 'svc',
            operation: 'op',
            duration: 1000,
            expectedMean: 100,
            deviation: 10,
            severity: 1,
            severityName: 'Critical',
            timestamp: new Date(),
        });
    });
});

describe('enrichAlertWithAnalysis', () => {
    it('updates an active alert with LLM analysis text', async () => {
        // First fire the alert
        mockFetch.mockResolvedValueOnce({ ok: true });
        await fireAnomalyAlert({
            traceId: 'trace-enrich',
            service: 'krystalinex',
            operation: 'GET /api/price',
            duration: 800,
            expectedMean: 100,
            deviation: 12,
            severity: 1,
            severityName: 'Critical',
            timestamp: new Date(),
        });

        // Then enrich with analysis
        mockFetch.mockResolvedValueOnce({ ok: true });
        await enrichAlertWithAnalysis(
            'krystalinex',
            'GET /api/price',
            'Root cause: Database connection pool exhausted. Action: Scale up PostgreSQL connections.',
        );

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const body = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(body[0].annotations.description).toContain('Database connection pool');
    });

    it('does nothing if no active alert exists for the service/operation', async () => {
        await enrichAlertWithAnalysis('unknown-service', 'unknown-op', 'some analysis');
        // No fetch call expected (only from the initial setup, not this enrichment)
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('resolveAnomalyAlert', () => {
    it('sends a resolved alert with endsAt set', async () => {
        // Fire first
        mockFetch.mockResolvedValueOnce({ ok: true });
        await fireAnomalyAlert({
            traceId: 'trace-resolve',
            service: 'payment',
            operation: 'POST /process',
            duration: 3000,
            expectedMean: 200,
            deviation: 18,
            severity: 1,
            severityName: 'Critical',
            timestamp: new Date(),
        });

        // Resolve
        mockFetch.mockResolvedValueOnce({ ok: true });
        await resolveAnomalyAlert('payment', 'POST /process');

        const body = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(body[0]).toHaveProperty('endsAt');
        expect(body[0].annotations.summary).toContain('Resolved');
    });
});

describe('getActiveAlertCount', () => {
    it('tracks active alerts', async () => {
        const initialCount = getActiveAlertCount();
        mockFetch.mockResolvedValueOnce({ ok: true });
        await fireAnomalyAlert({
            traceId: 'trace-count',
            service: 'counter-svc',
            operation: 'op',
            duration: 1000,
            expectedMean: 100,
            deviation: 10,
            severity: 3,
            severityName: 'Warning',
            timestamp: new Date(),
        });
        expect(getActiveAlertCount()).toBeGreaterThanOrEqual(initialCount + 1);
    });
});
