/**
 * Transparency Service Tests
 *
 * Tests the Prometheus histogram query for landing-page performance metrics,
 * including the fallback to span baselines when Prometheus is unreachable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (hoisted) ----

const mockDbQuery = vi.fn();
const mockGetBaselines = vi.fn();
const mockGetAnomalyHistory = vi.fn();
const mockGetServiceHealth = vi.fn();
const mockGetTraceProfiler = vi.fn();

vi.mock('../../server/db', () => ({
  db: { query: mockDbQuery },
}));

vi.mock('../../server/storage', () => ({
  storage: {},
}));

vi.mock('../../server/config', () => ({
  config: {
    env: 'test',
    observability: {
      prometheusUrl: 'http://localhost:9090',
      lokiUrl: '',
    },
    logging: { level: 'silent', pretty: false },
  },
}));

vi.mock('../../server/monitor/history-store', () => ({
  historyStore: {
    getBaselines: mockGetBaselines,
    getAnomalyHistory: mockGetAnomalyHistory,
  },
}));

vi.mock('../../server/monitor/trace-profiler', () => ({
  traceProfiler: {
    getComponentTraces: mockGetTraceProfiler,
  },
}));

vi.mock('../../server/monitor/anomaly-detector', () => ({
  anomalyDetector: {
    getServiceHealth: mockGetServiceHealth,
  },
}));

vi.mock('../../server/lib/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: vi.fn(),
    getTracer: vi.fn(() => ({
      startActiveSpan: vi.fn((_n: string, fn: any) => fn({
        setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(),
        spanContext: () => ({ traceId: 'abc123', spanId: 'def456' }),
      })),
    })),
  },
  context: { active: vi.fn(), with: vi.fn((_c: any, fn: any) => fn()) },
  SpanStatusCode: { OK: 0, ERROR: 1 },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---- Helpers ----

function mockDbDefaults() {
  // trades last 24h, total, active users
  mockDbQuery
    .mockResolvedValueOnce({ rows: [{ count: '50' }] })
    .mockResolvedValueOnce({ rows: [{ count: '500' }] })
    .mockResolvedValueOnce({ rows: [{ count: '5' }] });
  mockGetAnomalyHistory.mockResolvedValue([]);
  mockGetServiceHealth.mockReturnValue([]);
}

function promResponse(value: string) {
  return {
    ok: true,
    json: () => Promise.resolve({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: {}, value: [Date.now() / 1000, value] }],
      },
    }),
  };
}

// ---- Tests ----

describe('TransparencyService', () => {
  let transparencyService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to pick up fresh mocks each time
    const mod = await import('../../server/services/transparency-service');
    transparencyService = mod.transparencyService;
  });

  describe('getSystemStatus — Prometheus performance metrics', () => {
    it('should query Prometheus for P50, P95, P99 histogram quantiles', async () => {
      mockDbDefaults();

      // Mock 3 Prometheus quantile queries (0.5, 0.95, 0.99)
      mockFetch
        .mockResolvedValueOnce(promResponse('0.034'))  // P50 = 34ms
        .mockResolvedValueOnce(promResponse('0.798'))  // P95 = 798ms
        .mockResolvedValueOnce(promResponse('2.145')); // P99 = 2145ms

      const status = await transparencyService.getSystemStatus();

      // Verify 3 Prometheus calls were made
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify PromQL queries contain histogram_quantile
      const calls = mockFetch.mock.calls;
      expect(calls[0][0]).toContain('histogram_quantile(0.5');
      expect(calls[1][0]).toContain('histogram_quantile(0.95');
      expect(calls[2][0]).toContain('histogram_quantile(0.99');

      // Verify converted to milliseconds
      expect(status.performance.p50ResponseMs).toBe(34);
      expect(status.performance.p95ResponseMs).toBe(798);
      expect(status.performance.p99ResponseMs).toBe(2145);
    });

    it('should handle NaN values from Prometheus (no data in window)', async () => {
      mockDbDefaults();

      mockFetch
        .mockResolvedValueOnce(promResponse('NaN'))
        .mockResolvedValueOnce(promResponse('NaN'))
        .mockResolvedValueOnce(promResponse('NaN'));

      const status = await transparencyService.getSystemStatus();

      expect(status.performance.p50ResponseMs).toBe(0);
      expect(status.performance.p95ResponseMs).toBe(0);
      expect(status.performance.p99ResponseMs).toBe(0);
    });

    it('should handle +Inf values from Prometheus', async () => {
      mockDbDefaults();

      mockFetch
        .mockResolvedValueOnce(promResponse('+Inf'))
        .mockResolvedValueOnce(promResponse('0.5'))
        .mockResolvedValueOnce(promResponse('+Inf'));

      const status = await transparencyService.getSystemStatus();

      expect(status.performance.p50ResponseMs).toBe(0);
      expect(status.performance.p95ResponseMs).toBe(500);
      expect(status.performance.p99ResponseMs).toBe(0);
    });

    it('should fall back to span baselines when Prometheus is unreachable', async () => {
      mockDbDefaults();

      // Prometheus connection refused
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      // Span baselines: only HTTP methods with 100+ samples from kx-exchange
      mockGetBaselines.mockResolvedValue([
        { service: 'kx-exchange', operation: 'GET', sampleCount: 200, p50: 25, p95: 150, p99: 500 },
        { service: 'kx-exchange', operation: 'POST', sampleCount: 150, p50: 40, p95: 200, p99: 800 },
        // Should be EXCLUDED: non-HTTP operation
        { service: 'kx-exchange', operation: 'dns.lookup', sampleCount: 500, p50: 1, p95: 5, p99: 10 },
        // Should be EXCLUDED: different service
        { service: 'other-service', operation: 'GET', sampleCount: 300, p50: 100, p95: 500, p99: 1000 },
        // Should be EXCLUDED: too few samples
        { service: 'kx-exchange', operation: 'DELETE', sampleCount: 5, p50: 50, p95: 200, p99: 600 },
      ]);

      const status = await transparencyService.getSystemStatus();

      // Weighted average of GET (200 samples) and POST (150 samples) only
      const expectedP50 = Math.round((25 * 200 + 40 * 150) / 350);
      const expectedP95 = Math.round((150 * 200 + 200 * 150) / 350);
      const expectedP99 = Math.round((500 * 200 + 800 * 150) / 350);

      expect(status.performance.p50ResponseMs).toBe(expectedP50);
      expect(status.performance.p95ResponseMs).toBe(expectedP95);
      expect(status.performance.p99ResponseMs).toBe(expectedP99);
    });

    it('should return 0 when fallback has no qualifying baselines', async () => {
      mockDbDefaults();

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      mockGetBaselines.mockResolvedValue([
        // All excluded: wrong service, non-HTTP, too few samples
        { service: 'other', operation: 'GET', sampleCount: 200, p50: 100, p95: 500, p99: 1000 },
        { service: 'kx-exchange', operation: 'tcp.connect', sampleCount: 200, p50: 10, p95: 50, p99: 100 },
        { service: 'kx-exchange', operation: 'GET', sampleCount: 10, p50: 30, p95: 200, p99: 500 },
      ]);

      const status = await transparencyService.getSystemStatus();

      expect(status.performance.p50ResponseMs).toBe(0);
      expect(status.performance.p95ResponseMs).toBe(0);
      expect(status.performance.p99ResponseMs).toBe(0);
    });
  });

  describe('getSystemStatus — service health mapping', () => {
    it('should map service health to operational status', async () => {
      mockDbDefaults();
      mockFetch
        .mockResolvedValueOnce(promResponse('0.034'))
        .mockResolvedValueOnce(promResponse('0.798'))
        .mockResolvedValueOnce(promResponse('2.145'));

      mockGetServiceHealth.mockReturnValue([
        { name: 'exchange-api', status: 'healthy' },
        { name: 'wallet-service', status: 'healthy' },
      ]);

      const status = await transparencyService.getSystemStatus();

      expect(status.status).toBe('operational');
      expect(status.services.exchange).toBe('operational');
    });

    it('should detect degraded state from critical services', async () => {
      mockDbDefaults();
      mockFetch
        .mockResolvedValueOnce(promResponse('0.05'))
        .mockResolvedValueOnce(promResponse('0.5'))
        .mockResolvedValueOnce(promResponse('1.0'));

      mockGetServiceHealth.mockReturnValue([
        { name: 'exchange-api', status: 'critical' },
      ]);

      const status = await transparencyService.getSystemStatus();

      expect(status.services.exchange).toBe('degraded');
    });
  });
});
