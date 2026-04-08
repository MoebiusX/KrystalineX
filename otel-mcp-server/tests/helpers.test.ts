import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { textResult, errorResult, parseDuration, tryParseJSON, fetchJSON, createFetcher } from '../src/helpers.js';

// ─── textResult ─────────────────────────────────────────────────────────────

describe('textResult', () => {
  it('wraps a string as-is', () => {
    const r = textResult('hello');
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toBe('hello');
  });

  it('JSON-stringifies objects', () => {
    const r = textResult({ foo: 1 });
    expect(JSON.parse(r.content[0].text)).toEqual({ foo: 1 });
  });

  it('JSON-stringifies arrays', () => {
    const r = textResult([1, 2, 3]);
    expect(JSON.parse(r.content[0].text)).toEqual([1, 2, 3]);
  });
});

// ─── errorResult ────────────────────────────────────────────────────────────

describe('errorResult', () => {
  it('prefixes message with Error:', () => {
    const r = errorResult('something broke');
    expect(r.content[0].text).toBe('Error: something broke');
    expect(r.isError).toBe(true);
  });
});

// ─── parseDuration ──────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses milliseconds', () => expect(parseDuration('500ms')).toBe(500));
  it('parses seconds', () => expect(parseDuration('30s')).toBe(30_000));
  it('parses minutes', () => expect(parseDuration('5m')).toBe(300_000));
  it('parses hours', () => expect(parseDuration('2h')).toBe(7_200_000));
  it('parses days', () => expect(parseDuration('1d')).toBe(86_400_000));
  it('returns 1h default for invalid input', () => expect(parseDuration('bad')).toBe(3_600_000));
  it('returns 1h default for empty string', () => expect(parseDuration('')).toBe(3_600_000));
});

// ─── tryParseJSON ───────────────────────────────────────────────────────────

describe('tryParseJSON', () => {
  it('parses valid JSON', () => {
    expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns original string for invalid JSON', () => {
    expect(tryParseJSON('not json')).toBe('not json');
  });

  it('parses JSON arrays', () => {
    expect(tryParseJSON('[1,2]')).toEqual([1, 2]);
  });
});

// ─── fetchJSON ──────────────────────────────────────────────────────────────

describe('fetchJSON', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and parses JSON', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: 'test' }) };
    (fetch as any).mockResolvedValue(mockResponse);

    const result = await fetchJSON('http://example.com/api');
    expect(result).toEqual({ data: 'test' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('throws on non-ok response', async () => {
    const mockResponse = { ok: false, status: 404, statusText: 'Not Found' };
    (fetch as any).mockResolvedValue(mockResponse);

    await expect(fetchJSON('http://example.com/missing')).rejects.toThrow('HTTP 404');
  });

  it('passes auth headers when provided', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    (fetch as any).mockResolvedValue(mockResponse);

    await fetchJSON('http://example.com/api', 5000, {
      authorization: 'Bearer my-token',
      extraHeaders: { 'X-Custom': 'value' },
    });

    const callArgs = (fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toEqual({
      Authorization: 'Bearer my-token',
      'X-Custom': 'value',
    });
  });

  it('sends no auth headers when auth is empty', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    (fetch as any).mockResolvedValue(mockResponse);

    await fetchJSON('http://example.com/api', 5000);

    const callArgs = (fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toEqual({});
  });
});

// ─── createFetcher ──────────────────────────────────────────────────────────

describe('createFetcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a fetcher with pre-baked auth', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ ok: true }) };
    (fetch as any).mockResolvedValue(mockResponse);

    const fetcher = createFetcher(10_000, { authorization: 'Bearer xyz' });
    const result = await fetcher('http://backend/api');

    expect(result).toEqual({ ok: true });
    const callArgs = (fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toEqual({ Authorization: 'Bearer xyz' });
  });

  it('allows timeout override', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    (fetch as any).mockResolvedValue(mockResponse);

    const fetcher = createFetcher(5_000, {});
    await fetcher('http://backend/api', 30_000);

    // Verify it was called (timeout is internal via AbortController)
    expect(fetch).toHaveBeenCalledOnce();
  });
});
