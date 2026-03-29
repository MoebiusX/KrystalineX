#!/usr/bin/env node

/**
 * OpenTelemetry MCP Server
 *
 * Exposes traces (Jaeger), metrics (Prometheus), logs (Loki),
 * and optionally ZK proofs as MCP tools for AI agents.
 *
 * Transports:
 *   stdio   — Default. For Claude Desktop, GitHub Copilot, etc.
 *   HTTP    — Use --http <port> for remote / multi-client access.
 *
 * Usage:
 *   otel-mcp-server                  # stdio mode
 *   otel-mcp-server --http 3001      # HTTP mode on port 3001
 *   otel-mcp-server --tools traces,metrics,logs   # only core OTEL tools
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer, VERSION } from './server.js';
import { loadClientKeys, validateClientKey } from './auth.js';
import type { ServerOptions } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --tools flag
  const toolsIndex = args.indexOf('--tools');
  const options: ServerOptions = {};
  if (toolsIndex !== -1 && args[toolsIndex + 1]) {
    const toolNames = args[toolsIndex + 1]!.split(',').map(t => t.trim());
    const valid = ['traces', 'metrics', 'logs', 'zk-proofs', 'system'] as const;
    options.tools = toolNames.filter(t => (valid as readonly string[]).includes(t)) as typeof valid[number][];
  }

  const config = loadConfig();

  // Parse --http flag
  const httpIndex = args.indexOf('--http');

  if (httpIndex !== -1 && args[httpIndex + 1]) {
    // ── HTTP transport ────────────────────────────────────────────────────
    const port = parseInt(args[httpIndex + 1]!, 10);
    const clientKeys = loadClientKeys();
    const authEnabled = clientKeys.length > 0;

    if (!authEnabled) {
      console.error('  Auth:    ⚠ No client keys configured — HTTP server is OPEN');
      console.error('           Set MCP_AUTH_KEYS env or mount auth-keys.json');
    } else {
      console.error(`  Auth:    ${clientKeys.length} client key(s) loaded`);
    }

    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const { randomUUID } = await import('node:crypto');
    const http = await import('node:http');

    // Session map: each MCP client gets its own server+transport pair
    const sessions = new Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport> }>();

    const httpServer = http.createServer(async (req, res) => {
      // Health check — always open
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          server: 'otel-mcp-server',
          version: VERSION,
          auth: authEnabled ? 'enabled' : 'disabled',
          tools: options.tools || ['traces', 'metrics', 'logs', 'zk-proofs', 'system'],
          sessions: sessions.size,
        }));
        return;
      }

      // CORS preflight — always open
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id',
        });
        res.end();
        return;
      }

      // Client authentication
      if (authEnabled) {
        const authHeader = req.headers['authorization'] as string | undefined;
        const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
        const clientKey = validateClientKey(clientKeys, authHeader, apiKeyHeader);

        if (!clientKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unauthorized',
            message: 'Valid API key required. Pass via Authorization: Bearer <key> or X-API-Key header.',
          }));
          return;
        }
      }

      // Session-based routing: existing sessions vs new connections
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Route to existing session
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      if (sessionId && !sessions.has(sessionId)) {
        // Client sent an unknown session ID
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found', sessionId }));
        return;
      }

      // New session — create a fresh server+transport pair
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport });
        },
      });
      const sessionServer = createServer(config, options);
      await sessionServer.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, () => {
      console.error(`✓ otel-mcp-server v${VERSION} listening on http://0.0.0.0:${port}`);
      console.error(`  Health:  http://localhost:${port}/health`);
      console.error(`  Jaeger:  ${config.jaegerUrl}`);
      console.error(`  Prom:    ${config.prometheusUrl}${config.prometheusPathPrefix}`);
      console.error(`  Loki:    ${config.lokiUrl}`);
      if (options.tools) {
        console.error(`  Tools:   ${options.tools.join(', ')}`);
      }
    });
  } else {
    // ── stdio transport (default) ─────────────────────────────────────────
    const server = createServer(config, options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`✓ otel-mcp-server v${VERSION} running on stdio`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
