/**
 * Bayesian Inference Orchestrator
 *
 * End-to-end workflow:
 *   1. Pull traces from existing pipeline (Jaeger + TraceProfiler)
 *   2. Extract features (service metrics, dependency graph, time windows)
 *   3. Call Bayesian service (/train or /infer)
 *   4. Return structured probabilistic insights
 *
 * Designed to run periodically or on-demand from the monitor module.
 */

import { bayesianClient } from './client';
import { extractFeatures, extractFeaturesFromBaselines } from './feature-extractor';
import type {
    BayesianInsight,
    InferResponse,
    ServiceInference,
    TrainResponse,
} from './types';
import { createLogger } from '../lib/logger';

const logger = createLogger('bayesian-inference');

const TRAIN_INTERVAL_MS = 15 * 60 * 1000; // Retrain every 15 minutes

export class BayesianInference {
    private lastTrainTime = 0;
    private lastInsights: BayesianInsight[] = [];
    private inferenceInterval: NodeJS.Timeout | null = null;
    private isRunning = false;

    /**
     * Start periodic inference loop.
     * Trains model on startup, then runs inference every cycle.
     */
    async start(intervalMs = 60_000): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;

        logger.info('Starting Bayesian inference engine');

        // Initial train + infer
        await this.runCycle();

        this.inferenceInterval = setInterval(() => {
            this.runCycle().catch(err =>
                logger.error({ err }, 'Bayesian inference cycle failed')
            );
        }, intervalMs);
    }

    /**
     * Stop the inference loop.
     */
    stop(): void {
        if (this.inferenceInterval) {
            clearInterval(this.inferenceInterval);
            this.inferenceInterval = null;
        }
        this.isRunning = false;
        logger.info('Bayesian inference engine stopped');
    }

    /**
     * Get the latest inference results.
     */
    getLatestInsights(): BayesianInsight[] {
        return this.lastInsights;
    }

    /**
     * Run a full cycle: optionally retrain, then infer.
     */
    async runCycle(): Promise<BayesianInsight[]> {
        const available = await bayesianClient.isAvailable();
        if (!available) {
            logger.debug('Bayesian service not available, skipping cycle');
            return this.lastInsights;
        }

        try {
            // Retrain if needed
            const now = Date.now();
            if (now - this.lastTrainTime > TRAIN_INTERVAL_MS) {
                await this.train();
                this.lastTrainTime = now;
            }

            // Run inference
            return await this.infer();
        } catch (err) {
            logger.warn({ err }, 'Bayesian inference cycle error');
            return this.lastInsights;
        }
    }

    /**
     * Train the model with full feature extraction (Jaeger fetch + graph).
     */
    async train(): Promise<TrainResponse> {
        logger.info('Training Bayesian model...');

        const features = await extractFeatures();

        const response = await bayesianClient.train({
            services: features.services,
            dependency_graph: features.dependency_graph,
            spans: features.spans,
        });

        logger.info({
            servicesModeled: response.services_modeled.length,
            samplesUsed: response.samples_used,
        }, 'Bayesian model trained');

        return response;
    }

    /**
     * Run inference with current observations.
     * Uses baselines for fast path when possible.
     */
    async infer(): Promise<BayesianInsight[]> {
        // Full extraction for inference (includes time windows for trend detection)
        const features = await extractFeatures();

        const response = await bayesianClient.infer({
            services: features.services,
            dependency_graph: features.dependency_graph,
            time_windows: features.time_windows,
        });

        this.lastInsights = response.results.map(toInsight);

        logger.info({
            resultsCount: response.results.length,
            inferenceTimeMs: response.inference_time_ms,
            modelTrained: response.model_trained,
        }, 'Bayesian inference complete');

        return this.lastInsights;
    }

    /**
     * Quick inference using only cached baselines (no Jaeger fetch).
     * Useful for real-time queries where latency matters.
     */
    async inferFast(): Promise<BayesianInsight[]> {
        const available = await bayesianClient.isAvailable();
        if (!available) return this.lastInsights;

        const { services, dependency_graph } = extractFeaturesFromBaselines();

        const response = await bayesianClient.infer({
            services,
            dependency_graph,
        });

        this.lastInsights = response.results.map(toInsight);
        return this.lastInsights;
    }
}

function toInsight(result: ServiceInference): BayesianInsight {
    return {
        service: result.service,
        latency_anomaly_probability: result.latency_anomaly_probability,
        error_anomaly_probability: result.error_anomaly_probability,
        likely_root_causes: result.likely_root_causes,
        confidence: result.confidence,
        timestamp: new Date(),
    };
}

/** Singleton instance */
export const bayesianInference = new BayesianInference();
