/**
 * Telemetry Context Enricher
 *
 * Trace-centric RCA context gatherer. Pass a traceId, get the full picture.
 *
 * The trace IS the process flow — from it we discover:
 *   - Every service and operation involved
 *   - The critical path and error spans
 *   - Correlated logs (Loki, by traceId + service errors)
 *   - Service topology + blast radius (Jaeger Dependencies)
 *   - System metrics at the time of the trace (Prometheus)
 *   - Firing alerts at that moment
 *   - SLO / error budget status
 *   - ZK proof health
 *
 * Used by analysis-service.ts for deep RCA.
 * Stream-analyzer stays lightweight — it doesn't use this.
 */

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import type { JaegerTrace } from './types.js';

const logger = createLogger('context-enricher');

const JAEGER_URL = config.observability.jaegerUrl;
const PROMETHEUS_URL = config.observability.prometheusUrl;
const PROM_PREFIX = process.env.PROMETHEUS_PATH_PREFIX || '';
const LOKI_URL = config.observability.lokiUrl;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpanSummary {
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  durationMs: number;
  pctOfTrace: number;
  startTimeUs: number;
  statusCode?: number;
  error?: boolean;
  tags: Record<string, unknown>;
}

export interface LogEntry {
  timestamp: string;
  level?: string;
  message: string;
  service?: string;
  traceId?: string;
}

export interface AlertSnapshot {
  name: string;
  state: string;
  severity: string;
  summary?: string;
}

export interface SLOSnapshot {
  availabilityBudgetRemaining: number | null;
  latencyBudgetRemaining: number | null;
  errorRate5m: number | null;
  p99Latency5m: number | null;
}

/** Optional anomaly metadata to attach when available */
export interface AnomalyHint {
  id?: string;
  deviation?: number;
  severity?: number;
  expectedMeanMs?: number;
  expectedStdDevMs?: number;
}

/** The full RCA context assembled from a single traceId */
export interface TraceContext {
  traceId: string;

  trace: {
    totalSpans: number;
    totalDurationMs: number;
    services: string[];
    rootService: string;
    rootOperation: string;
    startTime: string;
    spans: SpanSummary[];
    criticalPath: SpanSummary[];
    errorSpans: SpanSummary[];
  } | null;

  anomalyHint: AnomalyHint | null;

  metrics: {
    cpuPercent: number | null;
    memoryMB: number | null;
    requestRate: number | null;
    errorRate: number | null;
    p99LatencyMs: number | null;
    activeConnections: number | null;
    eventLoopLagMs: number | null;
    gcPauseMs: number | null;
    insights: string[];
  };

  logs: {
    count: number;
    errorLogs: LogEntry[];
    warnLogs: LogEntry[];
    contextLogs: LogEntry[];
  };

  topology: {
    upstreamServices: string[];
    downstreamServices: string[];
    blastRadius: string[];
  };

  alerts: {
    firing: AlertSnapshot[];
    pending: AlertSnapshot[];
  };

  slo: SLOSnapshot;

  zkHealth: {
    totalProofsGenerated: number;
    verificationSuccessRate: number;
    avgProvingTimeMs: number;
    solvencyAge: number;
  } | null;
}

// ─── HTTP Helper ────────────────────────────────────────────────────────────

async function fetchJSON(url: string, timeoutMs = 10_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function promInstant(query: string, time: number): Promise<number | null> {
  const url = `${PROMETHEUS_URL}${PROM_PREFIX}/api/v1/query?query=${encodeURIComponent(query)}&time=${time}`;
  const data = await fetchJSON(url);
  if (!data?.data?.result?.[0]?.value) return null;
  const val = parseFloat(data.data.result[0].value[1]);
  return isNaN(val) ? null : val;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Given a traceId, gather the complete RCA context.
 * Optionally pass anomaly metadata and/or an already-fetched trace.
 */
export async function enrichFromTrace(
  traceId: string,
  opts?: { hint?: AnomalyHint; existingTrace?: JaegerTrace },
): Promise<TraceContext> {
  const rawTrace = opts?.existingTrace ?? await fetchTrace(traceId);
  const trace = processTrace(rawTrace);

  // Derive time & root service from the trace itself
  const rootService = trace?.rootService ?? 'unknown';
  const traceStartUs = trace?.spans?.[trace.spans.length - 1]?.startTimeUs ?? Date.now() * 1000;
  const traceTime = new Date(traceStartUs / 1000);
  const tsEpoch = traceTime.getTime() / 1000;

  // Fire all enrichment queries in parallel
  const [logs, alerts, slo, topology, zk, metrics] = await Promise.all([
    gatherLogs(traceId, rootService, traceTime),
    gatherAlerts(),
    gatherSLO(tsEpoch),
    gatherTopology(rootService),
    gatherZKHealth(),
    gatherMetrics(tsEpoch),
  ]);

  logger.info({
    traceId,
    spans: trace?.totalSpans ?? 0,
    services: trace?.services?.length ?? 0,
    logs: logs.count,
    firingAlerts: alerts.firing.length,
    blastRadius: topology.blastRadius.length,
  }, 'RCA context enriched');

  return {
    traceId,
    trace,
    anomalyHint: opts?.hint ?? null,
    metrics,
    logs,
    topology,
    alerts,
    slo,
    zkHealth: zk,
  };
}

// ─── Trace ──────────────────────────────────────────────────────────────────

async function fetchTrace(traceId: string): Promise<JaegerTrace | null> {
  const data = await fetchJSON(`${JAEGER_URL}/api/traces/${traceId}`);
  return data?.data?.[0] ?? null;
}

function processTrace(raw: JaegerTrace | null): TraceContext['trace'] {
  if (!raw || !raw.spans?.length) return null;

  const rootSpan = raw.spans.reduce((r, s) =>
    s.duration > r.duration ? s : r, raw.spans[0]);
  const totalDuration = rootSpan.duration || 1;

  const spans: SpanSummary[] = raw.spans
    .map(s => {
      const tags = Object.fromEntries((s.tags || []).map(t => [t.key, t.value]));
      return {
        spanId: s.spanID,
        parentSpanId: s.references?.[0]?.spanID || null,
        service: raw.processes[s.processID]?.serviceName || 'unknown',
        operation: s.operationName,
        durationMs: s.duration / 1000,
        pctOfTrace: Math.round((s.duration / totalDuration) * 1000) / 10,
        startTimeUs: s.startTime,
        statusCode: tags['http.status_code'] as number | undefined,
        error: tags['error'] === true || tags['otel.status_code'] === 'ERROR',
        tags,
      };
    })
    .sort((a, b) => b.durationMs - a.durationMs);

  const services = Array.from(new Set(spans.map(s => s.service)));
  const rootService = raw.processes[rootSpan.processID]?.serviceName || services[0] || 'unknown';

  return {
    totalSpans: spans.length,
    totalDurationMs: totalDuration / 1000,
    services,
    rootService,
    rootOperation: rootSpan.operationName,
    startTime: new Date(rootSpan.startTime / 1000).toISOString(),
    spans,
    criticalPath: spans.filter(s => s.pctOfTrace >= 10),
    errorSpans: spans.filter(s => s.error),
  };
}

// ─── Logs ───────────────────────────────────────────────────────────────────

async function gatherLogs(
  traceId: string,
  service: string,
  timestamp: Date,
): Promise<TraceContext['logs']> {
  const windowNs = 5 * 60 * 1_000_000_000; // ±5 min
  const tsNs = timestamp.getTime() * 1_000_000;
  const start = tsNs - windowNs;
  const end = tsNs + windowNs;

  const [byTrace, byErrors] = await Promise.all([
    fetchJSON(
      `${LOKI_URL}/loki/api/v1/query_range?` +
      `query=${encodeURIComponent(`{app=~".+"} |~ "${traceId}"`)}&` +
      `start=${start}&end=${end}&limit=50&direction=backward`,
      15_000,
    ),
    fetchJSON(
      `${LOKI_URL}/loki/api/v1/query_range?` +
      `query=${encodeURIComponent(`{app="${service}"} |~ "error|Error|ERROR|panic|fatal"`)}&` +
      `start=${start}&end=${end}&limit=30&direction=backward`,
      15_000,
    ),
  ]);

  const lines: any[] = [];
  for (const data of [byTrace, byErrors]) {
    if (!data?.data?.result) continue;
    for (const stream of data.data.result) {
      for (const [ts, line] of stream.values || []) {
        lines.push({ ts, line, labels: stream.stream });
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = lines.filter(l => {
    const key = `${l.ts}:${l.line.substring(0, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const entries: LogEntry[] = unique.map(l => {
    let parsed: any = {};
    try { parsed = JSON.parse(l.line); } catch { parsed = { msg: l.line }; }
    return {
      timestamp: new Date(Number(l.ts) / 1_000_000).toISOString(),
      level: parsed.level || parsed.severity || undefined,
      message: parsed.msg || parsed.message || l.line,
      service: l.labels?.app || l.labels?.component || undefined,
      traceId: parsed.traceId || parsed.trace_id || undefined,
    };
  });

  return {
    count: entries.length,
    errorLogs: entries.filter(e => e.level && /error|fatal|panic/i.test(e.level)).slice(0, 20),
    warnLogs: entries.filter(e => e.level && /warn/i.test(e.level)).slice(0, 10),
    contextLogs: entries.slice(0, 30),
  };
}

// ─── Alerts ─────────────────────────────────────────────────────────────────

async function gatherAlerts(): Promise<TraceContext['alerts']> {
  const data = await fetchJSON(`${PROMETHEUS_URL}${PROM_PREFIX}/api/v1/rules?type=alert`);
  const firing: AlertSnapshot[] = [];
  const pending: AlertSnapshot[] = [];

  if (!data?.data?.groups) return { firing, pending };

  for (const group of data.data.groups) {
    for (const rule of group.rules || []) {
      if (rule.state === 'firing' || rule.state === 'pending') {
        const snap: AlertSnapshot = {
          name: rule.name,
          state: rule.state,
          severity: rule.labels?.severity || 'unknown',
          summary: rule.annotations?.summary,
        };
        (rule.state === 'firing' ? firing : pending).push(snap);
      }
    }
  }

  return { firing, pending };
}

// ─── SLO ────────────────────────────────────────────────────────────────────

async function gatherSLO(tsEpoch: number): Promise<SLOSnapshot> {
  const [avail, latency, errRate, p99] = await Promise.all([
    promInstant('slo:availability:error_budget_remaining', tsEpoch),
    promInstant('slo:latency:error_budget_remaining', tsEpoch),
    promInstant('slo:http_requests:error_ratio_5m', tsEpoch),
    promInstant('slo:http_request_duration:p99_5m', tsEpoch),
  ]);

  return {
    availabilityBudgetRemaining: avail,
    latencyBudgetRemaining: latency,
    errorRate5m: errRate,
    p99Latency5m: p99 !== null ? p99 * 1000 : null,
  };
}

// ─── Topology ───────────────────────────────────────────────────────────────

async function gatherTopology(service: string): Promise<TraceContext['topology']> {
  const data = await fetchJSON(`${JAEGER_URL}/api/dependencies?endTs=${Date.now()}&lookback=3600000`);
  const deps: Array<{ parent: string; child: string }> = data?.data || [];

  const upstream = deps.filter(d => d.child === service).map(d => d.parent);
  const downstream = deps.filter(d => d.parent === service).map(d => d.child);

  // BFS blast radius
  const visited = new Set<string>();
  const queue = [...downstream];
  const blastRadius: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    blastRadius.push(node);
    for (const dep of deps) {
      if (dep.parent === node && !visited.has(dep.child)) queue.push(dep.child);
    }
  }

  return { upstreamServices: upstream, downstreamServices: downstream, blastRadius };
}

// ─── ZK Health ──────────────────────────────────────────────────────────────

async function gatherZKHealth(): Promise<TraceContext['zkHealth']> {
  const kxUrl = process.env.KX_API_URL || `http://localhost:${config.server.port}`;
  const data = await fetchJSON(`${kxUrl}/api/public/zk/stats`);
  if (!data) return null;
  return {
    totalProofsGenerated: data.totalProofsGenerated || 0,
    verificationSuccessRate: data.verificationSuccessRate || 0,
    avgProvingTimeMs: data.avgProvingTimeMs || 0,
    solvencyAge: data.solvencyProofAge ?? -1,
  };
}

// ─── Metrics ────────────────────────────────────────────────────────────────

async function gatherMetrics(tsEpoch: number): Promise<TraceContext['metrics']> {
  const [cpu, mem, reqRate, errRate, p99, conns, gcPause, evtLag] = await Promise.all([
    promInstant('rate(process_cpu_seconds_total[1m])', tsEpoch),
    promInstant('process_resident_memory_bytes', tsEpoch),
    promInstant('sum(rate(http_requests_total[1m]))', tsEpoch),
    promInstant('sum(rate(http_request_errors_total[5m])) / sum(rate(http_requests_total[5m])) * 100', tsEpoch),
    promInstant('histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))', tsEpoch),
    promInstant('http_active_connections', tsEpoch),
    promInstant('rate(nodejs_gc_duration_seconds_sum[1m]) * 1000', tsEpoch),
    promInstant('nodejs_eventloop_lag_p99_seconds * 1000', tsEpoch),
  ]);

  const cpuPct = cpu !== null ? cpu * 100 : null;
  const memMB = mem !== null ? mem / (1024 * 1024) : null;
  const errorRate = errRate !== null && !isNaN(errRate) ? errRate : null;
  const p99Ms = p99 !== null ? p99 * 1000 : null;

  const insights: string[] = [];
  if (cpuPct !== null && cpuPct >= 90) insights.push('🔥 Critical CPU (≥90%)');
  else if (cpuPct !== null && cpuPct >= 70) insights.push('⚠️ High CPU (≥70%)');
  if (memMB !== null && memMB >= 1024) insights.push('🔥 High memory (≥1GB)');
  if (errorRate !== null && errorRate >= 5) insights.push(`⚠️ Error rate ${errorRate.toFixed(1)}%`);
  if (conns !== null && conns >= 100) insights.push(`⚠️ ${conns} active connections`);
  if (evtLag !== null && evtLag >= 100) insights.push(`⚠️ Event loop lag ${evtLag.toFixed(0)}ms`);
  if (gcPause !== null && gcPause >= 50) insights.push(`⚠️ GC pause ${gcPause.toFixed(0)}ms`);

  return {
    cpuPercent: cpuPct,
    memoryMB: memMB,
    requestRate: reqRate,
    errorRate,
    p99LatencyMs: p99Ms,
    activeConnections: conns,
    eventLoopLagMs: evtLag,
    gcPauseMs: gcPause,
    insights,
  };
}

// ─── Prompt Builder ─────────────────────────────────────────────────────────

/**
 * Build a rich LLM prompt from trace context.
 * Replaces the limited 10-span / 6-metric prompt.
 */
export function buildRCAPrompt(ctx: TraceContext): string {
  const s: string[] = [];

  s.push(`You are an expert SRE analyzing a trace from KrystalineX, an institutional crypto exchange.`);

  // Anomaly hint (if available from the detector)
  if (ctx.anomalyHint) {
    const h = ctx.anomalyHint;
    const parts = [`Deviation: ${h.deviation?.toFixed(1) ?? '?'}σ`];
    if (h.severity) parts.push(`SEV${h.severity}`);
    if (h.expectedMeanMs) parts.push(`expected ${h.expectedMeanMs.toFixed(0)}ms`);
    s.push(`## Anomaly Detection\n${parts.join(' · ')}`);
  }

  // Trace breakdown
  if (ctx.trace) {
    const t = ctx.trace;
    s.push(`## Trace ${ctx.traceId}\n- Root: ${t.rootService}:${t.rootOperation}\n- Duration: ${t.totalDurationMs.toFixed(1)}ms · ${t.totalSpans} spans · ${t.services.length} services (${t.services.join(', ')})\n- Start: ${t.startTime}`);

    if (t.criticalPath.length) {
      s.push(`### Critical Path (>10% of trace)\n${t.criticalPath.map(sp =>
        `- ${sp.service}:${sp.operation} ${sp.durationMs.toFixed(1)}ms (${sp.pctOfTrace}%)${sp.error ? ' ❌ ERROR' : ''}`
      ).join('\n')}`);
    }

    if (t.errorSpans.length) {
      s.push(`### Error Spans\n${t.errorSpans.map(sp =>
        `- ${sp.service}:${sp.operation} — ${sp.tags['otel.status_description'] || sp.tags['error.message'] || 'error'}`
      ).join('\n')}`);
    }

    s.push(`### All Spans (by duration)\n${t.spans.slice(0, 30).map(sp =>
      `- ${sp.service}:${sp.operation} ${sp.durationMs.toFixed(1)}ms (${sp.pctOfTrace}%)${sp.error ? ' ❌' : ''}`
    ).join('\n')}${t.spans.length > 30 ? `\n... +${t.spans.length - 30} more` : ''}`);
  }

  // Metrics
  const m = ctx.metrics;
  s.push(`## System Metrics\n- CPU: ${fmt(m.cpuPercent, '%')}\n- Memory: ${fmt(m.memoryMB, 'MB', 0)}\n- Request Rate: ${fmt(m.requestRate, ' req/s')}\n- Error Rate: ${fmt(m.errorRate, '%')}\n- P99 Latency: ${fmt(m.p99LatencyMs, 'ms', 0)}\n- Connections: ${m.activeConnections ?? 'N/A'}\n- Event Loop Lag: ${fmt(m.eventLoopLagMs, 'ms', 0)}\n- GC Pause: ${fmt(m.gcPauseMs, 'ms', 0)}`);

  if (m.insights.length) {
    s.push(`### Auto-Detected Issues\n${m.insights.map(i => `- ${i}`).join('\n')}`);
  }

  // Logs
  if (ctx.logs.count > 0) {
    s.push(`## Correlated Logs (${ctx.logs.count} entries)`);
    if (ctx.logs.errorLogs.length) {
      s.push(`### Errors\n${ctx.logs.errorLogs.slice(0, 10).map(l => `- [${l.timestamp}] ${l.service || ''}: ${l.message}`).join('\n')}`);
    }
    if (ctx.logs.warnLogs.length) {
      s.push(`### Warnings\n${ctx.logs.warnLogs.slice(0, 5).map(l => `- [${l.timestamp}] ${l.service || ''}: ${l.message}`).join('\n')}`);
    }
  }

  // Topology
  const tp = ctx.topology;
  if (tp.upstreamServices.length || tp.downstreamServices.length) {
    s.push(`## Service Topology\n- Upstream: ${tp.upstreamServices.join(', ') || 'none'}\n- Downstream: ${tp.downstreamServices.join(', ') || 'none'}\n- Blast radius: ${tp.blastRadius.join(', ') || 'none'}`);
  }

  // Alerts
  if (ctx.alerts.firing.length || ctx.alerts.pending.length) {
    s.push(`## Active Alerts`);
    if (ctx.alerts.firing.length) s.push(`### Firing\n${ctx.alerts.firing.map(a => `- [${a.severity}] ${a.name}: ${a.summary || ''}`).join('\n')}`);
    if (ctx.alerts.pending.length) s.push(`### Pending\n${ctx.alerts.pending.map(a => `- [${a.severity}] ${a.name}`).join('\n')}`);
  }

  // SLO
  const slo = ctx.slo;
  if (slo.availabilityBudgetRemaining !== null || slo.latencyBudgetRemaining !== null) {
    s.push(`## SLO Status\n- Availability Budget: ${slo.availabilityBudgetRemaining !== null ? `${(slo.availabilityBudgetRemaining * 100).toFixed(1)}% remaining` : 'N/A'}\n- Latency Budget: ${slo.latencyBudgetRemaining !== null ? `${(slo.latencyBudgetRemaining * 100).toFixed(1)}% remaining` : 'N/A'}\n- Error Rate (5m): ${slo.errorRate5m !== null ? `${(slo.errorRate5m * 100).toFixed(2)}%` : 'N/A'}\n- P99 (5m): ${slo.p99Latency5m !== null ? `${slo.p99Latency5m.toFixed(0)}ms` : 'N/A'}`);
  }

  // ZK
  if (ctx.zkHealth) {
    s.push(`## ZK Proof Health\n- Proofs: ${ctx.zkHealth.totalProofsGenerated}\n- Verification: ${ctx.zkHealth.verificationSuccessRate}%\n- Proving time: ${ctx.zkHealth.avgProvingTimeMs.toFixed(0)}ms\n- Solvency age: ${ctx.zkHealth.solvencyAge >= 0 ? `${ctx.zkHealth.solvencyAge}s` : 'N/A'}`);
  }

  // Instructions
  s.push(`## Analysis Required
Based on ALL the above (trace spans, metrics, logs, topology, alerts, SLO):

1. **Root cause** — cite specific spans, log entries, or metrics as evidence
2. **Contributing factors** — secondary issues amplifying the problem
3. **Blast radius** — affected downstream services and SLOs
4. **Recommendations** — 2-3 actionable steps, ordered by impact

Format:
SUMMARY: [1-2 sentences]
ROOT_CAUSE: [specific cause with evidence]
CONTRIBUTING_FACTORS:
- [factor 1]
- [factor 2]
BLAST_RADIUS: [affected services/SLOs]
RECOMMENDATIONS:
- [action 1]
- [action 2]
- [action 3]
CONFIDENCE: [low/medium/high]`);

  return s.join('\n\n');
}

function fmt(v: number | null, suffix: string, decimals = 1): string {
  if (v === null) return 'N/A';
  return `${v.toFixed(decimals)}${suffix}`;
}
