/**
 * Cap 11: Security SIEM Integration Tests (TDD)
 *
 * Tests for:
 * - SIEM webhook export for HIGH/CRITICAL events
 * - Filtering (only high/critical severity triggers export)
 * - Graceful failure handling when webhook is unreachable
 * - Configurable webhook URL via env var
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
);
vi.stubGlobal('fetch', mockFetch);

// Mock Drizzle DB
vi.mock('../../server/db/drizzle', () => ({
    drizzleDb: {
        insert: vi.fn(() => ({
            values: vi.fn(() => ({
                returning: vi.fn(() => Promise.resolve([{
                    id: 1,
                    eventType: 'login_failed',
                    severity: 'high',
                    userId: null,
                    ipAddress: '192.168.1.1',
                    userAgent: 'test',
                    resource: '/api/auth/login',
                    details: {},
                    traceId: 'trace-123',
                    createdAt: new Date(),
                }])),
            })),
        })),
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                        limit: vi.fn(() => ({
                            offset: vi.fn(() => Promise.resolve([])),
                        })),
                    })),
                })),
            })),
        })),
    },
}));

// Mock schema imports
vi.mock('../../server/db/schema', () => ({
    securityEvents: { eventType: 'eventType', severity: 'severity', userId: 'userId', ipAddress: 'ipAddress', userAgent: 'userAgent', resource: 'resource', details: 'details', traceId: 'traceId', createdAt: 'createdAt' },
    SecurityEventTypes: {
        LOGIN_SUCCESS: 'login_success',
        LOGIN_FAILED: 'login_failed',
        TWO_FA_FAILED: '2fa_failed',
        RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
        AUTH_RATE_LIMIT_EXCEEDED: 'auth_rate_limit_exceeded',
        SENSITIVE_RATE_LIMIT_EXCEEDED: 'sensitive_rate_limit_exceeded',
        INVALID_TOKEN: 'invalid_token',
        TOKEN_EXPIRED: 'token_expired',
        ANOMALY_DETECTED: 'anomaly_detected',
        SESSION_CREATED: 'session_created',
        SESSION_REVOKED: 'session_revoked',
    },
    SecuritySeverity: {
        LOW: 'low',
        MEDIUM: 'medium',
        HIGH: 'high',
        CRITICAL: 'critical',
        INFO: 'info',
    },
}));

// Mock OTEL
vi.mock('@opentelemetry/api', () => ({
    trace: {
        getActiveSpan: vi.fn(() => ({
            spanContext: () => ({ traceId: 'mock-trace-id' }),
        })),
    },
}));

// Mock prom-client
vi.mock('prom-client', () => ({
    Counter: vi.fn(() => ({
        inc: vi.fn(),
        labels: vi.fn(() => ({ inc: vi.fn() })),
    })),
}));

vi.mock('../../server/metrics/prometheus', () => ({
    getMetricsRegistry: vi.fn(() => ({
        registerMetric: vi.fn(),
    })),
}));

vi.mock('../../server/lib/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
    eq: vi.fn(),
    desc: vi.fn(),
    and: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    sql: vi.fn(),
}));

describe('Cap 11: Security SIEM Integration', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
        vi.resetModules();
    });

    describe('SIEM Webhook Export', () => {
        it('should export HIGH severity events to SIEM webhook', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';
            process.env.SIEM_API_KEY = 'test-api-key';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'login_failed',
                severity: 'high',
                ipAddress: '192.168.1.1',
                resource: '/api/auth/login',
                traceId: 'trace-123',
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://siem.example.com/webhook',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer test-api-key',
                    }),
                })
            );

            // Verify the body contains source and event data
            const callArgs = mockFetch.mock.calls[0];
            const body = JSON.parse(callArgs[1].body);
            expect(body.source).toBe('krystalinex');
            expect(body.eventType).toBe('login_failed');
            expect(body.severity).toBe('high');
            expect(body.timestamp).toBeDefined();
        });

        it('should export CRITICAL severity events to SIEM webhook', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';
            process.env.SIEM_API_KEY = 'test-api-key';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'rate_limit_exceeded',
                severity: 'critical',
                ipAddress: '10.0.0.1',
                resource: '/api/v1/trade',
                traceId: 'trace-456',
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should NOT export LOW severity events', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'token_expired',
                severity: 'low',
                ipAddress: '192.168.1.1',
            });

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should NOT export MEDIUM severity events', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'login_failed',
                severity: 'medium',
                ipAddress: '192.168.1.1',
            });

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should NOT export INFO severity events', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'login_success',
                severity: 'info',
                ipAddress: '192.168.1.1',
            });

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should NOT export when SIEM_WEBHOOK_URL is not configured', async () => {
            delete process.env.SIEM_WEBHOOK_URL;

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: 'login_failed',
                severity: 'high',
                ipAddress: '192.168.1.1',
            });

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should handle webhook failure gracefully (no throw)', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';

            mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

            const { exportToSIEM } = await import('../../server/observability/security-events');

            // Should not throw
            await expect(
                exportToSIEM({
                    eventType: 'login_failed',
                    severity: 'critical',
                    ipAddress: '192.168.1.1',
                })
            ).resolves.not.toThrow();
        });

        it('should include all required fields in SIEM payload', async () => {
            process.env.SIEM_WEBHOOK_URL = 'https://siem.example.com/webhook';
            process.env.SIEM_API_KEY = 'key123';

            const { exportToSIEM } = await import('../../server/observability/security-events');

            await exportToSIEM({
                eventType: '2fa_failed',
                severity: 'high',
                userId: 'user-42',
                ipAddress: '10.0.0.5',
                userAgent: 'Mozilla/5.0',
                resource: '/api/auth/2fa/verify',
                traceId: 'trace-789',
                details: { attemptCount: 3 },
            });

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body).toMatchObject({
                source: 'krystalinex',
                eventType: '2fa_failed',
                severity: 'high',
                userId: 'user-42',
                ipAddress: '10.0.0.5',
                resource: '/api/auth/2fa/verify',
                traceId: 'trace-789',
            });
            expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });
});
