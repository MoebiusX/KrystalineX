/**
 * Auto-Remediation Service
 *
 * Alertmanager webhook handler that executes predefined safe remediation
 * actions in response to alerts. Includes kill switch, audit logging,
 * and graceful error handling.
 *
 * Activated by: AUTO_REMEDIATION_ENABLED=true environment variable.
 */

import { Router } from 'express';
import { createLogger } from '../lib/logger';

const logger = createLogger('auto-remediation');
const router = Router();

// ============================================
// Remediation Action Registry
// ============================================

interface RemediationAction {
    alertname: string;
    description: string;
    handler: () => Promise<void>;
}

const SAFE_ACTIONS: RemediationAction[] = [
    {
        alertname: 'HighMemoryUsage',
        description: 'Trigger garbage collection if available',
        handler: async () => {
            if (global.gc) {
                global.gc();
            }
        },
    },
    {
        alertname: 'DatabaseConnectionsHigh',
        description: 'Log connection pool pressure (manual intervention recommended)',
        handler: async () => {
            logger.warn('DatabaseConnectionsHigh alert — connection pool under pressure');
        },
    },
    {
        alertname: 'RabbitMQDLQBacklog',
        description: 'Log DLQ backlog alert for manual review',
        handler: async () => {
            logger.warn('RabbitMQDLQBacklog alert — dead letter queue needs review');
        },
    },
];

// ============================================
// Audit Log (in-memory, production: PostgreSQL)
// ============================================

interface RemediationLogEntry {
    alertname: string;
    severity: string;
    status: string;
    timestamp: string;
    details?: string;
}

const remediationHistory: RemediationLogEntry[] = [];

// ============================================
// Webhook Handler
// ============================================

/**
 * POST /webhook/remediation
 * Receives Alertmanager webhook payloads and executes matching safe actions.
 */
router.post('/webhook/remediation', async (req, res) => {
    if (process.env.AUTO_REMEDIATION_ENABLED !== 'true') {
        return res.json({ skipped: true, reason: 'Auto-remediation is disabled' });
    }

    const { alerts } = req.body;
    const actions: RemediationLogEntry[] = [];

    for (const alert of alerts) {
        const alertname = alert.labels?.alertname;
        const severity = alert.labels?.severity || 'unknown';

        // Only act on firing alerts
        if (alert.status !== 'firing') {
            const entry: RemediationLogEntry = {
                alertname,
                severity,
                status: 'skipped_resolved',
                timestamp: new Date().toISOString(),
            };
            actions.push(entry);
            remediationHistory.push(entry);
            continue;
        }

        const action = SAFE_ACTIONS.find(a => a.alertname === alertname);

        if (!action) {
            const entry: RemediationLogEntry = {
                alertname,
                severity,
                status: 'no_action',
                timestamp: new Date().toISOString(),
                details: 'No registered remediation action',
            };
            actions.push(entry);
            remediationHistory.push(entry);
            continue;
        }

        try {
            await action.handler();
            const entry: RemediationLogEntry = {
                alertname,
                severity,
                status: 'executed',
                timestamp: new Date().toISOString(),
                details: action.description,
            };
            actions.push(entry);
            remediationHistory.push(entry);
            logger.info({ alertname, action: action.description }, 'Remediation action executed');
        } catch (error: unknown) {
            const entry: RemediationLogEntry = {
                alertname,
                severity,
                status: 'failed',
                timestamp: new Date().toISOString(),
                details: error instanceof Error ? error.message : String(error),
            };
            actions.push(entry);
            remediationHistory.push(entry);
            logger.error({ alertname, err: error }, 'Remediation action failed');
        }
    }

    res.json({ processed: alerts.length, actions });
});

// ============================================
// History & Inspection Endpoints
// ============================================

/**
 * GET /remediation/history
 * Returns audit log of all remediation actions taken.
 */
router.get('/remediation/history', (_req, res) => {
    res.json({
        actions: [...remediationHistory].reverse().slice(0, 100),
    });
});

/**
 * GET /remediation/actions
 * Lists all registered remediation actions and current enabled status.
 */
router.get('/remediation/actions', (_req, res) => {
    res.json({
        enabled: process.env.AUTO_REMEDIATION_ENABLED === 'true',
        actions: SAFE_ACTIONS.map(a => ({
            alertname: a.alertname,
            description: a.description,
        })),
    });
});

export default router;
