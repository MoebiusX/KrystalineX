/**
 * Order Matcher Service (formerly Payment Processor)
 * 
 * A standalone microservice that:
 * 1. Consumes trade orders from the "payments" queue (legacy name kept for compat)
 * 2. Simulates order matching with price execution
 * 3. Sends execution response to the "payment_response" queue
 * 
 * Run with: npx tsx payment-processor/index.ts
 */

import * as amqp from 'amqplib';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, context, SpanStatusCode, SpanKind, propagation } from '@opentelemetry/api';
import express from 'express';
import { collectDefaultMetrics, Registry, Counter, Histogram, Gauge } from 'prom-client';

// Initialize OpenTelemetry
// Note: OTEL_EXPORTER_OTLP_ENDPOINT is base URL, we need to append /v1/traces for HTTP exporter
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const tracesUrl = otelEndpoint.endsWith('/v1/traces') ? otelEndpoint : `${otelEndpoint}/v1/traces`;

const sdk = new NodeSDK({
    serviceName: 'kx-matcher',
    traceExporter: new OTLPTraceExporter({
        url: tracesUrl
    }),
    instrumentations: [getNodeAutoInstrumentations()]
});

sdk.start();

// ============================================
// PROMETHEUS METRICS
// ============================================

const register = new Registry();
collectDefaultMetrics({ register });

// Order processing metrics
const ordersProcessedTotal = new Counter({
    name: 'kx_matcher_orders_processed_total',
    help: 'Total number of orders processed',
    labelNames: ['status', 'side'],
    registers: [register]
});

const orderProcessingDuration = new Histogram({
    name: 'kx_matcher_order_processing_duration_seconds',
    help: 'Order processing duration in seconds',
    labelNames: ['side'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register]
});

const slippageHistogram = new Histogram({
    name: 'kx_matcher_slippage_percent',
    help: 'Price slippage percentage',
    labelNames: ['side'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register]
});

const queueDepth = new Gauge({
    name: 'kx_matcher_queue_messages',
    help: 'Current messages in queue',
    labelNames: ['queue'],
    registers: [register]
});

// Initialize counters with zero values so they appear in /metrics immediately
for (const side of ['BUY', 'SELL']) {
    for (const status of ['filled', 'rejected']) {
        ordersProcessedTotal.inc({ status, side }, 0);
    }
}
queueDepth.set({ queue: 'payments' }, 0);

// Start metrics HTTP server
const metricsApp = express();
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '3001', 10);

metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

metricsApp.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'kx-matcher' });
});

metricsApp.listen(METRICS_PORT, '0.0.0.0', () => {
    console.log(`[MATCHER] Metrics server running on http://0.0.0.0:${METRICS_PORT}/metrics`);
});

// Message interfaces
interface OrderMessage {
    orderId: string;
    correlationId: string;
    pair: string;
    side: "BUY" | "SELL";
    quantity: number;
    orderType: "MARKET";
    currentPrice: number;
    traceId: string;
    spanId: string;
    timestamp: string;
    // Legacy fields (for backwards compat)
    paymentId?: number;
    amount?: number;
    currency?: string;
}

interface ExecutionResponse {
    orderId: string;
    correlationId: string;
    paymentId?: number;  // Legacy field
    status: 'FILLED' | 'REJECTED' | 'acknowledged';  // acknowledged for legacy compat
    fillPrice: number;
    totalValue: number;
    processedAt: string;
    processorId: string;
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://admin:admin123@localhost:5672';
const ORDERS_QUEUE = 'payments';  // Keep legacy queue name for compat
const RESPONSE_QUEUE = 'payment_response';  // Keep legacy queue name
const PROCESSOR_ID = `matcher-${Date.now()}`;

const tracer = trace.getTracer('kx-matcher', '1.0.0');


// Price simulation with volatility
function simulateExecution(price: number, side: string): { fillPrice: number; slippage: number } {
    // Simulate slippage: 0.01% to 0.5%
    const slippage = (Math.random() * 0.005 + 0.0001);
    const direction = side === 'BUY' ? 1 : -1;
    const fillPrice = price * (1 + (slippage * direction));
    return {
        fillPrice: Math.round(fillPrice * 100) / 100,
        slippage: Math.round(slippage * 10000) / 100
    };
}

async function main() {
    console.log(`[MATCHER] Starting Order Matcher Service (ID: ${PROCESSOR_ID})...`);

    try {
        // Connect to RabbitMQ
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();

        // Declare queues
        await channel.assertQueue(ORDERS_QUEUE, { durable: true });
        await channel.assertQueue(RESPONSE_QUEUE, { durable: true });

        console.log(`[MATCHER] Connected to RabbitMQ`);
        console.log(`[MATCHER] Listening on queue: ${ORDERS_QUEUE}`);
        console.log(`[MATCHER] Responses sent to: ${RESPONSE_QUEUE}`);

        // Consume orders
        await channel.consume(ORDERS_QUEUE, async (msg) => {
            if (!msg) return;

            // Extract trace context from message headers
            const headers = msg.properties.headers || {};

            // Extract the parent context (for order.match span)
            const parentContext = propagation.extract(context.active(), headers);

            // Also get the original POST span context (for response)
            const originalPostTraceparent = headers['x-parent-traceparent'];
            const originalPostTracestate = headers['x-parent-tracestate'];
            console.log(`[MATCHER] Original POST context: ${originalPostTraceparent?.slice(0, 40) || 'none'}...`);

            // Create processing span as child of extracted context
            const span = tracer.startSpan('order.match', {
                kind: SpanKind.CONSUMER,
                attributes: {
                    'messaging.system': 'rabbitmq',
                    'messaging.source': ORDERS_QUEUE,
                    'messaging.destination': RESPONSE_QUEUE,
                    'messaging.operation': 'process',
                    'processor.id': PROCESSOR_ID
                }
            }, parentContext);

            console.log(`[MATCHER] Created span with traceId: ${span.spanContext().traceId}`);

            // Store original POST context for response routing
            const originalContext = { traceparent: originalPostTraceparent, tracestate: originalPostTracestate };

            await context.with(trace.setSpan(parentContext, span), async () => {
                const startTime = Date.now();
                let orderSide = 'BUY';
                try {
                    const order: OrderMessage = JSON.parse(msg.content.toString());

                    // Handle both new order format and legacy payment format
                    const orderId = order.orderId || `ORD-${order.paymentId}`;
                    const pair = order.pair || 'BTC/USD';
                    const side = order.side || 'BUY';
                    orderSide = side;
                    const quantity = order.quantity || (order.amount ? order.amount / 42500 : 0.001);
                    const currentPrice = order.currentPrice || 42500;

                    console.log(`[MATCHER] Processing ${side} order: ${quantity.toFixed(8)} BTC @ ~$${currentPrice}`);

                    span.setAttributes({
                        'order.id': orderId,
                        'order.pair': pair,
                        'order.side': side,
                        'order.quantity': quantity,
                        'order.price': currentPrice
                    });

                    // Simulate order matching (validation, price lookup, execution)
                    // Random 150-800ms to model real order book matching + risk checks
                    const matchingDelay = 150 + Math.floor(Math.random() * 650);
                    await simulateProcessing(matchingDelay);

                    // Calculate execution
                    const { fillPrice, slippage } = simulateExecution(currentPrice, side);
                    const totalValue = fillPrice * quantity;

                    // Record slippage metric
                    slippageHistogram.observe({ side }, slippage);

                    console.log(`[MATCHER] Executed: ${side} ${quantity.toFixed(8)} BTC @ $${fillPrice} (slip: ${slippage}%)`);

                    // Create response
                    const response: ExecutionResponse = {
                        orderId,
                        correlationId: order.correlationId,
                        paymentId: order.paymentId,  // Legacy field
                        status: 'FILLED',
                        fillPrice,
                        totalValue,
                        processedAt: new Date().toISOString(),
                        processorId: PROCESSOR_ID
                    };

                    // Send response as CHILD of order.match span (current context)
                    // This maintains proper trace hierarchy: order.match -> order.response
                    const currentContext = context.active();
                    const responseSpan = tracer.startSpan('order.response', {
                        kind: SpanKind.PRODUCER,
                        attributes: {
                            'messaging.system': 'rabbitmq',
                            'messaging.destination': RESPONSE_QUEUE,
                            'messaging.operation': 'publish',
                            'order.id': orderId,
                            'order.status': response.status,
                            'order.fillPrice': fillPrice
                        }
                    }, currentContext);

                    // Send response with original POST context headers
                    const responseHeaders: Record<string, string> = {};
                    if (originalContext.traceparent) {
                        responseHeaders['traceparent'] = originalContext.traceparent;
                    }
                    if (originalContext.tracestate) {
                        responseHeaders['tracestate'] = originalContext.tracestate;
                    }
                    console.log(`[MATCHER] Response with POST context: ${originalContext.traceparent?.slice(0, 40) || 'none'}...`);

                    // Reply to the caller's exclusive queue if set, otherwise use shared queue
                    const replyTo = msg.properties.replyTo || RESPONSE_QUEUE;

                    channel.sendToQueue(
                        replyTo,
                        Buffer.from(JSON.stringify(response)),
                        {
                            persistent: true,
                            headers: responseHeaders
                        }
                    );

                    responseSpan.setStatus({ code: SpanStatusCode.OK });
                    responseSpan.end();

                    // Acknowledge original message
                    channel.ack(msg);

                    span.setStatus({ code: SpanStatusCode.OK });
                    console.log(`[MATCHER] Order ${orderId} filled → response sent`);

                    // Record success metrics
                    const durationSec = (Date.now() - startTime) / 1000;
                    ordersProcessedTotal.inc({ status: 'filled', side: orderSide });
                    orderProcessingDuration.observe({ side: orderSide }, durationSec);

                } catch (error: unknown) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error(`[MATCHER] Error:`, errorMessage);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
                    channel.nack(msg, false, false);

                    // Record error metric
                    ordersProcessedTotal.inc({ status: 'rejected', side: orderSide });
                } finally {
                    span.end();
                }
            });
        });

        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('[MATCHER] Shutting down...');
            await channel.close();
            await connection.close();
            await sdk.shutdown();
            process.exit(0);
        });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[MATCHER] Failed to start:', errorMessage);
        process.exit(1);
    }
}

function simulateProcessing(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main();
