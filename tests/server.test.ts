import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';

describe('createServer', () => {
  it('creates a server with all skills by default', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it('creates a server with selective skills', () => {
    const server = createServer({ tools: ['traces', 'metrics'] });
    expect(server).toBeDefined();
  });

  it('creates a server with only logs', () => {
    const server = createServer({ tools: ['logs'] });
    expect(server).toBeDefined();
  });

  it('creates a server with empty tools array', () => {
    const server = createServer({ tools: [] });
    expect(server).toBeDefined();
  });
});
