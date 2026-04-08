/**
 * Skill — the plugin abstraction for telemetry signal sources.
 *
 * Each skill is a self-contained module that:
 *  - Declares its identity and availability
 *  - Self-configures from environment variables
 *  - Registers MCP tools on the server
 *
 * Adding a new telemetry source is as simple as:
 *  1. Create a file in src/tools/ that exports `skill: Skill`
 *  2. Import it in src/skills.ts and add to the `allSkills` array
 *
 * @example
 * ```typescript
 * // src/tools/tempo.ts
 * import type { Skill, SkillHelpers } from '../skill.js';
 * import { textResult, errorResult } from '../helpers.js';
 *
 * function registerTools(server, helpers) {
 *   const url = helpers.env('TEMPO_URL');
 *   const fetch = helpers.createFetcher('TEMPO', 'tempo');
 *   server.tool('tempo_search', 'Search traces', { ... }, async (params) => { ... });
 * }
 *
 * export const skill: Skill = {
 *   id: 'tempo',
 *   name: 'Grafana Tempo',
 *   description: 'Query traces via the Grafana Tempo API',
 *   tools: 3,
 *   backends: ['Tempo'],
 *   isAvailable: () => !!process.env.TEMPO_URL,
 *   register: registerTools,
 * };
 * ```
 */

import { buildAuth } from './auth.js';
import { createFetcher as createRawFetcher } from './helpers.js';
import type { FetchOptions } from './helpers.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export type Fetcher = (
  url: string,
  overrideTimeout?: number,
  options?: FetchOptions,
) => Promise<any>;

export interface Skill {
  /** Unique ID, used in the --tools CLI flag (e.g. 'traces', 'elasticsearch') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description of the skill's capabilities */
  description: string;
  /** Number of tools this skill registers */
  tools: number;
  /** Backend system names for startup display */
  backends: string[];
  /** Return true if this skill's backend(s) are configured and available */
  isAvailable(): boolean;
  /** Register MCP tools on the server */
  register(server: any, helpers: SkillHelpers): void;
}

export interface CreateFetcherOptions {
  /** Additional headers beyond auth (e.g. X-Scope-OrgID for multi-tenant Loki) */
  extraHeaders?: Record<string, string>;
  /** Override the default timeout for all requests made by this fetcher (ms) */
  timeoutMs?: number;
}

export interface SkillHelpers {
  /** Default request timeout (ms), from MCP_TIMEOUT_MS env var or 15000 */
  timeoutMs: number;

  /**
   * Create an instrumented fetcher for a backend.
   *
   * Auth is auto-resolved from `{envPrefix}_AUTH_TOKEN`, `_AUTH_BASIC`,
   * or `_AUTH_HEADER` environment variables.
   *
   * @param envPrefix Env var prefix for auth resolution (e.g. 'JAEGER', 'PROMETHEUS')
   * @param backend   Backend label for self-metrics instrumentation
   * @param options   Optional extra headers and timeout override
   */
  createFetcher(
    envPrefix: string,
    backend: string,
    options?: CreateFetcherOptions,
  ): Fetcher;

  /** Read an environment variable with optional fallback */
  env(key: string, fallback?: string): string;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Create SkillHelpers from the current process environment. */
export function createSkillHelpers(overrides?: { timeoutMs?: number }): SkillHelpers {
  const timeoutMs =
    overrides?.timeoutMs ??
    parseInt(process.env['MCP_TIMEOUT_MS'] || '15000', 10);

  return {
    timeoutMs,

    createFetcher(
      envPrefix: string,
      backend: string,
      options?: CreateFetcherOptions,
    ): Fetcher {
      const auth = buildAuth(envPrefix);
      if (options?.extraHeaders) {
        auth.extraHeaders = { ...auth.extraHeaders, ...options.extraHeaders };
      }
      return createRawFetcher(options?.timeoutMs ?? timeoutMs, auth, backend);
    },

    env(key: string, fallback = ''): string {
      return process.env[key] || fallback;
    },
  };
}
