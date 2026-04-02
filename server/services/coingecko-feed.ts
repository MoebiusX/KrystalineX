/**
 * CoinGecko Price Feed (REST polling)
 *
 * Secondary/fallback price provider. Uses CoinGecko's free public API
 * (no API key required) with 10-second polling. Less real-time than
 * Binance WebSocket but highly reliable as a fallback.
 *
 * Rate limit: 10-30 req/min on free tier — we poll every 10s (6/min).
 * API docs: https://docs.coingecko.com/v3.0.1/reference/simple-price
 */

import { createLogger } from '../lib/logger';
import type {
  PriceFeedProvider,
  PriceUpdateCallback,
  ProviderStatus,
} from './price-feed-provider';

const logger = createLogger('coingecko-feed');

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const POLL_INTERVAL_MS = 10_000;

// Map CoinGecko IDs to our internal symbols
const COIN_IDS: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
};
const COIN_ID_LIST = Object.keys(COIN_IDS).join(',');

export class CoinGeckoFeed implements PriceFeedProvider {
  readonly name = 'coingecko';
  readonly priority = 20; // Lower priority than Binance (10)

  private pollTimer: NodeJS.Timeout | null = null;
  private onPrice: PriceUpdateCallback | null = null;
  private running = false;
  private lastTickTime: number | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private consecutiveErrors = 0;

  start(onPrice: PriceUpdateCallback): void {
    if (this.running) return;

    this.onPrice = onPrice;
    this.running = true;
    this.consecutiveErrors = 0;

    // Fetch immediately, then poll
    this.fetchPrices();
    this.pollTimer = setInterval(() => this.fetchPrices(), POLL_INTERVAL_MS);

    logger.info('CoinGecko price feed started (10s polling)');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.onPrice = null;
    logger.info('CoinGecko price feed stopped');
  }

  reconnect(): void {
    this.stop();
    setTimeout(() => {
      if (this.onPrice) this.start(this.onPrice);
    }, 1000);
  }

  getStatus(): ProviderStatus {
    return {
      name: this.name,
      health: this.isHealthy() ? 'healthy' : this.consecutiveErrors > 3 ? 'unhealthy' : 'degraded',
      connected: this.running && this.consecutiveErrors < 5,
      lastTickTime: this.lastTickTime,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
      reconnectCount: 0,
    };
  }

  isHealthy(): boolean {
    if (!this.running) return false;
    if (this.consecutiveErrors >= 5) return false;
    // Stale if no tick in 30s (3 missed polls)
    return this.getTickAge() < 30_000;
  }

  getTickAge(): number {
    if (!this.lastTickTime) return Infinity;
    return Date.now() - this.lastTickTime;
  }

  private async fetchPrices(): Promise<void> {
    if (!this.running || !this.onPrice) return;

    try {
      const url = `${COINGECKO_API}?ids=${COIN_ID_LIST}&vs_currencies=usd`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as Record<string, { usd?: number }>;
      const now = new Date();

      for (const [coinId, priceData] of Object.entries(data)) {
        const symbol = COIN_IDS[coinId];
        if (symbol && priceData.usd) {
          this.onPrice({
            symbol,
            price: priceData.usd,
            source: this.name,
            timestamp: now,
          });
        }
      }

      this.lastTickTime = Date.now();
      this.tickCount++;
      this.consecutiveErrors = 0;
    } catch (err) {
      this.errorCount++;
      this.consecutiveErrors++;

      if (this.consecutiveErrors <= 3 || this.consecutiveErrors % 10 === 0) {
        logger.warn(
          { err, consecutiveErrors: this.consecutiveErrors },
          'CoinGecko price fetch failed'
        );
      }
    }
  }
}

export const coingeckoFeed = new CoinGeckoFeed();
