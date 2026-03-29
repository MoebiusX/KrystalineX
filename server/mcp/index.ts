/**
 * KrystalineX OpenTelemetry MCP Server
 *
 * Exposes traces, metrics, logs, and ZK proofs as MCP tools
 * so any AI agent can query the platform's telemetry.
 *
 * Transport: stdio (standard MCP) or streamable HTTP
 * Usage:    node dist/mcp/index.js [--http <port>]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const JAEGER_URL = process.env.JAEGER_URL || 'http://localhost:16686';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
const KX_API_URL = process.env.KX_API_URL || 'http://localhost:5000';
const PROM_PATH_PREFIX = process.env.PROMETHEUS_PATH_PREFIX || '';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchJSON(url: string, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'krystalinex-otel',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════
//  TRACES (Jaeger)
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'traces_search',
  'Search distributed traces by service, operation, tags, or duration. Returns trace summaries.',
  {
    service: z.string().describe('Service name (e.g. kx-exchange, kx-matcher, kx-gateway, kx-wallet)'),
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

      const data = await fetchJSON(`${JAEGER_URL}/api/traces?${qs}`);
      const traces = (data.data || []).map((t: any) => {
        const spans = t.spans || [];
        const root = spans[0];
        const services = Array.from(new Set(spans.map((s: any) => s.processID).map((pid: string) => {
          const proc = t.processes?.[pid];
          return proc?.serviceName || pid;
        })));
        return {
          traceId: t.traceID,
          rootOperation: root?.operationName,
          spanCount: spans.length,
          duration_ms: (root?.duration || 0) / 1000,
          services,
          startTime: root ? new Date(root.startTime / 1000).toISOString() : null,
          hasErrors: spans.some((s: any) => s.tags?.some((tag: any) => tag.key === 'error' && tag.value === true)),
        };
      });
      return textResult({ count: traces.length, traces });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'trace_get',
  'Get full trace detail — all spans with timing, tags, and parent-child relationships.',
  {
    trace_id: z.string().describe('Jaeger trace ID'),
  },
  async ({ trace_id }) => {
    try {
      const data = await fetchJSON(`${JAEGER_URL}/api/traces/${trace_id}`);
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

server.tool(
  'traces_services',
  'List all services currently reporting traces to Jaeger.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${JAEGER_URL}/api/services`);
      return textResult({ services: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'traces_operations',
  'List all operations for a given service.',
  { service: z.string().describe('Service name') },
  async ({ service }) => {
    try {
      const data = await fetchJSON(`${JAEGER_URL}/api/operations?service=${encodeURIComponent(service)}`);
      return textResult({ service, operations: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'traces_dependencies',
  'Get service dependency graph (which services call which).',
  {
    lookback: z.string().default('1h').describe('Time window to compute dependencies'),
  },
  async ({ lookback }) => {
    try {
      const lookbackMs = parseDuration(lookback);
      const endTs = Date.now();
      const data = await fetchJSON(`${JAEGER_URL}/api/dependencies?endTs=${endTs}&lookback=${lookbackMs}`);
      return textResult({ dependencies: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  METRICS (Prometheus)
// ═══════════════════════════════════════════════════════════════════════════

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
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/query?${qs}`);
      return textResult({ status: data.status, resultType: data.data?.resultType, result: data.data?.result });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

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
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/query_range?${qs}`);
      return textResult({ status: data.status, resultType: data.data?.resultType, result: data.data?.result });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'metrics_targets',
  'List all Prometheus scrape targets and their health status.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/targets`);
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

server.tool(
  'metrics_alerts',
  'Get all active Prometheus alerting rules and their current state.',
  {
    filter: z.enum(['all', 'firing', 'pending', 'inactive']).default('all').describe('Filter alerts by state'),
  },
  async ({ filter }) => {
    try {
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/rules?type=alert`);
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

server.tool(
  'metrics_metadata',
  'Look up metric metadata — type, help text, and unit for a metric name.',
  {
    metric: z.string().describe('Metric name (e.g. http_requests_total)'),
  },
  async ({ metric }) => {
    try {
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/metadata?metric=${encodeURIComponent(metric)}`);
      return textResult({ metric, metadata: data.data?.[metric] || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'metrics_label_values',
  'Get all values for a given Prometheus label (e.g. list all jobs, instances, or status codes).',
  {
    label: z.string().describe('Label name (e.g. "job", "instance", "status_code")'),
  },
  async ({ label }) => {
    try {
      const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PATH_PREFIX}/api/v1/label/${encodeURIComponent(label)}/values`);
      return textResult({ label, values: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  LOGS (Loki)
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'logs_query',
  'Query logs from Loki using LogQL. Returns log lines matching the query.',
  {
    query: z.string().describe('LogQL query (e.g. {app="kx-exchange"} |= "error")'),
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

      const data = await fetchJSON(`${LOKI_URL}/loki/api/v1/query_range?${qs}`, 30_000);
      const streams = data.data?.result || [];
      const lines = streams.flatMap((s: any) =>
        (s.values || []).map(([ts, line]: [string, string]) => ({
          timestamp: new Date(Number(BigInt(ts) / BigInt(1_000_000))).toISOString(),
          labels: s.stream,
          line: tryParseJSON(line),
        })),
      );
      return textResult({ count: lines.length, logs: lines });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'logs_labels',
  'List all label names available in Loki.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${LOKI_URL}/loki/api/v1/labels`);
      return textResult({ labels: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'logs_label_values',
  'Get all values for a Loki label (e.g. all app names, namespaces).',
  {
    label: z.string().describe('Label name (e.g. "app", "namespace", "component")'),
  },
  async ({ label }) => {
    try {
      const data = await fetchJSON(`${LOKI_URL}/loki/api/v1/label/${encodeURIComponent(label)}/values`);
      return textResult({ label, values: data.data || [] });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'logs_tail_context',
  'Get recent logs around a specific trace ID to correlate logs with traces.',
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
      const data = await fetchJSON(`${LOKI_URL}/loki/api/v1/query_range?${qs}`, 30_000);
      const streams = data.data?.result || [];
      const lines = streams.flatMap((s: any) =>
        (s.values || []).map(([ts, line]: [string, string]) => ({
          timestamp: new Date(Number(BigInt(ts) / BigInt(1_000_000))).toISOString(),
          labels: s.stream,
          line: tryParseJSON(line),
        })),
      );
      return textResult({ traceId: trace_id, matchingLogs: lines.length, logs: lines });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  ZK PROOFS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'zk_proof_get',
  'Retrieve a ZK-SNARK proof for a specific trade. Proves trade executed within stated price range.',
  {
    trade_id: z.string().describe('Trade/order ID'),
  },
  async ({ trade_id }) => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/public/zk/proof/${encodeURIComponent(trade_id)}`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'zk_proof_verify',
  'Verify a ZK-SNARK proof server-side. Returns whether the Groth16 proof is mathematically valid.',
  {
    trade_id: z.string().describe('Trade/order ID to verify'),
  },
  async ({ trade_id }) => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/public/zk/verify/${encodeURIComponent(trade_id)}`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'zk_solvency',
  'Get the latest solvency proof — proves total reserves >= liabilities without revealing individual balances.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/public/zk/solvency`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'zk_stats',
  'Get aggregate ZK proof statistics — total proofs generated, verification success rate, average proving time, circuit breakdown.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/public/zk/stats`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  ANOMALY DETECTION & SYSTEM HEALTH
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'anomalies_active',
  'Get currently active anomalies detected by the trace-based and amount-based (whale) detectors.',
  {
    type: z.enum(['trace', 'amount', 'all']).default('all').describe('Anomaly type to retrieve'),
  },
  async ({ type }) => {
    try {
      const results: any = {};
      if (type === 'trace' || type === 'all') {
        results.traceAnomalies = await fetchJSON(`${KX_API_URL}/api/monitor/anomalies`);
      }
      if (type === 'amount' || type === 'all') {
        results.amountAnomalies = await fetchJSON(`${KX_API_URL}/api/monitor/amount-anomalies`);
      }
      return textResult(results);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'anomalies_baselines',
  'Get current span duration baselines used for anomaly detection (mean, stdDev, p50, p95, p99 per operation).',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/monitor/baselines/enriched`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'system_health',
  'Get full system health — service status, uptime, performance metrics, active alerts.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${KX_API_URL}/api/monitor/health`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'system_topology',
  'Get the live service dependency topology with health overlays.',
  {},
  async () => {
    try {
      const [deps, health] = await Promise.all([
        fetchJSON(`${JAEGER_URL}/api/dependencies?endTs=${Date.now()}&lookback=3600000`),
        fetchJSON(`${KX_API_URL}/api/monitor/health`).catch(() => null),
      ]);
      return textResult({ dependencies: deps.data || [], health });
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  RESOURCES — Pre-built prompts for common analysis tasks
// ═══════════════════════════════════════════════════════════════════════════

server.resource(
  'platform://krystalinex/overview',
  'KrystalineX platform overview — architecture, services, and telemetry capabilities',
  async () => ({
    contents: [{
      uri: 'platform://krystalinex/overview',
      mimeType: 'text/markdown',
      text: `# KrystalineX Platform Overview

## Services
- **kx-exchange** — Main Express API server (auth, orders, wallets, monitoring)
- **kx-matcher** — Payment processor / order matching engine (RabbitMQ consumer)
- **kx-gateway** — Kong API Gateway with OTEL tracing
- **kx-wallet** — Wallet service for balance management

## Telemetry Stack
- **Traces:** OpenTelemetry → OTEL Collector (tail sampling) → Jaeger
- **Metrics:** prom-client → Prometheus (SLO recording rules, predictive alerts, FinOps)
- **Logs:** Pino → Promtail → Loki (structured JSON, traceId correlation)
- **Proofs:** Groth16 ZK-SNARKs (trade integrity + solvency)

## Key Metrics
- \`http_requests_total{method, route, status_code}\` — Request counter
- \`http_request_duration_seconds{method, route}\` — Latency histogram with exemplars
- \`orders_processed_total{status, side}\` — Trade counter
- \`order_processing_duration\` — Trade latency histogram
- \`circuit_breaker_state{name}\` — Circuit breaker gauge
- \`anomalies_detected_total{service, severity}\` — Anomaly counter

## SLOs
- Availability: 99.9% (error budget: 43.2 min/month)
- Trade Latency P95: ≤ 500ms
- Price Freshness: ≤ 5s staleness

## Anomaly Detection
- Trace-based: Z-score > 6.6σ on span durations (Welford's algorithm, 168 hourly buckets)
- Amount-based: Z-score > 3.0σ on transaction amounts (whale detection)
- Bayesian: Hierarchical probabilistic model (PyMC) for latency/error anomaly with root cause ranking
- LLM RCA: Ollama-powered root cause analysis with Prometheus metric correlation
`,
    }],
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
//  BAYESIAN INFERENCE — Probabilistic anomaly detection
// ═══════════════════════════════════════════════════════════════════════════

const BAYESIAN_URL = process.env.BAYESIAN_SERVICE_URL || 'http://localhost:8100';

server.tool(
  'bayesian_health',
  'Check health of the Bayesian inference service.',
  {},
  async () => {
    try {
      const data = await fetchJSON(`${BAYESIAN_URL}/health`);
      return textResult(data);
    } catch (e: any) {
      return errorResult(`Bayesian service unreachable: ${e.message}`);
    }
  },
);

server.tool(
  'bayesian_insights',
  'Get probabilistic anomaly insights: anomaly probabilities, ranked root causes with confidence scores for each service.',
  {},
  async () => {
    try {
      const monitor = await fetchJSON(`${KX_API_URL}/api/monitor/bayesian/insights`);
      return textResult(monitor);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

server.tool(
  'bayesian_train',
  'Trigger Bayesian model retraining from current trace baselines.',
  {},
  async () => {
    try {
      const result = await fetchJSON(`${KX_API_URL}/api/monitor/bayesian/train`);
      return textResult(result);
    } catch (e: any) {
      return errorResult(e.message);
    }
  },
);

// ─── Utility ────────────────────────────────────────────────────────────────

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 3_600_000; // default 1h
  const [, val, unit] = match;
  const n = parseInt(val, 10);
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (multipliers[unit] || 3_600_000);
}

function tryParseJSON(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const httpIndex = args.indexOf('--http');

  if (httpIndex !== -1 && args[httpIndex + 1]) {
    // HTTP/SSE transport for remote access
    const port = parseInt(args[httpIndex + 1], 10);
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const http = await import('node:http');

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'krystalinex-otel-mcp', version: '1.0.0' }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServer.listen(port, () => {
      console.error(`KrystalineX OTEL MCP server listening on http://0.0.0.0:${port}`);
      console.error(`Health: http://localhost:${port}/health`);
    });
  } else {
    // Default: stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('KrystalineX OTEL MCP server running on stdio');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
