import { z } from "zod";

// ============================================
// KRYSTALINE EXCHANGE - WALLET SCHEMAS
// ============================================

// Wallet Address Format: kx1 + base32 encoded identifier
// Example: kx1qxy2kgdygjrsqtzq2n0yrf249
export const walletAddressSchema = z.string()
  .regex(/^kx1[a-z0-9]{20,40}$/, "Invalid wallet address format (must start with kx1)");

// Core Wallet - independent of user auth
export const kxWalletSchema = z.object({
  walletId: z.string(),           // Primary key: "wal_" + nanoid
  address: walletAddressSchema,    // Human-readable: kx1...
  ownerId: z.string(),             // User's UUID from auth
  label: z.string(),               // "Main Trading Wallet"
  type: z.enum(["custodial", "non-custodial"]),
  createdAt: z.date(),
});

// Wallet Balance - stored separately for each asset
export const walletBalanceSchema = z.object({
  walletId: z.string(),
  asset: z.enum(["BTC", "USD", "ETH"]),
  // Balance stored as integer in smallest unit (satoshi=8 decimals, cents=2)
  balance: z.number().int(),
  decimals: z.number().int().min(0).max(18),  // BTC=8, USD=2
  lastUpdated: z.date(),
});

// User-to-Wallet mapping (1 user can have many wallets)
export const userWalletMappingSchema = z.object({
  userId: z.string(),
  walletIds: z.array(z.string()),
  defaultWalletId: z.string(),
});

// ============================================
// CRYPTO EXCHANGE SCHEMAS
// ============================================

// Trade Order - submitted by client
export const insertOrderSchema = z.object({
  pair: z.literal("BTC/USD"),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  orderType: z.enum(["MARKET"]),
});

// Payment schema - for direct payment transfers (legacy payment form)
export const insertPaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.enum(["USD", "BTC", "ETH"]),
  recipient: z.string().email(),
  description: z.string().optional(),
});

export const orderSchema = z.object({
  orderId: z.string(),
  pair: z.literal("BTC/USD"),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number(),
  orderType: z.enum(["MARKET"]),
  status: z.enum(["PENDING", "FILLED", "REJECTED"]),
  fillPrice: z.number().optional(),
  totalValue: z.number().optional(),
  traceId: z.string(),
  spanId: z.string(),
  createdAt: z.date(),
});

// Trade Execution - returned by order matcher
export const executionSchema = z.object({
  orderId: z.string(),
  executionId: z.string(),
  pair: z.string(),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number(),
  fillPrice: z.number(),
  totalValue: z.number(),
  status: z.enum(["FILLED", "REJECTED"]),
  processorId: z.string(),
  timestamp: z.string(),
});

// Wallet Balance
export const walletSchema = z.object({
  btc: z.number(),
  usd: z.number(),
  lastUpdated: z.date(),
});

// Price Data
export const priceSchema = z.object({
  pair: z.literal("BTC/USD"),
  price: z.number(),
  change24h: z.number(),
  timestamp: z.date(),
});

// ============================================
// MULTI-USER & TRANSFER SCHEMAS
// ============================================

// User
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
});

// User Wallet (extends base wallet with userId)
export const userWalletSchema = walletSchema.extend({
  userId: z.string(),
});

// BTC Transfer between wallets (uses addresses)
export const insertTransferSchema = z.object({
  fromAddress: walletAddressSchema,  // kx1... sender address
  toAddress: walletAddressSchema,    // kx1... recipient address
  amount: z.number().positive(),
  // Legacy fields for backwards compatibility
  fromUserId: z.string().optional(),
  toUserId: z.string().optional(),
});

export const transferSchema = z.object({
  transferId: z.string(),
  fromAddress: z.string(),          // kx1... sender address
  toAddress: z.string(),            // kx1... recipient address
  fromUserId: z.string().optional(), // Legacy: owner of sender wallet
  toUserId: z.string().optional(),   // Legacy: owner of recipient wallet
  amount: z.number(),
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]),
  traceId: z.string(),
  spanId: z.string(),
  createdAt: z.date(),
});

// ============================================
// TRACE SCHEMAS (unchanged)
// ============================================

export const insertTraceSchema = z.object({
  traceId: z.string(),
  rootSpanId: z.string(),
});

export const traceSchema = z.object({
  id: z.number(),
  traceId: z.string(),
  rootSpanId: z.string(),
  status: z.string(),
  duration: z.number().nullable(),
  startTime: z.date(),
  endTime: z.date().nullable(),
});

export const insertSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  operationName: z.string(),
  serviceName: z.string(),
  status: z.string().optional(),
  duration: z.number().optional(),
  endTime: z.string().optional(),
  tags: z.string().optional(),
});

export const spanSchema = z.object({
  id: z.number(),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  operationName: z.string(),
  serviceName: z.string(),
  status: z.string(),
  duration: z.number().nullable(),
  startTime: z.date(),
  endTime: z.date().nullable(),
  tags: z.string().nullable(),
});

// ============================================
// TypeScript Types
// ============================================

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Price = z.infer<typeof priceSchema>;

// Krystaline Wallet types (new)
export type KXWallet = z.infer<typeof kxWalletSchema>;
export type WalletBalance = z.infer<typeof walletBalanceSchema>;
export type UserWalletMapping = z.infer<typeof userWalletMappingSchema>;
export type WalletAddress = z.infer<typeof walletAddressSchema>;

// Legacy wallet types (for backwards compatibility)
export type Wallet = z.infer<typeof walletSchema>;
export type UserWallet = z.infer<typeof userWalletSchema>;

// Multi-user types
export type User = z.infer<typeof userSchema>;
export type InsertTransfer = z.infer<typeof insertTransferSchema>;
export type Transfer = z.infer<typeof transferSchema>;

export type InsertTrace = z.infer<typeof insertTraceSchema>;
export type Trace = z.infer<typeof traceSchema>;
export type InsertSpan = z.infer<typeof insertSpanSchema>;
export type Span = z.infer<typeof spanSchema>;

// Legacy type alias for backwards compatibility during migration
export type Payment = Order;
export type InsertPayment = InsertOrder;

// ============================================
// TRANSPARENCY API SCHEMAS
// ============================================

// System Status - for public transparency dashboard
export const systemStatusSchema = z.object({
  status: z.enum(['operational', 'degraded', 'down']),
  timestamp: z.string(),
  uptime: z.number().min(0).max(100),
  metrics: z.object({
    tradesLast24h: z.number().int().nonnegative(),
    tradesTotal: z.number().int().nonnegative(),
    avgExecutionMs: z.number().nonnegative(),
    anomaliesDetected: z.number().int().nonnegative(),
    anomaliesResolved: z.number().int().nonnegative(),
    activeUsers: z.number().int().nonnegative(),
  }),
  services: z.object({
    api: z.enum(['operational', 'degraded', 'down']),
    exchange: z.enum(['operational', 'degraded', 'down']),
    wallets: z.enum(['operational', 'degraded', 'down']),
    monitoring: z.enum(['operational', 'degraded', 'down']),
  }),
  performance: z.object({
    p50ResponseMs: z.number().nonnegative(),
    p95ResponseMs: z.number().nonnegative(),
    p99ResponseMs: z.number().nonnegative(),
  }),
});

// Public Trade - anonymized trade for transparency feed
export const publicTradeSchema = z.object({
  tradeId: z.string(),
  traceId: z.string().optional(), // OpenTelemetry trace ID for Jaeger links
  timestamp: z.string(),
  type: z.enum(['BUY', 'SELL']),
  asset: z.string(),
  amount: z.number().positive(),
  price: z.number().nonnegative(),
  executionTimeMs: z.number().nonnegative(),
  status: z.enum(['completed', 'pending', 'failed']),
  aiVerified: z.boolean(),
});

// Transparency Metrics - trust and monitoring stats
export const transparencyMetricsSchema = z.object({
  timestamp: z.string(),
  trust: z.object({
    uptimePercentage: z.number().min(0).max(100),
    totalTradesProcessed: z.number().int().nonnegative(),
    anomalyDetectionRate: z.number().nonnegative(),
    avgResolutionTimeMs: z.number().nonnegative(),
  }),
  realtime: z.object({
    tradesPerMinute: z.number().nonnegative(),
    activeTraders: z.number().int().nonnegative(),
    currentPrice: z.number().nonnegative(),
    volume24h: z.number().nonnegative(),
  }),
  monitoring: z.object({
    tracesCollected: z.number().int().nonnegative(),
    spansAnalyzed: z.number().int().nonnegative(),
    baselinesCount: z.number().int().nonnegative(),
    lastAnomalyDetected: z.string().nullable(),
  }),
});

// Trade Trace Detail - for trace viewer
export const tradeTraceSchema = z.object({
  traceId: z.string(),
  orderId: z.string().optional(),
  timestamp: z.string(),
  duration: z.number().nonnegative(),
  status: z.string(),
  spans: z.array(z.object({
    spanId: z.string(),
    operation: z.string(),
    service: z.string(),
    duration: z.number().nonnegative(),
    status: z.string(),
  })),
});

// Database row schemas for validation
export const dbOrderRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  pair: z.string(),
  side: z.string(),
  type: z.string(),
  price: z.string().nullable(),
  quantity: z.string(),
  filled: z.string(),
  status: z.string(),
  trace_id: z.string().nullable().optional(), // OpenTelemetry trace ID
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});

export const dbTradeRowSchema = z.object({
  id: z.string(),
  buyer_order_id: z.string().nullable(),
  seller_order_id: z.string().nullable(),
  pair: z.string(),
  price: z.string(),
  quantity: z.string(),
  buyer_fee: z.string(),
  seller_fee: z.string(),
  created_at: z.union([z.date(), z.string()]),
});

// Export transparency types
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type PublicTrade = z.infer<typeof publicTradeSchema>;
export type TransparencyMetrics = z.infer<typeof transparencyMetricsSchema>;
export type TradeTrace = z.infer<typeof tradeTraceSchema>;
export type DbOrderRow = z.infer<typeof dbOrderRowSchema>;
export type DbTradeRow = z.infer<typeof dbTradeRowSchema>;

// ============================================
// ZERO-KNOWLEDGE PROOF SCHEMAS
// ============================================

// ZK Proof - generated for each filled trade
export const zkProofSchema = z.object({
  tradeId: z.string(),
  tradeHash: z.string(),              // Poseidon(fillPrice, quantity, userId, timestamp, traceId)
  proof: z.string(),                  // Groth16 proof JSON
  publicSignals: z.array(z.string()), // [tradeHash, priceLow, priceHigh]
  verificationKey: z.string(),
  circuit: z.literal('trade_integrity'),
  generatedAt: z.string(),
  provingTimeMs: z.number(),
  timestamp: z.string().optional(),   // Unix epoch ms (Phase 3)
  traceId: z.string().optional(),     // OTel trace ID (Phase 3)
});

// ZK Solvency Proof - aggregate proof of reserves
export const zkSolvencySchema = z.object({
  totalReserveCommitment: z.string(),
  assets: z.object({ btc: z.number(), usd: z.number() }),
  circuit: z.literal('solvency'),
  generatedAt: z.string(),
  nextProofAt: z.string(),
});

// ZK Stats - dashboard metrics
export const zkStatsSchema = z.object({
  totalProofsGenerated: z.number(),
  totalVerifications: z.number(),
  verificationSuccessRate: z.number(),
  avgProvingTimeMs: z.number(),
  latestProofTimestamp: z.string().nullable(),
  solvencyProofAge: z.number(),
  solvency: z.object({
    totalReserveCommitment: z.string().nullable(),
    lastGeneratedAt: z.string().nullable(),
  }),
  circuits: z.object({
    tradeIntegrity: z.object({ count: z.number(), avgMs: z.number() }),
    solvency: z.object({ count: z.number(), avgMs: z.number() }),
  }),
});

// ZK Verification Result
export const zkVerifyResultSchema = z.object({
  verified: z.boolean(),
  tradeId: z.string(),
  tradeHash: z.string(),
  proof: z.string(),
  publicSignals: z.array(z.string()),
  verifiedAt: z.string(),
  timestamp: z.string().optional(),   // Unix epoch ms (Phase 3)
  traceId: z.string().optional(),     // OTel trace ID (Phase 3)
});

// Export ZK types
export type ZKProof = z.infer<typeof zkProofSchema>;
export type ZKSolvencyProof = z.infer<typeof zkSolvencySchema>;
export type ZKStats = z.infer<typeof zkStatsSchema>;
export type ZKVerifyResult = z.infer<typeof zkVerifyResultSchema>;