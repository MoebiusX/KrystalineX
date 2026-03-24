/**
 * Log tools — query structured logs via the Loki HTTP API.
 *
 * Tools:
 *   logs_query        — LogQL query for log lines
 *   logs_labels       — List all label names
 *   logs_label_values — Get values for a label
 *   logs_tail_context — Find logs correlated with a trace ID
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { createFetcher, textResult, errorResult, tryParseJSON } from '../helpers.js';

function parseLokiStreams(streams: any[]): any[] {
  return streams.flatMap((s: any) =>
    (s.values || []).map(([ts, line]: [string, string]) => ({
      timestamp: new Date(Number(BigInt(ts) / BigInt(1_000_000))).toISOString(),
      labels: s.stream,
      line: tryParseJSON(line),
    })),
  );
}

export function registerLogTools(server: McpServer, config: Config): void {
  const { lokiUrl } = config;
  const lokiTimeout = Math.max(config.timeoutMs, 30_000); // logs can be slow
  const fetchJSON = createFetcher(lokiTimeout, config.auth.loki);

  // ── logs_query ────────────────────────────────────────────────────────────

  server.tool(
    'logs_query',
    'Query logs from Loki using LogQL. Returns log lines matching the query.',
    {
      query: z.string().describe('LogQL query (e.g. {app="my-api"} |= "error")'),
      start: z.string().optional().describe('Start time (ISO 8601 or Unix nanoseconds). Defaults to 1h ago.'),
      end: z.string().optional().describe('End time. Defaults to now.'),
      limit: z.number().default(100).describe('Maximum log lines to return'),
      direction: z.enum(['forward', 'backward']).default('backward').describe('Sort order'),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams({
          query: params.query,
          limit: String(params.limit),
          direction: params.direction,
        });
        if (params.start) qs.set('start', params.start);
        if (params.end) qs.set('end', params.end);

        const data = await fetchJSON(`${lokiUrl}/loki/api/v1/query_range?${qs}`);
        const lines = parseLokiStreams(data.data?.result || []);
        return textResult({ count: lines.length, logs: lines });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── logs_labels ───────────────────────────────────────────────────────────

  server.tool(
    'logs_labels',
    'List all label names available in Loki.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${lokiUrl}/loki/api/v1/labels`);
        return textResult({ labels: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── logs_label_values ─────────────────────────────────────────────────────

  server.tool(
    'logs_label_values',
    'Get all values for a Loki label (e.g. all app names, namespaces, components).',
    {
      label: z.string().describe('Label name (e.g. "app", "namespace", "component")'),
    },
    async ({ label }) => {
      try {
        const data = await fetchJSON(
          `${lokiUrl}/loki/api/v1/label/${encodeURIComponent(label)}/values`,
        );
        return textResult({ label, values: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── logs_tail_context ─────────────────────────────────────────────────────

  server.tool(
    'logs_tail_context',
    'Get recent logs correlated with a specific trace ID. Searches across all apps for log lines containing the trace ID.',
    {
      trace_id: z.string().describe('Trace ID to search for in log lines'),
      limit: z.number().default(50).describe('Max log lines'),
    },
    async ({ trace_id, limit }) => {
      try {
        const query = `{app=~".+"} |~ "${trace_id}"`;
        const qs = new URLSearchParams({
          query,
          limit: String(limit),
          direction: 'backward',
        });
        const data = await fetchJSON(`${lokiUrl}/loki/api/v1/query_range?${qs}`);
        const lines = parseLokiStreams(data.data?.result || []);
        return textResult({ traceId: trace_id, matchingLogs: lines.length, logs: lines });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
