/**
 * Amount Anomaly Detector
 * 
 * Detects anomalous transaction amounts (whale transactions, system failures)
 * using Z-score deviation from baselines. Designed for passive monitoring.
 * 
 * Thresholds are tuned for 6 orders of magnitude detection:
 * - SEV 5 (3σ): Large whale (~99.7th percentile)
 * - SEV 4 (4σ): Very large whale
 * - SEV 3 (5σ): Mega whale
 * - SEV 2 (6σ): System anomaly suspected
 * - SEV 1 (7σ): Critical - System failure (like Alice's $7T wallet)
 */

import type { AmountAnomaly, AmountOperationType, SeverityLevel } from './types';
import { SEVERITY_CONFIG, WHALE_THRESHOLDS } from './types';
import { amountProfiler } from './amount-profiler';
import { config } from '../config';
import { recordAnomalyDetected } from '../metrics/prometheus';
import { createLogger } from '../lib/logger';

const logger = createLogger('amount-anomaly-detector');
const ANOMALY_WINDOW = 15 * 60 * 1000; // 15 minutes - keep anomalies for this long
const MIN_SAMPLES = 20;                 // Need at least 20 samples for reliable baseline

// Approximate BTC/USD price for dollar value calculation
// In production, this would come from a price feed
const APPROX_BTC_PRICE = 90000;

export class AmountAnomalyDetector {
    private anomalies: Map<string, AmountAnomaly> = new Map();
    private isRunning = false;

    /**
     * Start the detector (just marks as running, actual detection is event-driven)
     */
    start(): void {
        if (this.isRunning) return;

        logger.info('Starting amount anomaly detector (whale detection)...');
        this.isRunning = true;
    }

    /**
     * Stop the detector
     */
    stop(): void {
        this.isRunning = false;
        logger.info('Stopped');
    }

    /**
     * Check if detector is enabled and running
     */
    isEnabled(): boolean {
        return config.monitor?.enableAmountAnomalyDetection === true && this.isRunning;
    }

    /**
     * Get active anomalies (within the window)
     */
    getActiveAnomalies(): AmountAnomaly[] {
        const now = Date.now();
        const active: AmountAnomaly[] = [];

        const entries = Array.from(this.anomalies.entries());
        for (const [id, anomaly] of entries) {
            if (now - anomaly.timestamp.getTime() < ANOMALY_WINDOW) {
                active.push(anomaly);
            } else {
                // Clean up old anomalies
                this.anomalies.delete(id);
            }
        }

        return active.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    /**
     * Get all anomalies (for history)
     */
    getAllAnomalies(): AmountAnomaly[] {
        return Array.from(this.anomalies.values());
    }

    /**
     * Check an order for amount anomalies
     * Called by order-service when orders are executed
     */
    checkOrder(params: {
        orderId: string;
        userId: string;
        side: 'BUY' | 'SELL';
        pair: string;
        amount: number;
        traceId?: string;
    }): AmountAnomaly | null {
        if (!this.isEnabled()) return null;

        const { orderId, userId, side, pair, amount, traceId } = params;
        const [baseAsset] = pair.split('/');
        const operationType: AmountOperationType = side;

        return this.checkAmount({
            id: orderId,
            referenceType: 'order',
            userId,
            operationType,
            asset: baseAsset,
            amount,
            traceId,
        });
    }

    /**
     * Check a transfer for amount anomalies
     * Called by transfer-service when transfers are executed
     */
    checkTransfer(params: {
        transferId: string;
        userId: string;
        type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER';
        asset: string;
        amount: number;
        traceId?: string;
    }): AmountAnomaly | null {
        if (!this.isEnabled()) return null;

        const { transferId, userId, type, asset, amount, traceId } = params;
        const operationType: AmountOperationType = type === 'WITHDRAWAL' ? 'WITHDRAW' : type;

        return this.checkAmount({
            id: transferId,
            referenceType: 'transfer',
            userId,
            operationType,
            asset,
            amount,
            traceId,
        });
    }

    /**
     * Core amount checking logic
     */
    private checkAmount(params: {
        id: string;
        referenceType: 'order' | 'transfer';
        userId: string;
        operationType: AmountOperationType;
        asset: string;
        amount: number;
        traceId?: string;
    }): AmountAnomaly | null {
        const { id, referenceType, userId, operationType, asset, amount, traceId } = params;

        // Get baseline for this operation type and asset
        const baseline = amountProfiler.getBaseline(operationType, asset);

        // Debug logging to diagnose whale detection
        logger.info({
            operationType,
            asset,
            amount,
            hasBaseline: !!baseline,
            sampleCount: baseline?.sampleCount ?? 0,
            mean: baseline?.mean ?? 0,
            stdDev: baseline?.stdDev ?? 0,
            minRequired: MIN_SAMPLES,
        }, '🔍 Whale check: baseline lookup');

        // Need baseline with enough samples to detect anomalies
        if (!baseline || baseline.sampleCount < MIN_SAMPLES) {
            // Still record the transaction for future baselines
            amountProfiler.recordTransaction(operationType, asset, amount);
            return null;
        }

        // Skip if stdDev is too small (avoid division issues)
        if (baseline.stdDev < 0.0001) {
            amountProfiler.recordTransaction(operationType, asset, amount);
            return null;
        }

        // Calculate Z-score (deviation from mean)
        const deviation = Math.abs(amount - baseline.mean) / baseline.stdDev;

        // Debug logging for Z-score calculation
        logger.info({
            amount,
            baselineMean: baseline.mean,
            baselineStdDev: baseline.stdDev,
            deviation: deviation.toFixed(2),
            sev5Threshold: WHALE_THRESHOLDS.sev5,
            isAnomaly: deviation >= WHALE_THRESHOLDS.sev5,
        }, '🔍 Whale check: Z-score calculation');

        // Check against whale thresholds
        if (deviation < WHALE_THRESHOLDS.sev5) {
            // Normal transaction - just record for baseline
            amountProfiler.recordTransaction(operationType, asset, amount);
            return null;
        }

        // Determine severity
        const severityInfo = this.getSeverity(deviation);
        if (!severityInfo) {
            amountProfiler.recordTransaction(operationType, asset, amount);
            return null;
        }

        // Calculate dollar value
        const dollarValue = this.calculateDollarValue(asset, amount);

        // Create anomaly
        const anomaly: AmountAnomaly = {
            id: `amount-${id}-${Date.now()}`,
            orderId: referenceType === 'order' ? id : undefined,
            transferId: referenceType === 'transfer' ? id : undefined,
            traceId,
            userId,
            operationType,
            asset,
            amount,
            dollarValue,
            expectedMean: baseline.mean,
            expectedStdDev: baseline.stdDev,
            deviation: Math.round(deviation * 100) / 100,
            severity: severityInfo.level,
            severityName: severityInfo.name,
            timestamp: new Date(),
            reason: this.generateReason(operationType, asset, amount, dollarValue, deviation, severityInfo),
        };

        // Store anomaly
        this.anomalies.set(anomaly.id, anomaly);
        recordAnomalyDetected(operationType, anomaly.severity);

        // Log the anomaly (passive monitoring)
        logger.warn({
            severity: anomaly.severity,
            severityName: anomaly.severityName,
            operationType,
            asset,
            amount,
            dollarValue: `$${dollarValue.toLocaleString()}`,
            deviation: `${anomaly.deviation}σ`,
            userId: userId.substring(0, 8) + '...',
        }, `🐋 WHALE ALERT: ${anomaly.severityName} amount anomaly detected`);

        // Record transaction for baseline (even if anomalous)
        amountProfiler.recordTransaction(operationType, asset, amount);

        return anomaly;
    }

    /**
     * Determine severity level based on deviation
     */
    private getSeverity(deviation: number): { level: SeverityLevel; name: string } | null {
        if (deviation >= WHALE_THRESHOLDS.sev1) return { level: 1, name: SEVERITY_CONFIG[1].name };
        if (deviation >= WHALE_THRESHOLDS.sev2) return { level: 2, name: SEVERITY_CONFIG[2].name };
        if (deviation >= WHALE_THRESHOLDS.sev3) return { level: 3, name: SEVERITY_CONFIG[3].name };
        if (deviation >= WHALE_THRESHOLDS.sev4) return { level: 4, name: SEVERITY_CONFIG[4].name };
        if (deviation >= WHALE_THRESHOLDS.sev5) return { level: 5, name: SEVERITY_CONFIG[5].name };
        return null;
    }

    /**
     * Calculate approximate dollar value
     */
    private calculateDollarValue(asset: string, amount: number): number {
        if (asset === 'USD' || asset === 'USDT' || asset === 'USDC') {
            return amount;
        }
        if (asset === 'BTC') {
            return amount * APPROX_BTC_PRICE;
        }
        // For other assets, return the raw amount (would need price feed)
        return amount;
    }

    /**
     * Generate human-readable reason for the anomaly
     */
    private generateReason(
        operationType: AmountOperationType,
        asset: string,
        amount: number,
        dollarValue: number,
        deviation: number,
        severityInfo: { level: SeverityLevel; name: string }
    ): string {
        const action = operationType.toLowerCase();
        const formattedAmount = asset === 'BTC'
            ? `${amount.toFixed(8)} BTC`
            : `$${amount.toLocaleString()}`;
        const formattedValue = `$${dollarValue.toLocaleString()}`;

        if (severityInfo.level <= 2) {
            return `CRITICAL: ${action} of ${formattedAmount} (${formattedValue}) is ${deviation.toFixed(1)}σ from normal - possible system failure`;
        }
        if (severityInfo.level <= 4) {
            return `Large ${action} detected: ${formattedAmount} (${formattedValue}) is ${deviation.toFixed(1)}σ from normal - whale transaction`;
        }
        return `Notable ${action}: ${formattedAmount} (${formattedValue}) is ${deviation.toFixed(1)}σ from normal`;
    }
}

// Singleton instance
export const amountAnomalyDetector = new AmountAnomalyDetector();
