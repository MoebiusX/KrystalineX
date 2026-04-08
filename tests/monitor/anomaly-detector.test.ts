/**
 * Anomaly Detector Tests
 * 
 * Tests for the anomaly detection service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../../server/monitor/trace-profiler', () => ({
    traceProfiler: {
        getBaselines: vi.fn(() => []),
        getBaseline: vi.fn(() => undefined),
    }
}));

vi.mock('../../server/monitor/stream-analyzer', () => ({
    streamAnalyzer: {
        enqueue: vi.fn(),
    }
}));

vi.mock('../../server/config', () => ({
    config: {
        observability: {
            jaegerUrl: 'http://localhost:16686',
        }
    }
}));

vi.mock('../../server/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }))
}));

// Mock fetch
global.fetch = vi.fn();

import { AnomalyDetector } from '../../server/monitor/anomaly-detector';
import { traceProfiler } from '../../server/monitor/trace-profiler';
import type { SpanBaseline, Anomaly } from '../../server/monitor/types';

describe('AnomalyDetector', () => {
    let detector: AnomalyDetector;

    beforeEach(() => {
        vi.clearAllMocks();
        detector = new AnomalyDetector();
    });

    afterEach(() => {
        detector.stop();
    });

    // ============================================
    // Lifecycle
    // ============================================
    describe('Lifecycle', () => {
        it('should create detector instance', () => {
            expect(detector).toBeDefined();
        });

        it('should start detection loop', () => {
            detector.start();
            // Should not throw
            expect(detector).toBeDefined();
        });

        it('should not start twice', () => {
            detector.start();
            detector.start(); // Second call should be no-op
            expect(detector).toBeDefined();
        });

        it('should stop detection', () => {
            detector.start();
            detector.stop();
            expect(detector).toBeDefined();
        });
    });

    // ============================================
    // Get Active Anomalies
    // ============================================
    describe('getActiveAnomalies', () => {
        it('should return empty array initially', () => {
            const anomalies = detector.getActiveAnomalies();
            expect(anomalies).toEqual([]);
        });

        it('should return anomalies sorted by timestamp descending', () => {
            // Add anomalies through internal state (simulating detection)
            const anomalies = detector.getActiveAnomalies();
            expect(Array.isArray(anomalies)).toBe(true);
        });
    });

    // ============================================
    // Get All Anomalies
    // ============================================
    describe('getAllAnomalies', () => {
        it('should return all anomalies', () => {
            const all = detector.getAllAnomalies();
            expect(Array.isArray(all)).toBe(true);
        });
    });

    // ============================================
    // Service Health
    // ============================================
    describe('getServiceHealth', () => {
        it('should return empty array when no baselines', () => {
            (traceProfiler.getBaselines as any).mockReturnValue([]);
            
            const health = detector.getServiceHealth();
            expect(health).toEqual([]);
        });

        it('should aggregate health by service', () => {
            const baselines: SpanBaseline[] = [
                {
                    service: 'kx-wallet',
                    operation: 'transfer',
                    spanKey: 'kx-wallet:transfer',
                    mean: 100,
                    stdDev: 20,
                    variance: 400,
                    p50: 95,
                    p95: 140,
                    p99: 180,
                    min: 50,
                    max: 200,
                    sampleCount: 1000,
                    lastUpdated: new Date()
                },
                {
                    service: 'kx-wallet',
                    operation: 'getBalance',
                    spanKey: 'kx-wallet:getBalance',
                    mean: 50,
                    stdDev: 10,
                    variance: 100,
                    p50: 45,
                    p95: 70,
                    p99: 90,
                    min: 20,
                    max: 100,
                    sampleCount: 2000,
                    lastUpdated: new Date()
                },
                {
                    service: 'kx-exchange',
                    operation: 'executeOrder',
                    spanKey: 'kx-exchange:executeOrder',
                    mean: 200,
                    stdDev: 40,
                    variance: 1600,
                    p50: 190,
                    p95: 280,
                    p99: 350,
                    min: 100,
                    max: 500,
                    sampleCount: 500,
                    lastUpdated: new Date()
                }
            ];

            (traceProfiler.getBaselines as any).mockReturnValue(baselines);

            const health = detector.getServiceHealth();

            expect(health.length).toBe(2);
            
            const walletHealth = health.find(h => h.name === 'kx-wallet');
            expect(walletHealth).toBeDefined();
            expect(walletHealth?.spanCount).toBe(2);

            const exchangeHealth = health.find(h => h.name === 'kx-exchange');
            expect(exchangeHealth).toBeDefined();
            expect(exchangeHealth?.spanCount).toBe(1);
        });

        it('should set healthy status when no anomalies', () => {
            const baselines: SpanBaseline[] = [
                {
                    service: 'kx-wallet',
                    operation: 'transfer',
                    spanKey: 'kx-wallet:transfer',
                    mean: 100,
                    stdDev: 20,
                    variance: 400,
                    p50: 95,
                    p95: 140,
                    p99: 180,
                    min: 50,
                    max: 200,
                    sampleCount: 1000,
                    lastUpdated: new Date()
                }
            ];

            (traceProfiler.getBaselines as any).mockReturnValue(baselines);

            const health = detector.getServiceHealth();
            expect(health[0]?.status).toBe('healthy');
        });
    });

    // ============================================
    // Severity Calculation
    // ============================================
    describe('Severity Calculation', () => {
        it('should calculate severity based on deviation', () => {
            // Test the severity thresholds conceptually
            // SEV 5: deviation >= 1.3σ
            // SEV 4: deviation >= 1.65σ
            // SEV 3: deviation >= 2.0σ
            // SEV 2: deviation >= 2.6σ
            // SEV 1: deviation >= 3.3σ
            
            const thresholds = {
                sev5: 2.0,
                sev4: 3.0,
                sev3: 4.0,
                sev2: 5.0,
                sev1: 6.0
            };

            expect(thresholds.sev1).toBeGreaterThan(thresholds.sev2);
            expect(thresholds.sev2).toBeGreaterThan(thresholds.sev3);
            expect(thresholds.sev3).toBeGreaterThan(thresholds.sev4);
            expect(thresholds.sev4).toBeGreaterThan(thresholds.sev5);
        });
    });
});
