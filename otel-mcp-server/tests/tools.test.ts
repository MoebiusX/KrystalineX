import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

/**
 * Integration tests — creates a real MCP server + client connected
 * via in-memory transport, then calls tools against mocked backends.
 */

function mockFetch(responses: Record<string, any>) {
  return vi.fn(async (url: string | URL | Request) => {
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
//  Tool Listing
// ═══════════════════════════════════════════════════════════════════════════

describe('tool listing', () => {
  it('lists all 23 tools when all groups enabled', async () => {
    const { client } = await createTestClient();
    const result = await client.listTools();
    expect(result.tools.length).toBe(23);
  });

  it('lists only trace tools (5) when restricted', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.listTools();

    const names = result.tools.map(t => t.name);
    expect(names).toContain('traces_search');
    expect(names).toContain('trace_get');
    expect(names).toContain('traces_services');
    expect(names).toContain('traces_operations');
    expect(names).toContain('traces_dependencies');
    expect(names).not.toContain('metrics_query');
    expect(names).not.toContain('logs_query');
    expect(result.tools.length).toBe(5);
  });

  it('lists only metrics tools (6) when restricted', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.listTools();
    expect(result.tools.length).toBe(6);
    expect(result.tools.map(t => t.name)).toContain('metrics_query');
    expect(result.tools.map(t => t.name)).toContain('metrics_query_range');
  });

  it('lists only log tools (4) when restricted', async () => {
    const { client } = await createTestClient(['logs']);
    const result = await client.listTools();
    expect(result.tools.length).toBe(4);
  });

  it('combines multiple groups', async () => {
    const { client } = await createTestClient(['traces', 'logs']);
    const result = await client.listTools();
    expect(result.tools.length).toBe(9); // 5 + 4
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Trace Tools
// ═══════════════════════════════════════════════════════════════════════════

describe('trace tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/traces?': {
        data: [{
          traceID: 'abc123',
          spans: [{
            spanID: 's1',
            operationName: 'GET /api/test',
            processID: 'p1',
            duration: 50000,
            startTime: 1700000000000000,
            tags: [],
            references: [],
          }],
          processes: { p1: { serviceName: 'my-service' } },
        }],
      },
      '/api/traces/abc123': {
        data: [{
          traceID: 'abc123',
          spans: [{
            spanID: 's1',
            operationName: 'GET /api/test',
            processID: 'p1',
            duration: 50000,
            startTime: 1700000000000000,
            tags: [{ key: 'http.method', value: 'GET' }],
            logs: [],
            references: [],
          }],
          processes: { p1: { serviceName: 'my-service' } },
        }],
      },
      '/api/services': { data: ['my-service', 'other-service'] },
      '/api/operations': { data: ['GET /api/test', 'POST /api/orders'] },
      '/api/dependencies': { data: [{ parent: 'gateway', child: 'api', callCount: 100 }] },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('traces_search returns formatted results', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({
      name: 'traces_search',
      arguments: { service: 'my-service', lookback: '1h', limit: 10 },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(1);
    expect(content.traces[0].traceId).toBe('abc123');
    expect(content.traces[0].spanCount).toBe(1);
    expect(content.traces[0].services).toContain('my-service');
  });

  it('trace_get returns full span details', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({
      name: 'trace_get',
      arguments: { trace_id: 'abc123' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.traceId).toBe('abc123');
    expect(content.spans).toHaveLength(1);
    expect(content.spans[0].operationName).toBe('GET /api/test');
    expect(content.spans[0].tags['http.method']).toBe('GET');
  });

  it('traces_services returns service list', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({ name: 'traces_services', arguments: {} });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.services).toContain('my-service');
    expect(content.services).toContain('other-service');
  });

  it('traces_operations returns operations', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({
      name: 'traces_operations',
      arguments: { service: 'my-service' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.operations).toContain('GET /api/test');
  });

  it('traces_dependencies returns dependency graph', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({
      name: 'traces_dependencies',
      arguments: { lookback: '1h' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.dependencies[0].parent).toBe('gateway');
    expect(content.dependencies[0].child).toBe('api');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Metrics Tools
// ═══════════════════════════════════════════════════════════════════════════

describe('metrics tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/v1/query?': {
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: { __name__: 'up' }, value: [1700000000, '1'] }] },
      },
      '/api/v1/query_range?': {
        status: 'success',
        data: { resultType: 'matrix', result: [] },
      },
      '/api/v1/targets': {
        data: {
          activeTargets: [
            { labels: { job: 'my-api', instance: 'localhost:5000' }, health: 'up', lastScrape: '2026-01-01T00:00:00Z' },
          ],
        },
      },
      '/api/v1/rules': {
        data: {
          groups: [{
            name: 'test-alerts',
            rules: [{ name: 'HighErrorRate', state: 'firing', labels: { severity: 'critical' }, query: 'rate(errors[5m]) > 0.05', duration: 300, alerts: [{ activeAt: '2026-01-01T00:00:00Z' }], annotations: { summary: 'High errors' } }],
          }],
        },
      },
      '/api/v1/metadata': {
        data: { http_requests_total: [{ type: 'counter', help: 'Total requests', unit: '' }] },
      },
      '/api/v1/label/': {
        data: ['my-api', 'prometheus'],
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('metrics_query returns instant results', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.callTool({
      name: 'metrics_query',
      arguments: { query: 'up' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.status).toBe('success');
    expect(content.resultType).toBe('vector');
  });

  it('metrics_targets returns target health', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.callTool({ name: 'metrics_targets', arguments: {} });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.activeTargets).toBe(1);
    expect(content.targets[0].health).toBe('up');
  });

  it('metrics_alerts filters by state', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.callTool({
      name: 'metrics_alerts',
      arguments: { filter: 'firing' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.groups[0].rules[0].name).toBe('HighErrorRate');
    expect(content.groups[0].rules[0].state).toBe('firing');
  });

  it('metrics_metadata returns metric info', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.callTool({
      name: 'metrics_metadata',
      arguments: { metric: 'http_requests_total' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.metadata[0].type).toBe('counter');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Log Tools
// ═══════════════════════════════════════════════════════════════════════════

describe('log tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch({
      '/loki/api/v1/query_range': {
        data: {
          result: [{
            stream: { app: 'my-api' },
            values: [
              ['1700000000000000000', '{"level":"error","msg":"connection refused"}'],
              ['1700000001000000000', 'plain text log line'],
            ],
          }],
        },
      },
      '/loki/api/v1/labels': { data: ['app', 'namespace', 'pod'] },
      '/loki/api/v1/label/app/values': { data: ['my-api', 'my-worker'] },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs_query returns parsed log lines', async () => {
    const { client } = await createTestClient(['logs']);
    const result = await client.callTool({
      name: 'logs_query',
      arguments: { query: '{app="my-api"} |= "error"' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.count).toBe(2);
    // First line is parsed JSON
    expect(content.logs[0].line.level).toBe('error');
    // Second line is plain text
    expect(content.logs[1].line).toBe('plain text log line');
  });

  it('logs_labels returns label names', async () => {
    const { client } = await createTestClient(['logs']);
    const result = await client.callTool({ name: 'logs_labels', arguments: {} });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.labels).toContain('app');
  });

  it('logs_tail_context searches by trace ID', async () => {
    const { client } = await createTestClient(['logs']);
    const result = await client.callTool({
      name: 'logs_tail_context',
      arguments: { trace_id: 'abc123def456' },
    });

    const content = JSON.parse((result.content as any)[0].text);
    expect(content.traceId).toBe('abc123def456');
    expect(content.matchingLogs).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('error handling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, statusText: 'Service Unavailable',
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns MCP error when backend is down', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.callTool({
      name: 'traces_services',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('503');
  });

  it('returns MCP error for metrics when Prometheus is down', async () => {
    const { client } = await createTestClient(['metrics']);
    const result = await client.callTool({
      name: 'metrics_query',
      arguments: { query: 'up' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('Error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Resources
// ═══════════════════════════════════════════════════════════════════════════

describe('resources', () => {
  it('lists the overview resource', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.listResources();

    expect(result.resources.length).toBeGreaterThanOrEqual(1);
    expect(result.resources.some(r => r.uri === 'otel://overview')).toBe(true);
  });

  it('reads the overview resource', async () => {
    const { client } = await createTestClient(['traces']);
    const result = await client.readResource({ uri: 'otel://overview' });

    const text = (result.contents[0] as any).text;
    expect(text).toContain('OpenTelemetry');
    expect(text).toContain('Traces');
    expect(text).toContain('Metrics');
  });
});
