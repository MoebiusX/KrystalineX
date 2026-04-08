/**
 * Elasticsearch skill — search documents, inspect indices, and monitor cluster health.
 *
 * Tools: es_search, es_cluster_health, es_indices, es_index_mapping, es_cat_nodes
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill, SkillHelpers } from '../skill.js';
import { textResult, errorResult } from '../helpers.js';

function registerTools(server: McpServer, helpers: SkillHelpers): void {
  const esUrl = helpers.env('ELASTICSEARCH_URL');
  if (!esUrl) return;

  const fetchJSON = helpers.createFetcher('ELASTICSEARCH', 'elasticsearch');

  // ── es_search ─────────────────────────────────────────────────────────────

  server.tool(
    'es_search',
    'Full-text search across Elasticsearch indices. Supports query strings, filters, and aggregations.',
    {
      index: z.string().default('*').describe('Index pattern (e.g. "logs-*", "traces-*", or "*" for all)'),
      query: z.string().describe('Search query (Lucene syntax, e.g. "level:error AND service:api")'),
      size: z.number().default(20).describe('Maximum documents to return'),
      sort: z.string().optional().describe('Sort field (e.g. "@timestamp:desc")'),
      from: z.number().default(0).describe('Offset for pagination'),
      fields: z.array(z.string()).optional().describe('Specific fields to return (default: all)'),
    },
    async ({ index, query, size, sort, from, fields }) => {
      try {
        const body: any = {
          query: { query_string: { query } },
          size,
          from,
        };
        if (sort) {
          const [field, order] = sort.split(':');
          body.sort = [{ [field!]: { order: order || 'desc' } }];
        }
        if (fields && fields.length > 0) {
          body._source = fields;
        }

        const data = await fetchJSON(
          `${esUrl}/${encodeURIComponent(index)}/_search`,
          undefined,
          { method: 'POST', body: JSON.stringify(body) },
        );

        const hits = (data.hits?.hits || []).map((h: any) => ({
          _index: h._index,
          _id: h._id,
          _score: h._score,
          ...h._source,
        }));

        return textResult({
          total: data.hits?.total?.value ?? data.hits?.total ?? 0,
          returned: hits.length,
          hits,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── es_cluster_health ─────────────────────────────────────────────────────

  server.tool(
    'es_cluster_health',
    'Get Elasticsearch cluster health — status (green/yellow/red), node count, shard allocation.',
    {},
    async () => {
      try {
        const data = await fetchJSON(`${esUrl}/_cluster/health`);
        return textResult({
          cluster: data.cluster_name,
          status: data.status,
          nodes: data.number_of_nodes,
          dataNodes: data.number_of_data_nodes,
          shards: {
            active: data.active_shards,
            primary: data.active_primary_shards,
            relocating: data.relocating_shards,
            initializing: data.initializing_shards,
            unassigned: data.unassigned_shards,
          },
          activeShardsPercent: data.active_shards_percent_as_number,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── es_indices ────────────────────────────────────────────────────────────

  server.tool(
    'es_indices',
    'List Elasticsearch indices with document counts, storage size, and health status.',
    {
      pattern: z.string().default('*').describe('Index name pattern (e.g. "logs-*")'),
      sort_by: z.enum(['docs.count', 'store.size', 'index']).default('index')
        .describe('Sort indices by field'),
    },
    async ({ pattern, sort_by }) => {
      try {
        const data = await fetchJSON(
          `${esUrl}/_cat/indices/${encodeURIComponent(pattern)}?format=json&s=${sort_by}:desc`,
        );
        const indices = (Array.isArray(data) ? data : []).map((idx: any) => ({
          index: idx.index,
          health: idx.health,
          status: idx.status,
          docsCount: idx['docs.count'],
          storeSize: idx['store.size'],
          primaryShards: idx.pri,
          replicas: idx.rep,
        }));
        return textResult({ count: indices.length, indices });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── es_index_mapping ──────────────────────────────────────────────────────

  server.tool(
    'es_index_mapping',
    'Get the field mappings for an Elasticsearch index — shows field names, types, and analyzers.',
    {
      index: z.string().describe('Index name (e.g. "logs-2026.03")'),
    },
    async ({ index }) => {
      try {
        const data = await fetchJSON(
          `${esUrl}/${encodeURIComponent(index)}/_mapping`,
        );
        // Flatten nested mapping structure for readability
        const mappings: Record<string, any> = {};
        for (const [idxName, idxData] of Object.entries(data)) {
          mappings[idxName] = (idxData as any)?.mappings?.properties || {};
        }
        return textResult({ index, mappings });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ── es_cat_nodes ──────────────────────────────────────────────────────────

  server.tool(
    'es_cat_nodes',
    'Get Elasticsearch node resource usage — CPU, heap, disk, load average per node.',
    {},
    async () => {
      try {
        const data = await fetchJSON(
          `${esUrl}/_cat/nodes?format=json&h=name,ip,heap.percent,ram.percent,cpu,load_1m,load_5m,disk.used_percent,node.role,master`,
        );
        const nodes = (Array.isArray(data) ? data : []).map((n: any) => ({
          name: n.name,
          ip: n.ip,
          heapPercent: n['heap.percent'],
          ramPercent: n['ram.percent'],
          cpu: n.cpu,
          load1m: n.load_1m,
          load5m: n.load_5m,
          diskUsedPercent: n['disk.used_percent'],
          role: n['node.role'],
          master: n.master === '*',
        }));
        return textResult({ count: nodes.length, nodes });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}

export const skill: Skill = {
  id: 'elasticsearch',
  name: 'Elasticsearch',
  description: 'Full-text search, cluster health, and index management via Elasticsearch',
  tools: 5,
  backends: ['Elasticsearch'],
  isAvailable: () => !!process.env['ELASTICSEARCH_URL'],
  register: registerTools,
};
