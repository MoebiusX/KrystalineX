/**
 * Price Feed Provider Interface
 *
 * Abstraction layer for price data sources. Allows the system to use
 * multiple providers (Binance, CoinGecko, etc.) with automatic failover.
 */

export interface PriceUpdate {
  symbol: string;
  price: number;
  source: string;
  timestamp: Date;
}

export type PriceUpdateCallback = (update: PriceUpdate) => void;

export type ProviderHealth = 'healthy' | 'degraded' | 'unhealthy';

export interface ProviderStatus {
  name: string;
  health: ProviderHealth;
  connected: boolean;
  lastTickTime: number | null;
  tickCount: number;
  errorCount: number;
  reconnectCount: number;
}

/**
 * All price feed providers must implement this interface.
 * Enables hot-swapping and failover between providers.
 */
export interface PriceFeedProvider {
  readonly name: string;
  readonly priority: number; // lower = higher priority

  start(onPrice: PriceUpdateCallback): void;
  stop(): void;
  reconnect(): void;

  getStatus(): ProviderStatus;
  isHealthy(): boolean;

  /** Milliseconds since last price tick, or Infinity if never received */
  getTickAge(): number;
}
