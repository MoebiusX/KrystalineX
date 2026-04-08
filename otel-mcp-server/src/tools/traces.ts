/**
 * Traces skill — query distributed traces via the Jaeger Query API.
 *
 * Tools: traces_search, trace_get, traces_services, traces_operations, traces_dependencies
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill, SkillHelpers } from '../skill.js';
import { textResult, errorResult, parseDuration } from '../helpers.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const jaegerUrl = helpers.env('JAEGER_URL', 'http://localhost:16686');
  const fetchJSON = helpers.createFetcher('JAEGER', 'jaeger');

  // ── traces_search ─────────────────────────────────────────────────────────

  server.tool(
    'traces_search',
    'Search distributed traces by service, operation, tags, or duration. Returns trace summaries with timing, span count, and error status.',
    {
      service: z.string().describe('Service name (e.g. my-api, my-worker)'),
      operation: z.string().optional().describe('Filter by operation name'),
      tags: z.string().optional().describe('JSON object of span tags to filter (e.g. {"http.status_code":"500"})'),
      min_duration: z.string().optional().describe('Minimum duration filter (e.g. "500ms", "1s")'),
      max_duration: z.string().optional().describe('Maximum duration filter'),
      lookback: z.string().default('1h').describe('Time window (e.g. "1h", "30m", "2d")'),
      limit: z.number().default(20).describe('Max traces to return'),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams({
          service: params.service,
          lookback: params.lookback,
          limit: String(params.limit),
        });
        if (params.operation) qs.set('operation', params.operation);
        if (params.tags) qs.set('tags', params.tags);
        if (params.min_duration) qs.set('minDuration', params.min_duration);
        if (params.max_duration) qs.set('maxDuration', params.max_duration);

        const data = await fetchJSON(`${jaegerUrl}/api/traces?${qs}`);
        const traces = (data.data || []).map((t: any) => {
          const spans = t.spans || [];
          const root = spans[0];
          const services = Array.from(new Set(
            spans.map((s: any) => s.processID)
              .map((pid: string) => t.processes?.[pid]?.serviceName || pid),
          ));
          return {
            traceId: t.traceID,
            rootOperation: root?.operationName,
            spanCount: spans.length,
            duration_ms: (root?.duration || 0) / 1000,
            services,
            startTime: root ? new Date(root.startTime / 1000).toISOString() : null,
            hasErrors: spans.some((s: any) =>
              s.tags?.some((tag: any) => tag.key === 'error' && tag.value === true),
            ),
          };
        });
        return textResult({ count: traces.length, traces });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── trace_get ─────────────────────────────────────────────────────────────

  server.tool(
    'trace_get',
    'Get full trace detail — all spans with timing, tags, logs, and parent-child relationships.',
    {
      trace_id: z.string().describe('Jaeger trace ID (hex string)'),
    },
    async ({ trace_id }) => {
      try {
        const data = await fetchJSON(`${jaegerUrl}/api/traces/${trace_id}`);
        const trace = data.data?.[0];
        if (!trace) return errorResult(`Trace ${trace_id} not found`);

        const spans = (trace.spans || []).map((s: any) => ({
          spanId: s.spanID,
          parentSpanId: s.references?.[0]?.spanID || null,
          operationName: s.operationName,
          service: trace.processes?.[s.processID]?.serviceName,
          duration_ms: s.duration / 1000,
          startTime: new Date(s.startTime / 1000).toISOString(),
          tags: Object.fromEntries((s.tags || []).map((t: any) => [t.key, t.value])),
          logs: (s.logs || []).map((l: any) => ({
            timestamp: new Date(l.timestamp / 1000).toISOString(),
            fields: Object.fromEntries((l.fields || []).map((f: any) => [f.key, f.value])),
          })),
        }));

        return textResult({
          traceId: trace.traceID,
          spanCount: spans.length,
          totalDuration_ms: spans[0]?.duration_ms,
          services: Array.from(new Set(spans.map((s: any) => s.service))),
          spans,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── traces_services ───────────────────────────────────────────────────────

  server.tool(
    'traces_services',
    'List all services currently reporting traces to Jaeger.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${jaegerUrl}/api/services`);
        return textResult({ services: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── traces_operations ─────────────────────────────────────────────────────

  server.tool(
    'traces_operations',
    'List all operations for a given service.',
    { service: z.string().describe('Service name') },
    async ({ service }) => {
      try {
        const data = await fetchJSON(
          `${jaegerUrl}/api/operations?service=${encodeURIComponent(service)}`,
        );
        return textResult({ service, operations: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── traces_dependencies ───────────────────────────────────────────────────

  server.tool(
    'traces_dependencies',
    'Get service dependency graph — which services call which, with call counts.',
    {
      lookback: z.string().default('1h').describe('Time window to compute dependencies (e.g. "1h", "6h", "1d")'),
    },
    async ({ lookback }) => {
      try {
        const lookbackMs = parseDuration(lookback);
        const endTs = Date.now();
        const data = await fetchJSON(
          `${jaegerUrl}/api/dependencies?endTs=${endTs}&lookback=${lookbackMs}`,
        );
        return textResult({ dependencies: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}

export const skill: Skill = {
  id: 'traces',
  name: 'Distributed Traces',
  description: 'Search and analyze distributed traces via the Jaeger Query API',
  tools: 5,
  backends: ['Jaeger'],
  isAvailable: () => true,
  register: registerTools,
};
