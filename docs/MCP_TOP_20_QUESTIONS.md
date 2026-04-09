# OTEL MCP Server — Top 20 Questions It Answers

The OTEL MCP Server bridges AI agents to KrystalineX's observability stack (Jaeger, Prometheus, Loki) and application APIs (ZK proofs, anomaly detection). It exposes **23 tools** that enable both end‑users and platform engineers to interrogate the system through natural language.

> **Live:** `https://www.krystaline.io` · **MCP endpoint:** `kx-krystalinex-otel-mcp-server:3001`  
> **Tools:** `traces` (5) · `metrics` (6) · `logs` (4) · `zk-proofs` (4) · `system` (4)

---

## For End‑Users (Traders & Auditors)

### 1. "Was my trade executed at a fair price?"

Every trade produces a **Groth16 zk‑SNARK proof** binding price, quantity, user, timestamp, and trace ID into a Poseidon commitment. The MCP server lets an AI agent verify this cryptographically — no trust required.

| Tool | What it does |
|------|-------------|
| `zk_proof_get` | Retrieve the proof, public signals, and verification key for a specific trade |
| `zk_proof_verify` | Verify the proof server‑side — confirms price was within 0.5% of real Binance price |

**Example agent interaction:**
> *"Verify my BTC buy from 10 minutes ago"*  
> → Agent calls `zk_proof_verify` → "✅ Proof valid. Fill price $66,534.72 was within 0.12% of Binance mid‑price at execution time."

---

### 2. "Is the exchange solvent right now?"

Solvency proofs are generated every 60 seconds, proving reserves ≥ liabilities without revealing individual balances.

| Tool | What it does |
|------|-------------|
| `zk_solvency` | Get the latest solvency proof with timestamp and verification status |
| `zk_stats` | Aggregate proof statistics — total generated, verification success rate, proving time |

**Example:**
> *"Show me the latest solvency proof"*  
> → Agent calls `zk_solvency` → "Solvency proof generated 23s ago. Reserves exceed liabilities. Verification: ✅ valid."

---

### 3. "What exactly happened during my trade?"

Every trade generates 17+ distributed trace spans across 4 services. End‑users can follow the exact path their order took — from browser to matcher to wallet update.

| Tool | What it does |
|------|-------------|
| `trace_get` | Full waterfall of every span: Kong auth, API validation, RabbitMQ publish, order matching, wallet update |
| `traces_search` | Find trades by service, duration, or tags (e.g., `order.pair: BTC/USD`) |

**Example:**
> *"Show me the trace for my last trade"*  
> → Agent calls `traces_search` with user's service → `trace_get` on the result → "Your order traversed 4 services in 47ms. Kong (3ms) → API validation (5ms) → RabbitMQ (2ms) → Matcher (31ms) → Wallet update (6ms). No errors."

---

### 4. "Is the platform healthy? Should I trade right now?"

Real‑time system health with per‑service status, uptime, and active anomaly count.

| Tool | What it does |
|------|-------------|
| `system_health` | Overall status (operational/degraded/down), per‑service health, uptime, performance metrics |
| `anomalies_active` | Currently active anomalies with severity (SEV 1–5) and affected services |

**Example:**
> *"Is the exchange healthy?"*  
> → Agent calls `system_health` → "All systems operational. Uptime 99.97%. No active anomalies. Price feed: Binance (active), 0.6s tick age."

---

### 5. "How fast is the exchange processing trades?"

Real performance data — not marketing benchmarks — derived from actual OpenTelemetry instrumentation.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Instant latency percentiles: `histogram_quantile(0.95, ...)` |
| `metrics_query_range` | Latency trends over time (last hour, day, week) |
| `anomalies_baselines` | Historical baselines per operation — mean, stdDev, P50, P95, P99 |

**Example:**
> *"What's the current trade execution speed?"*  
> → Agent queries P50/P95/P99 via PromQL → "Current trade execution: P50 12ms, P95 45ms, P99 243ms. Within normal range for Wednesday 10am baseline."

---

## For Platform Engineering (SREs & Developers)

### 6. "What's causing this latency spike?"

The most common on‑call question. The MCP server lets an AI agent correlate traces, metrics, and logs to pinpoint root cause in seconds.

| Tool | What it does |
|------|-------------|
| `traces_search` | Find slow traces with `min_duration` filter |
| `trace_get` | Drill into the slowest trace — identify which span is the bottleneck |
| `metrics_query` | Check resource metrics (CPU, memory, event loop lag) at the time of the spike |
| `logs_tail_context` | Get logs correlated with the slow trace ID |

**Example workflow:**
> *"Why is P99 latency at 2s?"*  
> → `traces_search` with `min_duration: "1s"` → finds 3 slow traces  
> → `trace_get` on the slowest → `pg.query` span took 1.8s  
> → `logs_tail_context` with trace ID → finds "slow query: SELECT ... WHERE NOT EXISTS" log  
> → `metrics_query` for `pg_stat_activity_count` → "Database connections at 89/100. Slow query + connection saturation."

---

### 7. "What alerts are firing and what do they mean?"

85 alerting rules across 18 groups. The MCP server gives an AI agent the full picture — what's firing, what's pending, and the severity/annotations context.

| Tool | What it does |
|------|-------------|
| `metrics_alerts` | All alert rules with state (firing/pending/inactive), severity, annotations |
| `metrics_query` | Query the underlying metric to understand the alert condition |
| `system_health` | Cross‑reference with application‑level health |

**Example:**
> *"What alerts are firing?"*  
> → `metrics_alerts` with `filter: "firing"` → "2 alerts firing: DiskExhaustionForecast (warning, kube node /dev/sda2) and ContainerCrashLooping (critical, bayesian‑service). DiskExhaustionForecast: predicted to exhaust within 7 days at current write rate."

---

### 8. "Which services are down and what's the blast radius?"

Service topology with health overlays — understand not just what's broken, but what it affects downstream.

| Tool | What it does |
|------|-------------|
| `metrics_targets` | Prometheus scrape targets — which are up/down, last scrape time, errors |
| `traces_dependencies` | Service dependency graph with call counts |
| `system_topology` | Live topology with health overlays from both Jaeger and the application API |
| `traces_services` | All services currently reporting traces |

**Example:**
> *"Is anything down?"*  
> → `metrics_targets` → "19/19 targets UP"  
> → `system_topology` → "All services healthy. Dependency graph: API → RabbitMQ → Matcher. No broken edges."

---

### 9. "What do the logs say about this error?"

Correlate logs with traces using the shared trace ID — the three pillars of observability unified through one query.

| Tool | What it does |
|------|-------------|
| `logs_query` | LogQL queries — filter by app, level, component, keyword |
| `logs_tail_context` | Find all logs across all services that mention a specific trace ID |
| `logs_labels` / `logs_label_values` | Discover available log labels and their values |

**Example:**
> *"Show me error logs from the payment processor in the last 15 minutes"*  
> → `logs_query` with `{app="payment-processor"} |= "error"` → "3 error logs found: 'AMQP connection reset', 'Failed to acknowledge message', 'Reconnecting to RabbitMQ'. All within a 2‑second window at 09:47:12."

---

### 10. "How are our SLOs tracking? Are we burning error budget?"

SLO recording rules pre‑compute availability and latency budgets. The MCP server lets an AI agent query these and explain the business impact.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Instant SLO values: `slo:availability:error_budget_remaining`, `slo:latency:error_budget_remaining` |
| `metrics_query_range` | Error budget burn rate over time — detect slow burns before they exhaust the budget |
| `metrics_alerts` | SLO burn rate alerts (multi‑window: 5m, 30m, 2h, 6h) |

**Example:**
> *"How's our error budget?"*  
> → `metrics_query` for both budgets → "Availability budget: 100% remaining (0 errors in window). Latency budget: 95% remaining — P95 at 45ms vs 500ms target. No burn rate alerts firing. 43 minutes of budget remaining this month."

---

## For Business Owners (CEO, CPO, Investors)

### 11. "Are we meeting our uptime commitments to customers?"

The question behind every SLA negotiation and board slide. Rather than trusting a status page, the MCP server provides the actual measured availability — computed from real request outcomes, not synthetic probes.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Instant SLO: `slo:availability:error_budget_remaining`, uptime percentages |
| `metrics_query_range` | Historical availability trends — week over week, month over month |
| `metrics_alerts` | SLO burn rate alerts — early warning before a breach |

**Example:**
> *"What's our uptime this month?"*  
> → `metrics_query` → "99.97% availability (measured). Error budget: 100% remaining. Zero SLO breaches in the last 30 days. We can contractually offer 99.95% SLA with margin."

---

### 12. "How much does our infrastructure actually cost per trade?"

Unit economics matter. By correlating request volume with infrastructure topology, the MCP server reveals cost‑per‑transaction dynamics without separate FinOps tooling.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Total request counts: `http_requests_total`, order volumes |
| `metrics_targets` | Number of active infrastructure components (19 scrape targets = 19 billable services) |
| `system_topology` | Full service map — understand what each trade touches |
| `traces_dependencies` | Call fan‑out per request — how many downstream hops per order |

**Example:**
> *"What does our infrastructure footprint look like per trade?"*  
> → `metrics_query` for daily order volume + `system_topology` for service count → "1,247 trades today across 22 services. Each trade traverses 4 services (API → RabbitMQ → Matcher → Wallet). 19 infrastructure components running. This gives you the denominator for cost‑per‑trade against your cloud bill."

---

### 13. "Can we prove to regulators that we're operating transparently?"

Regulatory compliance in crypto means demonstrable auditability. The MCP server surfaces cryptographic proofs and full audit trails — the kind of evidence regulators actually want.

| Tool | What it does |
|------|-------------|
| `zk_solvency` | Proof of reserves ≥ liabilities, generated every 60 seconds |
| `zk_stats` | Proof generation history — total count, success rate, average proving time |
| `zk_proof_get` | Individual trade proofs — cryptographic binding of price, quantity, timestamp |
| `traces_search` | Full audit trail — every API call, every state change, end‑to‑end traced |

**Example:**
> *"What evidence do we have for a regulatory audit?"*  
> → `zk_stats` → "14,293 trade proofs generated, 100% verification success rate. Solvency proofs every 60s for 30 days continuous. Every trade has an immutable OpenTelemetry trace linking price source → execution → settlement."

---

### 14. "Is the platform performing well enough to scale to 10× volume?"

Before spending on marketing or onboarding institutional clients, you need to know if the platform can handle the load. The MCP server reveals headroom directly from production telemetry.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Current throughput, CPU/memory utilization, connection pool saturation |
| `metrics_query_range` | Load trends — are we growing toward a ceiling? |
| `anomalies_baselines` | Per‑operation baselines — know what "normal" looks like so you can model 10× |
| `anomalies_active` | Active anomalies — are we already stressed at current volume? |

**Example:**
> *"Can we handle 10× current volume?"*  
> → `metrics_query` for resource utilization + `anomalies_baselines` for latency norms → "Current P95 trade latency: 45ms at ~50 trades/min. Database connections at 12/100 (88% headroom). No active anomalies. Event loop lag: 2ms. At 10× you'd hit ~120ms P95 and 60% DB connection usage — comfortable margin. RabbitMQ queue depth is the first bottleneck to watch."

---

### 15. "What went wrong during yesterday's incident?"

Investors and board members ask this after every outage. The MCP server lets an AI agent reconstruct the full incident timeline — from first anomaly to resolution — without requiring an engineer to write the post‑mortem manually.

| Tool | What it does |
|------|-------------|
| `anomalies_active` | What anomalies were detected, at what severity |
| `metrics_alerts` | Which alerts fired, when, and for how long |
| `traces_search` | Affected traces during the incident window |
| `logs_query` | Error logs correlated with the incident timeframe |
| `metrics_query_range` | Metric graphs showing degradation and recovery |

**Example:**
> *"What happened yesterday at 3pm?"*  
> → `metrics_alerts` for firing history + `logs_query` for errors in window + `traces_search` for slow traces → "At 14:58 UTC, PriceFeedUnavailable fired (Binance WebSocket disconnected). Self‑healing reconnected at stage 1 within 8 seconds. 3 trades experienced 200ms additional latency during the 8s window. No failed trades. Alert auto‑resolved at 14:59. Total customer impact: 8 seconds of degraded price freshness, zero order failures."

---

## For Product & Growth (Head of Product, VP Growth)

### 16. "How many users are active on the platform right now?"

The north‑star engagement metric. The MCP server derives real‑time active users from actual authenticated request telemetry — not analytics JavaScript that ad‑blockers strip out.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Active sessions, authenticated request rate, WebSocket connections |
| `metrics_query_range` | DAU/MAU trends, peak‑hour patterns, week‑over‑week growth |
| `logs_query` | Login events — count distinct users from auth logs |

**Example:**
> *"How many users are online right now?"*  
> → `metrics_query` for active WebSocket connections + authenticated request rate → "47 active WebSocket connections. 12 unique users made API calls in the last 5 minutes. Peak today: 63 concurrent at 14:30 UTC."

---

### 17. "What's our daily trade volume and how is it trending?"

Trade volume is the core product‑market‑fit signal for an exchange. The MCP server provides exact counts and USD notional from production telemetry — no reporting lag.

| Tool | What it does |
|------|-------------|
| `metrics_query` | Total orders today: `http_requests_total{path="/api/v1/orders",method="POST"}` |
| `metrics_query_range` | Volume trends — daily, weekly, monthly curves |
| `traces_search` | Individual trade traces — filter by pair, size, time window |
| `traces_operations` | Which trading operations are most active |

**Example:**
> *"What's today's trade volume?"*  
> → `metrics_query` for order counts + `metrics_query_range` for trend → "1,247 trades executed today (BTC/USD: 892, ETH/USD: 355). Up 18% vs same day last week. Average order size: 0.04 BTC. Peak trading hour: 13:00–14:00 UTC."

---

### 18. "Where are users dropping off in the signup‑to‑first‑trade funnel?"

Every step from registration to first trade is instrumented with OpenTelemetry spans. The MCP server lets you measure the actual conversion funnel from backend telemetry.

| Tool | What it does |
|------|-------------|
| `traces_search` | Find traces for each funnel step: registration, KYC, deposit, first order |
| `traces_operations` | List all operations per service — see which endpoints are called |
| `metrics_query` | Request counts per endpoint — compare signup vs deposit vs trade counts |
| `logs_query` | Error/validation failure logs at each step — why users fail |

**Example:**
> *"Where's the funnel leaking?"*  
> → `metrics_query` for request counts at each step → "Last 7 days: 340 registrations → 285 KYC completions (84%) → 142 first deposits (50%) → 98 first trades (69%). Biggest drop: KYC‑to‑deposit. `logs_query` shows 31 deposit attempts failed with 'unsupported currency' — users are trying to deposit EUR but only USD is enabled."

---

### 19. "Which features are users actually using?"

Feature adoption drives roadmap prioritization. Every API endpoint and UI action generates traces — the MCP server turns this into a usage heatmap.

| Tool | What it does |
|------|-------------|
| `traces_operations` | All operations called per service — natural feature usage signal |
| `metrics_query` | Request counts per endpoint, per time period |
| `metrics_query_range` | Adoption trends after feature launches |
| `traces_dependencies` | Which services a feature touches — understand complexity vs usage |

**Example:**
> *"Which features get the most use?"*  
> → `metrics_query` for request counts by endpoint → "Top 5 by volume: (1) GET /prices — 48,200/day, (2) GET /portfolio — 12,400/day, (3) POST /orders — 1,247/day, (4) GET /orderbook — 890/day, (5) POST /transfers — 67/day. ZK proof verification (GET /proofs/verify) called 340 times — users are actively checking trade fairness."

---

### 20. "Is poor performance driving users away?"

The link between engineering metrics and business outcomes. The MCP server correlates latency/error spikes with user activity drops — connecting SRE data to churn.

| Tool | What it does |
|------|-------------|
| `metrics_query_range` | Overlay latency P95 with active user count over time |
| `anomalies_active` | Current anomalies that may be impacting user experience |
| `anomalies_baselines` | What "normal" performance looks like — detect degradation before users notice |
| `traces_search` | Find user‑facing requests that exceeded acceptable latency |

**Example:**
> *"Did last night's slowdown affect users?"*  
> → `metrics_query_range` for P95 latency + active sessions over 24h → "P95 spiked to 1.2s between 02:00–02:15 UTC. Active WebSocket connections dropped from 28 to 19 during that window (32% drop). 6 users reconnected after the spike resolved. Anomaly detector classified it SEV‑3 (self‑healed via stage 1 reconnect in 8s)."

---

## Quick Reference: All 23 Tools

| Domain | Tool | Purpose |
|--------|------|---------|
| **Traces** | `traces_search` | Find traces by service, operation, tags, duration |
| | `trace_get` | Full trace detail — all spans, timing, tags, logs |
| | `traces_services` | List all traced services |
| | `traces_operations` | List operations for a service |
| | `traces_dependencies` | Service dependency graph with call counts |
| **Metrics** | `metrics_query` | Instant PromQL query |
| | `metrics_query_range` | Time‑series PromQL query |
| | `metrics_targets` | Prometheus scrape target health |
| | `metrics_alerts` | Alert rules and their state |
| | `metrics_metadata` | Metric type, help, unit |
| | `metrics_label_values` | Label value enumeration |
| **Logs** | `logs_query` | LogQL query for log lines |
| | `logs_labels` | Available log label names |
| | `logs_label_values` | Values for a log label |
| | `logs_tail_context` | Logs correlated with a trace ID |
| **ZK Proofs** | `zk_proof_get` | Retrieve trade proof |
| | `zk_proof_verify` | Verify trade proof |
| | `zk_solvency` | Latest solvency proof |
| | `zk_stats` | Aggregate proof statistics |
| **System** | `anomalies_active` | Current anomalies (SEV 1–5) |
| | `anomalies_baselines` | Anomaly detection baselines per operation |
| | `system_health` | Full system health check |
| | `system_topology` | Service dependency topology with health overlays |

---

## CLI Client

The companion `otel-mcp-client` CLI provides direct access for operators:

```bash
otel-mcp-client report --range 1d        # Full cluster health report
otel-mcp-client health                    # Quick system health
otel-mcp-client targets                   # Prometheus target status
otel-mcp-client traces --service api      # Recent traces for a service
otel-mcp-client query metrics_query '{"query":"up"}'   # Raw tool call
otel-mcp-client tools                     # List all available tools
```

**Config:** `MCP_URL` + `MCP_API_KEY` environment variables.
