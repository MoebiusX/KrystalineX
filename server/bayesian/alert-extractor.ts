/**
 * Alert Extractor — Pull alerts from Alertmanager, enrich with trace IDs, and cluster into incidents.
 *
 * Data sources:
 *   1. Alertmanager API (/api/v2/alerts) — Prometheus-based alerts
 *   2. Internal anomaly detector — trace-based anomalies (converted to alert format)
 *
 * Enrichment:
 *   For alerts based on metrics with exemplars (e.g. http_request_duration_seconds),
 *   queries Prometheus exemplars API to attach the traceId of the request that
 *   triggered the alert. This closes the loop: alert → exemplar → trace → root cause.
 *
 * Clustering:
 *   Alerts that fire within a configurable time window (default 5 min)
 *   are grouped into a single "incident." Each incident is a candidate
 *   for root cause analysis.
 */

import { createLogger } from '../lib/logger';
import type { AlertRecord, AlertIncident } from './types';

const logger = createLogger('alert-extractor');

const ALERTMANAGER_URL = process.env.ALERTMANAGER_URL || 'http://localhost:9093';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const CLUSTER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── Alertmanager Types ─────────────────────────────────────────────────────

interface AlertmanagerAlert {
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    fingerprint: string;
    status: { state: string };
}

// Map alert names → base metric selectors that carry exemplars.
// Only metrics with enableExemplars: true are worth querying.
const ALERT_TO_EXEMPLAR_METRIC: Record<string, string> = {
    HighLatencyP99: 'http_request_duration_seconds_bucket',
    HighLatencyP99Critical: 'http_request_duration_seconds_bucket',
    HighErrorRate: 'http_request_duration_seconds_bucket',
    OrderProcessingFailures: 'order_processing_duration_seconds_bucket',
};

// ─── Prometheus Exemplars API ───────────────────────────────────────────────

interface PrometheusExemplar {
    seriesLabels: Record<string, string>;
    exemplars: Array<{
        labels: Record<string, string>;
        value: string;
        timestamp: number;
    }>;
}

/**
 * Query Prometheus exemplars API for a metric around a specific time.
 * Returns the traceId from the nearest exemplar, or null.
 */
async function queryExemplarTraceId(
    metricSelector: string,
    aroundEpochSec: number,
    windowSec: number = 300,
): Promise<string | null> {
    const start = new Date((aroundEpochSec - windowSec) * 1000).toISOString();
    const end = new Date((aroundEpochSec + windowSec) * 1000).toISOString();

    const url = `${PROMETHEUS_URL}/api/v1/query_exemplars?query=${encodeURIComponent(metricSelector)}&start=${start}&end=${end}`;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!response.ok) return null;

        const body = await response.json() as { status: string; data: PrometheusExemplar[] };
        if (body.status !== 'success' || !body.data?.length) return null;

        // Find the exemplar closest to the alert's firing time
        let bestTraceId: string | null = null;
        let bestDist = Infinity;

        for (const series of body.data) {
            for (const ex of series.exemplars) {
                const traceId = ex.labels.traceID || ex.labels.trace_id;
                if (!traceId) continue;

                const dist = Math.abs(ex.timestamp - aroundEpochSec);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestTraceId = traceId;
                }
            }
        }

        return bestTraceId;
    } catch {
        return null;
    }
}

// ─── Fetch from Alertmanager ────────────────────────────────────────────────

/**
 * Fetch current and recent alerts from Alertmanager API.
 */
export async function fetchAlertmanagerAlerts(): Promise<AlertRecord[]> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(`${ALERTMANAGER_URL}/api/v2/alerts`, {
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            logger.warn({ status: response.status }, 'Alertmanager returned non-OK');
            return [];
        }

        const raw: AlertmanagerAlert[] = await response.json() as AlertmanagerAlert[];

        return raw.map((a): AlertRecord => ({
            alertname: a.labels.alertname || 'unknown',
            service: a.labels.service || a.labels.job || a.labels.instance || '',
            severity: a.labels.severity || 'warning',
            fired_at: new Date(a.startsAt).getTime() / 1000,
            resolved_at: a.endsAt && a.endsAt !== '0001-01-01T00:00:00Z'
                ? new Date(a.endsAt).getTime() / 1000
                : null,
            labels: a.labels,
            fingerprint: a.fingerprint,
            trace_id: null,  // Will be enriched by enrichAlertsWithExemplars()
        }));
    } catch (err) {
        logger.debug({ err }, 'Could not reach Alertmanager');
        return [];
    }
}

// ─── Exemplar Enrichment ────────────────────────────────────────────────────

/**
 * Enrich alerts with trace IDs from Prometheus exemplars.
 *
 * For each alert whose metric supports exemplars, queries the Prometheus
 * exemplars API around the alert's firing time to find the traceId of
 * the request that actually triggered the alert.
 */
export async function enrichAlertsWithExemplars(
    alerts: AlertRecord[],
): Promise<AlertRecord[]> {
    const enrichmentPromises = alerts.map(async (alert) => {
        // Skip if already has a traceId (e.g., from internal anomaly detector)
        if (alert.trace_id) return alert;

        const metricSelector = ALERT_TO_EXEMPLAR_METRIC[alert.alertname];
        if (!metricSelector) return alert;

        const traceId = await queryExemplarTraceId(metricSelector, alert.fired_at);
        if (traceId) {
            logger.debug(
                { alertname: alert.alertname, traceId },
                'Enriched alert with exemplar traceId',
            );
            return { ...alert, trace_id: traceId };
        }

        return alert;
    });

    return Promise.all(enrichmentPromises);
}

// ─── Clustering ─────────────────────────────────────────────────────────────

/**
 * Cluster alerts into incidents by time proximity.
 *
 * Algorithm:
 *   1. Sort alerts by fired_at
 *   2. Walk sequentially — if the gap between consecutive alerts exceeds
 *      the cluster window, start a new incident
 *   3. Return list of incidents
 */
export function clusterAlertsIntoIncidents(
    alerts: AlertRecord[],
    windowMs: number = CLUSTER_WINDOW_MS,
): AlertIncident[] {
    if (alerts.length === 0) return [];

    const sorted = [...alerts].sort((a, b) => a.fired_at - b.fired_at);
    const windowSec = windowMs / 1000;

    const incidents: AlertIncident[] = [];
    let currentAlerts: AlertRecord[] = [sorted[0]];
    let clusterStart = sorted[0].fired_at;

    for (let i = 1; i < sorted.length; i++) {
        const alert = sorted[i];
        if (alert.fired_at - clusterStart <= windowSec) {
            currentAlerts.push(alert);
        } else {
            incidents.push(buildIncident(currentAlerts, incidents.length));
            currentAlerts = [alert];
            clusterStart = alert.fired_at;
        }
    }

    // Flush last cluster
    if (currentAlerts.length > 0) {
        incidents.push(buildIncident(currentAlerts, incidents.length));
    }

    return incidents;
}

function buildIncident(alerts: AlertRecord[], index: number): AlertIncident {
    const sorted = [...alerts].sort((a, b) => a.fired_at - b.fired_at);
    return {
        id: `incident-${Date.now()}-${index}`,
        alerts: sorted,
        root_cause_alert: null,  // No label — model will use temporal ordering
        started_at: sorted[0].fired_at,
        ended_at: sorted[sorted.length - 1].fired_at,
    };
}

// ─── Full Pipeline ──────────────────────────────────────────────────────────

/**
 * Pull alerts from Alertmanager, enrich with exemplar trace IDs,
 * and cluster into incidents.
 */
export async function extractAlertIncidents(): Promise<AlertIncident[]> {
    let alerts = await fetchAlertmanagerAlerts();
    if (alerts.length === 0) {
        logger.debug('No alerts from Alertmanager');
        return [];
    }

    // Enrich with trace IDs from Prometheus exemplars
    alerts = await enrichAlertsWithExemplars(alerts);

    const enrichedCount = alerts.filter(a => a.trace_id).length;
    const incidents = clusterAlertsIntoIncidents(alerts);

    logger.info(
        { alertCount: alerts.length, enrichedWithTraceId: enrichedCount, incidentCount: incidents.length },
        'Extracted alert incidents',
    );
    return incidents;
}

/**
 * Get currently-firing alerts (for inference), enriched with trace IDs.
 */
export async function getCurrentlyFiringAlerts(): Promise<AlertRecord[]> {
    let allAlerts = await fetchAlertmanagerAlerts();
    const firing = allAlerts.filter(a => a.resolved_at === null);

    // Enrich firing alerts with exemplar trace IDs
    return enrichAlertsWithExemplars(firing);
}
