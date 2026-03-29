/**
 * Alertmanager Notifier — Sends anomaly detection results as alerts to Alertmanager.
 *
 * When the anomaly detector finds SEV1-3 anomalies and the LLM stream analyzer
 * produces an analysis, this module posts firing alerts to Alertmanager's v2 API.
 * This means anomaly-based alerts appear alongside Prometheus-based alerts,
 * enabling the Bayesian RCA service to correlate them all.
 *
 * Alert lifecycle:
 *   - Anomaly detected → POST firing alert to Alertmanager
 *   - Analysis complete → update alert annotations with LLM analysis text
 *   - Anomaly resolves (5min window) → POST resolved alert
 */

import { createLogger } from '../lib/logger';

const logger = createLogger('alertmanager-notifier');

const ALERTMANAGER_URL = process.env.ALERTMANAGER_URL || 'http://localhost:9093';

// ─── Alertmanager v2 Alert Format ───────────────────────────────────────────

interface AlertmanagerV2Alert {
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt?: string;
    generatorURL?: string;
}

// Severity mapping: internal SEV levels → Alertmanager severity labels
const SEVERITY_MAP: Record<number, string> = {
    1: 'critical',
    2: 'warning',
    3: 'info',
};

// Track active anomaly alerts for auto-resolution
const activeAlerts = new Map<string, { startsAt: string; labels: Record<string, string> }>();

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Send one or more alerts to Alertmanager v2 API.
 */
async function postAlerts(alerts: AlertmanagerV2Alert[]): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);

        const response = await fetch(`${ALERTMANAGER_URL}/api/v2/alerts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(alerts),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            logger.warn({ status: response.status }, 'Alertmanager rejected alert POST');
            return false;
        }
        return true;
    } catch (err) {
        logger.debug({ err }, 'Could not reach Alertmanager');
        return false;
    }
}

/**
 * Build an anomaly alert key for dedup and resolution tracking.
 */
function alertKey(service: string, operation: string): string {
    return `AnomalyDetected:${service}:${operation}`;
}

/**
 * Fire an anomaly alert to Alertmanager.
 *
 * Called by the anomaly detector when a SEV1-3 anomaly is found.
 * The alert includes all relevant context as labels and annotations.
 */
export async function fireAnomalyAlert(anomaly: {
    traceId: string;
    service: string;
    operation: string;
    duration: number;
    expectedMean: number;
    deviation: number;
    severity: number;
    severityName: string;
    timestamp: Date;
}): Promise<void> {
    const severity = SEVERITY_MAP[anomaly.severity];
    if (!severity) return; // Only SEV1-3

    const key = alertKey(anomaly.service, anomaly.operation);
    const startsAt = anomaly.timestamp.toISOString();

    const labels: Record<string, string> = {
        alertname: 'AnomalyDetected',
        service: anomaly.service,
        operation: anomaly.operation,
        severity,
        source: 'anomaly-detector',
        traceId: anomaly.traceId,
    };

    const alert: AlertmanagerV2Alert = {
        labels,
        annotations: {
            summary: `${anomaly.severityName} anomaly: ${anomaly.service}/${anomaly.operation} — ${Math.round(anomaly.duration)}ms (${anomaly.deviation.toFixed(1)}σ above baseline)`,
            description: `Latency: ${Math.round(anomaly.duration)}ms (expected ~${Math.round(anomaly.expectedMean)}ms, deviation ${anomaly.deviation.toFixed(1)}σ). Trace: ${anomaly.traceId}`,
            trace_id: anomaly.traceId,
        },
        startsAt,
        generatorURL: `http://localhost:16686/trace/${anomaly.traceId}`,
    };

    const sent = await postAlerts([alert]);
    if (sent) {
        activeAlerts.set(key, { startsAt, labels });
        logger.info(
            { service: anomaly.service, severity, traceId: anomaly.traceId },
            'Fired anomaly alert to Alertmanager',
        );
    }
}

/**
 * Update an existing anomaly alert with LLM analysis text.
 *
 * Called by the stream analyzer after it completes LLM analysis.
 * Re-posts the alert with the analysis in annotations.description,
 * which Alertmanager treats as an update (same labels = same alert).
 */
export async function enrichAlertWithAnalysis(
    service: string,
    operation: string,
    analysisText: string,
): Promise<void> {
    const key = alertKey(service, operation);
    const existing = activeAlerts.get(key);
    if (!existing) return; // No active alert for this anomaly

    const alert: AlertmanagerV2Alert = {
        labels: existing.labels,
        annotations: {
            summary: `Anomaly: ${service}/${operation} — AI analysis available`,
            description: analysisText.slice(0, 2048), // Alertmanager annotation size limit
            trace_id: existing.labels.traceId || '',
        },
        startsAt: existing.startsAt,
    };

    const sent = await postAlerts([alert]);
    if (sent) {
        logger.info({ service, operation }, 'Updated anomaly alert with LLM analysis');
    }
}

/**
 * Resolve an anomaly alert (mark as no longer firing).
 *
 * Called when the anomaly detector determines a previously-anomalous
 * service+operation is back to normal.
 */
export async function resolveAnomalyAlert(
    service: string,
    operation: string,
): Promise<void> {
    const key = alertKey(service, operation);
    const existing = activeAlerts.get(key);
    if (!existing) return;

    const alert: AlertmanagerV2Alert = {
        labels: existing.labels,
        annotations: {
            summary: `Resolved: ${service}/${operation} anomaly cleared`,
            description: 'Latency returned to normal baseline.',
        },
        startsAt: existing.startsAt,
        endsAt: new Date().toISOString(),
    };

    const sent = await postAlerts([alert]);
    if (sent) {
        activeAlerts.delete(key);
        logger.info({ service, operation }, 'Resolved anomaly alert');
    }
}

/**
 * Get count of currently-tracked active anomaly alerts.
 */
export function getActiveAlertCount(): number {
    return activeAlerts.size;
}
