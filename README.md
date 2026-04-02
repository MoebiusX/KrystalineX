# KrystalineX

**What happens when you combine a SIFI messaging platform team's engineering discipline with 2026's state‑of‑the‑art AI‑powered observability?**

KrystalineX is a production-grade crypto exchange that answers that question. Every trade — from browser click to order matcher decision — is captured in a distributed trace, evaluated by a statistical anomaly engine, diagnosed by a fine-tuned LLM, and verified by zero-knowledge proofs. When something breaks, the system heals itself before a human even notices.

This is not a dashboard of mock data. It is a **live, deployed, self-healing financial platform** running on Kubernetes at [krystaline.io](https://www.krystaline.io).

### By the numbers

| Metric | Value |
|--------|-------|
| Distributed traces | **17+ spans** per trade, full W3C context propagation over RabbitMQ |
| Anomaly detection | **168 time buckets** (7d × 24h), Welford's online algorithm, adaptive percentile thresholds |
| AI diagnosis | **LoRA‑tuned Llama 3.2:1B**, real‑time streaming analysis with structured output |
| Bayesian inference | **Hierarchical PyMC model** — uncertainty‑aware root‑cause ranking with confidence scores |
| Alerting | **85 rules** across 18 groups, multi‑channel escalation (GoAlert SMS/voice, ntfy push, email) |
| Self‑healing | **4‑stage escalation ladder** — reconnect → failover → full restart → K8s pod replacement |
| Cryptographic proofs | **zk‑SNARK** trade integrity (5‑input Poseidon commitment) + solvency proofs |
| Test coverage | **940+ tests** (Vitest unit + Playwright E2E) |
| Infrastructure | **22 services** orchestrated via Helm on bare‑metal Kubernetes |

**License:** Apache‑2.0 · **Live:** [krystaline.io](https://www.krystaline.io)

---

---

## Architecture

```text
  Browser (React 18 + OTEL SDK)
       ↓ HTTP + spans
    Kong API Gateway ─────────────────────────────────┐
       ↓ proxy + W3C context                          │
  Exchange API (Node/Express) ──→ PostgreSQL           │
  (auth · orders · wallets · monitoring)               │
       ↓ publish                                       │
    RabbitMQ (traceparent in headers) ──→ Order Matcher ──→ zk‑SNARK proof gen
       ↓                                     ↓
    OTEL Collector                     order response + proof
       ↓
  ┌────┴──────────────────────────┐
  │  Jaeger (traces)              │
  │  Prometheus (metrics)         │ ──→ Grafana (52‑panel unified dashboard)
  │  Loki (logs)                  │
  └───────────────────────────────┘
       ↓
  Anomaly Detector (Welford's algorithm, 168 time buckets)
       ↓ SEV 1‑5 classification
  Stream Analyzer (LoRA‑tuned Llama 3.2:1B via Ollama)
       ↓ structured diagnosis
  ┌────┴──────────────────────────┐
  │  Alertmanager (85 rules)      │ ──→ GoAlert (SMS/voice) · ntfy (push) · email
  │  Bayesian Service (PyMC)      │ ──→ probabilistic root‑cause ranking
  │  Auto‑Remediation Engine      │ ──→ self‑healing (reconnect → failover → restart)
  └───────────────────────────────┘
```

All services emit OpenTelemetry spans and metrics. Traces carry W3C context through
RabbitMQ headers, enabling full trade‑path reconstruction from browser to matcher.

---

## What makes this different

### 1. Observability is not bolted on — it IS the architecture

Every component is instrumented from day one. The OTEL Collector ingests spans, metrics,
and logs from all services. Traces flow through RabbitMQ message headers. The Grafana
dashboard validates itself automatically (52 panels, 4 validation dimensions, tiered
criticality).

### 2. AI‑powered diagnosis, not just detection

When the anomaly detector flags a latency spike (SEV 1‑5 via adaptive percentile
thresholds), a **fine‑tuned Llama 3.2:1B** model streams a structured root‑cause analysis
in real time — `SUMMARY / CAUSES / RECOMMENDATIONS / CONFIDENCE`. A **hierarchical
Bayesian model** (PyMC) independently produces uncertainty‑aware probability rankings
across the service dependency graph.

### 3. Self‑healing closed‑loop control

The system doesn't just detect and alert — it **remediates**:

| Stage | Trigger | Action |
|-------|---------|--------|
| 1 — Soft heal | Feed stale 15s | Reconnect WebSocket |
| 2 — Failover | Feed stale 30s | Switch to secondary provider (CoinGecko) |
| 3 — Full reconnect | Feed stale 45s | Reconnect all providers |
| 4 — Pod restart | Feed stale 60s | Business‑aware liveness probe fails → K8s restarts pod |

Alertmanager webhooks trigger remediation actions automatically. The `NoTraffic` alert
pings the site to generate traffic, auto‑resolving itself.

### 4. Cryptographic verification, not trust

zk‑SNARK circuits produce tamper‑proof trade commitments (price, quantity, user,
timestamp, trace ID) with ~680 constraints. Solvency proofs demonstrate reserves exceed
liabilities. Verification is public — no trust required.

### 5. Production Kubernetes, not docker‑compose demos

22 services on bare‑metal K8s via Helm charts. GoAlert on‑call with Twilio SMS/voice
escalation. Prometheus with 85 alert rules across 18 groups. Persistent volumes, network
policies, HPA autoscaling. Not a toy.

---

## Quick start

```bash
npm install --legacy-peer-deps
npm run dev          # launches full stack (Docker infra + Node services)
```

Browse to ➜ <http://localhost:5173>

For production K8s deployment see the [deployment guide](docs/operations/02_DEPLOYMENT_K8S.md).

---

## Technical stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, TypeScript, Vite, TailwindCSS, Radix UI, Wouter |
| **Backend** | Node.js, Express, TypeScript, PostgreSQL (raw pg + Drizzle schema) |
| **Messaging** | RabbitMQ with W3C trace context propagation |
| **Gateway** | Kong with OpenTelemetry plugin |
| **Observability** | OTEL SDK + Collector, Jaeger, Prometheus, Loki, Grafana, Alertmanager |
| **Alerting** | GoAlert (SMS/voice via Twilio), ntfy (push), email |
| **AI / ML** | Llama 3.2:1B (LoRA fine‑tuned), PyMC Bayesian service, Ollama |
| **Cryptography** | Circom zk‑SNARK circuits, snarkjs |
| **Testing** | Vitest (940+ unit), Playwright (27 E2E scenarios) |
| **Infrastructure** | Helm charts, bare‑metal K8s, Docker Compose for local dev |

---

## Documentation

| Guide | Description |
|-------|-------------|
| **[Demo Walkthrough](docs/product/03_DEMO_WALKTHROUGH.md)** | 15‑minute guided tour of the platform |
| **[Architecture](docs/architecture/01_ARCHITECTURE.md)** | System design, data flow, component interactions |
| **[Observability Whitepaper](docs/OBSERVABILITY_WHITEPAPER.md)** | Philosophy, implementation, mathematical foundations |
| **[Anomaly Detection Design](docs/observability/02_ANOMALY_DETECTION_DESIGN.md)** | Welford's algorithm, time buckets, adaptive thresholds |
| **[Bayesian Inference](docs/observability/05_BAYESIAN_INFERENCE.md)** | Hierarchical models, dependency‑aware RCA |
| **[Fine‑Tuning Guide](docs/observability/04_FINE_TUNING.md)** | LoRA training pipeline, synthetic data generation |
| **[K8s Deployment](docs/operations/02_DEPLOYMENT_K8S.md)** | Helm charts, bare‑metal setup, production config |
| **[Runbook](docs/operations/04_RUNBOOK.md)** | Operational procedures, incident response |
| **[GoAlert Setup](docs/operations/GOALERT_SETUP.md)** | On‑call schedules, Twilio SMS/voice, provisioning |
| **[User Journey](docs/product/02_USER_JOURNEY.md)** | End‑to‑end user experience across all phases |