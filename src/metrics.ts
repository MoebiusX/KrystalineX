/**
 * Self-metrics — lightweight Prometheus-format metrics for the MCP server itself.
 *
 * No external dependencies — implements a minimal counter/histogram/gauge
 * registry that serializes to Prometheus text exposition format.
 *
 * Exposed via GET /metrics on the HTTP transport.
 */

// ═══════════════════════════════════════════════════════════════════════════
//  Metric types
// ═══════════════════════════════════════════════════════════════════════════

type Labels = Record<string, string>;

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

function labelsStr(labels: Labels): string {
  const key = labelsKey(labels);
  return key ? `{${key}}` : '';
}

class Counter {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, value = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  serialize(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      const lbl = key ? `{${key}}` : '';
      lines.push(`${this.name}${lbl} ${val}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels, value: number): void {
    this.values.set(labelsKey(labels), value);
  }

  inc(labels: Labels = {}, value = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  dec(labels: Labels = {}, value = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) - value);
  }

  serialize(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.values) {
      const lbl = key ? `{${key}}` : '';
      lines.push(`${this.name}${lbl} ${val}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly bucketBounds: number[];
  private data = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.bucketBounds = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = labelsKey(labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = { buckets: new Array(this.bucketBounds.length).fill(0), sum: 0, count: 0 };
      this.data.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.bucketBounds.length; i++) {
      if (value <= this.bucketBounds[i]!) entry.buckets[i]!++;
    }
  }

  serialize(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.data) {
      const base = key ? `{${key},` : '{';
      let cumulative = 0;
      for (let i = 0; i < this.bucketBounds.length; i++) {
        cumulative += entry.buckets[i]!;
        lines.push(`${this.name}_bucket${base}le="${this.bucketBounds[i]}"} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${base}le="+Inf"} ${entry.count}`);
      const lbl = key ? `{${key}}` : '';
      lines.push(`${this.name}_sum${lbl} ${entry.sum}`);
      lines.push(`${this.name}_count${lbl} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Global metrics registry
// ═══════════════════════════════════════════════════════════════════════════

export const metrics = {
  _startTime: Date.now(),

  toolCalls: new Counter(
    'mcp_tool_calls_total',
    'Total MCP tool calls',
  ),

  toolDuration: new Histogram(
    'mcp_tool_duration_seconds',
    'MCP tool call duration in seconds',
    [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  ),

  toolErrors: new Counter(
    'mcp_tool_errors_total',
    'Total MCP tool call errors',
  ),

  backendRequests: new Counter(
    'mcp_backend_requests_total',
    'Total outbound requests to telemetry backends',
  ),

  backendDuration: new Histogram(
    'mcp_backend_duration_seconds',
    'Backend request duration in seconds',
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ),

  authAttempts: new Counter(
    'mcp_auth_attempts_total',
    'Client authentication attempts',
  ),

  activeSessions: new Gauge(
    'mcp_active_sessions',
    'Currently active MCP sessions',
  ),

  serverInfo: new Gauge(
    'mcp_server_info',
    'MCP server metadata',
  ),
};

/** Serialize all metrics to Prometheus text exposition format. */
export function serializeMetrics(): string {
  const startTime = metrics._startTime;
  // Add process uptime
  const uptimeLines = [
    '# HELP mcp_uptime_seconds Server uptime in seconds',
    '# TYPE mcp_uptime_seconds gauge',
    `mcp_uptime_seconds ${((Date.now() - startTime) / 1000).toFixed(1)}`,
  ];

  const parts = [
    uptimeLines.join('\n'),
    metrics.toolCalls.serialize(),
    metrics.toolDuration.serialize(),
    metrics.toolErrors.serialize(),
    metrics.backendRequests.serialize(),
    metrics.backendDuration.serialize(),
    metrics.authAttempts.serialize(),
    metrics.activeSessions.serialize(),
    metrics.serverInfo.serialize(),
  ].filter(s => s.includes('\n')); // skip empty metrics

  return parts.join('\n\n') + '\n';
}

// Set server info label
metrics.serverInfo.set({ version: '1.1.0' }, 1);

// ═══════════════════════════════════════════════════════════════════════════
//  Instrumented fetch wrapper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wraps a fetcher function with metrics instrumentation.
 * Tracks request count and duration per backend.
 */
export function instrumentFetcher(
  fetcher: (url: string, overrideTimeout?: number) => Promise<any>,
  backend: string,
): (url: string, overrideTimeout?: number) => Promise<any> {
  return async (url: string, overrideTimeout?: number) => {
    const start = performance.now();
    const labels = { backend };
    try {
      const result = await fetcher(url, overrideTimeout);
      metrics.backendRequests.inc({ ...labels, status: 'success' });
      return result;
    } catch (err) {
      metrics.backendRequests.inc({ ...labels, status: 'error' });
      throw err;
    } finally {
      const duration = (performance.now() - start) / 1000;
      metrics.backendDuration.observe(labels, duration);
    }
  };
}
