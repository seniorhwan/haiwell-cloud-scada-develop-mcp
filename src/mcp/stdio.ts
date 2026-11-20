#!/usr/bin/env tsx
/**
 * Standalone local stdio MCP server entrypoint for VS Code, Google Antigravity,
 * Claude Code, and OpenAI Codex CLI.
 * Usage: npx tsx src/mcp/stdio.ts
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHaiwellMcpServer } from './createMcpServer';
import { HAIWELL_PROMPTS, HAIWELL_RESOURCES } from './resourcesAndPrompts';
import { getToolsForProfile, normalizeAgentArgs, resolveToolProfile } from './toolRegistry';
import { defaultProjectStore } from './projectStore';

async function main() {
  const profile = resolveToolProfile(process.env.HAIWELL_MCP_PROFILE);
  const server = createHaiwellMcpServer(defaultProjectStore, profile);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const origOnMessage = transport.onmessage;
  if (origOnMessage) {
    transport.onmessage = (message) => {
      if (message && typeof message === 'object' && 'method' in message && message.method === 'tools/call') {
        const req = message as { params?: { arguments?: unknown } };
        if (req.params && req.params.arguments !== undefined) {
          req.params = { ...req.params, arguments: normalizeAgentArgs(req.params.arguments) };
        }
      }
      origOnMessage(message);
    };
  }

  console.error(
    `[haiwell-cloud-scada-mcp] stdio transport ready (profile=${profile}, ${getToolsForProfile(profile).length} tools, ${HAIWELL_RESOURCES.length} resources, ${HAIWELL_PROMPTS.length} prompts)`
  );
}

main().catch((err) => {
  console.error('[haiwell-cloud-scada-mcp] fatal error:', err);
  process.exit(1);
});
