/**
 * Authentication for both sides of the MCP server:
 *
 * 1. **Backend auth** — credentials the MCP server uses when calling
 *    Jaeger, Prometheus, Loki, and the application API.
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

export interface BackendAuthConfig {
  jaeger: BackendAuth;
  prometheus: BackendAuth;
  loki: BackendAuth;
  appApi: BackendAuth;
}

/**
 * Build backend auth config from environment variables.
 *
 * Supported env vars per backend (JAEGER_, PROMETHEUS_, LOKI_, APP_API_):
 *   *_AUTH_TOKEN    — Bearer token (sets Authorization: Bearer <token>)
 *   *_AUTH_BASIC    — Basic auth in user:password format
 *   *_AUTH_HEADER   — Raw Authorization header value (overrides token/basic)
 *   LOKI_TENANT_ID — Sets X-Scope-OrgID header for multi-tenant Loki
 */
export function loadBackendAuth(): BackendAuthConfig {
  return {
    jaeger: buildAuth('JAEGER'),
    prometheus: buildAuth('PROMETHEUS'),
    loki: buildLokiAuth(),
    appApi: buildAuth('APP_API'),
  };
}

function buildAuth(prefix: string): BackendAuth {
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

function buildLokiAuth(): BackendAuth {
  const auth = buildAuth('LOKI');
  const tenantId = process.env['LOKI_TENANT_ID'];
  if (tenantId) {
    auth.extraHeaders = { ...auth.extraHeaders, 'X-Scope-OrgID': tenantId };
  }
  return auth;
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

/** Predefined roles with sensible tool-group defaults. */
export type ClientRole = 'admin' | 'platform-engineer' | 'trader' | 'business-owner' | 'product';

const ALL_TOOL_GROUPS = ['traces', 'metrics', 'logs', 'zk-proofs', 'system'] as const;
export type ToolGroup = typeof ALL_TOOL_GROUPS[number];

/**
 * Role → allowed tool groups mapping.
 *
 * | Role              | Tools                              |
 * |-------------------|------------------------------------|
 * | admin             | all                                |
 * | platform-engineer | all                                |
 * | trader            | zk-proofs, system                  |
 * | business-owner    | metrics, zk-proofs, system         |
 * | product           | metrics, traces, system            |
 */
export const ROLE_TOOL_MAP: Record<ClientRole, readonly ToolGroup[]> = {
  'admin':             ALL_TOOL_GROUPS,
  'platform-engineer': ALL_TOOL_GROUPS,
  'trader':            ['zk-proofs', 'system'],
  'business-owner':    ['metrics', 'zk-proofs', 'system'],
  'product':           ['metrics', 'traces', 'system'],
};

export interface ClientKey {
  /** Unique key identifier (for logging/auditing) */
  id: string;
  /** The API key value */
  key: string;
  /** Human-readable description */
  description?: string;
  /** Role-based access control. Determines which tool groups are available. */
  role?: ClientRole;
  /** Explicit tool group override. Takes precedence over role if set. */
  allowedTools?: ToolGroup[];
}

/**
 * Resolve which tool groups a client key grants access to.
 *
 * Priority: explicit allowedTools > role mapping > all (for keys with no restrictions).
 * If the server was started with --tools, the result is intersected with that global filter.
 */
export function resolveToolGroups(
  clientKey: ClientKey | null,
  globalFilter?: ToolGroup[],
): ToolGroup[] {
  let allowed: ToolGroup[];

  if (clientKey?.allowedTools && clientKey.allowedTools.length > 0) {
    allowed = clientKey.allowedTools;
  } else if (clientKey?.role && ROLE_TOOL_MAP[clientKey.role]) {
    allowed = [...ROLE_TOOL_MAP[clientKey.role]];
  } else {
    allowed = [...ALL_TOOL_GROUPS];
  }

  // Intersect with --tools global filter if present
  if (globalFilter && globalFilter.length > 0) {
    const globalSet = new Set(globalFilter);
    allowed = allowed.filter(t => globalSet.has(t));
  }

  return allowed;
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
 *     { "id": "dev-1", "key": "sk-...", "role": "admin", "description": "Local dev" },
 *     { "id": "trader-app", "key": "sk-...", "role": "trader", "description": "Trading UI" },
 *     { "id": "dashboard", "key": "sk-...", "role": "business-owner", "description": "Exec dashboard" },
 *     { "id": "growth-bot", "key": "sk-...", "role": "product", "description": "Product analytics" },
 *     { "id": "custom", "key": "sk-...", "allowedTools": ["traces", "metrics"], "description": "Custom scope" }
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
