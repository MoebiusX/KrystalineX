/**
 * KrystalineX Load Test — Synthetic Traffic Generator
 *
 * Generates realistic exchange traffic at configurable intensity levels.
 * Users are seeded directly into Postgres (pre-verified) and log in via the
 * real auth flow to obtain JWT tokens — no E2E bypass needed.
 *
 * Profiles model "moderate success in a large EU country":
 *   smoke   —   5 VUs,   30s  (sanity check)
 *   light   —  25 VUs,   2m   (baseline)
 *   medium  — 100 VUs,   5m   (sustained load)
 *   heavy   — 500 VUs,  10m   (peak hour)
 *   stress  — 1000 VUs, 15m   (breaking point)
 *
 * Usage:
 *   node scripts/load-test.js [--remote] [--profile smoke|light|medium|heavy|stress]
 *   node scripts/load-test.js --vus 50 --duration 120
 */

import config from './config.js';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;

// ── CLI args ──────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = cliArgs.indexOf(`--${name}`);
    return idx >= 0 && cliArgs[idx + 1] ? cliArgs[idx + 1] : fallback;
}

const PROFILES = {
    smoke:  { vus: 5,    durationSec: 30,   rampUpSec: 5  },
    light:  { vus: 25,   durationSec: 120,  rampUpSec: 15 },
    medium: { vus: 100,  durationSec: 300,  rampUpSec: 30 },
    heavy:  { vus: 500,  durationSec: 600,  rampUpSec: 60 },
    stress: { vus: 1000, durationSec: 900,  rampUpSec: 90 },
};

const profileName = getArg('profile', 'smoke');
const profile = PROFILES[profileName];
if (!profile && !getArg('vus', null)) {
    console.error(`❌ Unknown profile: ${profileName}. Options: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
}

const VUS         = parseInt(getArg('vus', profile?.vus ?? 5));
const DURATION_S  = parseInt(getArg('duration', profile?.durationSec ?? 30));
const RAMP_UP_S   = parseInt(getArg('rampup', profile?.rampUpSec ?? 5));
const BASE_URL    = config.server.internalUrl;
const API_URL     = `${BASE_URL}/api/v1`;

// ── Database ──────────────────────────────────────────────────────────────

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5433'),
    database: process.env.DB_NAME || 'crypto_exchange',
    user: process.env.DB_USER || 'exchange',
    password: process.env.DB_PASSWORD,
};

// ── Stats ─────────────────────────────────────────────────────────────────

const stats = {
    requests: 0,
    successes: 0,
    failures: 0,
    rateLimited: 0,
    latencies: [],
    byEndpoint: {},
    errors: {},
    startTime: 0,
};

function recordRequest(endpoint, latencyMs, success, statusCode) {
    stats.requests++;
    if (success) stats.successes++;
    else stats.failures++;
    if (statusCode === 429) stats.rateLimited++;
    stats.latencies.push(latencyMs);

    if (!stats.byEndpoint[endpoint]) {
        stats.byEndpoint[endpoint] = { count: 0, totalMs: 0, failures: 0 };
    }
    const ep = stats.byEndpoint[endpoint];
    ep.count++;
    ep.totalMs += latencyMs;
    if (!success) ep.failures++;

    if (!success && statusCode !== 429) {
        const key = `${endpoint}:${statusCode}`;
        stats.errors[key] = (stats.errors[key] || 0) + 1;
    }
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function printLiveStats() {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const rps = (stats.requests / elapsed).toFixed(1);
    const p50 = percentile(stats.latencies, 50).toFixed(0);
    const p95 = percentile(stats.latencies, 95).toFixed(0);
    const errRate = stats.requests > 0 ? ((stats.failures / stats.requests) * 100).toFixed(1) : '0.0';
    process.stdout.write(
        `\r⏱  ${elapsed.toFixed(0)}s | ${stats.requests} req (${rps}/s) | P50 ${p50}ms P95 ${p95}ms | ❌ ${errRate}% | 🚦 ${stats.rateLimited} rate-limited   `
    );
}

// ── HTTP helper ───────────────────────────────────────────────────────────

async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const start = Date.now();
    let statusCode = 0;
    try {
        const res = await fetch(`${API_URL}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        statusCode = res.status;
        const data = await res.json().catch(() => ({}));
        const latency = Date.now() - start;
        const success = statusCode >= 200 && statusCode < 400;
        recordRequest(`${method} ${path}`, latency, success, statusCode);
        return { data, status: statusCode, ok: success };
    } catch (err) {
        const latency = Date.now() - start;
        recordRequest(`${method} ${path}`, latency, false, 0);
        return { data: null, status: 0, ok: false, error: err.message };
    }
}

// ── User pool ─────────────────────────────────────────────────────────────

const PASSWORD = 'LoadTest1234!';
let passwordHash;

async function seedUsers(pool, count) {
    console.log(`\n🌱 Seeding ${count} load-test users...`);
    passwordHash = await bcrypt.hash(PASSWORD, 10); // 10 rounds for speed

    const client = await pool.connect();
    try {
        // Check how many already exist
        const existing = await client.query(
            "SELECT count(*) FROM users WHERE email LIKE 'loadtest-%@load.krystaline.io'"
        );
        const existingCount = parseInt(existing.rows[0].count);

        if (existingCount >= count) {
            console.log(`   ✅ ${existingCount} load-test users already exist`);
            // Fetch their IDs
            const result = await client.query(
                "SELECT id, email FROM users WHERE email LIKE 'loadtest-%@load.krystaline.io' ORDER BY email LIMIT $1",
                [count]
            );
            return result.rows;
        }

        // Seed missing users in batches
        const toCreate = count - existingCount;
        console.log(`   Creating ${toCreate} new users (${existingCount} already exist)...`);

        const batchSize = 50;
        const allUsers = [];

        for (let i = existingCount; i < count; i += batchSize) {
            const batch = Math.min(batchSize, count - i);
            const values = [];
            const params = [];
            for (let j = 0; j < batch; j++) {
                const idx = i + j;
                const offset = params.length;
                values.push(`($${offset + 1}, $${offset + 2}, 'verified', 1)`);
                params.push(`loadtest-${String(idx).padStart(5, '0')}@load.krystaline.io`, passwordHash);
            }

            const result = await client.query(
                `INSERT INTO users (email, password_hash, status, kyc_level)
                 VALUES ${values.join(',')}
                 ON CONFLICT (email) DO UPDATE SET status = 'verified'
                 RETURNING id, email`,
                params
            );
            allUsers.push(...result.rows);
        }

        // Create wallets for new users
        console.log('   💰 Creating wallets...');
        for (const user of allUsers) {
            // Check if wallets exist
            const wExists = await client.query('SELECT 1 FROM wallets WHERE user_id = $1 LIMIT 1', [user.id]);
            if (wExists.rows.length === 0) {
                await client.query(
                    `INSERT INTO wallets (user_id, asset, balance, available, locked) VALUES
                     ($1, 'BTC', 1, 1, 0),
                     ($1, 'ETH', 10, 10, 0),
                     ($1, 'USD', 50000, 50000, 0),
                     ($1, 'USDT', 10000, 10000, 0),
                     ($1, 'EUR', 45000, 45000, 0)`,
                    [user.id]
                );
            }
        }

        // Return all users
        const result = await client.query(
            "SELECT id, email FROM users WHERE email LIKE 'loadtest-%@load.krystaline.io' ORDER BY email LIMIT $1",
            [count]
        );
        console.log(`   ✅ ${result.rows.length} users ready with wallets`);
        return result.rows;
    } finally {
        client.release();
    }
}

// ── VU (Virtual User) ────────────────────────────────────────────────────

/**
 * Traffic mix modelled on a real exchange:
 *   40% — price/market reads (unauthenticated, high frequency)
 *   20% — balance/wallet checks (authenticated)
 *   15% — place order (BUY/SELL)
 *   10% — conversion quote
 *    5% — transfer
 *    5% — public transparency endpoints
 *    5% — monitor/health
 */
const ACTIONS = [
    { weight: 40, fn: actionPriceRead },
    { weight: 20, fn: actionWalletRead },
    { weight: 15, fn: actionPlaceOrder },
    { weight: 10, fn: actionConversionQuote },
    { weight: 5,  fn: actionTransfer },
    { weight: 5,  fn: actionPublicTransparency },
    { weight: 5,  fn: actionMonitorHealth },
];

// Build weighted lookup
const weightedActions = [];
for (const a of ACTIONS) {
    for (let i = 0; i < a.weight; i++) weightedActions.push(a.fn);
}

function pickAction() {
    return weightedActions[Math.floor(Math.random() * weightedActions.length)];
}

const PAIRS = ['BTC/USD', 'ETH/USD', 'BTC/EUR'];
const ASSETS = ['BTC', 'ETH'];

async function actionPriceRead(_vu) {
    const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
    const asset = pair.split('/')[0];
    await api('GET', `/trade/price/${asset}`);
}

async function actionWalletRead(vu) {
    await api('GET', '/wallet/balances', null, vu.token);
}

async function actionPlaceOrder(vu) {
    const side = Math.random() > 0.5 ? 'buy' : 'sell';
    const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
    const quantity = +(Math.random() * 0.01 + 0.001).toFixed(6);
    const price = pair.startsWith('BTC') ? randomBetween(40000, 70000) : randomBetween(2000, 4000);

    await api('POST', '/trade/order', {
        pair,
        side,
        quantity,
        price,
    }, vu.token);
}

async function actionConversionQuote(vu) {
    const fromAsset = Math.random() > 0.5 ? 'BTC' : 'ETH';
    const toAsset = 'USD';
    const amount = +(Math.random() * 0.1 + 0.01).toFixed(6);

    await api('POST', '/trade/convert/quote', { fromAsset, toAsset, amount }, vu.token);
}

async function actionTransfer(vu) {
    // Transfer tiny amounts to a random other user
    if (vu.allUserIds.length < 2) return;
    const others = vu.allUserIds.filter(id => id !== vu.userId);
    const toUserId = others[Math.floor(Math.random() * others.length)];
    const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];

    await api('POST', '/wallet/transfer', {
        toUserId,
        asset,
        amount: 0.0001,
    }, vu.token);
}

async function actionPublicTransparency(_vu) {
    const endpoints = ['/public/status', '/public/metrics', '/public/trades'];
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    await api('GET', ep);
}

async function actionMonitorHealth(_vu) {
    const endpoints = ['/monitor/health', '/monitor/baselines', '/monitor/anomalies'];
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    await api('GET', ep);
}

// ── VU lifecycle ──────────────────────────────────────────────────────────

async function loginUser(email) {
    const res = await api('POST', '/auth/login', { email, password: PASSWORD });
    if (res.ok && res.data?.tokens?.accessToken) {
        return {
            token: res.data.tokens.accessToken,
            userId: res.data.user?.id,
        };
    }
    return null;
}

async function runVU(vuId, user, allUserIds, durationMs) {
    // Login
    const session = await loginUser(user.email);
    if (!session) {
        // If login fails, still do unauthenticated reads
        const vu = { userId: user.id, token: null, allUserIds };
        const end = Date.now() + durationMs;
        while (Date.now() < end) {
            await actionPriceRead(vu);
            await sleep(randomBetween(500, 2000));
        }
        return;
    }

    const vu = { userId: session.userId || user.id, token: session.token, allUserIds };
    const end = Date.now() + durationMs;

    // Think time between actions: 200ms–2000ms (models real user behavior)
    while (Date.now() < end) {
        const action = pickAction();
        try {
            await action(vu);
        } catch {
            // Individual action failure shouldn't kill the VU
        }
        await sleep(randomBetween(200, 2000));
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomBetween(min, max) { return Math.floor(Math.random() * (max - min) + min); }

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log(' 🔥 KrystalineX Load Test');
    console.log('═'.repeat(60));
    console.log(`  Profile:    ${profileName}`);
    console.log(`  VUs:        ${VUS}`);
    console.log(`  Duration:   ${DURATION_S}s`);
    console.log(`  Ramp-up:    ${RAMP_UP_S}s`);
    console.log(`  Target:     ${BASE_URL}`);
    console.log(`  DB:         ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    console.log('═'.repeat(60));

    // Health check
    try {
        const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('\n✅ Server is healthy');
    } catch (err) {
        console.error(`\n❌ Server not reachable at ${BASE_URL}/health: ${err.message}`);
        process.exit(1);
    }

    // Seed users
    const pool = new Pool(dbConfig);
    let users;
    try {
        users = await seedUsers(pool, VUS);
    } catch (err) {
        console.error(`\n❌ Failed to seed users: ${err.message}`);
        console.error('   Make sure the database is accessible and DB_PASSWORD is set if needed.');
        await pool.end();
        process.exit(1);
    }
    await pool.end();

    const allUserIds = users.map(u => u.id);

    // Start load
    console.log(`\n🚀 Ramping up ${VUS} virtual users over ${RAMP_UP_S}s...\n`);
    stats.startTime = Date.now();

    const liveInterval = setInterval(printLiveStats, 1000);
    const vuPromises = [];
    const rampDelay = (RAMP_UP_S * 1000) / VUS;

    for (let i = 0; i < VUS; i++) {
        const user = users[i % users.length];
        const vuDuration = (DURATION_S * 1000) - (i * rampDelay);
        if (vuDuration <= 0) break;

        vuPromises.push(runVU(i, user, allUserIds, vuDuration));

        if (rampDelay > 0 && i < VUS - 1) {
            await sleep(rampDelay);
        }
    }

    await Promise.all(vuPromises);
    clearInterval(liveInterval);

    // Final report
    printReport();
}

function printReport() {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const sorted = [...stats.latencies].sort((a, b) => a - b);

    console.log('\n\n' + '═'.repeat(60));
    console.log(' 📊 Load Test Results');
    console.log('═'.repeat(60));
    console.log(`  Duration:       ${elapsed.toFixed(1)}s`);
    console.log(`  Total requests: ${stats.requests}`);
    console.log(`  Throughput:     ${(stats.requests / elapsed).toFixed(1)} req/s`);
    console.log(`  Successes:      ${stats.successes} (${((stats.successes / stats.requests) * 100).toFixed(1)}%)`);
    console.log(`  Failures:       ${stats.failures} (${((stats.failures / stats.requests) * 100).toFixed(1)}%)`);
    console.log(`  Rate limited:   ${stats.rateLimited}`);
    console.log('');
    console.log('  ┌─ Latency ──────────────────────────────────────────┐');
    console.log(`  │  P50:  ${percentile(sorted, 50).toFixed(0).padStart(6)}ms                                  │`);
    console.log(`  │  P90:  ${percentile(sorted, 90).toFixed(0).padStart(6)}ms                                  │`);
    console.log(`  │  P95:  ${percentile(sorted, 95).toFixed(0).padStart(6)}ms                                  │`);
    console.log(`  │  P99:  ${percentile(sorted, 99).toFixed(0).padStart(6)}ms                                  │`);
    console.log(`  │  Max:  ${(sorted[sorted.length - 1] || 0).toFixed(0).padStart(6)}ms                                  │`);
    console.log('  └────────────────────────────────────────────────────┘');

    console.log('\n  ┌─ By Endpoint ─────────────────────────────────────┐');
    const endpoints = Object.entries(stats.byEndpoint)
        .sort((a, b) => b[1].count - a[1].count);
    for (const [ep, data] of endpoints) {
        const avg = (data.totalMs / data.count).toFixed(0);
        const errPct = data.failures > 0 ? ` (${data.failures} err)` : '';
        console.log(`  │  ${ep.padEnd(30)} ${String(data.count).padStart(5)} req  avg ${avg}ms${errPct}`);
    }
    console.log('  └────────────────────────────────────────────────────┘');

    if (Object.keys(stats.errors).length > 0) {
        console.log('\n  ┌─ Errors ──────────────────────────────────────────┐');
        for (const [key, count] of Object.entries(stats.errors).sort((a, b) => b[1] - a[1])) {
            console.log(`  │  ${key.padEnd(40)} × ${count}`);
        }
        console.log('  └────────────────────────────────────────────────────┘');
    }

    console.log('\n' + '═'.repeat(60));

    // Exit code based on error rate
    const errRate = stats.requests > 0 ? (stats.failures / stats.requests) * 100 : 0;
    if (errRate > 10) {
        console.log('  ⚠️  Error rate > 10% — DEGRADED');
        process.exit(1);
    } else {
        console.log('  ✅ Load test completed successfully');
        process.exit(0);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⏹  Interrupted — printing results...');
    printReport();
});

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
