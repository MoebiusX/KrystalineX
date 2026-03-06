# KrystalineX – Institutional-Grade Crypto Exchange & Observability Platform

KrystalineX is an **institutional-grade cryptocurrency exchange** engineered around a
"Proof of Observability™" philosophy. Every action — from the browser's click to a
matcher's trade decision — is captured in an end-to-end distributed trace, fed into a
statistical anomaly engine, and — when something looks wrong — analyzed by a fine‑tuned
LLM that explains **what went wrong and how to fix it**.

> **Why it exists**
> *Demonstrate how modern observability, AI, and cryptography can be combined to build
> transparent, auditable, and self‑diagnosing infrastructure.*

- 4 micro‑services with **17+ spans per trace** and full W3C context propagation over
  RabbitMQ
- Automated **latency & amount anomaly detection** using time‑aware baselines and
  Welford's online algorithm
- **AI‑powered root‑cause analysis** via a LoRA‑tuned Llama 3.2:1B model (hosted by
  Ollama), streamed to the UI in real time
- **Zero‑knowledge proofs** (zk‑SNARKs) for tamper‑proof trade commitments and solvency
- **34 alerting rules** across 7 groups with escalation via GoAlert (SMS/voice) and ntfy
  (push)
- Comprehensive telemetry: OpenTelemetry → OTEL Collector → Jaeger, Prometheus, Loki,
  Grafana — see [Observability Whitepaper](docs/OBSERVABILITY_WHITEPAPER.md)
- 940+ automated tests (Vitest + Playwright); production‑grade Docker‑Compose &
  Kubernetes manifests

**License:** Apache‑2.0

---

## Screenshots

<details>
<summary>Click to expand</summary>

| | |
|---|---|
| ![Trading UI](docs/images/screenshot_trade_page.png) | ![Transparency Dashboard](docs/images/screenshot_transparency.png) |
| ![Jaeger Distributed Trace](docs/images/screenshot_jaeger.png) | ![Grafana Dashboard](docs/images/screenshot_grafana.png) |

</details>

---

## Quick start

```powershell
# build & launch entire stack (dev mode)
npm run dev

# clean restart (kills containers, re‑init)
scripts\restart.bat
```

Browse to ➜ <http://localhost:5173>

> For Kubernetes deployment see `k8s/manifests`, Helm charts, and the
> [deployment guide](docs/operations/02_DEPLOYMENT_K8S.md).

---

## High‑level architecture

```text
  [kx-wallet (Browser)]                              [Jaeger]   [Prometheus]
        ↓ HTTP + OTEL spans
     [Kong API Gateway] ──────┐
          ↓ proxy + context   │      [Loki]     [Grafana]    [Alertmanager]
   [kx-exchange API] ────┐   ├──→ [RabbitMQ] ──→ [kx-matcher] ──→ ZK proof gen
   (orders, auth, wallet) │   │                       ↓
        ↳ PostgreSQL      │   │               order response + proof
                          │   │
        [OTEL Collector] ←┘   │
              ↓               │
   ┌──────────┴───────────────┘
   ↓
  trace/metric/log correlator ──→ anomaly detector (Welford) ──→ stream analyzer (LLM)
                                        ↓                              ↓
                                  SEV 1-5 classification        WebSocket → Live UI
                                        ↓
                                  alerting rules (34) → Alertmanager → GoAlert / ntfy
```

All components emit OpenTelemetry spans and metrics; traces carry W3C context
through RabbitMQ headers so the full path of a trade can be reconstructed.

---

## Key features

### 🔄 Trading & wallet
- BTC/USD spot market with **live Binance WebSocket price feed**
- BUY/SELL orders with fill price, slippage, and fair‑band logic
- Multi‑user wallet service (`kx-wallet`) with `kx1`‑style addresses and balance
  validation
- Peer‑to‑peer transfers between users (transfer page, `/api/transfers`)

### 🔐 Authentication & security
- Email registration/verification (MailDev for local)
- JWT access + refresh tokens, secure logout, session management
- Optional TOTP‑based two‑factor authentication
- Three‑tier rate limiting (global, auth, sensitive operations)
- Security event metrics for brute‑force / credential‑stuffing detection

### ⚠️ Anomaly detection

Adaptive, time‑aware anomaly detection across two dimensions:

**Latency anomalies** — trace duration baselines maintained per
`service:operation` across **168 time buckets** (7 days × 24 hours):
- Statistics (mean, σ, sample count) computed via **Welford's online algorithm**
  for numerically stable, single‑pass updates
- **Adaptive percentile thresholds** learned from historical deviation
  distributions (not fixed multipliers)
- **SEV 5** (80th %) → **SEV 1** (99.9th %) classification with multi‑level
  fallback lookup (exact bucket → same‑hour → same‑day → global)
- Baselines persisted in PostgreSQL and merged additively using pooled variance

**Amount anomalies** — "whale alerts" with 6‑order‑of‑magnitude sensitivity:
- Enable with `ENABLE_AMOUNT_ANOMALY_DETECTION=true`
- Passive 🐋 WHALE ALERT logging and `/api/monitor/amount-anomalies` endpoint

→ *Deep dive:*
  [Anomaly Detection Design](docs/observability/02_ANOMALY_DETECTION_DESIGN.md)

### 🧠 AI‑powered analysis

A LoRA‑fine‑tuned **Llama 3.2:1B** model provides natural‑language root‑cause
analysis for detected anomalies:

- **Real‑time streaming** — anomalies batched in 30‑second windows, analyzed via
  Ollama, and streamed token‑by‑token to the UI over WebSocket
- **8 use‑case detection patterns** (P0/P1/P2 priority) covering latency spikes,
  error bursts, queue backlogs, and more
- **Structured output** — every diagnosis contains
  `SUMMARY / CAUSES / RECOMMENDATIONS / CONFIDENCE`
- **Human feedback loop** — 👍/👎 ratings collected in‑app → stored as training
  examples → exported as JSONL for retraining

**Fine‑tuning pipeline:**

| Step | Tool / File |
|------|-------------|
| Generate synthetic data (100+ samples) | `scripts/generate-synthetic-training.cjs` |
| Validate combined dataset | `scripts/validate-training-data.cjs` |
| LoRA training (`r=16, α=32`, q/k/v/o projections) | [axolotl-config.yaml](axolotl-config.yaml) |
| Merge & quantize → GGUF | `llama.cpp` convert |
| Deploy to Ollama | `ollama create anomaly-analyzer` |

122+ training samples ship with the repo (22 hand‑crafted + 100 synthetic).

→ *Deep dive:*
  [Fine‑Tuning Guide](docs/observability/04_FINE_TUNING.md) ·
  [LLM Monitoring Setup](docs/observability/03_LLM_MONITORING_SETUP.md) ·
  [MLOps for AIOps](docs/MLOps%20for%20AIOps.md)

### 🔐 Zero‑knowledge proofs

Circom‑based zk‑SNARK circuits provide **tamper‑proof trade commitments** and
**solvency proofs**:

**Trade integrity (Phase 3)** — 5‑input Poseidon commitment:

| # | Signal | What it proves |
|---|--------|----------------|
| 1 | `fillPrice` | Exact execution price (scaled integer) |
| 2 | `quantity` | Exact trade quantity |
| 3 | `userId` | Cryptographic user attribution |
| 4 | `timestamp` | Temporal commitment — cannot be backdated |
| 5 | `traceId` | OTel trace binding — cannot be forged or swapped |

~680 constraints, well within 2^12 Powers of Tau ceremony limits.

**Tampering vectors closed by Phase 3:**
- ❌ Alter fill price or quantity
- ❌ Attribute trade to wrong user
- ❌ Backdate or future‑date a trade
- ❌ Forge, swap, or disassociate OTel traces

**Solvency proofs** — demonstrate on‑chain balances exceed liabilities.

Proofs generated by `snarkjs` during order execution and stored with trade
events.

→ *Deep dive:*
  [Phase 3 Circuit Spec](docs/phase3-circuit-spec.md) ·
  `zk-SNARK/` directory

### 📢 Monitoring & alerting

**34 Prometheus alerting rules** across 7 groups:

| Group | Examples | Severity |
|-------|----------|----------|
| Application | `HighErrorRate`, `ServiceDown`, `NoTraffic` | critical/warning |
| Trading | `OrderProcessingFailures`, `PriceFeedUnavailable`, `OrderQueueCritical` | critical/warning |
| Database | `PostgreSQLDown`, `DatabaseConnectionsCritical`, `SlowQueries` | critical/warning |
| RabbitMQ | `RabbitMQDown`, `RabbitMQNoConsumers`, `ConsumerLag` | critical/warning |
| Infrastructure | `HighCPUUsage`, `HighMemoryUsage`, `DiskSpaceCritical` | critical/warning |
| Security | `BruteForceAttack`, `CredentialStuffingAttack`, `TwoFactorAuthBypass`, `TokenEnumerationAttack` | critical/warning |
| SLA | `AvailabilitySLABreach` (99.9%), `LatencySLABreach` (P95 < 500ms) | critical/warning |

**Escalation chain:**
Prometheus → Alertmanager → GoAlert (SMS / voice) + ntfy (push notifications)

→ *Config:*
  [alerting-rules.yml](config/alerting-rules.yml) ·
  [GoAlert Setup](docs/operations/GOALERT_SETUP.md)

### 🛠️ Developer tooling & testing
- 940+ unit/E2E tests (Vitest + Playwright)
- `npm run test:e2e` exercises trading and transfer flows
- Docker‑Compose orchestration plus Kubernetes manifests for production
- Scripts for datasets, docs, security audits, and synthetic training data

---

## API reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/register` | POST | register new user |
| `/api/auth/login` | POST | login with credentials |
| `/api/auth/verify` | POST | verify email code |
| `/api/auth/refresh` | POST | refresh JWT token |
| `/api/auth/2fa/setup` | POST | enable TOTP 2FA |
| `/api/auth/2fa/verify` | POST | verify TOTP code |
| `/api/wallet` | GET | current user wallet |
| `/api/orders` | POST | submit trade order |
| `/api/orders` | GET | list user orders |
| `/api/transfers` | POST | send crypto to another user |
| `/api/price` | GET | current BTC price (live Binance feed) |
| `/api/monitor/health` | GET | system health / liveness |
| `/api/monitor/anomalies` | GET | active trace anomalies (SEV 1‑5) |
| `/api/monitor/amount-anomalies` | GET | active whale alerts |
| `/api/monitor/recalculate` | POST | trigger baseline recalculation |
| `/api/monitor/time-baselines` | GET | view computed time‑aware baselines |
| `/api/monitor/training/stats` | GET | LLM training data statistics |
| `/api/monitor/training/export` | GET | export training data as JSONL |

Metrics available under `/metrics` for Prometheus scraping (exchange API,
RabbitMQ, PostgreSQL, Kong, Node exporter, etc.).

---

## Running & testing

### Manual testing (dev)
1. Start stack with `npm run dev`.
2. Register/login via UI; verify email at <http://localhost:1080>.
3. Place orders or perform transfers; watch Jaeger (<http://localhost:16686>)
   and Grafana dashboards.
4. Trigger anomalies by throttling responses or submitting extreme amounts.

### Multi‑user transfer test
1. Register a second account.
2. Navigate to the Transfer page.
3. Enter recipient's `kx1…` wallet address and amount.
4. Verify balance updates for both users.

### Automated tests
```bash
npm run test:e2e      # end‑to‑end (Playwright)
npm run test:unit     # unit tests (Vitest)
```

### Production deployment
See [Docker deployment](docs/operations/01_DEPLOYMENT_DOCKER.md) and
[Kubernetes deployment](docs/operations/02_DEPLOYMENT_K8S.md).

---

## Technical stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, TypeScript, Vite, TailwindCSS, Radix UI, Wouter |
| **Backend** | Node.js, Express, TypeScript, Drizzle ORM, PostgreSQL |
| **Messaging** | RabbitMQ (W3C trace context propagation) |
| **Gateway** | Kong with OpenTelemetry plugin |
| **Observability** | OTEL SDK (browser & Node), OTEL Collector, Jaeger, Prometheus, Loki, Grafana, Alertmanager, GoAlert, ntfy |
| **AI / ML** | Llama 3.2:1B, Ollama, Axolotl / LoRA, synthetic + human training data |
| **Cryptography** | Circom, snarkjs, zk‑SNARK circuits (`zk-SNARK/`) |
| **Testing** | Vitest, Playwright |
| **Infrastructure** | Docker‑Compose, Kubernetes manifests, Helm charts |

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | launch full dev environment |
| `scripts\restart.bat` | clean restart of containers + services |
| `npm run build` | build frontend for production |
| `npm run test:e2e` | run end‑to‑end tests |
| `npm run test:unit` | run unit tests |
| `npm run docs` | build project documentation |

---

## Documentation

| Area | Path |
|------|------|
| Architecture & repo map | `docs/architecture/` |
| OTEL tracing, anomaly detection, LLM monitoring, fine‑tuning | `docs/observability/` |
| Deployment, backup, runbooks, GoAlert | `docs/operations/` |
| Roadmap, user journey, demo walkthrough | `docs/product/` |
| Observability whitepaper | `docs/OBSERVABILITY_WHITEPAPER.md` |
| MLOps for AIOps | `docs/MLOps for AIOps.md` |
| Phase 3 zk‑SNARK circuit spec | `docs/phase3-circuit-spec.md` |