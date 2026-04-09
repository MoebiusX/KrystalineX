/**
 * KrystalineX Chaos Scenarios — On-Demand Anomaly Generator
 *
 * Triggers realistic failure conditions that fire alerts, anomaly detection,
 * and LLM-powered root-cause analysis. Designed for demos.
 *
 * Usage:
 *   node scripts/chaos-scenarios.js <scenario> [options]
 *
 * Scenarios:
 *   latency-spike       — 3-8s delays on trade/wallet (triggers HighLatencyP99, anomaly SEV3+)
 *   error-burst         — 40% 500 errors for 2min (triggers HighErrorRate, SLO burn)
 *   slow-degradation    — Gradual latency increase 200ms→6s over 5min (realistic memory leak)
 *   intermittent-errors  — Sporadic 502s, 15% (flaky upstream dependency)
 *   cascade-failure     — Multi-phase escalation: wallet→trade→full outage
 *   brute-force         — Rapid failed logins (triggers BruteForceAttack security alert)
 *   whale-trade         — Places abnormally large orders (triggers amount anomaly detection)
 *   rate-limit-flood    — Floods API to trigger RateLimitAbuse alert
 *
 * Options:
 *   --duration <sec>    Override scenario duration
 *   --remote            Target krystaline.io instead of localhost
 *   --key <key>         Chaos API key (or set CHAOS_API_KEY env var)
 *   --stop              Stop any running chaos scenario
 *   --status            Check current chaos status
 *
 * Examples:
 *   node scripts/chaos-scenarios.js latency-spike
 *   node scripts/chaos-scenarios.js cascade-failure --duration 120
 *   node scripts/chaos-scenarios.js brute-force
 *   node scripts/chaos-scenarios.js --stop
 *   node scripts/chaos-scenarios.js --status
 */

import config from './config.js';

// ── CLI parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const BASE_URL = config.server.internalUrl;
const API_URL = `${BASE_URL}/api/v1`;
const CHAOS_API_KEY = getArg('key', process.env.CHAOS_API_KEY || 'demo-chaos-key');
const SCENARIO = args.find(a => !a.startsWith('--'));
const DURATION = getArg('duration', null);

// ── Helpers ──────────────────────────────────────────────────────────────

const headers = {
    'Content-Type': 'application/json',
    'X-Chaos-Key': CHAOS_API_KEY,
};

async function chaosRequest(method, path, body) {
    const url = `${API_URL}/monitor${path}`;
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();

    if (!res.ok) {
        console.error(`❌ ${res.status}: ${data.error || JSON.stringify(data)}`);
        process.exit(1);
    }
    return data;
}

async function login(username, password) {
    const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    return res;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function progressBar(current, total, label) {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round(pct / 2);
    const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
    process.stdout.write(`\r  ${bar} ${pct}% — ${label}`);
}

// ── Server-side scenarios (via chaos API) ────────────────────────────────

async function startServerScenario(scenario) {
    console.log(`\n🔥 Starting server-side scenario: ${scenario}`);
    const body = { scenario };
    if (DURATION) body.duration = parseInt(DURATION);

    const result = await chaosRequest('POST', '/chaos/start', body);
    console.log(`   ${result.message}`);
    console.log(`   ${result.description}`);

    if (result.config?.expiresAt) {
        const remaining = Math.round((new Date(result.config.expiresAt) - Date.now()) / 1000);
        console.log(`   ⏱  Expires in ${remaining}s`);
    }

    console.log('\n📊 Monitor at: https://www.krystaline.io/monitor');
    console.log('   Stop with:  node scripts/chaos-scenarios.js --stop\n');

    // Show countdown
    const totalSec = DURATION ? parseInt(DURATION) : result.config?.expiresAt
        ? Math.round((new Date(result.config.expiresAt) - Date.now()) / 1000)
        : 120;

    for (let i = 0; i < totalSec; i++) {
        progressBar(i, totalSec, `${totalSec - i}s remaining`);
        await sleep(1000);
    }
    progressBar(totalSec, totalSec, 'Complete!\n');
}

// ── Client-side scenarios (attack patterns) ──────────────────────────────

async function bruteForce() {
    const duration = parseInt(DURATION || '60');
    console.log('\n🔓 Starting brute-force attack simulation');
    console.log(`   Sending rapid failed logins for ${duration}s`);
    console.log('   Target: BruteForceAttack alert (>20 failures in 5m)\n');

    const usernames = ['admin', 'root', 'exchange_admin', 'carlos', 'test'];
    let attempts = 0;
    const startTime = Date.now();

    while ((Date.now() - startTime) / 1000 < duration) {
        const username = usernames[Math.floor(Math.random() * usernames.length)];
        try {
            await login(username, 'wrong-password-' + Math.random().toString(36).slice(2));
            attempts++;
        } catch {
            attempts++;
        }

        progressBar(
            (Date.now() - startTime) / 1000,
            duration,
            `${attempts} failed login attempts`
        );

        // ~4 attempts per second to quickly exceed the 20/5min threshold
        await sleep(250);
    }

    console.log(`\n✅ Sent ${attempts} failed login attempts`);
    console.log('   Alert should fire within 1-2 minutes');
}

async function whaleTrade() {
    const duration = parseInt(DURATION || '90');
    console.log('\n🐋 Starting whale trade injection');
    console.log(`   Placing abnormally large orders for ${duration}s`);
    console.log('   Target: Amount anomaly detection (3σ+ whale alerts)\n');

    // First, login as a test user
    const loginRes = await login('carlos', 'carlos123');
    if (!loginRes.ok) {
        console.error('❌ Could not login as test user. Make sure the dev stack is running.');
        console.error('   Try: node scripts/load-test.js (to seed users first)');
        process.exit(1);
    }
    const { token } = await loginRes.json();

    const pairs = ['BTC/USD', 'ETH/USD'];
    let trades = 0;
    const startTime = Date.now();

    while ((Date.now() - startTime) / 1000 < duration) {
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        const side = Math.random() > 0.5 ? 'buy' : 'sell';
        // Whale-sized orders: 10-50x normal
        const quantity = pair.startsWith('BTC')
            ? (0.5 + Math.random() * 5).toFixed(4)     // 0.5-5.5 BTC (normal is ~0.001-0.01)
            : (20 + Math.random() * 100).toFixed(4);    // 20-120 ETH

        const price = pair.startsWith('BTC')
            ? Math.round(60000 + Math.random() * 5000)
            : Math.round(3000 + Math.random() * 500);

        try {
            await fetch(`${API_URL}/trade/order`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ pair, side, price, quantity: parseFloat(quantity) }),
            });
            trades++;
        } catch {
            // Expected — may get rejected due to insufficient balance
        }

        progressBar(
            (Date.now() - startTime) / 1000,
            duration,
            `${trades} whale orders placed`
        );

        await sleep(3000); // One whale order every 3s
    }

    console.log(`\n✅ Placed ${trades} whale-sized orders`);
    console.log('   Amount anomalies should appear within 30s');
}

async function rateLimitFlood() {
    const duration = parseInt(DURATION || '30');
    console.log('\n🌊 Starting rate limit flood');
    console.log(`   Hammering API for ${duration}s (300+ req/min threshold)`);
    console.log('   Target: RateLimitAbuse alert (>50 rate limits in 5m)\n');

    let requests = 0;
    let rateLimited = 0;
    const startTime = Date.now();

    while ((Date.now() - startTime) / 1000 < duration) {
        // Fire 10 requests concurrently
        const batch = Array.from({ length: 10 }, () =>
            fetch(`${API_URL}/trade/price/BTC`).then(r => {
                requests++;
                if (r.status === 429) rateLimited++;
                return r;
            }).catch(() => { requests++; })
        );

        await Promise.all(batch);

        progressBar(
            (Date.now() - startTime) / 1000,
            duration,
            `${requests} requests, ${rateLimited} rate-limited`
        );

        await sleep(50); // ~200 requests/second
    }

    console.log(`\n✅ Sent ${requests} requests, ${rateLimited} rate-limited`);
    console.log('   RateLimitAbuse alert should fire within 2 minutes');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
    // Handle --stop
    if (hasFlag('stop')) {
        const result = await chaosRequest('POST', '/chaos/stop');
        console.log(`\n${result.message}\n`);
        return;
    }

    // Handle --status
    if (hasFlag('status')) {
        const status = await chaosRequest('GET', '/chaos/status');
        if (status.enabled) {
            console.log(`\n🔥 Chaos ACTIVE: ${status.scenario || 'custom'}`);
            console.log(`   Delay: ${status.delayMs}ms, Error rate: ${(status.errorRate * 100).toFixed(0)}%`);
            console.log(`   Routes: ${status.targetRoutes?.join(', ') || 'all'}`);
            console.log(`   Remaining: ${status.remainingSeconds}s\n`);
        } else {
            console.log('\n✅ No chaos active — system operating normally\n');
        }
        return;
    }

    // Validate scenario
    if (!SCENARIO) {
        console.log(`
🔥 KrystalineX Chaos Scenarios

  Server-side (injected via middleware):
    latency-spike         3-8s delays → HighLatencyP99 + anomaly detection
    error-burst           40% 500 errors → HighErrorRate + SLO burn
    slow-degradation      Gradual 200ms→6s → realistic memory leak pattern
    intermittent-errors   Sporadic 502s → flaky dependency simulation
    cascade-failure       Multi-phase escalation → full system degradation

  Client-side (attack patterns):
    brute-force           Rapid failed logins → BruteForceAttack security alert
    whale-trade           Large orders → amount anomaly (whale detection)
    rate-limit-flood      API flood → RateLimitAbuse alert

  Commands:
    --stop                Stop any running scenario
    --status              Check current chaos status

  Options:
    --duration <sec>      Override scenario duration
    --key <key>           Chaos API key
    --remote              Target krystaline.io

  Example:
    node scripts/chaos-scenarios.js latency-spike --duration 60
`);
        return;
    }

    // Server-side scenarios
    const serverScenarios = ['latency-spike', 'error-burst', 'slow-degradation', 'intermittent-errors', 'cascade-failure'];
    if (serverScenarios.includes(SCENARIO)) {
        await startServerScenario(SCENARIO);
        return;
    }

    // Client-side scenarios
    switch (SCENARIO) {
        case 'brute-force':
            await bruteForce();
            break;
        case 'whale-trade':
            await whaleTrade();
            break;
        case 'rate-limit-flood':
            await rateLimitFlood();
            break;
        default:
            console.error(`❌ Unknown scenario: ${SCENARIO}`);
            console.error('   Run without arguments to see available scenarios.');
            process.exit(1);
    }
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
