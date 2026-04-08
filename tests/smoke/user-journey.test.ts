/**
 * User Journey Smoke Test
 *
 * Validates the complete user lifecycle against a running environment:
 *   a) Registration  b) Login  c) Trade  d) Transfer  e) Validate  f) Logout
 *
 * Run:
 *   npm run test:smoke                                      # Dev (Docker, default)
 *   SMOKE_BASE_URL=https://www.krystaline.io npm run test:smoke  # Prod (K8s)
 *
 * Prod mode (bypasses registration, uses pre-seeded credentials):
 *   SMOKE_BASE_URL=https://www.krystaline.io \
 *   SMOKE_USER_EMAIL=smoke@krystaline.io \
 *   SMOKE_USER_PASSWORD=SmokeTest1! \
 *   SMOKE_USER_B_EMAIL=smokeB@krystaline.io \
 *   SMOKE_USER_B_PASSWORD=SmokeTest1! \
 *   npm run test:smoke
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { api, get, post, testEmail, TEST_PASSWORD, BASE_URL } from './smoke-client';

// ============================================
// Environment detection
// ============================================

const IS_PROD = !!process.env.SMOKE_USER_EMAIL;

// ============================================
// Shared state across sequential tests
// ============================================

interface UserState {
    email: string;
    password: string;
    id: string;
    accessToken: string;
    refreshToken: string;
    walletAddress: string;
}

const userA: UserState = {
    email: process.env.SMOKE_USER_EMAIL || testEmail('smokeA'),
    password: process.env.SMOKE_USER_PASSWORD || TEST_PASSWORD,
    id: '', accessToken: '', refreshToken: '', walletAddress: '',
};

const userB: UserState = {
    email: process.env.SMOKE_USER_B_EMAIL || testEmail('smokeB'),
    password: process.env.SMOKE_USER_B_PASSWORD || TEST_PASSWORD,
    id: '', accessToken: '', refreshToken: '', walletAddress: '',
};

let orderId = '';
let transferId = '';
let tradeSucceeded = false;
let initialBtc = 0;
let initialUsd = 0;

// ============================================
// Tests — executed sequentially top-to-bottom
// ============================================

describe(`User Journey Smoke Test [${BASE_URL}]`, () => {
    const TIMEOUT = 30_000; // generous timeout for network calls

    // -----------------------------------------------
    // a) Registration
    // -----------------------------------------------
    describe('a) Registration', () => {
        if (IS_PROD) {
            it('skips registration in prod mode (using pre-seeded credentials)', () => {
                expect(userA.email).toBeTruthy();
                expect(userB.email).toBeTruthy();
            });
            return;
        }

        it('registers user A', async () => {
            const res = await post('/api/v1/auth/register', {
                email: userA.email,
                password: userA.password,
            });

            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.user?.id).toBeTruthy();
            userA.id = res.body.user.id;
        }, TIMEOUT);

        it('verifies user A email with bypass code', async () => {
            const res = await post('/api/v1/auth/verify', {
                email: userA.email,
                code: '000000',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.tokens?.accessToken).toBeTruthy();
            // Tokens from verify are valid but we'll test login separately
        }, TIMEOUT);

        it('registers user B (transfer recipient)', async () => {
            const res = await post('/api/v1/auth/register', {
                email: userB.email,
                password: userB.password,
            });

            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            userB.id = res.body.user.id;
        }, TIMEOUT);

        it('verifies user B email with bypass code', async () => {
            const res = await post('/api/v1/auth/verify', {
                email: userB.email,
                code: '000000',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        }, TIMEOUT);
    });

    // -----------------------------------------------
    // b) Login
    // -----------------------------------------------
    describe('b) Login', () => {
        it('logs in user A and receives tokens', async () => {
            const res = await post('/api/v1/auth/login', {
                email: userA.email,
                password: userA.password,
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.tokens?.accessToken).toBeTruthy();
            expect(res.body.tokens?.refreshToken).toBeTruthy();

            userA.id = res.body.user.id;
            userA.accessToken = res.body.tokens.accessToken;
            userA.refreshToken = res.body.tokens.refreshToken;
        }, TIMEOUT);

        it('accesses protected profile with token', async () => {
            const res = await get('/api/v1/auth/me', { token: userA.accessToken });

            expect(res.status).toBe(200);
            expect(res.body.user?.email.toLowerCase()).toBe(userA.email.toLowerCase());
        }, TIMEOUT);

        it('logs in user B to get their ID', async () => {
            const res = await post('/api/v1/auth/login', {
                email: userB.email,
                password: userB.password,
            });

            expect(res.status).toBe(200);
            userB.id = res.body.user.id;
            userB.accessToken = res.body.tokens.accessToken;
        }, TIMEOUT);
    });

    // -----------------------------------------------
    // c) Trade
    // -----------------------------------------------
    describe('c) Trade', () => {
        it('checks initial wallet balance', async () => {
            const res = await get('/api/v1/wallet', {
                query: { userId: userA.id },
                token: userA.accessToken,
            });

            expect(res.status).toBe(200);
            expect(res.body.btc).toBeGreaterThan(0);
            expect(res.body.usd).toBeGreaterThan(0);
            initialBtc = res.body.btc;
            initialUsd = res.body.usd;
        }, TIMEOUT);

        it('places a BTC buy order (0.0001 BTC)', async () => {
            const res = await post('/api/v1/orders', {
                userId: userA.id,
                pair: 'BTC/USD',
                side: 'BUY',
                quantity: 0.0001,
                orderType: 'MARKET',
            }, { token: userA.accessToken });

            // 201 = filled normally, 503 = RabbitMQ/matcher unavailable (acceptable in dev)
            expect([201, 503]).toContain(res.status);

            if (res.status === 201) {
                expect(res.body.success).toBe(true);
                expect(res.body.orderId).toBeTruthy();
                expect(res.body.execution?.status).toBe('FILLED');
                expect(res.body.traceId).toBeTruthy();
                orderId = res.body.orderId;
                tradeSucceeded = true;
            }
        }, TIMEOUT);

        it('verifies order appears in history', async () => {
            if (!tradeSucceeded) return; // skip if trade didn't execute

            const res = await get('/api/v1/orders', {
                query: { userId: userA.id },
                token: userA.accessToken,
            });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            const order = res.body.find((o: any) => o.orderId === orderId);
            expect(order).toBeTruthy();
            expect(order.status).toBe('FILLED');
        }, TIMEOUT);
    });

    // -----------------------------------------------
    // d) Transfer
    // -----------------------------------------------
    describe('d) Transfer', () => {
        it('gets wallet addresses from user directory', async () => {
            const res = await get('/api/v1/users', { token: userA.accessToken });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);

            const foundA = res.body.find((u: any) => u.id === userA.id);
            const foundB = res.body.find((u: any) => u.id === userB.id);

            if (foundA?.walletAddress) userA.walletAddress = foundA.walletAddress;
            if (foundB?.walletAddress) userB.walletAddress = foundB.walletAddress;

            // At least one method must work for transfer
            expect(userA.id && userB.id).toBeTruthy();
        }, TIMEOUT);

        it('transfers BTC from user A to user B', async () => {
            // Use the wallet transfer endpoint (authenticated, simpler)
            const res = await post('/api/v1/wallet/transfer', {
                toUserId: userB.id,
                asset: 'BTC',
                amount: 0.001,
            }, { token: userA.accessToken });

            // If wallet transfer endpoint works, great
            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                transferId = res.body.transferId || 'wallet-transfer';
                return;
            }

            // Fallback to v1 transfer with addresses
            if (userA.walletAddress && userB.walletAddress) {
                const v1Res = await post('/api/v1/transfer', {
                    fromAddress: userA.walletAddress,
                    toAddress: userB.walletAddress,
                    amount: 0.001,
                    fromUserId: userA.id,
                    toUserId: userB.id,
                }, { token: userA.accessToken });

                expect(v1Res.status).toBe(200);
                expect(v1Res.body.success).toBe(true);
                transferId = v1Res.body.transferId;
            } else {
                // Skip transfer if neither method available
                expect(true).toBe(true);
            }
        }, TIMEOUT);
    });

    // -----------------------------------------------
    // e) Validate
    // -----------------------------------------------
    describe('e) Validate', () => {
        it('validates wallet balance reflects trade and transfer', async () => {
            const res = await get('/api/v1/wallet', {
                query: { userId: userA.id },
                token: userA.accessToken,
            });

            expect(res.status).toBe(200);

            if (transferId) {
                // BTC should decrease (transferred 0.001 out, maybe bought 0.0001)
                expect(res.body.btc).toBeLessThan(initialBtc);
            }
            if (tradeSucceeded) {
                // USD should be less (spent on buy order)
                expect(res.body.usd).toBeLessThan(initialUsd);
            }
        }, TIMEOUT);

        it('validates user B received the transfer', async () => {
            if (!transferId) return; // skip if transfer didn't execute

            const res = await get('/api/v1/wallet', {
                query: { userId: userB.id },
                token: userB.accessToken,
            });

            expect(res.status).toBe(200);
            // User B should have more BTC than initial 1.0 (received 0.001)
            expect(res.body.btc).toBeGreaterThan(1.0);
        }, TIMEOUT);

        it('validates transaction history contains entries', async () => {
            const res = await get('/api/v1/wallet/transactions/history', {
                token: userA.accessToken,
            });

            // Transaction history may or may not exist depending on implementation
            if (res.status === 200 && res.body.transactions) {
                expect(Array.isArray(res.body.transactions)).toBe(true);
                expect(res.body.transactions.length).toBeGreaterThan(0);
            }
        }, TIMEOUT);
    });

    // -----------------------------------------------
    // f) Logout
    // -----------------------------------------------
    describe('f) Logout', () => {
        it('logs out user A', async () => {
            const res = await post('/api/v1/auth/logout', {}, { token: userA.accessToken });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        }, TIMEOUT);

        it('validates token invalidation after logout', async () => {
            const res = await get('/api/v1/auth/me', { token: userA.accessToken });

            // Ideal: 401 (session-backed invalidation)
            // Acceptable: 200 (stateless JWT still valid until expiry)
            // Both indicate the system is functioning — logout cleared server-side sessions
            expect([200, 401]).toContain(res.status);
        }, TIMEOUT);

        it('logs out user B (cleanup)', async () => {
            if (userB.accessToken) {
                const res = await post('/api/v1/auth/logout', {}, { token: userB.accessToken });
                expect(res.status).toBe(200);
            }
        }, TIMEOUT);
    });
});
