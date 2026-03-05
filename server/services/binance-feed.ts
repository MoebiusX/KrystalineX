/**
 * Binance Price Feed
 * 
 * Connects to Binance public WebSocket API for real-time prices.
 * No API key required - uses public market data streams.
 * 
 * Docs: https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams
 */

import WebSocket from 'ws';
import { priceService } from './price-service';
import { createLogger } from '../lib/logger';

const logger = createLogger('binance-feed');

// Binance WebSocket endpoints
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

// Symbols we care about (Binance format: lowercase + usdt)
const SYMBOLS = ['btcusdt', 'ethusdt'];

// Map Binance symbols to our format
const SYMBOL_MAP: Record<string, string> = {
  btcusdt: 'BTC',
  ethusdt: 'ETH',
};

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let lastMessageTime = Date.now();

// Watchdog interval - checks connection every 30 seconds
const WATCHDOG_INTERVAL = 30000;
// If no data received for 2 minutes, consider connection stale
const STALE_THRESHOLD = 120000;

/**
 * Binance Price Feed Service
 */
export const binanceFeed = {
  /**
   * Start the price feed connection
   */
  start(): void {
    if (isRunning) {
      logger.warn('Binance feed already running');
      return;
    }

    isRunning = true;
    this.connect();
    this.startWatchdog();
    logger.info('Binance price feed started with watchdog');
  },

  /**
   * Stop the price feed connection
   */
  stop(): void {
    logger.info('Stopping Binance price feed...');
    isRunning = false;

    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (ws) {
      ws.close();
      ws = null;
    }

    priceService.setConnected(false, 'binance');
    logger.info('Binance price feed stopped');
  },

  /**
   * Force reconnect the price feed
   * Used by admin API to restart without pod restart
   */
  reconnect(): void {
    logger.info('Force reconnecting Binance price feed...');
    this.stop();
    // Small delay before reconnecting
    setTimeout(() => {
      isRunning = true;
      this.connect();
      this.startWatchdog();
    }, 1000);
  },

  /**
   * Get current connection status
   */
  getStatus(): { connected: boolean; running: boolean } {
    return {
      connected: ws?.readyState === WebSocket.OPEN,
      running: isRunning,
    };
  },

  /**
   * Start watchdog timer to monitor connection health
   * Auto-reconnects if connection drops
   */
  startWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
    }

    watchdogTimer = setInterval(() => {
      if (!isRunning) {
        logger.warn('Watchdog: isRunning is false, restarting...');
        isRunning = true;
        this.connect();
        return;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn('Watchdog: WebSocket not connected, reconnecting...');
        this.connect();
        return;
      }

      // Staleness check: WS appears open but no data received
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      if (timeSinceLastMessage > STALE_THRESHOLD) {
        logger.warn({ staleSec: Math.round(timeSinceLastMessage / 1000) },
          'Watchdog: WebSocket appears stale (no data received), force reconnecting...');
        if (ws) {
          ws.terminate(); // Force close (don't wait for graceful close)
          ws = null;
        }
        priceService.setConnected(false, 'binance');
        this.connect();
      }
    }, WATCHDOG_INTERVAL);

    logger.info('Watchdog timer started (30s interval, 2min staleness check)');
  },

  /**
   * Connect to Binance WebSocket
   */
  connect(): void {
    if (!isRunning) return;

    try {
      // Subscribe to mini ticker streams for all symbols
      const streams = SYMBOLS.map(s => `${s}@miniTicker`).join('/');
      const url = `${BINANCE_WS_URL}/${streams}`;

      ws = new WebSocket(url);

      ws.on('open', () => {
        logger.info('Connected to Binance WebSocket');
        priceService.setConnected(true, 'binance');
      });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err) {
          logger.error({ err }, 'Failed to parse Binance message');
        }
      });

      ws.on('close', () => {
        logger.warn('Binance WebSocket closed');
        priceService.setConnected(false, 'binance');
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'Binance WebSocket error');
        priceService.setConnected(false, 'binance');
      });

    } catch (err) {
      logger.error({ err }, 'Failed to connect to Binance');
      this.scheduleReconnect();
    }
  },

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(message: any): void {
    // Track last received message for staleness detection
    lastMessageTime = Date.now();

    // Mini ticker format: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '42000.00', ... }
    if (message.e === '24hrMiniTicker') {
      const symbol = message.s?.toLowerCase();
      const price = parseFloat(message.c);

      if (symbol && !isNaN(price) && SYMBOL_MAP[symbol]) {
        priceService.updatePrice(SYMBOL_MAP[symbol], price, 'binance');
      }
    }
  },

  /**
   * Schedule reconnection after disconnect
   */
  scheduleReconnect(): void {
    if (!isRunning) return;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    // Reconnect after 5 seconds
    reconnectTimer = setTimeout(() => {
      logger.info('Attempting to reconnect to Binance...');
      this.connect();
    }, 5000);
  },

  /**
   * Get current connection status
   */
  isConnected(): boolean {
    return ws?.readyState === WebSocket.OPEN;
  },
};

export default binanceFeed;
