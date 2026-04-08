/**
 * Bayesian Inference Layer — Type Definitions
 *
 * Shared interfaces between the TypeScript client and the Python Bayesian service.
 * These mirror the Pydantic schemas in bayesian-service/app/schemas.py.
 */

// ─── Span Data ──────────────────────────────────────────────────────────────

export type SpanStatus = 'OK' | 'ERROR';

export interface SpanRecord {
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    service_name: string;
    operation_name: string;
    duration_ms: number;
    status: SpanStatus;
    timestamp: number;
}

// ─── Service-Level Metrics ──────────────────────────────────────────────────

export interface LatencyDistribution {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    std_dev: number;
    sample_count: number;
}

export interface ServiceMetrics {
    service_name: string;
    latency: LatencyDistribution;
    error_rate: number;
    error_count: number;
    request_count: number;
}

// ─── Dependency Graph ───────────────────────────────────────────────────────

export interface BayesianServiceEdge {
    parent: string;
    child: string;
    call_count: number;
}

export interface BayesianDependencyGraph {
    nodes: string[];
    edges: BayesianServiceEdge[];
}

// ─── Time Windows ───────────────────────────────────────────────────────────

export interface TimeWindow {
    window_name: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
    services: ServiceMetrics[];
}

// ─── Request / Response: /train ─────────────────────────────────────────────

export interface TrainRequest {
    services: ServiceMetrics[];
    dependency_graph: BayesianDependencyGraph;
    spans?: SpanRecord[];
}

export interface TrainResponse {
    status: string;
    services_modeled: string[];
    samples_used: number;
    message: string;
}

// ─── Request / Response: /infer ─────────────────────────────────────────────

export interface InferRequest {
    services: ServiceMetrics[];
    dependency_graph: BayesianDependencyGraph;
    time_windows?: TimeWindow[];
}

export interface RootCause {
    service: string;
    probability: number;
    evidence: string;
}

export interface ServiceInference {
    service: string;
    latency_anomaly_probability: number;
    error_anomaly_probability: number;
    likely_root_causes: RootCause[];
    confidence: number;
    posterior_latency_mean: number | null;
    posterior_latency_std: number | null;
    posterior_error_rate: number | null;
}

export interface InferResponse {
    results: ServiceInference[];
    model_trained: boolean;
    inference_time_ms: number;
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface BayesianHealthResponse {
    status: string;
    model_loaded: boolean;
    services_tracked: number;
    last_trained: string | null;
}

// ─── Bayesian Insight (enriched output for consumers) ───────────────────────

export interface BayesianInsight {
    service: string;
    latency_anomaly_probability: number;
    error_anomaly_probability: number;
    likely_root_causes: RootCause[];
    confidence: number;
    timestamp: Date;
}


// ═══════════════════════════════════════════════════════════════════════════
//  ALERT CORRELATION — Root Cause Analysis from Alert Storms
// ═══════════════════════════════════════════════════════════════════════════

export interface AlertRecord {
    alertname: string;
    service: string;
    severity: string;
    fired_at: number;
    resolved_at: number | null;
    labels: Record<string, string>;
    fingerprint: string;
    trace_id: string | null;
}

export interface AlertIncident {
    id: string;
    alerts: AlertRecord[];
    root_cause_alert: string | null;
    started_at: number;
    ended_at: number | null;
}

export interface TrainAlertsRequest {
    incidents: AlertIncident[];
}

export interface TrainAlertsResponse {
    status: string;
    incidents_learned: number;
    unique_alert_types: number;
    co_occurrence_pairs: number;
    message: string;
}

export interface AlertRootCause {
    alert_key: string;
    alertname: string;
    service: string;
    probability: number;
    evidence: string;
    trace_id: string | null;
}

export interface InferAlertsRequest {
    alerts: AlertRecord[];
}

export interface InferAlertsResponse {
    probable_root_causes: AlertRootCause[];
    incident_size: number;
    model_incidents_learned: number;
    inference_time_ms: number;
}
