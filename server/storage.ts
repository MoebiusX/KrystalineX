import { type Order, type Trace, type InsertTrace, type Span, type InsertSpan, type User, type UserWallet, type Transfer, type KXWallet, type WalletBalance, type UserWalletMapping } from "@shared/schema";
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { createLogger } from './lib/logger';

// ============================================
// KRYSTALINE EXCHANGE - WALLET ADDRESS GENERATION
// ============================================

/**
 * Generates a Krystaline Exchange wallet address
 * Format: kx1 + 32 chars base32 = "kx1qxy2kgdygjrsqtzq2n0yrf249abc"
 */
export function generateWalletAddress(seed?: string): string {
  const input = seed || nanoid(32);
  const hash = createHash('sha256').update(input).digest();
  // Base32 encode (lowercase, no padding) - similar to bech32
  const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
  let address = 'kx1';
  for (let i = 0; i < 32; i++) {
    address += base32Chars[hash[i % hash.length] % 32];
  }
  return address;
}

/**
 * Generates a wallet ID
 */
export function generateWalletId(): string {
  return `wal_${nanoid(21)}`;
}

// ============================================
// SEED DATA - Initial System Configuration
// ============================================

export const USERS: User[] = [
  { id: 'user_seed_001', name: 'Primary User', avatar: '👤' },
  { id: 'user_seed_002', name: 'Secondary User', avatar: '👤' },
];

// Seed wallet addresses (deterministic from user identifiers)
export const SEED_WALLETS = {
  primary: {
    walletId: 'wal_seed_primary_001',
    address: generateWalletAddress('seed_user_primary_001'),
    ownerId: 'seed.user.primary@krystaline.io',
  },
  secondary: {
    walletId: 'wal_seed_primary_002',
    address: generateWalletAddress('seed_user_primary_002'),
    ownerId: 'seed.user.secondary@krystaline.io',
  },
};

// ============================================
// STORAGE INTERFACE
// ============================================

export interface IStorage {
  // User operations
  getUsers(): Promise<User[]>;
  getUser(userId: string): Promise<User | undefined>;

  // NEW: Wallet operations (by address)
  getWalletByAddress(address: string): Promise<KXWallet | undefined>;
  getWalletById(walletId: string): Promise<KXWallet | undefined>;
  getWalletsByOwner(ownerId: string): Promise<KXWallet[]>;
  createWallet(ownerId: string, label?: string): Promise<KXWallet>;

  // NEW: Balance operations
  getBalance(walletId: string, asset: string): Promise<WalletBalance | undefined>;
  getAllBalances(walletId: string): Promise<WalletBalance[]>;
  updateBalance(walletId: string, asset: string, amount: number): Promise<WalletBalance | undefined>;

  // NEW: User-Wallet mapping
  getUserWalletMapping(userId: string): Promise<UserWalletMapping | undefined>;
  getDefaultWallet(userId: string): Promise<KXWallet | undefined>;

  // Legacy wallet operations (for backwards compatibility)
  getWallet(userId: string): Promise<UserWallet | undefined>;
  updateWallet(userId: string, updates: { btc?: number; usd?: number }): Promise<UserWallet | undefined>;

  // Transfer operations (now uses addresses)
  createTransfer(data: { transferId: string; fromAddress: string; toAddress: string; amount: number; traceId: string; spanId: string }): Promise<Transfer>;
  getTransfers(limit?: number, userId?: string): Promise<Transfer[]>;
  updateTransfer(transferId: string, status: "PENDING" | "COMPLETED" | "FAILED"): Promise<Transfer | undefined>;

  // Order operations
  createOrder(order: { orderId: string; pair: string; side: string; quantity: number; orderType: string; traceId: string; spanId: string; userId?: string; walletAddress?: string }): Promise<Order>;
  getOrders(limit?: number): Promise<Order[]>;
  updateOrder(orderId: string, updates: { status?: "PENDING" | "FILLED" | "REJECTED"; fillPrice?: number; totalValue?: number }): Promise<Order | undefined>;

  // Trace operations
  createTrace(trace: InsertTrace): Promise<Trace>;
  getTrace(traceId: string): Promise<Trace | undefined>;
  getTraces(limit?: number): Promise<Trace[]>;
  updateTraceStatus(traceId: string, status: string, duration?: number): Promise<Trace | undefined>;

  // Span operations
  createSpan(span: InsertSpan): Promise<Span>;
  getSpan(spanId: string): Promise<Span | undefined>;
  getSpansByTrace(traceId: string): Promise<Span[]>;
  updateSpan(spanId: string, updates: Partial<Span>): Promise<Span | undefined>;

  // Address lookup utilities
  resolveAddress(identifier: string): Promise<string | undefined>;  // email/userId -> kx1 address

  // Clear all data
  clearAllData(): Promise<void>;
}

// ============================================
// MEMORY STORAGE IMPLEMENTATION
// ============================================

export class MemoryStorage implements IStorage {
  // NEW: Krystaline wallet storage
  private kxWallets: Map<string, KXWallet> = new Map();           // walletId -> KXWallet
  private walletsByAddress: Map<string, string> = new Map();       // address -> walletId
  private walletsByOwner: Map<string, string[]> = new Map();       // ownerId -> walletId[]
  private balances: Map<string, Map<string, WalletBalance>> = new Map(); // walletId -> asset -> balance
  private userWalletMappings: Map<string, UserWalletMapping> = new Map();

  // Legacy storage
  private wallets: Map<string, UserWallet> = new Map();
  private transfers: Map<string, Transfer> = new Map();
  private orders: Map<string, Order> = new Map();
  private traces: Map<string, Trace> = new Map();
  private spans: Map<string, Span> = new Map();
  private nextId = 1;

  constructor() {
    this.initializeSeedData();
  }

  private initializeSeedData(): void {
    // Create seed wallets with kx1 addresses
    for (const [name, seed] of Object.entries(SEED_WALLETS)) {
      const wallet: KXWallet = {
        walletId: seed.walletId,
        address: seed.address,
        ownerId: seed.ownerId,
        label: `${name.charAt(0).toUpperCase() + name.slice(1)}'s Main Wallet`,
        type: 'custodial',
        createdAt: new Date(),
      };

      this.kxWallets.set(wallet.walletId, wallet);
      this.walletsByAddress.set(wallet.address, wallet.walletId);
      this.walletsByOwner.set(wallet.ownerId, [wallet.walletId]);

      // Initialize balances (stored as smallest units)
      const walletBalances = new Map<string, WalletBalance>();

      if (name === 'primary') {
        walletBalances.set('BTC', { walletId: wallet.walletId, asset: 'BTC', balance: 150000000, decimals: 8, lastUpdated: new Date() }); // 1.5 BTC
        walletBalances.set('USD', { walletId: wallet.walletId, asset: 'USD', balance: 5000000, decimals: 2, lastUpdated: new Date() });   // $50,000
      } else {
        walletBalances.set('BTC', { walletId: wallet.walletId, asset: 'BTC', balance: 50000000, decimals: 8, lastUpdated: new Date() });  // 0.5 BTC
        walletBalances.set('USD', { walletId: wallet.walletId, asset: 'USD', balance: 1000000, decimals: 2, lastUpdated: new Date() });   // $10,000
      }
      this.balances.set(wallet.walletId, walletBalances);

      // User wallet mapping
      this.userWalletMappings.set(wallet.ownerId, {
        userId: wallet.ownerId,
        walletIds: [wallet.walletId],
        defaultWalletId: wallet.walletId,
      });

      // Seed wallet storage for backwards compatibility
      const seedWallet: UserWallet = {
        userId: wallet.ownerId,
        btc: name === 'primary' ? 1.5 : 0.5,
        usd: name === 'primary' ? 50000 : 10000,
        lastUpdated: new Date(),
      };
      this.wallets.set(wallet.ownerId, seedWallet);
      this.wallets.set(name, { ...seedWallet, userId: name });
    }

    const storageLogger = createLogger('storage');
    storageLogger.info({ primary: SEED_WALLETS.primary.address, secondary: SEED_WALLETS.secondary.address }, 'Initialized seed wallets');
  }

  // ============================================
  // USER OPERATIONS
  // ============================================

  async getUsers(): Promise<User[]> {
    return USERS;
  }

  async getUser(userId: string): Promise<User | undefined> {
    return USERS.find(u => u.id === userId);
  }

  // ============================================
  // NEW: KRYSTALINE WALLET OPERATIONS
  // ============================================

  async getWalletByAddress(address: string): Promise<KXWallet | undefined> {
    const walletId = this.walletsByAddress.get(address);
    if (!walletId) return undefined;
    return this.kxWallets.get(walletId);
  }

  async getWalletById(walletId: string): Promise<KXWallet | undefined> {
    return this.kxWallets.get(walletId);
  }

  async getWalletsByOwner(ownerId: string): Promise<KXWallet[]> {
    const walletIds = this.walletsByOwner.get(ownerId) || [];
    return walletIds.map(id => this.kxWallets.get(id)).filter(Boolean) as KXWallet[];
  }

  async createWallet(ownerId: string, label: string = 'Trading Wallet'): Promise<KXWallet> {
    const walletId = generateWalletId();
    const address = generateWalletAddress(`${ownerId}-${walletId}-${Date.now()}`);

    const wallet: KXWallet = {
      walletId,
      address,
      ownerId,
      label,
      type: 'custodial',
      createdAt: new Date(),
    };

    this.kxWallets.set(walletId, wallet);
    this.walletsByAddress.set(address, walletId);

    const ownerWallets = this.walletsByOwner.get(ownerId) || [];
    ownerWallets.push(walletId);
    this.walletsByOwner.set(ownerId, ownerWallets);

    // Initialize empty balances
    this.balances.set(walletId, new Map());

    // Update or create user mapping
    let mapping = this.userWalletMappings.get(ownerId);
    if (mapping) {
      mapping.walletIds.push(walletId);
    } else {
      mapping = { userId: ownerId, walletIds: [walletId], defaultWalletId: walletId };
      this.userWalletMappings.set(ownerId, mapping);
    }

    createLogger('storage').debug({ address, ownerId }, 'Created wallet');
    return wallet;
  }

  // ============================================
  // NEW: BALANCE OPERATIONS
  // ============================================

  async getBalance(walletId: string, asset: string): Promise<WalletBalance | undefined> {
    return this.balances.get(walletId)?.get(asset);
  }

  async getAllBalances(walletId: string): Promise<WalletBalance[]> {
    const balanceMap = this.balances.get(walletId);
    if (!balanceMap) return [];
    return Array.from(balanceMap.values());
  }

  async updateBalance(walletId: string, asset: string, amount: number): Promise<WalletBalance | undefined> {
    let balanceMap = this.balances.get(walletId);
    if (!balanceMap) {
      balanceMap = new Map();
      this.balances.set(walletId, balanceMap);
    }

    const decimals = asset === 'BTC' ? 8 : asset === 'ETH' ? 18 : 2;
    const balance: WalletBalance = {
      walletId,
      asset: asset as 'BTC' | 'USD' | 'ETH',
      balance: Math.round(amount),  // Ensure integer
      decimals,
      lastUpdated: new Date(),
    };
    balanceMap.set(asset, balance);
    return balance;
  }

  // ============================================
  // USER-WALLET MAPPING
  // ============================================

  async getUserWalletMapping(userId: string): Promise<UserWalletMapping | undefined> {
    return this.userWalletMappings.get(userId);
  }

  async getDefaultWallet(userId: string): Promise<KXWallet | undefined> {
    const mapping = await this.getUserWalletMapping(userId);
    if (!mapping) return undefined;
    return this.kxWallets.get(mapping.defaultWalletId);
  }

  // ============================================
  // ADDRESS RESOLUTION (email/userId -> kx1 address)
  // ============================================

  async resolveAddress(identifier: string): Promise<string | undefined> {
    // If already a kx1 address, return as-is
    if (identifier.startsWith('kx1')) {
      return identifier;
    }

    // Try to find by owner ID (email)
    const wallet = await this.getDefaultWallet(identifier);
    return wallet?.address;
  }

  // ============================================
  // LEGACY WALLET OPERATIONS (backwards compatibility)
  // ============================================

  async getWallet(userId: string): Promise<UserWallet | undefined> {
    return this.wallets.get(userId);
  }

  async updateWallet(userId: string, updates: { btc?: number; usd?: number }): Promise<UserWallet | undefined> {
    const wallet = this.wallets.get(userId);
    if (wallet) {
      if (updates.btc !== undefined) wallet.btc = updates.btc;
      if (updates.usd !== undefined) wallet.usd = updates.usd;
      wallet.lastUpdated = new Date();
      return wallet;
    }
    return undefined;
  }

  // ============================================
  // TRANSFER OPERATIONS (now uses addresses)
  // ============================================

  async createTransfer(data: { transferId: string; fromAddress: string; toAddress: string; amount: number; traceId: string; spanId: string }): Promise<Transfer> {
    // Resolve owners for legacy compatibility
    const fromWallet = await this.getWalletByAddress(data.fromAddress);
    const toWallet = await this.getWalletByAddress(data.toAddress);

    const transfer: Transfer = {
      transferId: data.transferId,
      fromAddress: data.fromAddress,
      toAddress: data.toAddress,
      fromUserId: fromWallet?.ownerId,
      toUserId: toWallet?.ownerId,
      amount: data.amount,
      status: "PENDING",
      traceId: data.traceId,
      spanId: data.spanId,
      createdAt: new Date(),
    };
    this.transfers.set(transfer.transferId, transfer);
    return transfer;
  }

  async getTransfers(limit: number = 10, userId?: string): Promise<Transfer[]> {
    let allTransfers = Array.from(this.transfers.values());
    if (userId) {
      allTransfers = allTransfers.filter(t => t.fromUserId === userId || t.toUserId === userId);
    }
    return allTransfers
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async updateTransfer(transferId: string, status: "PENDING" | "COMPLETED" | "FAILED"): Promise<Transfer | undefined> {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      transfer.status = status;
      return transfer;
    }
    return undefined;
  }

  // ============================================
  // ORDER OPERATIONS
  // ============================================

  async createOrder(orderData: { orderId: string; pair: string; side: string; quantity: number; orderType: string; traceId: string; spanId: string; userId?: string }): Promise<Order> {
    const order: Order = {
      orderId: orderData.orderId,
      pair: "BTC/USD",
      side: orderData.side as "BUY" | "SELL",
      quantity: orderData.quantity,
      orderType: "MARKET",
      status: "PENDING",
      traceId: orderData.traceId,
      spanId: orderData.spanId,
      createdAt: new Date(),
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  async getOrders(limit: number = 10): Promise<Order[]> {
    const allOrders = Array.from(this.orders.values());
    return allOrders
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async updateOrder(orderId: string, updates: { status?: "PENDING" | "FILLED" | "REJECTED"; fillPrice?: number; totalValue?: number }): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    if (order) {
      if (updates.status) order.status = updates.status;
      if (updates.fillPrice) order.fillPrice = updates.fillPrice;
      if (updates.totalValue) order.totalValue = updates.totalValue;
      return order;
    }
    return undefined;
  }

  // ============================================
  // TRACE OPERATIONS
  // ============================================

  async createTrace(traceData: InsertTrace): Promise<Trace> {
    const trace: Trace = {
      id: this.nextId++,
      ...traceData,
      status: "active",
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
  // SPAN OPERATIONS
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
    this.orders.clear();
    this.transfers.clear();
    this.traces.clear();
    this.spans.clear();
    this.nextId = 1;

    // Reset wallets to initial state
    this.kxWallets.clear();
    this.walletsByAddress.clear();
    this.walletsByOwner.clear();
    this.balances.clear();
    this.userWalletMappings.clear();
    this.wallets.clear();

    // Re-initialize seed data
    this.initializeSeedData();
  }
}

// ============================================
// STORAGE FACTORY
// ============================================

/**
 * Storage type configuration
 * Default is 'postgres' for production. Use STORAGE_TYPE=memory for testing.
 */
export type StorageType = 'memory' | 'postgres';

/**
 * Get the configured storage type - defaults to postgres for production
 * Set STORAGE_TYPE=memory for testing environments only
 */
export function getStorageType(): StorageType {
  const envType = process.env.STORAGE_TYPE?.toLowerCase();
  if (envType === 'memory') {
    return 'memory';
  }
  // Default to postgres for production - trades must be persisted!
  return 'postgres';
}

/**
 * Create the appropriate storage instance based on configuration
 * Use this for async initialization (required for PostgreSQL)
 */
export async function createStorage(): Promise<IStorage> {
  const storageType = getStorageType();

  if (storageType === 'postgres') {
    // Dynamic import to avoid loading pg when not needed
    const { getPostgresStorage } = await import('./db/postgres-storage');
    createLogger('storage').info('Using PostgreSQL storage');
    return getPostgresStorage();
  }

  createLogger('storage').info('Using in-memory storage');
  return new MemoryStorage();
}

// Mutable storage instance - initialized on server startup
let _storage: IStorage = new MemoryStorage(); // Fallback until initialized

/**
 * Initialize storage - MUST be called on server startup
 */
export async function initializeStorage(): Promise<void> {
  _storage = await createStorage();
  createLogger('storage').info('Storage initialized');
}

/**
 * Get the current storage instance
 */
export function getStorage(): IStorage {
  return _storage;
}

// Default export: proxy to the mutable storage
// This allows code to import { storage } and get the correct backend after initialization
export const storage: IStorage = new Proxy({} as IStorage, {
  get(_target, prop) {
    const value = (_storage as any)[prop];
    // Bind methods to the storage instance so 'this' works correctly
    if (typeof value === 'function') {
      return value.bind(_storage);
    }
    return value;
  }
});