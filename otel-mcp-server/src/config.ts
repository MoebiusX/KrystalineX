/**
 * Environment-based configuration with sensible defaults.
 *
 * All settings can be overridden via environment variables.
 * See .env.example for the full list.
 */

import { loadBackendAuth, type BackendAuthConfig } from './auth.js';

export interface Config {
  /** Jaeger Query API URL */
  jaegerUrl: string;
  /** Prometheus API URL */
  prometheusUrl: string;
  /** Loki API URL */
  lokiUrl: string;
  /** Optional Prometheus path prefix (e.g. /prometheus) */
  prometheusPathPrefix: string;
  /** Optional application API URL (for ZK proofs, anomaly detection, system health) */
  appApiUrl: string;
  /** Default HTTP timeout for backend queries (ms) */
  timeoutMs: number;
  /** Backend authentication credentials */
  auth: BackendAuthConfig;
}

export function loadConfig(): Config {
  return {
    jaegerUrl: env('JAEGER_URL', 'http://localhost:16686'),
    prometheusUrl: env('PROMETHEUS_URL', 'http://localhost:9090'),
    lokiUrl: env('LOKI_URL', 'http://localhost:3100'),
    prometheusPathPrefix: env('PROMETHEUS_PATH_PREFIX', ''),
    appApiUrl: env('APP_API_URL', 'http://localhost:5000'),
    timeoutMs: parseInt(env('MCP_TIMEOUT_MS', '15000'), 10),
    auth: loadBackendAuth(),
  };
}

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}
