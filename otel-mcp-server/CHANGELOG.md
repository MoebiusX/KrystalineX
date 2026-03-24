# Changelog

All notable changes to otel-mcp-server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
