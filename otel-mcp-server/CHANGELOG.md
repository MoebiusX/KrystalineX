# Changelog

All notable changes to otel-mcp-server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-03-24

### Added

- **Skill plugin architecture** — each telemetry backend is now a self-contained `Skill` object
  that self-configures from environment variables, declares its own availability, and registers
  MCP tools independently. Adding a new backend is now a single file + one registry line.
- `src/skill.ts` — `Skill` interface, `SkillHelpers` abstraction, `createSkillHelpers()` factory
- `src/skills.ts` — central skill registry (import + array)
- Skill-aware startup display showing ✓/✗ per skill with tool counts and backend names
- Health endpoint now returns per-skill availability status
- `buildAuth(prefix)` exported from auth.ts for use by skill helpers
- Overview resource auto-generates from active skill metadata

### Changed

- `createServer(config, options)` → `createServer(options)` — skills self-configure from env vars
- Config module stripped to `env()` helper — no more shared `Config` object
- Removed `loadBackendAuth()`, `BackendAuthConfig`, `buildLokiAuth()` from auth.ts (superseded by `buildAuth()`)
- Removed `ToolGroup` type, `ALL_TOOL_GROUPS` — replaced by `allSkills` registry
- Loki tenant ID (`LOKI_TENANT_ID`) now handled by the logs skill via `CreateFetcherOptions.extraHeaders`
  instead of special-cased auth logic
- Version bumped to 1.2.0
- Test count: 98 → 99

### How to add a new skill

```typescript
// 1. Create src/tools/tempo.ts
export const skill: Skill = {
  id: 'tempo',
  name: 'Grafana Tempo',
  description: 'Query traces via the Grafana Tempo API',
  tools: 3,
  backends: ['Tempo'],
  isAvailable: () => !!process.env.TEMPO_URL,
  register: registerTools,
};

// 2. Add to src/skills.ts
import { skill as tempo } from './tools/tempo.js';
export const allSkills: Skill[] = [..., tempo];
```

## [1.1.0] - 2026-03-24

### Added

- **Elasticsearch / OpenSearch** tool group (5 tools):
  - `es_search` — Full-text search across indices with Lucene query syntax
  - `es_cluster_health` — Cluster health status (green/yellow/red), node and shard counts
  - `es_indices` — List indices with doc counts, storage size, and health
  - `es_index_mapping` — Field mappings, types, and analyzers for an index
  - `es_cat_nodes` — Node resource usage (CPU, heap, disk, load)
- **Alertmanager** tool group (4 tools):
  - `alertmanager_alerts` — Active alerts with labels, annotations, and routing status
  - `alertmanager_silences` — List active/pending/expired silences with matchers
  - `alertmanager_groups` — Alert groups by routing rules and receivers
  - `alertmanager_status` — Cluster status, version, peer count, and live config
- **Self-metrics** (`GET /metrics` in HTTP mode):
  - `mcp_tool_calls_total{tool, status}` — Tool call counter
  - `mcp_tool_duration_seconds{tool}` — Tool call latency histogram
  - `mcp_backend_requests_total{backend, status}` — Outbound request counter
  - `mcp_backend_duration_seconds{backend}` — Backend request latency histogram
  - `mcp_auth_attempts_total{result}` — Authentication attempt counter
  - `mcp_active_sessions` — Active connected sessions gauge
  - `mcp_uptime_seconds` — Server uptime gauge
  - `mcp_server_info{version}` — Server metadata
- All backend fetchers now instrumented with per-backend request metrics
- `createFetcher()` accepts optional `backend` name for automatic instrumentation
- `fetchJSON()` supports POST requests with JSON body (for Elasticsearch)

### Changed

- Tool count: 23 → 32 (with all backends configured)
- Conditional tool registration: ES and AM tools only register when URLs are configured
- Version bumped to 1.1.0

## [1.0.0] - 2026-03-24

### Added

- **23 MCP tools** across 5 domains:
  - **Traces** (5): search, get, services, operations, dependencies
  - **Metrics** (6): query, query_range, targets, alerts, metadata, label_values
  - **Logs** (4): query, labels, label_values, tail_context
  - **ZK Proofs** (4): proof_get, proof_verify, solvency, stats
  - **System** (4): anomalies_active, anomalies_baselines, system_health, system_topology
- **Two transports**: stdio (Claude Desktop, Copilot) and Streamable HTTP (remote agents)
- **Backend authentication**: per-backend Bearer token, Basic auth, or raw Authorization headers; Loki multi-tenant support via X-Scope-OrgID
- **Client authentication**: API keys loaded from MCP_AUTH_KEYS env var (container-native), MCP_AUTH_KEYS_FILE, or local auth-keys.json
- **Selective tool groups**: `--tools traces,metrics,logs` flag to load only needed tools
- **MCP resource**: `otel://overview` with platform architecture and workflow guidance
- **Health endpoint**: `/health` (always unauthenticated) with version, auth status, and enabled tools
- **CORS support** for browser-based MCP clients
- **Dockerfile**: multi-stage build with health check
- **Client examples**: Claude Desktop and VS Code / GitHub Copilot configs
