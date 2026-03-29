"""
KrystalineX Bayesian Inference Service — FastAPI Application

Endpoints:
  POST /train  — Fit hierarchical model to historical features
  POST /infer  — Produce anomaly probabilities and root cause rankings
  GET  /health — Service health check
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

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
    try:
        # Extract raw latencies from spans if provided
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

        return TrainResponse(
            status="trained",
            services_modeled=result["services_modeled"],
            samples_used=result["samples_used"],
            message=f"Model trained in {result['training_time_ms']:.1f}ms",
        )
    except Exception as e:
        logger.exception("Training failed")
        raise HTTPException(status_code=500, detail=f"Training failed: {e}") from e


@app.post("/infer", response_model=InferResponse)
async def infer(req: InferRequest) -> InferResponse:
    """
    Produce anomaly probabilities and root cause rankings.

    If the model has not been trained, inference falls back to
    heuristic scoring (lower confidence).
    """
    try:
        return engine.infer(
            services=req.services,
            dependency_graph=req.dependency_graph,
            time_windows=req.time_windows,
        )
    except Exception as e:
        logger.exception("Inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}") from e
