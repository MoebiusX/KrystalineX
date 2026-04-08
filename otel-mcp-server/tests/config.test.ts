import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSkillHelpers } from '../src/skill.js';

describe('createSkillHelpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses default timeout of 15000ms', () => {
    const helpers = createSkillHelpers();
    expect(helpers.timeoutMs).toBe(15_000);
  });

  it('reads custom timeout from MCP_TIMEOUT_MS', () => {
    process.env.MCP_TIMEOUT_MS = '30000';
    const helpers = createSkillHelpers();
    expect(helpers.timeoutMs).toBe(30_000);
  });

  it('accepts timeout override via parameter', () => {
    const helpers = createSkillHelpers({ timeoutMs: 5000 });
    expect(helpers.timeoutMs).toBe(5000);
  });

  it('env() returns env var value', () => {
    process.env.JAEGER_URL = 'http://jaeger:16686';
    const helpers = createSkillHelpers();
    expect(helpers.env('JAEGER_URL')).toBe('http://jaeger:16686');
  });

  it('env() returns fallback when env var not set', () => {
    const helpers = createSkillHelpers();
    expect(helpers.env('NONEXISTENT_VAR', 'http://default:8080')).toBe('http://default:8080');
  });

  it('env() returns empty string when no fallback', () => {
    const helpers = createSkillHelpers();
    expect(helpers.env('NONEXISTENT_VAR')).toBe('');
  });

  it('createFetcher returns a function', () => {
    const helpers = createSkillHelpers();
    const fetcher = helpers.createFetcher('JAEGER', 'jaeger');
    expect(typeof fetcher).toBe('function');
  });
});
