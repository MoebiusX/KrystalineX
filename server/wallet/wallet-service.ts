/**
 * Wallet Service
 * 
 * Manages user wallets, balances, and transactions.
 * Uses Krystaline Exchange wallet addresses (kx1...)
 */

import db from '../db';
import { createLogger } from '../lib/logger';
import { WalletError, ValidationError, NotFoundError, InsufficientFundsError } from '../lib/errors';
import { generateWalletAddress, generateWalletId, SEED_WALLETS } from '../storage';
import { cacheGet, cacheSet, cacheDel } from '../lib/redis';

const logger = createLogger('wallet');

// Supported assets
export const SUPPORTED_ASSETS = ['BTC', 'ETH', 'USDT', 'USD', 'EUR'];

// Default balances for new user accounts
const INITIAL_BALANCES: Record<string, number> = {
    USDT: 10000,
    BTC: 1,
    ETH: 10,
    USD: 5000,
    EUR: 4500,
};

export interface Wallet {
    id: string;
    user_id: string;
    asset: string;
    balance: string;
    available: string;
    locked: string;
    address?: string;  // Krystaline address (kx1...)
}

export interface Transaction {
    id: string;
    user_id: string;
    wallet_id: string;
    type: string;
    amount: string;
    fee: string;
    status: string;
    reference_id: string | null;
    description: string | null;
    created_at: Date;
}

/**
 * Resolve userId (which might be an email) to database UUID
 */
async function resolveUserId(userId: string): Promise<string | null> {
    if (!userId.includes('@')) {
        // Already looks like a UUID or basic ID
        return userId;
    }

    // Resolve email to UUID
    const result = await db.query(
        `SELECT id FROM users WHERE email = $1`,
        [userId]
    );

    if (result.rows.length === 0) {
        logger.warn({ userId }, 'User not found by email');
        return null;
    }

    return result.rows[0].id;
}

export const walletService = {
    /**
     * Create default wallets for a new user with initial funding
     * Also creates a Krystaline Exchange wallet address (kx1...)
     */
    async createDefaultWallets(userId: string): Promise<Wallet[]> {
        const wallets: Wallet[] = [];

        // Generate Krystaline wallet address for this user
        const kxAddress = generateWalletAddress(userId);
        const kxWalletId = generateWalletId();

        logger.info({
            userId,
            kxAddress,
            kxWalletId
        }, 'Creating Krystaline wallet for user');

        await db.transaction(async (client) => {
            for (const asset of SUPPORTED_ASSETS) {
                const balance = INITIAL_BALANCES[asset] || 0;

                const result = await client.query(
                    `INSERT INTO wallets (user_id, asset, balance, available, locked, address)
                     VALUES ($1, $2, $3, $3, 0, $4)
                     RETURNING *`,
                    [userId, asset, balance, kxAddress]
                );

                wallets.push(result.rows[0]);

                // Log bonus transaction if balance > 0
                if (balance > 0) {
                    await client.query(
                        `INSERT INTO transactions (user_id, wallet_id, type, amount, description)
                         VALUES ($1, $2, 'bonus', $3, 'Welcome bonus - initial funding')`,
                        [userId, result.rows[0].id, balance]
                    );
                }
            }
        });

        logger.info({
            userId,
            kxAddress,
            walletsCreated: wallets.length,
            assets: SUPPORTED_ASSETS
        }, 'Created default wallets for user');
        return wallets;
    },

    /**
     * Get Krystaline wallet address for a user
     */
    async getKXAddress(userId: string): Promise<string | null> {
        const resolvedId = await resolveUserId(userId);
        if (!resolvedId) return null;

        const result = await db.query(
            `SELECT address FROM wallets WHERE user_id = $1 AND address IS NOT NULL LIMIT 1`,
            [resolvedId]
        );

        if (result.rows.length > 0 && result.rows[0].address) {
            return result.rows[0].address;
        }

        // Fallback to seed wallets
        const seedEntry = Object.values(SEED_WALLETS).find(s => s.ownerId === userId);
        return seedEntry?.address || null;
    },

    /**
     * Resolve a wallet address from userId/email
     */
    async resolveAddress(identifier: string): Promise<string | null> {
        // If already a kx1 address, return as-is
        if (identifier.startsWith('kx1')) {
            return identifier;
        }

        // Otherwise resolve from userId/email
        return this.getKXAddress(identifier);
    },

    /**
     * Get all wallets for a user
     */
    async getWallets(userId: string): Promise<Wallet[]> {
        const dbUserId = await resolveUserId(userId);
        if (!dbUserId) return [];

        // Check Redis cache (10s TTL — balances can change on trades)
        const cacheKey = `wallet:${dbUserId}`;
        const cached = await cacheGet<Wallet[]>(cacheKey);
        if (cached) return cached;

        const result = await db.query(
            `SELECT * FROM wallets WHERE user_id = $1 ORDER BY asset`,
            [dbUserId]
        );

        // Cache for 10 seconds
        await cacheSet(cacheKey, result.rows, 10);

        // Address is now stored in DB, no fallback needed
        return result.rows;
    },

    /**
     * Get a specific wallet
     * Note: userId can be either a UUID or email - we resolve it first
     */
    async getWallet(userId: string, asset: string): Promise<Wallet | null> {
        // First resolve userId to actual database user_id (UUID)
        let dbUserId = userId;

        // Resolve seed wallet keys ('primary', 'secondary') to their ownerId emails
        const seedWallet = SEED_WALLETS[userId as keyof typeof SEED_WALLETS];
        if (seedWallet) {
            dbUserId = seedWallet.ownerId;
        }

        // If it looks like an email, resolve to UUID
        if (dbUserId.includes('@')) {
            const userResult = await db.query(
                `SELECT id FROM users WHERE email = $1`,
                [dbUserId]
            );
            if (userResult.rows.length === 0) {
                logger.warn({ userId, asset }, 'User not found by email in getWallet');
                return null;
            }
            dbUserId = userResult.rows[0].id;
        }

        const result = await db.query(
            `SELECT * FROM wallets WHERE user_id = $1 AND asset = $2`,
            [dbUserId, asset.toUpperCase()]
        );
        return result.rows[0] || null;
    },

    /**
     * Get wallet by ID
     */
    async getWalletById(walletId: string): Promise<Wallet | null> {
        const result = await db.query(
            `SELECT * FROM wallets WHERE id = $1`,
            [walletId]
        );
        return result.rows[0] || null;
    },

    /**
     * Credit funds to a wallet
     */
    async credit(
        userId: string,
        asset: string,
        amount: number,
        type: 'deposit' | 'trade_buy' | 'bonus' = 'deposit',
        description?: string,
        referenceId?: string
    ): Promise<Transaction> {
        return db.transaction(async (client) => {
            // Update wallet balance
            const dbUserId = await resolveUserId(userId);
            if (!dbUserId) {
                throw new Error(`User not found: ${userId}`);
            }

            const walletResult = await client.query(
                `UPDATE wallets 
                 SET balance = balance + $1, available = available + $1, updated_at = NOW()
                 WHERE user_id = $2 AND asset = $3
                 RETURNING *`,
                [amount, userId, asset.toUpperCase()]
            );

            if (walletResult.rows.length === 0) {
                throw new Error(`Wallet not found for asset: ${asset}`);
            }

            // Create transaction record
            const txResult = await client.query(
                `INSERT INTO transactions (user_id, wallet_id, type, amount, description, reference_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [userId, walletResult.rows[0].id, type, amount, description, referenceId]
            );

            logger.info({
                userId,
                asset: asset.toUpperCase(),
                amount,
                type
            }, 'Wallet credited');

            // Invalidate wallet cache after credit
            await cacheDel(`wallet:${dbUserId}`);

            return txResult.rows[0];
        });
    },

    /**
     * Debit funds from a wallet
     */
    async debit(
        userId: string,
        asset: string,
        amount: number,
        type: 'withdrawal' | 'trade_sell' | 'fee',
        description?: string,
        referenceId?: string
    ): Promise<Transaction> {
        return db.transaction(async (client) => {
            // Check available balance
            const dbUserId = await resolveUserId(userId);
            if (!dbUserId) {
                throw new Error(`User not found: ${userId}`);
            }

            const walletResult = await client.query(
                `SELECT * FROM wallets WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
                [dbUserId, asset.toUpperCase()]
            );

            if (walletResult.rows.length === 0) {
                throw new Error(`Wallet not found for asset: ${asset}`);
            }

            const wallet = walletResult.rows[0];
            if (parseFloat(wallet.available) < amount) {
                throw new Error(`Insufficient balance. Available: ${wallet.available} ${asset}`);
            }

            // Update wallet balance
            await client.query(
                `UPDATE wallets 
                 SET balance = balance - $1, available = available - $1, updated_at = NOW()
                 WHERE id = $2`,
                [amount, wallet.id]
            );

            // Create transaction record
            const txResult = await client.query(
                `INSERT INTO transactions (user_id, wallet_id, type, amount, description, reference_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [userId, wallet.id, type, -amount, description, referenceId]
            );

            logger.info({
                userId,
                asset: asset.toUpperCase(),
                amount,
                type
            }, 'Wallet debited');

            // Invalidate wallet cache after debit
            await cacheDel(`wallet:${dbUserId}`);

            return txResult.rows[0];
        });
    },

    /**
     * Lock funds for a pending order
     */
    async lockFunds(userId: string, asset: string, amount: number): Promise<void> {
        const dbUserId = await resolveUserId(userId);
        if (!dbUserId) return;

        await db.query(
            `UPDATE wallets 
             SET available = available - $1, locked = locked + $1, updated_at = NOW()
             WHERE user_id = $2 AND asset = $3 AND available >= $1`,
            [amount, dbUserId, asset.toUpperCase()]
        );

        await cacheDel(`wallet:${dbUserId}`);
    },

    /**
     * Unlock funds (order cancelled)
     */
    async unlockFunds(userId: string, asset: string, amount: number): Promise<void> {
        const dbUserId = await resolveUserId(userId);
        if (!dbUserId) return;

        await db.query(
            `UPDATE wallets 
             SET available = available + $1, locked = locked - $1, updated_at = NOW()
             WHERE user_id = $2 AND asset = $3 AND locked >= $1`,
            [amount, dbUserId, asset.toUpperCase()]
        );

        await cacheDel(`wallet:${dbUserId}`);
    },

    /**
     * Get transaction history
     */
    async getTransactions(userId: string, limit = 50): Promise<Transaction[]> {
        const dbUserId = await resolveUserId(userId);
        if (!dbUserId) return [];

        const result = await db.query(
            `SELECT t.*, w.asset 
             FROM transactions t
             JOIN wallets w ON t.wallet_id = w.id
             WHERE t.user_id = $1
             ORDER BY t.created_at DESC
             LIMIT $2`,
            [dbUserId, limit]
        );
        return result.rows;
    },

    /**
     * Get balance summary (formatted for display)
     */
    async getBalanceSummary(userId: string): Promise<Record<string, { balance: string; available: string; locked: string }>> {
        const wallets = await this.getWallets(userId);
        const summary: Record<string, any> = {};

        for (const wallet of wallets) {
            summary[wallet.asset] = {
                balance: wallet.balance,
                available: wallet.available,
                locked: wallet.locked,
            };
        }

        return summary;
    },

    /**
     * Transfer funds between users (P2P transfer)
     */
    async transfer(
        fromUserId: string,
        toUserId: string,
        asset: string,
        amount: number
    ): Promise<{ success: boolean; fromBalance: string; toBalance: string; transferId: string }> {
        const transferId = `TXF-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        return db.transaction(async (client) => {
            // Resolve user IDs (might be emails)
            const dbFromUserId = await resolveUserId(fromUserId);
            const dbToUserId = await resolveUserId(toUserId);

            if (!dbFromUserId || !dbToUserId) {
                throw new NotFoundError(`User not found`);
            }

            // Get sender's wallet
            const senderResult = await client.query(
                `SELECT * FROM wallets WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
                [dbFromUserId, asset.toUpperCase()]
            );

            if (senderResult.rows.length === 0) {
                throw new NotFoundError(`Sender wallet not found for asset: ${asset}`);
            }

            const senderWallet = senderResult.rows[0];
            const availableAmount = parseFloat(senderWallet.available);
            if (availableAmount < amount) {
                throw new InsufficientFundsError(asset, amount, availableAmount);
            }

            // Get receiver's wallet
            const receiverResult = await client.query(
                `SELECT * FROM wallets WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
                [dbToUserId, asset.toUpperCase()]
            );

            if (receiverResult.rows.length === 0) {
                throw new NotFoundError(`Receiver wallet not found for asset: ${asset}`);
            }

            const receiverWallet = receiverResult.rows[0];

            // Debit from sender
            await client.query(
                `UPDATE wallets 
                 SET balance = balance - $1, available = available - $1, updated_at = NOW()
                 WHERE id = $2`,
                [amount, senderWallet.id]
            );

            // Credit to receiver
            await client.query(
                `UPDATE wallets 
                 SET balance = balance + $1, available = available + $1, updated_at = NOW()
                 WHERE id = $2`,
                [amount, receiverWallet.id]
            );

            // Create transaction records for both parties
            await client.query(
                `INSERT INTO transactions (user_id, wallet_id, type, amount, description, reference_id)
                 VALUES ($1, $2, 'withdrawal', $3, $4, $5)`,
                [dbFromUserId, senderWallet.id, -amount, `Transfer to user`, transferId]
            );

            await client.query(
                `INSERT INTO transactions (user_id, wallet_id, type, amount, description, reference_id)
                 VALUES ($1, $2, 'deposit', $3, $4, $5)`,
                [dbToUserId, receiverWallet.id, amount, `Transfer from user`, transferId]
            );

            // Get updated balances
            const updatedSender = await client.query(
                `SELECT available FROM wallets WHERE id = $1`,
                [senderWallet.id]
            );
            const updatedReceiver = await client.query(
                `SELECT available FROM wallets WHERE id = $1`,
                [receiverWallet.id]
            );

            logger.info({
                transferId,
                fromUserId,
                toUserId,
                asset,
                amount
            }, 'P2P Transfer completed');

            // Invalidate both users' wallet caches
            await cacheDel(`wallet:${dbFromUserId}`);
            await cacheDel(`wallet:${dbToUserId}`);

            return {
                success: true,
                fromBalance: updatedSender.rows[0].available,
                toBalance: updatedReceiver.rows[0].available,
                transferId
            };
        });
    },

    /**
     * Get composite wallet summary (BTC + USD for legacy compatibility)
     * Replaces storage.getWallet()
     */
    async getWalletSummary(userId: string): Promise<{ userId: string; btc: number; usd: number; lastUpdated: Date } | null> {
        const resolvedId = await resolveUserId(userId);

        if (!resolvedId) {
            // Check seed users fallback
            const seedEntries = Object.entries(SEED_WALLETS);
            const matchedEntry = seedEntries.find(([key, seed]) =>
                seed.ownerId === userId ||
                seed.ownerId.split('@')[0] === userId ||
                key === userId
            );
            if (matchedEntry) {
                const [key] = matchedEntry;
                return {
                    userId,
                    btc: key === 'primary' ? 1.5 : 0.5,
                    usd: key === 'primary' ? 50000 : 10000,
                    lastUpdated: new Date(),
                };
            }
            return null;
        }

        const result = await db.query(
            `SELECT asset, balance, updated_at FROM wallets WHERE user_id = $1`,
            [resolvedId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        let btc = 0;
        let usd = 0;
        let lastUpdated = new Date();

        for (const row of result.rows) {
            if (row.asset === 'BTC') {
                btc = parseFloat(row.balance);
            } else if (row.asset === 'USD') {
                usd = parseFloat(row.balance);
            }
            lastUpdated = row.updated_at;
        }

        return { userId, btc, usd, lastUpdated };
    },

    /**
     * Update absolute balance for a wallet
     * Uses upsert pattern - creates wallet if it doesn't exist
     * Replaces storage.updateWallet()
     */
    async updateBalance(userId: string, asset: string, newBalance: number): Promise<boolean> {
        const resolvedId = await resolveUserId(userId);
        if (!resolvedId) {
            logger.warn({ userId, asset }, 'Cannot update balance - user not found');
            return false;
        }

        // Use upsert pattern - insert if not exists, update if exists
        const result = await db.query(
            `INSERT INTO wallets (user_id, asset, balance, available, locked, updated_at)
             VALUES ($1, $2, $3, $3, 0, NOW())
             ON CONFLICT (user_id, asset) DO UPDATE SET
             balance = $3, available = $3, updated_at = NOW()
             RETURNING id`,
            [resolvedId, asset.toUpperCase(), newBalance]
        );

        if (result.rows.length === 0) {
            logger.warn({ userId, asset }, 'Failed to upsert wallet balance');
            return false;
        }

        logger.debug({ userId, asset, newBalance }, 'Balance updated');

        // Invalidate wallet cache
        await cacheDel(`wallet:${resolvedId}`);

        return true;
    }
};

export default walletService;
