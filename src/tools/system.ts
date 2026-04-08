/**
 * System skill — health checks, anomaly detection, and service topology.
 *
 * Tools: anomalies_active, anomalies_baselines, system_health, system_topology
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill, SkillHelpers } from '../skill.js';
import { textResult, errorResult } from '../helpers.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const appApiUrl = helpers.env('APP_API_URL', 'http://localhost:5000');
  const jaegerUrl = helpers.env('JAEGER_URL', 'http://localhost:16686');
  const fetchApp = helpers.createFetcher('APP_API', 'app-api');
  const fetchJaeger = helpers.createFetcher('JAEGER', 'jaeger');

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

export const skill: Skill = {
  id: 'system',
  name: 'System Health',
  description: 'Health checks, anomaly detection, and live service topology',
  tools: 4,
  backends: ['App API', 'Jaeger'],
  isAvailable: () => true,
  register: registerTools,
};
