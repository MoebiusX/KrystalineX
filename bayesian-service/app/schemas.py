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
    last_trained: Optional[str] = None
