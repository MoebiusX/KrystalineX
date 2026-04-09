/**
 * KrystalineX Dashboard Integrity Monitor
 *
 * Continuous synthetic traffic generator + dashboard integrity scorer.
 * Runs on a configurable loop (default 60s) that:
 *
 *   1. Generates synthetic traffic (login, order, trade) to keep panels warm
 *   2. Validates all critical panels against live Prometheus data
 *   3. Checks data freshness for key metric categories
 *   4. Evaluates cross-panel semantic invariants
 *   5. Probes datasource health (Prometheus, Loki, Jaeger)
 *   6. Computes composite Dashboard Integrity Score
 *   7. Pushes all 5 integrity metrics to Prometheus Pushgateway
 *
 * Usage:
 *   node scripts/dashboard-integrity-monitor.js                # Local (Docker)
 *   node scripts/dashboard-integrity-monitor.js --remote       # K8s
 *   node scripts/dashboard-integrity-monitor.js --interval 30  # Custom interval (seconds)
 *   node scripts/dashboard-integrity-monitor.js --once         # Single run (for CI)
 *
 * Metrics pushed:
 *   kx_dashboard_panel_availability_ratio    (0–1)
 *   kx_dashboard_freshness_ratio            (0–1)
 *   kx_dashboard_semantic_consistency_ratio  (0–1)
 *   kx_dashboard_datasource_health_ratio    (0–1)
 *   kx_dashboard_broken_panels              (count)
 */

import config from './config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const intervalIdx = args.indexOf('--interval');
const INTERVAL_SEC = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : 60;

// ── Endpoints ────────────────────────────────────────────────────────────

const PROM_URL = config.observability.prometheusUrl;
const LOKI_URL = config.observability.lokiUrl;
const JAEGER_URL = config.observability.jaegerUrl;
const SERVER_URL = config.server.url;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL || 'http://localhost:9091';

// ── Panel Classification (mirrors validate-dashboard.js) ─────────────────

const CRITICAL_PANELS = [2, 3, 4, 5, 71, 72, 73, 74, 101, 102, 103, 105, 21, 22, 23, 97, 31, 91, 15];

// ── Prometheus Client ────────────────────────────────────────────────────

async function promQuery(expr) {
    const url = `${PROM_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { status: 'error', error: `HTTP ${res.status}`, data: null };
        const json = await res.json();
        if (json.status !== 'success') return { status: 'error', error: json.error || 'query failed', data: null };
        return { status: 'success', data: json.data };
    } catch (err) {
        return { status: 'error', error: err.message, data: null };
    }
}

// ── Dashboard Loader ─────────────────────────────────────────────────────

function loadDashboard() {
    const paths = [
        '/etc/dashboards/unified-observability.json',
        path.join(rootDir, 'k8s', 'charts', 'krystalinex', 'dashboards', 'unified-observability.json'),
        path.join(rootDir, 'config', 'grafana', 'provisioning', 'dashboards', 'unified-observability.json'),
    ];
    for (const p of paths) {
        try { return JSON.parse(readFileSync(p, 'utf-8')); }
        catch { /* try next */ }
    }
    throw new Error('Dashboard JSON not found');
}

function extractPromQueries(dashboard) {
    const queries = [];
    function walk(panels) {
        for (const panel of panels) {
            if (panel.type === 'row') {
                if (panel.panels) walk(panel.panels);
                continue;
            }
            if (panel.datasource?.type === 'loki' || panel.datasource?.type === 'jaeger') continue;
            const targets = (panel.targets || [])
                .filter(t => t.datasource?.type !== 'loki' && t.datasource?.type !== 'jaeger'
                    && t.datasource?.uid !== '-- Grafana --')
                .map(t => t.expr)
                .filter(Boolean);
            if (targets.length > 0) {
                queries.push({ id: panel.id, title: panel.title, exprs: targets, isCritical: CRITICAL_PANELS.includes(panel.id) });
            }
            if (panel.panels) walk(panel.panels);
        }
    }
    walk(dashboard.panels || []);
    return queries;
}

// Template variable resolution
function resolveVars(expr) {
    return expr.replaceAll('$method', '.+').replaceAll('$route', '.+')
        .replaceAll('$status', '.+').replaceAll('$__range', '1h').replaceAll('$__rate_interval', '5m');
}

// ── 1. Synthetic Traffic Generator ───────────────────────────────────────

async function generateSyntheticTraffic() {
    const results = { login: false, healthcheck: false, order: false };

    // Synthetic login
    try {
        const res = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Synthetic': 'true' },
            body: JSON.stringify({
                username: `synthetic_monitor_${Date.now()}`,
                password: 'synthetic_probe_check',
            }),
            signal: AbortSignal.timeout(10000),
        });
        // We expect 401 — we just need the request to flow through metrics
        results.login = res.status === 401 || res.status === 200;
    } catch { results.login = false; }

    // Synthetic health check (always succeeds if server is up)
    try {
        const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
        results.healthcheck = res.ok;
    } catch { results.healthcheck = false; }

    // Synthetic API call to exercise request rate metrics
    try {
        const res = await fetch(`${SERVER_URL}/api/prices`, { signal: AbortSignal.timeout(5000) });
        results.order = res.status < 500;
    } catch { results.order = false; }

    return results;
}

// ── 2. Panel Availability Check ──────────────────────────────────────────

async function checkPanelAvailability(panelQueries) {
    const criticalPanels = panelQueries.filter(p => p.isCritical);
    let availableCount = 0;
    let brokenPanels = 0;

    for (const panel of criticalPanels) {
        let panelOk = false;
        for (const expr of panel.exprs) {
            const result = await promQuery(resolveVars(expr));
            if (result.status === 'success' && result.data?.result?.length > 0) {
                panelOk = true;
                break;
            }
        }
        if (panelOk) {
            availableCount++;
        } else {
            brokenPanels++;
        }
    }

    return {
        ratio: criticalPanels.length > 0 ? availableCount / criticalPanels.length : 1,
        brokenPanels,
        total: criticalPanels.length,
    };
}

// ── 3. Freshness Check ───────────────────────────────────────────────────

async function checkFreshness() {
    const checks = [
        { name: 'nodejs_process_resident_memory_bytes{job="krystalinex-server"}', maxAge: 120 },
        { name: 'node_cpu_seconds_total', maxAge: 120 },
        { name: 'pg_stat_activity_count', maxAge: 120 },
        { name: 'up', maxAge: 120 },
    ];

    let freshCount = 0;
    for (const check of checks) {
        const res = await promQuery(`time() - max(timestamp(${check.name}))`);
        if (res.status === 'success' && res.data?.result?.length > 0) {
            const age = parseFloat(res.data.result[0].value[1]);
            if (age <= check.maxAge) freshCount++;
        }
    }

    return { ratio: checks.length > 0 ? freshCount / checks.length : 1 };
}

// ── 4. Semantic Consistency Check ────────────────────────────────────────

async function checkSemanticConsistency() {
    const invariants = [];
    let passed = 0;

    // Helper: query a single scalar
    async function scalar(expr) {
        const res = await promQuery(resolveVars(expr));
        if (res.status === 'success' && res.data?.result?.length > 0) {
            const v = parseFloat(res.data.result[0].value[1]);
            return isNaN(v) ? null : v;
        }
        return null;
    }

    // Invariant 1: SLO budget consistency
    const availability = await scalar('slo:availability:composite_1h or slo:server:probe_success_ratio_1h or vector(1)');
    const errorBudget = await scalar('slo:availability:error_budget_remaining');
    invariants.push('slo_budget');
    if (availability === null || errorBudget === null || !(availability >= 0.999 && errorBudget < -0.01)) {
        passed++;
    }

    // Invariant 2: Login/user consistency
    const logins = await scalar('kx_logins_total{status="success"}');
    const activeUsers = await scalar('kx_active_users_current');
    invariants.push('login_user');
    if (logins === null || activeUsers === null || !(logins > 10 && activeUsers === 0)) {
        passed++;
    }

    // Invariant 3: Request rate / aggregation
    const reqRate = await scalar('sum(rate(http_requests_total[5m]))');
    const reqLastHour = await scalar('increase(http_requests_total[1h])');
    invariants.push('request_aggregation');
    if (reqRate === null || reqLastHour === null || !(reqRate > 1 && reqLastHour === 0)) {
        passed++;
    }

    // Invariant 4: Services up → CPU/Memory present
    const servicesUp = await scalar('count(up == 1)');
    const cpu = await scalar('rate(node_cpu_seconds_total{mode="idle"}[5m])');
    invariants.push('infra_metrics');
    if (servicesUp === null || servicesUp === 0 || cpu !== null) {
        passed++;
    }

    return { ratio: invariants.length > 0 ? passed / invariants.length : 1 };
}

// ── 5. Datasource Health Check ───────────────────────────────────────────

async function checkDatasourceHealth() {
    const datasources = [];
    let healthy = 0;

    // Prometheus
    datasources.push('prometheus');
    try {
        const res = await fetch(`${PROM_URL}/api/v1/status/runtimeinfo`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) healthy++;
    } catch { /* unhealthy */ }

    // Loki
    datasources.push('loki');
    try {
        const res = await fetch(`${LOKI_URL}/ready`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) healthy++;
    } catch { /* unhealthy */ }

    // Jaeger
    datasources.push('jaeger');
    try {
        const res = await fetch(`${JAEGER_URL}/api/services`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) healthy++;
    } catch { /* unhealthy */ }

    return { ratio: datasources.length > 0 ? healthy / datasources.length : 1 };
}

// ── 6. Push Metrics ──────────────────────────────────────────────────────

async function pushMetrics(metrics) {
    // Push via Prometheus Pushgateway
    const lines = [
        `# HELP kx_dashboard_panel_availability_ratio Fraction of critical panels returning valid data`,
        `# TYPE kx_dashboard_panel_availability_ratio gauge`,
        `kx_dashboard_panel_availability_ratio ${metrics.panelAvailability.toFixed(4)}`,
        `# HELP kx_dashboard_freshness_ratio Fraction of key metrics with fresh data`,
        `# TYPE kx_dashboard_freshness_ratio gauge`,
        `kx_dashboard_freshness_ratio ${metrics.freshness.toFixed(4)}`,
        `# HELP kx_dashboard_semantic_consistency_ratio Fraction of semantic invariants that hold`,
        `# TYPE kx_dashboard_semantic_consistency_ratio gauge`,
        `kx_dashboard_semantic_consistency_ratio ${metrics.semanticConsistency.toFixed(4)}`,
        `# HELP kx_dashboard_datasource_health_ratio Fraction of datasources responding`,
        `# TYPE kx_dashboard_datasource_health_ratio gauge`,
        `kx_dashboard_datasource_health_ratio ${metrics.datasourceHealth.toFixed(4)}`,
        `# HELP kx_dashboard_broken_panels Number of broken critical panels`,
        `# TYPE kx_dashboard_broken_panels gauge`,
        `kx_dashboard_broken_panels ${metrics.brokenPanels}`,
    ];
    const body = lines.join('\n') + '\n';

    try {
        const res = await fetch(`${PUSHGATEWAY_URL}/metrics/job/dashboard_integrity`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body,
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            console.warn(`  ⚠️  Pushgateway HTTP ${res.status} — metrics not pushed`);
        }
    } catch (err) {
        console.warn(`  ⚠️  Pushgateway unreachable (${err.message}) — metrics available via server /metrics only`);
    }
}

// ── Main Loop ────────────────────────────────────────────────────────────

async function runCycle(panelQueries) {
    const t0 = Date.now();
    console.log(`\n🔄 [${new Date().toISOString()}] Dashboard integrity check...`);

    // 1. Generate synthetic traffic
    const synthetic = await generateSyntheticTraffic();
    const syntheticOk = Object.values(synthetic).filter(Boolean).length;
    console.log(`   🧪 Synthetic traffic: ${syntheticOk}/3 probes succeeded (login=${synthetic.login}, health=${synthetic.healthcheck}, api=${synthetic.order})`);

    // 2. Check panel availability
    const availability = await checkPanelAvailability(panelQueries);
    console.log(`   📊 Panel availability: ${(availability.ratio * 100).toFixed(1)}% (${availability.total - availability.brokenPanels}/${availability.total} critical panels OK)`);

    // 3. Check freshness
    const freshness = await checkFreshness();
    console.log(`   ⏱️  Freshness: ${(freshness.ratio * 100).toFixed(1)}%`);

    // 4. Check semantic consistency
    const semantic = await checkSemanticConsistency();
    console.log(`   🧠 Semantic consistency: ${(semantic.ratio * 100).toFixed(1)}%`);

    // 5. Check datasource health
    const datasource = await checkDatasourceHealth();
    console.log(`   🔗 Datasource health: ${(datasource.ratio * 100).toFixed(1)}%`);

    // 6. Compute composite score
    const score = 0.35 * (availability.ratio * 100) +
                  0.25 * (freshness.ratio * 100) +
                  0.25 * (semantic.ratio * 100) +
                  0.15 * (datasource.ratio * 100);
    console.log(`   🛡️  Dashboard Integrity Score: ${score.toFixed(1)}%`);

    // 7. Push metrics
    const metrics = {
        panelAvailability: availability.ratio,
        freshness: freshness.ratio,
        semanticConsistency: semantic.ratio,
        datasourceHealth: datasource.ratio,
        brokenPanels: availability.brokenPanels,
    };
    await pushMetrics(metrics);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`   ✅ Cycle complete in ${elapsed}s`);

    return metrics;
}

async function main() {
    console.log('🛡️  KrystalineX Dashboard Integrity Monitor');
    console.log(`   Target: ${config.isRemote ? '🌐 K8s' : '🏠 Local'}`);
    console.log(`   Prometheus: ${PROM_URL}`);
    console.log(`   Server: ${SERVER_URL}`);
    console.log(`   Pushgateway: ${PUSHGATEWAY_URL}`);
    console.log(`   Interval: ${INTERVAL_SEC}s${ONCE ? ' (single run)' : ''}`);

    // Load dashboard panels once
    const dashboard = loadDashboard();
    const panelQueries = extractPromQueries(dashboard);
    console.log(`   Loaded ${panelQueries.length} panels (${panelQueries.filter(p => p.isCritical).length} critical)`);

    if (ONCE) {
        await runCycle(panelQueries);
        return;
    }

    // Continuous loop
    while (true) {
        try {
            await runCycle(panelQueries);
        } catch (err) {
            console.error(`   ❌ Cycle failed: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, INTERVAL_SEC * 1000));
    }
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
