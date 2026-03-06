// Clean API Routes - Crypto Exchange
// Multi-user with BTC transfers

import type { Express } from "express";
import { Request, Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { orderService, getPrice } from "../core/order-service";
import { insertOrderSchema, insertTransferSchema } from "@shared/schema";
import { traces } from "../otel";
import { createLogger } from "../lib/logger";
import { getErrorMessage, InsufficientFundsError, OrderError } from "../lib/errors";
import db from "../db";
import authRoutes from "./auth-routes";
import twoFactorRoutes from "./2fa-routes";
import { validateUUID } from "../middleware/uuid-validation";
import { tradingHealthCheck } from "../middleware/health-check";
import { priceService } from '../services/price-service';
import { binanceFeed } from '../services/binance-feed';

const logger = createLogger('api-routes');

export function registerRoutes(app: Express) {
  logger.info('Registering API routes');

  // Register auth routes (profile, sessions, password management)
  app.use('/api/v1/auth', authRoutes);

  // Register 2FA routes
  app.use('/api/v1/auth/2fa', twoFactorRoutes);

  // Health check for trading services
  app.get('/api/v1/health/trading', tradingHealthCheck);

  // ============================================
  // ADMIN ENDPOINTS
  // ============================================

  // Reconnect price feed (Binance WebSocket)
  app.post('/api/v1/admin/price-feed/reconnect', async (req: Request, res: Response) => {
    try {
      binanceFeed.reconnect();
      logger.info('Admin triggered price feed reconnect');
      res.json({
        success: true,
        message: 'Price feed reconnect initiated',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to reconnect price feed');
      res.status(500).json({ error: 'Failed to reconnect price feed' });
    }
  });

  // Get price feed status
  app.get('/api/v1/admin/price-feed/status', async (req: Request, res: Response) => {
    try {
      const feedStatus = binanceFeed.getStatus();
      const priceStatus = priceService.getStatus();

      res.json({
        binanceFeed: feedStatus,
        priceService: priceStatus,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get price feed status' });
    }
  });

  // ============================================

  // Get all verified users (for transfers)
  app.get("/api/v1/users", async (req: Request, res: Response) => {
    try {
      // Get real users from database with their wallet addresses
      const result = await db.query(
        `SELECT u.id, u.email, u.status, w.address as wallet_address
         FROM users u
         LEFT JOIN wallets w ON u.id = w.user_id AND w.asset = 'BTC'
         WHERE u.status = 'verified'
         ORDER BY u.created_at DESC LIMIT 50`
      );

      // Map to expected format for transfer form
      const users = result.rows.map(user => ({
        id: user.id,
        name: user.email.split('@')[0], // Use username part of email
        email: user.email,
        avatar: '👤',
        walletAddress: user.wallet_address
      }));

      res.json(users);
    } catch (error: unknown) {
      logger.error({ error: getErrorMessage(error) }, 'Failed to fetch users');
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // ============================================
  // WALLET & PRICE ENDPOINTS
  // ============================================

  // Get current BTC price (real from Binance)
  app.get("/api/v1/price", async (req: Request, res: Response) => {
    try {
      // Try to get real BTC price from Binance
      const btcPrice = priceService.getPrice('BTC');
      const ethPrice = priceService.getPrice('ETH');
      const status = priceService.getStatus();

      if (btcPrice) {
        // Return real Binance price
        res.json({
          pair: "BTC/USD",
          price: btcPrice.price,
          BTC: btcPrice.price,
          ETH: ethPrice?.price || 0,
          change24h: 0, // Binance mini ticker doesn't include 24h change
          timestamp: btcPrice.timestamp,
          source: btcPrice.source,
          connected: status.connected
        });
      } else {
        // No price available - do NOT return fake prices
        res.json({
          pair: "BTC/USD",
          price: null,
          BTC: null,
          ETH: null,
          change24h: 0,
          timestamp: new Date(),
          source: 'none',
          connected: false,
          available: false,
          message: 'Waiting for pricing feed...'
        });
      }
    } catch (error: unknown) {
      logger.error({ err: error }, 'Price endpoint error');
      res.status(500).json({ error: "Failed to fetch price" });
    }
  });

  // Get wallet balance for a user - requires explicit userId
  app.get("/api/v1/wallet", async (req: Request, res: Response) => {
    try {
      const userId = req.query.userId as string;
      if (!userId) {
        return res.status(400).json({ error: "userId query parameter is required" });
      }
      const wallet = await orderService.getWallet(userId);
      if (!wallet) {
        return res.status(404).json({ error: "User not found" });
      }
      const price = getPrice();
      res.json({
        ...wallet,
        btcValue: wallet.btc * price,
        totalValue: wallet.usd + (wallet.btc * price)
      });
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to fetch wallet" });
    }
  });

  // NOTE: /api/v1/wallet/* routes are handled by walletRoutes (server/wallet/routes.ts)
  // Do NOT add /api/v1/wallet/:userId here as it conflicts with /api/v1/wallet/balances

  // ============================================
  // ORDER ENDPOINTS
  // ============================================

  // Submit trade order - NOW WITH UUID VALIDATION
  app.post("/api/v1/orders", validateUUID('userId'), async (req: Request, res: Response) => {
    // CRITICAL: Explicitly extract trace context from HTTP headers
    // The HTTP auto-instrumentation may not always properly link the span
    const { propagation, context, trace } = await import('@opentelemetry/api');

    // Extract trace context from incoming request headers
    const extractedContext = propagation.extract(context.active(), req.headers);
    const extractedSpan = trace.getSpan(extractedContext);

    logger.debug({
      hasExtractedSpan: !!extractedSpan,
      extractedTraceId: extractedSpan?.spanContext().traceId,
      incomingTraceparent: req.headers['traceparent'],
    }, 'Trace context extraction for order request');

    // Execute the entire order processing within the extracted context
    return context.with(extractedContext, async () => {
      try {
        // Extend schema to include userId
        const orderWithUserSchema = insertOrderSchema.extend({
          userId: z.string() // Make it required now
        });

        const validation = orderWithUserSchema.safeParse(req.body);
        if (!validation.success) {
          return res.status(400).json({
            error: "Invalid order request",
            details: fromZodError(validation.error).message
          });
        }

        const orderData = validation.data;

        if (!orderData.userId) {
          return res.status(400).json({ error: "userId is required" });
        }

        const result = await orderService.submitOrder({
          userId: orderData.userId,
          pair: orderData.pair,
          side: orderData.side,
          quantity: orderData.quantity,
          orderType: orderData.orderType
        });

        const wallet = await orderService.getWallet(orderData.userId);

        // Return 201 Created for successful order submission
        return res.status(201).json({
          success: true,
          orderId: result.orderId,
          order: {
            orderId: result.orderId,
            pair: orderData.pair,
            side: orderData.side,
            quantity: orderData.quantity
          },
          execution: result.execution,
          wallet,
          traceId: result.traceId,
          spanId: result.spanId
        });

      } catch (error: unknown) {
        // Handle semantic errors with proper HTTP status codes
        if (error instanceof InsufficientFundsError) {
          return res.status(422).json({
            error: error.message,
            code: 'INSUFFICIENT_FUNDS',
            details: error.details
          });
        }

        if (error instanceof OrderError) {
          // Check if it's a service unavailable error
          if (error.message.includes('unavailable')) {
            return res.status(503).json({
              error: error.message,
              code: 'SERVICE_UNAVAILABLE'
            });
          }
          return res.status(422).json({
            error: error.message,
            code: 'ORDER_ERROR'
          });
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error }, 'Order processing failed');
        return res.status(500).json({ error: "Failed to process order", details: errorMessage });
      }
    });
  });

  // Get orders (filtered by userId if provided)
  app.get("/api/v1/orders", async (req: Request, res: Response) => {
    try {
      const userId = req.query.userId as string | undefined;
      const orders = await orderService.getOrders(10, userId);
      res.json(orders);
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // ============================================
  // TRANSFER ENDPOINTS
  // ============================================

  // Transfer BTC between users
  app.post("/api/v1/transfer", async (req: Request, res: Response) => {
    try {
      const incomingTraceparent = req.headers['traceparent'];
      if (incomingTraceparent) {
        logger.debug({ traceparent: incomingTraceparent }, 'Incoming trace context for transfer');
      }

      const validation = insertTransferSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: "Invalid transfer request",
          details: fromZodError(validation.error).message
        });
      }

      const transferData = validation.data;

      // fromUserId and toUserId are optional - provide defaults if needed
      const fromUserId = transferData.fromUserId || 'unknown';
      const toUserId = transferData.toUserId || 'unknown';

      const result = await orderService.processTransfer({
        fromUserId,
        toUserId,
        amount: transferData.amount
      });

      // Get updated wallets
      const fromWallet = await orderService.getWallet(fromUserId);
      const toWallet = await orderService.getWallet(toUserId);

      res.json({
        success: result.status === 'COMPLETED',
        transferId: result.transferId,
        transfer: result.transfer,
        status: result.status,
        message: result.message,
        wallets: {
          [fromUserId]: fromWallet,
          [toUserId]: toWallet
        },
        traceId: result.traceId,
        spanId: result.spanId
      });

    } catch (error: unknown) {
      logger.error({ err: error }, 'Transfer processing failed');
      res.status(500).json({ error: "Failed to process transfer" });
    }
  });

  // Get transfers (filtered by userId if provided)
  app.get("/api/v1/transfers", async (req: Request, res: Response) => {
    try {
      const userId = req.query.userId as string | undefined;
      const transfers = await orderService.getTransfers(10, userId);
      res.json(transfers);
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to fetch transfers" });
    }
  });

  // ============================================
  // LEGACY PAYMENT ROUTES (backwards compat) - requires userId
  // ============================================

  app.post("/api/v1/payments", async (req: Request, res: Response) => {
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const price = getPrice();
    const orderRequest = {
      userId,
      pair: "BTC/USD" as const,
      side: "BUY" as const,
      quantity: (req.body.amount || 100) / price,
      orderType: "MARKET" as const
    };

    try {
      const result = await orderService.submitOrder(orderRequest);
      const wallet = await orderService.getWallet(userId);

      res.status(201).json({
        success: true,
        payment: {
          id: result.orderId,
          amount: req.body.amount || 100,
          currency: "USD",
          status: result.execution?.status || "PENDING",
          wallet
        },
        traceId: result.traceId,
        processorResponse: result.execution ? {
          status: result.execution.status,
          processedAt: result.execution.processedAt,
          processorId: result.execution.processorId
        } : undefined
      });
    } catch (error: unknown) {
      if (error instanceof InsufficientFundsError) {
        return res.status(422).json({
          error: error.message,
          code: 'INSUFFICIENT_FUNDS',
          details: error.details
        });
      }

      if (error instanceof OrderError) {
        if (error.message.includes('unavailable')) {
          return res.status(503).json({
            error: error.message,
            code: 'SERVICE_UNAVAILABLE'
          });
        }
        return res.status(422).json({
          error: error.message,
          code: 'ORDER_ERROR'
        });
      }

      res.status(500).json({ error: "Failed to process payment" });
    }
  });

  app.get("/api/v1/payments", async (req: Request, res: Response) => {
    try {
      const orders = await orderService.getOrders(10);
      res.json(orders);
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to fetch payments" });
    }
  });

  // ============================================
  // TRACES ENDPOINT (for UI)
  // ============================================

  app.get("/api/v1/traces", async (req: Request, res: Response) => {
    try {
      const userId = req.query.userId as string | undefined;
      const traceGroups = new Map<string, any[]>();

      // If userId provided, get the user's order traceIds to filter
      let userTraceIds: Set<string> | null = null;
      if (userId) {
        const userOrders = await orderService.getOrders(100, userId);
        userTraceIds = new Set(userOrders.map(o => o.traceId).filter(Boolean));
      }

      traces.forEach(span => {
        const traceId = span.traceId;
        // If filtering by user, skip traces that don't belong to user's orders
        if (userTraceIds && !userTraceIds.has(traceId)) return;
        if (!traceGroups.has(traceId)) {
          traceGroups.set(traceId, []);
        }
        traceGroups.get(traceId)?.push(span);
      });

      const formattedTraces = Array.from(traceGroups.entries()).map(([traceId, spans]) => {
        const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
        return {
          traceId,
          rootSpanId: rootSpan?.spanId || spans[0]?.spanId,
          status: 'completed',
          duration: Math.max(...spans.map(s => s.duration || 0)),
          startTime: new Date(Math.min(...spans.map(s => new Date(s.startTime).getTime()))),
          spans: spans.map(span => ({
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            traceId: span.traceId,
            operationName: getOperationName(span),
            serviceName: getServiceName(span),
            duration: span.duration,
            startTime: span.startTime,
            endTime: span.endTime,
            tags: span.attributes || {},
            status: 'completed'
          }))
        };
      });

      formattedTraces.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
      res.json(formattedTraces.slice(0, 10));
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to fetch traces" });
    }
  });

  // Clear all data
  app.delete("/api/v1/clear", async (req: Request, res: Response) => {
    try {
      const { clearTraces } = await import('../otel');
      await orderService.clearAllData();
      clearTraces();
      res.json({ success: true, message: "All data cleared" });
    } catch (error: unknown) {
      res.status(500).json({ error: "Failed to clear data" });
    }
  });
}

// Helper functions
function getOperationName(span: any): string {
  const httpMethod = span.attributes?.['http.method'];
  const httpTarget = span.attributes?.['http.target'];
  const messagingOperation = span.attributes?.['messaging.operation'];
  const messagingSystem = span.attributes?.['messaging.system'];

  if (messagingSystem === 'rabbitmq') {
    return messagingOperation === 'publish' ? 'order.submit' : 'order.match';
  }

  if (httpMethod && httpTarget) {
    if (httpTarget.includes('/orders')) return 'order.submit';
    if (httpTarget.includes('/transfer')) return 'btc.transfer';
    return `${httpMethod.toLowerCase()}.${httpTarget.replace('/api/', '')}`;
  }

  return span.name || 'unknown';
}

function getServiceName(span: any): string {
  const serviceName = span.serviceName || span.attributes?.['service.name'];
  const httpUrl = span.attributes?.['http.url'];
  const messagingSystem = span.attributes?.['messaging.system'];

  if (messagingSystem === 'rabbitmq') return 'rabbitmq';
  if (httpUrl?.includes(':8000')) return 'kong-gateway';
  return serviceName || 'kx-exchange';
}