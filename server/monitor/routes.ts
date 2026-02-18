/**
 * Monitor API Routes
 * 
 * API endpoints for the trace monitoring dashboard.
 */

import { Router } from 'express';
import { traceProfiler } from './trace-profiler';
import { anomalyDetector } from './anomaly-detector';
import { historyStore } from './history-store';
import { metricsCorrelator } from './metrics-correlator';
import { trainingStore } from './training-store';
import { amountProfiler } from './amount-profiler';
import { amountAnomalyDetector } from './amount-anomaly-detector';
import { createLogger } from '../lib/logger';
import { getErrorMessage } from '../lib/errors';
import type {
    HealthResponse,
    AnomaliesResponse,
    BaselinesResponse,
    AmountAnomaliesResponse,
    AmountBaselinesResponse,
} from './types';

const logger = createLogger('monitor-routes');
const router = Router();

/**
 * GET /api/monitor/health
 * Overall system health and per-service status
 */
router.get('/health', (req, res) => {
    const services = anomalyDetector.getServiceHealth();

    // Determine overall status
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (services.some(s => s.status === 'critical')) {
        status = 'critical';
    } else if (services.some(s => s.status === 'warning')) {
        status = 'warning';
    }

    const response: HealthResponse = {
        status,
        services,
        lastPolled: new Date()
    };

    res.json(response);
});

/**
 * GET /api/monitor/baselines
 * All span baselines with statistics (from database)
 */
router.get('/baselines', async (req, res) => {
    // Read from database to get consistent results with recalculate
    const baselines = await historyStore.getBaselines();

    const response: BaselinesResponse = {
        baselines: baselines.sort((a, b) => b.sampleCount - a.sampleCount),
        spanCount: baselines.length
    };

    res.json(response);
});

/**
 * GET /api/monitor/anomalies
 * Recent anomalies
 */
router.get('/anomalies', (req, res) => {
    const active = anomalyDetector.getActiveAnomalies();

    const response: AnomaliesResponse = {
        active,
        recentCount: active.length
    };

    res.json(response);
});

/**
 * GET /api/monitor/history
 * Anomaly history for trends
 */
router.get('/history', async (req, res) => {
    const hours = parseInt(req.query.hours as string) || 24;
    const service = req.query.service as string;

    const anomalies = await historyStore.getAnomalyHistory({ hours, service });
    const hourlyTrend = await historyStore.getHourlyTrend(hours);

    res.json({
        anomalies,
        hourlyTrend,
        totalCount: anomalies.length
    });
});

/**
 * POST /api/monitor/analyze
 * Trigger LLM analysis for a trace
 */
router.post('/analyze', async (req, res) => {
    // Override global 30s timeout — Ollama cold starts can take 2+ minutes
    res.setTimeout(150000);

    const { traceId, anomalyId } = req.body;

    if (!traceId) {
        return res.status(400).json({ error: 'traceId is required' });
    }

    // Check for cached analysis
    const cached = historyStore.getAnalysis(traceId);
    if (cached) {
        return res.json(cached);
    }

    // Find the anomaly
    const anomalies = anomalyDetector.getActiveAnomalies();
    const anomaly = anomalies.find(a => a.traceId === traceId || a.id === anomalyId);

    if (!anomaly) {
        // Create a synthetic anomaly for analysis
        const syntheticAnomaly = {
            id: traceId,
            traceId,
            spanId: 'unknown',
            service: 'unknown',
            operation: 'unknown',
            duration: 0,
            expectedMean: 0,
            expectedStdDev: 0,
            deviation: 0,
            severity: 5 as const,
            severityName: 'Low',
            timestamp: new Date(),
            attributes: {}
        };

        const { analysisService } = await import('./analysis-service');
        const analysis = await analysisService.analyzeAnomaly(syntheticAnomaly);
        return res.json(analysis);
    }

    // Fetch full trace for context
    let fullTrace;
    try {
        const jaegerUrl = process.env.JAEGER_URL || 'http://localhost:16686';
        const traceResponse = await fetch(`${jaegerUrl}/api/traces/${traceId}`);
        if (traceResponse.ok) {
            const data = await traceResponse.json();
            fullTrace = data.data?.[0];
        }
    } catch (error) {
        // Continue without trace context
    }

    // Analyze with Ollama
    const { analysisService } = await import('./analysis-service');
    const analysis = await analysisService.analyzeAnomaly(anomaly, fullTrace);

    res.json(analysis);
});

/**
 * GET /api/monitor/trace/:traceId
 * Get full trace details from Jaeger
 */
router.get('/trace/:traceId', async (req, res) => {
    const { traceId } = req.params;
    const jaegerUrl = process.env.JAEGER_URL || 'http://localhost:16686';

    try {
        const response = await fetch(`${jaegerUrl}/api/traces/${traceId}`);

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Trace not found' });
        }

        const data = await response.json();
        res.json(data);
    } catch (error: unknown) {
        res.status(500).json({ error: getErrorMessage(error) });
    }
});

/**
 * POST /api/monitor/recalculate
 * Trigger manual baseline recalculation
 * Body: { full?: boolean } - if true, clears watermarks and does full recalculation
 */
router.post('/recalculate', async (req, res) => {
    const { baselineCalculator } = await import('./baseline-calculator');
    const { full } = req.body || {};

    logger.info({ full: !!full }, 'Manual baseline recalculation triggered');

    const result = await baselineCalculator.recalculate({ full: !!full });

    res.json(result);
});

/**
 * DELETE /api/monitor/reset
 * Clear all baselines for fresh validation
 */
router.delete('/reset', async (req, res) => {
    const { drizzleDb } = await import('../db/drizzle');
    const { sql } = await import('drizzle-orm');

    logger.warn('Resetting all baseline data');

    // Clear all baseline tables
    await drizzleDb.execute(sql`TRUNCATE TABLE span_baselines, time_baselines, recalculation_state RESTART IDENTITY CASCADE`);

    res.json({
        success: true,
        message: 'All baselines cleared. Ready for fresh validation.'
    });
});

/**
 * GET /api/monitor/baselines/enriched
 * Baselines with status indicators for UI display
 */
router.get('/baselines/enriched', async (req, res) => {
    const { baselineCalculator } = await import('./baseline-calculator');

    const baselines = await historyStore.getBaselines();
    const enriched = await baselineCalculator.enrichWithStatus(baselines);

    res.json({
        baselines: enriched.sort((a, b) => b.sampleCount - a.sampleCount),
        spanCount: enriched.length,
        timestamp: new Date()
    });
});

/**
 * GET /api/monitor/time-baselines
 * Get all time-aware baselines with adaptive thresholds
 */
router.get('/time-baselines', async (req, res) => {
    const { baselineCalculator } = await import('./baseline-calculator');

    const baselines = baselineCalculator.getAllBaselines();
    const status = baselineCalculator.getStatus();

    res.json({
        baselines,
        count: baselines.length,
        ...status
    });
});

/**
 * POST /api/monitor/correlate
 * Get correlated metrics for an anomaly
 */
router.post('/correlate', async (req, res) => {
    const { anomalyId, service, timestamp } = req.body;

    if (!service || !timestamp) {
        return res.status(400).json({ error: 'service and timestamp are required' });
    }

    try {
        const correlatedMetrics = await metricsCorrelator.correlate(
            anomalyId || 'manual',
            service,
            new Date(timestamp)
        );

        res.json(correlatedMetrics);
    } catch (error: unknown) {
        logger.error({ err: error }, 'Metrics correlation failed');
        res.status(500).json({ error: 'Failed to correlate metrics', details: getErrorMessage(error) });
    }
});

/**
 * GET /api/monitor/metrics/summary
 * Get current metrics summary
 */
router.get('/metrics/summary', async (req, res) => {
    try {
        const summary = await metricsCorrelator.getMetricsSummary();
        res.json(summary);
    } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to get metrics summary');
        res.status(500).json({ error: 'Failed to get metrics summary' });
    }
});

/**
 * GET /api/monitor/metrics/health
 * Check Prometheus health
 */
router.get('/metrics/health', async (req, res) => {
    const healthy = await metricsCorrelator.checkHealth();
    res.json({
        prometheus: healthy ? 'healthy' : 'unreachable',
        url: process.env.PROMETHEUS_URL || 'http://localhost:9090'
    });
});

// ============================================
// Training Data Collection Routes
// ============================================

/**
 * POST /api/monitor/training/rate
 * Rate an AI analysis as good or bad
 */
router.post('/training/rate', (req, res) => {
    const { anomaly, prompt, completion, rating, correction, notes } = req.body;

    if (!anomaly || !prompt || !completion || !rating) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['good', 'bad'].includes(rating)) {
        return res.status(400).json({ error: 'Rating must be good or bad' });
    }

    const example = trainingStore.addExample({
        anomaly,
        prompt,
        completion,
        rating,
        correction,
        notes
    });

    res.json({ success: true, example });
});

/**
 * GET /api/monitor/training/stats
 * Get training data statistics
 */
router.get('/training/stats', (req, res) => {
    const stats = trainingStore.getStats();
    res.json(stats);
});

/**
 * GET /api/monitor/training/examples
 * Get all training examples
 */
router.get('/training/examples', (req, res) => {
    const examples = trainingStore.getAll();
    res.json({ examples });
});

/**
 * GET /api/monitor/training/export
 * Export training data as JSONL
 */
router.get('/training/export', (req, res) => {
    const jsonl = trainingStore.exportToJsonl();

    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', 'attachment; filename=training-data.jsonl');
    res.send(jsonl);
});

/**
 * DELETE /api/monitor/training/:id
 * Delete a training example
 */
router.delete('/training/:id', (req, res) => {
    const deleted = trainingStore.delete(req.params.id);
    res.json({ success: deleted });
});

// ============================================
// Amount Anomaly Detection Routes (Whale Detection)
// ============================================

/**
 * GET /api/monitor/amount-anomalies
 * Get active amount anomalies (whale transactions)
 */
router.get('/amount-anomalies', (req, res) => {
    const active = amountAnomalyDetector.getActiveAnomalies();
    const enabled = amountAnomalyDetector.isEnabled();

    const response: AmountAnomaliesResponse = {
        active,
        recentCount: active.length,
        enabled,
    };

    res.json(response);
});

/**
 * GET /api/monitor/amount-baselines
 * Get amount baselines for each operation type and asset
 */
router.get('/amount-baselines', (req, res) => {
    const baselines = amountProfiler.getBaselines();

    const response: AmountBaselinesResponse = {
        baselines: baselines.sort((a, b) => b.sampleCount - a.sampleCount),
        operationCount: baselines.length,
    };

    res.json(response);
});

/**
 * POST /api/monitor/amount-baselines/reset
 * Reset all amount baselines (whale detector averages)
 */
router.post('/amount-baselines/reset', (req, res) => {
    logger.info('Resetting amount baselines (whale detector)');
    const result = amountProfiler.reset();
    res.json({
        success: true,
        message: `Cleared ${result.clearedCount} amount baselines`,
        ...result
    });
});

// ============================================
// Business KPI Admin Dashboard Routes
// ============================================

/**
 * GET /api/monitor/admin/stats
 * Get comprehensive business KPIs
 * Query params: ?tz=-60 (timezone offset in minutes from UTC)
 */
router.get('/admin/stats', async (req, res) => {
    try {
        const { businessStatsService } = await import('../services/business-stats-service');

        // Parse timezone offset (positive for west of UTC, negative for east)
        const tzOffset = parseInt(req.query.tz as string) || 0;

        const stats = await businessStatsService.getStats(tzOffset);
        res.json(stats);
    } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to get business stats');
        res.status(500).json({ error: 'Failed to get business stats', details: getErrorMessage(error) });
    }
});

/**
 * GET /api/monitor/admin/activity
 * Get recent user activity (last 15 minutes)
 */
router.get('/admin/activity', async (req, res) => {
    try {
        const { businessStatsService } = await import('../services/business-stats-service');

        const limit = parseInt(req.query.limit as string) || 20;
        const activity = await businessStatsService.getRecentActivity(limit);

        res.json({
            activity,
            count: activity.length,
            timestamp: new Date(),
        });
    } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to get user activity');
        res.status(500).json({ error: 'Failed to get user activity' });
    }
});

/**
 * GET /api/monitor/admin/volume
 * Get volume breakdown by trading pair
 * Query params: ?period=today|all (default: today, respects tz param)
 */
router.get('/admin/volume', async (req, res) => {
    try {
        const { businessStatsService } = await import('../services/business-stats-service');

        const period = req.query.period as string || 'today';
        const tzOffset = parseInt(req.query.tz as string) || 0;

        let volumeByPair;
        if (period === 'all') {
            volumeByPair = await businessStatsService.getAllTimeVolume();
        } else {
            // Get today's volume (uses timezone offset for midnight calculation)
            const stats = await businessStatsService.getStats(tzOffset);
            volumeByPair = stats.volumeByPair;
        }

        const totalVolumeUsd = volumeByPair.reduce((sum, v) => sum + v.valueUsd, 0);

        res.json({
            volumeByPair,
            totalVolumeUsd,
            period,
            timestamp: new Date(),
        });
    } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to get volume stats');
        res.status(500).json({ error: 'Failed to get volume stats' });
    }
});

export default router;

