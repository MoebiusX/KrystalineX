/**
 * MCP resources — pre-built context documents for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerResources(server: McpServer): void {
  server.resource(
    'otel://overview',
    'OpenTelemetry stack overview — architecture, backends, and available telemetry signals',
    async () => ({
      contents: [{
        uri: 'otel://overview',
        mimeType: 'text/markdown',
        text: `# OpenTelemetry MCP Server — Platform Overview

## Telemetry Signals

| Signal  | Backend    | API                          |
|---------|------------|------------------------------|
| Traces  | Jaeger     | \`/api/traces\`, \`/api/services\`, \`/api/dependencies\` |
| Metrics | Prometheus | \`/api/v1/query\`, \`/api/v1/query_range\`, \`/api/v1/targets\` |
| Logs    | Loki       | \`/loki/api/v1/query_range\`, \`/loki/api/v1/labels\` |

## Available Tool Groups

### Traces (5 tools)
- \`traces_search\` — Search traces by service, operation, tags, duration
- \`trace_get\` — Full trace detail with all spans
- \`traces_services\` — List reporting services
- \`traces_operations\` — List operations per service
- \`traces_dependencies\` — Service dependency graph

### Metrics (6 tools)
- \`metrics_query\` — Instant PromQL query
- \`metrics_query_range\` — Range PromQL query (time series)
- \`metrics_targets\` — Scrape target health
- \`metrics_alerts\` — Alert rules and state
- \`metrics_metadata\` — Metric type/help/unit lookup
- \`metrics_label_values\` — Label value enumeration

### Logs (4 tools)
- \`logs_query\` — LogQL query
- \`logs_labels\` — Available label names
- \`logs_label_values\` — Values for a label
- \`logs_tail_context\` — Logs correlated with a trace ID

### ZK Proofs (4 tools) — optional
- \`zk_proof_get\` — Retrieve a ZK-SNARK proof
- \`zk_proof_verify\` — Verify a proof
- \`zk_solvency\` — Latest solvency proof
- \`zk_stats\` — Proof statistics

### System (4 tools) — optional
- \`anomalies_active\` — Active anomalies
- \`anomalies_baselines\` — Detection baselines
- \`system_health\` — Full health check
- \`system_topology\` — Service dependency topology

## Common Workflows

### Investigate a slow request
1. \`traces_search\` with \`min_duration: "1s"\` to find slow traces
2. \`trace_get\` with the trace ID to see all spans
3. \`logs_tail_context\` with the trace ID for correlated logs
4. \`metrics_query\` for resource metrics at that time

### Check system health
1. \`metrics_targets\` for scrape target status
2. \`metrics_alerts\` with \`filter: "firing"\` for active alerts
3. \`system_health\` for application-level health
4. \`traces_dependencies\` for service topology
`,
      }],
    }),
  );
}
