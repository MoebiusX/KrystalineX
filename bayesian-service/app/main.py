"""
KrystalineX Bayesian Inference Service — FastAPI Application

Endpoints:
  POST /train  — Fit hierarchical model to historical features
  POST /infer  — Produce anomaly probabilities and root cause rankings
  GET  /health — Service health check
  GET  /metrics — Prometheus metrics
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from starlette.responses import Response

from .models import BayesianInferenceEngine
from .schemas import (
    HealthResponse,
    InferRequest,
    InferResponse,
    TrainRequest,
    TrainResponse,
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

# ─── Application ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="KrystalineX Bayesian Inference Service",
    version="1.0.0",
    description="Hierarchical Bayesian modeling for distributed system observability",
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

engine = BayesianInferenceEngine()


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    MODEL_TRAINED.set(1 if engine.is_trained else 0)
    SERVICES_TRACKED.set(len(engine.state.posteriors))
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        model_loaded=engine.is_trained,
        services_tracked=len(engine.state.posteriors),
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
