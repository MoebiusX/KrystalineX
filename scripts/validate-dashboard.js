/**
 * KrystalineX Dashboard Validator
 *
 * Production-grade tool that validates every Grafana dashboard panel
 * against live Prometheus data. Catches empty panels, stale data,
 * semantic inconsistencies, and query errors BEFORE they embarrass
 * you in a demo.
 *
 * Validates across four dimensions:
 *   1. Data presence   — panels should not be empty unexpectedly
 *   2. Query health    — PromQL must execute without errors
 *   3. Freshness       — data must be recent
 *   4. Semantic sanity  — cross-panel invariants must hold
 *
 * Usage:
 *   node scripts/validate-dashboard.js              # Local (Docker)
 *   node scripts/validate-dashboard.js --remote     # K8s (krystaline.io)
 *   node scripts/validate-dashboard.js --ci         # CI mode (exit 1 on failures)
 *   node scripts/validate-dashboard.js --json       # JSON output for automation
 *
 * Exit codes:
 *   0 = All critical panels healthy
 *   1 = Critical panel failures detected
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
const CI_MODE = args.includes('--ci');
const JSON_OUTPUT = args.includes('--json');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// ── Colors ───────────────────────────────────────────────────────────────

const c = JSON_OUTPUT ? {
    reset: '', red: '', green: '', yellow: '', blue: '', cyan: '', dim: '', bold: '',
} : {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

// ── Panel Classification ─────────────────────────────────────────────────
// CRITICAL:           Must ALWAYS have data when the system is running
// TRAFFIC_DEPENDENT:  Expected to have data when traffic is flowing
// ACTIVITY_DEPENDENT: Only has data when specific activities occur
// INFORMATIONAL:      May legitimately be empty/zero

const PANEL_TIER = {
    // System Health — always present
    2:   'CRITICAL',       // CPU Usage
    3:   'CRITICAL',       // Memory Usage
    4:   'CRITICAL',       // Disk Usage
    5:   'CRITICAL',       // Services Up

    // SLO — always present (recording rules)
    71:  'CRITICAL',       // Availability SLO
    72:  'CRITICAL',       // Latency SLO
    73:  'CRITICAL',       // Error Budget Remaining
    74:  'CRITICAL',       // Error Burn Rate

    // Alert Status — always present (may be 0)
    101: 'CRITICAL',       // Firing Alerts
    102: 'CRITICAL',       // Pending Alerts
    103: 'CRITICAL',       // Critical Firing
    105: 'CRITICAL',       // Warnings

    // Database — always present when postgres-exporter is enabled
    21:  'CRITICAL',       // Active DB Connections
    22:  'CRITICAL',       // Database Operations
    23:  'CRITICAL',       // Database Size

    // Infrastructure
    96:  'TRAFFIC_DEPENDENT',  // Active HTTP Connections
    97:  'CRITICAL',           // Node.js Event Loop Lag
    98:  'TRAFFIC_DEPENDENT',  // RabbitMQ Queue Depth by Queue

    // Application — need traffic
    11:  'TRAFFIC_DEPENDENT',  // HTTP Request Rate
    12:  'TRAFFIC_DEPENDENT',  // Response Latency
    14:  'TRAFFIC_DEPENDENT',  // Requests Last Hour
    15:  'CRITICAL',           // Server Memory
    115: 'TRAFFIC_DEPENDENT',  // Server Errors (5xx)
    116: 'TRAFFIC_DEPENDENT',  // Client Errors (4xx)

    // Security
    43:  'TRAFFIC_DEPENDENT',  // Security Events
    44:  'TRAFFIC_DEPENDENT',  // High/Critical Events
    45:  'TRAFFIC_DEPENDENT',  // Failed Logins
    46:  'TRAFFIC_DEPENDENT',  // Rate Limits
    47:  'TRAFFIC_DEPENDENT',  // Successful Logins

    // Business KPIs — need trading activity
    81:  'TRAFFIC_DEPENDENT',  // Active Users
    82:  'ACTIVITY_DEPENDENT', // Trade Volume
    83:  'ACTIVITY_DEPENDENT', // Orders Processed
    84:  'TRAFFIC_DEPENDENT',  // Login Success Rate
    85:  'ACTIVITY_DEPENDENT', // Trade Value

    // Order Matcher — need orders
    51:  'ACTIVITY_DEPENDENT', // Orders Last Hour
    52:  'ACTIVITY_DEPENDENT', // Order Processing Rate
    53:  'ACTIVITY_DEPENDENT', // Matcher Latency
    54:  'ACTIVITY_DEPENDENT', // Avg Slippage
    55:  'ACTIVITY_DEPENDENT', // Slippage Distribution

    // RabbitMQ
    31:  'CRITICAL',           // Queue Messages (should always report, even 0)
    32:  'TRAFFIC_DEPENDENT',  // Message Throughput

    // Circuit Breakers & Anomalies
    91:  'CRITICAL',           // Circuit Breaker State
    92:  'INFORMATIONAL',      // Circuit Breaker Trips
    93:  'INFORMATIONAL',      // Anomalies Detected

    // LLM Analytics
    61:  'INFORMATIONAL',      // LLM Events by Severity
    62:  'INFORMATIONAL',      // Queue Depth
    63:  'INFORMATIONAL',      // LLM Analysis Duration
    64:  'INFORMATIONAL',      // Dropped Events
    65:  'INFORMATIONAL',      // Analysis by Use Case

    // Alerts table
    104: 'INFORMATIONAL',      // Active Alerts table
};

// ── Semantic Invariants ──────────────────────────────────────────────────
// Cross-panel rules that MUST hold for the dashboard to make sense.
// Each invariant references panel results by ID.

function checkSemanticInvariants(results) {
    const violations = [];
    const r = (id) => results.get(id);

    // Helper to get a scalar value from a panel result
    const scalar = (id) => {
        const panel = r(id);
        if (!panel || !panel.queryResults) return null;
        for (const qr of panel.queryResults) {
            if (qr.value !== null && qr.value !== undefined) return qr.value;
        }
        return null;
    };

    // 1. If availability >= 99.9%, error budget should be >= 0
    const availability = scalar(71);
    const errorBudget = scalar(73);
    if (availability !== null && errorBudget !== null) {
        if (availability >= 0.999 && errorBudget < -0.01) {
            violations.push({
                severity: 'ERROR',
                rule: 'SLO_BUDGET_CONSISTENCY',
                message: `Availability = ${(availability * 100).toFixed(1)}% but Error Budget = ${(errorBudget * 100).toFixed(1)}% — budget should be positive when availability meets SLO`,
                panels: [71, 73],
            });
        }
    }

    // 2. If successful logins > 0, active users should be > 0
    const logins = scalar(47);
    const activeUsers = scalar(81);
    if (logins !== null && activeUsers !== null) {
        if (logins > 10 && activeUsers === 0) {
            violations.push({
                severity: 'WARNING',
                rule: 'LOGIN_USER_CONSISTENCY',
                message: `Successful Logins = ${logins} but Active Users = ${activeUsers} — session tracking may be broken`,
                panels: [47, 81],
            });
        }
    }

    // 3. If HTTP request rate > 0, requests last hour should be > 0
    const requestRate = scalar(11);
    const requestsLastHour = scalar(14);
    if (requestRate !== null && requestsLastHour !== null) {
        if (requestRate > 1 && requestsLastHour === 0) {
            violations.push({
                severity: 'ERROR',
                rule: 'REQUEST_AGGREGATION_CONSISTENCY',
                message: `HTTP Request Rate = ${requestRate.toFixed(1)} req/s but Requests Last Hour = 0 — aggregation query likely broken`,
                panels: [11, 14],
            });
        }
    }

    // 4. If services up > 0, CPU/Memory should have data
    const servicesUp = scalar(5);
    const cpu = scalar(2);
    const memory = scalar(3);
    if (servicesUp !== null && servicesUp > 0) {
        if (cpu === null) {
            violations.push({
                severity: 'ERROR',
                rule: 'INFRA_METRICS_PRESENT',
                message: `${servicesUp} services up but CPU Usage has no data — node-exporter may be down`,
                panels: [5, 2],
            });
        }
        if (memory === null) {
            violations.push({
                severity: 'ERROR',
                rule: 'INFRA_METRICS_PRESENT',
                message: `${servicesUp} services up but Memory Usage has no data — node-exporter may be down`,
                panels: [5, 3],
            });
        }
    }

    // 5. If login success rate exists but logins_total doesn't, metric name mismatch
    const loginSuccessRate = scalar(84);
    if (loginSuccessRate === null && logins !== null && logins > 0) {
        violations.push({
            severity: 'WARNING',
            rule: 'LOGIN_RATE_CONSISTENCY',
            message: `Successful Logins = ${logins} but Login Success Rate panel has no data — possible metric name mismatch`,
            panels: [47, 84],
        });
    }

    return violations;
}

// ── Prometheus Client ────────────────────────────────────────────────────

const PROM_URL = config.observability.prometheusUrl;
const LOKI_URL = config.observability.lokiUrl;

async function promQuery(expr) {
    const url = `${PROM_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            return { status: 'error', error: `HTTP ${res.status}`, data: null };
        }
        const json = await res.json();
        if (json.status !== 'success') {
            return { status: 'error', error: json.error || 'query failed', data: null };
        }
        return { status: 'success', data: json.data };
    } catch (err) {
        return { status: 'error', error: err.message, data: null };
    }
}

async function lokiQuery(expr) {
    const url = `${LOKI_URL}/loki/api/v1/query?query=${encodeURIComponent(expr)}&limit=5`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            return { status: 'error', error: `HTTP ${res.status}`, data: null };
        }
        const json = await res.json();
        if (json.status !== 'success') {
            return { status: 'error', error: json.error || 'query failed', data: null };
        }
        return { status: 'success', data: json.data };
    } catch (err) {
        return { status: 'error', error: err.message, data: null };
    }
}

let lokiAvailable = null;
async function checkLokiAvailability() {
    if (lokiAvailable !== null) return lokiAvailable;
    const res = await lokiQuery('{job=~".+"}');
    lokiAvailable = res.status === 'success';
    return lokiAvailable;
}

// ── Dashboard Parser ─────────────────────────────────────────────────────

function loadDashboard() {
    // Try K8s dashboard first, fall back to Docker dashboard
    const paths = [
        path.join(rootDir, 'k8s', 'charts', 'krystalinex', 'dashboards', 'unified-observability.json'),
        path.join(rootDir, 'config', 'grafana', 'provisioning', 'dashboards', 'unified-observability.json'),
    ];

    for (const p of paths) {
        try {
            return JSON.parse(readFileSync(p, 'utf-8'));
        } catch { /* try next */ }
    }
    throw new Error('Dashboard JSON not found');
}

function extractPanels(dashboard) {
    const panels = [];
    const rows = [];

    function walk(panelList, currentRow) {
        for (const panel of panelList) {
            if (panel.type === 'row') {
                rows.push({ id: panel.id, title: panel.title });
                if (panel.panels) walk(panel.panels, panel.title);
                currentRow = panel.title;
                continue;
            }

            // Detect panel-level datasource
            const panelDsType = panel.datasource?.type;

            // Loki panels — validate via Loki API
            if (panelDsType === 'loki') {
                const lokiTargets = (panel.targets || [])
                    .map(t => ({ expr: t.expr, refId: t.refId }))
                    .filter(t => t.expr);

                panels.push({
                    id: panel.id,
                    title: panel.title,
                    type: panel.type,
                    row: currentRow,
                    targets: lokiTargets,
                    tier: PANEL_TIER[panel.id] || 'INFORMATIONAL',
                    queryEngine: 'loki',
                    skip: false,
                });
                continue;
            }

            // Extract PromQL targets (filter out any target-level Loki/Jaeger)
            const targets = (panel.targets || [])
                .filter(t => t.datasource?.type !== 'loki' && t.datasource?.type !== 'jaeger'
                    && t.datasource?.uid !== '-- Grafana --')
                .map(t => ({
                    expr: t.expr,
                    refId: t.refId,
                    legendFormat: t.legendFormat,
                }))
                .filter(t => t.expr);

            if (targets.length === 0 && panel.type !== 'row') {
                // Non-Prometheus panel (Jaeger, text, etc.)
                const dsTypes = (panel.targets || []).map(t => t.datasource?.type).filter(Boolean);
                panels.push({
                    id: panel.id,
                    title: panel.title,
                    type: panel.type,
                    row: currentRow,
                    targets: [],
                    datasource: dsTypes[0] || panelDsType || 'unknown',
                    skip: true,
                });
                continue;
            }

            panels.push({
                id: panel.id,
                title: panel.title,
                type: panel.type,
                row: currentRow,
                targets,
                tier: PANEL_TIER[panel.id] || 'INFORMATIONAL',
                queryEngine: 'prometheus',
                skip: false,
            });

            // Recurse into nested panels (grid layout)
            if (panel.panels) walk(panel.panels, currentRow);
        }
    }

    walk(dashboard.panels || [], 'Ungrouped');
    return { panels, rows };
}

// ── Query Execution ──────────────────────────────────────────────────────

// Template variables — resolve to match-all for validation
const TEMPLATE_DEFAULTS = {
    '$method': '.+',
    '$route': '.+',
    '$status': '.+',
    '$__range': '1h',
    '$__rate_interval': '5m',
};

function resolveTemplateVars(expr) {
    let resolved = expr;
    for (const [k, v] of Object.entries(TEMPLATE_DEFAULTS)) {
        resolved = resolved.replaceAll(k, v);
    }
    return resolved;
}

async function validatePanel(panel) {
    if (panel.skip) {
        return {
            ...panel,
            status: 'SKIPPED',
            reason: `Non-Prometheus datasource (${panel.datasource})`,
            queryResults: [],
        };
    }

    // Loki panels — validate via Loki API
    if (panel.queryEngine === 'loki') {
        return validateLokiPanel(panel);
    }

    const queryResults = [];
    let hasData = false;
    let hasError = false;
    let scalarValue = null;

    for (const target of panel.targets) {
        const expr = resolveTemplateVars(target.expr);
        const result = await promQuery(expr);

        if (result.status === 'error') {
            hasError = true;
            queryResults.push({
                refId: target.refId,
                expr: target.expr,
                status: 'ERROR',
                error: result.error,
                value: null,
                seriesCount: 0,
            });
            continue;
        }

        const data = result.data;
        const resultType = data.resultType;
        const results = data.result || [];
        const seriesCount = results.length;

        // Extract scalar value for semantic checks
        let value = null;
        if (seriesCount === 1) {
            const v = resultType === 'vector' ? parseFloat(results[0].value[1]) : null;
            if (v !== null && !isNaN(v)) value = v;
        } else if (seriesCount > 1) {
            // Sum all values for aggregate scalar
            const sum = results.reduce((acc, r) => {
                const v = parseFloat(r.value?.[1] || '0');
                return acc + (isNaN(v) ? 0 : v);
            }, 0);
            value = sum;
        }

        if (seriesCount > 0) hasData = true;
        if (scalarValue === null && value !== null) scalarValue = value;

        queryResults.push({
            refId: target.refId,
            expr: target.expr,
            status: seriesCount > 0 ? 'OK' : 'EMPTY',
            value,
            seriesCount,
        });
    }

    // Determine overall status
    let status;
    if (hasError) {
        status = 'ERROR';
    } else if (!hasData) {
        status = 'EMPTY';
    } else {
        status = 'OK';
    }

    return {
        ...panel,
        status,
        queryResults,
        value: scalarValue,
    };
}

async function validateLokiPanel(panel) {
    const available = await checkLokiAvailability();
    if (!available) {
        return {
            ...panel,
            status: 'SKIPPED',
            reason: 'Loki unreachable',
            queryResults: [],
        };
    }

    const queryResults = [];
    let hasData = false;
    let hasError = false;

    for (const target of panel.targets) {
        const result = await lokiQuery(target.expr);

        if (result.status === 'error') {
            hasError = true;
            queryResults.push({
                refId: target.refId,
                expr: target.expr,
                status: 'ERROR',
                error: result.error,
                value: null,
                seriesCount: 0,
            });
            continue;
        }

        const streams = result.data?.result || [];
        const seriesCount = streams.length;
        const lineCount = streams.reduce((acc, s) => acc + (s.values?.length || 0), 0);

        if (seriesCount > 0) hasData = true;

        queryResults.push({
            refId: target.refId,
            expr: target.expr,
            status: seriesCount > 0 ? 'OK' : 'EMPTY',
            value: lineCount > 0 ? `${lineCount} lines` : null,
            seriesCount,
        });
    }

    let status;
    if (hasError) {
        status = 'ERROR';
    } else if (!hasData) {
        status = 'EMPTY';
    } else {
        status = 'OK';
    }

    return {
        ...panel,
        status,
        queryResults,
        value: hasData ? 'logs flowing' : null,
    };
}

// ── Freshness Check ──────────────────────────────────────────────────────

async function checkFreshness(panels) {
    // Check key metrics for staleness (use always-present metrics, not traffic-dependent ones)
    const freshnessChecks = [
        { name: 'nodejs_process_resident_memory_bytes{job="krystalinex-server"}', maxAge: 120, category: 'Application' },
        { name: 'node_cpu_seconds_total', maxAge: 120, category: 'Infrastructure' },
        { name: 'pg_stat_activity_count', maxAge: 120, category: 'Database' },
        { name: 'up', maxAge: 120, category: 'Core' },
    ];

    const results = [];
    for (const check of freshnessChecks) {
        const res = await promQuery(`time() - max(timestamp(${check.name}))`);
        if (res.status === 'success' && res.data.result.length > 0) {
            const age = parseFloat(res.data.result[0].value[1]);
            results.push({
                metric: check.name,
                category: check.category,
                ageSec: Math.round(age),
                maxAge: check.maxAge,
                fresh: age <= check.maxAge,
            });
        } else {
            results.push({
                metric: check.name,
                category: check.category,
                ageSec: null,
                maxAge: check.maxAge,
                fresh: false,
                error: 'metric not found',
            });
        }
    }
    return results;
}

// ── Reporter ─────────────────────────────────────────────────────────────

function formatValue(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
        if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
        if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
        if (Number.isInteger(v)) return v.toString();
        return v.toFixed(2);
    }
    return String(v);
}

function statusIcon(status) {
    switch (status) {
        case 'OK': return `${c.green}✅${c.reset}`;
        case 'EMPTY': return `${c.red}❌${c.reset}`;
        case 'ERROR': return `${c.red}💥${c.reset}`;
        case 'SKIPPED': return `${c.dim}⏭️${c.reset}`;
        default: return '❓';
    }
}

function tierLabel(tier) {
    switch (tier) {
        case 'CRITICAL': return `${c.red}CRIT${c.reset}`;
        case 'TRAFFIC_DEPENDENT': return `${c.yellow}TRAF${c.reset}`;
        case 'ACTIVITY_DEPENDENT': return `${c.blue}ACTV${c.reset}`;
        case 'INFORMATIONAL': return `${c.dim}INFO${c.reset}`;
        default: return '    ';
    }
}

function printReport(panelResults, freshness, semanticViolations) {
    const resultsByRow = new Map();
    for (const pr of panelResults) {
        const row = pr.row || 'Ungrouped';
        if (!resultsByRow.has(row)) resultsByRow.set(row, []);
        resultsByRow.get(row).push(pr);
    }

    console.log(`\n${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}  🔍 KrystalineX Dashboard Validator${c.reset}`);
    console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`  Target: ${config.isRemote ? '🌐 K8s' : '🏠 Local'}  Prometheus: ${PROM_URL}${lokiAvailable ? `  Loki: ✅` : ''}`);
    console.log(`  Panels: ${panelResults.length}  Queries: ${panelResults.reduce((a, p) => a + (p.queryResults?.length || p.targets.length), 0)}`);
    console.log();

    for (const [row, panels] of resultsByRow) {
        console.log(`${c.bold}  ${row}${c.reset}`);
        for (const p of panels) {
            const icon = statusIcon(p.status);
            const tier = tierLabel(p.tier);
            const value = p.status === 'SKIPPED' ? c.dim + p.reason + c.reset
                : p.status === 'OK' ? `${formatValue(p.value)}${p.queryResults.length > 1 ? ` (${p.queryResults.filter(q => q.seriesCount > 0).length}/${p.queryResults.length} queries)` : ''}`
                : p.status === 'ERROR' ? `${c.red}${p.queryResults.find(q => q.status === 'ERROR')?.error}${c.reset}`
                : `${c.red}NO DATA${c.reset}`;
            console.log(`    ${icon} [${tier}] ${p.title} — ${value}`);

            if (VERBOSE && p.status !== 'SKIPPED') {
                for (const qr of p.queryResults) {
                    const qIcon = qr.status === 'OK' ? '  ✓' : qr.status === 'EMPTY' ? '  ✗' : '  !';
                    console.log(`      ${c.dim}${qIcon} ${qr.refId}: ${qr.expr.substring(0, 80)}${qr.expr.length > 80 ? '...' : ''} → ${qr.seriesCount} series${c.reset}`);
                }
            }
        }
        console.log();
    }

    // Freshness
    console.log(`${c.bold}  📡 Data Freshness${c.reset}`);
    for (const f of freshness) {
        const icon = f.fresh ? `${c.green}✅${c.reset}` : `${c.red}❌${c.reset}`;
        const age = f.ageSec !== null ? `${f.ageSec}s ago` : 'NOT FOUND';
        console.log(`    ${icon} ${f.category}: ${f.metric} — ${age} (max: ${f.maxAge}s)`);
    }
    console.log();

    // Semantic violations
    if (semanticViolations.length > 0) {
        console.log(`${c.bold}  ⚠️  Semantic Invariant Violations${c.reset}`);
        for (const v of semanticViolations) {
            const icon = v.severity === 'ERROR' ? `${c.red}🔴${c.reset}` : `${c.yellow}🟡${c.reset}`;
            console.log(`    ${icon} [${v.rule}] ${v.message}`);
        }
        console.log();
    }

    // Summary
    const counts = { OK: 0, EMPTY: 0, ERROR: 0, SKIPPED: 0 };
    for (const p of panelResults) counts[p.status] = (counts[p.status] || 0) + 1;

    const criticalFailures = panelResults.filter(p =>
        p.tier === 'CRITICAL' && (p.status === 'EMPTY' || p.status === 'ERROR')
    );
    const trafficFailures = panelResults.filter(p =>
        p.tier === 'TRAFFIC_DEPENDENT' && (p.status === 'EMPTY' || p.status === 'ERROR')
    );
    const staleMetrics = freshness.filter(f => !f.fresh);

    console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}  RESULTS${c.reset}`);
    console.log(`    ${c.green}${counts.OK} OK${c.reset}  |  ${c.red}${counts.EMPTY} EMPTY${c.reset}  |  ${c.red}${counts.ERROR} ERROR${c.reset}  |  ${c.dim}${counts.SKIPPED} SKIPPED${c.reset}`);
    console.log(`    Semantic violations: ${semanticViolations.length}`);
    console.log(`    Stale metrics: ${staleMetrics.length}`);
    console.log();

    if (criticalFailures.length > 0) {
        console.log(`  ${c.red}${c.bold}🚨 CRITICAL PANEL FAILURES (${criticalFailures.length}):${c.reset}`);
        for (const p of criticalFailures) {
            console.log(`    ${c.red}• ${p.title} (panel ${p.id}) — ${p.status}${c.reset}`);
        }
        console.log();
    }

    if (trafficFailures.length > 0) {
        console.log(`  ${c.yellow}${c.bold}⚠️  TRAFFIC-DEPENDENT FAILURES (${trafficFailures.length}):${c.reset}`);
        for (const p of trafficFailures) {
            console.log(`    ${c.yellow}• ${p.title} (panel ${p.id}) — ${p.status}${c.reset}`);
        }
        console.log();
    }

    // Overall verdict
    const healthy = criticalFailures.length === 0 && staleMetrics.length === 0;
    if (healthy) {
        console.log(`  ${c.green}${c.bold}✅ DASHBOARD HEALTHY — all critical panels have data${c.reset}`);
    } else {
        console.log(`  ${c.red}${c.bold}❌ DASHBOARD UNHEALTHY — ${criticalFailures.length} critical failures, ${staleMetrics.length} stale metrics${c.reset}`);
    }
    console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

    return {
        healthy,
        counts,
        criticalFailures: criticalFailures.map(p => ({ id: p.id, title: p.title, status: p.status })),
        trafficFailures: trafficFailures.map(p => ({ id: p.id, title: p.title, status: p.status })),
        semanticViolations,
        staleMetrics,
    };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
    // 1. Load dashboard
    const dashboard = loadDashboard();
    const { panels } = extractPanels(dashboard);
    const promPanels = panels.filter(p => !p.skip && p.queryEngine === 'prometheus');
    const lokiPanels = panels.filter(p => !p.skip && p.queryEngine === 'loki');
    const validatablePanels = [...promPanels, ...lokiPanels];

    if (!JSON_OUTPUT) {
        console.log(`\n📊 Loaded dashboard: ${dashboard.title || 'Unified Observability'}`);
        console.log(`   ${panels.length} panels total, ${promPanels.length} with Prometheus queries, ${lokiPanels.length} with Loki queries`);
    }

    // 2. Connectivity check — Prometheus
    const healthCheck = await promQuery('up');
    if (healthCheck.status === 'error') {
        console.error(`\n${c.red}❌ Cannot reach Prometheus at ${PROM_URL}${c.reset}`);
        console.error(`   Error: ${healthCheck.error}`);
        console.error(`   Is Prometheus running? Try: ${config.isRemote ? 'check K8s port-forward' : 'docker compose up -d prometheus'}`);
        process.exit(1);
    }

    if (!JSON_OUTPUT) {
        const upCount = healthCheck.data?.result?.length || 0;
        console.log(`   ${c.green}Prometheus reachable — ${upCount} targets${c.reset}`);
    }

    // 2b. Connectivity check — Loki (non-blocking)
    if (lokiPanels.length > 0) {
        const lokiOk = await checkLokiAvailability();
        if (!JSON_OUTPUT) {
            if (lokiOk) {
                console.log(`   ${c.green}Loki reachable — ${LOKI_URL}${c.reset}`);
            } else {
                console.log(`   ${c.yellow}Loki unreachable — Loki panels will be skipped${c.reset}`);
            }
        }
    }

    if (!JSON_OUTPUT) {
        console.log(`\n   Validating ${validatablePanels.length} panels...`);
    }

    // 3. Validate all panels (with concurrency limit)
    const CONCURRENCY = 5;
    const panelResults = [];
    const skippedResults = panels.filter(p => p.skip).map(p => ({
        ...p, status: 'SKIPPED', reason: `Non-Prometheus (${p.datasource})`, queryResults: [],
    }));

    for (let i = 0; i < validatablePanels.length; i += CONCURRENCY) {
        const batch = validatablePanels.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(validatePanel));
        panelResults.push(...results);

        if (!JSON_OUTPUT && !CI_MODE) {
            const done = Math.min(i + CONCURRENCY, validatablePanels.length);
            process.stdout.write(`\r   Progress: ${done}/${validatablePanels.length} panels checked`);
        }
    }
    if (!JSON_OUTPUT && !CI_MODE) process.stdout.write('\n');

    const allResults = [...panelResults, ...skippedResults];

    // 4. Build results map for semantic checks
    const resultsMap = new Map();
    for (const r of allResults) resultsMap.set(r.id, r);

    // 5. Freshness check
    const freshness = await checkFreshness(allResults);

    // 6. Semantic invariant check
    const semanticViolations = checkSemanticInvariants(resultsMap);

    // 7. Report
    if (JSON_OUTPUT) {
        const report = {
            timestamp: new Date().toISOString(),
            target: config.isRemote ? 'k8s' : 'local',
            prometheus: PROM_URL,
            panels: allResults.map(p => ({
                id: p.id, title: p.title, type: p.type, tier: p.tier,
                row: p.row, status: p.status, value: p.value,
                queries: p.queryResults?.map(q => ({
                    refId: q.refId, status: q.status, seriesCount: q.seriesCount, value: q.value,
                })),
            })),
            freshness,
            semanticViolations,
        };
        console.log(JSON.stringify(report, null, 2));
    } else {
        var summary = printReport(allResults, freshness, semanticViolations);
    }

    // 8. Exit code
    const criticalFailed = allResults.some(p =>
        p.tier === 'CRITICAL' && (p.status === 'EMPTY' || p.status === 'ERROR')
    );
    if (CI_MODE && criticalFailed) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error(`\n${c.red}Fatal: ${err.message}${c.reset}`);
    if (VERBOSE) console.error(err.stack);
    process.exit(1);
});
