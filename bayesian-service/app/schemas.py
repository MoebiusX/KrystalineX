"""
Pydantic schemas for the Bayesian Inference Service API.

Defines request/response contracts for /train, /infer, and /health endpoints.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ─── Enums ───────────────────────────────────────────────────────────────────


class SpanStatus(str, Enum):
    OK = "OK"
    ERROR = "ERROR"


# ─── Input: Raw Span Data ────────────────────────────────────────────────────


class SpanRecord(BaseModel):
    """A single OTEL span, pre-processed by the TypeScript feature extractor."""

    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None
    service_name: str
    operation_name: str
    duration_ms: float = Field(ge=0)
    status: SpanStatus = SpanStatus.OK
    timestamp: float = Field(description="Unix epoch milliseconds")


# ─── Input: Service-Level Metrics ────────────────────────────────────────────


class LatencyDistribution(BaseModel):
    p50: float
    p95: float
    p99: float
    mean: float
    std_dev: float
    sample_count: int = Field(ge=0)


class ServiceMetrics(BaseModel):
    """Aggregated metrics for a single service within a time window."""

    service_name: str
    latency: LatencyDistribution
    error_rate: float = Field(ge=0, le=1, description="Fraction of errored spans")
    error_count: int = Field(ge=0)
    request_count: int = Field(ge=0)


# ─── Input: Dependency Graph ─────────────────────────────────────────────────


class ServiceEdge(BaseModel):
    parent: str
    child: str
    call_count: int = Field(ge=0)


class DependencyGraph(BaseModel):
    nodes: list[str]
    edges: list[ServiceEdge]


# ─── Input: Time-Windowed Features ───────────────────────────────────────────


class TimeWindow(BaseModel):
    window_name: str = Field(description="e.g. '5m', '15m', '1h'")
    start_epoch_ms: float
    end_epoch_ms: float
    services: list[ServiceMetrics]


# ─── Request: /train ─────────────────────────────────────────────────────────


class TrainRequest(BaseModel):
    """Historical features for model training."""

    services: list[ServiceMetrics]
    dependency_graph: DependencyGraph
    spans: Optional[list[SpanRecord]] = Field(
        default=None,
        description="Raw span records for fine-grained model fitting",
    )


class TrainResponse(BaseModel):
    status: str = "trained"
    services_modeled: list[str]
    samples_used: int
    message: str = ""


# ─── Request: /infer ─────────────────────────────────────────────────────────


class InferRequest(BaseModel):
    """Current feature snapshot for inference."""

    services: list[ServiceMetrics]
    dependency_graph: DependencyGraph
    time_windows: Optional[list[TimeWindow]] = Field(
        default=None,
        description="Multi-resolution time windows for trend detection",
    )


class RootCause(BaseModel):
    service: str
    probability: float = Field(ge=0, le=1)
    evidence: str = Field(default="", description="Human-readable explanation")


class ServiceInference(BaseModel):
    """Inference result for a single service."""

    service: str
    latency_anomaly_probability: float = Field(ge=0, le=1)
    error_anomaly_probability: float = Field(ge=0, le=1)
    likely_root_causes: list[RootCause]
    confidence: float = Field(ge=0, le=1)
    posterior_latency_mean: Optional[float] = None
    posterior_latency_std: Optional[float] = None
    posterior_error_rate: Optional[float] = None


class InferResponse(BaseModel):
    results: list[ServiceInference]
    model_trained: bool
    inference_time_ms: float


# ─── Health ──────────────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    status: str = "healthy"
    model_loaded: bool = False
    services_tracked: int = 0
    alert_model_incidents: int = 0
    last_trained: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════
#  ALERT CORRELATION — Probabilistic Root Cause Analysis
# ═══════════════════════════════════════════════════════════════════════════


class AlertRecord(BaseModel):
    """A single alert from Alertmanager or the internal anomaly detector."""

    alertname: str = Field(description="Alert rule name, e.g. HighErrorRate")
    service: str = Field(default="", description="Service that fired the alert")
    severity: str = Field(default="warning", description="critical | warning | info")
    fired_at: float = Field(description="Unix epoch seconds when the alert started firing")
    resolved_at: Optional[float] = Field(default=None, description="Unix epoch seconds when resolved")
    labels: dict[str, str] = Field(default_factory=dict, description="All alert labels")
    fingerprint: str = Field(default="", description="Alertmanager fingerprint for dedup")
    trace_id: Optional[str] = Field(
        default=None,
        description="OTEL trace ID that triggered or is associated with this alert",
    )


class AlertIncident(BaseModel):
    """
    A cluster of alerts that fired close together, forming a single incident.
    Optionally includes a human-labeled root cause.
    """

    id: str = Field(default="", description="Incident ID")
    alerts: list[AlertRecord] = Field(min_length=1)
    root_cause_alert: Optional[str] = Field(
        default=None,
        description="Alert key (alertname:service) labeled as the actual root cause",
    )
    started_at: float = Field(description="Epoch seconds — earliest alert in the cluster")
    ended_at: Optional[float] = Field(default=None, description="Epoch seconds — latest alert")


class TrainAlertsRequest(BaseModel):
    """Historical alert incidents for correlation model training."""

    incidents: list[AlertIncident] = Field(min_length=1)


class TrainAlertsResponse(BaseModel):
    status: str = "trained"
    incidents_learned: int
    unique_alert_types: int
    co_occurrence_pairs: int
    message: str = ""


class AlertRootCause(BaseModel):
    """A candidate root cause alert with probability."""

    alert_key: str = Field(description="alertname:service")
    alertname: str
    service: str
    probability: float = Field(ge=0, le=1)
    evidence: str = Field(default="")
    trace_id: Optional[str] = Field(
        default=None,
        description="OTEL trace ID from exemplar enrichment, linking this alert to the triggering trace",
    )


class InferAlertsRequest(BaseModel):
    """Currently-firing alerts to analyze for root cause."""

    alerts: list[AlertRecord] = Field(min_length=1)


class InferAlertsResponse(BaseModel):
    probable_root_causes: list[AlertRootCause]
    incident_size: int
    model_incidents_learned: int
    inference_time_ms: float
