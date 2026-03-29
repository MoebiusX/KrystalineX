# Bayesian Inference Layer

Probabilistic anomaly detection and root-cause analysis using hierarchical Bayesian models.

## Architecture

```
[ OTEL Traces (Jaeger) ]
        ↓
[ Feature Extraction (TypeScript) ]
  - Service metrics: p50/p95/p99 latency, error rate, request volume
  - Dependency graph: service → downstream (from trace parent/child)
  - Time windows: 5m / 15m / 1h sliding windows
        ↓
[ Bayesian Service (Python + PyMC + FastAPI) ]
  - Hierarchical LogNormal latency model
  - Beta-Bernoulli error model
  - Dependency-aware prior propagation
        ↓
[ Probabilistic Insights ]
  - Anomaly probability per service (0.0–1.0)
  - Ranked root causes with probabilities
  - Confidence scores
  - Trend detection
```

## Models

### Latency Model (Hierarchical LogNormal)

```
Global:
  μ_global ~ Normal(0, 1)
  σ_global ~ HalfNormal(1)

Per-service:
  μ_service[i] ~ Normal(μ_global, σ_global)
  σ_service[i] ~ HalfNormal(1)

Observations:
  latency ~ LogNormal(μ_service[s], σ_service[s])
```

When raw spans are available, full MCMC sampling is used (500 draws, 200 tune, 2 chains). Otherwise, conjugate updates from summary statistics provide instant training.

### Error Model (Beta-Bernoulli)

```
Per-service:
  p_error[i] ~ Beta(1 + errors, 1 + successes)

Observations:
  error ~ Bernoulli(p_error[s])
```

### Dependency-Aware Extensions

- Upstream service σ widened by `sqrt(σ² + 0.25 × max_child_σ²)`
- Error priors shifted when downstream error rate > 10%
- Root cause ranking: downstream anomalies propagated with attenuation

## API Endpoints

### Bayesian Service (Python, port 8100)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health, model status |
| `/train` | POST | Train model from historical features |
| `/infer` | POST | Anomaly inference with root causes |
| `/metrics` | GET | Prometheus metrics |

### Monitor API (Express, via `/api/monitor/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/bayesian/insights` | GET | Latest probabilistic insights |
| `/bayesian/train` | POST | Trigger model retraining |
| `/bayesian/health` | GET | Bayesian service health proxy |

### MCP Tools

| Tool | Description |
|------|-------------|
| `bayesian_health` | Check Bayesian service status |
| `bayesian_insights` | Get anomaly probabilities and root causes |
| `bayesian_train` | Trigger model retraining |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ENABLE_BAYESIAN_INFERENCE` | `false` | Enable the Bayesian inference loop |
| `BAYESIAN_SERVICE_URL` | `http://localhost:8100` | URL of the Python service |

## Inference Response Example

```json
{
  "results": [
    {
      "service": "kx-matcher",
      "latency_anomaly_probability": 0.921,
      "error_anomaly_probability": 0.156,
      "likely_root_causes": [
        {"service": "kx-exchange", "probability": 0.953, "evidence": "Upstream latency 2.1σ above baseline"},
        {"service": "kx-wallet", "probability": 0.182, "evidence": "Within normal parameters"}
      ],
      "confidence": 0.88
    }
  ],
  "model_trained": true,
  "inference_time_ms": 0.29
}
```

## File Layout

```
bayesian-service/           # Python microservice
├── app/
│   ├── main.py             # FastAPI endpoints + Prometheus metrics
│   ├── models.py           # BayesianInferenceEngine + AlertCorrelationEngine
│   └── schemas.py          # Pydantic request/response schemas
├── Dockerfile
├── requirements.txt
└── README.md

server/bayesian/            # TypeScript integration
├── alert-extractor.ts      # Alertmanager fetch, exemplar enrichment, clustering
├── client.ts               # HTTP client with health caching
├── feature-extractor.ts    # OTEL traces → structured features
├── inference.ts            # Orchestrator (train every 15m, infer every 60s)
├── types.ts                # TypeScript interfaces
└── index.ts                # Module exports
```

## Docker

```bash
# Build and start
docker compose build bayesian-service
docker compose up -d bayesian-service

# Test
curl http://localhost:8100/health
curl http://localhost:8100/metrics
```

## Alert Storm RCA (Root Cause Analysis)

A separate model for analyzing alert storms — when multiple alerts fire during an incident,
the system learns which alert is the **harbinger** (root cause) vs. cascading symptoms.

### How It Works

1. **Training**: Feed historical alert incidents (co-occurring alerts + labeled root cause)
2. **Learning**: Builds a Noisy-OR Bayesian Network from co-occurrence patterns and temporal ordering
3. **Inference**: Given currently-firing alerts, ranks probable root causes by posterior probability

### Noisy-OR Model

For each candidate root cause `c` given observed alerts:

```
P(c | alerts) ∝ P_prior(c) × ∏ P(symptom | c)
```

- **Prior**: Laplace-smoothed historical root cause frequency × temporal bonus (first-to-fire gets 2× weight)
- **Likelihood**: `P(symptom | root_cause) = (co_count + 0.5) / (rc_count + 1.0)` (Laplace smoothed)
- **Leak probability**: 0.05 for never-seen-together pairs

### Exemplar Enrichment

Alerts based on metrics with exemplars (e.g., `http_request_duration_seconds`) are enriched
with the **traceId** of the request that triggered the alert, via the Prometheus exemplars API.

```
Alert fired → metric selector → Prometheus /api/v1/query_exemplars → traceId → trace context
```

This closes the loop: **alert → metric → exemplar → trace → root cause service**.

### API Endpoints

```bash
# Train from historical alert incidents
curl -X POST http://localhost:8100/train-alerts \
  -H "Content-Type: application/json" \
  -d '{"incidents": [...]}'

# Infer root cause from current alerts
curl -X POST http://localhost:8100/infer-alerts \
  -H "Content-Type: application/json" \
  -d '{"alerts": [...]}'
```

### Example Output

```json
{
  "probable_root_causes": [
    {
      "alert_key": "HighLatencyP99:krystalinex",
      "alertname": "HighLatencyP99",
      "service": "krystalinex",
      "probability": 0.9986,
      "evidence": "Root cause in 2 prior incident(s); Fired first 4 time(s)",
      "trace_id": "abc123def456"
    }
  ],
  "incident_size": 3,
  "model_incidents_learned": 3
}
```

### MCP Tools

- `alert_rca` — Analyze currently-firing alerts to identify probable root cause
- `alert_rca_train` — Train the model from Alertmanager history

## Kubernetes

The service is deployed via Helm chart with:
- `deployment-bayesian-service.yaml` — Deployment + Service
- `values.yaml` → `bayesianService.enabled: true`
- Prometheus scrape target auto-configured when enabled
- Server pod gets `BAYESIAN_SERVICE_URL` and `ENABLE_BAYESIAN_INFERENCE` env vars injected
