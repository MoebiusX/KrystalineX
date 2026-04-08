/**
 * Scripts Configuration
 * 
 * Centralized configuration for all scripts.
 * Reads from environment variables with sensible defaults.
 * 
 * Usage:
 *   import config from './config.js';
 *   console.log(config.server.url);
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Load .env file manually (no external dependency)
const envPath = path.join(rootDir, '.env');
if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=').trim();
            if (key && value && !process.env[key]) {
                process.env[key] = value;
            }
        }
    });
}

/**
 * Detect target environment: local (Docker Compose) or remote (krystaline.io)
 * Set via: E2E_TARGET=remote or --remote CLI flag
 */
const cliArgs = process.argv.slice(2);
const pauseIndex = cliArgs.indexOf('--pause');
const pauseArg = pauseIndex >= 0 ? cliArgs[pauseIndex + 1] : undefined;
const isRemote = cliArgs.includes('--remote') ||
    process.env.E2E_TARGET === 'remote' ||
    process.env.E2E_TARGET === 'krystaline';

function parsePauseSeconds(value) {
    if (value === undefined) {
        return 1;
    }

    if (!/^\d+$/.test(value)) {
        console.error('❌ Invalid --pause value. Use a non-negative integer number of seconds.');
        process.exit(1);
    }

    return parseInt(value, 10);
}

const retryPauseSeconds = parsePauseSeconds(process.env.E2E_RETRY_PAUSE_SECONDS || pauseArg);

const REMOTE_BASE = process.env.REMOTE_URL || 'https://www.krystaline.io';

if (isRemote) {
    console.log(`🌐 Target: REMOTE (${REMOTE_BASE})`);
} else {
    console.log('🏠 Target: LOCAL (Docker Compose / localhost)');
}

/**
 * Script configuration with environment variable overrides
 */
const config = {
    // Target environment
    isRemote,
    remoteBase: REMOTE_BASE,

    // E2E configuration
    e2e: {
        retryPauseSeconds,
        retryPauseMs: retryPauseSeconds * 1000,
    },

    // Server
    server: {
        host: process.env.HOST || 'localhost',
        port: parseInt(process.env.PORT || '5000', 10),
        get url() {
            if (isRemote) return `${REMOTE_BASE}/api`;
            return `http://${this.host}:${this.port}`;
        },
        get internalUrl() {
            if (isRemote) return REMOTE_BASE;
            return `http://localhost:${this.port}`;
        },
        get healthUrl() {
            if (isRemote) return `${REMOTE_BASE}/api/health`;
            return `${this.internalUrl}/health`;
        },
    },

    // Database
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5433', 10),
    },

    // RabbitMQ
    rabbitmq: {
        url: process.env.RABBITMQ_URL || 'amqp://admin:admin123@localhost:5672',
        managementPort: parseInt(process.env.RABBITMQ_MANAGEMENT_PORT || '15672', 10),
        // For health checks - always use localhost (Docker maps ports there)
        get managementUrl() {
            return `http://localhost:${this.managementPort}`;
        },
    },

    // Kong Gateway
    kong: {
        get gatewayUrl() {
            if (isRemote) return REMOTE_BASE;
            return process.env.KONG_GATEWAY_URL || 'http://localhost:8000';
        },
        adminUrl: process.env.KONG_ADMIN_URL || 'http://localhost:8001',
        get internalGatewayUrl() {
            if (isRemote) return REMOTE_BASE;
            return `http://localhost:${this.gatewayPort}`;
        },
        get internalAdminUrl() {
            return `http://localhost:${this.adminPort}`;
        },
        get gatewayHost() {
            return new URL(this.gatewayUrl).hostname;
        },
        get gatewayPort() {
            return parseInt(new URL(this.gatewayUrl).port || '8000', 10);
        },
        get adminHost() {
            return new URL(this.adminUrl).hostname;
        },
        get adminPort() {
            return parseInt(new URL(this.adminUrl).port || '8001', 10);
        },
    },

    // Observability
    observability: {
        get jaegerUrl() {
            if (isRemote) return `${REMOTE_BASE}/jaeger`;
            return process.env.JAEGER_URL || 'http://localhost:16686';
        },
        get prometheusUrl() {
            if (isRemote) return `${REMOTE_BASE}/prometheus`;
            return process.env.PROMETHEUS_URL || 'http://localhost:9090';
        },
        get otelCollectorUrl() {
            if (isRemote) return `${REMOTE_BASE}/otel`;
            return process.env.OTEL_COLLECTOR_URL || 'http://localhost:4318';
        },
        get lokiUrl() {
            if (isRemote) return `${REMOTE_BASE}/grafana/api/datasources/proxy/uid/loki`;
            return process.env.LOKI_URL || 'http://localhost:3100';
        },
        get grafanaUrl() {
            if (isRemote) return `${REMOTE_BASE}/grafana`;
            return process.env.GRAFANA_URL || 'http://localhost:3000';
        },
    },

    // Timeouts (in seconds)
    timeouts: {
        kongAdmin: parseInt(process.env.KONG_ADMIN_TIMEOUT || '30', 10),
        kongProxy: parseInt(process.env.KONG_PROXY_TIMEOUT || '45', 10),
        rabbitmq: parseInt(process.env.RABBITMQ_TIMEOUT || '30', 10),
        postgres: parseInt(process.env.POSTGRES_TIMEOUT || '30', 10),
        server: parseInt(process.env.SERVER_TIMEOUT || '60', 10),
    },

    // Vite / Client configuration (from VITE_ prefixed env vars)
    vite: {
        kongUrl: process.env.VITE_KONG_URL || 'http://localhost:8000',
        apiUrl: process.env.VITE_API_URL || 'http://localhost:5000',
        wsUrl: process.env.VITE_WS_URL || 'ws://localhost:5000/ws',
        port: 5173,  // Vite dev server port
    },

    // Platform detection
    isWindows: process.platform === 'win32',

    // Root directory
    rootDir,

    // Helper to get npm/npx command
    get npmCmd() {
        return this.isWindows ? 'npm.cmd' : 'npm';
    },
    get npxCmd() {
        return this.isWindows ? 'npx.cmd' : 'npx';
    },
};

// Log resolved configuration at startup
console.log('📋 Scripts Configuration Loaded:');
console.log('   Server:');
console.log(`      URL: ${config.server.url}`);
console.log(`      Health: ${config.server.healthUrl}`);
console.log('   Database:');
console.log(`      Host: ${config.database.host}:${config.database.port}`);
console.log('   RabbitMQ:');
console.log(`      URL: ${config.rabbitmq.url.replace(/:[^:@]+@/, ':****@')}`);
console.log(`      Management: ${config.rabbitmq.managementUrl}`);
console.log('   Kong Gateway:');
console.log(`      Gateway: ${config.kong.gatewayUrl}`);
console.log(`      Admin: ${config.kong.adminUrl}`);
console.log('   Observability:');
console.log(`      Jaeger: ${config.observability.jaegerUrl}`);
console.log(`      Prometheus: ${config.observability.prometheusUrl}`);
console.log(`      Loki: ${config.observability.lokiUrl}`);
console.log(`      Grafana: ${config.observability.grafanaUrl}`);
console.log(`      OTEL Collector: ${config.observability.otelCollectorUrl}`);
console.log('   Timeouts (seconds):');
console.log(`      Kong Admin: ${config.timeouts.kongAdmin}s, Proxy: ${config.timeouts.kongProxy}s`);
console.log(`      RabbitMQ: ${config.timeouts.rabbitmq}s, Postgres: ${config.timeouts.postgres}s`);
console.log(`      Server: ${config.timeouts.server}s`);
console.log('   E2E:');
console.log(`      Retry pause: ${config.e2e.retryPauseSeconds}s`);
console.log('');

export default config;
