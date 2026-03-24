/**
 * Shared utility functions used by all tool modules.
 */

import type { BackendAuth } from './auth.js';
import { backendHeaders } from './auth.js';

/** Fetch JSON with timeout, error handling, and optional auth headers. */
export async function fetchJSON(url: string, timeoutMs = 15_000, auth?: BackendAuth): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = auth ? backendHeaders(auth) : {};
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a backend-specific fetcher with pre-baked auth headers.
 * Tools call `fetcher(url)` without needing to know about auth.
 */
export function createFetcher(timeoutMs: number, auth: BackendAuth) {
  return (url: string, overrideTimeout?: number) =>
    fetchJSON(url, overrideTimeout ?? timeoutMs, auth);
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
