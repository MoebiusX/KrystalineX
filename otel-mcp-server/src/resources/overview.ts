/**
 * MCP resources — auto-generated context documents for AI agents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Skill } from '../skill.js';

export function registerResources(server: McpServer, skills: Skill[]): void {
  server.resource(
    'platform-overview',
    'otel://overview',
    async () => ({
      contents: [{
        uri: 'otel://overview',
        mimeType: 'text/markdown',
        text: generateOverview(skills),
      }],
    }),
  );
}

function generateOverview(skills: Skill[]): string {
  const totalTools = skills.reduce((sum, s) => sum + s.tools, 0);

  const skillSections = skills.map(s =>
    `### ${s.name} — \`${s.id}\` (${s.tools} tools)\n` +
    `${s.description}.\n` +
    `Backends: ${s.backends.join(', ')}`,
  ).join('\n\n');

  return `# OpenTelemetry MCP Server — Platform Overview

## Active Skills (${skills.length} skills, ${totalTools} tools)

${skillSections}

## Self-Metrics

The server exposes its own metrics at \`GET /metrics\` (HTTP mode):
- \`mcp_backend_requests_total\` — Outbound backend request counter
- \`mcp_backend_duration_seconds\` — Backend request latency histogram
- \`mcp_auth_attempts_total\` — Authentication attempt counter
- \`mcp_active_sessions\` — Current connected sessions gauge
- \`mcp_uptime_seconds\` — Server uptime

## Common Workflows

### Investigate a slow request
1. \`traces_search\` with \`min_duration: "1s"\` to find slow traces
2. \`trace_get\` with the trace ID to see all spans
3. \`logs_tail_context\` with the trace ID for correlated logs
4. \`metrics_query\` for resource metrics at that time

### Check system health
1. \`metrics_targets\` for scrape target status
2. \`metrics_alerts\` with \`filter: "firing"\` for active alerts
3. \`alertmanager_alerts\` for routed alert status
4. \`system_health\` for application-level health
5. \`traces_dependencies\` for service topology

### Search logs across Elasticsearch
1. \`es_cluster_health\` to verify cluster status
2. \`es_indices\` to find relevant indices
3. \`es_search\` with Lucene query for full-text log search
`;
}
