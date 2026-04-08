#!/usr/bin/env node

/**
 * OpenTelemetry MCP Server
 *
 * Exposes telemetry backends as MCP tools for AI agents.
 * Each backend is a "skill" — a self-contained plugin that
 * self-configures from environment variables.
 *
 * Transports:
 *   stdio   — Default. For Claude Desktop, GitHub Copilot, etc.
 *   HTTP    — Use --http <port> for remote / multi-client access.
 *
 * Usage:
 *   otel-mcp-server                                # stdio mode
 *   otel-mcp-server --http 3001                    # HTTP mode
 *   otel-mcp-server --tools traces,metrics,logs    # only core OTEL tools
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION, allSkills } from './server.js';
import type { ServerOptions } from './server.js';
import { loadClientKeys, validateClientKey } from './auth.js';
import { metrics, serializeMetrics } from './metrics.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const validIds = allSkills.map(s => s.id);

  // Parse --tools flag
  const toolsIndex = args.indexOf('--tools');
  const options: ServerOptions = {};
  if (toolsIndex !== -1 && args[toolsIndex + 1]) {
    const toolNames = args[toolsIndex + 1]!.split(',').map(t => t.trim());
    options.tools = toolNames.filter(t => validIds.includes(t));
  }

  const enabledIds = new Set(options.tools || validIds);

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
    }

    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const http = await import('node:http');

      // ── Session-based MCP transport ──────────────────────────────
      // Each MCP session gets its own McpServer + Transport pair.
      // The init request creates a new session; subsequent requests
      // reuse the same pair via the Mcp-Session-Id header.
      const { randomUUID } = await import('node:crypto');
      const sessions = new Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport>; server: ReturnType<typeof createServer> }>();

      const httpServer = http.createServer(async (req, res) => {
        // Health check — always open
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            server: 'otel-mcp-server',
            version: VERSION,
            auth: authEnabled ? 'enabled' : 'disabled',
            skills: allSkills
              .filter(s => enabledIds.has(s.id))
              .map(s => ({ id: s.id, available: s.isAvailable(), tools: s.tools })),
          }));
          return;
        }

        // Prometheus metrics — always open
        if (req.method === 'GET' && req.url === '/metrics') {
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          res.end(serializeMetrics());
          return;
        }

        // CORS preflight — always open
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers':
              'Content-Type, Authorization, X-API-Key, Mcp-Session-Id',
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
            metrics.authAttempts.inc({ result: 'rejected' });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Unauthorized',
              message: 'Valid API key required. Pass via Authorization: Bearer <key> or X-API-Key header.',
            }));
            return;
          }
          metrics.authAttempts.inc({ result: 'accepted' });
        }

        // Look up existing session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }

        // New session (initialize request)
        metrics.activeSessions.inc();
        const mcpServer = createServer(options);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
          metrics.activeSessions.dec();
          mcpServer.close();
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);

        if (transport.sessionId) {
          sessions.set(transport.sessionId, { transport, server: mcpServer });
        }
      });

    httpServer.listen(port, () => {
      console.error(`✓ otel-mcp-server v${VERSION} listening on http://0.0.0.0:${port}`);
      console.error(`  Health:  http://localhost:${port}/health`);
      console.error(`  Metrics: http://localhost:${port}/metrics`);
      console.error(`  Skills:`);
      for (const skill of allSkills) {
        if (!enabledIds.has(skill.id)) continue;
        const available = skill.isAvailable();
        const icon = available ? '✓' : '✗';
        const detail = available
          ? `${skill.name} (${skill.tools} tools) [${skill.backends.join(', ')}]`
          : 'not configured';
        console.error(`    ${icon} ${skill.id.padEnd(14)} — ${detail}`);
      }
    });
  } else {
    // ── stdio transport (default) ─────────────────────────────────────────
    const server = createServer(options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`✓ otel-mcp-server v${VERSION} running on stdio`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
