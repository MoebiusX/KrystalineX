/**
 * Synthetic Training Data Generator for Anomaly Analyzer
 * 
 * Generates realistic training examples based on patterns observed
 * in the 22 real examples from the KrystalineX platform.
 * 
 * Usage: node scripts/generate-synthetic-training.cjs [count]
 *   count: number of synthetic examples to generate (default: 200)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────

const DEFAULT_COUNT = 100;
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'training-data-synthetic.jsonl');
const COMBINED_FILE = path.join(__dirname, '..', 'data', 'training-data-combined.jsonl');
const EXISTING_FILE = path.join(__dirname, '..', 'data', 'training-data-axolotl.jsonl');
const RESERVE_FILE = path.join(__dirname, '..', 'data', 'training-data-reserve.jsonl');

// ─── Randomness Helpers ─────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max, decimals = 2) { return +(Math.random() * (max - min) + min).toFixed(decimals); }
function randBool(probability = 0.5) { return Math.random() < probability; }
function randId() { return crypto.randomBytes(16).toString('hex'); }

// ─── Platform Domain Knowledge ──────────────────────────────────

const SERVICES = {
    'kx-exchange': {
        port: 3001,
        operations: [
            { name: 'GET', kind: 'client', category: 'http' },
            { name: 'POST', kind: 'server', category: 'http' },
            { name: 'tcp.connect', kind: 'internal', category: 'network' },
            { name: 'dns.lookup', kind: 'client', category: 'network' },
            { name: 'pg-pool.connect', kind: 'client', category: 'database' },
            { name: 'pg.query:SELECT crypto_exchange', kind: 'client', category: 'database' },
            { name: 'pg.query:INSERT crypto_exchange', kind: 'client', category: 'database' },
            { name: 'pg.query:UPDATE crypto_exchange', kind: 'client', category: 'database' },
            { name: 'pg.query:BEGIN crypto_exchange', kind: 'client', category: 'database' },
            { name: 'pg.query:COMMIT crypto_exchange', kind: 'client', category: 'database' },
            { name: 'publish orders', kind: 'producer', category: 'messaging' },
            { name: 'publish <default>', kind: 'producer', category: 'messaging' },
        ],
        scopes: [
            '@opentelemetry/instrumentation-undici',
            '@opentelemetry/instrumentation-net',
            '@opentelemetry/instrumentation-dns',
            '@opentelemetry/instrumentation-pg',
        ],
    },
    'kx-wallet': {
        port: 3002,
        operations: [
            { name: 'HTTP GET', kind: 'client', category: 'http' },
            { name: 'HTTP POST', kind: 'client', category: 'http' },
        ],
        scopes: [
            '@opentelemetry/instrumentation-fetch',
        ],
    },
    'api-gateway': {
        port: 8000,
        operations: [
            { name: 'kong', kind: 'server', category: 'proxy' },
            { name: 'kong.balancer', kind: 'internal', category: 'proxy' },
            { name: 'kong.router', kind: 'internal', category: 'proxy' },
            { name: 'kong.dns', kind: 'internal', category: 'network' },
            { name: 'kong.access.plugin.cors', kind: 'internal', category: 'plugin' },
            { name: 'kong.access.plugin.opentelemetry', kind: 'internal', category: 'plugin' },
        ],
        scopes: [],
    },
    'order-matcher': {
        port: null,
        operations: [
            { name: 'order.match', kind: 'consumer', category: 'messaging' },
            { name: 'order.response', kind: 'producer', category: 'messaging' },
            { name: 'payment_response process', kind: 'consumer', category: 'messaging' },
        ],
        scopes: ['order-matcher'],
    },
    'jaeger-all-in-one': {
        port: 16686,
        operations: [
            { name: '/api/traces', kind: 'server', category: 'http' },
            { name: '/api/services', kind: 'server', category: 'http' },
        ],
        scopes: ['go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp'],
    },
};

const SEVERITY_MAP = {
    1: 'SEV1 (Critical)',
    2: 'SEV2 (Major)',
    3: 'SEV3 (Moderate)',
    4: 'SEV4 (Minor)',
    5: 'SEV5 (Low)',
};

const DB_TABLES = [
    'wallets', 'orders', 'users', 'trades', 'verification_codes',
    'sessions', 'baselines', 'anomalies', 'audit_log',
];

const DB_STATEMENTS = {
    SELECT: (table) => `SELECT * FROM ${table} WHERE id = $1`,
    INSERT: (table) => `INSERT INTO ${table} (id, data, created_at) VALUES ($1, $2, NOW())`,
    UPDATE: (table) => `UPDATE ${table} SET updated_at = NOW() WHERE id = $1`,
    BEGIN: () => 'BEGIN',
    COMMIT: () => 'COMMIT',
};

// ─── Anomaly Scenario Templates ─────────────────────────────────

const SCENARIOS = [
    // 1. Connection Pool Exhaustion
    {
        id: 'pool_exhaustion',
        services: ['kx-exchange'],
        operations: ['pg-pool.connect'],
        duration: () => ({ actual: randFloat(150, 500), expected: randFloat(0.3, 2), stddev: randFloat(5, 15) }),
        metrics: () => ({ cpu: randFloat(0.1, 1.5), mem: randInt(80, 160), reqRate: randFloat(0, 0.3), errRate: randFloat(0, 3), p99: randInt(3000, 10000), conns: randInt(0, 2) }),
        severity: () => 1,
        goodAnalysis: (d, m) => ({
            summary: `The pg-pool.connect operation experienced extreme latency (${d.actual}ms vs expected ${d.expected}ms) due to connection pool exhaustion requiring a new TCP connection to PostgreSQL.`,
            causes: [
                'Connection pool was empty, forcing a new connection establishment',
                `TCP connect span confirms network-level connection setup overhead`,
                `Idle timeout (30s) likely evicted all pooled connections during inactivity`,
            ],
            recommendations: [
                'Increase minimum pool size to maintain warm connections during idle periods',
                'Reduce idle timeout or implement connection keepalive pings',
                'Add connection pool utilization metrics (idle/active/waiting) to monitoring',
            ],
            confidence: 'high',
        }),
        traceSpans: (s, op, d) => [
            `${s}: pg.connect (${(d.actual - randFloat(5, 20)).toFixed(2)}ms)`,
            `kx-wallet: HTTP GET (${(d.actual + randFloat(10, 50)).toFixed(2)}ms)`,
            `api-gateway: kong (${(d.actual + randFloat(15, 60)).toFixed(2)}ms)`,
            `${s}: tcp.connect (${(d.actual - randFloat(20, 40)).toFixed(2)}ms)`,
            `${s}: pg.query:SELECT crypto_exchange (${randFloat(1, 15).toFixed(2)}ms)`,
        ],
    },

    // 2. Cold Start / Warmup
    {
        id: 'cold_start',
        services: ['kx-exchange', 'kx-wallet'],
        operations: ['HTTP GET', 'GET', 'POST'],
        duration: () => ({ actual: randFloat(80, 400), expected: randFloat(20, 50), stddev: randFloat(10, 30) }),
        metrics: () => ({ cpu: randFloat(0.2, 0.8), mem: randInt(60, 120), reqRate: randFloat(0, 0.2), errRate: randFloat(0, 5), p99: randInt(100, 500), conns: 0 }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => ({
            summary: `The elevated latency (${d.actual}ms) on the first request after service restart is consistent with cold start behavior — JIT compilation, module loading, and connection establishment all contribute to initial request overhead.`,
            causes: [
                'Service recently restarted, requiring initialization of connection pools and caches',
                'First request triggers lazy-loaded modules and JIT compilation overhead',
                `Low request rate (${m.reqRate} req/s) confirms this was among the first requests processed`,
            ],
            recommendations: [
                'Implement health check warmup requests before accepting traffic',
                'Add request count to metrics to distinguish cold start from steady-state latency',
                'Consider pre-warming connection pools and caches on service startup',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `api-gateway: kong (${(d.actual + randFloat(5, 20)).toFixed(2)}ms)`,
            `api-gateway: kong.balancer (${(d.actual - randFloat(5, 10)).toFixed(2)}ms)`,
        ],
    },

    // 3. Database Query Lock Contention
    {
        id: 'query_lock',
        services: ['kx-exchange'],
        operations: ['pg.query:SELECT crypto_exchange', 'pg.query:UPDATE crypto_exchange', 'pg.query:INSERT crypto_exchange'],
        duration: () => ({ actual: randFloat(500, 5000), expected: randFloat(2, 50), stddev: randFloat(10, 200) }),
        metrics: () => ({ cpu: randFloat(2, 8), mem: randInt(70, 150), reqRate: randFloat(0, 0.5), errRate: randFloat(0, 5), p99: randInt(5000, 15000), conns: randInt(0, 3) }),
        severity: () => 1,
        goodAnalysis: (d, m) => ({
            summary: `The database query took ${d.actual.toFixed(0)}ms instead of the expected ${d.expected}ms, indicating lock contention or table-level blocking from concurrent transactions.`,
            causes: [
                `Elevated CPU (${m.cpu}%) suggests active query processing, possibly a full table scan or lock wait`,
                `P99 latency of ${m.p99}ms indicates systemic database pressure, not an isolated event`,
                'Concurrent INSERT/UPDATE transactions may be holding row-level locks that block this SELECT',
            ],
            recommendations: [
                'Add appropriate indexes for frequently queried columns to avoid full table scans',
                'Review transaction isolation levels — consider READ COMMITTED if SERIALIZABLE is not required',
                'Implement query timeout limits to prevent long-running queries from blocking others',
            ],
            confidence: 'high',
        }),
        traceSpans: (s, op, d) => {
            const table = pick(DB_TABLES);
            return [
                `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
                `${s}: pg.query:BEGIN crypto_exchange (${randFloat(0.5, 5).toFixed(2)}ms)`,
                `${s}: pg.query:INSERT crypto_exchange (${randFloat(5, 40).toFixed(2)}ms)`,
                `${s}: POST (${(d.actual + randFloat(50, 200)).toFixed(2)}ms)`,
                `${s}: pg-pool.connect (${randFloat(0.1, 2).toFixed(2)}ms)`,
            ];
        },
    },

    // 4. DNS Cache Miss
    {
        id: 'dns_cache_miss',
        services: ['kx-exchange'],
        operations: ['dns.lookup'],
        duration: () => ({ actual: randFloat(4, 20), expected: randFloat(0.5, 2), stddev: randFloat(0.5, 2) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.6), mem: randInt(18, 30), reqRate: 0, errRate: 0, p99: randInt(50, 300), conns: 0 }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => ({
            summary: `The DNS lookup operation took ${d.actual}ms, elevated from the expected ${d.expected}ms, likely due to a DNS cache miss requiring a full resolution cycle.`,
            causes: [
                'DNS cache entry expired, requiring a fresh lookup to the upstream resolver',
                'Possible resolver congestion or round-trip delay to the DNS server',
                'IPv6/IPv4 dual-stack resolution attempting both address families sequentially',
            ],
            recommendations: [
                'Increase DNS cache TTL if the resolved addresses rarely change',
                'Use a local DNS resolver (e.g., dnsmasq) to reduce lookup latency',
                'Consider pinning resolved addresses for critical internal services',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => [
            `${s}: dns.lookup (${d.actual.toFixed(2)}ms)`,
        ],
    },

    // 5. Network Jitter / TCP Connect Anomaly
    {
        id: 'network_jitter',
        services: ['kx-exchange'],
        operations: ['tcp.connect'],
        duration: () => ({ actual: randFloat(5, 50), expected: randFloat(2, 5), stddev: randFloat(1, 3) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.6), mem: randInt(18, 30), reqRate: 0, errRate: randFloat(0, 100), p99: randInt(10, 1000), conns: 0 }),
        severity: () => pick([1, 2, 3, 4]),
        goodAnalysis: (d, m) => ({
            summary: `The TCP connect operation showed elevated latency of ${d.actual}ms (expected ${d.expected}ms), suggesting network-level jitter or ephemeral port exhaustion.`,
            causes: [
                'Network jitter caused by transient congestion on the loopback or container network',
                'TCP SYN/SYN-ACK handshake delayed due to kernel socket buffer pressure',
                `The ${d.deviation}σ deviation may be a statistical outlier rather than a systemic issue`,
            ],
            recommendations: [
                'Monitor TCP retransmission rates to correlate with connect latency spikes',
                'Check for ephemeral port exhaustion with netstat/ss if connection rates are high',
                'Consider connection pooling to reduce the frequency of new TCP handshakes',
            ],
            confidence: m.errRate > 50 ? 'medium' : 'low',
        }),
        traceSpans: (s, op, d) => [
            `${s}: tcp.connect (${d.actual.toFixed(2)}ms)`,
        ],
    },

    // 6. GC Pause
    {
        id: 'gc_pause',
        services: ['kx-exchange', 'order-matcher'],
        operations: ['GET', 'POST', 'order.match'],
        duration: () => ({ actual: randFloat(100, 800), expected: randFloat(10, 50), stddev: randFloat(5, 30) }),
        metrics: () => ({ cpu: randFloat(1, 5), mem: randInt(120, 250), reqRate: randFloat(0, 0.5), errRate: 0, p99: randInt(100, 500), conns: randInt(0, 2) }),
        severity: () => pick([1, 2]),
        goodAnalysis: (d, m) => ({
            summary: `The ${d.actual.toFixed(0)}ms latency spike with elevated memory (${m.mem}MB) and CPU (${m.cpu}%) is consistent with a garbage collection pause in the Node.js runtime.`,
            causes: [
                `Elevated memory usage (${m.mem}MB) suggests heap pressure triggering a major GC cycle`,
                `CPU spike to ${m.cpu}% during the anomaly window confirms compute-bound activity consistent with GC`,
                'V8 stop-the-world GC pauses can freeze the event loop for hundreds of milliseconds',
            ],
            recommendations: [
                'Profile heap usage with --inspect to identify memory leak candidates',
                'Tune V8 GC flags (--max-old-space-size, --gc-interval) for the workload',
                'Implement object pooling for frequently allocated/deallocated objects',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => {
            return [
                `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
                `${s}: pg.query:SELECT crypto_exchange (${randFloat(2, 10).toFixed(2)}ms)`,
                `api-gateway: kong (${(d.actual + randFloat(5, 20)).toFixed(2)}ms)`,
            ];
        },
    },

    // 7. Message Queue Backlog
    {
        id: 'mq_backlog',
        services: ['order-matcher'],
        operations: ['order.match', 'payment_response process'],
        duration: () => ({ actual: randFloat(200, 2000), expected: randFloat(50, 100), stddev: randFloat(10, 30) }),
        metrics: () => ({ cpu: randFloat(0.1, 1), mem: randInt(70, 120), reqRate: null, errRate: 0, p99: randInt(10, 100), conns: 0 }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => ({
            summary: `The ${d.actual.toFixed(0)}ms processing time for message consumption indicates a RabbitMQ queue backlog causing increased delivery-to-processing delay.`,
            causes: [
                'Messages accumulated in the queue during a period of consumer unavailability or slowness',
                'Consumer prefetch count may be too low, causing sequential processing bottlenecks',
                `Low CPU (${m.cpu}%) suggests the consumer was idle or blocked waiting, not compute-bound`,
            ],
            recommendations: [
                'Monitor RabbitMQ queue depth and consumer utilization metrics',
                'Increase consumer prefetch count to allow batch processing of queued messages',
                'Add dead-letter queue handling for messages that exceed processing time thresholds',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `kx-exchange: publish orders (${randFloat(1, 5).toFixed(2)}ms)`,
            `kx-exchange: payment_response process (${randFloat(0.3, 2).toFixed(2)}ms)`,
            `kx-wallet: HTTP POST (${(d.actual + randFloat(30, 100)).toFixed(2)}ms)`,
        ],
    },

    // 8. Large Response Serialization
    {
        id: 'large_response',
        services: ['jaeger-all-in-one', 'kx-exchange'],
        operations: ['/api/traces', 'GET'],
        duration: () => ({ actual: randFloat(60, 300), expected: randFloat(20, 40), stddev: randFloat(10, 20) }),
        metrics: () => ({ cpu: randFloat(0.2, 1), mem: randInt(18, 50), reqRate: 0, errRate: 0, p99: randInt(100, 500), conns: 0 }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => {
            const bodySize = randInt(500000, 2000000);
            return {
                summary: `The ${d.actual.toFixed(0)}ms response time is correlated with a large response body (~${(bodySize / 1024).toFixed(0)}KB), indicating serialization and network transfer overhead.`,
                causes: [
                    `Large response payload (~${(bodySize / 1024).toFixed(0)}KB) requires significant JSON serialization time`,
                    'Jaeger accumulates traces over the lookback window — larger windows produce more data',
                    `Low CPU (${m.cpu}%) and memory (${m.mem}MB) confirm the bottleneck is I/O-bound, not compute`,
                ],
                recommendations: [
                    'Reduce the lookback window or limit parameter in trace queries to minimize payload size',
                    'Implement pagination for large result sets instead of returning all traces at once',
                    'Consider compressing responses (gzip/brotli) to reduce transfer time',
                ],
                confidence: 'high',
            };
        },
        traceSpans: (s, op, d) => [
            `kx-exchange: GET (${(d.actual + randFloat(50, 200)).toFixed(2)}ms)`,
            `jaeger-all-in-one: /api/traces (${d.actual.toFixed(2)}ms)`,
        ],
    },

    // 9. Cascading Timeout
    {
        id: 'cascading_timeout',
        services: ['kx-exchange', 'kx-wallet'],
        operations: ['HTTP GET', 'HTTP POST', 'GET'],
        duration: () => ({ actual: randFloat(3000, 10000), expected: randFloat(30, 80), stddev: randFloat(20, 100) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.5), mem: randInt(80, 130), reqRate: randFloat(0, 0.3), errRate: randFloat(5, 30), p99: randInt(5000, 15000), conns: randInt(0, 3) }),
        severity: () => 1,
        goodAnalysis: (d, m) => ({
            summary: `The extreme latency of ${(d.actual / 1000).toFixed(1)}s with ${m.errRate}% error rate indicates a cascading failure where a downstream service timeout propagated upstream through the request chain.`,
            causes: [
                'A downstream service (likely database or external API) became unresponsive, causing the caller to wait until timeout',
                `Elevated error rate (${m.errRate}%) shows the failure affected multiple requests, not just an isolated event`,
                `Low CPU (${m.cpu}%) confirms the service was blocked waiting on I/O, not doing productive work`,
            ],
            recommendations: [
                'Implement circuit breaker pattern to fail fast when a downstream service is unresponsive',
                'Set aggressive timeouts at each service boundary to prevent cascade propagation',
                'Add bulkhead isolation to prevent one slow dependency from consuming all connection resources',
            ],
            confidence: 'high',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `api-gateway: kong (${(d.actual + randFloat(5, 30)).toFixed(2)}ms)`,
            `api-gateway: kong.balancer (${(d.actual - randFloat(10, 30)).toFixed(2)}ms)`,
            `kx-exchange: pg.query:SELECT crypto_exchange (${(d.actual - randFloat(100, 500)).toFixed(2)}ms)`,
        ],
    },

    // 10. Idle Connection Eviction
    {
        id: 'idle_eviction',
        services: ['kx-exchange'],
        operations: ['pg-pool.connect', 'pg.query:SELECT crypto_exchange'],
        duration: () => ({ actual: randFloat(100, 400), expected: randFloat(0.3, 5), stddev: randFloat(2, 15) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.6), mem: randInt(80, 160), reqRate: randFloat(0, 0.2), errRate: 0, p99: randInt(1000, 8000), conns: randInt(0, 1) }),
        severity: () => pick([1, 2]),
        goodAnalysis: (d, m) => ({
            summary: `The ${d.actual.toFixed(0)}ms connection acquisition latency indicates all pooled connections were evicted due to the 30-second idle timeout, requiring a full TCP + auth handshake to PostgreSQL.`,
            causes: [
                'All connections in the pool expired after 30s of inactivity (db.postgresql.idle.timeout.millis: 30000)',
                `The subsequent tcp.connect span accounts for most of the latency, confirming new connection establishment`,
                `Low request rate (${m.reqRate} req/s) means the pool sits idle long enough for eviction between requests`,
            ],
            recommendations: [
                'Set a minimum pool size > 0 to always maintain at least one warm connection',
                'Implement a connection keepalive ping at intervals shorter than the idle timeout',
                'Consider increasing the idle timeout if the traffic pattern is bursty with long gaps',
            ],
            confidence: 'high',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `${s}: pg.connect (${(d.actual - randFloat(2, 10)).toFixed(2)}ms)`,
            `${s}: tcp.connect (${(d.actual - randFloat(15, 40)).toFixed(2)}ms)`,
            `${s}: pg.query:SELECT crypto_exchange (${randFloat(2, 15).toFixed(2)}ms)`,
        ],
    },

    // 11. Kong Proxy Overhead
    {
        id: 'kong_overhead',
        services: ['api-gateway'],
        operations: ['kong', 'kong.balancer'],
        duration: () => ({ actual: randFloat(100, 500), expected: randFloat(15, 40), stddev: randFloat(10, 50) }),
        metrics: () => ({ cpu: randFloat(0.2, 0.8), mem: randInt(50, 100), reqRate: randFloat(0, 0.5), errRate: randFloat(0, 5), p99: randInt(200, 1000), conns: randInt(0, 3) }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => ({
            summary: `The API gateway experienced ${d.actual.toFixed(0)}ms latency — the bulk of which is attributable to the upstream service response time, not Kong's own processing overhead.`,
            causes: [
                `Kong's plugin execution (cors, opentelemetry) adds negligible overhead (<1ms combined)`,
                'The balancer span shows the majority of time was spent waiting for the upstream exchange service',
                `Error rate of ${m.errRate}% may indicate intermittent upstream failures triggering retry logic`,
            ],
            recommendations: [
                'Investigate the upstream kx-exchange service for the root cause of elevated latency',
                'Review Kong retry and timeout configuration to prevent unnecessary retry amplification',
                'Monitor Kong plugin execution times to ensure they remain negligible',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => [
            `api-gateway: kong (${d.actual.toFixed(2)}ms)`,
            `api-gateway: kong.balancer (${(d.actual - randFloat(5, 15)).toFixed(2)}ms)`,
            `api-gateway: kong.router (${randFloat(0.03, 0.1).toFixed(2)}ms)`,
            `api-gateway: kong.access.plugin.cors (${randFloat(0.02, 0.3).toFixed(2)}ms)`,
            `api-gateway: kong.access.plugin.opentelemetry (${randFloat(0.1, 0.4).toFixed(2)}ms)`,
            `kx-exchange: GET (${(d.actual - randFloat(10, 30)).toFixed(2)}ms)`,
        ],
    },

    // 12. Retry Storm
    {
        id: 'retry_storm',
        services: ['kx-exchange', 'kx-wallet'],
        operations: ['HTTP POST', 'POST', 'GET'],
        duration: () => ({ actual: randFloat(1000, 5000), expected: randFloat(30, 80), stddev: randFloat(20, 60) }),
        metrics: () => ({ cpu: randFloat(0.3, 2), mem: randInt(90, 150), reqRate: randFloat(0.5, 3), errRate: randFloat(10, 50), p99: randInt(3000, 10000), conns: randInt(1, 5) }),
        severity: () => 1,
        goodAnalysis: (d, m) => ({
            summary: `The ${(d.actual / 1000).toFixed(1)}s operation with ${m.errRate}% error rate and elevated request rate (${m.reqRate} req/s) indicates a retry storm where failed requests are being automatically retried, amplifying load.`,
            causes: [
                `Request rate elevated to ${m.reqRate} req/s — higher than normal, consistent with retry amplification`,
                `Error rate of ${m.errRate}% means a significant fraction of requests are failing and being retried`,
                `Active connections (${m.conns}) show concurrent request pressure from accumulated retries`,
            ],
            recommendations: [
                'Implement exponential backoff with jitter on retries to spread load over time',
                'Add a retry budget (e.g., max 3 retries per request) to cap amplification factor',
                'Implement circuit breaker to stop retrying when failure rate exceeds a threshold',
            ],
            confidence: 'high',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `api-gateway: kong (${(d.actual + randFloat(10, 50)).toFixed(2)}ms)`,
            `kx-exchange: pg.query:INSERT crypto_exchange (${randFloat(5, 40).toFixed(2)}ms)`,
        ],
    },

    // 13. TLS Handshake Overhead
    {
        id: 'tls_handshake',
        services: ['kx-exchange'],
        operations: ['tcp.connect', 'GET', 'POST'],
        duration: () => ({ actual: randFloat(30, 150), expected: randFloat(5, 15), stddev: randFloat(3, 10) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.5), mem: randInt(70, 120), reqRate: 0, errRate: 0, p99: randInt(50, 300), conns: 0 }),
        severity: () => pick([2, 3, 4]),
        goodAnalysis: (d, m) => ({
            summary: `The ${d.actual.toFixed(0)}ms latency includes TLS handshake overhead for establishing a new secure connection, which is expected when connection reuse was not possible.`,
            causes: [
                'A new TLS session negotiation was required (no session resumption ticket available)',
                'Certificate verification and key exchange add 1-2 RTTs of latency over plain TCP',
                `Resource metrics are nominal (CPU ${m.cpu}%, Memory ${m.mem}MB), confirming the delay is network-bound`,
            ],
            recommendations: [
                'Enable TLS session resumption (session tickets or session IDs) to reduce handshake cost',
                'Use HTTP/2 connection multiplexing to reduce the number of TLS handshakes needed',
                'Ensure connection pooling retains TLS sessions across requests',
            ],
            confidence: 'medium',
        }),
        traceSpans: (s, op, d) => [
            `${s}: ${op} (${d.actual.toFixed(2)}ms)`,
            `${s}: tcp.connect (${(d.actual - randFloat(5, 20)).toFixed(2)}ms)`,
        ],
    },

    // 14. Jaeger Storage Pressure
    {
        id: 'jaeger_pressure',
        services: ['jaeger-all-in-one'],
        operations: ['/api/traces'],
        duration: () => ({ actual: randFloat(60, 250), expected: randFloat(15, 40), stddev: randFloat(8, 20) }),
        metrics: () => ({ cpu: randFloat(0.3, 1), mem: randInt(15, 40), reqRate: 0, errRate: 0, p99: randFloat(NaN, NaN), conns: 0 }),
        severity: () => pick([1, 2, 3]),
        goodAnalysis: (d, m) => {
            const bodySize = randInt(300000, 1500000);
            return {
                summary: `The Jaeger /api/traces endpoint took ${d.actual.toFixed(0)}ms due to a large response body (~${(bodySize / 1024).toFixed(0)}KB), indicating accumulated trace storage pressure.`,
                causes: [
                    `Response body size of ~${(bodySize / 1024).toFixed(0)}KB indicates a large number of stored traces being serialized`,
                    'Jaeger\'s in-memory storage may be approaching capacity, causing slower lookups',
                    `CPU and memory are low, confirming the bottleneck is data volume, not resource starvation`,
                ],
                recommendations: [
                    'Reduce trace retention period or increase sampling rate to control storage volume',
                    'Consider moving from in-memory to persistent storage (Elasticsearch, Cassandra) for production workloads',
                    'Implement trace query pagination to avoid large single responses',
                ],
                confidence: 'medium',
            };
        },
        traceSpans: (s, op, d) => [
            `kx-exchange: GET (${(d.actual + randFloat(100, 400)).toFixed(2)}ms)`,
            `jaeger-all-in-one: /api/traces (${d.actual.toFixed(2)}ms)`,
        ],
    },

    // 15. Order Processing Pipeline Latency
    {
        id: 'order_pipeline',
        services: ['order-matcher'],
        operations: ['order.match'],
        duration: () => ({ actual: randFloat(95, 200), expected: randFloat(80, 95), stddev: randFloat(3, 8) }),
        metrics: () => ({ cpu: randFloat(0.1, 0.3), mem: randInt(70, 100), reqRate: null, errRate: 0, p99: randInt(5, 20), conns: 0 }),
        severity: () => pick([3, 4, 5]),
        goodAnalysis: (d, m) => ({
            summary: `The order matching operation took ${d.actual.toFixed(0)}ms, a minor deviation from the expected ${d.expected}ms. This is within acceptable variance for the order processing pipeline.`,
            causes: [
                'Minor latency variation in the RabbitMQ message delivery-to-processing cycle',
                `Low CPU (${m.cpu}%) and memory (${m.mem}MB) rule out resource contention as a factor`,
                `The ${d.deviation}σ deviation is close to the alert threshold and may not warrant investigation`,
            ],
            recommendations: [
                'Consider raising the alert threshold for this operation if minor deviations are acceptable',
                'Monitor trend over time — if mean duration is drifting upward, investigate proactively',
                'No immediate action required for this severity level',
            ],
            confidence: 'low',
        }),
        traceSpans: (s, op, d) => [
            `order-matcher: order.match (${d.actual.toFixed(2)}ms)`,
            `kx-exchange: payment_response process (${randFloat(0.3, 1).toFixed(2)}ms)`,
            `kx-wallet: HTTP POST (${randFloat(200, 350).toFixed(2)}ms)`,
            `api-gateway: kong (${randFloat(250, 380).toFixed(2)}ms)`,
            `kx-exchange: publish orders (${randFloat(1, 5).toFixed(2)}ms)`,
            `order-matcher: order.response (${randFloat(1, 5).toFixed(2)}ms)`,
        ],
    },
];

// ─── Low-Metric Dismissal Outputs ───────────────────────────────
// These teach the model NOT to hallucinate high resource usage

function generateDismissalOutput(metrics, scenario) {
    const dismissals = [];

    if (metrics.cpu < 2) {
        dismissals.push(
            `CPU at ${metrics.cpu}% is negligible — this is not a contributing factor to the anomaly.`,
            `CPU usage was ${metrics.cpu}%, far too low to be significant. Not a factor.`,
            `There is no high CPU usage — ${metrics.cpu}% is well within normal range.`,
            `CPU was very low at ${metrics.cpu}%, so not a factor.`,
            `low cpu (${metrics.cpu}%), not relevant to this anomaly`,
        );
    }

    if (metrics.mem < 100) {
        dismissals.push(
            `Memory at ${metrics.mem}MB is low and not significant for this anomaly.`,
            `memory allocation was very low (${metrics.mem}MB), so not significant`,
        );
    }

    if (metrics.reqRate !== null && metrics.reqRate < 0.1) {
        dismissals.push(
            `Request rate is ${metrics.reqRate} req/s — effectively zero. This is not a high request rate.`,
            `${metrics.reqRate} requests per second is not elevated, therefore irrelevant.`,
            `request rate of ${metrics.reqRate} req/s could not have caused congestion`,
        );
    }

    if (metrics.errRate === 0) {
        dismissals.push(
            `Error rate is 0.0% — no errors were observed during this anomaly window.`,
        );
    }

    return pick(dismissals);
}

// ─── Diagnostic Question Outputs ────────────────────────────────

function generateDiagnosticOutput(metrics, scenario) {
    const questions = [
        `Was this the first request after a service restart? The latency pattern is consistent with cold start behavior. Check how many requests have been processed to rule out first-request overhead.`,
        `What's the statistical confidence in the baseline averages? With a small sample size, a single outlier can significantly shift the expected values and trigger false positives.`,
        `In clear cases like this, requesting additional info like kernel context switching, open file descriptors, or OOM killer activity should identify the culprit at the next iteration.`,
        `Is the database connection pool properly sized? Check pg_stat_activity for active/idle connections and compare against the pool max setting.`,
        `Check the trace for parent span context — was this operation called as part of a larger transaction, or is it an isolated request? The answer changes the root cause analysis significantly.`,
        `Were there any deployments or configuration changes around this timestamp? The sudden deviation pattern is more consistent with a change event than gradual degradation.`,
        `This appears to be a transient outlier. Monitor the next 10 occurrences of this operation — if the deviation persists, escalate. If it was a one-time spike, consider adjusting the alert sensitivity.`,
    ];

    return pick(questions);
}

// ─── Span Attribute Generators ──────────────────────────────────

function generateHttpSpanAttrs(service, operation) {
    const svcInfo = SERVICES[service];
    const method = operation.includes('POST') ? 'POST' : 'GET';
    const statusCode = randBool(0.9) ? 200 : pick([201, 400, 500, 502, 503]);

    if (service === 'kx-wallet' || service === 'crypto-wallet') {
        return {
            'component': 'fetch',
            'http.host': `localhost:${svcInfo?.port || 8000}`,
            'http.method': method,
            'http.response_content_length': randInt(500, 200000),
            'http.scheme': 'http',
            'http.status_code': statusCode,
            'http.status_text': statusCode === 200 ? 'OK' : 'Error',
            'http.url': '',
            'http.user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
            'otel.scope.name': '@opentelemetry/instrumentation-fetch',
            'otel.scope.version': '0.209.0',
            'span.kind': 'client',
        };
    }

    return {
        'http.request.method': method,
        'http.request.method_original': method,
        'http.response.status_code': statusCode,
        'network.peer.address': pick(['127.0.0.1', '::1']),
        'network.peer.port': 16686,
        'otel.scope.name': '@opentelemetry/instrumentation-undici',
        'otel.scope.version': '0.13.1',
        'server.address': 'localhost',
        'server.port': svcInfo?.port || 16686,
        'span.kind': 'client',
        'url.full': `http://localhost:16686/api/traces?service=${service}&lookback=1h&limit=100`,
        'url.path': '/api/traces',
        'url.scheme': 'http',
        'user_agent.original': 'node',
    };
}

function generateDbSpanAttrs(operation) {
    const table = pick(DB_TABLES);
    const opType = operation.includes('SELECT') ? 'SELECT'
        : operation.includes('INSERT') ? 'INSERT'
            : operation.includes('UPDATE') ? 'UPDATE'
                : operation.includes('BEGIN') ? 'BEGIN' : 'COMMIT';
    return {
        'db.connection_string': 'postgresql://localhost:5433/crypto_exchange',
        'db.name': 'crypto_exchange',
        'db.statement': DB_STATEMENTS[opType](table),
        'db.system': 'postgresql',
        'db.user': 'exchange',
        'net.peer.name': 'localhost',
        'net.peer.port': 5433,
        'otel.scope.name': '@opentelemetry/instrumentation-pg',
        'otel.scope.version': '0.54.1',
        'span.kind': 'client',
    };
}

function generatePoolSpanAttrs() {
    return {
        'db.connection_string': 'postgresql://localhost:5433/crypto_exchange',
        'db.name': 'crypto_exchange',
        'db.postgresql.idle.timeout.millis': 30000,
        'db.system': 'postgresql',
        'db.user': 'exchange',
        'net.peer.name': 'localhost',
        'net.peer.port': 5433,
        'otel.scope.name': '@opentelemetry/instrumentation-pg',
        'otel.scope.version': '0.54.1',
        'span.kind': 'client',
    };
}

function generateNetworkSpanAttrs(operation) {
    if (operation === 'dns.lookup') {
        return {
            'otel.scope.name': '@opentelemetry/instrumentation-dns',
            'otel.scope.version': '0.46.0',
            'peer.ipv6': '::1',
            'peer[1].ipv4': '127.0.0.1',
            'span.kind': 'client',
        };
    }
    // tcp.connect
    return {
        'net.host.ip': '::1',
        'net.host.port': randInt(3000, 65535),
        'net.peer.ip': '::1',
        'net.peer.name': 'localhost',
        'net.peer.port': String(pick([5433, 16686, 5672, 8000])),
        'net.transport': 'ip_tcp',
        'otel.scope.name': '@opentelemetry/instrumentation-net',
        'otel.scope.version': '0.46.1',
        'span.kind': 'internal',
    };
}

function generateMessagingSpanAttrs(operation) {
    const pair = pick(['BTC/USD', 'ETH/USD', 'BTC/EUR']);
    return {
        'messaging.destination': pick(['payment_response', 'orders', 'notifications']),
        'messaging.operation': 'process',
        'messaging.source': pick(['payments', 'orders', 'matching']),
        'messaging.system': 'rabbitmq',
        'order.id': `ORD-${Date.now()}-${randInt(1, 10)}`,
        'order.pair': pair,
        'order.price': randFloat(30000, 100000, 2),
        'order.quantity': randFloat(0.001, 1, 4),
        'order.side': pick(['BUY', 'SELL']),
        'otel.scope.name': 'order-matcher',
        'otel.scope.version': '1.0.0',
        'otel.status_code': 'OK',
        'processor.id': `matcher-${Date.now()}`,
        'span.kind': 'consumer',
    };
}

function generateKongSpanAttrs() {
    return {
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'otel.scope.name': 'kong',
        'span.kind': 'server',
    };
}

function generateJaegerSpanAttrs() {
    return {
        'client.address': '172.21.0.1',
        'http.request.method': 'GET',
        'http.response.body.size': randInt(100000, 2000000),
        'http.response.status_code': 200,
        'http.route': '/api/traces',
        'network.peer.address': '172.21.0.1',
        'network.peer.port': randInt(50000, 65000),
        'network.protocol.version': '1.1',
        'otel.scope.name': 'go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp',
        'otel.scope.version': '0.63.0',
        'server.address': 'localhost',
        'server.port': 16686,
        'span.kind': 'server',
        'url.path': '/api/traces',
        'url.scheme': 'http',
        'user_agent.original': 'node',
    };
}

function getSpanAttrs(service, operation, category) {
    if (category === 'database') {
        if (operation.includes('pool')) return generatePoolSpanAttrs();
        return generateDbSpanAttrs(operation);
    }
    if (category === 'network') return generateNetworkSpanAttrs(operation);
    if (category === 'messaging') return generateMessagingSpanAttrs(operation);
    if (category === 'proxy' || category === 'plugin') return generateKongSpanAttrs();
    if (service === 'jaeger-all-in-one') return generateJaegerSpanAttrs();
    return generateHttpSpanAttrs(service, operation);
}

// ─── Prompt Generators ──────────────────────────────────────────

function generateShortPrompt(service, operation) {
    return `Analyze anomaly: ${service}:${operation}`;
}

function generateDetailedPrompt(service, operation, duration, metrics, severity, traceSpans, spanAttrs) {
    const deviation = duration.deviation;
    const sevLabel = SEVERITY_MAP[severity];
    const timestamp = new Date(Date.now() - randInt(0, 30 * 24 * 60 * 60 * 1000));
    const tsStr = timestamp.toString().replace(/\s\(.*\)$/, '');

    const autoIssues = [];
    if (metrics.errRate >= 50) autoIssues.push(`- 🔥 Critical error rate (${metrics.errRate}%) - service degradation`);
    else if (metrics.errRate >= 2) autoIssues.push(`- 📊 Notable error rate (${metrics.errRate}%)`);

    const spanCount = traceSpans.length + randInt(0, 5);
    const moreSpans = spanCount > traceSpans.length ? `\n... and ${spanCount - traceSpans.length} more spans` : '';

    let prompt = `You are an expert in distributed systems and observability. Analyze this performance anomaly:

## Anomaly Details
- Service: ${service}
- Operation: ${operation}
- Duration: ${duration.actual.toFixed(2)}ms (expected: ${duration.expected.toFixed(2)}ms ± ${duration.stddev.toFixed(2)}ms)
- Deviation: ${deviation.toFixed(2)}σ (standard deviations from mean)
- Severity: ${sevLabel}
- Timestamp: ${tsStr}

## Span Attributes
${JSON.stringify(spanAttrs, null, 2)}

## Correlated System Metrics (at time of anomaly)
- CPU Usage: ${metrics.cpu}%
- Memory: ${metrics.mem}MB
- Request Rate: ${metrics.reqRate === null ? 'N/A' : metrics.reqRate + ' req/s'}
- Error Rate: ${metrics.errRate}%${metrics.errRate >= 50 ? ' ⚠️ HIGH' : ''}
- P99 Latency: ${isNaN(metrics.p99) ? 'NaN' : metrics.p99}ms
- Active Connections: ${metrics.conns}`;

    if (autoIssues.length > 0) {
        prompt += `\n\n## Auto-Detected Issues\n${autoIssues.join('\n')}`;
    }

    prompt += `\n\n## Trace Context
The full trace contains ${spanCount} spans:
${traceSpans.map(s => `- ${s}`).join('\n')}${moreSpans}


Based on the trace data AND correlated metrics, provide:
1. A brief summary (1-2 sentences) of what likely caused this anomaly
2. 2-3 possible root causes (consider resource utilization if metrics show issues)
3. 2-3 actionable recommendations

Format your response as:
SUMMARY: [your summary]
CAUSES:
- [cause 1]
- [cause 2]
RECOMMENDATIONS:
- [recommendation 1]
- [recommendation 2]
CONFIDENCE: [low/medium/high]`;

    return prompt;
}

// ─── Output Formatters ──────────────────────────────────────────

function formatFullAnalysis(analysis) {
    return `SUMMARY: ${analysis.summary}\n\nCAUSES:\n${analysis.causes.map(c => `- ${c}`).join('\n')}\n\nRECOMMENDATIONS:\n${analysis.recommendations.map(r => `- ${r}`).join('\n')}\n\nCONFIDENCE: ${analysis.confidence}`;
}

// ─── Main Generator ─────────────────────────────────────────────

function generateExample() {
    const scenario = pick(SCENARIOS);
    const service = pick(scenario.services);
    const operation = pick(scenario.operations);
    const duration = scenario.duration();
    const metrics = scenario.metrics();
    const severity = scenario.severity();

    // Calculate deviation
    duration.deviation = duration.stddev > 0
        ? (duration.actual - duration.expected) / duration.stddev
        : randFloat(2, 30);

    // Find operation category
    const svcOps = SERVICES[service]?.operations || [];
    const opInfo = svcOps.find(o => o.name === operation) || { category: 'http' };

    // Generate trace spans
    const traceSpans = scenario.traceSpans(service, operation, duration);

    // Generate span attributes
    const spanAttrs = getSpanAttrs(service, operation, opInfo.category);

    // Always generate full structured analysis
    // (Dismissal/diagnostic outputs were poisoning the training data)
    const analysis = scenario.goodAnalysis(duration, metrics);
    const output = formatFullAnalysis(analysis);
    const useShortPrompt = randBool(0.15); // mostly detailed prompts

    // Generate prompt
    const instruction = useShortPrompt
        ? generateShortPrompt(service, operation)
        : generateDetailedPrompt(service, operation, duration, metrics, severity, traceSpans, spanAttrs);

    return {
        instruction,
        input: '',
        output,
    };
}

// ─── Entry Point ────────────────────────────────────────────────

function main() {
    const count = parseInt(process.argv[2]) || DEFAULT_COUNT;
    // --max N caps the combined file at N total samples (default: 100)
    const maxIdx = process.argv.indexOf('--max');
    const maxTotal = maxIdx !== -1 ? parseInt(process.argv[maxIdx + 1]) : 100;

    console.log(`🔧 Generating ${count} synthetic training examples...`);

    const examples = [];
    for (let i = 0; i < count; i++) {
        examples.push(generateExample());
    }

    // Write all synthetic data
    const syntheticLines = examples.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(OUTPUT_FILE, syntheticLines, 'utf8');
    console.log(`✅ Wrote ${count} examples to ${path.relative(process.cwd(), OUTPUT_FILE)}`);

    // Merge with existing data, capping at maxTotal
    if (fs.existsSync(EXISTING_FILE)) {
        const existingLines = fs.readFileSync(EXISTING_FILE, 'utf8').trim().split('\n');
        const syntheticArr = syntheticLines.trim().split('\n');
        const slotsForSynthetic = Math.max(0, maxTotal - existingLines.length);

        const forCombined = syntheticArr.slice(0, slotsForSynthetic);
        const forReserve = syntheticArr.slice(slotsForSynthetic);

        // Write combined (capped)
        const combined = existingLines.concat(forCombined).join('\n') + '\n';
        fs.writeFileSync(COMBINED_FILE, combined, 'utf8');
        const totalCombined = existingLines.length + forCombined.length;
        console.log(`✅ Combined: ${existingLines.length} real + ${forCombined.length} synthetic = ${totalCombined} total → ${path.relative(process.cwd(), COMBINED_FILE)}`);

        // Write reserve (overflow)
        if (forReserve.length > 0) {
            fs.writeFileSync(RESERVE_FILE, forReserve.join('\n') + '\n', 'utf8');
            console.log(`📦 Reserve: ${forReserve.length} extra examples → ${path.relative(process.cwd(), RESERVE_FILE)}`);
        }
    } else {
        console.log(`⚠️  Existing file not found: ${EXISTING_FILE}`);
        console.log(`   Synthetic data saved standalone.`);
    }

    // Print sample
    console.log('\n── Sample output (first example) ──────────');
    const sample = examples[0];
    console.log(`INSTRUCTION (${sample.instruction.length} chars):`);
    console.log(sample.instruction.substring(0, 200) + (sample.instruction.length > 200 ? '...' : ''));
    console.log(`\nOUTPUT (${sample.output.length} chars):`);
    console.log(sample.output.substring(0, 300) + (sample.output.length > 300 ? '...' : ''));
}

main();
