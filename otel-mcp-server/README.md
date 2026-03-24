# otel-mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes your **OpenTelemetry** observability stack — traces, metrics, logs, and optionally ZK proofs — as tools for AI agents.

> Give any LLM agent the ability to query your Jaeger traces, run PromQL, search Loki logs, and investigate production issues — through a standard protocol.

```
┌─────────────────┐     MCP (stdio/HTTP)     ┌──────────────────┐
│  Claude Desktop  │ ◄──────────────────────► │                  │
│  GitHub Copilot  │                          │  otel-mcp-server │──► Jaeger   (traces)
│  Custom Agent    │                          │                  │──► Prometheus (metrics)
└─────────────────┘                           │   23 tools       │──► Loki     (logs)
                                              │   authenticated  │──► App API  (ZK proofs)
                                              └──────────────────┘
```

## Features

- **23 tools** across 5 domains — traces, metrics, logs, ZK proofs, system health
- **Two transports** — stdio (Claude Desktop, Copilot) and HTTP (remote, multi-client)
- **Two-layer auth** — backend credentials (Bearer/Basic/custom headers per backend) and client API keys (env var, mounted file, or local file)
- **Selective tool groups** — enable only the tools you need (`--tools traces,metrics,logs`)
- **Container-native** — env-var config, K8s Secret mounting, multi-stage Dockerfile
- **Zero dependencies** beyond the MCP SDK and Zod

## Quick Start

### Install

```bash
git clone https://github.com/KrystalineX/otel-mcp-server.git
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
# ✓ otel-mcp-server v1.0.0 listening on http://0.0.0.0:3001
```

### Docker

```bash
docker build -t otel-mcp-server .
docker run -p 3001:3001 \
  -e JAEGER_URL=http://jaeger:16686 \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e LOKI_URL=http://loki:3100 \
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
| `MCP_TIMEOUT_MS` | `15000` | Backend query timeout (ms) |

### Backend Authentication

The MCP server authenticates to each backend independently. For each backend prefix (`JAEGER_`, `PROMETHEUS_`, `LOKI_`, `APP_API_`), you can set:

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

## Tools

### Traces (Jaeger) — 5 tools

| Tool | Description |
|------|-------------|
| `traces_search` | Search traces by service, operation, tags, or duration |
| `trace_get` | Full trace detail — all spans with timing, tags, and parent-child |
| `traces_services` | List all reporting services |
| `traces_operations` | List operations for a service |
| `traces_dependencies` | Service dependency graph |

### Metrics (Prometheus) — 6 tools

| Tool | Description |
|------|-------------|
| `metrics_query` | Instant PromQL query |
| `metrics_query_range` | Range PromQL query (time series) |
| `metrics_targets` | Scrape target health |
| `metrics_alerts` | Alerting rules and state |
| `metrics_metadata` | Metric type, help, unit lookup |
| `metrics_label_values` | Label value enumeration |

### Logs (Loki) — 4 tools

| Tool | Description |
|------|-------------|
| `logs_query` | LogQL query for log lines |
| `logs_labels` | Available label names |
| `logs_label_values` | Values for a label |
| `logs_tail_context` | Logs correlated with a trace ID |

### ZK Proofs — 4 tools (optional)

| Tool | Description |
|------|-------------|
| `zk_proof_get` | Retrieve a ZK-SNARK proof |
| `zk_proof_verify` | Verify a proof server-side |
| `zk_solvency` | Latest solvency proof |
| `zk_stats` | Aggregate proof statistics |

### System — 4 tools (optional)

| Tool | Description |
|------|-------------|
| `anomalies_active` | Active anomalies |
| `anomalies_baselines` | Detection baselines |
| `system_health` | Full health check |
| `system_topology` | Service dependency topology |

### Selective Tool Groups

Only load the tools you need:

```bash
# Core OTEL only (no ZK / system health)
node dist/index.js --tools traces,metrics,logs

# Traces + metrics only
node dist/index.js --http 3001 --tools traces,metrics
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

```
src/
├── index.ts              # CLI entry point (stdio / HTTP transport)
├── server.ts             # MCP server factory (tool registration)
├── config.ts             # Environment-based configuration
├── auth.ts               # Backend + client authentication
├── helpers.ts            # fetchJSON, createFetcher, utilities
├── tools/
│   ├── traces.ts         # Jaeger trace tools
│   ├── metrics.ts        # Prometheus metrics tools
│   ├── logs.ts           # Loki log tools
│   ├── zk-proofs.ts      # ZK proof tools (optional)
│   └── system.ts         # System health tools (optional)
└── resources/
    └── overview.ts       # MCP resource: platform overview
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
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
