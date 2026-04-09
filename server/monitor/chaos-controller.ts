/**
 * Chaos Controller
 *
 * Server-side chaos injection engine for on-demand demo scenarios.
 * Injects artificial latency, errors, and anomalous conditions into
 * the request pipeline to trigger real alerts and anomaly detection.
 *
 * Protected by API key — never exposed without CHAOS_API_KEY set.
 */

import { createLogger } from '../lib/logger';
import { traceProfiler } from './trace-profiler';

const logger = createLogger('chaos-controller');

// ============================================
// Types
// ============================================

export type ChaosScenarioType =
    | 'latency-spike'
    | 'error-burst'
    | 'slow-degradation'
    | 'intermittent-errors'
    | 'cascade-failure';

export interface ChaosConfig {
    enabled: boolean;
    scenario: ChaosScenarioType | null;
    startedAt: Date | null;
    expiresAt: Date | null;

    /** Artificial delay to add to matching requests (ms) */
    delayMs: number;
    /** Probability of injecting an error (0-1) */
    errorRate: number;
    /** HTTP status code to return for injected errors */
    errorCode: number;
    /** Route patterns to target (empty = all routes) */
    targetRoutes: string[];
    /** Custom error message */
    errorMessage: string;
}

export interface ChaosScenario {
    type: ChaosScenarioType;
    name: string;
    description: string;
    durationSeconds: number;
    config: Partial<ChaosConfig>;
    /** For scenarios that escalate over time */
    phases?: Array<{
        atSeconds: number;
        config: Partial<ChaosConfig>;
    }>;
}

// ============================================
// Built-in Scenarios
// ============================================

export const SCENARIOS: Record<ChaosScenarioType, ChaosScenario> = {
    'latency-spike': {
        type: 'latency-spike',
        name: 'Latency Spike',
        description: 'Injects 3-8s delays on trade and wallet routes, triggering HighLatencyP99 alerts and anomaly detection SEV3+',
        durationSeconds: 180,
        config: {
            delayMs: 5000,
            errorRate: 0,
            targetRoutes: ['/api/v1/trade', '/api/v1/wallet'],
        },
    },
    'error-burst': {
        type: 'error-burst',
        name: 'Error Burst',
        description: 'Returns 500 errors on 40% of requests for 2 minutes, triggering HighErrorRate and SLO burn alerts',
        durationSeconds: 120,
        config: {
            delayMs: 200,
            errorRate: 0.4,
            errorCode: 500,
            errorMessage: 'Internal chaos: simulated database connection pool exhaustion',
            targetRoutes: ['/api/v1/trade', '/api/v1/wallet'],
        },
    },
    'slow-degradation': {
        type: 'slow-degradation',
        name: 'Slow Degradation',
        description: 'Gradually increasing latency over 5 minutes (200ms → 6s), simulating memory leak or connection pool drain',
        durationSeconds: 300,
        config: {
            delayMs: 200,
            errorRate: 0,
            targetRoutes: ['/api/v1/trade', '/api/v1/wallet'],
        },
        phases: [
            { atSeconds: 0, config: { delayMs: 200 } },
            { atSeconds: 60, config: { delayMs: 800 } },
            { atSeconds: 120, config: { delayMs: 2000 } },
            { atSeconds: 180, config: { delayMs: 4000 } },
            { atSeconds: 240, config: { delayMs: 6000, errorRate: 0.1 } },
        ],
    },
    'intermittent-errors': {
        type: 'intermittent-errors',
        name: 'Intermittent Errors',
        description: 'Sporadic 502/503 errors (15%) with moderate latency, simulating flaky upstream dependency',
        durationSeconds: 180,
        config: {
            delayMs: 1500,
            errorRate: 0.15,
            errorCode: 502,
            errorMessage: 'Bad Gateway: upstream service unavailable (chaos injection)',
            targetRoutes: ['/api/v1/trade'],
        },
    },
    'cascade-failure': {
        type: 'cascade-failure',
        name: 'Cascade Failure',
        description: 'Simulates cascading failure: starts with wallet latency, escalates to trade errors, then full degradation',
        durationSeconds: 240,
        config: {
            delayMs: 500,
            errorRate: 0,
            targetRoutes: ['/api/v1/wallet'],
        },
        phases: [
            { atSeconds: 0, config: { delayMs: 3000, targetRoutes: ['/api/v1/wallet'] } },
            { atSeconds: 60, config: { delayMs: 4000, errorRate: 0.2, targetRoutes: ['/api/v1/wallet', '/api/v1/trade'] } },
            { atSeconds: 120, config: { delayMs: 6000, errorRate: 0.5, errorCode: 503, targetRoutes: ['/api/v1/wallet', '/api/v1/trade'] } },
            { atSeconds: 180, config: { delayMs: 8000, errorRate: 0.7, errorCode: 503 } },
        ],
    },
};

// ============================================
// Controller
// ============================================

class ChaosController {
    private config: ChaosConfig = {
        enabled: false,
        scenario: null,
        startedAt: null,
        expiresAt: null,
        delayMs: 0,
        errorRate: 0,
        errorCode: 500,
        targetRoutes: [],
        errorMessage: 'Chaos injection: simulated failure',
    };

    private phaseTimer: ReturnType<typeof setInterval> | null = null;
    private expiryTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Start a built-in scenario
     */
    startScenario(type: ChaosScenarioType, durationOverride?: number): ChaosConfig {
        const scenario = SCENARIOS[type];
        if (!scenario) {
            throw new Error(`Unknown scenario: ${type}`);
        }

        this.stop();

        const duration = durationOverride || scenario.durationSeconds;
        const now = new Date();

        this.config = {
            enabled: true,
            scenario: type,
            startedAt: now,
            expiresAt: new Date(now.getTime() + duration * 1000),
            delayMs: scenario.config.delayMs || 0,
            errorRate: scenario.config.errorRate || 0,
            errorCode: scenario.config.errorCode || 500,
            targetRoutes: scenario.config.targetRoutes || [],
            errorMessage: scenario.config.errorMessage || 'Chaos injection: simulated failure',
        };

        // Set up phase progression for multi-phase scenarios
        if (scenario.phases && scenario.phases.length > 0) {
            let phaseIndex = 0;
            this.phaseTimer = setInterval(() => {
                const elapsedSeconds = (Date.now() - now.getTime()) / 1000;
                const nextPhase = scenario.phases!.find(
                    (p, i) => i > phaseIndex && elapsedSeconds >= p.atSeconds
                );
                if (nextPhase) {
                    phaseIndex = scenario.phases!.indexOf(nextPhase);
                    Object.assign(this.config, nextPhase.config);
                    logger.warn(
                        { phase: phaseIndex, delayMs: this.config.delayMs, errorRate: this.config.errorRate },
                        `Chaos escalation: phase ${phaseIndex + 1}`
                    );
                }
            }, 5000);
        }

        // Auto-expire
        this.expiryTimer = setTimeout(() => {
            logger.info({ scenario: type, duration }, 'Chaos scenario expired — auto-stopping');
            this.stop();
        }, duration * 1000);

        logger.warn(
            { scenario: type, duration, delayMs: this.config.delayMs, errorRate: this.config.errorRate },
            '🔥 Chaos scenario STARTED'
        );

        // Freeze baselines so anomaly detector compares against pre-chaos values
        traceProfiler.freezeBaselines();

        return { ...this.config };
    }

    /**
     * Start with custom configuration
     */
    startCustom(params: {
        delayMs?: number;
        errorRate?: number;
        errorCode?: number;
        targetRoutes?: string[];
        errorMessage?: string;
        durationSeconds?: number;
    }): ChaosConfig {
        this.stop();

        const duration = params.durationSeconds || 120;
        const now = new Date();

        this.config = {
            enabled: true,
            scenario: null,
            startedAt: now,
            expiresAt: new Date(now.getTime() + duration * 1000),
            delayMs: params.delayMs || 0,
            errorRate: params.errorRate || 0,
            errorCode: params.errorCode || 500,
            targetRoutes: params.targetRoutes || [],
            errorMessage: params.errorMessage || 'Chaos injection: simulated failure',
        };

        this.expiryTimer = setTimeout(() => {
            logger.info('Custom chaos expired — auto-stopping');
            this.stop();
        }, duration * 1000);

        logger.warn(
            { duration, delayMs: this.config.delayMs, errorRate: this.config.errorRate },
            '🔥 Custom chaos STARTED'
        );

        return { ...this.config };
    }

    /**
     * Stop all chaos injection
     */
    stop(): ChaosConfig {
        const wasEnabled = this.config.enabled;

        if (this.phaseTimer) {
            clearInterval(this.phaseTimer);
            this.phaseTimer = null;
        }
        if (this.expiryTimer) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = null;
        }

        this.config = {
            enabled: false,
            scenario: null,
            startedAt: null,
            expiresAt: null,
            delayMs: 0,
            errorRate: 0,
            errorCode: 500,
            targetRoutes: [],
            errorMessage: 'Chaos injection: simulated failure',
        };

        if (wasEnabled) {
            logger.info('✅ Chaos injection STOPPED — system returning to normal');
            traceProfiler.unfreezeBaselines();
        }

        return { ...this.config };
    }

    /**
     * Get current chaos state
     */
    getStatus(): ChaosConfig & { remainingSeconds: number | null; scenarios: typeof SCENARIOS } {
        const remaining = this.config.expiresAt
            ? Math.max(0, Math.round((this.config.expiresAt.getTime() - Date.now()) / 1000))
            : null;

        return {
            ...this.config,
            remainingSeconds: remaining,
            scenarios: SCENARIOS,
        };
    }

    /**
     * Check if a request path should be affected by chaos
     */
    shouldAffect(path: string): boolean {
        if (!this.config.enabled) return false;

        // Check expiry
        if (this.config.expiresAt && Date.now() > this.config.expiresAt.getTime()) {
            this.stop();
            return false;
        }

        // If no target routes specified, affect everything
        if (this.config.targetRoutes.length === 0) return true;

        // Match against target route prefixes
        return this.config.targetRoutes.some(route => path.startsWith(route));
    }

    /**
     * Get the current delay to inject (with jitter)
     */
    getDelay(): number {
        if (!this.config.enabled || this.config.delayMs === 0) return 0;
        // Add ±30% jitter for realism
        const jitter = 0.7 + Math.random() * 0.6;
        return Math.round(this.config.delayMs * jitter);
    }

    /**
     * Should this request return an error?
     */
    shouldError(): boolean {
        if (!this.config.enabled || this.config.errorRate === 0) return false;
        return Math.random() < this.config.errorRate;
    }

    getErrorCode(): number {
        return this.config.errorCode;
    }

    getErrorMessage(): string {
        return this.config.errorMessage;
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }
}

export const chaosController = new ChaosController();
