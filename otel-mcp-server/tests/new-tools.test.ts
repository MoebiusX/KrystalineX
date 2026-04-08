import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

function mockFetch(responses: Record<string, any>) {
  return vi.fn(async (url: string | URL | Request, init?: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, data] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return { ok: true, json: async () => data };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

async function createTestClient(tools?: string[]) {
  const server = createServer(tools ? { tools } : undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Elasticsearch Tools
// ═══════════════════════════════════════════════════════════════════════════

describe('elasticsearch tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ELASTICSEARCH_URL = 'http://es:9200';
    vi.stubGlobal('fetch', mockFetch({
      '/_search': {
        hits: {
          total: { value: 42 },
          hits: [
            { _index: 'logs-2026.03', _id: 'doc1', _score: 1.5, _source: { message: 'test log', level: 'error' } },
            { _index: 'logs-2026.03', _id: 'doc2', _score: 1.2, _source: { message: 'another', level: 'info' } },
          ],
        },
      },
      '/_cluster/health': {
        cluster_name: 'kx-cluster',
        status: 'green',
        number_of_nodes: 3,
        number_of_data_nodes: 2,
        active_shards: 100,
        active_primary_shards: 50,
        relocating_shards: 0,
        initializing_shards: 0,
        unassigned_shards: 0,
        active_shards_percent_as_number: 100.0,
      },
      '/_cat/indices': [
        { index: 'logs-2026.03', health: 'green', status: 'open', 'docs.count': '50000', 'store.size': '1.2gb', pri: '5', rep: '1' },
        { index: 'traces-2026.03', health: 'green', status: 'open', 'docs.count': '30000', 'store.size': '800mb', pri: '3', rep: '1' },
      ],
      '/_mapping': {
        'logs-2026.03': {
          mappings: {
            properties: {
              message: { type: 'text' },
              level: { type: 'keyword' },
              timestamp: { type: 'date' },
            },
          },
        },
      },
      '/_cat/nodes': [
        { name: 'es-node-1', ip: '10.0.0.1', 'heap.percent': '45', 'ram.percent': '72', cpu: '12', load_1m: '1.2', load_5m: '1.0', 'disk.used_percent': '60', 'node.role': 'dim', master: '*' },
      ],
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('registers 5 ES tools when URL is configured', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.listTools();
    expect(result.tools.length).toBe(5);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('es_search');
    expect(names).toContain('es_cluster_health');
    expect(names).toContain('es_indices');
    expect(names).toContain('es_index_mapping');
    expect(names).toContain('es_cat_nodes');
  });

  it('registers 0 ES tools when URL is empty', async () => {
    delete process.env.ELASTICSEARCH_URL;
    const server = createServer({ tools: ['elasticsearch'] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // No tools registered — listTools throws "Method not found"
    await expect(client.listTools()).rejects.toThrow();
  });

  it('es_search returns formatted hits', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.callTool({
      name: 'es_search',
      arguments: { query: 'level:error', index: 'logs-*' },
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.total).toBe(42);
    expect(content.returned).toBe(2);
    expect(content.hits[0].message).toBe('test log');
    expect(content.hits[0]._index).toBe('logs-2026.03');
  });

  it('es_cluster_health returns cluster info', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.callTool({
      name: 'es_cluster_health',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.cluster).toBe('kx-cluster');
    expect(content.status).toBe('green');
    expect(content.nodes).toBe(3);
  });

  it('es_indices returns index list', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.callTool({
      name: 'es_indices',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(2);
    expect(content.indices[0].index).toBe('logs-2026.03');
  });

  it('es_index_mapping returns field mappings', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.callTool({
      name: 'es_index_mapping',
      arguments: { index: 'logs-2026.03' },
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.mappings['logs-2026.03'].message.type).toBe('text');
    expect(content.mappings['logs-2026.03'].level.type).toBe('keyword');
  });

  it('es_cat_nodes returns node info', async () => {
    const { client } = await createTestClient(['elasticsearch']);
    const result = await client.callTool({
      name: 'es_cat_nodes',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(1);
    expect(content.nodes[0].name).toBe('es-node-1');
    expect(content.nodes[0].master).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Alertmanager Tools
// ═══════════════════════════════════════════════════════════════════════════

describe('alertmanager tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ALERTMANAGER_URL = 'http://am:9093';
    vi.stubGlobal('fetch', mockFetch({
      '/api/v2/alerts?': [
        {
          fingerprint: 'abc123',
          status: { state: 'active', silencedBy: [], inhibitedBy: [] },
          labels: { alertname: 'HighErrorRate', severity: 'critical', service: 'api' },
          annotations: { summary: 'Error rate > 5%' },
          startsAt: '2026-03-24T18:00:00Z',
          endsAt: '0001-01-01T00:00:00Z',
          generatorURL: 'http://prometheus:9090/graph?g0.expr=...',
        },
      ],
      '/api/v2/silences': [
        {
          id: 'sil-1',
          status: { state: 'active' },
          createdBy: 'admin',
          comment: 'Maintenance window',
          startsAt: '2026-03-24T17:00:00Z',
          endsAt: '2026-03-24T19:00:00Z',
          matchers: [{ name: 'alertname', value: 'HighLatency', isRegex: false, isEqual: true }],
        },
        {
          id: 'sil-2',
          status: { state: 'expired' },
          createdBy: 'ci',
          comment: 'Deploy window',
          startsAt: '2026-03-23T00:00:00Z',
          endsAt: '2026-03-23T02:00:00Z',
          matchers: [{ name: 'service', value: 'api', isRegex: false, isEqual: true }],
        },
      ],
      '/api/v2/alerts/groups': [
        {
          labels: { service: 'api' },
          receiver: { name: 'pagerduty' },
          alerts: [
            {
              fingerprint: 'abc123',
              status: { state: 'active' },
              labels: { alertname: 'HighErrorRate', severity: 'critical' },
              annotations: { summary: 'Error rate > 5%' },
              startsAt: '2026-03-24T18:00:00Z',
            },
          ],
        },
      ],
      '/api/v2/status': {
        versionInfo: { version: '0.27.0' },
        uptime: '2026-03-24T12:00:00.000Z',
        cluster: { status: 'ready', peers: [{ name: 'am-1' }, { name: 'am-2' }] },
        config: { original: 'route:\n  receiver: default\n' },
      },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('registers 4 AM tools when URL is configured', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.listTools();
    expect(result.tools.length).toBe(4);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('alertmanager_alerts');
    expect(names).toContain('alertmanager_silences');
    expect(names).toContain('alertmanager_groups');
    expect(names).toContain('alertmanager_status');
  });

  it('registers 0 AM tools when URL is empty', async () => {
    delete process.env.ALERTMANAGER_URL;
    const server = createServer({ tools: ['alertmanager'] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // No tools registered — listTools throws "Method not found"
    await expect(client.listTools()).rejects.toThrow();
  });

  it('alertmanager_alerts returns active alerts', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.callTool({
      name: 'alertmanager_alerts',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(1);
    expect(content.alerts[0].fingerprint).toBe('abc123');
    expect(content.alerts[0].status).toBe('active');
    expect(content.alerts[0].labels.severity).toBe('critical');
  });

  it('alertmanager_silences filters by state', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.callTool({
      name: 'alertmanager_silences',
      arguments: { state: 'active' },
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(1);
    expect(content.silences[0].id).toBe('sil-1');
    expect(content.silences[0].comment).toBe('Maintenance window');
  });

  it('alertmanager_silences returns all when state=all', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.callTool({
      name: 'alertmanager_silences',
      arguments: { state: 'all' },
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(2);
  });

  it('alertmanager_groups returns alert groups', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.callTool({
      name: 'alertmanager_groups',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(1);
    expect(content.groups[0].receiver).toBe('pagerduty');
    expect(content.groups[0].alerts[0].labels.alertname).toBe('HighErrorRate');
  });

  it('alertmanager_status returns cluster info', async () => {
    const { client } = await createTestClient(['alertmanager']);
    const result = await client.callTool({
      name: 'alertmanager_status',
      arguments: {},
    });
    const content = JSON.parse((result.content as any)[0].text);
    expect(content.version).toBe('0.27.0');
    expect(content.cluster.status).toBe('ready');
    expect(content.cluster.peers).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Combined tool counts
// ═══════════════════════════════════════════════════════════════════════════

describe('combined tool registration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('registers 32 tools when all groups enabled with all backends', async () => {
    process.env.ELASTICSEARCH_URL = 'http://es:9200';
    process.env.ALERTMANAGER_URL = 'http://am:9093';
    const { client } = await createTestClient();
    const result = await client.listTools();
    // 5 traces + 6 metrics + 4 logs + 4 zk + 4 system + 5 es + 4 am = 32
    expect(result.tools.length).toBe(32);
  });

  it('registers 23 tools when ES/AM URLs are empty', async () => {
    delete process.env.ELASTICSEARCH_URL;
    delete process.env.ALERTMANAGER_URL;
    const { client } = await createTestClient();
    const result = await client.listTools();
    expect(result.tools.length).toBe(23);
  });
});
