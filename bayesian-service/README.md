# KrystalineX Bayesian Inference Service

Hierarchical Bayesian modeling for probabilistic observability.  
Extends KrystalineX's deterministic anomaly detection with uncertainty-aware inference, root cause analysis, and confidence scoring.

## Architecture

```
KrystalineX (Node/TypeScript)
  └─ server/bayesian/
       ├─ feature-extractor.ts  → OTEL traces → structured features
       ├─ client.ts             → HTTP client to Python service
       └─ inference.ts          → Orchestration (train → infer → insights)
                ↓ REST (JSON)
Bayesian Service (Python)
  └─ bayesian-service/app/
       ├─ main.py     → FastAPI endpoints
       ├─ models.py   → Hierarchical PyMC models
       └─ schemas.py  → Pydantic request/response schemas
```

## Models

### Latency Model (Hierarchical LogNormal)

```
Global:
  μ_global     ~ Normal(0, 1)
  σ_global     ~ HalfNormal(1)

Per-service:
  μ_service[i]    ~ Normal(μ_global, σ_global)
  σ_service[i]    ~ HalfNormal(1)

Observation:
  log(latency) ~ Normal(μ_service[i], σ_service[i])
```

### Error Model (Beta-Bernoulli)

```
Per-service:
  p_error[i] ~ Beta(1 + errors, 1 + successes)

Observation:
  error ~ Bernoulli(p_error[i])
```

### Dependency-Aware Extension

Upstream services inherit increased uncertainty from anomalous downstream services:
- Latency σ is widened by downstream uncertainty
- Error priors are shifted when downstream error rates exceed 10%

## API Endpoints

### `POST /train`

Fit model to historical service metrics.

```json
{
  "services": [
    {
      "service_name": "kx-exchange",
      "latency": { "p50": 12, "p95": 45, "p99": 120, "mean": 18, "std_dev": 15, "sample_count": 5000 },
      "error_rate": 0.02,
      "error_count": 100,
      "request_count": 5000
    }
  ],
  "dependency_graph": {
    "nodes": ["kx-exchange", "kx-matcher", "kx-wallet"],
    "edges": [
      { "parent": "kx-exchange", "child": "kx-matcher", "call_count": 3000 },
      { "parent": "kx-exchange", "child": "kx-wallet", "call_count": 1500 }
    ]
  }
}
```

### `POST /infer`

Get anomaly probabilities and root cause rankings.

```json
{
  "services": [{ "service_name": "kx-exchange", "latency": { "..." }, "..." }],
  "dependency_graph": { "nodes": ["..."], "edges": ["..."] },
  "time_windows": [
    {
      "window_name": "5m",
      "start_epoch_ms": 1711735000000,
      "end_epoch_ms": 1711735300000,
      "services": [{ "..." }]
    }
  ]
}
```

**Response:**

```json
{
  "results": [
    {
      "service": "kx-exchange",
      "latency_anomaly_probability": 0.87,
      "error_anomaly_probability": 0.12,
      "likely_root_causes": [
        { "service": "kx-matcher", "probability": 0.65, "evidence": "latency_anomaly=0.82; p99=450.0ms" },
        { "service": "kx-wallet", "probability": 0.22, "evidence": "err_rate=5.2%" }
      ],
      "confidence": 0.91,
      "posterior_latency_mean": 2.89,
      "posterior_latency_std": 0.45,
      "posterior_error_rate": 0.019
    }
  ],
  "model_trained": true,
  "inference_time_ms": 3.21
}
```

### `GET /health`

```json
{ "status": "healthy", "model_loaded": true, "services_tracked": 4, "last_trained": "2026-03-29T17:00:00Z" }
```

## Running Locally

### Docker Compose (recommended)

```bash
docker compose up bayesian-service
```

### Standalone

```bash
cd bayesian-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8100
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BAYESIAN_SERVICE_URL` | `http://localhost:8100` | URL of the Python service (TypeScript client) |

## Integration with KrystalineX

The TypeScript integration at `server/bayesian/` handles:

1. **Feature extraction** — Pulls traces from Jaeger, builds dependency graph from `TopologyService`, aggregates service metrics
2. **Training** — Periodically calls `/train` with historical features (every 15 min)
3. **Inference** — Calls `/infer` with current observations and returns `BayesianInsight[]`
4. **Fast path** — `inferFast()` uses cached baselines from `TraceProfiler` (no Jaeger fetch)

```typescript
import { bayesianInference } from './server/bayesian';

// Start periodic inference (trains every 15m, infers every 60s)
await bayesianInference.start();

// Get latest results
const insights = bayesianInference.getLatestInsights();

// Quick inference from cached baselines
const fast = await bayesianInference.inferFast();
```

## Performance

- Model parameters are cached in memory — no retraining per request
- Full PyMC MCMC sampling only runs when raw span data is provided
- Summary-based training uses closed-form conjugate updates (instant)
- Inference is pure NumPy computation (~1-5ms per request)
- Batch inference: all services scored in a single call
