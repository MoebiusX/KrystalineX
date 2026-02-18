"""
Generate clean, properly formatted training data for the anomaly-analyzer model.
Each sample has an instruction (the full prompt) and output (properly formatted response).
"""
import json
import random

# Realistic anomaly scenarios for a crypto exchange platform
scenarios = [
    {
        "service": "kx-exchange",
        "operation": "pg-pool.connect",
        "duration": 276.32,
        "expected_mean": 2.58,
        "expected_std": 1.82,
        "deviation": 6.89,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"db.system": "postgresql", "db.connection_string": "pg-pool.connect"},
        "summary": "The pg-pool.connect operation took 276ms instead of the expected 2.58ms, indicating a connection pool exhaustion event. This is typically caused by either a burst of concurrent requests depleting available connections, or by idle connections being reaped by PostgreSQL while the pool was not replenished.",
        "causes": [
            "Connection pool exhaustion due to a sudden spike in concurrent database requests exceeding the max pool size",
            "PostgreSQL's idle connection timeout may have closed stale connections, forcing new TCP handshakes",
            "DNS resolution delay for the database host during connection establishment"
        ],
        "recommendations": [
            "Increase the connection pool's min and max size to handle traffic spikes (current max may be too low for peak load)",
            "Configure connection pool idle timeout to match PostgreSQL's idle_in_transaction_session_timeout",
            "Add connection pool metrics (available, waiting, total) to the monitoring dashboard for early warning"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "pg.query:SELECT",
        "duration": 845.12,
        "expected_mean": 12.34,
        "expected_std": 5.67,
        "deviation": 14.7,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"db.system": "postgresql", "db.statement": "SELECT * FROM orders WHERE user_id = $1"},
        "summary": "A SELECT query on the orders table took 845ms, far exceeding the 12ms baseline. This extreme deviation suggests the query hit a sequential scan instead of using the expected index, likely due to table bloat or an outdated query plan after a large batch of inserts.",
        "causes": [
            "Missing or stale index on the orders table's user_id column, forcing a sequential scan",
            "PostgreSQL autovacuum has not run recently, causing table bloat and inflated page reads",
            "Lock contention from a concurrent long-running transaction holding a share lock on the orders table"
        ],
        "recommendations": [
            "Run EXPLAIN ANALYZE on the slow query to confirm whether the index is being used, and re-create the index if necessary",
            "Check pg_stat_user_tables for dead tuple count and trigger a manual VACUUM ANALYZE if autovacuum is lagging",
            "Consider adding a composite index on (user_id, created_at) for time-bounded order queries"
        ],
        "confidence": "high"
    },
    {
        "service": "api-gateway",
        "operation": "kong.proxy",
        "duration": 1523.45,
        "expected_mean": 45.2,
        "expected_std": 22.1,
        "deviation": 6.7,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"http.method": "POST", "http.route": "/api/v1/orders", "http.status_code": 200},
        "summary": "The Kong API gateway proxy took 1.5s to route a POST request to the orders endpoint, far above the 45ms baseline. This indicates downstream service latency rather than a gateway issue, as the request ultimately succeeded with a 200 status.",
        "causes": [
            "The downstream kx-exchange service was experiencing high latency due to database connection pool exhaustion",
            "Kong's upstream health checks may have marked the primary target as unhealthy, causing a failover to a slower backup",
            "Network latency spike between the Kong gateway container and the upstream service container"
        ],
        "recommendations": [
            "Check the kx-exchange service's latency metrics around the same timestamp to identify if the delay originates from the application layer",
            "Review Kong's upstream health check configuration to ensure timeouts and thresholds are tuned for the expected response times",
            "Add request-level tracing correlation between Kong and downstream services for faster root cause isolation"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "rabbitmq.publish",
        "duration": 312.78,
        "expected_mean": 3.45,
        "expected_std": 2.11,
        "deviation": 14.6,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"messaging.system": "rabbitmq", "messaging.destination": "order.matched"},
        "summary": "Publishing a message to the RabbitMQ order.matched queue took 312ms instead of the expected 3.4ms. This suggests either a TCP connection re-establishment to the broker, publisher confirms blocking due to queue backpressure, or a RabbitMQ cluster partition event.",
        "causes": [
            "AMQP connection was closed by RabbitMQ due to heartbeat timeout, forcing a reconnection during the publish attempt",
            "Publisher confirms mode is enabled and the broker is applying backpressure due to slow consumers on the order.matched queue",
            "RabbitMQ's memory alarm was triggered, causing all publishers to be temporarily blocked"
        ],
        "recommendations": [
            "Check RabbitMQ management UI for memory and disk alarms around the anomaly timestamp",
            "Review the consumer count and consumer utilization rate for the order.matched queue to identify potential bottlenecks",
            "Implement connection pooling and heartbeat monitoring for the AMQP client to detect and recover from silent disconnections faster"
        ],
        "confidence": "medium"
    },
    {
        "service": "payment-processor",
        "operation": "process.payment",
        "duration": 2341.56,
        "expected_mean": 125.8,
        "expected_std": 45.3,
        "deviation": 4.9,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"payment.method": "crypto", "payment.currency": "BTC", "payment.amount": "0.5"},
        "summary": "Payment processing took 2.3s instead of the expected 125ms. Given the crypto payment method, this likely reflects blockchain confirmation latency or an external API call timeout to the price oracle, not an application-level issue.",
        "causes": [
            "Bitcoin network congestion increasing the time to verify the transaction against the mempool",
            "External price oracle API (e.g., Binance) responded slowly due to rate limiting or temporary degradation",
            "Wallet balance verification required an additional RPC call to the Bitcoin node, adding round-trip latency"
        ],
        "recommendations": [
            "Implement circuit breaker pattern around external blockchain API calls with a fallback to cached prices",
            "Add a separate timeout for blockchain verification vs. internal payment logic to prevent cascading delays",
            "Consider asynchronous payment confirmation with webhook notifications instead of synchronous blocking"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "order.match",
        "duration": 567.89,
        "expected_mean": 8.92,
        "expected_std": 4.15,
        "deviation": 13.5,
        "severity": 1,
        "severity_name": "Critical",
        "attributes": {"order.type": "limit", "order.pair": "BTC/USDT", "order.side": "buy"},
        "summary": "Order matching took 567ms instead of the expected 8.9ms, a critical 13.5σ deviation. This indicates the order book data structure is severely degraded, likely due to an excessive number of open orders at similar price levels causing O(n) scans instead of the expected O(log n) tree lookups.",
        "causes": [
            "Order book fragmentation with an unusually high number of limit orders at adjacent price levels, degrading the matching algorithm's performance",
            "A market data replay or bulk order import flooded the order book, temporarily overloading the matching engine",
            "Memory pressure causing the JIT-compiled matching logic to be deoptimized, falling back to interpreted execution"
        ],
        "recommendations": [
            "Profile the order book data structure under high cardinality scenarios and consider switching to a more cache-friendly implementation",
            "Implement order book depth limits that reject or queue new orders when the book exceeds a configurable threshold",
            "Add real-time order book depth metrics to the monitoring dashboard to detect saturation before it impacts matching latency"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "http.request",
        "duration": 3125.0,
        "expected_mean": 180.5,
        "expected_std": 65.2,
        "deviation": 4.5,
        "severity": 4,
        "severity_name": "Minor",
        "attributes": {"http.method": "GET", "http.url": "/api/v1/market/orderbook/BTC-USDT", "http.status_code": 200},
        "summary": "The order book API endpoint took 3.1 seconds to respond, well above the 180ms baseline. The successful 200 status code rules out upstream failures; this is likely an application-level performance regression, possibly related to serializing a large order book response payload.",
        "causes": [
            "Large order book payload (potentially tens of thousands of price levels) causing high JSON serialization overhead",
            "Node.js event loop blocking due to synchronous computation during order book aggregation",
            "Garbage collection pause in the V8 engine triggered by high memory allocation during response construction"
        ],
        "recommendations": [
            "Implement server-side pagination or depth limits for order book API responses to cap payload size",
            "Profile the order book serialization path with clinicjs or 0x to identify CPU-bound bottlenecks",
            "Consider pre-serializing and caching the order book snapshot and invalidating on book changes rather than constructing it per-request"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "tcp.connect",
        "duration": 450.23,
        "expected_mean": 1.2,
        "expected_std": 0.8,
        "deviation": 56.1,
        "severity": 1,
        "severity_name": "Critical",
        "attributes": {"net.peer.name": "app-database", "net.peer.port": 5432},
        "summary": "TCP connection to the PostgreSQL database took 450ms instead of the expected 1.2ms. This extreme 56σ deviation indicates a network-level issue, not an application bug. The container networking layer likely experienced a DNS resolution timeout or a TCP SYN retransmission.",
        "causes": [
            "Docker DNS resolution timeout for the 'app-database' container hostname, possibly due to Docker's embedded DNS cache expiry",
            "TCP SYN packet loss causing a retransmission cycle with exponential backoff",
            "The app-database container was briefly unreachable during a Docker network reconfiguration or container restart"
        ],
        "recommendations": [
            "Add explicit /etc/hosts entries or use static IPs for critical database containers to avoid DNS resolution delays",
            "Monitor container restart events and correlate them with connection anomalies to identify infrastructure instability",
            "Implement connection pre-warming on service startup to detect database connectivity issues before handling traffic"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "pg.query:INSERT",
        "duration": 189.45,
        "expected_mean": 5.67,
        "expected_std": 3.12,
        "deviation": 5.9,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"db.system": "postgresql", "db.statement": "INSERT INTO transactions"},
        "summary": "An INSERT into the transactions table took 189ms instead of the expected 5.7ms. This is consistent with PostgreSQL's autovacuum running concurrently on the transactions table, causing I/O contention and increased write latency.",
        "causes": [
            "Autovacuum running on the transactions table, competing for I/O bandwidth with the INSERT operation",
            "WAL (Write-Ahead Log) sync delay due to high write throughput exceeding the disk's sustained IOPS capacity",
            "Row-level lock contention from a concurrent transaction holding a lock on the same partition"
        ],
        "recommendations": [
            "Tune autovacuum parameters for the transactions table (reduce vacuum_cost_delay, increase vacuum_cost_limit) to minimize I/O impact",
            "Monitor WAL write latency and consider moving the WAL directory to a dedicated SSD if write latency is consistently high",
            "Consider table partitioning by date for the transactions table to reduce lock contention and autovacuum scope"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "redis.get",
        "duration": 125.67,
        "expected_mean": 0.45,
        "expected_std": 0.22,
        "deviation": 56.9,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"db.system": "redis", "db.operation": "GET", "db.redis.key": "session:user:*"},
        "summary": "A Redis GET operation took 125ms instead of the expected 0.45ms. Redis is single-threaded, so this extreme latency indicates either a blocking command (KEYS, SAVE) running concurrently, or a Redis cluster failover in progress.",
        "causes": [
            "A blocking command like KEYS or DEBUG SLEEP was executed by another client, blocking the event loop for all operations",
            "Redis RDB persistence (BGSAVE) was triggered, causing a fork and temporary memory pressure that delayed command processing",
            "Network partition between the application container and the Redis container caused a connection retry cycle"
        ],
        "recommendations": [
            "Replace KEYS usage with SCAN in all application code to prevent blocking the Redis event loop",
            "Switch from RDB snapshots to AOF persistence with everysec fsync to avoid BGSAVE-related latency spikes",
            "Add Redis SLOWLOG monitoring and alert when commands exceed 10ms to catch blocking operations early"
        ],
        "confidence": "high"
    },
    {
        "service": "api-gateway",
        "operation": "kong.auth",
        "duration": 890.12,
        "expected_mean": 15.3,
        "expected_std": 8.7,
        "deviation": 10.1,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"http.method": "POST", "http.route": "/api/v1/orders", "kong.plugin": "jwt"},
        "summary": "JWT authentication in Kong took 890ms instead of the expected 15ms. This suggests the JWT plugin's public key retrieval failed and triggered a retry, or the Kong database lookup for consumer credentials experienced a slow query.",
        "causes": [
            "JWT public key cache miss forcing Kong to fetch the key from the database, which was under high load",
            "Kong's PostgreSQL database connection pool was exhausted, delaying the consumer credentials lookup",
            "DNS resolution failure for the JWKS endpoint causing a timeout and retry before falling back to cached keys"
        ],
        "recommendations": [
            "Increase Kong's JWT key cache TTL to reduce database lookups for public keys during traffic spikes",
            "Monitor Kong's database connection pool utilization and increase the pool size if it frequently hits the limit",
            "Pre-cache JWT keys on Kong startup and implement a background refresh instead of on-demand fetching"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "websocket.broadcast",
        "duration": 456.78,
        "expected_mean": 2.1,
        "expected_std": 1.5,
        "deviation": 30.3,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"ws.clients": 847, "ws.message_type": "orderbook_update"},
        "summary": "Broadcasting an order book update to 847 WebSocket clients took 456ms instead of the expected 2.1ms. The message fan-out is creating significant event loop blocking, likely because messages are being serialized individually per client instead of using a shared buffer.",
        "causes": [
            "JSON serialization performed per-client instead of once, multiplying CPU work by the number of connected clients",
            "Node.js event loop saturation from synchronous iteration over 847 WebSocket connections in a tight loop",
            "TCP send buffer saturation for clients on slow connections, causing ws.send() to block waiting for drainage"
        ],
        "recommendations": [
            "Serialize the order book update once and broadcast the pre-serialized buffer to all clients to avoid redundant JSON.stringify calls",
            "Implement batched broadcasting with setImmediate() between chunks to yield the event loop and prevent blocking",
            "Add slow-client detection and disconnect clients that consistently fail to drain their send buffers within a threshold"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "pg.transaction",
        "duration": 1234.56,
        "expected_mean": 35.0,
        "expected_std": 15.0,
        "deviation": 8.0,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"db.system": "postgresql", "db.operation": "transaction", "transaction.type": "order_settlement"},
        "summary": "An order settlement transaction took 1.2s instead of the expected 35ms. The transaction involves multiple table updates (orders, wallets, transactions) and the delay is consistent with a deadlock retry, where two concurrent settlements competed for the same wallet rows.",
        "causes": [
            "Deadlock between two concurrent order settlement transactions both attempting to update the same wallet balances in different orders",
            "A long-running read query holding a shared lock on the wallets table, blocking the exclusive lock needed for the balance update",
            "PostgreSQL serialization failure under SERIALIZABLE isolation level, causing an automatic retry with accumulated latency"
        ],
        "recommendations": [
            "Implement consistent lock ordering by always acquiring wallet locks in ascending user_id order to prevent circular deadlocks",
            "Use SELECT ... FOR UPDATE SKIP LOCKED to gracefully handle contention instead of blocking on locked rows",
            "Add deadlock detection metrics and log the deadlock graph details for post-mortem analysis of contention patterns"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "crypto.wallet.balance",
        "duration": 678.9,
        "expected_mean": 18.5,
        "expected_std": 9.2,
        "deviation": 7.2,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"wallet.currency": "ETH", "wallet.operation": "balance_check"},
        "summary": "Wallet balance check took 678ms instead of the expected 18ms. The delay likely stems from an uncached balance aggregation query that sums all transactions for the wallet instead of using a pre-computed balance column.",
        "causes": [
            "Balance calculation using a SUM aggregate over the transactions table instead of reading a pre-computed balance column",
            "The transactions table has grown significantly and the aggregate query is performing a full table scan on the user's partition",
            "Connection pool starvation caused the balance check to wait for an available database connection"
        ],
        "recommendations": [
            "Implement a materialized balance column on the wallets table that is updated atomically during each transaction, eliminating the need for SUM aggregation",
            "Add a Redis cache layer for wallet balances with write-through invalidation on balance changes",
            "Create a partial index on transactions(wallet_id) WHERE settled = true to speed up balance aggregation queries"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "jwt.verify",
        "duration": 234.5,
        "expected_mean": 1.8,
        "expected_std": 0.9,
        "deviation": 25.8,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"auth.method": "jwt", "auth.token_length": 1024},
        "summary": "JWT token verification took 234ms instead of the expected 1.8ms. This extreme deviation suggests the JWK key cache expired and a synchronous HTTP fetch to the JWKS endpoint was needed, or the token payload was unusually large requiring more computation.",
        "causes": [
            "JWKS endpoint cache miss triggering a synchronous HTTP call to fetch the public key, adding network round-trip latency",
            "The JWT token contained an unusually large payload with embedded permissions, increasing cryptographic verification time",
            "Node.js crypto module contention due to multiple concurrent JWT verifications saturating the thread pool"
        ],
        "recommendations": [
            "Pre-fetch and cache JWKS keys on startup with a background refresh interval instead of on-demand fetching",
            "Limit JWT payload size by moving detailed permissions to a database lookup instead of embedding them in the token",
            "Use the UV_THREADPOOL_SIZE environment variable to increase the Node.js crypto thread pool for high-concurrency scenarios"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "market.data.aggregate",
        "duration": 1890.23,
        "expected_mean": 45.0,
        "expected_std": 20.0,
        "deviation": 9.2,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"market.pair": "BTC/USDT", "market.timeframe": "1h", "market.candles": 720},
        "summary": "Market data aggregation for 720 hourly candles took 1.89s instead of the expected 45ms. The 30-day lookback window is generating a large dataset that requires significant CPU time for OHLCV calculation, exacerbated by the lack of pre-aggregated candlestick data.",
        "causes": [
            "Computing OHLCV candles from raw trade data on every request instead of using pre-aggregated materialized views",
            "The trades table lacks a proper composite index on (pair, timestamp) for efficient range scans over the 30-day window",
            "Event loop blocking during the synchronous aggregation of 720 candle buckets from potentially millions of raw trades"
        ],
        "recommendations": [
            "Implement pre-computed candlestick data using PostgreSQL materialized views or a dedicated time-series store like TimescaleDB",
            "Add a composite index on trades(pair, created_at) and use a covering index that includes price and volume columns",
            "Offload heavy aggregation to a worker thread or background job and serve pre-computed results from cache"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "email.send",
        "duration": 5432.1,
        "expected_mean": 250.0,
        "expected_std": 100.0,
        "deviation": 5.2,
        "severity": 4,
        "severity_name": "Minor",
        "attributes": {"email.type": "order_confirmation", "email.provider": "maildev"},
        "summary": "Sending an order confirmation email took 5.4 seconds instead of the expected 250ms. Since this is a development environment using MailDev, the delay is likely due to the MailDev container being under memory pressure or the SMTP connection timing out and retrying.",
        "causes": [
            "MailDev container memory limit reached, causing slow response to incoming SMTP connections",
            "SMTP connection timeout and retry due to MailDev not responding to the initial connection attempt",
            "DNS resolution delay for the maildev container hostname in the Docker network"
        ],
        "recommendations": [
            "Move email sending to an async background queue so it does not block the order confirmation response",
            "Add SMTP connection health checks and pre-warm the SMTP connection pool on service startup",
            "In production, use a managed email service (e.g., SES, SendGrid) with async delivery and webhook confirmations"
        ],
        "confidence": "low"
    },
    {
        "service": "kx-exchange",
        "operation": "otel.export",
        "duration": 789.0,
        "expected_mean": 10.0,
        "expected_std": 5.0,
        "deviation": 15.6,
        "severity": 3,
        "severity_name": "Warning",
        "attributes": {"otel.exporter": "otlp", "otel.spans_count": 45, "otel.endpoint": "jaeger:4317"},
        "summary": "Exporting 45 spans via OTLP to Jaeger took 789ms instead of the expected 10ms. The telemetry pipeline is experiencing backpressure, likely because the Jaeger collector's gRPC endpoint is overloaded or the batch export buffer exceeded its configured size.",
        "causes": [
            "Jaeger collector gRPC endpoint (port 4317) is saturated with incoming spans from multiple services simultaneously",
            "The OTLP batch exporter exceeded its maxQueueSize, triggering a synchronous flush that blocked the export operation",
            "Network congestion between the application container and the Jaeger container on the Docker bridge network"
        ],
        "recommendations": [
            "Increase the OTLP batch exporter's maxExportBatchSize and scheduledDelayMillis to reduce export frequency",
            "Monitor Jaeger collector's spans received/dropped rate and scale the collector if drops are occurring",
            "Ensure telemetry export is non-blocking by using an async export strategy that does not impact application request latency"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "user.register",
        "duration": 1567.89,
        "expected_mean": 120.0,
        "expected_std": 40.0,
        "deviation": 3.6,
        "severity": 4,
        "severity_name": "Minor",
        "attributes": {"auth.method": "email", "user.role": "trader"},
        "summary": "User registration took 1.5s instead of the expected 120ms. The registration flow involves password hashing (bcrypt), database insert, and welcome email, and the deviation is consistent with bcrypt's work factor being set higher than optimal for the server's CPU.",
        "causes": [
            "Bcrypt password hashing with a high cost factor (e.g., 12+) consuming significant CPU time on the single-threaded event loop",
            "The welcome email send is synchronous and blocking the registration response while waiting for SMTP acknowledgment",
            "Database constraint checks (unique email, username) requiring full index scans on a large users table"
        ],
        "recommendations": [
            "Offload bcrypt hashing to a worker thread using worker_threads or a dedicated hashing microservice to avoid blocking the event loop",
            "Make the welcome email send asynchronous (fire-and-forget or queue-based) so registration completes immediately",
            "Review the bcrypt cost factor and calibrate it to complete within 100-250ms on the production hardware"
        ],
        "confidence": "medium"
    },
    {
        "service": "kx-exchange",
        "operation": "pg.query:UPDATE",
        "duration": 423.0,
        "expected_mean": 8.0,
        "expected_std": 4.0,
        "deviation": 10.4,
        "severity": 2,
        "severity_name": "Major",
        "attributes": {"db.system": "postgresql", "db.statement": "UPDATE wallets SET balance = balance + $1 WHERE id = $2"},
        "summary": "A wallet balance UPDATE took 423ms instead of the expected 8ms. The row-level lock on the wallet was likely held by a concurrent transaction (e.g., another order settlement), causing this UPDATE to wait for lock acquisition before proceeding.",
        "causes": [
            "Row-level lock contention on the wallet row: another concurrent transaction held a FOR UPDATE lock on the same wallet ID",
            "PostgreSQL's automatic deadlock detection triggered a rollback and retry cycle for this transaction",
            "The wallets table TOAST storage was triggered for a large JSONB metadata column, adding I/O overhead"
        ],
        "recommendations": [
            "Use advisory locks or application-level queuing for wallet balance updates to serialize access without relying on row locks",
            "Add pg_stat_activity monitoring for lock waits exceeding 100ms and alert on sustained lock contention",
            "Consider using optimistic concurrency control (version column) instead of pessimistic locking for wallet balance updates"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "price.feed.update",
        "duration": 890.0,
        "expected_mean": 5.0,
        "expected_std": 3.0,
        "deviation": 29.5,
        "severity": 1,
        "severity_name": "Critical",
        "attributes": {"feed.source": "binance", "feed.pair": "BTC/USDT", "feed.type": "websocket"},
        "summary": "Price feed update processing took 890ms instead of the expected 5ms. At 29.5σ deviation, this is a critical anomaly indicating the WebSocket feed from Binance was interrupted and a full reconnection cycle occurred, including re-subscribing to all trading pairs.",
        "causes": [
            "Binance WebSocket connection dropped due to Binance's 24-hour connection limit policy, necessitating a full reconnection",
            "Network instability caused the WebSocket ping/pong heartbeat to timeout, triggering an automatic reconnection",
            "The incoming price data burst after reconnection overwhelmed the message processing queue, creating a backlog"
        ],
        "recommendations": [
            "Implement proactive WebSocket reconnection before hitting Binance's 24-hour limit (reconnect at 23 hours)",
            "Add a fallback to the REST API for latest prices during WebSocket reconnection to prevent stale price display",
            "Buffer and deduplicate incoming price updates after reconnection to avoid processing the burst of catchup messages"
        ],
        "confidence": "high"
    },
    {
        "service": "kx-exchange",
        "operation": "middleware.rateLimit",
        "duration": 345.67,
        "expected_mean": 0.5,
        "expected_std": 0.3,
        "deviation": 115.1,
        "severity": 1,
        "severity_name": "Critical",
        "attributes": {"rate_limit.key": "user:1234", "rate_limit.window": "60s", "rate_limit.limit": 100},
        "summary": "Rate limiting middleware took 345ms instead of the expected 0.5ms. This 115σ deviation indicates the rate limiter's backing store (likely Redis or in-memory map) is experiencing severe latency, making every API request pay the cost of the rate limit check.",
        "causes": [
            "The rate limiter is using a Redis-backed store and the Redis connection was lost, triggering reconnection and timeout",
            "An in-memory rate limiter's cleanup timer fired during the request, synchronously evicting expired entries from a large map",
            "The rate limiting algorithm (sliding window log) is performing O(n) operations on a large request log for high-traffic users"
        ],
        "recommendations": [
            "Switch to a fixed window or token bucket algorithm with O(1) lookup complexity instead of sliding window log",
            "Add a circuit breaker around the rate limiter: if the backing store is slow, fail open rather than adding latency to all requests",
            "Monitor rate limiter latency as a separate metric and alert when p99 exceeds 10ms"
        ],
        "confidence": "high"
    }
]

def build_instruction(s):
    """Build the instruction in the same format as AnalysisService.buildPrompt"""
    return f"""You are an expert in distributed systems and observability. Analyze this performance anomaly:

## Anomaly Details
- Service: {s['service']}
- Operation: {s['operation']}
- Duration: {s['duration']}ms (expected: {s['expected_mean']}ms ± {s['expected_std']}ms)
- Deviation: {s['deviation']}σ (standard deviations from mean)
- Severity: SEV{s['severity']} ({s['severity_name']})

## Span Attributes
{json.dumps(s['attributes'], indent=2)}

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
CONFIDENCE: [low/medium/high]"""

def build_output(s):
    """Build the expected output in the format parseResponse expects"""
    causes = "\n".join(f"- {c}" for c in s['causes'])
    recs = "\n".join(f"- {r}" for r in s['recommendations'])
    return f"""SUMMARY: {s['summary']}
CAUSES:
{causes}
RECOMMENDATIONS:
{recs}
CONFIDENCE: {s['confidence']}"""

# Generate training data
output_file = 'data/training-data-axolotl.jsonl'
with open(output_file, 'w', encoding='utf-8') as f:
    for scenario in scenarios:
        entry = {
            "instruction": build_instruction(scenario),
            "input": "",
            "output": build_output(scenario)
        }
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')

print(f"Generated {len(scenarios)} training samples to {output_file}")

# Validation
with open(output_file, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"\nValidation:")
all_good = True
for i, line in enumerate(lines):
    d = json.loads(line)
    out = d['output']
    has_summary = 'SUMMARY:' in out
    has_causes = 'CAUSES:' in out
    has_recs = 'RECOMMENDATIONS:' in out
    has_conf = 'CONFIDENCE:' in out
    ok = has_summary and has_causes and has_recs and has_conf
    if not ok:
        all_good = False
    print(f"  [{i:2d}] {'✅' if ok else '❌'} len={len(out):5d} S={has_summary} C={has_causes} R={has_recs} CF={has_conf}")

print(f"\n{'✅ All samples valid!' if all_good else '❌ Some samples have issues!'}")
