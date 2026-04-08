/**
 * Cap 10: User-Centric Observability Tests (TDD)
 *
 * Tests for:
 * - Web Vitals reporting as OTEL spans
 * - Correct attribute names and values
 *
 * NOTE: These are unit tests for the reporting logic.
 * The actual web-vitals library is browser-only and tested via E2E.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OTEL tracer
const mockEnd = vi.fn();
const mockSetAttribute = vi.fn();
const mockStartSpan = vi.fn(() => ({
    setAttribute: mockSetAttribute,
    end: mockEnd,
}));
const mockTracer = { startSpan: mockStartSpan };

describe('Cap 10: User-Centric Observability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Web Vital Reporter', () => {
        it('should create a span with correct name for each web vital metric', async () => {
            const { reportWebVital } = await import('../../shared/web-vitals-reporter');

            reportWebVital(mockTracer as any, {
                name: 'LCP',
                value: 2500,
                rating: 'needs-improvement',
                id: 'v4-lcp-1',
                delta: 2500,
                entries: [],
                navigationType: 'navigate',
            });

            expect(mockStartSpan).toHaveBeenCalledWith('web-vital.LCP');
            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.name', 'LCP');
            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.value', 2500);
            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.rating', 'needs-improvement');
            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.id', 'v4-lcp-1');
            expect(mockEnd).toHaveBeenCalled();
        });

        it('should handle all 5 core web vitals', async () => {
            const { reportWebVital } = await import('../../shared/web-vitals-reporter');
            const vitals = [
                { name: 'LCP', value: 2500, rating: 'needs-improvement' as const },
                { name: 'INP', value: 50, rating: 'good' as const },
                { name: 'CLS', value: 0.15, rating: 'needs-improvement' as const },
                { name: 'FCP', value: 1800, rating: 'good' as const },
                { name: 'TTFB', value: 800, rating: 'poor' as const },
            ];

            for (const vital of vitals) {
                vi.clearAllMocks();
                reportWebVital(mockTracer as any, {
                    name: vital.name,
                    value: vital.value,
                    rating: vital.rating,
                    id: `v4-${vital.name.toLowerCase()}-1`,
                    delta: vital.value,
                    entries: [],
                    navigationType: 'navigate',
                });

                expect(mockStartSpan).toHaveBeenCalledWith(`web-vital.${vital.name}`);
                expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.value', vital.value);
                expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.rating', vital.rating);
            }
        });

        it('should include navigation type attribute', async () => {
            const { reportWebVital } = await import('../../shared/web-vitals-reporter');

            reportWebVital(mockTracer as any, {
                name: 'TTFB',
                value: 300,
                rating: 'good',
                id: 'v4-ttfb-1',
                delta: 300,
                entries: [],
                navigationType: 'reload',
            });

            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.navigation_type', 'reload');
        });

        it('should handle decimal CLS values correctly', async () => {
            const { reportWebVital } = await import('../../shared/web-vitals-reporter');

            reportWebVital(mockTracer as any, {
                name: 'CLS',
                value: 0.003,
                rating: 'good',
                id: 'v4-cls-1',
                delta: 0.003,
                entries: [],
                navigationType: 'navigate',
            });

            expect(mockSetAttribute).toHaveBeenCalledWith('web_vital.value', 0.003);
        });
    });
});
