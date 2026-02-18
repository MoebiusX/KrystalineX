// Initialize OpenTelemetry first
import "./otel";

// Initialize configuration and logging
import { config } from "./config";
import { createLogger } from "./lib/logger";
import { requestLogger } from "./middleware/request-logger";
import { errorHandler, notFoundHandler, handleUnhandledRejection, handleUncaughtException } from "./middleware/error-handler";
import {
  generalRateLimiter,
  authRateLimiter,
  securityHeaders,
  corsMiddleware,
  requestTimeout
} from "./middleware/security";

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./api/routes";
// Note: ./vite is only imported dynamically in development mode
// to avoid requiring vite package in production
import { kongClient } from "./services/kong-client";
import { rabbitMQClient } from "./services/rabbitmq-client";
import { monitorRoutes, startMonitor } from "./monitor";
import { metricsMiddleware, registerMetricsEndpoint } from "./metrics/prometheus";
import { transparencyService } from "./services/transparency-service";
import authRoutes from "./auth/routes";
import walletRoutes from "./wallet/routes";
import tradeRoutes from "./trade/routes";
import publicRoutes from "./api/public-routes";
import healthRoutes from "./api/health-routes";
import { binanceFeed } from "./services/binance-feed";

const logger = createLogger('server');
const app = express();

// Setup global error handlers for unhandled errors
handleUnhandledRejection();
handleUncaughtException();

// Register Prometheus metrics endpoint FIRST (before other middleware)
registerMetricsEndpoint(app);

// Health check routes (no rate limiting, no auth - for load balancers)
app.use(healthRoutes);

// Security headers (helmet)
app.use(securityHeaders);

// Apply rate limiting to all API routes (v1)
app.use('/api/v1', generalRateLimiter);

// Apply metrics collection middleware
app.use(metricsMiddleware);

// Request timeout (30 seconds)
app.use(requestTimeout(30000));

// Request logging with correlation IDs (early in middleware chain)
app.use(requestLogger);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// CORS configuration (environment-aware)
app.use(corsMiddleware);

(async () => {
  // Initialize PostgreSQL storage FIRST (before any routes use it)
  const { initializeStorage } = await import('./storage');
  await initializeStorage();

  // Initialize external services
  logger.info('Initializing external services...');

  // Setup Kong Gateway proxy routes with OTEL span attribute middleware
  app.use('/kong', async (req, res, next) => {
    // Mark this span as api-gateway component for proper service identification
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute('component', 'api-gateway');
    }
    next();
  }, kongClient.createProxy());

  // Initialize RabbitMQ connection
  try {
    await rabbitMQClient.connect();
    await rabbitMQClient.startConsumer();
    logger.info('RabbitMQ connected and consumer started');
  } catch (error) {
    logger.warn({ error }, 'RabbitMQ initialization failed - continuing without message queue');
  }

  // Start real-time price feed (Binance public WebSocket - no API key needed)
  try {
    binanceFeed.start();
    logger.info('Binance price feed started - real-time prices enabled');
  } catch (error) {
    logger.warn({ error }, 'Binance price feed failed to start - trading will show prices unavailable');
  }

  // Check Kong Gateway health
  const kongHealthy = await kongClient.checkHealth();
  if (kongHealthy) {
    logger.info('Kong Gateway available');
    await kongClient.configureService();
  } else {
    logger.warn('Kong Gateway not available - continuing without proxy');
  }

  // Clear all sessions on server restart (invalidate cached tokens)
  const { authService } = await import('./auth/auth-service');
  await authService.clearAllSessions();

  // Register API routes
  registerRoutes(app);

  // Register auth routes (with stricter rate limiting)
  app.use('/api/v1/auth', authRateLimiter, authRoutes);

  // Register wallet routes
  app.use('/api/v1/wallet', walletRoutes);

  // Register trade routes
  app.use('/api/v1/trade', tradeRoutes);

  // Register monitor routes (versioned + backward-compatible alias)
  app.use('/api/v1/monitor', monitorRoutes);
  app.use('/api/monitor', monitorRoutes);

  // Register public transparency routes (unauthenticated)
  app.use('/api/v1/public', publicRoutes);

  // Start trace monitoring services (polls Jaeger for baselines/anomalies)
  startMonitor();

  // Start transparency service for public metrics
  transparencyService.start();

  // Create server
  const { createServer } = await import("http");
  const server = createServer(app);

  // Setup WebSocket server for real-time monitoring
  const { wsServer } = await import("./monitor/ws-server");
  wsServer.setup(server);

  // Setup Vite in development or serve static in production
  // This MUST come before notFoundHandler to serve SPA routes
  if (app.get("env") === "development") {
    // Dynamic import - only loads vite package in development
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    // Production: serve static files from pre-built dist (no vite dependency)
    const { serveStatic } = await import("./static");
    serveStatic(app);
  }

  // 404 handler for undefined API routes only (after Vite serves SPA)
  app.use('/api/v1', notFoundHandler);

  // Global error handler (MUST be last)
  app.use(errorHandler);

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // Start server
  const port = config.server.port;
  const host = config.server.host;

  server.listen(port, host, () => {
    logger.info({
      port,
      host,
      env: config.env,
    }, `Server started successfully`);
    logger.info(`Serving on http://${host}:${port}`);
    logger.info(`WebSocket available at ws://localhost:${port}/ws/monitor`);
    logger.info(`Health check at http://${host}:${port}/health`);
  });

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal, closing gracefully...');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Stop monitor services
    try {
      const { stopMonitor } = await import('./monitor');
      stopMonitor();
      logger.info('Monitor services stopped');
    } catch (error) {
      logger.error({ err: error }, 'Error stopping monitor services');
    }

    // Stop Binance price feed
    try {
      binanceFeed.stop();
      logger.info('Binance price feed stopped');
    } catch (error) {
      logger.error({ err: error }, 'Error stopping Binance feed');
    }

    // Stop transparency service
    try {
      transparencyService.stop();
      logger.info('Transparency service stopped');
    } catch (error) {
      logger.error({ err: error }, 'Error stopping transparency service');
    }

    // Disconnect RabbitMQ
    try {
      await rabbitMQClient.disconnect();
      logger.info('RabbitMQ disconnected');
    } catch (error) {
      logger.error({ err: error }, 'Error disconnecting RabbitMQ');
    }

    // Close database connections
    try {
      const db = await import('./db');
      await db.default.end();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error({ err: error }, 'Error closing database');
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  // Handle termination signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();