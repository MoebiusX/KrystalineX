/**
 * Metrics tools — query Prometheus for metrics, alerts, and metadata.
 *
 * Tools:
 *   metrics_query        — Instant PromQL query
 *   metrics_query_range  — Range PromQL query (time series)
 *   metrics_targets      — List scrape targets and health
 *   metrics_alerts       — Active alerting rules
 *   metrics_metadata     — Metric type/help/unit lookup
 *   metrics_label_values — List values for a label
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { createFetcher, textResult, errorResult } from '../helpers.js';

export function registerMetricsTools(server: McpServer, config: Config): void {
  const promUrl = `${config.prometheusUrl}${config.prometheusPathPrefix}`;
  const fetchJSON = createFetcher(config.timeoutMs, config.auth.prometheus);

  // ── metrics_query ─────────────────────────────────────────────────────────

  server.tool(
    'metrics_query',
    'Execute an instant PromQL query and return current metric values.',
    {
      query: z.string().describe('PromQL expression (e.g. rate(http_requests_total[5m]))'),
      time: z.string().optional().describe('Evaluation timestamp (ISO 8601 or Unix epoch). Defaults to now.'),
    },
    async ({ query, time }) => {
      try {
        const qs = new URLSearchParams({ query });
        if (time) qs.set('time', time);
        const data = await fetchJSON(`${promUrl}/api/v1/query?${qs}`);
        return textResult({
          status: data.status,
          resultType: data.data?.resultType,
          result: data.data?.result,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── metrics_query_range ───────────────────────────────────────────────────

  server.tool(
    'metrics_query_range',
    'Execute a range PromQL query and return a time series.',
    {
      query: z.string().describe('PromQL expression'),
      start: z.string().describe('Range start (ISO 8601 or Unix epoch)'),
      end: z.string().describe('Range end (ISO 8601 or Unix epoch)'),
      step: z.string().default('60s').describe('Query resolution step (e.g. "15s", "1m", "5m")'),
    },
    async ({ query, start, end, step }) => {
      try {
        const qs = new URLSearchParams({ query, start, end, step });
        const data = await fetchJSON(`${promUrl}/api/v1/query_range?${qs}`);
        return textResult({
          status: data.status,
          resultType: data.data?.resultType,
          result: data.data?.result,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── metrics_targets ───────────────────────────────────────────────────────

  server.tool(
    'metrics_targets',
    'List all Prometheus scrape targets and their health status.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${promUrl}/api/v1/targets`);
        const targets = (data.data?.activeTargets || []).map((t: any) => ({
          job: t.labels?.job,
          instance: t.labels?.instance,
          health: t.health,
          lastScrape: t.lastScrape,
          lastError: t.lastError || null,
        }));
        return textResult({ activeTargets: targets.length, targets });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── metrics_alerts ────────────────────────────────────────────────────────

  server.tool(
    'metrics_alerts',
    'Get all Prometheus alerting rules and their current state (firing, pending, inactive).',
    {
      filter: z.enum(['all', 'firing', 'pending', 'inactive']).default('all')
        .describe('Filter alerts by state'),
    },
    async ({ filter }) => {
      try {
        const data = await fetchJSON(`${promUrl}/api/v1/rules?type=alert`);
        const groups = (data.data?.groups || []).map((g: any) => ({
          name: g.name,
          rules: (g.rules || [])
            .filter((r: any) => filter === 'all' || r.state === filter)
            .map((r: any) => ({
              name: r.name,
              state: r.state,
              severity: r.labels?.severity,
              query: r.query,
              duration: r.duration,
              activeAt: r.alerts?.[0]?.activeAt || null,
              annotations: r.annotations,
            })),
        })).filter((g: any) => g.rules.length > 0);
        return textResult({ groups });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── metrics_metadata ──────────────────────────────────────────────────────

  server.tool(
    'metrics_metadata',
    'Look up metric metadata — type, help text, and unit for a metric name.',
    {
      metric: z.string().describe('Metric name (e.g. http_requests_total)'),
    },
    async ({ metric }) => {
      try {
        const data = await fetchJSON(
          `${promUrl}/api/v1/metadata?metric=${encodeURIComponent(metric)}`,
        );
        return textResult({ metric, metadata: data.data?.[metric] || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── metrics_label_values ──────────────────────────────────────────────────

  server.tool(
    'metrics_label_values',
    'Get all values for a given Prometheus label (e.g. list all jobs, instances, or status codes).',
    {
      label: z.string().describe('Label name (e.g. "job", "instance", "status_code")'),
    },
    async ({ label }) => {
      try {
        const data = await fetchJSON(
          `${promUrl}/api/v1/label/${encodeURIComponent(label)}/values`,
        );
        return textResult({ label, values: data.data || [] });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
