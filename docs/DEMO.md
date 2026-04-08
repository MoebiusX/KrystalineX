# KrystalineX — Demo Script

> **Duration:** 20 minutes (30 with Q&A)  
> **Audience:** Fintech CTOs, observability architects, technical investors  
> **Environment:** Live at [krystaline.io](https://www.krystaline.io)  
> **Core thesis:** *"Other exchanges say 'trust us.' We say 'verify it yourself.'"*

---

## Pre‑Demo (5 min before)

```bash
# Warm the trace pipeline
curl -X POST https://www.krystaline.io/api/v1/monitor/recalculate
# Execute 3–5 trades via the UI to populate recent traces
```

Open tabs in order:

| # | URL | Purpose |
|---|-----|---------|
| 1 | `krystaline.io` | Landing page |
| 2 | `krystaline.io/jaeger/` | Distributed traces |
| 3 | `krystaline.io/grafana/` | Unified dashboard |
| 4 | `krystaline.io/monitor` | Anomaly detection + AI |
| 5 | `krystaline.io/transparency` | ZK proofs |
| 6 | `krystaline.io/alertmanager/` | Alert routing |

---

## Act 1 — The Problem (2 min)

*No screen sharing yet. Conversational.*

Three problems every financial platform faces:

1. **Regulation** — SEC/CFTC demand audit trails. Most platforms reconstruct them after the fact.
2. **Institutional trust** — Hedge funds and prime brokers demand proof of execution quality. "Trust us" doesn't work post‑FTX.
3. **Operational risk** — When something breaks at 2am, how fast can you diagnose it? Most teams: 30+ minutes. With AI diagnosis: 2 seconds.

> "We built an exchange where the observability IS the product."

---

## Act 2 — Landing Page (2 min)

*Show tab 1: `krystaline.io`*

Point out:
- **Live system status** badge (pulsing green dot, seconds since last update)
- **Real performance metrics** — P50/P95/P99 latencies from OpenTelemetry, not benchmarks
- **100% transaction coverage** — every trade generates 17+ spans, no sampling
- **"Don't Trust. Verify."** — this is the engineering philosophy, not marketing

> "These numbers update in real time from production telemetry. Nothing is mocked."

---

## Act 3 — Trade Execution (3 min)

*Register or log in, navigate to `/trade`*

1. Show **live Binance price feed** (WebSocket, updates every few seconds)
2. Execute a **BUY 0.001 BTC** order
3. Point to the **toast notification** with the Jaeger trace link
4. Explain the pipeline: Browser → Kong Gateway → Express API → RabbitMQ → Order Matcher → PostgreSQL

> "That trade just traversed 4 microservices. Every hop is a span. Let's look at the trace."

---

## Act 4 — The Distributed Trace (5 min)

*Open tab 2: Jaeger. Find the trade's trace.*

### 4A: Waterfall diagram
- Show 10–17 spans across services
- Walk through: Kong auth → Express validation → RabbitMQ publish → Matcher processing → wallet update
- Highlight **W3C Trace Context** propagating through RabbitMQ message headers

### 4B: Span attributes
- Click into `order.match` span
- Show structured business context: `order.pair: BTC/USD`, `order.side: buy`, `order.price`, `enduser.id`
- This is not just infrastructure data — it's **business‑level observability**

### 4C: Grafana correlation
*Switch to tab 3: Grafana*
- Show the **Unified Observability Dashboard** (52 panels, 68 PromQL queries)
- Point to exemplar dots on latency charts — click one to jump to the full trace
- Show **SLO panel**: 99.9% availability target, error budget remaining, burn rate

> "Metrics, traces, and logs unified through a single trace ID. Click any data point and get the full story."

---

## Act 5 — Anomaly Detection + AI (4 min)

*Switch to tab 4: `/monitor`*

### 5A: Time‑aware baselines
- 168 hourly buckets (7 days × 24 hours)
- Welford's online algorithm — single‑pass, numerically stable
- The system learns that Monday 9am traffic ≠ Sunday 3am

### 5B: AI diagnosis
- Find an anomaly (or reference a recent one)
- Click **Analyze** — watch the LLM stream in real time
- Output: `SUMMARY / CAUSES / RECOMMENDATIONS / CONFIDENCE`
- Llama 3.2:1B, LoRA fine‑tuned on this infrastructure's patterns
- **Feedback loop**: 👍/👎 ratings → stored as training examples → weekly retraining

> "Two seconds to get a structured root‑cause analysis that would take an SRE 30 minutes."

---

## Act 6 — Self‑Healing (2 min)

*Explain the closed‑loop control architecture:*

| Stage | Trigger | Automated Action |
|-------|---------|------------------|
| 1 | Feed stale 15s | Reconnect WebSocket |
| 2 | Feed stale 30s | Failover to secondary provider |
| 3 | Feed stale 45s | Reconnect all providers |
| 4 | Feed stale 60s | K8s pod restart via liveness probe |

- Alertmanager webhook → auto‑remediation service
- `NoTraffic` alert pings the site to self‑resolve
- **Business‑aware liveness**: `/health` checks tick freshness, not just process alive

> "The system detects, diagnoses, AND remediates — before a human even sees the alert."

---

## Act 7 — Cryptographic Proofs (2 min)

*Switch to tab 5: `/transparency`*

- Show **ZK proof statistics**: total proofs, verification rate, proving time (~200ms)
- Every trade produces a **Poseidon commitment** binding: price, quantity, user, timestamp, trace ID
- **Solvency proofs** generated every 60 seconds — reserves ≥ liabilities, verifiable without revealing individual balances
- Public verification API: `GET /api/public/zk/verify/:tradeId`

> "You can verify any trade with 30 lines of JavaScript. No trust required."

---

## Act 8 — The Moat (2 min)

*No screen sharing. Direct.*

Five capabilities no other platform combines:

1. **Distributed tracing** — 17 spans/trade, full W3C context, exemplar correlation
2. **Autonomous anomaly detection** — time‑aware baselines, Welford's algorithm, real‑time WebSocket
3. **AI diagnosis** — fine‑tuned local LLM, continuously improving from operator feedback
4. **Bayesian inference** — hierarchical probabilistic model for uncertainty‑aware root‑cause ranking
5. **Cryptographic verification** — Groth16 zk‑SNARK proofs on every trade + solvency

This is architectural depth, not a feature checklist. 12–18 months to replicate.

---

## Common Questions

| Question | Answer |
|----------|--------|
| Is this real data? | Yes — live Binance WebSocket, real order matching, real PostgreSQL. Only starter balance is simulated. |
| How many spans per trade? | 15–20 with structured business attributes |
| What if the LLM is wrong? | Confidence levels shown. Bad ratings feed into LoRA fine‑tuning. Model improves weekly. |
| Can you fake a ZK proof? | No — Groth16 is cryptographically secure. Verification key is public. |
| What's your uptime SLA? | 99.9% (43 min error budget/month). Multi‑window burn rate alerting (Google SRE model). |
| How does this scale? | K8s HPA, OTEL Collector with tail‑based sampling (100% errors, 10% normal), async ZK proofs. |

---

## If Something Goes Wrong

| Issue | Recovery |
|-------|----------|
| Landing page shows "0 Traces" | Execute a trade first — traces populate in 5–10s |
| Jaeger empty | Traces propagate in 5–10 seconds after trade execution |
| LLM slow on first analysis | Model cold‑loads in 1–2 min. Second analysis is instant. |
| No anomalies visible | System is healthy. Show historical analysis or explain that's the goal. |
| RabbitMQ down | Orders fall back to synchronous processing — graceful degradation |
