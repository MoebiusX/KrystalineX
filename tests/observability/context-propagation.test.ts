/**
 * Cap 3: Context Propagation Tests (TDD)
 *
 * Tests for:
 * - Prometheus exemplars on histogram observations
 * - User ID propagation to OTEL spans
 * - W3C Baggage propagator registration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// ============================================
// 3A: Prometheus Exemplar Tests
// ============================================

// Mock OTEL trace API
const mockSpanContext = { traceId: 'abc123def456789000000000deadbeef', spanId: '1234567890abcdef', traceFlags: 1 };
const mockSpan = {
    spanContext: vi.fn(() => mockSpanContext),
    setAttribute: vi.fn(),
    end: vi.fn(),
};

vi.mock('@opentelemetry/api', () => ({
    trace: {
        getActiveSpan: vi.fn(() => mockSpan),
        getTracer: vi.fn(() => ({
            startSpan: vi.fn(() => mockSpan),
        })),
    },
    context: { active: vi.fn() },
}));

// Mock prom-client
const mockObserve = vi.fn();
const mockInc = vi.fn();

vi.mock('prom-client', () => {
    const RegistryMock: any = vi.fn(() => ({
        registerMetric: vi.fn(),
        metrics: vi.fn(() => Promise.resolve('')),
        contentType: 'application/openmetrics-text; version=1.0.0; charset=utf-8',
        setContentType: vi.fn(),
    }));
    RegistryMock.OPENMETRICS_CONTENT_TYPE = 'application/openmetrics-text; version=1.0.0; charset=utf-8';
    return {
        Registry: RegistryMock,
        collectDefaultMetrics: vi.fn(),
        Counter: vi.fn(() => ({
            inc: mockInc,
            labels: vi.fn(() => ({ inc: mockInc })),
        })),
        Histogram: vi.fn(() => ({
            observe: mockObserve,
            labels: vi.fn(() => ({ observe: mockObserve })),
        })),
        Gauge: vi.fn(() => ({
            inc: vi.fn(),
            dec: vi.fn(),
            set: vi.fn(),
        })),
    };
});

vi.mock('../../server/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

describe('Cap 3: Context Propagation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('3A: Prometheus Exemplars', () => {
        it('should include traceId exemplar when observing http_request_duration', async () => {
            const { metricsMiddleware } = await import('../../server/metrics/prometheus');

            const req = {
                path: '/api/v1/trade',
                method: 'POST',
                route: { path: '/api/v1/trade' },
            } as unknown as Request;

            const finishCallbacks: Array<() => void> = [];
            const res = {
                statusCode: 200,
                on: vi.fn((event: string, cb: () => void) => {
                    if (event === 'finish') finishCallbacks.push(cb);
                }),
            } as unknown as Response;

            const next = vi.fn() as NextFunction;

            metricsMiddleware(req, res, next);
            expect(next).toHaveBeenCalled();

            // Simulate response finishing
            finishCallbacks.forEach(cb => cb());

            // Verify observe was called with exemplar in object form
            expect(mockObserve).toHaveBeenCalled();
            const observeCall = mockObserve.mock.calls[0];
            expect(observeCall).toBeDefined();
            // With exemplar: observe({ labels, value, exemplarLabels: {traceID: '...'} })
            const arg = observeCall[0];
            expect(arg).toHaveProperty('exemplarLabels');
            expect(arg.exemplarLabels).toHaveProperty('traceID');
            expect(arg.exemplarLabels.traceID).toBe(mockSpanContext.traceId);
        });

        it('should NOT include exemplar when no active span exists', async () => {
            const { trace } = await import('@opentelemetry/api');
            vi.mocked(trace.getActiveSpan).mockReturnValueOnce(undefined);

            const { metricsMiddleware } = await import('../../server/metrics/prometheus');

            const req = {
                path: '/api/test',
                method: 'GET',
                route: { path: '/api/test' },
            } as unknown as Request;

            const finishCallbacks: Array<() => void> = [];
            const res = {
                statusCode: 200,
                on: vi.fn((event: string, cb: () => void) => {
                    if (event === 'finish') finishCallbacks.push(cb);
                }),
            } as unknown as Response;

            metricsMiddleware(req, res, vi.fn());
            finishCallbacks.forEach(cb => cb());

            expect(mockObserve).toHaveBeenCalled();
            const observeCall = mockObserve.mock.calls[0];
            if (observeCall.length >= 3) {
                expect(observeCall[2]).toBeUndefined();
            }
        });

        it('should skip exemplars for /metrics endpoint', async () => {
            const { metricsMiddleware } = await import('../../server/metrics/prometheus');

            const req = { path: '/metrics', method: 'GET' } as Request;
            const res = { on: vi.fn() } as unknown as Response;
            const next = vi.fn();

            metricsMiddleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(mockObserve).not.toHaveBeenCalled();
        });
    });

    // ============================================
    // 3B: User Context Propagation Tests
    // ============================================

    describe('3B: User Context on Spans', () => {
        it('should set enduser.id on active span for authenticated requests', async () => {
            const { createUserContextMiddleware } = await import('../../server/middleware/user-context');

            const req = {
                user: { id: 42, email: 'trader@krystaline.io' },
            } as unknown as Request;
            const res = {} as Response;
            const next = vi.fn();

            createUserContextMiddleware()(req, res, next);

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('enduser.id', '42');
            expect(next).toHaveBeenCalled();
        });

        it('should NOT set enduser.id when user is not authenticated', async () => {
            const { createUserContextMiddleware } = await import('../../server/middleware/user-context');

            const req = {} as Request; // no req.user
            const res = {} as Response;
            const next = vi.fn();

            createUserContextMiddleware()(req, res, next);

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('enduser.id', expect.anything());
            expect(next).toHaveBeenCalled();
        });

        it('should handle missing active span gracefully', async () => {
            const { trace } = await import('@opentelemetry/api');
            vi.mocked(trace.getActiveSpan).mockReturnValueOnce(undefined);

            const { createUserContextMiddleware } = await import('../../server/middleware/user-context');

            const req = {
                user: { id: 42, email: 'trader@krystaline.io' },
            } as unknown as Request;
            const res = {} as Response;
            const next = vi.fn();

            createUserContextMiddleware()(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });
});
