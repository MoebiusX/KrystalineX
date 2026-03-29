/**
 * Monitor Module - Index
 * 
 * Exports all monitor services and starts background processes.
 */

import { createLogger } from '../lib/logger';
import { config } from '../config';

const logger = createLogger('monitor');

export { traceProfiler } from './trace-profiler';
export { anomalyDetector } from './anomaly-detector';
export { historyStore } from './history-store';
export { analysisService } from './analysis-service';
export { amountProfiler } from './amount-profiler';
export { amountAnomalyDetector } from './amount-anomaly-detector';
export { default as monitorRoutes } from './routes';
export * from './types';

import { traceProfiler } from './trace-profiler';
import { anomalyDetector } from './anomaly-detector';
import { historyStore } from './history-store';
import { amountProfiler } from './amount-profiler';
import { amountAnomalyDetector } from './amount-anomaly-detector';
import { bayesianInference } from '../bayesian';

/**
 * Start all monitor services
 */
export function startMonitor(): void {
    logger.info('Starting trace monitoring services');

    // Start history store (for auto-save)
    historyStore.start();

    // Start trace profiler (polls Jaeger every 30s)
    traceProfiler.start();

    // Start anomaly detector (checks every 10s)
    // Delay start to allow baselines to populate
    setTimeout(() => {
        anomalyDetector.start();
    }, 35000); // Start after first baseline collection

    // Start amount anomaly detection (if enabled)
    if (config.monitor.enableAmountAnomalyDetection) {
        logger.info('🐋 Amount anomaly detection (whale detection) ENABLED');
        amountProfiler.start();

        // Delay detector start to allow baselines to populate
        setTimeout(() => {
            amountAnomalyDetector.start();
        }, 65000); // Start after first amount baseline collection
    } else {
        logger.info('Amount anomaly detection is disabled (set ENABLE_AMOUNT_ANOMALY_DETECTION=true to enable)');
    }

    // Start Bayesian inference (if enabled)
    if (config.monitor.enableBayesianInference) {
        logger.info('🧠 Bayesian probabilistic inference ENABLED');
        // Delay start to allow trace profiler baselines to populate
        setTimeout(() => {
            bayesianInference.start();
        }, 70000);
    } else {
        logger.info('Bayesian inference is disabled (set ENABLE_BAYESIAN_INFERENCE=true to enable)');
    }

    logger.info('Monitor services started successfully');
}

/**
 * Stop all monitor services
 */
export function stopMonitor(): void {
    logger.info('Stopping trace monitoring services');

    anomalyDetector.stop();
    traceProfiler.stop();
    historyStore.stop();

    // Stop amount anomaly detection services
    amountAnomalyDetector.stop();
    amountProfiler.stop();

    // Stop Bayesian inference
    bayesianInference.stop();

    logger.info('Monitor services stopped');
}
