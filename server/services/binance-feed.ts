/**
 * Binance Price Feed
 *
 * Connects to Binance public WebSocket API for real-time prices.
 * No API key required - uses public market data streams.
 * Implements PriceFeedProvider for multi-provider failover.
 *
 * Docs: https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams
 */

import WebSocket from 'ws';
import { createLogger } from '../lib/logger';
import type {
  PriceFeedProvider,
  PriceUpdateCallback,
  ProviderStatus,
} from './price-feed-provider';

const logger = createLogger('binance-feed');

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

// Symbols we care about (Binance format: lowercase + usdt)
const SYMBOLS = ['btcusdt', 'ethusdt'];

// Map Binance symbols to our format
const SYMBOL_MAP: Record<string, string> = {
  btcusdt: 'BTC',
  ethusdt: 'ETH',
};

export class BinanceFeed implements PriceFeedProvider {
  readonly name = 'binance';
  readonly priority = 10; // Primary provider

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastMessageTime = Date.now();
  private onPrice: PriceUpdateCallback | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private reconnectCount = 0;

  // Tightened from 120s to 45s — feed manager handles escalation
  private readonly WATCHDOG_INTERVAL = 15_000;
  private readonly STALE_THRESHOLD = 45_000;

  start(onPrice: PriceUpdateCallback): void {
    if (this.running) {
      logger.warn('Binance feed already running');
      return;
    }

    this.onPrice = onPrice;
    this.running = true;
    this.lastMessageTime = Date.now();
    this.connect();
    this.startWatchdog();
    logger.info('Binance price feed started with watchdog');
  }

  stop(): void {
    logger.info('Stopping Binance price feed...');
    this.running = false;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('Binance price feed stopped');
  }

  reconnect(): void {
    logger.info('Force reconnecting Binance price feed...');
    this.reconnectCount++;
    const callback = this.onPrice;
    this.stop();
    setTimeout(() => {
      if (callback) {
        this.onPrice = callback;
        this.running = true;
        this.lastMessageTime = Date.now();
        this.connect();
        this.startWatchdog();
      }
    }, 1000);
  }

  getStatus(): ProviderStatus {
    return {
      name: this.name,
      health: this.isHealthy() ? 'healthy' : this.getTickAge() > this.STALE_THRESHOLD ? 'unhealthy' : 'degraded',
      connected: this.ws?.readyState === WebSocket.OPEN,
      lastTickTime: this.lastMessageTime,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
      reconnectCount: this.reconnectCount,
    };
  }

  isHealthy(): boolean {
    if (!this.running) return false;
    return this.ws?.readyState === WebSocket.OPEN && this.getTickAge() < this.STALE_THRESHOLD;
  }

  getTickAge(): number {
    return Date.now() - this.lastMessageTime;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Internal ────────────────────────────────────────────

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);

    this.watchdogTimer = setInterval(() => {
      if (!this.running) return;

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.warn('Watchdog: WebSocket not connected, reconnecting...');
        this.connect();
        return;
      }

      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      if (timeSinceLastMessage > this.STALE_THRESHOLD) {
        logger.warn(
          { staleSec: Math.round(timeSinceLastMessage / 1000) },
          'Watchdog: WebSocket stale, force reconnecting...'
        );
        if (this.ws) {
          this.ws.terminate();
          this.ws = null;
        }
        this.connect();
      }
    }, this.WATCHDOG_INTERVAL);
  }

  private connect(): void {
    if (!this.running) return;

    try {
      const streams = SYMBOLS.map(s => `${s}@miniTicker`).join('/');
      const url = `${BINANCE_WS_URL}/${streams}`;

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('Connected to Binance WebSocket');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err) {
          logger.error({ err }, 'Failed to parse Binance message');
        }
      });

      this.ws.on('close', () => {
        logger.warn('Binance WebSocket closed');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.errorCount++;
        logger.error({ err }, 'Binance WebSocket error');
      });
    } catch (err) {
      this.errorCount++;
      logger.error({ err }, 'Failed to connect to Binance');
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: any): void {
    this.lastMessageTime = Date.now();

    if (message.e === '24hrMiniTicker') {
      const symbol = message.s?.toLowerCase();
      const price = parseFloat(message.c);

      if (symbol && !isNaN(price) && SYMBOL_MAP[symbol] && this.onPrice) {
        this.tickCount++;
        this.onPrice({
          symbol: SYMBOL_MAP[symbol],
          price,
          source: this.name,
          timestamp: new Date(),
        });
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      logger.info('Attempting to reconnect to Binance...');
      this.connect();
    }, 5000);
  }
}

export const binanceFeed = new BinanceFeed();
export default binanceFeed;
