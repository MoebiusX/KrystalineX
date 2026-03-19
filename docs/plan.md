# KrystalineX Observability Gap Closure — Full Analysis

**Date:** 2026-03-18
**Scope:** All 12 capabilities scoring below 9/10
**Phases:** 1) Architectural Solutions · 2) Implementation Details · 3) Benefit/Cost Prioritization

---

## Capability 1: Unified Telemetry Model & Semantic Consistency (8 → 9)

**Current gap:** No formal telemetry schema versioning. Legacy format bridging is ad-hoc (`paymentId` → `orderId`).

### Solution: Telemetry Contract Registry

| Component | Standard Approach |
|---|---|
| **Schema registry** | Define a `telemetry-contracts/` directory with versioned JSON Schema files for span attributes, metric labels, and log fields per service. Validate at CI time. |
| **Attribute catalog** | Create a shared `TELEMETRY_ATTRIBUTES` TypeScript enum/const exported from `shared/` that all services import — ensures attribute name consistency at compile time. |
| **Resource attribute standardization** | Add `deployment.environment`, `service.version` (from `package.json`), and `service.instance.id` (from hostname/pod name) to the OTEL resource in `server/otel.ts`. Browser already sets `service.version: '1.0.0'` — make it dynamic. |
| **Migration path** | Add deprecation warnings when legacy `paymentId`/`correlationId` formats are received in `rabbitmq-client.ts`. Set a removal target version. |

**Dependencies:** None — purely additive.
**Risk:** Low.
**Estimated effort:** S (1–2 days)

---

## Capability 3: Context Propagation Across the Stack (7 → 9)

**Current gaps:** No Prometheus exemplars. No feature flag propagation. User ID not consistently added to spans. No experiment cohort tracking.

### Solution A: Prometheus Exemplars

| Component | Standard Approach |
|---|---|
| **Exemplar support** | `prom-client` v15 supports exemplars natively. Add `exemplarLabels: { traceID: traceId }` to histogram observations in `prometheus.ts` when recording `http_request_duration_seconds`. |
| **Grafana exemplar display** | Grafana natively renders exemplar dots on graphs linked to Jaeger. Already have both datasources provisioned — just needs the exemplar data. |

### Solution B: Systematic User Context

| Component | Standard Approach |
|---|---|
| **userId in spans** | In the `authenticateToken` middleware, after verifying JWT, call `span.setAttribute('enduser.id', userId)` using the OTEL semantic convention for end-user identity. This propagates automatically to child spans. |
| **Baggage propagation** | Use OTEL Baggage API to propagate `userId` and `tenantId` across service boundaries without manual header plumbing. Add `W3CBaggagePropagator` to the propagator list in `server/otel.ts`. |

### Solution C: Feature Flag Context (if/when feature flags are adopted)

| Component | Standard Approach |
|---|---|
| **Span attributes** | When a feature flag is evaluated, add `feature_flag.key` and `feature_flag.variant` to the active span. This is an emerging OTEL semantic convention. |
| **Prerequisite** | Requires a feature flag system (LaunchDarkly, Unleash, or env-var-based). Not needed until feature flags are introduced. |

**Dependencies:** Exemplars require Grafana datasource config update (set exemplar toggle on Prometheus datasource).
**Risk:** Low.
**Estimated effort:** S–M (2–3 days)

---

## Capability 4: Causal Inference & Dependency Mapping (5 → 9)

**Current gaps:** No programmatic service topology. No blast radius analysis. Jaeger service map is implicit/UI-only.

### Solution A: Service Dependency Graph

| Component | Standard Approach |
|---|---|
| **Jaeger Dependencies API** | Jaeger exposes `GET /api/dependencies?endTs=...&lookback=...` returning a JSON service graph. Create a `server/monitor/topology-service.ts` that polls this API periodically and caches the result. |
| **Dependency graph storage** | Store edges in PostgreSQL: `service_dependencies(source, target, call_count, error_rate, p99_latency, updated_at)`. Update every 5 minutes from Jaeger. |
| **API exposure** | Add `GET /api/monitor/topology` returning the current service graph with health overlays (error rate, latency per edge). |

### Solution B: Blast Radius Analysis

| Component | Standard Approach |
|---|---|
| **Graph traversal** | Given the dependency graph, implement `getBlastRadius(service)` — BFS/DFS traversal of downstream dependents. Returns all services + SLOs impacted by degradation of the input service. |
| **SLO linkage** | Once SLOs exist (Capability 5), tag each SLO with its dependent services. Blast radius query then returns "if kx-matcher degrades, the Order Completion SLO and Trade Latency SLO are at risk." |
| **Dashboard** | Add a Grafana panel or React component showing the live topology with color-coded health status. |

**Dependencies:** Jaeger Dependencies API (already available). SLO linkage depends on Capability 5.
**Risk:** Medium — Jaeger Dependencies API quality depends on trace volume.
**Estimated effort:** M (3–5 days)

---

## Capability 5: SLO-Driven Observability (3 → 9)

**Current gaps:** No error budgets, no burn rate alerts, no SLO enforcement. Only two hardcoded SLA threshold alerts.

### Solution: Multi-Window Burn Rate Framework (Google SRE pattern)

#### Step 1: Define SLIs and SLOs

| SLO | SLI Metric | Target | Error Budget (30d) |
|---|---|---|---|
| **Availability** | `1 - (5xx / total)` | 99.9% | 43.2 min |
| **Trade Latency** | `P95(order_processing_duration_seconds)` | ≤ 500ms | 0.1% of requests |
| **Price Freshness** | `time_since_last_price_update` | ≤ 5s | 43.2 min stale |
| **Order Success Rate** | `1 - (failed_orders / total_orders)` | 99.5% | 3.6 hours |

#### Step 2: Recording Rules (Prometheus)

```yaml
# Add to config/slo-recording-rules.yml
groups:
  - name: slo_recording
    rules:
      # Error ratio over multiple windows
      - record: slo:http_error_ratio:rate5m
        expr: sum(rate(http_request_errors_total[5m])) / sum(rate(http_requests_total[5m]))
      - record: slo:http_error_ratio:rate1h
        expr: sum(rate(http_request_errors_total[1h])) / sum(rate(http_requests_total[1h]))
      - record: slo:http_error_ratio:rate6h
        expr: sum(rate(http_request_errors_total[6h])) / sum(rate(http_requests_total[6h]))
```

#### Step 3: Multi-Window Burn Rate Alerts

```yaml
# Fast burn: 14.4x budget consumption over 1h → exhausts in 2 days
- alert: SLOFastBurn_Availability
  expr: slo:http_error_ratio:rate1h / (1 - 0.999) > 14.4
  for: 2m
  labels: { severity: critical, slo: availability }

# Slow burn: 6x budget consumption over 6h → exhausts in 5 days  
- alert: SLOSlowBurn_Availability
  expr: slo:http_error_ratio:rate6h / (1 - 0.999) > 6
  for: 15m
  labels: { severity: warning, slo: availability }
```

#### Step 4: Error Budget Tracking Dashboard

| Component | Standard Approach |
|---|---|
| **Grafana dashboard** | Create `slo-dashboard.json` with panels: remaining budget %, burn rate trend, budget forecast line, SLO compliance history. |
| **Budget API** | Add `GET /api/monitor/slo` returning current SLI values, budget remaining, burn rate, and forecast. |

#### Step 5: Enforcement (later, ties to Capability 8)

| Component | Standard Approach |
|---|---|
| **Deploy gate** | CI step queries `/api/monitor/slo` — block deploy if burn rate > 1.0. |
| **Traffic shedding** | When budget < 10%, enable aggressive rate limiting on non-critical endpoints. |

**Dependencies:** Prometheus recording rules infrastructure (already exists). Replace existing `AvailabilitySLABreach` and `LatencySLABreach` alerts.
**Risk:** Medium — requires careful threshold calibration to avoid alert fatigue.
**Estimated effort:** M–L (4–6 days)

---

## Capability 6: Advanced Alerting — Signal over Noise (8 → 9)

**Current gaps:** Alert deduplication relies on Alertmanager defaults. No codified ownership routing. Circuit breaker metrics referenced in alerts but not exported from code.

### Solution A: Fix Circuit Breaker Metrics Gap

| Component | Standard Approach |
|---|---|
| **Export metrics** | The `prometheus.ts` file defines `circuit_breaker_state` and `circuit_breaker_trips_total` metrics, but the `circuit-breaker.ts` class doesn't call them. Wire the `onStateChange` callback to call `recordCircuitBreakerTrip()` and update the gauge. |
| **Impact** | Fixes 2 dead alert rules (`CircuitBreakerOpen`, `CircuitBreakerHalfOpen`) that currently can never fire. |

### Solution B: Ownership Routing

| Component | Standard Approach |
|---|---|
| **Team labels** | Add `team: trading`, `team: platform`, `team: security` labels to alert rules. |
| **Alertmanager routing** | Add `match: { team: trading }` routes pointing to trading team's GoAlert integration or Slack channel. |
| **Runbook links** | Add `runbook_url` annotation to every alert rule, linking to the relevant section of `docs/operations/04_RUNBOOK.md`. |

### Solution C: Alert Deduplication

| Component | Standard Approach |
|---|---|
| **Alertmanager grouping** | Tune `group_by`, `group_wait`, `group_interval` per route. Current default grouping by `[alertname, severity, service]` is reasonable. |
| **Inhibition rules** | Already has 2 inhibition rules (severity cascade + ServiceDown suppression). Add: if `PostgreSQLDown` fires, suppress `SlowQueries` and `DatabaseConnectionsHigh`. |

**Dependencies:** None.
**Risk:** Low.
**Estimated effort:** S (1–2 days)

---

## Capability 8: Observability-Driven CI/CD Integration (1 → 9)

**Current gaps:** CI runs type-check + unit tests only. No observability gates, no canary, no telemetry validation.

### Solution: Phased CI/CD Observability Gates

#### Phase A: Static Validation (add to existing CI)

| Gate | Tool | Implementation |
|---|---|---|
| **Prometheus rule syntax** | `promtool check rules` | Add step: `docker run prom/prometheus promtool check rules config/alerting-rules.yml` |
| **OTEL config validation** | `otelcol validate` | Add step: `docker run otel/opentelemetry-collector-contrib validate --config config/otel-collector-config.yaml` |
| **Alert rule unit tests** | `promtool test rules` | Create `config/alerting-rules-test.yml` with expected firing scenarios. |
| **Secrets scan** | Already exists | `npm run security:secrets` — add to CI workflow. |

#### Phase B: Instrumentation Smoke Test

| Gate | Implementation |
|---|---|
| **Trace emission test** | Integration test that submits an order, then queries Jaeger API to verify a trace was created with expected span count (≥5 spans). |
| **Metrics endpoint test** | `curl localhost:5000/metrics | grep http_requests_total` — verify Prometheus metrics are being emitted. |

#### Phase C: Deploy-Time Observability Gates (requires SLOs from Capability 5)

| Gate | Implementation |
|---|---|
| **Error budget check** | Pre-deploy step queries Prometheus: `slo:http_error_ratio:rate1h / (1 - 0.999)`. If burn rate > 1.0, block deploy. |
| **Canary analysis** | Deploy to canary, wait 5 min, compare canary error rate vs. baseline. Promote if within tolerance. Use Argo Rollouts or Flagger for automated canary. |

**Dependencies:** Phase C depends on Capability 5 (SLO framework). Phases A & B are independent.
**Risk:** Low for A/B, Medium for C (requires canary infrastructure).
**Estimated effort:** S (Phase A: 1 day), M (Phase B: 2 days), L (Phase C: 5–7 days)

---

## Capability 9: Data Volume & Cost Governance (2 → 9)

**Current gaps:** No sampling strategy. No retention policies. No tiered storage. All spans exported.

### Solution A: Tail-Based Sampling (OTEL Collector)

| Component | Standard Approach |
|---|---|
| **Processor** | Add `tail_sampling` processor to `config/otel-collector-config.yaml`. |
| **Policies** | (1) Always keep errors (`status_code: ERROR`), (2) Always keep slow traces (`latency > 500ms`), (3) Probabilistic 10% for normal traces. |
| **Pipeline order** | `receivers → tail_sampling → batch → exporters` (never batch before sampling). |
| **Expected reduction** | ~80–90% trace volume reduction while keeping 100% of interesting traces. |

```yaml
# Proposed addition to otel-collector-config.yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    policies:
      - name: always-sample-errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: always-sample-slow
        type: latency
        latency: { threshold_ms: 500 }
      - name: sample-normal
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
```

### Solution B: Retention Policies

| Backend | Current | Proposed |
|---|---|---|
| **Prometheus** | Default 15d | Set `--storage.tsdb.retention.time=30d` and `--storage.tsdb.retention.size=10GB` |
| **Loki** | No retention | Add `retention_period: 14d` to `loki-config.yaml` limits_config |
| **Jaeger** | In-memory | Switch to Elasticsearch or Badger backend with 7d retention for detailed traces, 30d for indexed metadata |

### Solution C: Cardinality Control

| Component | Standard Approach |
|---|---|
| **Prometheus** | Add `metric_relabel_configs` to drop high-cardinality labels (e.g., individual user IDs, trace IDs in labels). |
| **OTEL Collector** | Add `filter` processor to drop spans from noisy internal operations. Add `attributes` processor to remove PII from span attributes. |
| **Monitoring** | Add `prometheus_tsdb_head_series` alert when cardinality exceeds threshold. |

**Dependencies:** Tail-based sampling requires OTEL Collector Contrib image (already in use).
**Risk:** Medium — sampling policy tuning requires iteration. Retention changes may lose historical data.
**Estimated effort:** M (3–4 days)

---

## Capability 10: User-Centric Observability (5 → 9)

**Current gaps:** No Web Vitals. No session replay. Browser OTEL only captures fetch() timing.

### Solution A: Core Web Vitals

| Component | Standard Approach |
|---|---|
| **Library** | Add `web-vitals` npm package (Google's official library). |
| **Metrics collection** | On each page load, capture LCP, FID/INP, CLS, FCP, TTFB. Report as OTEL spans or Prometheus push metrics. |
| **Implementation** | In `client/src/lib/otel.ts`, after `initBrowserOtel()`, register `web-vitals` callbacks that create OTEL spans with the measured values as attributes. |

```typescript
// Example integration
import { onLCP, onINP, onCLS } from 'web-vitals';

function reportWebVital(metric) {
  const span = tracer.startSpan(`web-vital.${metric.name}`);
  span.setAttribute('web_vital.value', metric.value);
  span.setAttribute('web_vital.rating', metric.rating); // 'good' | 'needs-improvement' | 'poor'
  span.end();
}

onLCP(reportWebVital);
onINP(reportWebVital);
onCLS(reportWebVital);
```

### Solution B: User Session Correlation

| Component | Standard Approach |
|---|---|
| **Session ID** | Generate a session ID on app load, store in sessionStorage. Add as OTEL resource attribute `session.id`. |
| **User journey mapping** | Add `page.name` and `page.path` span attributes to browser fetch spans. Enables filtering traces by page. |

### Solution C: Session Replay (optional, higher effort)

| Component | Standard Approach |
|---|---|
| **Open-source option** | OpenReplay (self-hosted) or rrweb (library). |
| **Integration** | rrweb records DOM changes as events. Link each recording session to the OTEL session ID for trace↔replay correlation. |
| **Privacy** | Must mask sensitive fields (passwords, wallet addresses, balances). Configure input masking rules. |

**Dependencies:** `web-vitals` package (tiny, no other deps). Session replay requires dedicated storage backend.
**Risk:** Low for A/B. Medium for C (privacy, storage, replay UI).
**Estimated effort:** S (A+B: 2 days), L (C: 5–8 days, optional)

---

## Capability 11: Security & Compliance Observability (8 → 9)

**Current gap:** No SIEM integration. Security data siloed within PostgreSQL + Prometheus.

### Solution: Security Event Shipping

| Component | Standard Approach |
|---|---|
| **OTEL Log Exporter** | Add `@opentelemetry/exporter-logs-otlp-http` to ship security events as OTEL log records through the Collector. Collector can then fan out to Loki + external SIEM. |
| **Loki security stream** | Tag security events with `{job="security", severity="..."}` labels. Create Grafana alerting rules on Loki log patterns. |
| **SIEM webhook (lightweight)** | Add a configurable webhook in `security-events.ts` — on HIGH/CRITICAL events, POST to an external URL (Splunk HEC, Datadog Logs API, or generic webhook). No vendor lock-in. |
| **Audit log immutability** | Add a `security_events_hash` column using SHA-256 chain (each row hashes previous row's hash + current event data). Enables tamper detection. |

**Dependencies:** Loki must be enabled (currently disabled in Helm values).
**Risk:** Low.
**Estimated effort:** S–M (2–3 days)

---

## Capability 12: Programmability & Extensibility (7 → 9)

**Current gap:** No SQL-over-telemetry data lake. Only one Grafana dashboard.

### Solution A: Additional Grafana Dashboards

| Dashboard | Content | Source |
|---|---|---|
| **Database Health** | Connection pool, query latency, table sizes, replication lag | `postgres-exporter` metrics |
| **RabbitMQ** | Queue depth, consumer count, message rates, memory | `rabbitmq` metrics |
| **Security Events** | Failed logins, rate limits, brute force timeline | `kx_security_events_total` |
| **Infrastructure** | CPU, memory, disk, network per service | `node-exporter` metrics |
| **SLO Dashboard** | Error budgets, burn rates, compliance history | SLO recording rules (Capability 5) |

### Solution B: Telemetry Query API

| Component | Standard Approach |
|---|---|
| **PromQL proxy** | Expose `GET /api/monitor/query?promql=...` that proxies to Prometheus, with auth + rate limiting. Enables custom ad-hoc queries from the UI. |
| **Trace search API** | Expose `GET /api/monitor/traces?service=...&minDuration=...&tags=...` proxying to Jaeger's search API. |

**Dependencies:** Capability 5 for SLO dashboard.
**Risk:** Low.
**Estimated effort:** M (3–4 days for dashboards), S (1 day for query API)

---

## Capability 13: Cross-Domain Correlation (7 → 9)

**Current gap:** No deployment event correlation. No ticket system integration.

### Solution A: Deployment Event Annotations

| Component | Standard Approach |
|---|---|
| **Deployment marker** | At the end of CI/CD deploy, POST to `POST /api/monitor/events` with `{ type: "deployment", version: "...", commit: "...", deployer: "..." }`. Store in PostgreSQL. |
| **Grafana annotations** | Configure Grafana annotation source from the events API. Deployment lines appear on all dashboards — instant "did a deploy cause this?" correlation. |
| **RCA integration** | Feed deployment events to `metrics-correlator.ts`. When analyzing an anomaly, check if a deployment occurred within ±10 minutes. Include in LLM prompt context. |

### Solution B: Business Impact Correlation

| Component | Standard Approach |
|---|---|
| **Revenue impact** | When an anomaly is detected on trade endpoints, query `kx_trade_value_usd_total` rate before/after. Report estimated revenue impact in LLM analysis context. |
| **User impact** | Query `kx_active_users_current` during anomaly window. Report "X active users affected." |

**Dependencies:** Solution A requires a CI/CD deploy step (ties to Capability 8). Solution B uses existing metrics.
**Risk:** Low.
**Estimated effort:** S–M (2–3 days)

---

## Capability 14: Self-Healing & Automation (3 → 9)

**Current gaps:** Circuit breakers are passive. No auto-remediation. Alert → human is the only path. No closed-loop automation.

### Solution A: Alert-Triggered Runbooks (Alertmanager Webhooks)

| Component | Standard Approach |
|---|---|
| **Webhook handler** | Create `server/monitor/auto-remediation.ts` — an Express endpoint that receives Alertmanager webhook POSTs and executes predefined remediation actions. |
| **Safe actions** | Start with low-risk automated responses: (1) restart a specific pod via K8s API, (2) flush RabbitMQ dead-letter queue, (3) clear connection pool, (4) toggle rate limit thresholds. |
| **Audit trail** | Log every automated action to `remediation_events` table with alert context, action taken, and outcome. |
| **Kill switch** | Environment variable `AUTO_REMEDIATION_ENABLED=true` — disabled by default. Each action has its own enable flag. |

### Solution B: Kubernetes-Native Self-Healing

| Component | Standard Approach |
|---|---|
| **Pod Disruption Budgets** | Add PDBs to prevent simultaneous pod termination: `minAvailable: 1` for server, payment-processor. |
| **Custom metrics HPA** | Use Prometheus Adapter to expose `http_request_duration_seconds_p99` as a K8s custom metric. Scale on latency, not just CPU. |
| **Topology spread constraints** | Ensure pods spread across nodes/zones for resilience. |

### Solution C: Progressive Delivery (advanced, ties to Capability 8)

| Component | Standard Approach |
|---|---|
| **Argo Rollouts or Flagger** | Automated canary analysis: deploy to 10% traffic, monitor error rate + latency via Prometheus, auto-promote or rollback. |
| **Integration** | Argo Rollouts queries Prometheus AnalysisTemplates. If canary error rate > baseline + threshold, automatic rollback. |

**Dependencies:** Solution A is standalone. Solution B requires K8s + Prometheus Adapter. Solution C requires Argo Rollouts or Flagger.
**Risk:** Medium for A (automated actions need careful safety bounds), High for C (new infrastructure).
**Estimated effort:** M (A: 3–4 days), M (B: 2–3 days), L (C: 5–8 days)

---

## Summary: All Capabilities at a Glance

| # | Capability | Current | Target | Solution Approach | Effort | Dependencies |
|---|---|---|---|---|---|---|
| 1 | Telemetry Model | 8 | 9 | Attribute catalog + resource enrichment | S (1–2d) | None |
| 3 | Context Propagation | 7 | 9 | Exemplars + userId in spans + Baggage API | S–M (2–3d) | Grafana config |
| 4 | Causal Inference | 5 | 9 | Jaeger Dependencies API + blast radius graph | M (3–5d) | Cap 5 for SLO linkage |
| 5 | SLO-Driven | 3 | 9 | Multi-window burn rate alerts + budget API | M–L (4–6d) | Prometheus recording rules |
| 6 | Advanced Alerting | 8 | 9 | Fix circuit breaker metrics + ownership routing | S (1–2d) | None |
| 8 | CI/CD Integration | 1 | 9 | Phased: static validation → smoke tests → deploy gates | S+M+L (8–10d) | Cap 5 for deploy gates |
| 9 | Cost Governance | 2 | 9 | Tail sampling + retention policies + cardinality control | M (3–4d) | OTEL Collector Contrib |
| 10 | User-Centric | 5 | 9 | Web Vitals + session correlation (+ optional replay) | S (2d) + optional L | `web-vitals` package |
| 11 | Security Compliance | 8 | 9 | SIEM webhook + OTEL log export | S–M (2–3d) | Loki enabled |
| 12 | Programmability | 7 | 9 | Additional dashboards + query API | M (3–4d) | Cap 5 for SLO dashboard |
| 13 | Cross-Domain | 7 | 9 | Deployment annotations + business impact in RCA | S–M (2–3d) | Cap 8 for deploy events |
| 14 | Self-Healing | 3 | 9 | Alert-triggered runbooks + PDBs + custom HPA metrics | M+L (10–15d) | K8s, Cap 5 |

**Total estimated effort: ~40–55 dev-days** (all capabilities to 9/10)

---

## Dependency Graph

```
Independent (can start immediately):
  ├── Cap 1: Telemetry Model
  ├── Cap 6: Advanced Alerting (fix circuit breaker metrics)
  ├── Cap 9: Cost Governance (sampling + retention)
  ├── Cap 10: User-Centric (Web Vitals)
  └── Cap 11: Security Compliance (SIEM webhook)

Foundational (enables others):
  └── Cap 5: SLO Framework
        ├── enables Cap 4: Causal Inference (SLO linkage)
        ├── enables Cap 8: CI/CD Gates (error budget check)
        ├── enables Cap 12: Programmability (SLO dashboard)
        └── enables Cap 14: Self-Healing (budget-based scaling)

Sequential:
  Cap 3: Context Propagation → after Cap 1 (consistent attributes)
  Cap 8: CI/CD Integration → Phase A independent, Phase C after Cap 5
  Cap 13: Cross-Domain → deploy annotations after Cap 8

Recommended execution order:
  1. Cap 6 + Cap 9 + Cap 1 (quick wins, no dependencies)
  2. Cap 5 (SLO framework — unlocks 4 other capabilities)
  3. Cap 3 + Cap 10 + Cap 11 (parallel, independent)
  4. Cap 8 Phase A+B + Cap 12 (validation + dashboards)
  5. Cap 4 + Cap 13 (dependency mapping + correlation)
  6. Cap 14 + Cap 8 Phase C (self-healing + deploy gates — highest effort)
```

---

---
---

# PHASE 2: Implementation Details — Files, Dependencies, Critical Path

For each capability, this section identifies: exact files to modify/create, specific code changes, npm packages required, config changes, and the critical path through the work.

---

## Cap 6: Advanced Alerting — Implementation Details

### Files to Modify

| # | File | Change | Lines |
|---|------|--------|-------|
| 1 | `server/services/rabbitmq-client.ts` | Wire `onStateChange` to metrics | ~54-61 |
| 2 | `config/alerting-rules.yml` | Fix PromQL for circuit breaker alerts | ~308-335 |
| 3 | `config/alerting-rules.yml` | Add `team` labels + `runbook_url` annotations | All alert groups |

### Critical Code Change

**`server/services/rabbitmq-client.ts`** — The `onStateChange` callback exists but doesn't call metrics:
```typescript
// CURRENT (broken):
onStateChange: (from, to) => {
    logger.warn({ from, to }, 'RabbitMQ circuit breaker state changed');
}

// FIX: Add one line:
import { recordCircuitBreakerTrip } from '../metrics/prometheus';
onStateChange: (from, to) => {
    logger.warn({ from, to }, 'RabbitMQ circuit breaker state changed');
    recordCircuitBreakerTrip('rabbitmq', from, to);  // ← ADD
}
```

**`config/alerting-rules.yml`** — Alert PromQL uses wrong label selector:
```yaml
# CURRENT (broken — uses {state="open"} but metric has {service} label only):
- alert: CircuitBreakerOpen
  expr: circuit_breaker_state{state="open"} == 1

# FIX:
- alert: CircuitBreakerOpen
  expr: circuit_breaker_state == 1    # 1 = OPEN state
  labels:
    team: platform
  annotations:
    runbook_url: "docs/operations/04_RUNBOOK.md#circuit-breaker"
```

### Packages: None needed (all already installed)
### Dependencies: None — can start immediately
### Verification: After fix, trigger circuit breaker in test → verify `circuit_breaker_trips_total` counter increments in Prometheus

---

## Cap 9: Cost Governance — Implementation Details

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `config/otel-collector-config.yaml` | Add `tail_sampling` + `memory_limiter` processors |
| 2 | `config/loki-config.yaml` | Add `retention_period: 14d` |
| 3 | `docker-compose.yml` | Add Prometheus retention flags |
| 4 | `k8s/charts/krystalinex/templates/configmaps.yaml` | Mirror OTEL changes |
| 5 | `server/otel.ts` | Switch Jaeger exporter to `BatchSpanProcessor` |

### Critical Code Change

**`config/otel-collector-config.yaml`** — Replace entire processors section:
```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    policies:
      - name: always-sample-errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: always-sample-slow
        type: latency
        latency: { threshold_ms: 500 }
      - name: sample-normal
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    timeout: 1s
    send_batch_size: 1024

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]  # ORDER MATTERS
      exporters: [otlp/jaeger]
```

**`server/otel.ts`** — Switch from `SimpleSpanProcessor` to `BatchSpanProcessor`:
```typescript
// CURRENT:
new SimpleSpanProcessor(jaegerExporter)
// FIX:
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
new BatchSpanProcessor(jaegerExporter)
```

**`docker-compose.yml`** — Add retention flags to Prometheus:
```yaml
command:
  - '--storage.tsdb.retention.time=30d'
  - '--storage.tsdb.retention.size=10GB'
```

### Packages: None (OTEL Collector Contrib image already used ✅)
### Dependencies: None — can start immediately
### Verification: Deploy, wait 10 min, check Jaeger trace count is ~10% of pre-sampling volume

---

## Cap 1: Telemetry Model — Implementation Details

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/otel.ts` | Add `Resource` attributes: `deployment.environment`, `service.version`, `service.instance.id` |
| 2 | `shared/telemetry-attributes.ts` | **NEW** — Shared attribute name constants |
| 3 | `payment-processor/index.ts` | Add deprecation log for `paymentId` field |

### Critical Code Change

**`server/otel.ts`** — Currently has no explicit Resource config:
```typescript
// ADD before NodeSDK initialization:
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } from '@opentelemetry/semantic-conventions';
import pkg from '../package.json';
import os from 'os';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: 'kx-exchange',
  [ATTR_SERVICE_VERSION]: pkg.version,
  [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  'service.instance.id': os.hostname(),
  'service.namespace': 'krystalinex',
});
```

**`shared/telemetry-attributes.ts`** — New file:
```typescript
export const TELEMETRY_ATTRIBUTES = {
  ORDER_ID: 'business.order_id',
  WALLET_ID: 'business.wallet_id',
  TRADE_PAIR: 'business.trade_pair',
  TRADE_SIDE: 'business.trade_side',
  CORRELATION_ID: 'messaging.correlation_id',
  USER_ID: 'enduser.id',
  SESSION_ID: 'session.id',
} as const;
```

### Packages: None needed
### Dependencies: None — can start immediately
### Verification: Check Jaeger spans show `service.version`, `deployment.environment` attributes

---

## Cap 5: SLO Framework — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `config/slo-recording-rules.yml` | **NEW** — Prometheus recording rules for SLI windows |
| 2 | `config/alerting-rules.yml` | Replace `AvailabilitySLABreach`/`LatencySLABreach` with burn rate alerts |
| 3 | `prometheus.yml` | Add `recording-rules.yml` to `rule_files` |
| 4 | `docker-compose.yml` | Mount new recording rules file |
| 5 | `server/monitor/routes.ts` | Add `GET /api/v1/monitor/slo` endpoint |
| 6 | `k8s/charts/krystalinex/templates/configmaps.yaml` | Mirror Prometheus config |

### Exact Metrics Available (from `server/metrics/prometheus.ts`)

| Metric | Type | Labels |
|--------|------|--------|
| `http_requests_total` | Counter | `method`, `route`, `status_code` |
| `http_request_errors_total` | Counter | `method`, `route`, `status_code` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |
| `order_processing_duration_seconds` | Histogram | `side` |

### Critical Code Change

**`config/slo-recording-rules.yml`** — New file:
```yaml
groups:
  - name: slo.availability
    interval: 30s
    rules:
      - record: slo:error_ratio:rate5m
        expr: sum(rate(http_request_errors_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
      - record: slo:error_ratio:rate1h
        expr: sum(rate(http_request_errors_total{status_code=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))
      - record: slo:error_ratio:rate6h
        expr: sum(rate(http_request_errors_total{status_code=~"5.."}[6h])) / sum(rate(http_requests_total[6h]))
      - record: slo:error_budget_remaining:30d
        expr: 1 - (sum(increase(http_request_errors_total{status_code=~"5.."}[30d])) / sum(increase(http_requests_total[30d]))) / (1 - 0.999)

  - name: slo.latency
    interval: 30s
    rules:
      - record: slo:latency_p95:5m
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
      - record: slo:latency_p99:5m
        expr: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

**`config/alerting-rules.yml`** — Replace existing SLA alerts with burn rate:
```yaml
  - name: krystalinex.slo
    rules:
      - alert: SLOFastBurn_Availability
        expr: slo:error_ratio:rate1h / (1 - 0.999) > 14.4
          AND slo:error_ratio:rate5m / (1 - 0.999) > 14.4
        for: 2m
        labels: { severity: critical, slo: availability, team: platform }
        annotations:
          summary: "Availability SLO fast burn — budget exhausts in ~2 days"

      - alert: SLOSlowBurn_Availability
        expr: slo:error_ratio:rate6h / (1 - 0.999) > 6
          AND slo:error_ratio:rate1h / (1 - 0.999) > 6
        for: 15m
        labels: { severity: warning, slo: availability, team: platform }
        annotations:
          summary: "Availability SLO slow burn — budget exhausts in ~5 days"
```

**`server/monitor/routes.ts`** — Add SLO API (after existing endpoints):
```typescript
router.get('/slo', async (req, res) => {
  const promUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const [errorRatio, budget, latencyP95] = await Promise.all([
    queryPrometheus(promUrl, 'slo:error_ratio:rate1h'),
    queryPrometheus(promUrl, 'slo:error_budget_remaining:30d'),
    queryPrometheus(promUrl, 'slo:latency_p95:5m'),
  ]);
  res.json({ availability: { target: 0.999, current: 1 - errorRatio, budgetRemaining: budget },
             latency: { targetP95Ms: 500, currentP95Ms: latencyP95 * 1000 } });
});
```

### Packages: None needed
### Dependencies: Prometheus recording rules infrastructure (already exists)
### Critical path: This is FOUNDATIONAL — Caps 4, 8C, 12, 14 depend on it
### Verification: Query `slo:error_ratio:rate1h` in Prometheus → should return a value

---

## Cap 3: Context Propagation — Implementation Details

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/metrics/prometheus.ts` | Add exemplar data to `.observe()` calls |
| 2 | `server/otel.ts` | Add `W3CBaggagePropagator` to propagator list |
| 3 | `server/index.ts` | Add middleware to set `enduser.id` on active span |

### Critical Code Change

**`server/metrics/prometheus.ts`** — prom-client v15.1.3 ✅ supports exemplars:
```typescript
// CURRENT (line ~221):
httpRequestDuration.observe({ method, route }, durationMs);

// FIX — add exemplar:
import { trace } from '@opentelemetry/api';
const span = trace.getActiveSpan();
const traceId = span?.spanContext().traceId;
httpRequestDuration.observe({ method, route }, durationMs,
  traceId ? { traceID: traceId } : undefined  // exemplar label
);
```

**`server/index.ts`** — Add userId propagation after auth middleware:
```typescript
import { trace } from '@opentelemetry/api';
// After authenticate middleware resolves req.user:
app.use((req, res, next) => {
  if (req.user?.id) {
    const span = trace.getActiveSpan();
    span?.setAttribute('enduser.id', String(req.user.id));
  }
  next();
});
```

### Packages: None needed (prom-client 15.1.3 ✅, OTEL API ✅)
### Dependencies: Cap 1 (consistent attribute names)
### Verification: In Grafana, enable exemplars on Prometheus datasource → exemplar dots appear on latency graphs

---

## Cap 10: User-Centric Observability — Implementation Details

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `client/src/lib/otel.ts` | Add web-vitals callbacks after `initBrowserOtel()` |
| 2 | `package.json` | Add `web-vitals` dependency |

### Critical Code Change

**`client/src/lib/otel.ts`** — Add after OTEL initialization (after `otelEnabled = true`):
```typescript
import { onLCP, onINP, onCLS, onFCP, onTTFB } from 'web-vitals';

function reportWebVital(metric: { name: string; value: number; rating: string }) {
  const span = tracer.startSpan(`web-vital.${metric.name}`);
  span.setAttribute('web_vital.value', metric.value);
  span.setAttribute('web_vital.rating', metric.rating);
  span.end();
}

onLCP(reportWebVital);
onINP(reportWebVital);
onCLS(reportWebVital);
onFCP(reportWebVital);
onTTFB(reportWebVital);
```

### Packages: `web-vitals` ^4.0.0 (NOT currently installed — `npm install web-vitals`)
### Dependencies: None
### Verification: Open app in browser → check Jaeger for `web-vital.lcp`, `web-vital.inp` spans

---

## Cap 11: Security Compliance — Implementation Details

### Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/observability/security-events.ts` | Add SIEM webhook export on HIGH/CRITICAL events |
| 2 | `k8s/charts/krystalinex/values.yaml` | Enable Loki by default |
| 3 | `k8s/charts/krystalinex/values-local.yaml` | Already has `loki.enabled: true` ✅ |

### Current Security Infrastructure (already robust)

- `security_events` table in PostgreSQL with traceId correlation
- `kx_security_events_total` Prometheus counter (labels: `event_type`, `severity`)
- 8 security alert rules in Alertmanager (brute force, credential stuffing, token enumeration, etc.)
- Events: `login_success`, `login_failed`, `2fa_failed`, `rate_limit_exceeded`, `invalid_token`, `token_expired`, `anomaly_detected`, `session_created`, `session_revoked`

### Critical Code Change

**`server/observability/security-events.ts`** — Add webhook export:
```typescript
// Add configurable SIEM webhook
const SIEM_WEBHOOK_URL = process.env.SIEM_WEBHOOK_URL;

async function exportToSIEM(event: SecurityEvent): Promise<void> {
  if (!SIEM_WEBHOOK_URL || !['high', 'critical'].includes(event.severity)) return;
  try {
    await fetch(SIEM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'Authorization': `Bearer ${process.env.SIEM_API_KEY}` },
      body: JSON.stringify({ ...event, source: 'krystalinex', timestamp: new Date().toISOString() }),
    });
  } catch (err) { logger.warn({ err }, 'SIEM export failed'); }
}
```

### Packages: None needed (uses native `fetch`)
### Dependencies: Loki should be enabled for log correlation
### Verification: Trigger a brute force scenario → verify webhook receives the event

---

## Cap 8: CI/CD Gates — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `.github/workflows/ci.yml` | Add `validate-observability` job |
| 2 | `config/alerting-rules-test.yml` | **NEW** — promtool test scenarios |

### Phase A (immediate — no dependencies):

**`.github/workflows/ci.yml`** — Add job:
```yaml
validate-observability:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Validate Prometheus rules
      run: |
        docker run --rm -v ${{ github.workspace }}/config:/config \
          prom/prometheus promtool check rules /config/alerting-rules.yml
    - name: Validate OTEL Collector config
      run: |
        docker run --rm -v ${{ github.workspace }}/config:/config \
          otel/opentelemetry-collector-contrib validate \
          --config /config/otel-collector-config.yaml
    - name: Secrets scan
      run: npm run security:secrets
```

### Phase B (after Phase A):

**Trace emission smoke test** — Add to E2E or integration test:
```typescript
test('trade flow emits OTEL trace', async () => {
  const res = await request(app).post('/api/v1/trade/order').send(orderPayload);
  // Wait for export
  await new Promise(r => setTimeout(r, 2000));
  const traces = await fetch(`${JAEGER_URL}/api/traces?service=kx-exchange&limit=1`);
  const { data } = await traces.json();
  expect(data.length).toBeGreaterThan(0);
  expect(data[0].spans.length).toBeGreaterThanOrEqual(5);
});
```

### Phase C (depends on Cap 5):
Pre-deploy SLO gate queries `slo:error_budget_remaining:30d` — blocks deploy if budget < 10%.

### Packages: None (uses Docker images for validation)
### Dependencies: Phase A: none. Phase B: test infrastructure. Phase C: Cap 5 SLO framework.

---

## Cap 12: Programmability — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `config/grafana/provisioning/dashboards/database-health.json` | **NEW** dashboard |
| 2 | `config/grafana/provisioning/dashboards/rabbitmq.json` | **NEW** dashboard |
| 3 | `config/grafana/provisioning/dashboards/security-events.json` | **NEW** dashboard |
| 4 | `config/grafana/provisioning/dashboards/slo-dashboard.json` | **NEW** (after Cap 5) |
| 5 | `server/monitor/routes.ts` | Add `GET /api/v1/monitor/query` PromQL proxy |

### Key Metrics Available for Dashboards

| Dashboard | Prometheus Metrics |
|---|---|
| Database Health | `pg_stat_activity_count`, `pg_stat_database_tup_*`, `pg_settings_*` |
| RabbitMQ | `rabbitmq_queue_messages`, `rabbitmq_queue_consumers`, `rabbitmq_global_messages_*` |
| Security | `kx_security_events_total{event_type, severity}` |
| SLO | `slo:error_ratio:*`, `slo:error_budget_remaining:*`, `slo:latency_*` |

### PromQL Proxy Endpoint
```typescript
// server/monitor/routes.ts — add:
router.get('/query', authenticate, async (req, res) => {
  const { q, start, end, step } = req.query;
  const promUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const result = await fetch(`${promUrl}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`);
  res.json(await result.json());
});
```

### Packages: None
### Dependencies: Cap 5 for SLO dashboard
### Verification: Import dashboards in Grafana → panels render data

---

## Cap 4: Causal Inference — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/monitor/topology-service.ts` | **NEW** — Polls Jaeger Dependencies API |
| 2 | `server/monitor/routes.ts` | Add `GET /api/v1/monitor/topology` |
| 3 | `server/monitor/stream-analyzer.ts` | Feed topology into LLM context |

### Jaeger API Available
- `GET http://jaeger:16686/api/services` — list services
- `GET http://jaeger:16686/api/dependencies?endTs={ms}&lookback={ms}` — dependency graph

### Critical Code
```typescript
// server/monitor/topology-service.ts (new):
export class TopologyService {
  private cache: ServiceGraph | null = null;
  private pollInterval = 5 * 60 * 1000; // 5 min

  async getGraph(): Promise<ServiceGraph> {
    if (this.cache) return this.cache;
    const endTs = Date.now();
    const lookback = 3600 * 1000; // 1 hour
    const resp = await fetch(`${jaegerUrl}/api/dependencies?endTs=${endTs}&lookback=${lookback}`);
    const { data } = await resp.json();
    // data: [{ parent: "kx-exchange", child: "kx-matcher", callCount: 42 }]
    this.cache = buildGraph(data);
    return this.cache;
  }

  getBlastRadius(service: string): string[] {
    // BFS downstream from service in dependency graph
  }
}
```

### Packages: None needed (native fetch)
### Dependencies: Cap 5 for SLO linkage in blast radius
### Verification: Call `/api/v1/monitor/topology` → returns service graph with edges

---

## Cap 13: Cross-Domain Correlation — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/monitor/routes.ts` | Add `POST /api/v1/monitor/events` for deployment markers |
| 2 | `server/monitor/metrics-correlator.ts` | Query deployment events within anomaly window |
| 3 | `server/monitor/stream-analyzer.ts` | Include deployment context in LLM prompt |

### Deployment Event Flow
```
CI deploy step → POST /api/v1/monitor/events { type: "deployment", version, commit }
  → Store in PostgreSQL deployment_events table
  → Grafana annotation datasource reads from same API
  → metrics-correlator checks for deploys within ±10min of anomaly
  → LLM prompt includes "Deploy v2.2.10 occurred 3min before anomaly"
```

### Packages: None
### Dependencies: Cap 8 for automated deploy event posting
### Verification: POST a deployment event → visible as annotation on Grafana dashboards

---

## Cap 14: Self-Healing — Implementation Details

### Files to Create/Modify

| # | File | Change |
|---|------|--------|
| 1 | `server/monitor/auto-remediation.ts` | **NEW** — Alertmanager webhook handler |
| 2 | `config/alertmanager.yml` | Add webhook receiver for auto-remediation |
| 3 | `k8s/charts/krystalinex/templates/hpa.yaml` | Enable HPA + add custom metrics |
| 4 | `k8s/charts/krystalinex/values-local.yaml` | Set `autoscaling.enabled: true` |

### Phase A: Alert-triggered remediation (app-level, no K8s API needed)
```typescript
// server/monitor/auto-remediation.ts:
const SAFE_ACTIONS: Record<string, () => Promise<void>> = {
  'RabbitMQDLQBacklog': async () => { await rabbitmqClient.purgeDLQ(); },
  'DatabaseConnectionsHigh': async () => { await db.pool.end(); await db.pool.connect(); },
  'HighMemoryUsage': async () => { global.gc?.(); },
};

router.post('/webhook/remediation', async (req, res) => {
  if (process.env.AUTO_REMEDIATION_ENABLED !== 'true') return res.json({ skipped: true });
  for (const alert of req.body.alerts) {
    const action = SAFE_ACTIONS[alert.labels.alertname];
    if (action) {
      await action();
      await logRemediation(alert, 'executed');
    }
  }
  res.json({ processed: req.body.alerts.length });
});
```

### Phase B: K8s-native (requires `@kubernetes/client-node`)
- Install: `npm install @kubernetes/client-node`
- Enable HPA: Set `server.autoscaling.enabled: true` in values
- Add PDBs: `minAvailable: 1` for server and payment-processor

### Packages: Phase A: none. Phase B: `@kubernetes/client-node` ^0.20.0
### Dependencies: Cap 5 (budget-based scaling decisions)
### Verification: Fire a test alert → remediation logged in `remediation_events` table

---
---

# PHASE 3: Benefit/Cost Prioritization Matrix

## Scoring Methodology

- **Benefit** (1–10): Impact on overall observability maturity, weighted by how many other capabilities it enables
- **Cost** (dev-days): Calibrated from code analysis — accounts for files touched, test coverage needed, config changes
- **ROI Score** = Benefit / Cost — higher is better, prioritize these first
- **Risk**: Likelihood of requiring iteration or causing regressions

## Prioritization Matrix

| Priority | Cap | Name | Current→Target | Benefit | Cost (days) | ROI | Risk | Wave |
|----------|-----|------|-----------------|---------|-------------|-----|------|------|
| **1** | 6 | Fix Circuit Breaker Metrics | 8→9 | 6 | 1 | **6.0** | Low | 1 |
| **2** | 1 | Telemetry Model | 8→9 | 5 | 1.5 | **3.3** | Low | 1 |
| **3** | 9 | Cost Governance (Sampling) | 2→9 | 9 | 3 | **3.0** | Med | 1 |
| **4** | 5 | SLO Framework | 3→9 | 10 | 5 | **2.0** | Med | 2 |
| **5** | 3 | Context Propagation | 7→9 | 6 | 2.5 | **2.4** | Low | 3 |
| **6** | 10 | Web Vitals | 5→9 | 5 | 2 | **2.5** | Low | 3 |
| **7** | 11 | Security SIEM Export | 8→9 | 5 | 2 | **2.5** | Low | 3 |
| **8** | 8A | CI/CD Static Validation | 1→5 | 7 | 1 | **7.0** | Low | 4 |
| **9** | 12 | Dashboards + Query API | 7→9 | 5 | 4 | **1.3** | Low | 4 |
| **10** | 4 | Causal Inference | 5→9 | 7 | 4 | **1.8** | Med | 5 |
| **11** | 13 | Cross-Domain Correlation | 7→9 | 6 | 2.5 | **2.4** | Low | 5 |
| **12** | 8B | CI/CD Smoke Tests | 5→7 | 6 | 2 | **3.0** | Med | 5 |
| **13** | 14A | Auto-Remediation | 3→6 | 8 | 4 | **2.0** | Med | 6 |
| **14** | 14B | K8s Self-Healing (HPA/PDB) | 6→8 | 7 | 3 | **2.3** | Med | 6 |
| **15** | 8C | CI/CD Deploy Gates | 7→9 | 8 | 5 | **1.6** | High | 6 |
| **16** | 14C | Canary Analysis (Argo) | 8→9 | 6 | 7 | **0.9** | High | Future |

## Recommended Execution Waves

### Wave 1: Quick Wins (3.5 days) — No dependencies, immediate value
- [x] **Cap 6**: Fix circuit breaker metrics wiring (1 day)
- [x] **Cap 1**: Telemetry attribute catalog + resource enrichment (1.5 days)
- [x] **Cap 9**: Tail-based sampling + retention policies (3 days, parallel with above)

**Outcome**: Fix 2 dead alerts, 80-90% trace volume reduction, consistent telemetry attributes

### Wave 2: Foundation (5 days) — Unlocks 4 downstream capabilities
- [x] **Cap 5**: SLO recording rules + burn rate alerts + budget API (5 days)

**Outcome**: Error budgets, burn rate alerts, SLO API — foundational for Caps 4, 8C, 12, 14

### Wave 3: Parallel Enrichment (4 days) — Independent, can parallelize
- [x] **Cap 3**: Prometheus exemplars + userId in spans (2.5 days)
- [x] **Cap 10**: Web Vitals browser telemetry (2 days)
- [x] **Cap 11**: SIEM webhook for security events (2 days)

**Outcome**: Trace↔metric correlation via exemplars, user experience visibility, security event export

### Wave 4: Validation & Visibility (4 days)
- [ ] **Cap 8A**: promtool + OTEL config validation in CI (1 day)
- [ ] **Cap 12**: 4 new Grafana dashboards + PromQL proxy API (4 days)

**Outcome**: CI catches config errors, comprehensive dashboard coverage

### Wave 5: Intelligence (6 days)
- [ ] **Cap 4**: Service topology from Jaeger + blast radius (4 days)
- [ ] **Cap 13**: Deployment event annotations + RCA integration (2.5 days)
- [ ] **Cap 8B**: Trace emission smoke tests in CI (2 days)

**Outcome**: Programmatic topology, deployment↔anomaly correlation, instrumentation regression protection

### Wave 6: Automation (12 days)
- [ ] **Cap 14A**: Alert-triggered auto-remediation (4 days)
- [ ] **Cap 14B**: K8s HPA/PDB self-healing (3 days)
- [ ] **Cap 8C**: SLO-based deploy gates (5 days)

**Outcome**: Closed-loop remediation, K8s-native resilience, deploy-time SLO enforcement

### Future: Advanced (7+ days, optional)
- [ ] **Cap 14C**: Argo Rollouts canary analysis (7 days, requires new infrastructure)

## Total Effort Summary

| Waves | Days | Cumulative | Score After |
|-------|------|------------|-------------|
| Wave 1 (Quick Wins) | 3.5 | 3.5 | 6.5 → 6.9 |
| Wave 2 (Foundation) | 5 | 8.5 | 6.9 → 7.3 |
| Wave 3 (Enrichment) | 4 | 12.5 | 7.3 → 7.9 |
| Wave 4 (Visibility) | 4 | 16.5 | 7.9 → 8.3 |
| Wave 5 (Intelligence) | 6 | 22.5 | 8.3 → 8.7 |
| Wave 6 (Automation) | 12 | 34.5 | 8.7 → 9.1 |

**Total to reach 9/10 across all capabilities: ~35 dev-days** (refined from initial 40-55 estimate)

## Critical Path

```
Cap 1 ──→ Cap 3 (attributes before exemplars)
Cap 5 ──→ Cap 4  (SLOs before blast radius)
Cap 5 ──→ Cap 8C (SLOs before deploy gates)
Cap 5 ──→ Cap 12 (SLOs before SLO dashboard)
Cap 5 ──→ Cap 14 (SLOs before budget-based scaling)
Cap 8A ──→ Cap 8B ──→ Cap 8C (CI gates are sequential)
Cap 13 ←── Cap 8 (deploy events from CI pipeline)
```

The single most important item is **Cap 5 (SLO Framework)** — it's the critical path bottleneck that unlocks 4 other capabilities. After Wave 1 quick wins, prioritize Cap 5 above all else.
