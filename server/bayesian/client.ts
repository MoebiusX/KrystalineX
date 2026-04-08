/**
 * Bayesian Service HTTP Client
 *
 * Communicates with the Python Bayesian Inference Service (FastAPI).
 * Handles connection errors gracefully — the service may not always be available.
 */

import type {
    TrainRequest,
    TrainResponse,
    InferRequest,
    InferResponse,
    BayesianHealthResponse,
    TrainAlertsRequest,
    TrainAlertsResponse,
    InferAlertsRequest,
    InferAlertsResponse,
} from './types';
import { createLogger } from '../lib/logger';
import { config } from '../config';

const logger = createLogger('bayesian-client');

const DEFAULT_TIMEOUT_MS = 30_000;

export class BayesianClient {
    private baseUrl: string;
    private timeoutMs: number;
    private available: boolean | null = null;
    private lastHealthCheck = 0;
    private healthCheckIntervalMs = 30_000;

    constructor(baseUrl?: string, timeoutMs?: number) {
        this.baseUrl = baseUrl ?? config?.bayesianService?.url ?? 'http://localhost:8100';
        this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * Check if the Bayesian service is reachable.
     * Caches result for 30 seconds to avoid spamming.
     */
    async isAvailable(): Promise<boolean> {
        const now = Date.now();
        if (this.available !== null && now - this.lastHealthCheck < this.healthCheckIntervalMs) {
            return this.available;
        }

        try {
            const resp = await this.health();
            this.available = resp.status === 'healthy';
        } catch {
            this.available = false;
        }
        this.lastHealthCheck = now;
        return this.available;
    }

    /**
     * GET /health
     */
    async health(): Promise<BayesianHealthResponse> {
        return this.request<BayesianHealthResponse>('GET', '/health');
    }

    /**
     * POST /train — Fit model to historical features
     */
    async train(data: TrainRequest): Promise<TrainResponse> {
        return this.request<TrainResponse>('POST', '/train', data);
    }

    /**
     * POST /infer — Get anomaly probabilities and root causes
     */
    async infer(data: InferRequest): Promise<InferResponse> {
        return this.request<InferResponse>('POST', '/infer', data);
    }

    /**
     * POST /train-alerts — Train alert correlation model from historical incidents
     */
    async trainAlerts(data: TrainAlertsRequest): Promise<TrainAlertsResponse> {
        return this.request<TrainAlertsResponse>('POST', '/train-alerts', data);
    }

    /**
     * POST /infer-alerts — Get root cause ranking for currently-firing alerts
     */
    async inferAlerts(data: InferAlertsRequest): Promise<InferAlertsResponse> {
        return this.request<InferAlertsResponse>('POST', '/infer-alerts', data);
    }

    /**
     * GET /alert-rca — Get latest autonomous alert RCA result
     */
    async getAlertRCA(): Promise<unknown> {
        return this.request<unknown>('GET', '/alert-rca');
    }

    // ─── Internal ───────────────────────────────────────────────────────

    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const init: RequestInit = {
                method,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
            };

            if (body !== undefined) {
                init.body = JSON.stringify(body);
            }

            const response = await fetch(url, init);

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(
                    `Bayesian service returned ${response.status}: ${text.slice(0, 200)}`
                );
            }

            return (await response.json()) as T;
        } catch (error: unknown) {
            // Mark unavailable on connection errors
            if (error instanceof Error) {
                const cause = 'cause' in error ? (error.cause as { code?: string }) : undefined;
                if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND') {
                    this.available = false;
                    this.lastHealthCheck = Date.now();
                }
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Singleton instance */
export const bayesianClient = new BayesianClient();
