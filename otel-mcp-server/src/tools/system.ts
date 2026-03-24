/**
 * System health & anomaly detection tools.
 *
 * These tools are optional and require an application API that exposes
 * health/monitoring endpoints. They work well with any application
 * that provides similar REST APIs.
 *
 * Tools:
 *   anomalies_active    — Get active anomalies
 *   anomalies_baselines — Get anomaly detection baselines
 *   system_health       — Full system health check
 *   system_topology     — Live service dependency topology
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { createFetcher, textResult, errorResult } from '../helpers.js';

export function registerSystemTools(server: McpServer, config: Config): void {
  const { appApiUrl, jaegerUrl } = config;
  const fetchApp = createFetcher(config.timeoutMs, config.auth.appApi);
  const fetchJaeger = createFetcher(config.timeoutMs, config.auth.jaeger);

  // ── anomalies_active ──────────────────────────────────────────────────────

  server.tool(
    'anomalies_active',
    'Get currently active anomalies detected by trace-based and amount-based detectors.',
    {
      type: z.enum(['trace', 'amount', 'all']).default('all')
        .describe('Anomaly type to retrieve'),
    },
    async ({ type }) => {
      try {
        const results: Record<string, any> = {};
        if (type === 'trace' || type === 'all') {
          results.traceAnomalies = await fetchApp(`${appApiUrl}/api/monitor/anomalies`);
        }
        if (type === 'amount' || type === 'all') {
          results.amountAnomalies = await fetchApp(`${appApiUrl}/api/monitor/amount-anomalies`);
        }
        return textResult(results);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── anomalies_baselines ───────────────────────────────────────────────────

  server.tool(
    'anomalies_baselines',
    'Get current span duration baselines used for anomaly detection — mean, stdDev, p50, p95, p99 per operation.',
    {},
    async () => {
      try {
        const data = await fetchApp(`${appApiUrl}/api/monitor/baselines/enriched`);
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── system_health ─────────────────────────────────────────────────────────

  server.tool(
    'system_health',
    'Get full system health — service status, uptime, performance metrics, active alerts.',
    {},
    async () => {
      try {
        const data = await fetchApp(`${appApiUrl}/api/monitor/health`);
        return textResult(data);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── system_topology ───────────────────────────────────────────────────────

  server.tool(
    'system_topology',
    'Get the live service dependency topology with health overlays from Jaeger and the application API.',
    {},
    async () => {
      try {
        const [deps, health] = await Promise.all([
          fetchJaeger(`${jaegerUrl}/api/dependencies?endTs=${Date.now()}&lookback=3600000`),
          fetchApp(`${appApiUrl}/api/monitor/health`).catch(() => null),
        ]);
        return textResult({ dependencies: deps.data || [], health });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
