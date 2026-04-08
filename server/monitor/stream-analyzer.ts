/**
 * Stream Analyzer
 * 
 * Batches anomalies and streams LLM analysis in real-time.
 * Implements tiered detection with use-case specific prompts.
 */

import type { Anomaly } from './types';
import { wsServer } from './ws-server';
import { metricsCorrelator } from './metrics-correlator';
import { enrichAlertWithAnalysis } from './alertmanager-notifier';
import { createLogger } from '../lib/logger';
import { getErrorMessage } from '../lib/errors';
import { Counter, Histogram, Gauge } from 'prom-client';
import { getMetricsRegistry } from '../metrics/prometheus';

// Get the shared metrics registry
const register = getMetricsRegistry();

const logger = createLogger('stream-analyzer');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
import { getModel } from './model-config';

// Batch configuration
const BATCH_SIZE = 10;           // Max anomalies per batch
const BATCH_TIMEOUT_MS = 30000;  // 30 seconds - wait before processing batch

// ============================================
// PROMETHEUS METRICS - LLM USAGE
// ============================================

// Total LLM analysis requests
const llmAnalysisTotal = new Counter({
    name: 'kx_llm_analysis_total',
    help: 'Total LLM anomaly analyses performed',
    labelNames: ['status', 'use_case'],
    registers: [register]
});

// Anomalies sent to LLM by severity (helps decide threshold)
const llmEventsBySeverity = new Counter({
    name: 'kx_llm_events_by_severity_total',
    help: 'Anomaly events sent to LLM by severity level',
    labelNames: ['severity'],
    registers: [register]
});

// LLM processing duration
const llmDuration = new Histogram({
    name: 'kx_llm_analysis_duration_seconds',
    help: 'Time to complete LLM analysis',
    buckets: [1, 2, 5, 10, 20, 30, 60],
    registers: [register]
});

// Current queue depth (saturation indicator)
const llmQueueDepth = new Gauge({
    name: 'kx_llm_queue_depth',
    help: 'Current number of anomalies waiting for LLM analysis',
    registers: [register]
});

// Dropped events (when queue is full or LLM unavailable)
const llmDroppedEvents = new Counter({
    name: 'kx_llm_dropped_events_total',
    help: 'Events dropped due to queue saturation or LLM errors',
    labelNames: ['reason'],
    registers: [register]
});

// Max queue size to prevent unbounded growth
const MAX_QUEUE_SIZE = 100;

// Initialize gauge to 0 so it appears in metrics immediately
llmQueueDepth.set(0);

// Initialize counters with zero values so they appear in /metrics
for (const status of ['success', 'failure', 'timeout']) {
    for (const useCase of ['latency_spike', 'error_burst', 'saturation', 'dependency_failure', 'general']) {
        llmAnalysisTotal.inc({ status, use_case: useCase }, 0);
    }
}
for (const severity of ['sev1', 'sev2', 'sev3', 'sev4', 'sev5']) {
    llmEventsBySeverity.inc({ severity }, 0);
}
for (const reason of ['queue_full', 'llm_error', 'timeout']) {
    llmDroppedEvents.inc({ reason }, 0);
}

// Use case detection patterns
interface UseCase {
    id: string;
    name: string;
    priority: 'P0' | 'P1' | 'P2';
    match: (anomaly: Anomaly) => boolean;
    promptTemplate: string;
}

const USE_CASES: UseCase[] = [
    {
        id: 'payment-gateway-down',
        name: 'Payment Gateway Down',
        priority: 'P0',
        match: (a) =>
            a.service.includes('payment') &&
            (a.attributes?.['http.status_code'] >= 500 ||
                a.attributes?.['error'] === true),
        promptTemplate: 'Payment gateway failure detected. Check provider status, failover options.'
    },
    {
        id: 'cert-expired',
        name: 'Certificate Expired',
        priority: 'P0',
        match: (a) =>
            String(a.attributes?.['error.message'] || '').toLowerCase().includes('cert') ||
            String(a.attributes?.['error.message'] || '').toLowerCase().includes('ssl'),
        promptTemplate: 'TLS/SSL certificate issue. Immediate action: check cert expiry, renew or contact provider.'
    },
    {
        id: 'dos-attack',
        name: 'DoS Attack',
        priority: 'P0',
        match: (a) =>
            a.service.includes('gateway') &&
            a.attributes?.['http.status_code'] === 429,
        promptTemplate: 'Rate limiting triggered. Possible DoS. Enable WAF, check traffic patterns.'
    },
    {
        id: 'auth-down',
        name: 'Auth Service Down',
        priority: 'P0',
        match: (a) =>
            a.service.includes('auth') &&
            a.attributes?.['http.status_code'] >= 500,
        promptTemplate: 'Auth service failure. CRITICAL: all user operations blocked.'
    },
    {
        id: 'cloud-degradation',
        name: 'Cloud Provider Issue',
        priority: 'P1',
        match: (a) =>
            a.deviation > 5 &&
            a.duration > a.expectedMean * 3,
        promptTemplate: 'Multi-service latency spike. Check cloud provider status page.'
    },
    {
        id: 'queue-backlog',
        name: 'Queue Backlog',
        priority: 'P1',
        match: (a) =>
            a.service.includes('matcher') || a.service.includes('order'),
        promptTemplate: 'Order processing delayed. Check queue depth, consumer health.'
    },
    {
        id: 'third-party-timeout',
        name: 'Third Party Timeout',
        priority: 'P1',
        match: (a) =>
            a.duration > 10000 &&
            (a.operation.includes('external') || a.operation.includes('api')),
        promptTemplate: 'External service timeout. Consider fallback, async processing.'
    },
    {
        id: 'db-exhaustion',
        name: 'Database Issue',
        priority: 'P2',
        match: (a) =>
            a.operation.toLowerCase().includes('query') ||
            a.operation.toLowerCase().includes('db'),
        promptTemplate: 'Database performance issue. Check connection pool, query optimization.'
    },
    {
        id: 'generic-anomaly',
        name: 'Performance Anomaly',
        priority: 'P2',
        match: () => true,  // Catch-all
        promptTemplate: 'Performance anomaly detected. Review trace for bottleneck.'
    }
];

class StreamAnalyzer {
    private buffer: Anomaly[] = [];
    private batchTimer: NodeJS.Timeout | null = null;
    private isProcessing = false;

    /**
     * Enqueue anomaly for batch analysis
     */
    async enqueue(anomaly: Anomaly): Promise<void> {
        // Track by severity for threshold analysis
        llmEventsBySeverity.inc({ severity: `sev${anomaly.severity}` });

        // Check for queue saturation
        if (this.buffer.length >= MAX_QUEUE_SIZE) {
            llmDroppedEvents.inc({ reason: 'queue_full' });
            logger.warn({ queueSize: this.buffer.length, anomalyId: anomaly.id }, 'LLM queue saturated, dropping event');
            return;
        }

        // Detect use case
        const useCase = USE_CASES.find(uc => uc.match(anomaly));

        // P0 critical: immediate alert
        if (useCase?.priority === 'P0') {
            wsServer.alert('critical', `${useCase.name}: ${anomaly.service}`, {
                anomalyId: anomaly.id,
                service: anomaly.service,
                operation: anomaly.operation,
                duration: anomaly.duration
            });
        }

        this.buffer.push(anomaly);
        llmQueueDepth.set(this.buffer.length);
        logger.debug({ service: anomaly.service, bufferSize: this.buffer.length, batchSize: BATCH_SIZE }, 'Buffered anomaly for batch processing');

        // Process immediately if batch full
        if (this.buffer.length >= BATCH_SIZE) {
            await this.processBatch();
        } else if (!this.batchTimer) {
            // Start timeout for partial batch
            this.batchTimer = setTimeout(() => this.processBatch(), BATCH_TIMEOUT_MS);
        }
    }

    /**
     * Process buffered anomalies
     */
    private async processBatch(): Promise<void> {
        if (this.buffer.length === 0 || this.isProcessing) return;

        // Clear timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        this.isProcessing = true;
        const batch = this.buffer.splice(0, BATCH_SIZE);
        const anomalyIds = batch.map(a => a.id);

        // Update queue depth after removing batch
        llmQueueDepth.set(this.buffer.length);

        // Detect primary use case for labeling
        const primaryUseCase = USE_CASES.find(uc => batch.some(a => uc.match(a)));

        logger.info({ batchSize: batch.length }, 'Processing anomaly batch');
        wsServer.analysisStart(anomalyIds);

        const startTime = Date.now();
        try {
            await this.streamAnalysis(batch);

            // Record success metrics
            const durationSec = (Date.now() - startTime) / 1000;
            llmDuration.observe(durationSec);
            llmAnalysisTotal.inc({ status: 'success', use_case: primaryUseCase?.id || 'unknown' });
        } catch (error: unknown) {
            logger.error({ err: error }, 'Analysis batch processing failed');
            wsServer.analysisComplete(anomalyIds, `Analysis failed: ${getErrorMessage(error)}`);

            // Record failure metrics
            llmAnalysisTotal.inc({ status: 'error', use_case: primaryUseCase?.id || 'unknown' });
            llmDroppedEvents.inc({ reason: 'llm_error' });
        }

        this.isProcessing = false;

        // Process remaining if any
        if (this.buffer.length > 0) {
            this.batchTimer = setTimeout(() => this.processBatch(), BATCH_TIMEOUT_MS);
        }
    }

    /**
     * Stream LLM analysis to WebSocket clients
     */
    private async streamAnalysis(anomalies: Anomaly[]): Promise<void> {
        const prompt = this.buildBatchPrompt(anomalies);
        const anomalyIds = anomalies.map(a => a.id);

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: getModel(),
                prompt,
                stream: true,
                options: {
                    temperature: 0.7,
                    num_predict: 400,
                    repeat_penalty: 1.3,
                    repeat_last_n: 64
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}`);
        }

        // Stream response chunks
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let fullResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });

            // Parse NDJSON lines
            const lines = chunk.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        fullResponse += json.response;
                        wsServer.streamChunk(json.response, anomalyIds);
                    }
                } catch {
                    // Skip invalid JSON
                }
            }
        }

        wsServer.analysisComplete(anomalyIds, fullResponse);

        // Update Alertmanager alerts with LLM analysis text
        for (const anomaly of anomalies) {
            enrichAlertWithAnalysis(anomaly.service, anomaly.operation, fullResponse).catch(() => {});
        }
    }

    /**
     * Build condensed batch prompt with trace span context
     */
    private buildBatchPrompt(anomalies: Anomaly[]): string {
        const summaries = anomalies.map((a, i) => {
            const useCase = USE_CASES.find(uc => uc.match(a));
            const statusCode = a.attributes?.['http.status_code'] || '';
            let entry = `${i + 1}. [SEV${a.severity}] ${a.service}:${a.operation} ${a.duration}ms (+${a.deviation.toFixed(1)}σ) ${statusCode ? `HTTP ${statusCode}` : ''}`;

            // Attach top spans from the trace so the LLM can pinpoint the bottleneck
            if (a.traceSpans?.length) {
                const spanLines = a.traceSpans
                    .slice(0, 5)
                    .map(s => `     ${s.service}:${s.operation} ${s.durationMs}ms (${s.pctOfTrace}%)`)
                    .join('\n');
                entry += `\n   Trace spans (by duration):\n${spanLines}`;
            }

            return entry;
        }).join('\n');

        return `You are monitoring a crypto exchange. Analyze these ${anomalies.length} anomalies:

${summaries}

For each numbered anomaly:
1. Identify the top 1-2 spans responsible for most of the delay (cite service:operation and %)
2. Likely root cause (1 line)
3. Action to take (1 line)

Be concise and actionable. Focus on business impact.`;
    }
}

// Singleton
export const streamAnalyzer = new StreamAnalyzer();
