# otel-mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes your **OpenTelemetry** observability stack — traces, metrics, logs, and more — as tools for AI agents. Built on a **Skill** plugin architecture for easy extensibility.

> Give any LLM agent the ability to query your Jaeger traces, run PromQL, search Loki logs, and investigate production issues — through a standard protocol.

```
┌─────────────────┐     MCP (stdio/HTTP)     ┌──────────────────┐
│  Claude Desktop │ ◄──────────────────────► │                  │
│  GitHub Copilot │                          │  otel-mcp-server │──► Jaeger   (traces)
│  Custom Agent   │                          │                  │──► Prometheus (metrics)
└─────────────────┘                          │   7 skills       │──► Loki     (logs)
                                             │   32 tools       │──► Elasticsearch
                                             │   authenticated  │──► Alertmanager
                                             └──────────────────┘──► App API  (ZK/system)
```

## Example

> *"What's running, what's healthy, and what needs attention?"* — answered in seconds by an AI agent using this MCP server against a local Docker Compose stack:

![MCP server exploring a local observability stack — showing Jaeger, Prometheus, and Loki backend status, active alerts, and key findings](docs/sample.png)

> *"Tell me what happened to order ORD-1774382223417-7"* — full distributed trace across 4 services, 40 spans, with ZK proof verification:

![Order tracing across gateway, exchange, matcher, and wallet services — showing timeline, fill price, latency breakdown, and Groth16 ZK proof verification](docs/sample2.png)

> *"What about the k8s cluster?"* 

![Health check across the cluster](docs/sample3.png)

## Features

- **32 tools** across 7 skills — traces, metrics, logs, Elasticsearch, Alertmanager, ZK proofs, system health
- **Skill plugin architecture** — each backend is a self-contained plugin; add new ones with a single file
- **Two transports** — stdio (Claude Desktop, Copilot) and HTTP (remote, multi-client)
- **Two-layer auth** — backend credentials (Bearer/Basic/custom headers per backend) and client API keys (env var, mounted file, or local file)
- **Selective skills** — enable only the skills you need (`--tools traces,metrics,logs`)
- **Self-metrics** — `GET /metrics` endpoint with tool call counts, backend latencies, auth attempts
- **Container-native** — env-var config, K8s Secret mounting, multi-stage Dockerfile
- **Zero dependencies** beyond the MCP SDK and Zod

## Quick Start

### Install

```bash
git clone https://github.com/MoebiusX/otel-mcp-server.git
cd otel-mcp-server
npm install
npm run build
```

### Run (stdio — for Claude Desktop / Copilot)

```bash
# Point at your backends
export JAEGER_URL=http://localhost:16686
export PROMETHEUS_URL=http://localhost:9090
export LOKI_URL=http://localhost:3100

node dist/index.js
```

### Run (HTTP — for remote agents / containers)

```bash
node dist/index.js --http 3001
# ✓ otel-mcp-server v1.2.0 listening on http://0.0.0.0:3001
#   Skills:
#     ✓ traces         — Distributed Traces (5 tools) [Jaeger]
#     ✓ metrics        — Prometheus Metrics (6 tools) [Prometheus]
#     ✓ logs           — Structured Logs (4 tools) [Loki]
#     ✓ zk-proofs      — ZK Proofs (4 tools) [App API]
#     ✓ system         — System Health (4 tools) [App API, Jaeger]
```

### Docker

```bash
docker build -t otel-mcp-server .
docker run -p 3001:3001 \
  -e JAEGER_URL=http://jaeger:16686 \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e LOKI_URL=http://loki:3100 \
  -e ELASTICSEARCH_URL=http://elasticsearch:9200 \
  -e ALERTMANAGER_URL=http://alertmanager:9093 \
  -e MCP_AUTH_KEYS='{"keys":[{"id":"agent-1","key":"sk-my-secret-key"}]}' \
  otel-mcp-server
```

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Backend URLs

| Variable | Default | Description |
|----------|---------|-------------|
| `JAEGER_URL` | `http://localhost:16686` | Jaeger Query API |
| `PROMETHEUS_URL` | `http://localhost:9090` | Prometheus API |
| `LOKI_URL` | `http://localhost:3100` | Loki API |
| `PROMETHEUS_PATH_PREFIX` | _(empty)_ | Path prefix (e.g. `/prometheus`) |
| `APP_API_URL` | `http://localhost:5000` | Application API (for ZK/system tools) |
| `ELASTICSEARCH_URL` | _(disabled)_ | Elasticsearch / OpenSearch API |
| `ALERTMANAGER_URL` | _(disabled)_ | Alertmanager API |
| `MCP_TIMEOUT_MS` | `15000` | Backend query timeout (ms) |

### Backend Authentication

The MCP server authenticates to each backend independently. For each backend prefix (`JAEGER_`, `PROMETHEUS_`, `LOKI_`, `APP_API_`, `ELASTICSEARCH_`, `ALERTMANAGER_`), you can set:

| Suffix | Effect |
|--------|--------|
| `_AUTH_TOKEN` | Sets `Authorization: Bearer <token>` |
| `_AUTH_BASIC` | Sets `Authorization: Basic <base64(user:pass)>` — provide as `user:password` |
| `_AUTH_HEADER` | Sets `Authorization: <raw value>` (overrides token/basic) |

Special:

| Variable | Effect |
|----------|--------|
| `LOKI_TENANT_ID` | Sets `X-Scope-OrgID` header for multi-tenant Loki |

**Example — Prometheus behind OAuth proxy + multi-tenant Loki:**

```bash
PROMETHEUS_AUTH_TOKEN=eyJhbGci...
LOKI_AUTH_TOKEN=my-loki-token
LOKI_TENANT_ID=team-platform
```

### Client Authentication (HTTP mode)

Clients connecting to the MCP server over HTTP must present an API key. Keys are loaded from (first match wins):

1. **`MCP_AUTH_KEYS` env var** — JSON string (best for containers / K8s Secrets)
2. **`MCP_AUTH_KEYS_FILE` env var** — path to a JSON file (K8s mounted Secret)
3. **`./auth-keys.json`** — local file in cwd
4. **`~/.otel-mcp/auth-keys.json`** — user home directory

If no keys are found, the server runs with **open access** (a warning is logged).

**Key format:**

```json
{
  "keys": [
    {
      "id": "agent-1",
      "key": "sk-my-secret-key-here",
      "description": "Production RCA agent"
    },
    {
      "id": "ci-readonly",
      "key": "sk-ci-key",
      "description": "CI pipeline — restricted tools",
      "allowedTools": ["traces", "metrics"]
    }
  ]
}
```

Clients authenticate via either header:
- `Authorization: Bearer sk-my-secret-key-here`
- `X-API-Key: sk-my-secret-key-here`

The `/health` endpoint is always unauthenticated.

### Kubernetes Deployment

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: otel-mcp-auth
stringData:
  # Client keys
  auth-keys.json: |
    {"keys":[{"id":"rca-agent","key":"sk-prod-xxx"}]}
  # Backend tokens
  PROMETHEUS_AUTH_TOKEN: "my-prom-token"
  LOKI_AUTH_TOKEN: "my-loki-token"
  LOKI_TENANT_ID: "platform"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-mcp-server
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: otel-mcp-server
          image: otel-mcp-server:latest
          ports:
            - containerPort: 3001
          env:
            - name: JAEGER_URL
              value: "http://jaeger-query.observability:16686"
            - name: PROMETHEUS_URL
              value: "http://prometheus.observability:9090"
            - name: LOKI_URL
              value: "http://loki.observability:3100"
            # Optional: uncomment to enable Elasticsearch / Alertmanager skills
            # - name: ELASTICSEARCH_URL
            #   value: "http://elasticsearch.observability:9200"
            # - name: ALERTMANAGER_URL
            #   value: "http://alertmanager.observability:9093"
            - name: PROMETHEUS_AUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: otel-mcp-auth
                  key: PROMETHEUS_AUTH_TOKEN
            - name: LOKI_AUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: otel-mcp-auth
                  key: LOKI_AUTH_TOKEN
            - name: LOKI_TENANT_ID
              valueFrom:
                secretKeyRef:
                  name: otel-mcp-auth
                  key: LOKI_TENANT_ID
            - name: MCP_AUTH_KEYS_FILE
              value: "/etc/otel-mcp/auth-keys.json"
          volumeMounts:
            - name: auth-keys
              mountPath: /etc/otel-mcp
              readOnly: true
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 5
          readinessProbe:
            httpGet:
              path: /health
              port: 3001
      volumes:
        - name: auth-keys
          secret:
            secretName: otel-mcp-auth
            items:
              - key: auth-keys.json
                path: auth-keys.json
```

## Skills

Each telemetry backend is a **skill** — an independent plugin. Skills with configured backends
are auto-discovered on startup; unconfigured ones (like Elasticsearch without `ELASTICSEARCH_URL`)
are silently skipped.

### Traces (Jaeger) — `traces` — 5 tools

| Tool | Description |
|------|-------------|
| `traces_search` | Search traces by service, operation, tags, or duration |
| `trace_get` | Full trace detail — all spans with timing, tags, and parent-child |
| `traces_services` | List all reporting services |
| `traces_operations` | List operations for a service |
| `traces_dependencies` | Service dependency graph |

### Metrics (Prometheus) — `metrics` — 6 tools

| Tool | Description |
|------|-------------|
| `metrics_query` | Instant PromQL query |
| `metrics_query_range` | Range PromQL query (time series) |
| `metrics_targets` | Scrape target health |
| `metrics_alerts` | Alerting rules and state |
| `metrics_metadata` | Metric type, help, unit lookup |
| `metrics_label_values` | Label value enumeration |

### Logs (Loki) — `logs` — 4 tools

| Tool | Description |
|------|-------------|
| `logs_query` | LogQL query for log lines |
| `logs_labels` | Available label names |
| `logs_label_values` | Values for a label |
| `logs_tail_context` | Logs correlated with a trace ID |

### Elasticsearch / OpenSearch — `elasticsearch` — 5 tools

> Enabled when `ELASTICSEARCH_URL` is set.

| Tool | Description |
|------|-------------|
| `es_search` | Full-text search across indices with Lucene query syntax |
| `es_cluster_health` | Cluster health (green/yellow/red), node and shard counts |
| `es_indices` | List indices with doc counts, storage size, and health |
| `es_index_mapping` | Field mappings, types, and analyzers for an index |
| `es_cat_nodes` | Node resource usage (CPU, heap, disk, load) |

### Alertmanager — `alertmanager` — 4 tools

> Enabled when `ALERTMANAGER_URL` is set.

| Tool | Description |
|------|-------------|
| `alertmanager_alerts` | Active alerts with labels, annotations, and routing status |
| `alertmanager_silences` | List active/pending/expired silences with matchers |
| `alertmanager_groups` | Alert groups by routing rules and receivers |
| `alertmanager_status` | Cluster status, version, peer count, and live config |

### ZK Proofs — `zk-proofs` — 4 tools

| Tool | Description |
|------|-------------|
| `zk_proof_get` | Retrieve a ZK-SNARK proof |
| `zk_proof_verify` | Verify a proof server-side |
| `zk_solvency` | Latest solvency proof |
| `zk_stats` | Aggregate proof statistics |

### System — `system` — 4 tools

| Tool | Description |
|------|-------------|
| `anomalies_active` | Active anomalies |
| `anomalies_baselines` | Detection baselines |
| `system_health` | Full health check |
| `system_topology` | Service dependency topology |

### Selective Skills

Only load the skills you need:

```bash
# Core OTEL only (no ZK / system health)
node dist/index.js --tools traces,metrics,logs

# Traces + metrics + alertmanager
node dist/index.js --http 3001 --tools traces,metrics,alertmanager
```

## Self-Metrics

In HTTP mode, `GET /metrics` exposes Prometheus-format metrics about the MCP server itself:

| Metric | Type | Description |
|--------|------|-------------|
| `mcp_tool_calls_total{tool,status}` | Counter | Tool invocation count |
| `mcp_tool_duration_seconds{tool}` | Histogram | Tool call latency |
| `mcp_backend_requests_total{backend,status}` | Counter | Outbound backend HTTP requests |
| `mcp_backend_duration_seconds{backend}` | Histogram | Backend request latency |
| `mcp_auth_attempts_total{result}` | Counter | Client auth attempts (accepted/rejected) |
| `mcp_active_sessions` | Gauge | Currently connected MCP sessions |
| `mcp_uptime_seconds` | Gauge | Server uptime |
| `mcp_server_info{version}` | Info | Server version metadata |

Scrape with Prometheus:

```yaml
scrape_configs:
  - job_name: 'otel-mcp-server'
    static_configs:
      - targets: ['otel-mcp-server:3001']
```

## Client Integration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "otel": {
      "command": "node",
      "args": ["/path/to/otel-mcp-server/dist/index.js"],
      "env": {
        "JAEGER_URL": "http://localhost:16686",
        "PROMETHEUS_URL": "http://localhost:9090",
        "LOKI_URL": "http://localhost:3100"
      }
    }
  }
}
```

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "otel": {
      "command": "node",
      "args": ["${workspaceFolder}/otel-mcp-server/dist/index.js"],
      "env": {
        "JAEGER_URL": "http://localhost:16686",
        "PROMETHEUS_URL": "http://localhost:9090",
        "LOKI_URL": "http://localhost:3100"
      }
    }
  }
}
```

### HTTP Client (any agent)

```bash
# Health check
curl http://localhost:3001/health

# MCP request with auth
curl -X POST http://localhost:3001/mcp \
  -H "Authorization: Bearer sk-my-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Architecture

Each telemetry backend is a **Skill** — a self-contained plugin that declares its tools,
self-configures from env vars, and registers MCP tools on the server.

```
src/
├── index.ts              # CLI entry point (stdio / HTTP transport)
├── server.ts             # MCP server factory (iterates skills)
├── skill.ts              # Skill interface + SkillHelpers factory
├── skills.ts             # Skill registry (one import per backend)
├── config.ts             # env() helper
├── auth.ts               # Backend + client authentication
├── helpers.ts            # fetchJSON, createFetcher, utilities
├── metrics.ts            # Self-metrics (Prometheus format)
├── tools/
│   ├── traces.ts         # Jaeger traces skill (5 tools)
│   ├── metrics.ts        # Prometheus metrics skill (6 tools)
│   ├── logs.ts           # Loki logs skill (4 tools)
│   ├── elasticsearch.ts  # ES/OpenSearch skill (5 tools)
│   ├── alertmanager.ts   # Alertmanager skill (4 tools)
│   ├── zk-proofs.ts      # ZK proof skill (4 tools)
│   └── system.ts         # System health skill (4 tools)
└── resources/
    └── overview.ts       # MCP resource: auto-generated overview
```

### Adding a new skill

```typescript
// 1. Create src/tools/tempo.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Skill, SkillHelpers } from '../skill.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const tempoUrl = helpers.env('TEMPO_URL');
  const fetchJSON = helpers.createFetcher('TEMPO', 'tempo');

  server.tool('tempo_search', 'Search traces in Tempo', { ... }, async (params) => {
    // ...
  });
}

export const skill: Skill = {
  id: 'tempo',
  name: 'Grafana Tempo',
  description: 'Query traces via the Grafana Tempo API',
  tools: 1,
  backends: ['Tempo'],
  isAvailable: () => !!process.env.TEMPO_URL,
  register: registerTools,
};

// 2. Add to src/skills.ts
import { skill as tempo } from './tools/tempo.js';
export const allSkills: Skill[] = [...existingSkills, tempo];
```

### Auth Flow

```
Client → [API Key] → MCP Server → [Backend Credentials] → Jaeger/Prometheus/Loki
                          │
                          ├── Authorization: Bearer <JAEGER_AUTH_TOKEN>  → Jaeger
                          ├── Authorization: Basic <PROMETHEUS_AUTH_BASIC> → Prometheus
                          └── Authorization: Bearer <LOKI_AUTH_TOKEN>    → Loki
                               X-Scope-OrgID: <LOKI_TENANT_ID>
```

## Development

```bash
# Dev mode (tsx, no build step)
npm run dev             # stdio
npm run dev:http        # HTTP on port 3001

# Type check
npm run lint

# Build
npm run build

# Tests (99 tests across 7 suites)
npm test

# Run a single test file
npx vitest run tests/auth.test.ts
```

## Appendix: Live Cluster Analysis

The following analysis was generated entirely by an AI agent (GitHub Copilot CLI) using this MCP server to query a production KrystalineX cluster — 27 tool calls across 6 skills, zero manual commands. This is what "Proof of Observability" looks like in practice.

> **Cluster**: KrystalineX crypto exchange · 3-node K8s (1 control-plane, 2 workers) · Helm-managed  
> **MCP Server**: v1.2.1 · 6/7 skills active (Elasticsearch disabled) · session-based HTTP transport  
> **Date**: 2026-03-24T19:30 UTC

---

### Infrastructure

| Node | Role | CPU | Memory | Disk | Status |
|------|------|-----|--------|------|--------|
| kube (192.168.1.32) | control-plane | 13.4% | 29.7% | 62.3% | ✅ Ready |
| worker1 (192.168.1.34) | worker | 10.0% | 28.6% | 51.2% | ✅ Ready |
| worker2 (192.168.1.35) | worker | — | — | — | 🔴 NotReady (hardware) |

### Prometheus Targets — 12/12 UP

All scrape targets healthy with zero errors:

krystalinex-server · payment-processor · Kong · Grafana · Jaeger · OTEL Collector · Prometheus · RabbitMQ · Redis · kube-state-metrics · node-exporter ×2

### Application Services

| Service | Avg Latency | Traced Spans | Anomalies | Status |
|---------|------------|--------------|-----------|--------|
| kx-exchange | 491 ms | 19 | 0 | ✅ Healthy |
| kx-wallet | 156 ms | 6 | 0 | ✅ Healthy |
| kx-matcher | 29 ms | 3 | 0 | ✅ Healthy |
| kx-gateway | — | *(traced)* | 0 | ✅ Healthy |

### Performance Snapshot

| Metric | Value | Threshold | Verdict |
|--------|-------|-----------|---------|
| P50 latency | **4.1 ms** | — | 🟢 Excellent |
| P99 latency | **424 ms** | 2 s | 🟢 Well within budget |
| Error rate (5xx) | **0%** | 5% | 🟢 Clean |
| Request throughput | 0.21 req/s | — | Idle / low traffic |
| RabbitMQ backlog | **0 messages** | — | 🟢 No queuing |
| Pod restarts | **0** | — | 🟢 Stable |

### SLO Error Budgets

| SLO | Budget Remaining | Status |
|-----|-----------------|--------|
| **Availability** (99.9% target) | **100%** | 🟢 Full |
| **Latency** (P99 < 2s target) | **14.2%** | 🟡 Predictive alert firing |

The latency SLO budget is being consumed faster than expected. A `predict_linear` rule forecasts exhaustion within 24 hours. Worth investigating tail latency in kx-exchange.

### Active Alerts — 3

| Alert | Severity | Detail |
|-------|----------|--------|
| PodNotReady | ⚠️ warning | `server-df98765f9-pcxxv` — stale pod from rollout, auto-resolving |
| PodNotReady | ⚠️ warning | `payment-processor-f4f8b8d78-wxszp` — stale pod, auto-resolving |
| LatencyBudgetExhaustion | ⚠️ warning | Predictive: latency error budget depleting within 24h |

All critical rules — HighErrorRate, ServiceDown, ContainerCrashLooping, OOMKilled — are **inactive**.

### Service Dependency Graph

```
kx-gateway ──(99 calls)──► kx-exchange ──(5 calls)──► kx-matcher
                                │
                                └──(94 calls)──► jaeger (OTEL export)

kx-wallet  ──(23 calls)──► kx-exchange
kx-wallet  ──(14 calls)──► kx-gateway
```

### Logs & Traces

| Signal | Window | Count | Finding |
|--------|--------|-------|---------|
| Error logs | 1 h | **0** | Clean |
| Warning logs | 1 h | **0** | Clean |
| OOM logs | 6 h | **0** | No memory pressure |
| Error traces | 1 h | **3** | Transient tcp.connect / dns.lookup — network hiccups |
| Slow traces (>2s) | 1 h | **0** | No significant slow requests |

### Tools Used

This analysis invoked 27 MCP tool calls:

| Skill | Tools Called |
|-------|-------------|
| **Traces** | `traces_services`, `traces_search` ×2, `traces_dependencies`, `system_health` |
| **Metrics** | `metrics_query` ×12 (up, latency, errors, CPU, memory, disk, SLO budgets, RabbitMQ), `metrics_targets`, `metrics_alerts` |
| **Logs** | `logs_query` ×3 (errors, warnings, OOM) |
| **Alertmanager** | `alertmanager_alerts`, `alertmanager_groups`, `alertmanager_status` |
| **ZK Proofs** | `zk_stats` |
| **System** | `anomalies_active`, `anomalies_baselines` |

### Verdict

The cluster is **healthy and stable** with generous headroom on both active nodes. The main items to watch are the **latency SLO budget trend** and **kube node disk usage at 62%**. The offline worker2 node is a known hardware issue. No action required on the PodNotReady alerts — they are ephemeral artifacts of recent deployments.

---

## Monorepo Integration (git subtree)

This directory is maintained as a **git subtree** of the standalone repo [`MoebiusX/otel-mcp-server`](https://github.com/MoebiusX/otel-mcp-server). The standalone repo is the **single source of truth**.

### Pull latest changes from upstream

```bash
cd /path/to/KrystalineX
git subtree pull --prefix=otel-mcp-server otel-upstream master --squash
```

### Push monorepo changes back upstream

```bash
cd /path/to/KrystalineX
git subtree push --prefix=otel-mcp-server otel-upstream master
```

### Initial setup (already done)

```bash
git remote add otel-upstream https://github.com/MoebiusX/otel-mcp-server.git
git subtree add --prefix=otel-mcp-server otel-upstream master --squash
```

> **Note:** `src/client.ts` is currently monorepo-only. Push it upstream when ready.

## License

Apache-2.0 — see [LICENSE](LICENSE).
