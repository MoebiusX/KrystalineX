/**
 * Price Feed Manager — Multi-Provider Orchestrator
 *
 * Manages multiple price feed providers with automatic failover,
 * escalation ladder, and self-healing capabilities.
 *
 * Escalation ladder (on primary feed stale):
 *   Stage 1 (15s stale)  → Soft reconnect primary WebSocket
 *   Stage 2 (30s stale)  → Failover to secondary provider
 *   Stage 3 (45s stale)  → Reconnect ALL providers
 *   Stage 4 (60s+ stale) → K8s liveness probe fails → pod restart
 *
 * The manager always starts ALL providers. The "active" provider is
 * whichever healthy provider has the highest priority (lowest number).
 */

import { createLogger } from '../lib/logger';
import { priceService } from './price-service';
import { Gauge, Counter } from 'prom-client';
import { getMetricsRegistry } from '../metrics/prometheus';
import type {
  PriceFeedProvider,
  PriceUpdate,
  ProviderStatus,
} from './price-feed-provider';

const logger = createLogger('price-feed-manager');
const register = getMetricsRegistry();

// Prometheus metrics
const activeProviderGauge = new Gauge({
  name: 'price_feed_active_provider',
  help: 'Currently active price feed provider (1=active)',
  labelNames: ['provider'],
  registers: [register],
});

const failoverCounter = new Counter({
  name: 'price_feed_failovers_total',
  help: 'Number of provider failovers',
  labelNames: ['from', 'to'],
  registers: [register],
});

const escalationGauge = new Gauge({
  name: 'price_feed_escalation_stage',
  help: 'Current escalation stage (0=healthy, 1-4=escalating)',
  registers: [register],
});

// Escalation thresholds (ms since last tick from ANY provider)
const STAGE_1_THRESHOLD = 15_000;  // Soft reconnect primary
const STAGE_2_THRESHOLD = 30_000;  // Failover to secondary
const STAGE_3_THRESHOLD = 45_000;  // Reconnect all providers
const LIVENESS_THRESHOLD = 60_000; // K8s liveness probe will fail

const HEALTH_CHECK_INTERVAL = 5_000;

export interface FeedManagerStatus {
  activeProvider: string;
  escalationStage: number;
  lastTickAge: number;
  providers: ProviderStatus[];
  healthy: boolean;
}

class PriceFeedManager {
  private providers: PriceFeedProvider[] = [];
  private activeProvider: string = 'none';
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastGlobalTickTime: number = Date.now();
  private escalationStage = 0;
  private lastEscalationAction = 0;

  /**
   * Register a price feed provider
   */
  register(provider: PriceFeedProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
    logger.info({ provider: provider.name, priority: provider.priority }, 'Provider registered');
  }

  /**
   * Start all providers and the health check loop
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastGlobalTickTime = Date.now();

    const onPrice = (update: PriceUpdate) => this.handlePriceUpdate(update);

    for (const provider of this.providers) {
      try {
        provider.start(onPrice);
        logger.info({ provider: provider.name }, 'Provider started');
      } catch (err) {
        logger.error({ err, provider: provider.name }, 'Failed to start provider');
      }
    }

    // Set initial active provider
    this.activeProvider = this.providers[0]?.name ?? 'none';
    this.updateActiveProviderMetric();
    priceService.setConnected(true, this.activeProvider);

    // Start health check loop
    this.healthCheckTimer = setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL);

    logger.info(
      { providers: this.providers.map(p => p.name) },
      'Price feed manager started with multi-provider failover'
    );
  }

  /**
   * Stop all providers
   */
  stop(): void {
    this.running = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    for (const provider of this.providers) {
      try {
        provider.stop();
      } catch (err) {
        logger.error({ err, provider: provider.name }, 'Error stopping provider');
      }
    }

    logger.info('Price feed manager stopped');
  }

  /**
   * Force reconnect — triggers escalation stage 1 immediately
   */
  reconnect(): void {
    logger.info('Admin-triggered reconnect');
    const primary = this.providers[0];
    if (primary) {
      primary.reconnect();
    }
  }

  /**
   * Business-aware liveness: is fresh price data flowing?
   * Used by /health endpoint so K8s can restart the pod if feed is truly dead.
   */
  isFeedAlive(): boolean {
    return this.getGlobalTickAge() < LIVENESS_THRESHOLD;
  }

  /**
   * Get comprehensive status for admin/monitoring
   */
  getStatus(): FeedManagerStatus {
    const tickAge = this.getGlobalTickAge();
    return {
      activeProvider: this.activeProvider,
      escalationStage: this.escalationStage,
      lastTickAge: Math.round(tickAge),
      providers: this.providers.map(p => p.getStatus()),
      healthy: tickAge < STAGE_1_THRESHOLD,
    };
  }

  /**
   * Milliseconds since the last price tick from ANY provider
   */
  getGlobalTickAge(): number {
    return Date.now() - this.lastGlobalTickTime;
  }

  // ─── Internal ────────────────────────────────────────────

  private handlePriceUpdate(update: PriceUpdate): void {
    this.lastGlobalTickTime = Date.now();

    // Reset escalation when data flows
    if (this.escalationStage > 0) {
      logger.info(
        { provider: update.source, stage: this.escalationStage },
        'Price data resumed — escalation reset'
      );
      this.escalationStage = 0;
      escalationGauge.set(0);
    }

    // Track which provider is actively delivering data
    if (update.source !== this.activeProvider) {
      const oldProvider = this.activeProvider;
      this.activeProvider = update.source;
      this.updateActiveProviderMetric();
      priceService.setConnected(true, update.source);

      if (oldProvider !== 'none') {
        failoverCounter.inc({ from: oldProvider, to: update.source });
        logger.warn(
          { from: oldProvider, to: update.source },
          'Active provider changed (failover)'
        );
      }
    }

    // Forward to price service
    priceService.updatePrice(update.symbol, update.price, update.source);
  }

  /**
   * Periodic health check — implements the escalation ladder
   */
  private healthCheck(): void {
    if (!this.running) return;

    const tickAge = this.getGlobalTickAge();
    const now = Date.now();
    const cooldown = 10_000; // Min 10s between escalation actions

    // Stage 0: Everything healthy
    if (tickAge < STAGE_1_THRESHOLD) {
      if (this.escalationStage !== 0) {
        this.escalationStage = 0;
        escalationGauge.set(0);
      }
      return;
    }

    // Stage 1: Soft reconnect primary (15s stale)
    if (tickAge >= STAGE_1_THRESHOLD && this.escalationStage < 1) {
      this.escalationStage = 1;
      escalationGauge.set(1);

      if (now - this.lastEscalationAction > cooldown) {
        const primary = this.providers[0];
        if (primary) {
          logger.warn(
            { tickAgeSec: Math.round(tickAge / 1000), provider: primary.name },
            'Stage 1: Soft reconnect primary provider'
          );
          primary.reconnect();
          this.lastEscalationAction = now;
        }
      }
    }

    // Stage 2: Failover — ensure secondary is running (30s stale)
    if (tickAge >= STAGE_2_THRESHOLD && this.escalationStage < 2) {
      this.escalationStage = 2;
      escalationGauge.set(2);

      if (now - this.lastEscalationAction > cooldown) {
        logger.warn(
          { tickAgeSec: Math.round(tickAge / 1000) },
          'Stage 2: Attempting failover to secondary providers'
        );
        // Reconnect all secondary providers
        for (const provider of this.providers.slice(1)) {
          provider.reconnect();
        }
        this.lastEscalationAction = now;
      }
    }

    // Stage 3: Reconnect everything (45s stale)
    if (tickAge >= STAGE_3_THRESHOLD && this.escalationStage < 3) {
      this.escalationStage = 3;
      escalationGauge.set(3);

      if (now - this.lastEscalationAction > cooldown) {
        logger.error(
          { tickAgeSec: Math.round(tickAge / 1000) },
          'Stage 3: All providers stale — reconnecting everything'
        );
        for (const provider of this.providers) {
          provider.reconnect();
        }
        this.lastEscalationAction = now;
      }
    }

    // Stage 4: Nothing worked — liveness probe will fail → K8s restarts pod
    if (tickAge >= LIVENESS_THRESHOLD && this.escalationStage < 4) {
      this.escalationStage = 4;
      escalationGauge.set(4);
      priceService.setConnected(false, 'all-providers-failed');
      logger.error(
        { tickAgeSec: Math.round(tickAge / 1000) },
        'Stage 4: All providers failed — liveness probe will fail, awaiting pod restart'
      );
    }
  }

  private updateActiveProviderMetric(): void {
    for (const provider of this.providers) {
      activeProviderGauge.set({ provider: provider.name }, provider.name === this.activeProvider ? 1 : 0);
    }
  }
}

export const priceFeedManager = new PriceFeedManager();
