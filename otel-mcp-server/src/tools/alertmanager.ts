/**
 * Alertmanager skill — query active alerts, silences, and alert groups.
 *
 * Tools: alertmanager_alerts, alertmanager_silences, alertmanager_groups, alertmanager_status
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill, SkillHelpers } from '../skill.js';
import { textResult, errorResult } from '../helpers.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const amUrl = helpers.env('ALERTMANAGER_URL');
  if (!amUrl) return;

  const fetchJSON = helpers.createFetcher('ALERTMANAGER', 'alertmanager');

  // ── alertmanager_alerts ───────────────────────────────────────────────────

  server.tool(
    'alertmanager_alerts',
    'Get active alerts from Alertmanager with labels, annotations, status, and timing.',
    {
      filter: z.array(z.string()).optional()
        .describe('Label matchers to filter alerts (e.g. ["severity=critical", "service=api"])'),
      silenced: z.boolean().default(false).describe('Include silenced alerts'),
      inhibited: z.boolean().default(false).describe('Include inhibited alerts'),
      active: z.boolean().default(true).describe('Include active (firing) alerts'),
    },
    async ({ filter, silenced, inhibited, active }) => {
      try {
        const qs = new URLSearchParams();
        qs.set('silenced', String(silenced));
        qs.set('inhibited', String(inhibited));
        qs.set('active', String(active));
        if (filter) {
          for (const f of filter) qs.append('filter', f);
        }

        const data = await fetchJSON(`${amUrl}/api/v2/alerts?${qs}`);
        const alerts = (Array.isArray(data) ? data : []).map((a: any) => ({
          fingerprint: a.fingerprint,
          status: a.status?.state,
          labels: a.labels,
          annotations: a.annotations,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          generatorURL: a.generatorURL,
          silencedBy: a.status?.silencedBy || [],
          inhibitedBy: a.status?.inhibitedBy || [],
        }));
        return textResult({ count: alerts.length, alerts });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── alertmanager_silences ─────────────────────────────────────────────────

  server.tool(
    'alertmanager_silences',
    'List alert silences — active, pending, and expired. Shows who created them and which alerts they match.',
    {
      state: z.enum(['active', 'pending', 'expired', 'all']).default('active')
        .describe('Filter silences by state'),
    },
    async ({ state }) => {
      try {
        const data = await fetchJSON(`${amUrl}/api/v2/silences`);
        const silences = (Array.isArray(data) ? data : [])
          .filter((s: any) => state === 'all' || s.status?.state === state)
          .map((s: any) => ({
            id: s.id,
            status: s.status?.state,
            createdBy: s.createdBy,
            comment: s.comment,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            matchers: (s.matchers || []).map((m: any) => ({
              name: m.name,
              value: m.value,
              isRegex: m.isRegex,
              isEqual: m.isEqual,
            })),
          }));
        return textResult({ count: silences.length, silences });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── alertmanager_groups ───────────────────────────────────────────────────

  server.tool(
    'alertmanager_groups',
    'Get alert groups — shows how alerts are grouped by routing rules with their receivers.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${amUrl}/api/v2/alerts/groups`);
        const groups = (Array.isArray(data) ? data : []).map((g: any) => ({
          labels: g.labels,
          receiver: g.receiver?.name,
          alerts: (g.alerts || []).map((a: any) => ({
            fingerprint: a.fingerprint,
            status: a.status?.state,
            labels: a.labels,
            annotations: a.annotations,
            startsAt: a.startsAt,
          })),
        }));
        return textResult({ count: groups.length, groups });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── alertmanager_status ───────────────────────────────────────────────────

  server.tool(
    'alertmanager_status',
    'Get Alertmanager status — version, uptime, cluster peers, and current configuration.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${amUrl}/api/v2/status`);
        return textResult({
          version: data.versionInfo?.version,
          uptime: data.uptime,
          cluster: {
            status: data.cluster?.status,
            peers: data.cluster?.peers?.length ?? 0,
          },
          config: data.config?.original || '(not exposed)',
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}

export const skill: Skill = {
  id: 'alertmanager',
  name: 'Alertmanager',
  description: 'Query active alerts, silences, and alert groups via the Alertmanager v2 API',
  tools: 4,
  backends: ['Alertmanager'],
  isAvailable: () => !!process.env['ALERTMANAGER_URL'],
  register: registerTools,
};
