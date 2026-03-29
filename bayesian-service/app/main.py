"""
KrystalineX Bayesian Inference Service — FastAPI Application

Endpoints:
  POST /train  — Fit hierarchical model to historical features
  POST /infer  — Produce anomaly probabilities and root cause rankings
  GET  /health — Service health check
  GET  /metrics — Prometheus metrics
  GET  /alert-rca — Latest autonomous alert RCA result
  POST /train-alerts — Manual alert training
  POST /infer-alerts — Manual alert inference
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

from .models import BayesianInferenceEngine, AlertCorrelationEngine
from .poller import AutonomousPoller
from .schemas import (
    HealthResponse,
    InferRequest,
    InferResponse,
    TrainRequest,
    TrainResponse,
    TrainAlertsRequest,
    TrainAlertsResponse,
    InferAlertsRequest,
    InferAlertsResponse,
    AlertRootCause,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("bayesian.main")

# ─── Prometheus Metrics ──────────────────────────────────────────────────────

TRAIN_REQUESTS = Counter("bayesian_train_requests_total", "Number of training requests")
TRAIN_ERRORS = Counter("bayesian_train_errors_total", "Number of training errors")
TRAIN_DURATION = Histogram("bayesian_train_duration_seconds", "Training request latency")
INFER_REQUESTS = Counter("bayesian_infer_requests_total", "Number of inference requests")
INFER_ERRORS = Counter("bayesian_infer_errors_total", "Number of inference errors")
INFER_DURATION = Histogram("bayesian_infer_duration_seconds", "Inference request latency")
MODEL_TRAINED = Gauge("bayesian_model_trained", "Whether the model is trained (1) or not (0)")
SERVICES_TRACKED = Gauge("bayesian_services_tracked", "Number of services currently modeled")
ALERT_TRAIN_REQUESTS = Counter("bayesian_alert_train_requests_total", "Alert correlation training requests")
ALERT_INFER_REQUESTS = Counter("bayesian_alert_infer_requests_total", "Alert RCA inference requests")
ALERT_INCIDENTS_LEARNED = Gauge("bayesian_alert_incidents_learned", "Total alert incidents learned")
POLL_CYCLES = Gauge("bayesian_poll_cycles_total", "Autonomous polling cycles completed")
POLL_ERRORS = Gauge("bayesian_poll_errors_total", "Autonomous polling errors")

# ─── Application ─────────────────────────────────────────────────────────────

engine = BayesianInferenceEngine()
alert_engine = AlertCorrelationEngine()
poller = AutonomousPoller(alert_engine)


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Start/stop the autonomous alert poller with the application."""
    await poller.start()
    logger.info("Bayesian service started with autonomous alert polling")
    yield
    await poller.stop()
    logger.info("Bayesian service shutting down")


app = FastAPI(
    title="KrystalineX Bayesian Inference Service",
    version="1.2.0",
    description="Hierarchical Bayesian modeling for distributed system observability",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5000",
        "http://localhost:8000",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    MODEL_TRAINED.set(1 if engine.is_trained else 0)
    SERVICES_TRACKED.set(len(engine.state.posteriors))
    ALERT_INCIDENTS_LEARNED.set(alert_engine.incidents_learned)
    POLL_CYCLES.set(poller.state.poll_count)
    POLL_ERRORS.set(poller.state.error_count)
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        model_loaded=engine.is_trained,
        services_tracked=len(engine.state.posteriors),
        alert_model_incidents=alert_engine.incidents_learned,
        last_trained=engine.state.last_trained,
    )


@app.post("/train", response_model=TrainResponse)
async def train(req: TrainRequest) -> TrainResponse:
    """Fit hierarchical Bayesian model to historical service metrics."""
    TRAIN_REQUESTS.inc()
    start = time.monotonic()
    try:
        raw_latencies: dict[str, list[float]] | None = None
        if req.spans:
            raw_latencies = {}
            for span in req.spans:
                raw_latencies.setdefault(span.service_name, []).append(span.duration_ms)

        result = engine.train(
            services=req.services,
            dependency_graph=req.dependency_graph,
            raw_latencies=raw_latencies,
        )

        TRAIN_DURATION.observe(time.monotonic() - start)

        return TrainResponse(
            status="trained",
            services_modeled=result["services_modeled"],
            samples_used=result["samples_used"],
            message=f"Model trained in {result['training_time_ms']:.1f}ms",
        )
    except Exception as e:
        TRAIN_ERRORS.inc()
        logger.exception("Training failed")
        raise HTTPException(status_code=500, detail=f"Training failed: {e}") from e


@app.post("/infer", response_model=InferResponse)
async def infer(req: InferRequest) -> InferResponse:
    """
    Produce anomaly probabilities and root cause rankings.

    If the model has not been trained, inference falls back to
    heuristic scoring (lower confidence).
    """
    INFER_REQUESTS.inc()
    start = time.monotonic()
    try:
        result = engine.infer(
            services=req.services,
            dependency_graph=req.dependency_graph,
            time_windows=req.time_windows,
        )
        INFER_DURATION.observe(time.monotonic() - start)
        return result
    except Exception as e:
        INFER_ERRORS.inc()
        logger.exception("Inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}") from e


# ═══════════════════════════════════════════════════════════════════════════
#  ALERT CORRELATION — Root Cause Analysis from Alert Storms
# ═══════════════════════════════════════════════════════════════════════════


@app.post("/train-alerts", response_model=TrainAlertsResponse)
async def train_alerts(req: TrainAlertsRequest) -> TrainAlertsResponse:
    """
    Learn alert co-occurrence and temporal patterns from historical incidents.

    Each incident is a cluster of alerts that fired close together.
    If root_cause_alert is labeled, the model uses it directly; otherwise
    the earliest-firing alert is the presumed root cause.
    """
    ALERT_TRAIN_REQUESTS.inc()
    try:
        result = alert_engine.train(incidents=req.incidents)
        return TrainAlertsResponse(
            status="trained",
            incidents_learned=result["incidents_learned"],
            unique_alert_types=result["unique_alert_types"],
            co_occurrence_pairs=result["co_occurrence_pairs"],
            message=f"Learned from {result['incidents_learned']} incidents in {result['training_time_ms']:.1f}ms",
        )
    except Exception as e:
        logger.exception("Alert training failed")
        raise HTTPException(status_code=500, detail=f"Alert training failed: {e}") from e


@app.post("/infer-alerts", response_model=InferAlertsResponse)
async def infer_alerts(req: InferAlertsRequest) -> InferAlertsResponse:
    """
    Given currently-firing alerts, rank them by probability of being
    the root cause using a Noisy-OR Bayesian model.

    Returns ranked candidates with probabilities and human-readable evidence.
    """
    ALERT_INFER_REQUESTS.inc()
    start = time.monotonic()
    try:
        results = alert_engine.infer(alerts=req.alerts)
        elapsed_ms = (time.monotonic() - start) * 1000
        return InferAlertsResponse(
            probable_root_causes=[AlertRootCause(**r) for r in results],
            incident_size=len(req.alerts),
            model_incidents_learned=alert_engine.incidents_learned,
            inference_time_ms=round(elapsed_ms, 2),
        )
    except Exception as e:
        logger.exception("Alert inference failed")
        raise HTTPException(status_code=500, detail=f"Alert inference failed: {e}") from e


# ═══════════════════════════════════════════════════════════════════════════
#  AUTONOMOUS ALERT RCA — Latest result from background polling
# ═══════════════════════════════════════════════════════════════════════════


@app.get("/alert-rca")
async def alert_rca():
    """
    Return the latest autonomous alert RCA result.

    The poller fetches alerts from Alertmanager every POLL_INTERVAL_SECONDS,
    enriches with Prometheus exemplar traceIds, clusters into incidents,
    and runs Bayesian inference. This endpoint returns the latest result.
    """
    rca = poller.latest_rca
    if rca is None:
        return {
            "status": "no_data",
            "message": "No alert RCA available — either no alerts are firing or poller has not run yet",
            "poller": {
                "poll_count": poller.state.poll_count,
                "last_poll_at": poller.state.last_poll_at,
                "error_count": poller.state.error_count,
            },
        }
    return {
        **rca,
        "poller": {
            "poll_count": poller.state.poll_count,
            "last_poll_at": poller.state.last_poll_at,
            "error_count": poller.state.error_count,
        },
    }
