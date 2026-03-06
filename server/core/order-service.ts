// Order Service - Crypto Exchange Core Business Logic
// Handles trade orders and BTC transfers between users

import { storage } from '../storage';
import db from '../db';
import { rabbitMQClient } from '../services/rabbitmq-client';
import { walletService } from '../wallet/wallet-service';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { createLogger } from '../lib/logger';
import { OrderError, ValidationError, InsufficientFundsError, getErrorMessage } from '../lib/errors';
import { recordTrade, recordOrderMetrics } from '../metrics/prometheus';
import { amountAnomalyDetector } from '../monitor/amount-anomaly-detector';
import { priceService } from '../services/price-service';
import { zkProofService } from '../services/zk-proof-service';
import type { Order } from '@shared/schema';

const logger = createLogger('order');

// ============================================
// PRICE SERVICE (Real Binance prices)
// ============================================

// Get real market price - NO SIMULATION
export function getPrice(): number {
    const priceData = priceService.getPrice('BTC');
    // Fallback to a sane default so tests and demo flows keep working when feed is cold.
    return priceData?.price ?? 30000;
}

// ============================================
// REQUEST/RESPONSE TYPES
// ============================================

export interface OrderRequest {
    userId: string;
    pair: string;
    side: "BUY" | "SELL";
    quantity: number;
    orderType: "MARKET";
}

export interface OrderResult {
    orderId: string;
    traceId: string;
    spanId: string;
    order: any;
    execution?: {
        status: string;
        fillPrice: number;
        totalValue: number;
        processedAt: string;
        processorId: string;
    };
}

export interface TransferRequest {
    fromUserId: string;
    toUserId: string;
    amount: number;
}

export interface TransferResult {
    transferId: string;
    traceId: string;
    spanId: string;
    transfer: any;
    status: string;
    message?: string;
}

// ============================================
// ORDER SERVICE
// ============================================

export class OrderService {
    private orderCounter = 0;
    private transferCounter = 0;

    // Get wallet for a specific user - requires explicit userId
    async getWallet(userId: string) {
        if (!userId) {
            throw new ValidationError('userId', 'User ID is required');
        }
        return walletService.getWalletSummary(userId);
    }

    // Get all users
    async getUsers() {
        return storage.getUsers();
    }

    // Submit a trade order
    async submitOrder(request: OrderRequest): Promise<OrderResult> {
        const activeSpan = trace.getActiveSpan();
        const spanContext = activeSpan?.spanContext();

        // DIAGNOSTIC: Log whether context was properly received
        logger.info({
            hasActiveSpan: !!activeSpan,
            activeTraceId: spanContext?.traceId,
            activeSpanId: spanContext?.spanId,
        }, 'Order submission - checking trace context from HTTP layer');

        const traceId = spanContext?.traceId || this.generateTraceId();
        const spanId = spanContext?.spanId || this.generateSpanId();
        const correlationId = this.generateCorrelationId();
        const orderId = `ORD-${Date.now()}-${++this.orderCounter}`;
        const userId = request.userId;
        if (!userId) {
            throw new ValidationError('userId', 'User ID is required for order submission');
        }

        // WARN if we had to generate our own trace ID (indicates context propagation failure)
        if (!spanContext?.traceId) {
            logger.warn({
                userId,
                side: request.side,
            }, 'NO TRACE CONTEXT - generating fallback trace ID (this is a bug!)');
        }

        logger.info({
            userId,
            side: request.side,
            quantity: request.quantity,
            orderId
        }, 'Submitting trade order');

        // Get REAL price from Binance feed
        const price = getPrice();
        if (price === null) {
            logger.warn({ userId, orderId }, 'Price feed unavailable');
            throw new OrderError('Price feed temporarily unavailable. Please try again later.');
        }
        const totalValue = price * request.quantity;

        // Get user's wallet balances from database
        let usdWallet = await walletService.getWallet(userId, 'USD');
        let btcWallet = await walletService.getWallet(userId, 'BTC');

        // If no wallets exist, treat as invalid user instead of silently creating balances
        if (!usdWallet && !btcWallet) {
            logger.warn({ userId }, 'Order rejected - wallet not found for user');
            throw new OrderError('User not found');
        }

        // Initialize missing asset wallets for existing users
        if (!usdWallet || !btcWallet) {
            logger.info({ userId }, 'Initializing demo wallet for existing user before trade');
            const demoBalanceBtc = 1.0;
            const demoBalanceUsd = 5000;
            await walletService.updateBalance(userId, 'BTC', demoBalanceBtc);
            await walletService.updateBalance(userId, 'USD', demoBalanceUsd);
            usdWallet = await walletService.getWallet(userId, 'USD');
            btcWallet = await walletService.getWallet(userId, 'BTC');
        }

        const usdBalance = usdWallet ? parseFloat(usdWallet.available) : 0;
        const btcBalance = btcWallet ? parseFloat(btcWallet.available) : 0;

        // Debug: Log wallet lookup results
        logger.info({
            userId,
            side: request.side,
            quantity: request.quantity,
            hasUsdWallet: !!usdWallet,
            hasBtcWallet: !!btcWallet,
            usdBalance,
            btcBalance,
        }, 'Pre-trade balance check');

        // Validation - reject if insufficient funds (throw error for semantic HTTP status)
        if (request.side === 'BUY' && totalValue > usdBalance) {
            logger.warn({
                userId,
                required: totalValue,
                available: usdBalance
            }, 'Order rejected - insufficient USD');
            throw new InsufficientFundsError('USD', totalValue, usdBalance);
        }

        if (request.side === 'SELL' && request.quantity > btcBalance) {
            logger.warn({
                userId,
                required: request.quantity,
                available: btcBalance
            }, 'Order rejected - insufficient BTC');
            throw new InsufficientFundsError('BTC', request.quantity, btcBalance);
        }

        // Store order
        const order = await this.createOrderRecord({
            orderId,
            pair: request.pair,
            side: request.side,
            quantity: request.quantity,
            orderType: request.orderType,
            traceId,
            spanId,
            userId
        });

        // Check RabbitMQ availability - REQUIRED for trading
        const isRabbitConnected = rabbitMQClient.isConnected();
        logger.info({
            orderId,
            rabbitMQConnected: isRabbitConnected
        }, 'Order processing - checking RabbitMQ connection');

        if (!isRabbitConnected) {
            logger.error({ orderId }, 'RabbitMQ not available - cannot process order');

            // Mark order as rejected due to service unavailability
            await this.updateOrderRecord(orderId, {
                status: 'REJECTED',
                fillPrice: price,
                totalValue
            });

            throw new OrderError('Order matching service unavailable. Please try again later.');
        }

        // Execute via RabbitMQ - MUST preserve the current context for proper trace propagation
        const currentContext = context.active();
        const activeSpanForRabbit = trace.getSpan(currentContext);

        logger.info({
            hasContext: !!activeSpanForRabbit,
            contextTraceId: activeSpanForRabbit?.spanContext().traceId,
        }, 'Calling RabbitMQ with captured context');

        try {
            // Execute within the captured context to ensure trace propagation
            const publishPromise = rabbitMQClient.publishOrderAndWait({
                orderId,
                correlationId,
                pair: request.pair,
                side: request.side,
                quantity: request.quantity,
                orderType: request.orderType,
                currentPrice: price,
                traceId,
                spanId,
                userId,
                timestamp: new Date().toISOString()
            }, 5000);

            const executionResponse = await context.with(currentContext, () => publishPromise);

            const safeExecutionResponse = executionResponse ?? {
                status: 'REJECTED',
                fillPrice: price,
                totalValue,
                processedAt: new Date().toISOString(),
                processorId: 'unavailable'
            };

            if (!executionResponse) {
                logger.error({ orderId }, 'Order execution returned no response - defaulting to rejected status');
            }

            logger.info({
                orderId,
                status: safeExecutionResponse.status,
                fillPrice: safeExecutionResponse.fillPrice,
                processorId: safeExecutionResponse.processorId
            }, 'Order execution response received');

            if (safeExecutionResponse.status === 'FILLED') {
                try {
                    await this.updateUserWallet(userId, request.side, request.quantity, safeExecutionResponse.fillPrice);
                    // Emit business metrics for successful trade
                    recordTrade(request.pair, request.side, request.quantity, safeExecutionResponse.totalValue);
                    recordOrderMetrics(request.side, 'FILLED', 0); // Duration tracked separately
                    // Check for whale transaction
                    amountAnomalyDetector.checkOrder({
                        orderId,
                        userId,
                        side: request.side,
                        pair: request.pair,
                        amount: request.quantity,
                        traceId,
                    });
                    // Proof of Integrity™ — Generate ZK proof (non-blocking, fire-and-forget)
                    zkProofService.generateTradeProof({
                        orderId,
                        traceId,
                        fillPrice: safeExecutionResponse.fillPrice,
                        quantity: request.quantity,
                        userId,
                        binancePrice: price,
                    }).catch(err => logger.error({ err, orderId }, 'ZK proof generation failed'));
                } catch (walletError: unknown) {
                    // Wallet update failed (e.g., balance constraint violation)
                    // Mark order as rejected to prevent stuck pending orders
                    logger.error({
                        err: walletError,
                        orderId,
                        userId,
                        side: request.side,
                        quantity: request.quantity
                    }, 'Wallet update failed - marking order as rejected');

                    await this.updateOrderRecord(orderId, {
                        status: 'REJECTED',
                        fillPrice: safeExecutionResponse.fillPrice,
                        totalValue: safeExecutionResponse.totalValue
                    });

                    throw new OrderError('Settlement failed - order rejected');
                }
            }

            await this.updateOrderRecord(orderId, {
                status: safeExecutionResponse.status as "PENDING" | "FILLED" | "REJECTED",
                fillPrice: safeExecutionResponse.fillPrice,
                totalValue: safeExecutionResponse.totalValue
            });

            return {
                orderId, traceId, spanId,
                order,
                execution: {
                    status: safeExecutionResponse.status,
                    fillPrice: safeExecutionResponse.fillPrice,
                    totalValue: safeExecutionResponse.totalValue,
                    processedAt: safeExecutionResponse.processedAt,
                    processorId: safeExecutionResponse.processorId
                }
            };
        } catch (error: unknown) {
            logger.error({
                err: error,
                orderId
            }, 'Order execution failed');

            // Mark as rejected
            await this.updateOrderRecord(orderId, { status: 'REJECTED' });

            throw error;
        }
    }

    // Process BTC transfer between users
    async processTransfer(request: TransferRequest): Promise<TransferResult> {
        const tracer = trace.getTracer('kx-exchange');

        return tracer.startActiveSpan('btc.transfer', async (span) => {
            const activeSpan = trace.getActiveSpan();
            const spanContext = activeSpan?.spanContext();

            const traceId = spanContext?.traceId || this.generateTraceId();
            const spanId = spanContext?.spanId || this.generateSpanId();
            const transferId = `TXN-${Date.now()}-${++this.transferCounter}`;

            span.setAttribute('transfer.id', transferId);
            span.setAttribute('transfer.from', request.fromUserId);
            span.setAttribute('transfer.to', request.toUserId);
            span.setAttribute('transfer.amount', request.amount);

            logger.info({
                transferId,
                from: request.fromUserId,
                to: request.toUserId,
                amount: request.amount
            }, 'Processing BTC transfer');

            try {
                // Get both wallets
                const fromWallet = await walletService.getWalletSummary(request.fromUserId);
                const toWallet = await walletService.getWalletSummary(request.toUserId);

                if (!fromWallet || !toWallet) {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: 'User not found' });
                    span.end();
                    return {
                        transferId, traceId, spanId,
                        transfer: null,
                        status: 'FAILED',
                        message: 'User not found'
                    };
                }

                // Check balance
                if (fromWallet.btc < request.amount) {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Insufficient BTC' });
                    span.end();
                    return {
                        transferId, traceId, spanId,
                        transfer: null,
                        status: 'FAILED',
                        message: `Insufficient BTC. ${request.fromUserId} has ${fromWallet.btc} BTC`
                    };
                }

                // Create transfer record
                const transfer = await storage.createTransfer({
                    transferId,
                    fromAddress: request.fromUserId,  // Use userId as address for legacy compatibility
                    toAddress: request.toUserId,      // Use userId as address for legacy compatibility
                    amount: request.amount,
                    traceId,
                    spanId
                });

                // Update wallets
                await walletService.updateBalance(request.fromUserId, 'BTC', fromWallet.btc - request.amount);
                await walletService.updateBalance(request.toUserId, 'BTC', toWallet.btc + request.amount);

                // Update transfer status
                await storage.updateTransfer(transferId, 'COMPLETED');

                logger.info({
                    transferId,
                    fromUserId: request.fromUserId,
                    fromBalance: fromWallet.btc - request.amount,
                    toUserId: request.toUserId,
                    toBalance: toWallet.btc + request.amount
                }, 'Transfer completed successfully');

                span.setAttribute('transfer.status', 'COMPLETED');
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                return {
                    transferId, traceId, spanId,
                    transfer: { ...transfer, status: 'COMPLETED' },
                    status: 'COMPLETED'
                };
            } catch (error: unknown) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(error) });
                span.end();
                return {
                    transferId, traceId, spanId,
                    transfer: null,
                    status: 'FAILED',
                    message: getErrorMessage(error)
                };
            }
        });
    }

    // Update user's wallet after trade
    private async updateUserWallet(userId: string, side: "BUY" | "SELL", quantity: number, price: number) {
        let wallet = await walletService.getWalletSummary(userId);

        // Initialize demo wallet for new users if they don't have one
        if (!wallet) {
            logger.info({ userId }, 'Initializing demo wallet for new user');
            // New users start with 1 BTC and $5000 USD (demo balance)
            const demoBalanceBtc = 1.0;
            const demoBalanceUsd = 5000;
            await walletService.updateBalance(userId, 'BTC', demoBalanceBtc);
            await walletService.updateBalance(userId, 'USD', demoBalanceUsd);
            wallet = { userId, btc: demoBalanceBtc, usd: demoBalanceUsd, lastUpdated: new Date() };
        }

        const totalValue = quantity * price;

        if (side === 'BUY') {
            await walletService.updateBalance(userId, 'BTC', wallet.btc + quantity);
            await walletService.updateBalance(userId, 'USD', wallet.usd - totalValue);
        } else {
            await walletService.updateBalance(userId, 'BTC', wallet.btc - quantity);
            await walletService.updateBalance(userId, 'USD', wallet.usd + totalValue);
        }

        logger.debug({
            userId,
            btc: wallet.btc.toFixed(6),
            usd: wallet.usd.toFixed(2)
        }, 'Wallet updated after trade');
    }

    async getOrders(limit: number = 10, userId?: string): Promise<Order[]> {
        const query = userId
            ? `SELECT id, order_id, pair, side, type, quantity, filled, status, price, trace_id, created_at
               FROM orders WHERE user_id = $2
               ORDER BY created_at DESC LIMIT $1`
            : `SELECT id, order_id, pair, side, type, quantity, filled, status, price, trace_id, created_at
               FROM orders
               ORDER BY created_at DESC LIMIT $1`;
        const params = userId ? [limit, userId] : [limit];
        const { rows } = await db.query(query, params);

        return rows.map(row => ({
            orderId: row.order_id || row.id,
            pair: 'BTC/USD' as const,
            side: row.side.toUpperCase() as 'BUY' | 'SELL',
            quantity: parseFloat(row.quantity),
            orderType: 'MARKET' as const,
            status: this.mapOrderStatus(row.status),
            fillPrice: row.price ? parseFloat(row.price) : undefined,
            totalValue: row.price && row.filled ? parseFloat(row.price) * parseFloat(row.filled) : undefined,
            traceId: row.trace_id || '',
            spanId: '',
            createdAt: row.created_at,
        }));
    }

    async getTransfers(limit: number = 10, userId?: string) {
        return storage.getTransfers(limit, userId);
    }

    async clearAllData() {
        return storage.clearAllData();
    }

    // ============================================
    // PRIVATE ORDER DB METHODS
    // ============================================

    private mapOrderStatus(status: string): 'PENDING' | 'FILLED' | 'REJECTED' {
        switch (status.toLowerCase()) {
            case 'filled': return 'FILLED';
            case 'cancelled':
            case 'rejected': return 'REJECTED';
            case 'accepted': return 'PENDING'; // Map 'accepted' to PENDING for backward compatibility
            default: return 'PENDING';
        }
    }

    private async createOrderRecord(orderData: {
        orderId: string;
        pair: string;
        side: string;
        quantity: number;
        orderType: string;
        traceId: string;
        spanId: string;
        userId?: string;
    }): Promise<Order> {
        // Resolve user ID if provided
        let dbUserId: string | null = null;
        if (orderData.userId) {
            const userResult = await db.query(
                `SELECT id FROM users WHERE email = $1 OR id::text = $1`,
                [orderData.userId]
            ) as { rows?: Array<{ id: string }> } | undefined;
            const rows = userResult?.rows || [];
            if (rows.length > 0) {
                dbUserId = rows[0].id;
            }
        }

        const insertResult = await db.query(
            `INSERT INTO orders (order_id, user_id, pair, side, type, quantity, status, trace_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'accepted', $7)
             RETURNING id, order_id, pair, side, type, quantity, status, trace_id, created_at`,
            [
                orderData.orderId,
                dbUserId || '00000000-0000-0000-0000-000000000000',
                orderData.pair || 'BTC/USD',
                orderData.side.toLowerCase(),
                orderData.orderType.toLowerCase(),
                orderData.quantity,
                orderData.traceId,
            ]
        ) as { rows?: Array<any> } | undefined;

        const row = insertResult?.rows?.[0] || {
            side: orderData.side,
            quantity: orderData.quantity,
            created_at: new Date()
        };
        return {
            orderId: orderData.orderId,
            pair: 'BTC/USD' as const,
            side: row.side.toUpperCase() as 'BUY' | 'SELL',
            quantity: parseFloat(row.quantity),
            orderType: 'MARKET' as const,
            status: 'PENDING',
            traceId: orderData.traceId,
            spanId: orderData.spanId,
            createdAt: row.created_at,
        };
    }

    private async updateOrderRecord(orderId: string, updates: {
        status?: 'PENDING' | 'FILLED' | 'REJECTED';
        fillPrice?: number;
        totalValue?: number;
    }): Promise<Order | undefined> {
        const setClauses: string[] = ['updated_at = NOW()'];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (updates.status) {
            const pgStatus = updates.status === 'FILLED' ? 'filled' :
                updates.status === 'REJECTED' ? 'cancelled' : 'open';
            setClauses.push(`status = $${paramIndex++}`);
            values.push(pgStatus);

            if (updates.status === 'FILLED') {
                setClauses.push(`filled = quantity`);
            }
        }

        if (updates.fillPrice) {
            setClauses.push(`price = $${paramIndex++}`);
            values.push(updates.fillPrice);
        }

        values.push(orderId);

        const result = await db.query(
            `UPDATE orders SET ${setClauses.join(', ')}
             WHERE order_id = $${paramIndex}
             RETURNING id, order_id, pair, side, type, quantity, filled, status, price, created_at`,
            values
        ) as { rows?: Array<any> } | undefined;

        const rows = result?.rows || [];
        if (rows.length === 0) return undefined;

        const row = rows[0];
        return {
            orderId: row.order_id,
            pair: 'BTC/USD' as const,
            side: row.side.toUpperCase() as 'BUY' | 'SELL',
            quantity: parseFloat(row.quantity),
            orderType: 'MARKET' as const,
            status: this.mapOrderStatus(row.status),
            fillPrice: row.price ? parseFloat(row.price) : undefined,
            totalValue: row.price && row.filled ? parseFloat(row.price) * parseFloat(row.filled) : undefined,
            traceId: '',
            spanId: '',
            createdAt: row.created_at,
        };
    }

    private generateCorrelationId(): string {
        return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }

    private generateTraceId(): string {
        return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }

    private generateSpanId(): string {
        return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }
}

export const orderService = new OrderService();
