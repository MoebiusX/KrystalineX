/**
 * Trace Monitor - Type Definitions
 */

// Jaeger API Response Types
export interface JaegerTrace {
    traceID: string;
    spans: JaegerSpan[];
    processes: Record<string, JaegerProcess>;
}

export interface JaegerSpan {
    traceID: string;
    spanID: string;
    operationName: string;
    references: Array<{
        refType: string;
        traceID: string;
        spanID: string;
    }>;
    startTime: number; // microseconds
    duration: number;  // microseconds
    tags: Array<{ key: string; type: string; value: any }>;
    processID: string;
}

export interface JaegerProcess {
    serviceName: string;
    tags: Array<{ key: string; type: string; value: any }>;
}

// Baseline Statistics
export interface SpanBaseline {
    service: string;
    operation: string;
    spanKey: string;      // "service:operation"
    mean: number;         // Average duration in ms
    stdDev: number;       // Standard deviation
    variance: number;     // For Welford's algorithm
    p50: number;          // Median (approximate)
    p95: number;          // 95th percentile
    p99: number;          // 99th percentile
    min: number;
    max: number;
    sampleCount: number;
    lastUpdated: Date;
}

// Severity Levels (SEV 1 = Critical, SEV 5 = Low)
export type SeverityLevel = 1 | 2 | 3 | 4 | 5;

export const SEVERITY_CONFIG = {
    1: { name: 'Critical', percentile: 99.9, color: '#dc2626' },  // red-600
    2: { name: 'Major', percentile: 99, color: '#ea580c' },       // orange-600
    3: { name: 'Moderate', percentile: 95, color: '#d97706' },    // amber-600
    4: { name: 'Minor', percentile: 90, color: '#ca8a04' },       // yellow-600
    5: { name: 'Low', percentile: 80, color: '#65a30d' },         // lime-600
} as const;

// Adaptive Thresholds (learned from data)
export interface AdaptiveThresholds {
    sev5: number;  // 80th percentile deviation (σ)
    sev4: number;  // 90th percentile deviation (σ)
    sev3: number;  // 95th percentile deviation (σ)
    sev2: number;  // 99th percentile deviation (σ)
    sev1: number;  // 99.9th percentile deviation (σ)
}

// Time-Aware Baseline (per day/hour bucket)
export interface TimeBaseline {
    spanKey: string;
    service: string;
    operation: string;
    dayOfWeek: number;    // 0-6 (Sunday-Saturday)
    hourOfDay: number;    // 0-23
    mean: number;
    stdDev: number;
    sampleCount: number;
    thresholds: AdaptiveThresholds;
    lastUpdated: Date;
}

// Anomaly Detection
export interface Anomaly {
    id: string;
    traceId: string;
    spanId: string;
    service: string;
    operation: string;
    duration: number;        // Actual duration in ms
    expectedMean: number;    // Baseline mean
    expectedStdDev: number;  // Baseline stdDev
    deviation: number;       // How many σ from mean
    severity: SeverityLevel; // SEV 1-5
    severityName: string;    // "Critical", "Major", etc.
    timestamp: Date;
    attributes: Record<string, any>;
    // Time context
    dayOfWeek?: number;
    hourOfDay?: number;
    // Trace context — sibling spans from the same trace for root-cause analysis
    traceSpans?: TraceSpanSummary[];
}

/** Lightweight span summary attached to anomalies for LLM context */
export interface TraceSpanSummary {
    service: string;
    operation: string;
    durationMs: number;
    /** Percentage of total trace duration consumed by this span */
    pctOfTrace: number;
}

// Service Health
export interface ServiceHealth {
    name: string;
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    avgDuration: number;
    spanCount: number;
    activeAnomalies: number;
    lastSeen: Date;
}

// LLM Analysis
export interface AnalysisRequest {
    traceId: string;
    anomalyId?: string;
}

export interface AnalysisResponse {
    traceId: string;
    summary: string;
    possibleCauses: string[];
    recommendations: string[];
    confidence: 'low' | 'medium' | 'high';
    analyzedAt: Date;
    prompt?: string;        // Exact prompt sent to LLM (for training data)
    rawResponse?: string;   // Raw LLM response (for training data)
}

// History Storage
export interface MonitorHistory {
    baselines: SpanBaseline[];
    anomalies: Anomaly[];
    analyses: AnalysisResponse[];
    lastUpdated: Date;
}

// API Response Types
export interface HealthResponse {
    status: 'healthy' | 'warning' | 'critical';
    services: ServiceHealth[];
    lastPolled: Date;
}

export interface AnomaliesResponse {
    active: Anomaly[];
    recentCount: number;
}

export interface BaselinesResponse {
    baselines: SpanBaseline[];
    spanCount: number;
}

// ============================================
// AMOUNT ANOMALY DETECTION (Whale Detection)
// ============================================

// Operation types for amount tracking
export type AmountOperationType = 'BUY' | 'SELL' | 'TRANSFER' | 'DEPOSIT' | 'WITHDRAW';

// Baseline statistics for transaction amounts
export interface AmountBaseline {
    key: string;              // "BUY:BTC" or "TRANSFER:USD"
    operationType: AmountOperationType;
    asset: string;            // 'BTC', 'USD', 'ETH'
    mean: number;             // Average amount
    stdDev: number;           // Standard deviation
    variance: number;         // For Welford's algorithm
    p50: number;              // Median
    p95: number;              // 95th percentile
    p99: number;              // 99th percentile
    min: number;
    max: number;
    sampleCount: number;
    lastUpdated: Date;
}

// Amount anomaly (detected whale transaction or system failure)
export interface AmountAnomaly {
    id: string;
    orderId?: string;
    transferId?: string;
    traceId?: string;
    userId: string;
    operationType: AmountOperationType;
    asset: string;
    amount: number;           // Raw amount
    dollarValue: number;      // Calculated USD value
    expectedMean: number;     // Baseline mean
    expectedStdDev: number;   // Baseline stdDev
    deviation: number;        // Z-score (σ from mean)
    severity: SeverityLevel;  // SEV 1-5
    severityName: string;     // "Critical", "Major", etc.
    timestamp: Date;
    // Context
    reason: string;           // Human-readable explanation
}

// Whale detection thresholds (tuned for 6 orders of magnitude)
// More relaxed than duration thresholds - looking for massive outliers
export const WHALE_THRESHOLDS = {
    sev5: 3.0,   // ~99.7th percentile - Large whale
    sev4: 4.0,   // ~99.99th percentile - Very large whale
    sev3: 5.0,   // ~99.9999th percentile - Mega whale
    sev2: 6.0,   // 6 σ - System anomaly suspected
    sev1: 7.0,   // 7 σ - Critical: System failure (like Alice's $7T)
} as const;

// API Response for amount anomalies
export interface AmountAnomaliesResponse {
    active: AmountAnomaly[];
    recentCount: number;
    enabled: boolean;
}

export interface AmountBaselinesResponse {
    baselines: AmountBaseline[];
    operationCount: number;
}

// ============================================
// BASELINE STATUS INDICATORS
// ============================================

/**
 * Status indicator types based on statistical deviation from mean.
 * Used to show how current performance compares to historical norms.
 */
export type BaselineStatus = 
    | 'above_mean'       // 1-3σ above mean (slower than normal)
    | 'below_mean'       // 1-3σ below mean (faster than normal)
    | 'slope_above'      // Rate of change 1-3σ above normal
    | 'slope_below'      // Rate of change 1-3σ below normal
    | 'upward_trend'     // Consistent upward movement over time
    | 'downward_trend'   // Consistent downward movement over time
    | 'normal';          // Within ±1σ of mean

/**
 * Detailed status indicator with deviation metrics.
 */
export interface BaselineStatusIndicator {
    status: BaselineStatus;
    deviation: number;            // σ from mean (positive = above, negative = below)
    slopeDeviation?: number;      // σ for rate of change
    trendDirection?: 'up' | 'down' | 'stable';
    confidence: number;           // 0-1, based on sample count
    recentMean?: number;          // Mean of current hour's samples
    previousMean?: number;        // Mean of previous hour's samples
}

/**
 * Span baseline enriched with current status indicator.
 */
export interface EnrichedSpanBaseline extends SpanBaseline {
    statusIndicator?: BaselineStatusIndicator;
}

/**
 * API response for enriched baselines endpoint.
 */
export interface EnrichedBaselinesResponse {
    baselines: EnrichedSpanBaseline[];
    spanCount: number;
    timestamp: Date;
}

