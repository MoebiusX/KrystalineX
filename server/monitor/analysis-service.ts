/**
 * Analysis Service
 * 
 * LLM-powered trace analysis using Ollama.
 * Provides root cause analysis for anomalous traces.
 */

import type {
    Anomaly,
    AnalysisResponse,
    JaegerTrace,
    JaegerSpan
} from './types';
import { historyStore } from './history-store';
import { metricsCorrelator, type CorrelatedMetrics } from './metrics-correlator';
import { createLogger } from '../lib/logger';
import { getErrorMessage } from '../lib/errors';

const logger = createLogger('analysis-service');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';  // 1b for faster inference

export class AnalysisService {
    private isOllamaAvailable = false;

    constructor() {
        this.checkOllamaHealth();
    }

    /**
     * Check if Ollama is available
     */
    async checkOllamaHealth(): Promise<boolean> {
        try {
            const response = await fetch(`${OLLAMA_URL}/api/tags`);
            this.isOllamaAvailable = response.ok;

            if (this.isOllamaAvailable) {
                logger.info('Ollama service is available');

                // Check if model is installed
                const data = await response.json();
                const models = data.models || [];
                const hasModel = models.some((m: any) => m.name.startsWith(MODEL.split(':')[0]));

                if (!hasModel) {
                    logger.warn({ model: MODEL }, 'Ollama model not found - pull model to enable AI analysis');
                }
            }

            return this.isOllamaAvailable;
        } catch (error) {
            this.isOllamaAvailable = false;
            logger.warn('Ollama service not available - AI analysis disabled');
            return false;
        }
    }

    /**
     * Analyze an anomalous trace
     */
    async analyzeAnomaly(
        anomaly: Anomaly,
        fullTrace?: JaegerTrace
    ): Promise<AnalysisResponse> {
        // Check cache first
        const cached = historyStore.getAnalysis(anomaly.traceId);
        if (cached) {
            return cached;
        }

        // If Ollama not available, return placeholder
        if (!this.isOllamaAvailable) {
            await this.checkOllamaHealth();

            if (!this.isOllamaAvailable) {
                return this.createPlaceholderAnalysis(anomaly);
            }
        }

        try {
            // Fetch correlated metrics for context
            let correlatedMetrics: CorrelatedMetrics | null = null;
            try {
                correlatedMetrics = await metricsCorrelator.correlate(
                    anomaly.id,
                    anomaly.service,
                    new Date(anomaly.timestamp)
                );
                logger.debug({ hasMetrics: !!correlatedMetrics }, 'Metrics correlation result');
            } catch (metricsError: any) {
                logger.warn({ err: metricsError }, 'Metrics unavailable for analysis');
            }

            const analysis = await this.callOllama(anomaly, fullTrace, correlatedMetrics);

            // Cache the result
            historyStore.addAnalysis(analysis);

            return analysis;
        } catch (error: unknown) {
            logger.error({ err: error }, 'Ollama analysis request failed');
            return this.createPlaceholderAnalysis(anomaly, getErrorMessage(error));
        }
    }

    /**
     * Call Ollama API for analysis
     */
    private async callOllama(
        anomaly: Anomaly,
        fullTrace?: JaegerTrace,
        metrics?: CorrelatedMetrics | null
    ): Promise<AnalysisResponse> {
        const prompt = this.buildPrompt(anomaly, fullTrace, metrics);

        // Add 120-second timeout to accommodate model cold starts
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            const response = await fetch(`${OLLAMA_URL}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: MODEL,
                    prompt,
                    stream: false,
                    options: {
                        temperature: 0.7,
                        num_predict: 500
                    }
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Ollama returned ${response.status}`);
            }

            const data = await response.json();
            const llmResponse = data.response || '';

            logger.info({
                model: MODEL,
                responseLength: llmResponse.length,
                hasContent: llmResponse.length > 0,
                totalDuration: data.total_duration ? `${(data.total_duration / 1e9).toFixed(1)}s` : 'N/A',
                preview: llmResponse.substring(0, 100),
            }, 'Ollama response received');

            // Parse and return with prompt + raw response for training data
            const analysis = this.parseResponse(anomaly.traceId, llmResponse);
            analysis.prompt = prompt;           // Exact prompt sent to LLM
            analysis.rawResponse = llmResponse; // Raw LLM response
            return analysis;
        } catch (error: unknown) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Ollama request timed out after 120 seconds');
            }
            throw error;
        }
    }

    /**
     * Build the prompt for the LLM
     */
    private buildPrompt(
        anomaly: Anomaly,
        fullTrace?: JaegerTrace,
        metrics?: CorrelatedMetrics | null
    ): string {
        const traceContext = fullTrace ? this.formatTraceContext(fullTrace) : '';
        const metricsContext = metrics ? this.formatMetricsContext(metrics) : '';



        return `You are an expert in distributed systems and observability. Analyze this performance anomaly:

## Anomaly Details
- Service: ${anomaly.service}
- Operation: ${anomaly.operation}
- Duration: ${anomaly.duration}ms (expected: ${anomaly.expectedMean}ms ± ${anomaly.expectedStdDev}ms)
- Deviation: ${anomaly.deviation}σ (standard deviations from mean)
- Severity: SEV${anomaly.severity} (${anomaly.severityName})
- Timestamp: ${anomaly.timestamp}

## Span Attributes
${JSON.stringify(anomaly.attributes, null, 2)}

${metricsContext}

${traceContext}

Based on the trace data AND correlated metrics, provide:
1. A brief summary (1-2 sentences) of what likely caused this anomaly
2. 2-3 possible root causes (consider resource utilization if metrics show issues)
3. 2-3 actionable recommendations

Format your response as:
SUMMARY: [your summary]
CAUSES:
- [cause 1]
- [cause 2]
RECOMMENDATIONS:
- [recommendation 1]
- [recommendation 2]
CONFIDENCE: [low/medium/high]`;
    }

    /**
     * Format metrics context for the prompt
     */
    private formatMetricsContext(metrics: CorrelatedMetrics): string {
        const m = metrics.metrics;

        let context = `## Correlated System Metrics (at time of anomaly)
- CPU Usage: ${m.cpuPercent !== null ? `${m.cpuPercent.toFixed(1)}%` : 'N/A'}${m.cpuPercent && m.cpuPercent >= 80 ? ' ⚠️ HIGH' : ''}
- Memory: ${m.memoryMB !== null ? `${m.memoryMB.toFixed(0)}MB` : 'N/A'}${m.memoryMB && m.memoryMB >= 512 ? ' ⚠️ HIGH' : ''}
- Request Rate: ${m.requestRate !== null ? `${m.requestRate.toFixed(1)} req/s` : 'N/A'}
- Error Rate: ${m.errorRate !== null ? `${m.errorRate.toFixed(1)}%` : '0%'}${m.errorRate && m.errorRate >= 5 ? ' ⚠️ HIGH' : ''}
- P99 Latency: ${m.p99LatencyMs !== null ? `${m.p99LatencyMs.toFixed(0)}ms` : 'N/A'}
- Active Connections: ${m.activeConnections !== null ? m.activeConnections : 'N/A'}`;

        if (metrics.insights.length > 0) {
            context += `\n\n## Auto-Detected Issues\n${metrics.insights.map(i => `- ${i}`).join('\n')}`;
        }

        return context;
    }


    /**
     * Format trace context for the prompt
     */
    private formatTraceContext(trace: JaegerTrace): string {
        const spans = trace.spans.map(s => ({
            service: trace.processes[s.processID]?.serviceName || 'unknown',
            operation: s.operationName,
            duration: (s.duration / 1000).toFixed(2) + 'ms'
        }));

        return `## Trace Context
The full trace contains ${spans.length} spans:
${spans.slice(0, 10).map(s => `- ${s.service}: ${s.operation} (${s.duration})`).join('\n')}
${spans.length > 10 ? `... and ${spans.length - 10} more spans` : ''}`;
    }

    /**
     * Parse LLM response into structured format
     */
    private parseResponse(traceId: string, response: string): AnalysisResponse {
        // Extract sections from response (using [\s\S] instead of 's' flag for compatibility)
        const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=\n|CAUSES:|$)/i);
        const causesMatch = response.match(/CAUSES:\s*([\s\S]+?)(?=RECOMMENDATIONS:|CONFIDENCE:|$)/i);
        const recsMatch = response.match(/RECOMMENDATIONS:\s*([\s\S]+?)(?=CONFIDENCE:|$)/i);
        const confMatch = response.match(/CONFIDENCE:?\s*(low|medium|high)/i);

        // Fallback: if no SUMMARY: prefix, grab any text before CAUSES: as summary
        let summary = summaryMatch?.[1]?.trim();
        if (!summary) {
            const fallbackSummary = response.match(/^([\s\S]+?)(?=CAUSES:|POSSIBLE CAUSES:|$)/i);
            if (fallbackSummary?.[1]) {
                summary = fallbackSummary[1]
                    .replace(/^[-•*\s]+/, '')
                    .replace(/\n+/g, ' ')
                    .trim();
            }
        }

        const extractBullets = (text: string | undefined): string[] => {
            if (!text) return [];
            return text
                .split('\n')
                .map(line => line.replace(/^[-•*]\s*/, '').trim())
                .filter(line =>
                    line.length > 0
                    && !line.startsWith('CAUSES')
                    && !line.startsWith('RECOMMENDATIONS')
                    && !/^CONFIDENCE:?\s*(low|medium|high)/i.test(line)
                );
        };

        return {
            traceId,
            summary: summary || 'Unable to generate summary',
            possibleCauses: extractBullets(causesMatch?.[1]),
            recommendations: extractBullets(recsMatch?.[1]),
            confidence: (confMatch?.[1]?.toLowerCase() as 'low' | 'medium' | 'high') || 'low',
            analyzedAt: new Date()
        };
    }

    /**
     * Create placeholder when Ollama unavailable
     */
    private createPlaceholderAnalysis(anomaly: Anomaly, error?: string): AnalysisResponse {
        return {
            traceId: anomaly.traceId,
            summary: error
                ? `Analysis failed: ${error}`
                : 'Ollama is not available. To enable AI analysis, start Ollama and pull the model.',
            possibleCauses: [
                `The ${anomaly.service} service took ${anomaly.duration}ms instead of expected ${anomaly.expectedMean}ms`,
                'This could indicate resource contention, network latency, or downstream service issues'
            ],
            recommendations: [
                'Start Ollama: docker compose up -d ollama',
                `Pull model: docker exec -it krystaline-ollama-1 ollama pull ${MODEL}`,
                'Check the service logs for errors around the timestamp'
            ],
            confidence: 'low',
            analyzedAt: new Date()
        };
    }
}

// Singleton instance
export const analysisService = new AnalysisService();
