import { describe, it, expect, beforeEach } from 'vitest';
import { metrics, serializeMetrics, instrumentFetcher } from '../src/metrics.js';

describe('metrics registry', () => {
  it('serializes counters', () => {
    metrics.toolCalls.inc({ tool: 'traces_search', status: 'success' });
    metrics.toolCalls.inc({ tool: 'traces_search', status: 'success' });
    metrics.toolCalls.inc({ tool: 'metrics_query', status: 'error' });

    const output = serializeMetrics();
    expect(output).toContain('# HELP mcp_tool_calls_total Total MCP tool calls');
    expect(output).toContain('# TYPE mcp_tool_calls_total counter');
    expect(output).toContain('mcp_tool_calls_total{status="success",tool="traces_search"}');
    expect(output).toContain('mcp_tool_calls_total{status="error",tool="metrics_query"}');
  });

  it('serializes histograms', () => {
    metrics.toolDuration.observe({ tool: 'test_tool' }, 0.05);
    metrics.toolDuration.observe({ tool: 'test_tool' }, 0.15);
    metrics.toolDuration.observe({ tool: 'test_tool' }, 1.5);

    const output = serializeMetrics();
    expect(output).toContain('# HELP mcp_tool_duration_seconds MCP tool call duration in seconds');
    expect(output).toContain('# TYPE mcp_tool_duration_seconds histogram');
    expect(output).toContain('mcp_tool_duration_seconds_bucket{tool="test_tool",le="0.05"}');
    expect(output).toContain('mcp_tool_duration_seconds_sum{tool="test_tool"}');
    expect(output).toContain('mcp_tool_duration_seconds_count{tool="test_tool"} 3');
  });

  it('serializes gauges', () => {
    metrics.activeSessions.set({}, 5);

    const output = serializeMetrics();
    expect(output).toContain('# HELP mcp_active_sessions Currently active MCP sessions');
    expect(output).toContain('mcp_active_sessions 5');
  });

  it('includes uptime', () => {
    const output = serializeMetrics();
    expect(output).toContain('# HELP mcp_uptime_seconds Server uptime in seconds');
    expect(output).toContain('mcp_uptime_seconds');
  });

  it('includes server info', () => {
    const output = serializeMetrics();
    expect(output).toContain('mcp_server_info{version="1.1.0"} 1');
  });

  it('gauge increments and decrements', () => {
    metrics.activeSessions.set({}, 0);
    metrics.activeSessions.inc();
    metrics.activeSessions.inc();
    metrics.activeSessions.dec();

    const output = serializeMetrics();
    expect(output).toContain('mcp_active_sessions 1');
  });

  it('auth attempts counter tracks results', () => {
    metrics.authAttempts.inc({ result: 'accepted' });
    metrics.authAttempts.inc({ result: 'rejected' });
    metrics.authAttempts.inc({ result: 'accepted' });

    const output = serializeMetrics();
    expect(output).toContain('mcp_auth_attempts_total{result="accepted"}');
    expect(output).toContain('mcp_auth_attempts_total{result="rejected"}');
  });

  it('produces valid Prometheus text format', () => {
    const output = serializeMetrics();
    // Must end with newline
    expect(output.endsWith('\n')).toBe(true);
    // No consecutive blank lines except between metric blocks
    expect(output).not.toContain('\n\n\n');
  });
});

describe('instrumentFetcher', () => {
  it('tracks successful backend requests', async () => {
    const mockFetcher = async (url: string) => ({ data: 'test' });
    const instrumented = instrumentFetcher(mockFetcher, 'jaeger');

    const result = await instrumented('http://jaeger:16686/api/services');
    expect(result.data).toBe('test');

    const output = serializeMetrics();
    expect(output).toContain('mcp_backend_requests_total{backend="jaeger",status="success"}');
    expect(output).toContain('mcp_backend_duration_seconds_bucket{backend="jaeger"');
  });

  it('tracks failed backend requests', async () => {
    const mockFetcher = async () => { throw new Error('Connection refused'); };
    const instrumented = instrumentFetcher(mockFetcher, 'failing-backend');

    await expect(instrumented('http://fail:9200')).rejects.toThrow('Connection refused');

    const output = serializeMetrics();
    expect(output).toContain('mcp_backend_requests_total{backend="failing-backend",status="error"}');
  });
});
