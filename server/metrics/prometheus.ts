/**
 * Prometheus Metrics Middleware
 * 
 * Exposes /metrics endpoint for Prometheus scraping and
 * collects HTTP request metrics (RED method).
 */
import { Request, Response, NextFunction, Express } from 'express';
import {
    collectDefaultMetrics,
    Registry,
    Counter,
    Histogram,
    Gauge,
} from 'prom-client';
import { trace } from '@opentelemetry/api';
import { createLogger } from '../lib/logger';

const logger = createLogger('prometheus-metrics');

// Create a custom registry with OpenMetrics format (required for exemplar support)
const register = new Registry();
(register as any).setContentType(Registry.OPENMETRICS_CONTENT_TYPE);

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({
    register,
    prefix: 'nodejs_',
});

// ============================================
// HTTP Request Metrics (RED Method)
// ============================================

// Rate: Total HTTP requests
export const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
});

// Errors: HTTP errors (4xx, 5xx)
export const httpRequestErrorsTotal = new Counter({
    name: 'http_request_errors_total',
    help: 'Total number of HTTP request errors',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
});

// Duration: Request latency histogram (with exemplar support for trace linking)
export const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
    enableExemplars: true,
});

// ============================================
// Application Metrics
// ============================================

// Active connections
export const activeConnections = new Gauge({
    name: 'http_active_connections',
    help: 'Number of active HTTP connections',
    registers: [register],
});

// Orders processed
export const ordersProcessedTotal = new Counter({
    name: 'orders_processed_total',
    help: 'Total number of orders processed',
    labelNames: ['status', 'side'],
    registers: [register],
});

// Order processing duration
export const orderProcessingDuration = new Histogram({
    name: 'order_processing_duration_seconds',
    help: 'Order processing duration in seconds',
    labelNames: ['side'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
});

// RabbitMQ queue depth (will be updated by RabbitMQ client)
export const rabbitmqQueueDepth = new Gauge({
    name: 'rabbitmq_queue_depth',
    help: 'Number of messages in RabbitMQ queue',
    labelNames: ['queue'],
    registers: [register],
});

// Anomalies detected
export const anomaliesDetectedTotal = new Counter({
    name: 'anomalies_detected_total',
    help: 'Total number of anomalies detected',
    labelNames: ['service', 'severity'],
    registers: [register],
});

// ============================================
// Circuit Breaker Metrics
// ============================================

// Circuit breaker state (0=closed, 1=open, 2=half-open)
export const circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
    labelNames: ['service'],
    registers: [register],
});

// Circuit breaker state changes
export const circuitBreakerTripsTotal = new Counter({
    name: 'circuit_breaker_trips_total',
    help: 'Total number of circuit breaker state changes',
    labelNames: ['service', 'from_state', 'to_state'],
    registers: [register],
});

// Helper to record circuit breaker state
export function recordCircuitBreakerState(service: string, state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
    const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
    circuitBreakerState.set({ service }, stateValue);
}

// Helper to record circuit breaker trip
export function recordCircuitBreakerTrip(service: string, fromState: string, toState: string): void {
    circuitBreakerTripsTotal.inc({ service, from_state: fromState, to_state: toState });
    recordCircuitBreakerState(service, toState as any);
}

// ============================================
// Business KPI Metrics
// ============================================

// Active users (users with activity in last 15 minutes)
export const activeUsersGauge = new Gauge({
    name: 'kx_active_users_current',
    help: 'Users with activity in the last 15 minutes',
    registers: [register],
});

// Login attempts counter
export const loginsTotal = new Counter({
    name: 'kx_logins_total',
    help: 'Total user login attempts',
    labelNames: ['status'],  // 'success' | 'failure'
    registers: [register],
});

// Trade volume in asset units (both pair-only and pair+side queryable)
export const tradeVolumeTotal = new Counter({
    name: 'kx_trade_volume_total',
    help: 'Total trade volume in asset units',
    labelNames: ['pair', 'side'],
    registers: [register],
});

// Trade value in USD
export const tradeValueUsdTotal = new Counter({
    name: 'kx_trade_value_usd_total',
    help: 'Total USD value of trades',
    labelNames: ['pair', 'side'],
    registers: [register],
});

// Trades count (for "trades today" - values synced from database)
export const tradesTodayGauge = new Gauge({
    name: 'kx_trades_today',
    help: 'Number of trades since midnight (user timezone)',
    labelNames: ['pair', 'side'],
    registers: [register],
});

// Trade count total (cumulative)
export const tradesTotal = new Counter({
    name: 'kx_trades_total',
    help: 'Total number of trades executed',
    labelNames: ['pair', 'side'],
    registers: [register],
});

// ============================================
// Middleware
// ============================================

/**
 * Express middleware to collect HTTP metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Skip metrics endpoint itself
    if (req.path === '/metrics') {
        next();
        return;
    }

    activeConnections.inc();
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
        activeConnections.dec();

        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1e9; // Convert to seconds

        // Get route pattern (or path if no route)
        const route = req.route?.path || req.path || 'unknown';
        const method = req.method;
        const statusCode = res.statusCode.toString();

        // Record request
        httpRequestsTotal.inc({ method, route, status_code: statusCode });

        // Record errors (4xx, 5xx)
        if (res.statusCode >= 400) {
            httpRequestErrorsTotal.inc({ method, route, status_code: statusCode });
        }

        // Record duration with trace exemplar for Grafana linking
        const span = trace.getActiveSpan();
        const traceId = span?.spanContext().traceId;
        if (traceId) {
            (httpRequestDuration as any).observe({
                labels: { method, route },
                value: durationMs,
                exemplarLabels: { traceID: traceId },
            });
        } else {
            httpRequestDuration.observe({ method, route }, durationMs);
        }
    });

    next();
}

/**
 * Register metrics endpoint with Express app
 */
export function registerMetricsEndpoint(app: Express): void {
    app.get('/metrics', async (req: Request, res: Response) => {
        try {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        } catch (error: unknown) {
            logger.error({ err: error }, 'Error generating Prometheus metrics');
            res.status(500).end('Error generating metrics');
        }
    });

    logger.info('Prometheus metrics endpoint registered at /metrics');
}

/**
 * Get the metrics registry (for custom metrics)
 */
export function getMetricsRegistry(): Registry {
    return register;
}

// Export helper to record order metrics
export function recordOrderMetrics(side: string, status: string, durationSeconds: number): void {
    ordersProcessedTotal.inc({ status, side });
    orderProcessingDuration.observe({ side }, durationSeconds);
}

// Export helper to record anomaly detection
export function recordAnomalyDetected(service: string, severity: number): void {
    anomaliesDetectedTotal.inc({ service, severity: `SEV${severity}` });
}

// ============================================
// Business KPI Helpers
// ============================================

// Record login attempt
export function recordLogin(status: 'success' | 'failure'): void {
    loginsTotal.inc({ status });
}

// Record a trade execution
export function recordTrade(pair: string, side: string, quantity: number, valueUsd: number): void {
    const normalizedSide = side.toUpperCase();
    tradeVolumeTotal.inc({ pair, side: normalizedSide }, quantity);
    tradeValueUsdTotal.inc({ pair, side: normalizedSide }, valueUsd);
    tradesTotal.inc({ pair, side: normalizedSide });
}

// Sync "trades today" gauge from database counts
export function syncTradesToday(counts: Array<{ pair: string; side: string; count: number }>): void {
    // Reset all values first
    tradesTodayGauge.reset();
    // Set current counts
    for (const { pair, side, count } of counts) {
        tradesTodayGauge.set({ pair, side: side.toUpperCase() }, count);
    }
}

// Update active users gauge
export function setActiveUsers(count: number): void {
    activeUsersGauge.set(count);
}
