/**
 * PostgreSQL Storage Implementation
 * 
 * Persistent storage using PostgreSQL for Krystaline Exchange.
 * Implements IStorage interface with connection pooling and proper error handling.
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  type IStorage,
  generateWalletAddress,
  generateWalletId,
  USERS,
  SEED_WALLETS
} from '../storage';
import {
  type Order,
  type Trace,
  type InsertTrace,
  type Span,
  type InsertSpan,
  type User,
  type UserWallet,
  type Transfer,
  type KXWallet,
  type WalletBalance,
  type UserWalletMapping
} from '@shared/schema';
import { config } from '../config';
import { logger } from '../lib/logger';

// ============================================
// DATABASE CONNECTION POOL
// ============================================

const poolConfig: PoolConfig = {
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  max: config.database.maxConnections,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectionTimeoutMs,
};

let pool: Pool | null = null;

/**
 * Get or create the database connection pool
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });

    pool.on('connect', () => {
      logger.debug('New PostgreSQL connection established');
    });
  }
  return pool;
}

/**
 * Close the connection pool gracefully
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL connection pool closed');
  }
}

/**
 * Test database connectivity
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('PostgreSQL connection test successful');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error }, `PostgreSQL connection test failed: ${message}`);
    return false;
  }
}

// ============================================
// POSTGRESQL STORAGE IMPLEMENTATION
// ============================================

export class PostgresStorage implements IStorage {
  private pool: Pool;
  private initialized = false;

  constructor() {
    this.pool = getPool();
  }

  /**
   * Initialize seed data if tables are empty
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if users exist
      const { rows } = await this.pool.query('SELECT COUNT(*) as count FROM users');
      if (parseInt(rows[0].count) === 0) {
        await this.initializeSeedData();
      }
      this.initialized = true;
      logger.info('[PostgresStorage] Initialized successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, `[PostgresStorage] Initialization failed: ${message}`);
      throw error;
    }
  }

  private async initializeSeedData(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Create seed users
      for (const [name, seed] of Object.entries(SEED_WALLETS)) {
        const userId = await this.createSeedUser(client, seed.ownerId, name);

        // Create wallet for user - use randomUUID for wallet IDs (database expects UUID)
        const btcWalletId = crypto.randomUUID();
        const usdWalletId = crypto.randomUUID();

        await client.query(
          `INSERT INTO wallets (id, user_id, asset, balance, available, locked)
           VALUES ($1, $2, 'BTC', $3, $3, 0),
                  ($4, $2, 'USD', $5, $5, 0)
           ON CONFLICT DO NOTHING`,
          [
            btcWalletId,
            userId,
            name === 'primary' ? 15000000000 : 50000000,  // 1.5 or 0.5 BTC in satoshis
            usdWalletId,
            name === 'primary' ? 5000000 : 1000000,     // $50k or $10k in cents
          ]
        );
      }

      await client.query('COMMIT');
      logger.info('[PostgresStorage] Seed data initialized');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async createSeedUser(client: PoolClient, email: string, name: string): Promise<string> {
    // bcrypt hash of 'Demo1234' - standard demo password for seed users
    const passwordHash = '$2b$10$NPbWAJ.0eAlOcdmnQ.bQQe86n19kD98MKAXFuRNV7UejtQuYeqyPO';
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, $2, 'verified')
       ON CONFLICT (email) DO UPDATE SET password_hash = $2
       RETURNING id`,
      [email, passwordHash]
    );
    return rows[0].id;
  }

  // ============================================
  // USER OPERATIONS
  // ============================================

  async getUsers(): Promise<User[]> {
    // Return static seed users for now (matches MemoryStorage behavior)
    return USERS;
  }

  async getUser(userId: string): Promise<User | undefined> {
    return USERS.find(u => u.id === userId);
  }

  // ============================================
  // KRYSTALINE WALLET OPERATIONS
  // ============================================

  async getWalletByAddress(address: string): Promise<KXWallet | undefined> {
    // For kx1 addresses, we need a mapping table
    // For now, use the seed wallet lookup
    for (const seed of Object.values(SEED_WALLETS)) {
      if (seed.address === address) {
        const { rows } = await this.pool.query(
          `SELECT u.id as user_id FROM users u WHERE u.email = $1`,
          [seed.ownerId]
        );
        if (rows.length > 0) {
          return {
            walletId: seed.walletId,
            address: seed.address,
            ownerId: seed.ownerId,
            label: 'Main Wallet',
            type: 'custodial',
            createdAt: new Date(),
          };
        }
      }
    }
    return undefined;
  }

  async getWalletById(walletId: string): Promise<KXWallet | undefined> {
    const { rows } = await this.pool.query(
      `SELECT w.id, w.user_id, u.email, w.asset, w.created_at
       FROM wallets w
       JOIN users u ON w.user_id = u.id
       WHERE w.id = $1
       LIMIT 1`,
      [walletId]
    );

    if (rows.length === 0) return undefined;

    const row = rows[0];
    const seedEntry = Object.values(SEED_WALLETS).find(d => d.ownerId === row.email);

    return {
      walletId: walletId,
      address: seedEntry?.address || generateWalletAddress(row.email),
      ownerId: row.email,
      label: 'Main Wallet',
      type: 'custodial',
      createdAt: row.created_at,
    };
  }

  async getWalletsByOwner(ownerId: string): Promise<KXWallet[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT w.user_id, u.email, w.created_at
       FROM wallets w
       JOIN users u ON w.user_id = u.id
       WHERE u.email = $1`,
      [ownerId]
    );

    if (rows.length === 0) return [];

    const seedEntry = Object.values(SEED_WALLETS).find(d => d.ownerId === ownerId);

    return [{
      walletId: seedEntry?.walletId || generateWalletId(),
      address: seedEntry?.address || generateWalletAddress(ownerId),
      ownerId: ownerId,
      label: 'Main Wallet',
      type: 'custodial',
      createdAt: rows[0].created_at,
    }];
  }

  async createWallet(ownerId: string, label: string = 'Trading Wallet'): Promise<KXWallet> {
    const walletId = generateWalletId();
    const address = generateWalletAddress(`${ownerId}-${walletId}-${Date.now()}`);

    // Get or create user
    let userId: string;
    const { rows: userRows } = await this.pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [ownerId]
    );

    if (userRows.length === 0) {
      const { rows } = await this.pool.query(
        `INSERT INTO users (email, password_hash, status) VALUES ($1, 'pending', 'pending') RETURNING id`,
        [ownerId]
      );
      userId = rows[0].id;
    } else {
      userId = userRows[0].id;
    }

    // Create wallet entries for common assets
    await this.pool.query(
      `INSERT INTO wallets (id, user_id, asset, balance, available, locked)
       VALUES ($1, $2, 'BTC', 0, 0, 0),
              ($3, $2, 'USD', 0, 0, 0)`,
      [walletId + '_btc', userId, walletId + '_usd']
    );

    logger.info({ walletId, address, ownerId }, 'Created new wallet');

    return {
      walletId,
      address,
      ownerId,
      label,
      type: 'custodial',
      createdAt: new Date(),
    };
  }

  // ============================================
  // BALANCE OPERATIONS
  // ============================================

  async getBalance(walletId: string, asset: string): Promise<WalletBalance | undefined> {
    const { rows } = await this.pool.query(
      `SELECT w.id, w.balance, w.updated_at
       FROM wallets w
       JOIN users u ON w.user_id = u.id
       WHERE w.id LIKE $1 AND w.asset = $2`,
      [walletId + '%', asset]
    );

    if (rows.length === 0) return undefined;

    const decimals = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 2;

    return {
      walletId,
      asset: asset as 'BTC' | 'USD' | 'ETH',
      balance: parseInt(rows[0].balance),
      decimals,
      lastUpdated: rows[0].updated_at,
    };
  }

  async getAllBalances(walletId: string): Promise<WalletBalance[]> {
    // Look up user by wallet ID pattern
    const { rows } = await this.pool.query(
      `SELECT w.asset, w.balance, w.updated_at
       FROM wallets w
       WHERE w.id LIKE $1`,
      [walletId + '%']
    );

    return rows.map(row => ({
      walletId,
      asset: row.asset as 'BTC' | 'USD' | 'ETH',
      balance: parseInt(row.balance),
      decimals: row.asset === 'BTC' ? 8 : row.asset === 'ETH' ? 18 : 2,
      lastUpdated: row.updated_at,
    }));
  }

  async updateBalance(walletId: string, asset: string, amount: number): Promise<WalletBalance | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE wallets SET balance = $1, available = $1, updated_at = NOW()
       WHERE id LIKE $2 AND asset = $3
       RETURNING id, balance, updated_at`,
      [Math.round(amount), walletId + '%', asset]
    );

    if (rows.length === 0) return undefined;

    const decimals = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 2;

    return {
      walletId,
      asset: asset as 'BTC' | 'USD' | 'ETH',
      balance: parseInt(rows[0].balance),
      decimals,
      lastUpdated: rows[0].updated_at,
    };
  }

  // ============================================
  // USER-WALLET MAPPING
  // ============================================

  async getUserWalletMapping(userId: string): Promise<UserWalletMapping | undefined> {
    const wallets = await this.getWalletsByOwner(userId);
    if (wallets.length === 0) return undefined;

    return {
      userId,
      walletIds: wallets.map(w => w.walletId),
      defaultWalletId: wallets[0].walletId,
    };
  }

  async getDefaultWallet(userId: string): Promise<KXWallet | undefined> {
    const wallets = await this.getWalletsByOwner(userId);
    return wallets[0];
  }

  // ============================================
  // ADDRESS RESOLUTION
  // ============================================

  async resolveAddress(identifier: string): Promise<string | undefined> {
    if (identifier.startsWith('kx1')) {
      return identifier;
    }

    const wallet = await this.getDefaultWallet(identifier);
    return wallet?.address;
  }

  // ============================================
  // LEGACY WALLET OPERATIONS
  // ============================================

  async getWallet(userId: string): Promise<UserWallet | undefined> {
    const { rows } = await this.pool.query(
      `SELECT w.asset, w.balance, w.updated_at
       FROM wallets w
       JOIN users u ON w.user_id = u.id
       WHERE u.email = $1 OR u.id::text = $1`,
      [userId]
    );

    if (rows.length === 0) {
      // Check seed users - match by ownerId, email prefix, or key name (primary/secondary)
      const seedEntries = Object.entries(SEED_WALLETS);
      const matchedEntry = seedEntries.find(([key, seed]) =>
        seed.ownerId === userId ||
        seed.ownerId.split('@')[0] === userId ||
        key === userId  // Match 'primary' or 'secondary' directly
      );
      if (matchedEntry) {
        const [key, seed] = matchedEntry;
        return {
          userId,
          btc: key === 'primary' ? 1.5 : 0.5,
          usd: key === 'primary' ? 50000 : 10000,
          lastUpdated: new Date(),
        };
      }
      return undefined;
    }

    let btc = 0;
    let usd = 0;
    let lastUpdated = new Date();

    for (const row of rows) {
      if (row.asset === 'BTC') {
        btc = parseInt(row.balance) / 100000000; // Convert from satoshis
      } else if (row.asset === 'USD') {
        usd = parseInt(row.balance) / 100; // Convert from cents
      }
      lastUpdated = row.updated_at;
    }

    return { userId, btc, usd, lastUpdated };
  }

  async updateWallet(userId: string, updates: { btc?: number; usd?: number }): Promise<UserWallet | undefined> {
    const { rows: userRows } = await this.pool.query(
      `SELECT id FROM users WHERE email = $1 OR id::text = $1`,
      [userId]
    );

    if (userRows.length === 0) return undefined;
    const dbUserId = userRows[0].id;

    if (updates.btc !== undefined) {
      await this.pool.query(
        `UPDATE wallets SET balance = $1, available = $1, updated_at = NOW()
         WHERE user_id = $2 AND asset = 'BTC'`,
        [Math.round(updates.btc * 100000000), dbUserId]
      );
    }

    if (updates.usd !== undefined) {
      await this.pool.query(
        `UPDATE wallets SET balance = $1, available = $1, updated_at = NOW()
         WHERE user_id = $2 AND asset = 'USD'`,
        [Math.round(updates.usd * 100), dbUserId]
      );
    }

    return this.getWallet(userId);
  }

  // ============================================
  // TRANSFER OPERATIONS
  // ============================================

  async createTransfer(data: {
    transferId: string;
    fromAddress: string;
    toAddress: string;
    amount: number;
    traceId: string;
    spanId: string
  }): Promise<Transfer> {
    const fromWallet = await this.getWalletByAddress(data.fromAddress);
    const toWallet = await this.getWalletByAddress(data.toAddress);

    // Store in transactions table
    const { rows: userRows } = await this.pool.query(
      `SELECT u.id FROM users u WHERE u.email = $1`,
      [fromWallet?.ownerId || 'system']
    );

    if (userRows.length > 0) {
      const { rows: walletRows } = await this.pool.query(
        `SELECT id FROM wallets WHERE user_id = $1 AND asset = 'BTC' LIMIT 1`,
        [userRows[0].id]
      );

      if (walletRows.length > 0) {
        await this.pool.query(
          `INSERT INTO transactions (id, user_id, wallet_id, type, amount, status, reference_id, description)
           VALUES ($1, $2, $3, 'trade_sell', $4, 'pending', $5, $6)`,
          [
            data.transferId,
            userRows[0].id,
            walletRows[0].id,
            data.amount,
            data.traceId,
            `Transfer to ${data.toAddress}`,
          ]
        );
      }
    }

    return {
      transferId: data.transferId,
      fromAddress: data.fromAddress,
      toAddress: data.toAddress,
      fromUserId: fromWallet?.ownerId,
      toUserId: toWallet?.ownerId,
      amount: data.amount,
      status: 'PENDING',
      traceId: data.traceId,
      spanId: data.spanId,
      createdAt: new Date(),
    };
  }

  async getTransfers(limit: number = 10, userId?: string): Promise<Transfer[]> {
    const query = userId
      ? `SELECT t.id, t.amount, t.status, t.reference_id, t.description, t.created_at,
                u.email as from_email
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.type IN ('trade_sell', 'trade_buy') AND t.user_id = $2
         ORDER BY t.created_at DESC
         LIMIT $1`
      : `SELECT t.id, t.amount, t.status, t.reference_id, t.description, t.created_at,
                u.email as from_email
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.type IN ('trade_sell', 'trade_buy')
         ORDER BY t.created_at DESC
         LIMIT $1`;
    const params = userId ? [limit, userId] : [limit];
    const { rows } = await this.pool.query(query, params);

    return rows.map(row => ({
      transferId: row.id,
      fromAddress: '', // Would need to join with wallet mapping
      toAddress: '',
      fromUserId: row.from_email,
      toUserId: undefined,
      amount: parseFloat(row.amount),
      status: row.status.toUpperCase() as 'PENDING' | 'COMPLETED' | 'FAILED',
      traceId: row.reference_id || '',
      spanId: '',
      createdAt: row.created_at,
    }));
  }

  async updateTransfer(transferId: string, status: 'PENDING' | 'COMPLETED' | 'FAILED'): Promise<Transfer | undefined> {
    const pgStatus = status.toLowerCase();
    const { rows } = await this.pool.query(
      `UPDATE transactions SET status = $1
       WHERE id = $2
       RETURNING id, amount, status, created_at`,
      [pgStatus, transferId]
    );

    if (rows.length === 0) return undefined;

    return {
      transferId: rows[0].id,
      fromAddress: '',
      toAddress: '',
      amount: parseFloat(rows[0].amount),
      status: status,
      traceId: '',
      spanId: '',
      createdAt: rows[0].created_at,
    };
  }

  // ============================================
  // ORDER OPERATIONS
  // ============================================

  async createOrder(orderData: {
    orderId: string;
    pair: string;
    side: string;
    quantity: number;
    orderType: string;
    traceId: string;
    spanId: string;
    userId?: string;
    walletAddress?: string;
  }): Promise<Order> {
    // Get user ID if provided
    let dbUserId: string | null = null;
    if (orderData.userId) {
      const { rows } = await this.pool.query(
        `SELECT id FROM users WHERE email = $1 OR id::text = $1`,
        [orderData.userId]
      );
      if (rows.length > 0) {
        dbUserId = rows[0].id;
      }
    }

    // Store both UUID (id) and friendly orderId (order_id) in the database
    const { rows } = await this.pool.query(
      `INSERT INTO orders (order_id, user_id, pair, side, type, quantity, status, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
       RETURNING id, order_id, pair, side, type, quantity, status, trace_id, created_at`,
      [
        orderData.orderId, // Friendly order ID (ORD-xxx-x)
        dbUserId || '00000000-0000-0000-0000-000000000000',
        orderData.pair || 'BTC/USD',
        orderData.side.toLowerCase(),
        orderData.orderType.toLowerCase(),
        orderData.quantity,
        orderData.traceId, // Store trace ID for observability
      ]
    );

    const row = rows[0];

    return {
      orderId: orderData.orderId, // Use the application-level orderId for UI/API
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

  async getOrders(limit: number = 10): Promise<Order[]> {
    const { rows } = await this.pool.query(
      `SELECT id, order_id, pair, side, type, quantity, filled, status, price, trace_id, created_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return rows.map(row => ({
      orderId: row.order_id || row.id, // Prefer order_id, fallback to id for legacy
      pair: 'BTC/USD' as const,
      side: row.side.toUpperCase() as 'BUY' | 'SELL',
      quantity: parseFloat(row.quantity),
      orderType: 'MARKET' as const,
      status: this.mapOrderStatus(row.status),
      fillPrice: row.price ? parseFloat(row.price) : undefined,
      totalValue: row.price && row.filled ? parseFloat(row.price) * parseFloat(row.filled) : undefined,
      traceId: row.trace_id || '', // Use trace_id from database
      spanId: '',
      createdAt: row.created_at,
    }));
  }

  private mapOrderStatus(status: string): 'PENDING' | 'FILLED' | 'REJECTED' {
    switch (status) {
      case 'filled': return 'FILLED';
      case 'cancelled': return 'REJECTED';
      default: return 'PENDING';
    }
  }

  async updateOrder(orderId: string, updates: {
    status?: 'PENDING' | 'FILLED' | 'REJECTED';
    fillPrice?: number;
    totalValue?: number
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

    const { rows } = await this.pool.query(
      `UPDATE orders SET ${setClauses.join(', ')}
       WHERE order_id = $${paramIndex}
       RETURNING id, order_id, pair, side, type, quantity, filled, status, price, created_at`,
      values
    );

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

  // ============================================
  // TRACE OPERATIONS (In-memory for now)
  // Traces are ephemeral observability data
  // ============================================

  private traces: Map<string, Trace> = new Map();
  private spans: Map<string, Span> = new Map();
  private nextId = 1;

  async createTrace(traceData: InsertTrace): Promise<Trace> {
    const trace: Trace = {
      id: this.nextId++,
      ...traceData,
      status: 'active',
      duration: null,
      startTime: new Date(),
      endTime: null,
    };
    this.traces.set(trace.traceId, trace);
    return trace;
  }

  async getTrace(traceId: string): Promise<Trace | undefined> {
    return this.traces.get(traceId);
  }

  async getTraces(limit: number = 10): Promise<Trace[]> {
    const allTraces = Array.from(this.traces.values());
    return allTraces
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  async updateTraceStatus(traceId: string, status: string, duration?: number): Promise<Trace | undefined> {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.status = status;
      trace.duration = duration || null;
      trace.endTime = new Date();
      return trace;
    }
    return undefined;
  }

  // ============================================
  // SPAN OPERATIONS (In-memory for now)
  // ============================================

  async createSpan(spanData: InsertSpan): Promise<Span> {
    const span: Span = {
      id: this.nextId++,
      ...spanData,
      status: spanData.status || 'OK',
      duration: spanData.duration ?? null,
      tags: spanData.tags ?? null,
      startTime: new Date(),
      endTime: spanData.endTime ? new Date(spanData.endTime) : null,
    };
    this.spans.set(span.spanId, span);
    return span;
  }

  async getSpan(spanId: string): Promise<Span | undefined> {
    return this.spans.get(spanId);
  }

  async getSpansByTrace(traceId: string): Promise<Span[]> {
    const allSpans = Array.from(this.spans.values());
    return allSpans
      .filter(span => span.traceId === traceId)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }

  async updateSpan(spanId: string, updates: Partial<Span>): Promise<Span | undefined> {
    const span = this.spans.get(spanId);
    if (span) {
      Object.assign(span, updates);
      return span;
    }
    return undefined;
  }

  // ============================================
  // CLEAR ALL DATA
  // ============================================

  async clearAllData(): Promise<void> {
    // Clear in-memory trace data
    this.traces.clear();
    this.spans.clear();
    this.nextId = 1;

    // Note: In production, you might want to truncate tables
    // For now, we'll just clear ephemeral data
    logger.info('[PostgresStorage] Cleared ephemeral data (traces/spans)');
  }
}

// ============================================
// FACTORY FUNCTION
// ============================================

let postgresStorage: PostgresStorage | null = null;

/**
 * Get a singleton PostgresStorage instance
 */
export async function getPostgresStorage(): Promise<PostgresStorage> {
  if (!postgresStorage) {
    postgresStorage = new PostgresStorage();
    await postgresStorage.initialize();
  }
  return postgresStorage;
}
