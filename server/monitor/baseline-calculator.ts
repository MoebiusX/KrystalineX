/**
 * Baseline Calculator
 * 
 * Calculates time-aware baselines with adaptive thresholds.
 * Designed to run nightly or on manual trigger.
 */

import type {
    TimeBaseline,
    AdaptiveThresholds,
    JaegerTrace,
    JaegerSpan,
    SpanBaseline,
    EnrichedSpanBaseline,
    BaselineStatus,
    BaselineStatusIndicator
} from './types';
import { historyStore } from './history-store';
import { config } from '../config';
import { createLogger } from '../lib/logger';
import { getErrorMessage } from '../lib/errors';
import { drizzleDb } from '../db/drizzle';
import { recalculationState } from '../db/schema';
import { eq } from 'drizzle-orm';

const logger = createLogger('baseline-calculator');
const JAEGER_URL = config.observability.jaegerUrl;
const MONITORED_SERVICES = ['kx-wallet', 'api-gateway', 'kx-exchange', 'kx-matcher'];
const LOOKBACK_DAYS = 30;
const MIN_SAMPLES_FOR_THRESHOLD = 10;

// Default thresholds when not enough data
const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
    sev5: 2.0,   // ~80th percentile of normal distribution
    sev4: 3.0,  // ~90th percentile
    sev3: 4.0,   // ~95th percentile
    sev2: 5.0,   // ~99th percentile
    sev1: 6.0,   // ~99.9th percentile
};

interface SpanData {
    service: string;
    operation: string;
    durationMs: number;
    dayOfWeek: number;
    hourOfDay: number;
    deviation?: number;
}

interface BucketStats {
    durations: number[];
    deviations: number[];
}

export class BaselineCalculator {
    private timeBaselines: Map<string, TimeBaseline> = new Map();
    private isCalculating = false;
    private lastCalculation: Date | null = null;

    /**
     * Get bucket key for time-aware lookup
     */
    private getBucketKey(spanKey: string, dayOfWeek: number, hourOfDay: number): string {
        return `${spanKey}:${dayOfWeek}:${hourOfDay}`;
    }

    /**
     * Fetch traces from Jaeger for the lookback period
     * @param afterTimestamp - Optional watermark: only fetch traces after this time (microseconds)
     */
    private async fetchHistoricalTraces(
        service: string,
        days: number,
        afterTimestamp?: number
    ): Promise<JaegerTrace[]> {
        const endTime = Date.now() * 1000; // microseconds
        const startTime = afterTimestamp || (endTime - (days * 24 * 60 * 60 * 1000 * 1000));
        const limit = 5000; // Max traces per service

        try {
            const url = `${JAEGER_URL}/api/traces?service=${service}&start=${startTime}&end=${endTime}&limit=${limit}`;
            const response = await fetch(url);

            if (!response.ok) {
                logger.warn({ service, status: response.status }, 'Failed to fetch traces from Jaeger');
                return [];
            }

            const data = await response.json();
            return data.data || [];
        } catch (error: unknown) {
            logger.error({ service, err: error }, 'Error fetching traces from Jaeger');
            return [];
        }
    }

    /**
     * Get watermark for a service (last processed trace timestamp)
     */
    private async getWatermark(service: string): Promise<number | null> {
        try {
            const rows = await drizzleDb.select()
                .from(recalculationState)
                .where(eq(recalculationState.service, service));

            if (rows.length > 0 && rows[0].lastTraceTime) {
                return parseInt(rows[0].lastTraceTime, 10);
            }
            return null;
        } catch (error) {
            logger.error({ service, err: error }, 'Failed to get watermark');
            return null;
        }
    }

    /**
     * Set watermark for a service
     */
    private async setWatermark(service: string, traceTimeMicros: number): Promise<void> {
        try {
            await drizzleDb.insert(recalculationState)
                .values({
                    service,
                    lastProcessedAt: new Date(),
                    lastTraceTime: traceTimeMicros.toString(),
                    processingStatus: 'idle',
                    updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: recalculationState.service,
                    set: {
                        lastProcessedAt: new Date(),
                        lastTraceTime: traceTimeMicros.toString(),
                        processingStatus: 'idle',
                        updatedAt: new Date(),
                    },
                });
            logger.debug({ service, traceTimeMicros }, 'Watermark updated');
        } catch (error) {
            logger.error({ service, err: error }, 'Failed to set watermark');
        }
    }

    /**
     * Clear all watermarks (for full recalculation)
     */
    private async clearWatermarks(): Promise<void> {
        try {
            await drizzleDb.delete(recalculationState);
            logger.info('Cleared all watermarks for full recalculation');
        } catch (error) {
            logger.error({ err: error }, 'Failed to clear watermarks');
        }
    }

    /**
     * Extract span data with time context
     */
    private extractSpanData(traces: JaegerTrace[]): SpanData[] {
        const spans: SpanData[] = [];

        for (const trace of traces) {
            for (const span of trace.spans) {
                const process = trace.processes[span.processID];
                // Only include spans from monitored business services
                // This filters out infrastructure spans like jaeger-all-in-one
                if (!process || !MONITORED_SERVICES.includes(process.serviceName)) continue;

                const timestampMs = span.startTime / 1000;
                const date = new Date(timestampMs);

                spans.push({
                    service: process.serviceName,
                    operation: span.operationName,
                    durationMs: span.duration / 1000,
                    dayOfWeek: date.getDay(),
                    hourOfDay: date.getHours(),
                });
            }
        }

        return spans;
    }

    /**
     * Group spans into time buckets
     */
    private groupIntoBuckets(spans: SpanData[]): Map<string, BucketStats> {
        const buckets = new Map<string, BucketStats>();

        // First pass: calculate mean per bucket
        const bucketSums = new Map<string, { sum: number; count: number }>();

        for (const span of spans) {
            const spanKey = `${span.service}:${span.operation}`;
            const bucketKey = this.getBucketKey(spanKey, span.dayOfWeek, span.hourOfDay);

            if (!bucketSums.has(bucketKey)) {
                bucketSums.set(bucketKey, { sum: 0, count: 0 });
            }
            const bucket = bucketSums.get(bucketKey)!;
            bucket.sum += span.durationMs;
            bucket.count++;
        }

        // Calculate means
        const bucketMeans = new Map<string, number>();
        for (const [key, stats] of Array.from(bucketSums.entries())) {
            bucketMeans.set(key, stats.sum / stats.count);
        }

        // Second pass: calculate stdDev and collect deviations
        const bucketVariances = new Map<string, { sumSq: number; count: number }>();

        for (const span of spans) {
            const spanKey = `${span.service}:${span.operation}`;
            const bucketKey = this.getBucketKey(spanKey, span.dayOfWeek, span.hourOfDay);
            const mean = bucketMeans.get(bucketKey) || 0;

            if (!bucketVariances.has(bucketKey)) {
                bucketVariances.set(bucketKey, { sumSq: 0, count: 0 });
            }
            const bucket = bucketVariances.get(bucketKey)!;
            bucket.sumSq += Math.pow(span.durationMs - mean, 2);
            bucket.count++;
        }

        // Calculate stdDevs
        const bucketStdDevs = new Map<string, number>();
        for (const [key, stats] of Array.from(bucketVariances.entries())) {
            const variance = stats.count > 1 ? stats.sumSq / (stats.count - 1) : 0;
            bucketStdDevs.set(key, Math.sqrt(variance));
        }

        // Third pass: collect deviations for threshold calculation
        for (const span of spans) {
            const spanKey = `${span.service}:${span.operation}`;
            const bucketKey = this.getBucketKey(spanKey, span.dayOfWeek, span.hourOfDay);
            const mean = bucketMeans.get(bucketKey) || 0;
            const stdDev = bucketStdDevs.get(bucketKey) || 1;

            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, { durations: [], deviations: [] });
            }
            const bucket = buckets.get(bucketKey)!;
            bucket.durations.push(span.durationMs);

            // Calculate deviation (σ from mean)
            const deviation = stdDev > 0 ? (span.durationMs - mean) / stdDev : 0;
            bucket.deviations.push(deviation);
        }

        return buckets;
    }

    /**
     * Calculate percentile from sorted array
     */
    private percentile(sorted: number[], p: number): number {
        if (sorted.length === 0) return 0;
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    }

    /**
     * Calculate adaptive thresholds from deviations
     */
    private calculateThresholds(deviations: number[]): AdaptiveThresholds {
        if (deviations.length < MIN_SAMPLES_FOR_THRESHOLD) {
            return { ...DEFAULT_THRESHOLDS };
        }

        // Sort deviations (only positive - we care about slow, not fast)
        const positiveDeviations = deviations.filter(d => d > 0).sort((a, b) => a - b);

        if (positiveDeviations.length < MIN_SAMPLES_FOR_THRESHOLD) {
            return { ...DEFAULT_THRESHOLDS };
        }

        return {
            sev5: Math.max(0.5, this.percentile(positiveDeviations, 80)),
            sev4: Math.max(1.0, this.percentile(positiveDeviations, 90)),
            sev3: Math.max(1.5, this.percentile(positiveDeviations, 95)),
            sev2: Math.max(2.0, this.percentile(positiveDeviations, 99)),
            sev1: Math.max(2.5, this.percentile(positiveDeviations, 99.9)),
        };
    }

    /**
     * Run the baseline calculation
     * @param options.full - If true, clear watermarks and do full recalculation
     */
    async recalculate(options?: { full?: boolean }): Promise<{
        success: boolean;
        baselinesCount: number;
        duration: number;
        message: string;
        isIncremental: boolean;
    }> {
        if (this.isCalculating) {
            return {
                success: false,
                baselinesCount: 0,
                duration: 0,
                message: 'Calculation already in progress',
                isIncremental: false
            };
        }

        this.isCalculating = true;
        const startTime = Date.now();
        const isFullRecalc = options?.full === true;

        if (isFullRecalc) {
            await this.clearWatermarks();
        }

        logger.info({ lookbackDays: LOOKBACK_DAYS, isFullRecalc }, 'Starting baseline recalculation');

        try {
            // Collect all spans from all services
            const allSpans: SpanData[] = [];
            let latestTraceTime = 0;

            for (const service of MONITORED_SERVICES) {
                // Get watermark for incremental processing
                const watermark = isFullRecalc ? null : await this.getWatermark(service);

                logger.info({ service, watermark: watermark || 'none' }, 'Fetching traces for service');
                const traces = await this.fetchHistoricalTraces(service, LOOKBACK_DAYS, watermark || undefined);
                const spans = this.extractSpanData(traces);
                allSpans.push(...spans);

                // Track latest trace time for watermark update
                for (const trace of traces) {
                    for (const span of trace.spans) {
                        if (span.startTime > latestTraceTime) {
                            latestTraceTime = span.startTime;
                        }
                    }
                }

                // Update watermark for this service
                if (latestTraceTime > 0) {
                    await this.setWatermark(service, latestTraceTime);
                }

                logger.info({ service, tracesCount: traces.length, spansCount: spans.length }, 'Collected traces for service');
            }

            if (allSpans.length === 0) {
                return {
                    success: false,
                    baselinesCount: 0,
                    duration: Date.now() - startTime,
                    message: 'No trace data available',
                    isIncremental: !isFullRecalc
                };
            }

            // Group into buckets
            logger.info({ totalSpans: allSpans.length }, 'Processing spans into time buckets');
            const buckets = this.groupIntoBuckets(allSpans);

            // Calculate baselines for each bucket
            const newBaselines = new Map<string, TimeBaseline>();

            for (const [bucketKey, stats] of Array.from(buckets.entries())) {
                // Parse bucket key: "service:operation:day:hour"
                const parts = bucketKey.split(':');
                const hourOfDay = parseInt(parts.pop()!, 10);
                const dayOfWeek = parseInt(parts.pop()!, 10);
                const operation = parts.pop()!;
                const service = parts.join(':'); // Handle services with colons

                const spanKey = `${service}:${operation}`;

                // Calculate stats
                const durations = stats.durations;
                const sum = durations.reduce((a, b) => a + b, 0);
                const mean = sum / durations.length;

                const variance = durations.length > 1
                    ? durations.reduce((acc, d) => acc + Math.pow(d - mean, 2), 0) / (durations.length - 1)
                    : 0;
                const stdDev = Math.sqrt(variance);

                // Calculate adaptive thresholds
                const thresholds = this.calculateThresholds(stats.deviations);

                const baseline: TimeBaseline = {
                    spanKey,
                    service,
                    operation,
                    dayOfWeek,
                    hourOfDay,
                    mean: Math.round(mean * 100) / 100,
                    stdDev: Math.round(stdDev * 100) / 100,
                    sampleCount: durations.length,
                    thresholds,
                    lastUpdated: new Date(),
                };

                newBaselines.set(bucketKey, baseline);
            }

            // Update storage
            this.timeBaselines = newBaselines;
            this.lastCalculation = new Date();

            // Persist time baselines to history store
            await historyStore.setTimeBaselines(Array.from(newBaselines.values()));

            // Also aggregate and save span baselines (for the /baselines endpoint)
            const spanBaselineMap = new Map<string, { durations: number[] }>();
            for (const span of allSpans) {
                const spanKey = `${span.service}:${span.operation}`;
                if (!spanBaselineMap.has(spanKey)) {
                    spanBaselineMap.set(spanKey, { durations: [] });
                }
                spanBaselineMap.get(spanKey)!.durations.push(span.durationMs);
            }

            const spanBaselines: SpanBaseline[] = [];
            for (const [spanKey, data] of Array.from(spanBaselineMap.entries())) {
                const [service, operation] = spanKey.split(':');
                const durations = data.durations.sort((a, b) => a - b);
                const n = durations.length;
                const mean = durations.reduce((a, b) => a + b, 0) / n;
                const variance = durations.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / n;
                const stdDev = Math.sqrt(variance);

                spanBaselines.push({
                    spanKey,
                    service,
                    operation,
                    mean: Math.round(mean * 100) / 100,
                    stdDev: Math.round(stdDev * 100) / 100,
                    variance: Math.round(variance * 100) / 100,
                    p50: durations[Math.floor(n * 0.5)] || 0,
                    p95: durations[Math.floor(n * 0.95)] || 0,
                    p99: durations[Math.floor(n * 0.99)] || 0,
                    min: durations[0] || 0,
                    max: durations[n - 1] || 0,
                    sampleCount: n,
                    lastUpdated: new Date()
                });
            }

            await historyStore.updateBaselines(spanBaselines);
            logger.info({ spanBaselinesCount: spanBaselines.length }, 'Saved aggregated span baselines');

            const duration = Date.now() - startTime;
            logger.info({ baselinesCount: newBaselines.size, durationMs: duration }, 'Calculated time-aware baselines');

            return {
                success: true,
                baselinesCount: newBaselines.size,
                duration,
                message: `Calculated ${newBaselines.size} baselines from ${allSpans.length} spans`,
                isIncremental: !isFullRecalc
            };

        } catch (error: unknown) {
            logger.error({ err: error }, 'Baseline recalculation failed');
            return {
                success: false,
                baselinesCount: 0,
                duration: Date.now() - startTime,
                message: getErrorMessage(error),
                isIncremental: !isFullRecalc
            };
        } finally {
            this.isCalculating = false;
        }
    }

    /**
     * Get baseline for specific time bucket
     */
    getBaseline(spanKey: string, dayOfWeek: number, hourOfDay: number): TimeBaseline | null {
        const bucketKey = this.getBucketKey(spanKey, dayOfWeek, hourOfDay);
        return this.timeBaselines.get(bucketKey) || null;
    }

    /**
     * Get baseline with fallback logic:
     * 1. Specific bucket (day + hour)
     * 2. Any day, same hour
     * 3. Same day, any hour
     * 4. Global (any day, any hour)
     */
    getBaselineWithFallback(spanKey: string, dayOfWeek: number, hourOfDay: number): TimeBaseline | null {
        // Try specific bucket first
        let baseline = this.getBaseline(spanKey, dayOfWeek, hourOfDay);
        if (baseline && baseline.sampleCount >= MIN_SAMPLES_FOR_THRESHOLD) {
            return baseline;
        }

        // Fallback: same hour, any day
        for (let d = 0; d < 7; d++) {
            baseline = this.getBaseline(spanKey, d, hourOfDay);
            if (baseline && baseline.sampleCount >= MIN_SAMPLES_FOR_THRESHOLD) {
                return baseline;
            }
        }

        // Fallback: same day, any hour
        for (let h = 0; h < 24; h++) {
            baseline = this.getBaseline(spanKey, dayOfWeek, h);
            if (baseline && baseline.sampleCount >= MIN_SAMPLES_FOR_THRESHOLD) {
                return baseline;
            }
        }

        // Fallback: any bucket for this span
        for (const b of Array.from(this.timeBaselines.values())) {
            if (b.spanKey === spanKey && b.sampleCount >= MIN_SAMPLES_FOR_THRESHOLD) {
                return b;
            }
        }

        return null;
    }

    /**
     * Get all time baselines
     */
    getAllBaselines(): TimeBaseline[] {
        return Array.from(this.timeBaselines.values());
    }

    /**
     * Get calculation status
     */
    getStatus(): {
        isCalculating: boolean;
        lastCalculation: Date | null;
        baselineCount: number;
    } {
        return {
            isCalculating: this.isCalculating,
            lastCalculation: this.lastCalculation,
            baselineCount: this.timeBaselines.size,
        };
    }

    /**
     * Load baselines from storage
     */
    async loadFromStorage(): Promise<void> {
        const baselines = await historyStore.getTimeBaselines();
        if (baselines && baselines.length > 0) {
            this.timeBaselines.clear();
            for (const b of baselines) {
                const key = this.getBucketKey(b.spanKey, b.dayOfWeek, b.hourOfDay);
                this.timeBaselines.set(key, b);
            }
            logger.info({ baselinesCount: this.timeBaselines.size }, 'Loaded time baselines from storage');
        }
    }
    /**
     * Calculate status indicator for a span baseline.
     * Uses the current hour's time baseline to calculate deviation from historical baseline.
     * Follows the anomaly detection model: deviation = (currentMean - historicalMean) / historicalStdDev
     * 
     * @param spanBaseline - The overall span baseline (historical aggregate)
     * @param currentTimeBaseline - The current hour's time baseline (recent data)
     */
    private calculateStatusIndicator(
        spanBaseline: SpanBaseline,
        currentTimeBaseline: TimeBaseline | null
    ): BaselineStatusIndicator {
        // Use the span baseline's historical mean/stdDev as the reference
        const historicalMean = spanBaseline.mean;
        const historicalStdDev = spanBaseline.stdDev || 1;
        const sampleCount = spanBaseline.sampleCount;

        // Calculate confidence based on sample count (0-1 scale)
        const confidence = Math.min(1, sampleCount / 50);

        // If no current hour data, we can't determine status - return normal
        if (!currentTimeBaseline) {
            return { status: 'normal', deviation: 0, confidence };
        }

        // Current hour's mean is what we're comparing
        const currentMean = currentTimeBaseline.mean;

        // Calculate deviation: how many σ is current hour's mean from historical mean?
        // This follows the model: deviation = (value - mean) / stdDev
        const deviation = historicalStdDev > 0
            ? (currentMean - historicalMean) / historicalStdDev
            : 0;

        // Determine trend direction based on deviation
        const trendDirection: 'up' | 'down' | 'stable' =
            deviation > 0.5 ? 'up' : deviation < -0.5 ? 'down' : 'stable';

        // Determine status based on deviation thresholds (matching severity model)
        // 1-3σ = above/below mean indicators, 3+σ = already handled by anomaly detection
        let status: BaselineStatus = 'normal';
        if (deviation >= 1 && deviation < 3) {
            status = 'above_mean';  // 1-3σ above historical mean (slower)
        } else if (deviation <= -1 && deviation > -3) {
            status = 'below_mean';  // 1-3σ below historical mean (faster)
        } else if (deviation > 0 && deviation < 1) {
            status = 'upward_trend';  // Slight upward trend
        } else if (deviation < 0 && deviation > -1) {
            status = 'downward_trend';  // Slight downward trend
        }

        return {
            status,
            deviation: Math.round(deviation * 100) / 100,
            trendDirection,
            confidence,
            recentMean: currentMean,
            previousMean: historicalMean,
        };
    }

    /**
     * Enrich span baselines with current status indicators.
     * Compares each span's current hour performance against its historical baseline.
     */
    async enrichWithStatus(baselines: SpanBaseline[]): Promise<EnrichedSpanBaseline[]> {
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay();

        return baselines.map(baseline => {
            // Get time baseline for current hour to see recent performance
            const currentTimeBaseline = this.getBaselineWithFallback(baseline.spanKey, currentDay, currentHour);

            // Calculate status by comparing current hour to historical baseline
            const statusIndicator = this.calculateStatusIndicator(baseline, currentTimeBaseline);

            return { ...baseline, statusIndicator };
        });
    }
}

// Singleton instance
export const baselineCalculator = new BaselineCalculator();
