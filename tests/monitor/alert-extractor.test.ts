/**
 * Alert Extractor — Unit Tests
 *
 * Tests alert clustering, exemplar enrichment, and end-to-end pipeline.
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

// Must mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
    clusterAlertsIntoIncidents,
    enrichAlertsWithExemplars,
    fetchAlertmanagerAlerts,
    getCurrentlyFiringAlerts,
    extractAlertIncidents,
} from '../../server/bayesian/alert-extractor';
import type { AlertRecord } from '../../server/bayesian/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
    return {
        alertname: 'HighLatencyP99',
        service: 'krystalinex',
        severity: 'warning',
        fired_at: 1700000000,
        resolved_at: null,
        labels: { alertname: 'HighLatencyP99', service: 'krystalinex' },
        fingerprint: 'abc123',
        trace_id: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── Clustering ─────────────────────────────────────────────────────────────

describe('clusterAlertsIntoIncidents', () => {
    it('returns empty for no alerts', () => {
        expect(clusterAlertsIntoIncidents([])).toEqual([]);
    });

    it('clusters alerts within the same time window', () => {
        const alerts = [
            makeAlert({ alertname: 'A', fired_at: 1000 }),
            makeAlert({ alertname: 'B', fired_at: 1060 }),   // +60s
            makeAlert({ alertname: 'C', fired_at: 1200 }),   // +200s
        ];
        const incidents = clusterAlertsIntoIncidents(alerts, 5 * 60 * 1000);
        expect(incidents).toHaveLength(1);
        expect(incidents[0].alerts).toHaveLength(3);
    });

    it('creates separate incidents for alerts beyond window', () => {
        const alerts = [
            makeAlert({ alertname: 'A', fired_at: 1000 }),
            makeAlert({ alertname: 'B', fired_at: 1060 }),
            makeAlert({ alertname: 'C', fired_at: 2000 }),   // 1000s gap > 300s window
        ];
        const incidents = clusterAlertsIntoIncidents(alerts, 5 * 60 * 1000);
        expect(incidents).toHaveLength(2);
        expect(incidents[0].alerts).toHaveLength(2);
        expect(incidents[1].alerts).toHaveLength(1);
    });

    it('sorts alerts by fired_at within each incident', () => {
        const alerts = [
            makeAlert({ alertname: 'C', fired_at: 1200 }),
            makeAlert({ alertname: 'A', fired_at: 1000 }),
            makeAlert({ alertname: 'B', fired_at: 1100 }),
        ];
        const incidents = clusterAlertsIntoIncidents(alerts, 5 * 60 * 1000);
        expect(incidents[0].alerts[0].alertname).toBe('A');
        expect(incidents[0].alerts[1].alertname).toBe('B');
        expect(incidents[0].alerts[2].alertname).toBe('C');
    });

    it('sets started_at and ended_at from first/last alert', () => {
        const alerts = [
            makeAlert({ alertname: 'A', fired_at: 1000 }),
            makeAlert({ alertname: 'B', fired_at: 1200 }),
        ];
        const incidents = clusterAlertsIntoIncidents(alerts, 5 * 60 * 1000);
        expect(incidents[0].started_at).toBe(1000);
        expect(incidents[0].ended_at).toBe(1200);
    });

    it('defaults root_cause_alert to null', () => {
        const alerts = [makeAlert({ alertname: 'A', fired_at: 1000 })];
        const incidents = clusterAlertsIntoIncidents(alerts, 5 * 60 * 1000);
        expect(incidents[0].root_cause_alert).toBeNull();
    });
});

// ─── Exemplar Enrichment ────────────────────────────────────────────────────

describe('enrichAlertsWithExemplars', () => {
    it('skips alerts that already have trace_id', async () => {
        const alerts = [makeAlert({ trace_id: 'existing-trace-id' })];
        const result = await enrichAlertsWithExemplars(alerts);
        expect(result[0].trace_id).toBe('existing-trace-id');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips alerts without exemplar-capable metrics', async () => {
        const alerts = [makeAlert({ alertname: 'SomeUnknownAlert' })];
        const result = await enrichAlertsWithExemplars(alerts);
        expect(result[0].trace_id).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('enriches HighLatencyP99 alert with exemplar traceId', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                status: 'success',
                data: [{
                    seriesLabels: { __name__: 'http_request_duration_seconds_bucket' },
                    exemplars: [{
                        labels: { traceID: 'abc-trace-123' },
                        value: '0.5',
                        timestamp: 1700000002,
                    }],
                }],
            }),
        });

        const alerts = [makeAlert({ alertname: 'HighLatencyP99', fired_at: 1700000000 })];
        const result = await enrichAlertsWithExemplars(alerts);
        expect(result[0].trace_id).toBe('abc-trace-123');
    });

    it('picks the closest exemplar to alert firing time', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                status: 'success',
                data: [{
                    seriesLabels: {},
                    exemplars: [
                        { labels: { traceID: 'far-away' }, value: '0.1', timestamp: 1699999000 },
                        { labels: { traceID: 'closest-one' }, value: '0.5', timestamp: 1700000001 },
                        { labels: { traceID: 'also-far' }, value: '0.3', timestamp: 1700000500 },
                    ],
                }],
            }),
        });

        const alerts = [makeAlert({ fired_at: 1700000000 })];
        const result = await enrichAlertsWithExemplars(alerts);
        expect(result[0].trace_id).toBe('closest-one');
    });

    it('handles Prometheus API failure gracefully', async () => {
        mockFetch.mockRejectedValueOnce(new Error('connection refused'));

        const alerts = [makeAlert({ alertname: 'HighLatencyP99', fired_at: 1700000000 })];
        const result = await enrichAlertsWithExemplars(alerts);
        expect(result[0].trace_id).toBeNull();
    });
});

// ─── Alertmanager Fetch ─────────────────────────────────────────────────────

describe('fetchAlertmanagerAlerts', () => {
    it('converts Alertmanager response to AlertRecord array', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ([
                {
                    labels: { alertname: 'HighErrorRate', service: 'krystalinex', severity: 'critical' },
                    annotations: { summary: 'High error rate' },
                    startsAt: '2024-01-15T10:00:00Z',
                    endsAt: '0001-01-01T00:00:00Z',
                    fingerprint: 'fp1',
                    status: { state: 'active' },
                },
            ]),
        });

        const alerts = await fetchAlertmanagerAlerts();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].alertname).toBe('HighErrorRate');
        expect(alerts[0].service).toBe('krystalinex');
        expect(alerts[0].severity).toBe('critical');
        expect(alerts[0].resolved_at).toBeNull();
        expect(alerts[0].trace_id).toBeNull();
    });

    it('returns empty on Alertmanager failure', async () => {
        mockFetch.mockRejectedValueOnce(new Error('network error'));
        const alerts = await fetchAlertmanagerAlerts();
        expect(alerts).toEqual([]);
    });

    it('returns empty on non-OK response', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
        const alerts = await fetchAlertmanagerAlerts();
        expect(alerts).toEqual([]);
    });
});

// ─── Currently Firing Alerts ────────────────────────────────────────────────

describe('getCurrentlyFiringAlerts', () => {
    it('filters to only unresolved alerts', async () => {
        // First call: Alertmanager fetch
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ([
                {
                    labels: { alertname: 'Active', service: 'svc', severity: 'warning' },
                    annotations: {},
                    startsAt: '2024-01-15T10:00:00Z',
                    endsAt: '0001-01-01T00:00:00Z',
                    fingerprint: 'fp1',
                    status: { state: 'active' },
                },
                {
                    labels: { alertname: 'Resolved', service: 'svc', severity: 'warning' },
                    annotations: {},
                    startsAt: '2024-01-15T09:00:00Z',
                    endsAt: '2024-01-15T10:00:00Z',
                    fingerprint: 'fp2',
                    status: { state: 'resolved' },
                },
            ]),
        });

        const firing = await getCurrentlyFiringAlerts();
        expect(firing).toHaveLength(1);
        expect(firing[0].alertname).toBe('Active');
    });
});
