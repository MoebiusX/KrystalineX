/**
 * MCP Server factory — creates and configures the McpServer
 * with skills and resources.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allSkills } from './skills.js';
import { createSkillHelpers } from './skill.js';
import type { Skill } from './skill.js';
import { registerResources } from './resources/overview.js';

export const VERSION = '1.2.0';

export interface ServerOptions {
  /** Skill IDs to enable. Defaults to all available. */
  tools?: string[];
}

/**
 * Create a fully configured MCP server.
 *
 * Skills self-configure from environment variables.
 * Use `options.tools` to restrict which skills are activated.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const helpers = createSkillHelpers();
  const enabledIds = new Set(options.tools || allSkills.map(s => s.id));

  const server = new McpServer({
    name: 'otel-mcp-server',
    version: VERSION,
  });

  const registered: Skill[] = [];
  for (const skill of allSkills) {
    if (enabledIds.has(skill.id) && skill.isAvailable()) {
      skill.register(server, helpers);
      registered.push(skill);
    }
  }

  registerResources(server, registered);

  return server;
}

export { allSkills };
