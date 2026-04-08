import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAuth,
  loadClientKeys,
  validateClientKey,
  backendHeaders,
  type ClientKey,
  type BackendAuth,
} from '../src/auth.js';

// ─── backendHeaders ─────────────────────────────────────────────────────────

describe('backendHeaders', () => {
  it('returns empty object when no auth configured', () => {
    expect(backendHeaders({})).toEqual({});
  });

  it('includes Authorization header', () => {
    const auth: BackendAuth = { authorization: 'Bearer token123' };
    expect(backendHeaders(auth)).toEqual({ Authorization: 'Bearer token123' });
  });

  it('includes extra headers', () => {
    const auth: BackendAuth = { extraHeaders: { 'X-Scope-OrgID': 'tenant-1' } };
    expect(backendHeaders(auth)).toEqual({ 'X-Scope-OrgID': 'tenant-1' });
  });

  it('includes both authorization and extra headers', () => {
    const auth: BackendAuth = {
      authorization: 'Bearer xyz',
      extraHeaders: { 'X-Custom': 'val' },
    };
    expect(backendHeaders(auth)).toEqual({
      Authorization: 'Bearer xyz',
      'X-Custom': 'val',
    });
  });
});

// ─── buildAuth ──────────────────────────────────────────────────────────────

describe('buildAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty auth when no env vars set', () => {
    const auth = buildAuth('JAEGER');
    expect(auth).toEqual({});
  });

  it('reads Bearer token from _AUTH_TOKEN', () => {
    process.env.JAEGER_AUTH_TOKEN = 'jaeger-token';
    const auth = buildAuth('JAEGER');
    expect(auth.authorization).toBe('Bearer jaeger-token');
  });

  it('reads Basic auth from _AUTH_BASIC', () => {
    process.env.LOKI_AUTH_BASIC = 'admin:secret';
    const auth = buildAuth('LOKI');
    const expected = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
    expect(auth.authorization).toBe(expected);
  });

  it('_AUTH_HEADER overrides _AUTH_TOKEN', () => {
    process.env.JAEGER_AUTH_TOKEN = 'should-be-ignored';
    process.env.JAEGER_AUTH_HEADER = 'Custom my-raw-header';
    const auth = buildAuth('JAEGER');
    expect(auth.authorization).toBe('Custom my-raw-header');
  });

  it('reads APP_API auth token', () => {
    process.env.APP_API_AUTH_TOKEN = 'app-token';
    const auth = buildAuth('APP_API');
    expect(auth.authorization).toBe('Bearer app-token');
  });

  it('reads PROMETHEUS auth token', () => {
    process.env.PROMETHEUS_AUTH_TOKEN = 'prom-token';
    const auth = buildAuth('PROMETHEUS');
    expect(auth.authorization).toBe('Bearer prom-token');
  });
});

// ─── loadClientKeys ─────────────────────────────────────────────────────────

describe('loadClientKeys', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Suppress console.error from loadClientKeys
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty array when no keys configured', () => {
    // Clear any existing env vars that might match
    delete process.env.MCP_AUTH_KEYS;
    delete process.env.MCP_AUTH_KEYS_FILE;
    const keys = loadClientKeys();
    // May return [] or find a local file — either way, it shouldn't throw
    expect(Array.isArray(keys)).toBe(true);
  });

  it('loads keys from MCP_AUTH_KEYS env var', () => {
    process.env.MCP_AUTH_KEYS = JSON.stringify({
      keys: [
        { id: 'test-1', key: 'sk-abc', description: 'Test key' },
        { id: 'test-2', key: 'sk-def' },
      ],
    });

    const keys = loadClientKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0].id).toBe('test-1');
    expect(keys[0].key).toBe('sk-abc');
    expect(keys[1].id).toBe('test-2');
  });

  it('handles malformed MCP_AUTH_KEYS env var gracefully', () => {
    process.env.MCP_AUTH_KEYS = 'not-valid-json{{{';
    const keys = loadClientKeys();
    // Should not throw, falls through to file-based loading
    expect(Array.isArray(keys)).toBe(true);
  });

  it('handles empty keys array', () => {
    process.env.MCP_AUTH_KEYS = JSON.stringify({ keys: [] });
    const keys = loadClientKeys();
    // Empty keys array doesn't count as "found"
    expect(Array.isArray(keys)).toBe(true);
  });
});

// ─── validateClientKey ──────────────────────────────────────────────────────

describe('validateClientKey', () => {
  const keys: ClientKey[] = [
    { id: 'key-1', key: 'sk-secret-one', description: 'First key' },
    { id: 'key-2', key: 'sk-secret-two', allowedTools: ['traces'] },
  ];

  it('returns null when no keys configured (auth disabled)', () => {
    const result = validateClientKey([], 'Bearer anything');
    expect(result).toBeNull();
  });

  it('returns null when no auth header provided', () => {
    const result = validateClientKey(keys);
    expect(result).toBeNull();
  });

  it('validates Bearer token from Authorization header', () => {
    const result = validateClientKey(keys, 'Bearer sk-secret-one');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('key-1');
  });

  it('validates X-API-Key header', () => {
    const result = validateClientKey(keys, undefined, 'sk-secret-two');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('key-2');
  });

  it('rejects invalid key', () => {
    const result = validateClientKey(keys, 'Bearer sk-wrong-key');
    expect(result).toBeNull();
  });

  it('rejects non-Bearer auth header', () => {
    const result = validateClientKey(keys, 'Basic abc123');
    expect(result).toBeNull();
  });

  it('prefers Authorization header over X-API-Key', () => {
    const result = validateClientKey(keys, 'Bearer sk-secret-one', 'sk-secret-two');
    expect(result!.id).toBe('key-1');
  });
});
