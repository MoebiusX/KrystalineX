/**
 * Shared utility functions used by all tool modules.
 */

import type { BackendAuth } from './auth.js';
import { backendHeaders } from './auth.js';
import { instrumentFetcher } from './metrics.js';

/** Extra fetch options beyond the standard auth/timeout. */
export interface FetchOptions {
  method?: string;
  body?: string;
}

/** Fetch JSON with timeout, error handling, and optional auth headers. */
export async function fetchJSON(
  url: string,
  timeoutMs = 15_000,
  auth?: BackendAuth,
  options?: FetchOptions,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = auth ? backendHeaders(auth) : {};
    if (options?.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      signal: controller.signal,
      headers,
      method: options?.method || 'GET',
      body: options?.body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a backend-specific fetcher with pre-baked auth headers.
 * Tools call `fetcher(url)` without needing to know about auth.
 *
 * @param backend - Optional backend name for metrics instrumentation
 */
export function createFetcher(timeoutMs: number, auth: BackendAuth, backend?: string) {
  const baseFetcher = (url: string, overrideTimeout?: number, options?: FetchOptions) =>
    fetchJSON(url, overrideTimeout ?? timeoutMs, auth, options);
  return backend ? instrumentFetcher(baseFetcher, backend) : baseFetcher;
}

/** Wrap arbitrary data into an MCP text content result. */
export function textResult(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

/** Return an MCP error result. */
export function errorResult(msg: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${msg}` }],
    isError: true as const,
  };
}

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: ms, s, m, h, d  (e.g. "30m", "2h", "1d")
 */
export function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 3_600_000; // default 1h
  const [, val, unit] = match;
  const n = parseInt(val!, 10);
  const multipliers: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
  };
  return n * (multipliers[unit!] || 3_600_000);
}

/** Try to parse a string as JSON; return original string if it fails. */
export function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
