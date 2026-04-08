/**
 * Authentication for both sides of the MCP server:
 *
 * 1. **Backend auth** — credentials the MCP server uses when calling
 *    telemetry backends (Jaeger, Prometheus, Loki, etc.).
 *    Each skill resolves its own auth via `buildAuth(envPrefix)`.
 *
 * 2. **Client auth** — API keys that clients must present to use
 *    the MCP server (HTTP transport only; stdio is inherently local).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
//  Backend Auth — outbound credentials for telemetry backends
// ═══════════════════════════════════════════════════════════════════════════

export interface BackendAuth {
  /** Authorization header value (e.g. "Bearer xxx" or "Basic xxx") */
  authorization?: string;
  /** Extra headers to attach (e.g. X-Scope-OrgID for multi-tenant Loki) */
  extraHeaders?: Record<string, string>;
}

/**
 * Build backend auth from environment variables for a given prefix.
 *
 * Supported env vars (replace PREFIX with e.g. JAEGER, PROMETHEUS, LOKI):
 *   PREFIX_AUTH_TOKEN   — Bearer token (sets Authorization: Bearer <token>)
 *   PREFIX_AUTH_BASIC   — Basic auth in user:password format
 *   PREFIX_AUTH_HEADER  — Raw Authorization header value (overrides token/basic)
 */
export function buildAuth(prefix: string): BackendAuth {
  const header = process.env[`${prefix}_AUTH_HEADER`];
  if (header) return { authorization: header };

  const token = process.env[`${prefix}_AUTH_TOKEN`];
  if (token) return { authorization: `Bearer ${token}` };

  const basic = process.env[`${prefix}_AUTH_BASIC`]; // user:password
  if (basic) {
    const encoded = Buffer.from(basic).toString('base64');
    return { authorization: `Basic ${encoded}` };
  }

  return {};
}

/**
 * Build a Headers object for a fetch() call to a specific backend.
 */
export function backendHeaders(auth: BackendAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.authorization) headers['Authorization'] = auth.authorization;
  if (auth.extraHeaders) Object.assign(headers, auth.extraHeaders);
  return headers;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Client Auth — inbound API key verification (HTTP transport)
// ═══════════════════════════════════════════════════════════════════════════

export interface ClientKey {
  /** Unique key identifier (for logging/auditing) */
  id: string;
  /** The API key value */
  key: string;
  /** Human-readable description */
  description?: string;
  /** Optional: restrict to specific tool groups */
  allowedTools?: string[];
}

interface KeysFile {
  keys: ClientKey[];
}

/**
 * Load client API keys from environment or file.
 *
 * Sources (first match wins):
 *   1. MCP_AUTH_KEYS env var — JSON string (ideal for containers / K8s secrets)
 *   2. MCP_AUTH_KEYS_FILE env var — path to a JSON file (K8s mounted secret)
 *   3. ./auth-keys.json (cwd)
 *   4. ~/.otel-mcp/auth-keys.json (home dir — local dev)
 *
 * If no source is found, client auth is disabled (open access).
 * A warning is logged when running in HTTP mode without auth.
 *
 * File / env var format:
 * ```json
 * {
 *   "keys": [
 *     { "id": "dev-1", "key": "sk-...", "description": "Local dev" },
 *     { "id": "ci", "key": "sk-...", "allowedTools": ["traces", "metrics"] }
 *   ]
 * }
 * ```
 */
export function loadClientKeys(): ClientKey[] {
  // 1. Inline JSON from env var (container-friendly)
  const envKeys = process.env['MCP_AUTH_KEYS'];
  if (envKeys) {
    try {
      const parsed: KeysFile = JSON.parse(envKeys);
      if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
        console.error(`  Auth:    ${parsed.keys.length} client key(s) loaded from MCP_AUTH_KEYS env`);
        return parsed.keys;
      }
    } catch (err: any) {
      console.error(`  Auth:    ⚠ Failed to parse MCP_AUTH_KEYS env: ${err.message}`);
    }
  }

  // 2. File path from env, cwd, or home dir
  const searchPaths = [
    process.env['MCP_AUTH_KEYS_FILE'],
    resolve(process.cwd(), 'auth-keys.json'),
    resolve(process.env['HOME'] || process.env['USERPROFILE'] || '.', '.otel-mcp', 'auth-keys.json'),
  ].filter(Boolean) as string[];

  for (const filePath of searchPaths) {
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed: KeysFile = JSON.parse(raw);
        if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
          console.error(`  Auth:    ${parsed.keys.length} client key(s) loaded from ${filePath}`);
          return parsed.keys;
        }
      } catch (err: any) {
        console.error(`  Auth:    ⚠ Failed to parse ${filePath}: ${err.message}`);
      }
    }
  }

  return [];
}

/**
 * Validate an incoming request's API key.
 *
 * Extracts the key from:
 *   1. Authorization: Bearer <key>
 *   2. X-API-Key: <key>
 *
 * Returns the matching ClientKey, or null if invalid.
 */
export function validateClientKey(
  keys: ClientKey[],
  authHeader?: string,
  apiKeyHeader?: string,
): ClientKey | null {
  if (keys.length === 0) return null; // auth disabled — allow all

  let providedKey: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!providedKey) return null;

  // Constant-time comparison would be ideal, but for API keys
  // (not passwords), this is acceptable. Use crypto.timingSafeEqual
  // if you need stronger guarantees.
  return keys.find(k => k.key === providedKey) || null;
}
