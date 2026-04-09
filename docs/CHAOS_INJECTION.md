# Chaos Injection System

> On-demand failure injection for demos, testing, and observability validation.

The chaos injection system creates realistic failure conditions that trigger the full KrystalineX observability pipeline: Prometheus alerts, anomaly detection (Welford's algorithm), severity classification (SEV 1–5), LLM-powered root-cause analysis (Ollama), and WebSocket-streamed dashboards.

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                        Request Pipeline                          │
│                                                                  │
│  Client → Rate Limiter → Metrics MW → ┌──────────────────┐       │
│                                       │  Chaos Middleware │       │
│                                       │  (chaos.ts)      │       │
│                                       │                  │       │
│                                       │  ┌─ delay? ──→ setTimeout(next) │
│                                       │  ├─ error? ──→ res.status(5xx)  │
│                                       │  └─ neither → next()            │
│                                       └──────────────────┘       │
│                                              ↓                   │
│                                       Domain Routes              │
│                                       (trade/wallet/auth)        │
└───────────────────────────────────────────────────────────────────┘
         ↓ latency/errors recorded by metrics middleware
┌───────────────────────────────────────────────────────────────────┐
│                    Observability Pipeline                         │
│                                                                  │
│  Prometheus ──→ Alert Rules ──→ Alertmanager ──→ GoAlert/Slack   │
│  OTEL Spans ──→ Jaeger ──→ Anomaly Detector ──→ WebSocket       │
│                                ↓                                 │
│                          Stream Analyzer (Ollama LLM)            │
│                                ↓                                 │
│                          Root-Cause Analysis                     │
└───────────────────────────────────────────────────────────────────┘
```

### Why After Metrics?

The middleware is placed **after** `metricsMiddleware` in the Express chain (`server/index.ts:64-65`). This is intentional — chaos-induced delays are measured by Prometheus histograms (`kx_http_request_duration_seconds`), making them visible to alerting rules, SLO burn calculations, and the anomaly detector. The system doesn't know it's synthetic; it responds exactly as it would to a real incident.

## Components

| File | Purpose |
|------|---------|
| `server/monitor/chaos-controller.ts` | Core engine — singleton managing state, scenarios, phase escalation, timers |
| `server/middleware/chaos.ts` | Express middleware — intercepts requests, injects delay/errors |
| `server/monitor/routes.ts` (chaos section) | REST API — start/stop/status/custom endpoints, API key auth |
| `scripts/chaos-scenarios.js` | CLI tool — runs scenarios with progress bars, includes client-side attacks |

### Chaos Controller (`chaos-controller.ts`)

The core engine is a singleton class exporting `chaosController`. It manages:

- **State**: `ChaosConfig` object tracking `enabled`, `delayMs`, `errorRate`, `errorCode`, `targetRoutes`, `expiresAt`
- **Scenario registry**: `SCENARIOS` — a `Record<ChaosScenarioType, ChaosScenario>` of 5 built-in scenarios
- **Phase escalation**: Multi-phase scenarios use `setInterval` (5s tick) to progressively worsen conditions
- **Auto-expiry**: Every scenario has a `setTimeout` that calls `stop()` when duration elapses
- **Jitter**: `getDelay()` applies ±30% random jitter (`0.7 + Math.random() * 0.6`) for realistic variance
- **Route targeting**: `shouldAffect(path)` does prefix matching against `targetRoutes[]`

No external dependencies — pure TypeScript, only imports `createLogger` from the shared logger.

### Chaos Middleware (`middleware/chaos.ts`)

A standard Express middleware (`req, res, next`). Decision flow:

1. **Fast path**: If chaos disabled or route doesn't match → `next()` immediately
2. **Error check**: Roll against `errorRate` probability → return `res.status(code).json({error, chaos: true})`
3. **Delay check**: Get jittered delay → `setTimeout(() => next(), delay)`
4. **Pass-through**: No delay, no error → `next()`

The `chaos: true` field in error responses allows clients/tests to distinguish injected errors from real failures.

### API Routes

All routes are mounted under `/api/v1/monitor/chaos/` (via the monitor router) and protected by the `requireChaosAuth` middleware which checks for `X-Chaos-Key` header or `?key=` query param against the `CHAOS_API_KEY` environment variable.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/chaos/status` | — | Current state, remaining time, all scenario definitions |
| `POST` | `/chaos/start` | `{scenario, duration?}` | Start a built-in scenario |
| `POST` | `/chaos/custom` | `{delayMs?, errorRate?, errorCode?, targetRoutes?, durationSeconds?}` | Start with custom parameters |
| `POST` | `/chaos/stop` | — | Stop all injection immediately |

**Security**: If `CHAOS_API_KEY` is not set, all chaos endpoints return `403 Forbidden`. This is a kill switch — chaos is completely disabled in environments without the env var.

## Scenarios

### Server-Side (Middleware Injection)

These inject real latency and errors into the Express pipeline. They affect Prometheus metrics, OTEL traces, and anomaly detection.

#### `latency-spike`
| Parameter | Value |
|-----------|-------|
| Duration | 180s |
| Delay | 5000ms (±30% jitter → 3.5–6.5s) |
| Error rate | 0% |
| Target routes | `/api/v1/trade`, `/api/v1/wallet` |
| **Triggers** | `HighLatencyP99` (>2s for 5m), `HighLatencyP99Critical` (>5s for 2m), anomaly SEV3+ |

#### `error-burst`
| Parameter | Value |
|-----------|-------|
| Duration | 120s |
| Delay | 200ms |
| Error rate | 40% (HTTP 500) |
| Error message | `Internal chaos: simulated database connection pool exhaustion` |
| Target routes | `/api/v1/trade`, `/api/v1/wallet` |
| **Triggers** | `HighErrorRate` (>5% for 2m), SLO budget burn (14.4x burn rate) |

#### `slow-degradation`
| Parameter | Value |
|-----------|-------|
| Duration | 300s (5 phases) |
| Target routes | `/api/v1/trade`, `/api/v1/wallet` |
| **Triggers** | Gradual alert escalation — warning at ~2min, critical at ~4min |

Phase progression (checked every 5s):

| Phase | At | Delay | Error Rate |
|-------|----|-------|------------|
| 1 | 0s | 200ms | 0% |
| 2 | 60s | 800ms | 0% |
| 3 | 120s | 2000ms | 0% |
| 4 | 180s | 4000ms | 0% |
| 5 | 240s | 6000ms | 10% |

#### `intermittent-errors`
| Parameter | Value |
|-----------|-------|
| Duration | 180s |
| Delay | 1500ms |
| Error rate | 15% (HTTP 502) |
| Target routes | `/api/v1/trade` |
| **Triggers** | `HighErrorRate` if sustained, anomaly detection on elevated latency |

#### `cascade-failure`
| Parameter | Value |
|-----------|-------|
| Duration | 240s (4 phases) |
| **Triggers** | Full alert storm — latency, errors, SLO burn, anomaly detection |

Phase progression:

| Phase | At | Delay | Error Rate | Code | Routes |
|-------|----|-------|------------|------|--------|
| 1 | 0s | 3000ms | 0% | — | `/api/v1/wallet` only |
| 2 | 60s | 4000ms | 20% | 500 | wallet + trade |
| 3 | 120s | 6000ms | 50% | 503 | wallet + trade |
| 4 | 180s | 8000ms | 70% | 503 | **all routes** |

This is the "showstopper" demo scenario — it produces a realistic cascading failure that starts in one service and spreads system-wide.

### Client-Side (Attack Patterns via CLI)

These scenarios send real HTTP requests to simulate external attack patterns. They don't use the chaos middleware — they generate actual traffic.

#### `brute-force`
- Sends ~4 failed login attempts/second using randomized usernames and passwords
- **Triggers**: `BruteForceAttack` alert (>20 failures in 5m, fires after 1m evaluation)
- Duration: 60s default

#### `whale-trade`
- Places abnormally large orders (0.5–5.5 BTC, 20–120 ETH) vs normal (0.001–0.01 BTC)
- Requires an authenticated user (logs in as test user)
- **Triggers**: Amount anomaly detection (3σ+ whale alerts)
- Duration: 90s default, one order every 3s

#### `rate-limit-flood`
- Fires ~200 concurrent requests/second against price endpoints
- **Triggers**: `RateLimitAbuse` alert (>50 rate-limited requests in 5m)
- Duration: 30s default

## Usage

### Prerequisites

```bash
# Set the chaos API key (required for server-side scenarios)
export CHAOS_API_KEY=your-secret-key

# Ensure the dev stack is running
npm run dev
```

### CLI Tool

```bash
# List all scenarios
node scripts/chaos-scenarios.js

# Run a scenario (shows progress bar with countdown)
node scripts/chaos-scenarios.js latency-spike
node scripts/chaos-scenarios.js cascade-failure --duration 120

# Client-side attacks
node scripts/chaos-scenarios.js brute-force
node scripts/chaos-scenarios.js whale-trade
node scripts/chaos-scenarios.js rate-limit-flood --duration 15

# Management
node scripts/chaos-scenarios.js --status
node scripts/chaos-scenarios.js --stop

# Target production (careful!)
node scripts/chaos-scenarios.js latency-spike --remote --key prod-chaos-key
```

### Direct API

```bash
CHAOS_KEY="your-secret-key"

# Start a built-in scenario
curl -X POST http://localhost:5000/api/v1/monitor/chaos/start \
  -H "Content-Type: application/json" \
  -H "X-Chaos-Key: $CHAOS_KEY" \
  -d '{"scenario": "latency-spike", "duration": 60}'

# Custom chaos
curl -X POST http://localhost:5000/api/v1/monitor/chaos/custom \
  -H "Content-Type: application/json" \
  -H "X-Chaos-Key: $CHAOS_KEY" \
  -d '{"delayMs": 3000, "errorRate": 0.25, "errorCode": 503, "targetRoutes": ["/api/v1/trade"]}'

# Check status
curl http://localhost:5000/api/v1/monitor/chaos/status \
  -H "X-Chaos-Key: $CHAOS_KEY"

# Emergency stop
curl -X POST http://localhost:5000/api/v1/monitor/chaos/stop \
  -H "X-Chaos-Key: $CHAOS_KEY"
```

## How It Connects to the Observability Stack

### Anomaly Detection Path

1. Chaos middleware injects delays → recorded in OTEL spans
2. Jaeger receives spans → Trace Profiler polls every 30s
3. Anomaly Detector runs Welford's online algorithm against 168 hourly baselines (7 days × 24 hours)
4. Latency exceeding adaptive σ thresholds → anomaly created with severity:
   - **SEV 5**: 6.6σ | **SEV 4**: 9.3σ | **SEV 3**: 12.0σ | **SEV 2**: 17.2σ | **SEV 1**: 20.6σ
5. SEV 1–3 anomalies → forwarded to Ollama for LLM root-cause analysis
6. Analysis streamed over WebSocket (`/ws/monitor`) → dashboard updates live

### Prometheus Alert Path

1. Chaos middleware injects errors → counted in `kx_http_request_errors_total`
2. Prometheus scrapes every 15s → evaluates alerting rules
3. Alert thresholds (from `config/alerting-rules.yml`):
   - `HighErrorRate`: error rate > 5% for 2m → critical
   - `HighLatencyP99`: P99 > 2s for 5m → warning; > 5s for 2m → critical
   - `BruteForceAttack`: > 20 login failures in 5m → critical
   - `RateLimitAbuse`: > 50 rate-limited requests in 5m → warning
   - `SLOBudgetBurn`: 14.4x burn rate → critical (99.9% availability = 43.2min/month error budget)
4. Alertmanager receives → routes to GoAlert (PagerDuty-compatible) or auto-remediation webhook

## Design Decisions

### No External Dependencies

The chaos system is built entirely with Node.js primitives (`setTimeout`, `setInterval`, `Math.random()`). No chaos engineering frameworks (Chaos Monkey, Litmus, Gremlin) are used. This is intentional:

- **Zero footprint**: No additional containers, sidecars, or infrastructure
- **Deterministic**: Scenarios are fully reproducible from code
- **Integrated**: Operates inside the Express middleware chain, affecting real metrics
- **Safe**: Auto-expiry prevents runaway chaos; API key prevents unauthorized access

### Single Scenario at a Time

`startScenario()` calls `stop()` before activating. Only one scenario can run at a time. This prevents compounding effects that could mask which scenario caused which alert — important for demos.

### Jitter over Fixed Delays

Fixed delays produce unrealistic flat-line latency histograms. The ±30% jitter creates a natural distribution that looks like a real incident to the anomaly detector and Grafana dashboards.

## Demo Playbook

For a live demo showing the full observability pipeline:

1. **Start normal traffic**: `node scripts/load-test.js --profile smoke`
2. **Open the monitor**: Navigate to `https://www.krystaline.io/monitor`
3. **Trigger cascade failure**: `node scripts/chaos-scenarios.js cascade-failure --duration 180`
4. **Watch the dashboard**: Latency graphs spike → error rate climbs → alerts fire → LLM analysis streams in
5. **Stop chaos**: `node scripts/chaos-scenarios.js --stop` — system self-heals
6. **Show the trace**: Click any anomaly trace ID → full Jaeger waterfall with injected delays visible

Expected timeline for `cascade-failure`:
- **0–30s**: Wallet latency visible on dashboard
- **60–90s**: `HighLatencyP99` warning fires, anomaly detection triggers
- **120–150s**: Trade errors appear, `HighErrorRate` alert fires, SLO budget burns
- **150–180s**: LLM analysis streams root-cause explanation
- **180s+**: Full degradation — all routes affected, multiple SEV2+ anomalies active
