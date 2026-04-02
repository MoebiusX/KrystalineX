# OTEL MCP Server — Top 10 Questions It Answers

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
