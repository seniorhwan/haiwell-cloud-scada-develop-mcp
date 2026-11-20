#!/usr/bin/env tsx
/**
 * Standalone local stdio MCP server entrypoint for VS Code, Google Antigravity,
 * Claude Code, and OpenAI Codex CLI.
 * Usage: npx tsx src/mcp/stdio.ts
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHaiwellMcpServer } from './createMcpServer';
import { HAIWELL_PROMPTS, HAIWELL_RESOURCES } from './resourcesAndPrompts';
import { HAIWELL_TOOLS } from './toolRegistry';

async function main() {
  const server = createHaiwellMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[haiwell-cloud-scada-mcp] stdio transport ready (${HAIWELL_TOOLS.length} tools, ${HAIWELL_RESOURCES.length} resources, ${HAIWELL_PROMPTS.length} prompts)`
  );
}

main().catch((err) => {
  console.error('[haiwell-cloud-scada-mcp] fatal error:', err);
  process.exit(1);
});
