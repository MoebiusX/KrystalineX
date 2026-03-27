#!/usr/bin/env node
/**
 * otel-mcp-client — CLI companion for otel-mcp-server
 *
 * Usage:
 *   otel-mcp-client report [--range 1h]       Full cluster health report
 *   otel-mcp-client health                     Quick health check
 *   otel-mcp-client targets                    Prometheus targets status
 *   otel-mcp-client traces [--service X]       Recent traces
 *   otel-mcp-client query <tool> [json-args]   Call any MCP tool directly
 *   otel-mcp-client tools                      List available tools
 *
 * Environment:
 *   MCP_URL      Server URL  (default: http://localhost:3001/mcp)
 *   MCP_API_KEY  API key     (default: none)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'fs';

// ── Output capture (for --output flag) ──────────────────

let outputBuffer: string[] | null = null;

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

/** Emoji → plain-text map for clean file output */
const EMOJI_MAP: Record<string, string> = {
  '✅': '[OK]', '❌': '[FAIL]', '🟢': '[UP]', '🔴': '[DOWN]',
  '🟡': '[WARN]', '🔥': '[FIRE]', '⚠': '[!]', '⚠️': '[!]',
  '📊': '[REPORT]', '🏥': '[HEALTH]', '🎯': '[TARGET]',
  '📡': '[TOPO]', '📈': '[METRIC]', '🔍': '[TRACE]',
  '🚨': '[ALERT]', '💡': '[INFO]', '🛠': '[TOOL]', '🛠️': '[TOOL]',
  '📋': '[LIST]', '█': '#',
};

function stripEmoji(text: string): string {
  let s = text;
  for (const [emoji, plain] of Object.entries(EMOJI_MAP)) {
    s = s.split(emoji).join(plain);
  }
  return s;
}

function enableOutputCapture(): void {
  outputBuffer = [];
  console.log = (...args: unknown[]) => {
    const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
    outputBuffer!.push(line);
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
    outputBuffer!.push(line);
    originalError(...args);
  };
}

function flushToFile(filePath: string): void {
  if (!outputBuffer) return;
  const content = stripEmoji(outputBuffer.join('\n')) + '\n';
  writeFileSync(filePath, content, 'utf-8');
  // Restore original console so the confirmation message is clean
  console.log = originalLog;
  console.error = originalError;
  console.log(`\nReport saved to: ${filePath}`);
}

// ── Helpers ──────────────────────────────────────────────

const SEP = '═'.repeat(60);

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/** Parse --flag value pairs from argv */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

/** Convert a duration like "15m", "1h", "1d" into seconds for Prometheus range queries */
function rangeToSeconds(range: string): number {
  const m = range.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 3600;
  }
}

/** Choose a reasonable step for a given range */
function rangeToStep(range: string): string {
  const secs = rangeToSeconds(range);
  if (secs <= 900) return '15s';      // ≤15m → 15s steps
  if (secs <= 3600) return '60s';     // ≤1h  → 1m steps
  if (secs <= 21600) return '5m';     // ≤6h  → 5m steps
  if (secs <= 86400) return '15m';    // ≤1d  → 15m steps
  return '1h';                         // >1d  → 1h steps
}

function heading(title: string): void {
  console.log(`\n${SEP}`);
  console.log(` ${title}`);
  console.log(SEP);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(val: string | number): string {
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return 'N/A';
  return `${n.toFixed(2)}%`;
}

// ── MCP Client ───────────────────────────────────────────

class McpCli {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private url: string;
  private apiKey: string | undefined;

  constructor(url: string, apiKey?: string) {
    this.url = url;
    this.apiKey = apiKey;

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    this.client = new Client({ name: 'otel-mcp-client', version: '1.0.0' });
    this.transport = new StreamableHTTPClientTransport(
      new URL(url),
      { requestInit: { headers } }
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.content && Array.isArray(result.content)) {
      for (const c of result.content) {
        if ((c as { type: string }).type === 'text') {
          const text = (c as { text: string }).text;
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        }
      }
    }
    return result;
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map(t => t.name);
  }

  async listToolsDetailed(): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.client.listTools();
    return result.tools.map(t => ({ name: t.name, description: t.description }));
  }
}

// ── Commands ─────────────────────────────────────────────

async function cmdTools(cli: McpCli): Promise<void> {
  const tools = await cli.listToolsDetailed();
  heading('Available Tools');
  const maxLen = Math.max(...tools.map(t => t.name.length));
  for (const t of tools) {
    console.log(`  ${t.name.padEnd(maxLen + 2)}${t.description ?? ''}`);
  }
}

async function cmdHealth(cli: McpCli): Promise<void> {
  heading('System Health');
  const raw = await cli.callTool('system_health');

  // Handle error responses
  if (typeof raw === 'string') {
    console.log(`  ${raw}`);
    return;
  }

  const health = raw as {
    status?: string;
    services?: Array<{ name: string; status: string; avgDuration: number; spanCount: number; activeAnomalies: number; lastSeen: string }>;
    lastPolled?: string;
  };

  const status = health.status ?? 'unknown';
  const icon = status === 'healthy' ? '✅' : '❌';
  console.log(`  Status: ${icon} ${status.toUpperCase()}`);
  if (health.lastPolled) console.log(`  Polled: ${health.lastPolled}`);
  console.log();

  if (health.services?.length) {
    const maxName = Math.max(...health.services.map(s => s.name.length));
    for (const svc of health.services) {
      const sIcon = svc.status === 'healthy' ? '✅' : '❌';
      console.log(`  ${sIcon} ${svc.name.padEnd(maxName + 2)} avg ${formatDuration(svc.avgDuration).padStart(8)}  spans: ${svc.spanCount}  anomalies: ${svc.activeAnomalies}`);
    }
  }
}

async function cmdTargets(cli: McpCli): Promise<void> {
  heading('Prometheus Targets');
  const raw = await cli.callTool('metrics_targets');

  if (typeof raw === 'string') {
    console.log(`  ${raw}`);
    return;
  }

  const data = raw as {
    activeTargets?: number;
    targets?: Array<{ job: string; instance: string; health: string; lastScrape: string; lastError: string | null }>;
  };

  const targets = data.targets ?? [];
  const up = targets.filter(t => t.health === 'up').length;
  const down = targets.filter(t => t.health !== 'up').length;
  console.log(`  Total: ${data.activeTargets ?? targets.length}  |  🟢 Up: ${up}  |  🔴 Down: ${down}`);
  console.log();

  if (targets.length) {
    const maxJob = Math.max(...targets.map(t => t.job.length));
    const maxInst = Math.max(...targets.map(t => t.instance.length));
    for (const t of targets) {
      const icon = t.health === 'up' ? '🟢' : '🔴';
      const err = t.lastError ? `  ⚠ ${t.lastError}` : '';
      console.log(`  ${icon} ${t.job.padEnd(maxJob + 2)}${t.instance.padEnd(maxInst + 2)}${err}`);
    }
  }
}

async function cmdTraces(cli: McpCli, flags: Record<string, string>): Promise<void> {
  const service = flags['service'] || 'kx-exchange';
  const range = flags['range'] || '1h';
  const limit = parseInt(flags['limit'] || '20', 10);

  heading(`Recent Traces — ${service} (${range})`);
  const raw = await cli.callTool('traces_search', { service, lookback: range, limit });

  if (typeof raw === 'string') {
    console.log(`  ${raw}`);
    return;
  }

  const data = raw as { count?: number; traces?: Array<{ traceId: string; rootOperation: string; spanCount: number; duration_ms: number; services: string[]; startTime: string; hasErrors: boolean }> };

  console.log(`  Found: ${data.count ?? data.traces?.length ?? 0} traces`);
  console.log();

  if (data.traces) {
    for (const t of data.traces) {
      const icon = t.hasErrors ? '❌' : '✅';
      console.log(`  ${icon} ${t.traceId.substring(0, 16)}…  ${formatDuration(t.duration_ms).padStart(8)}  ${t.rootOperation}  [${t.services.join(', ')}]`);
    }
  }
}

async function cmdReport(cli: McpCli, flags: Record<string, string>): Promise<void> {
  const range = flags['range'] || '1h';
  const rangeWindow = range;  // for PromQL rate() window
  const secs = rangeToSeconds(range);
  const step = rangeToStep(range);
  const now = Math.floor(Date.now() / 1000);
  const start = (now - secs).toString();
  const end = now.toString();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(` 📊 Cluster Report — last ${range}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Generated: ${new Date().toISOString()}`);

  // ── Health ──
  await cmdHealth(cli);

  // ── Targets ──
  await cmdTargets(cli);

  // ── Topology ──
  heading('Service Topology');
  const topo = await cli.callTool('system_topology') as {
    dependencies: Array<{ parent: string; child: string; callCount: number }>;
  };
  if (topo.dependencies) {
    for (const d of topo.dependencies) {
      console.log(`  ${d.parent} → ${d.child}  (${d.callCount} calls)`);
    }
  }

  // ── Key Metrics (instant) ──
  heading(`Key Metrics (${range} window)`);

  const [reqRate, errRate, p50, p95, p99] = await Promise.all([
    cli.callTool('metrics_query', { query: `sum(rate(http_requests_total[${rangeWindow}]))` }),
    cli.callTool('metrics_query', { query: `sum(rate(http_requests_total{status=~"5.."}[${rangeWindow}])) / sum(rate(http_requests_total[${rangeWindow}])) * 100` }),
    cli.callTool('metrics_query', { query: `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[${rangeWindow}])) by (le))` }),
    cli.callTool('metrics_query', { query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[${rangeWindow}])) by (le))` }),
    cli.callTool('metrics_query', { query: `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[${rangeWindow}])) by (le))` }),
  ]) as Array<{ status: string; result: Array<{ value: [number, string] }> }>;

  const val = (r: { status: string; result: Array<{ value: [number, string] }> }) =>
    r?.result?.[0]?.value?.[1] ?? 'N/A';

  const rateVal = parseFloat(val(reqRate));
  const errVal = val(errRate);
  const p50Val = parseFloat(val(p50));
  const p95Val = parseFloat(val(p95));
  const p99Val = parseFloat(val(p99));

  console.log(`  Request rate:  ${isNaN(rateVal) ? 'N/A' : `${rateVal.toFixed(1)} req/s`}`);
  console.log(`  Error rate:    ${errVal === 'N/A' || errVal === 'NaN' ? '0.00%' : formatPercent(errVal)}`);
  console.log(`  Latency P50:   ${isNaN(p50Val) ? 'N/A' : formatDuration(p50Val * 1000)}`);
  console.log(`  Latency P95:   ${isNaN(p95Val) ? 'N/A' : formatDuration(p95Val * 1000)}`);
  console.log(`  Latency P99:   ${isNaN(p99Val) ? 'N/A' : formatDuration(p99Val * 1000)}`);

  // ── Anomalies ──
  heading('Active Anomalies');
  const anomalies = await cli.callTool('anomalies_active') as {
    traceAnomalies: { active: unknown[]; recentCount: number };
    amountAnomalies: { active: unknown[]; recentCount: number };
  };
  const traceCount = anomalies?.traceAnomalies?.active?.length ?? 0;
  const amountCount = anomalies?.amountAnomalies?.active?.length ?? 0;
  if (traceCount === 0 && amountCount === 0) {
    console.log('  ✅ No active anomalies');
  } else {
    console.log(`  ⚠ Trace anomalies: ${traceCount}  |  Amount anomalies: ${amountCount}`);
    if (traceCount > 0) {
      console.log(JSON.stringify(anomalies.traceAnomalies.active, null, 2));
    }
  }

  // ── Alerts (Prometheus rules) ──
  heading('Prometheus Alerts');
  try {
    const alerts = await cli.callTool('metrics_alerts', { filter: 'firing' }) as {
      groups: Array<{ name: string; rules: Array<{ name: string; state: string; severity: string }> }>;
    };
    let firingCount = 0;
    if (alerts?.groups) {
      for (const g of alerts.groups) {
        for (const r of g.rules) {
          if (r.state === 'firing') {
            firingCount++;
            console.log(`  🔥 [${r.severity}] ${r.name}`);
          }
        }
      }
    }
    if (firingCount === 0) {
      console.log('  ✅ No firing alerts');
    }
  } catch {
    console.log('  ⚠ Could not query alerts');
  }

  // ── Error Traces ──
  heading(`Error Traces (${range})`);
  try {
    const traces = await cli.callTool('traces_search', {
      service: 'kx-exchange',
      lookback: range,
      limit: 5,
      tags: '{"error":"true"}',
    }) as { count: number; traces: Array<{ traceId: string; rootOperation: string; duration_ms: number; services: string[] }> };
    if (traces.count === 0) {
      console.log('  ✅ No error traces');
    } else {
      console.log(`  Found ${traces.count} error traces (showing up to 5):`);
      for (const t of traces.traces ?? []) {
        console.log(`  ❌ ${t.traceId.substring(0, 16)}…  ${formatDuration(t.duration_ms).padStart(8)}  ${t.rootOperation}`);
      }
    }
  } catch {
    console.log('  ⚠ Could not query error traces');
  }

  // ── Request Rate Trend ──
  heading(`Request Rate Trend (${range}, ${step} steps)`);
  try {
    const trend = await cli.callTool('metrics_query_range', {
      query: `sum(rate(http_requests_total[${step}]))`,
      start, end, step,
    }) as { result: Array<{ values: Array<[number, string]> }> };

    if (trend?.result?.[0]?.values) {
      const values = trend.result[0].values;
      const nums = values.map(v => parseFloat(v[1])).filter(n => !isNaN(n));
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;

      console.log(`  Min: ${min.toFixed(1)} req/s  |  Avg: ${avg.toFixed(1)} req/s  |  Max: ${max.toFixed(1)} req/s`);
      console.log();

      // Simple sparkline
      const barWidth = 50;
      for (const [ts, val] of values.slice(-12)) {
        const n = parseFloat(val);
        const pct = max > 0 ? n / max : 0;
        const bar = '█'.repeat(Math.round(pct * barWidth));
        const time = new Date(ts * 1000).toISOString().substring(11, 16);
        console.log(`  ${time} ${bar} ${n.toFixed(1)}`);
      }
    }
  } catch {
    console.log('  ⚠ Could not query trend data');
  }

  // ── Latency Trend ──
  heading(`P95 Latency Trend (${range}, ${step} steps)`);
  try {
    const trend = await cli.callTool('metrics_query_range', {
      query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[${step}])) by (le))`,
      start, end, step,
    }) as { result: Array<{ values: Array<[number, string]> }> };

    if (trend?.result?.[0]?.values) {
      const values = trend.result[0].values;
      const nums = values.map(v => parseFloat(v[1]) * 1000).filter(n => !isNaN(n));
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;

      console.log(`  Min: ${formatDuration(min)}  |  Avg: ${formatDuration(avg)}  |  Max: ${formatDuration(max)}`);
      console.log();

      const barWidth = 50;
      for (const [ts, val] of values.slice(-12)) {
        const n = parseFloat(val) * 1000;
        const pct = max > 0 ? n / max : 0;
        const bar = '█'.repeat(Math.round(pct * barWidth));
        const time = new Date(ts * 1000).toISOString().substring(11, 16);
        console.log(`  ${time} ${bar} ${formatDuration(n)}`);
      }
    }
  } catch {
    console.log('  ⚠ Could not query latency trend');
  }

  console.log(`\n${SEP}`);
  console.log(` Report complete`);
  console.log(SEP);
}

async function cmdQuery(cli: McpCli, toolName: string, argsJson: string): Promise<void> {
  let args: Record<string, unknown> = {};
  if (argsJson) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      console.error(`Error: Invalid JSON arguments: ${argsJson}`);
      process.exit(1);
    }
  }

  const result = await cli.callTool(toolName, args);
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { positional, flags } = parseFlags(args);
  const command = positional[0] ?? 'help';

  const url = flags['url'] || env('MCP_URL', 'http://localhost:3001/mcp');
  const apiKey = flags['key'] || env('MCP_API_KEY', '');
  const outputFile = flags['output'];

  if (outputFile) enableOutputCapture();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
otel-mcp-client — CLI companion for otel-mcp-server

Usage:
  otel-mcp-client report  [--range 1h]           Full cluster health report
  otel-mcp-client health                          Quick health check
  otel-mcp-client targets                         Prometheus targets status
  otel-mcp-client traces  [--service X] [--range 1h] [--limit 20]  Recent traces
  otel-mcp-client query   <tool> [json-args]      Call any MCP tool directly
  otel-mcp-client tools                           List available tools

Options:
  --url <url>     MCP server URL  (env: MCP_URL, default: http://localhost:3001/mcp)
  --key <key>     API key         (env: MCP_API_KEY)
  --range <dur>   Time range: 15m, 1h, 6h, 1d, 7d  (default: 1h)
  --output <file> Save output to file (clean plain-text, no emoji)

Examples:
  otel-mcp-client report --range 1d
  otel-mcp-client report --range 1d --output cluster-report.txt
  otel-mcp-client targets --url http://mcp.internal:3001/mcp
  otel-mcp-client query metrics_query '{"query":"up"}'
  MCP_API_KEY=sk-xxx otel-mcp-client health
`);
    return;
  }

  const cli = new McpCli(url, apiKey || undefined);

  try {
    await cli.connect();

    switch (command) {
      case 'report':
        await cmdReport(cli, flags);
        break;
      case 'health':
        await cmdHealth(cli);
        break;
      case 'targets':
        await cmdTargets(cli);
        break;
      case 'traces':
        await cmdTraces(cli, flags);
        break;
      case 'tools':
        await cmdTools(cli);
        break;
      case 'query': {
        const toolName = positional[1];
        if (!toolName) {
          console.error('Error: Missing tool name. Usage: otel-mcp-client query <tool> [json-args]');
          process.exit(1);
        }
        await cmdQuery(cli, toolName, positional[2] ?? '');
        break;
      }
      default:
        console.error(`Unknown command: ${command}. Run with --help for usage.`);
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  } finally {
    await cli.close();
    if (outputFile) flushToFile(outputFile);
  }
}

main();
