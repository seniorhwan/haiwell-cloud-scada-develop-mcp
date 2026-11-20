/**
 * Factory creating a configured @modelcontextprotocol/sdk McpServer instance
 * shared identically by both Streamable HTTP (/mcp) and local stdio transports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultProjectStore, type HaiwellProjectStore } from './projectStore';
import {
  buildPromptMessages,
  HAIWELL_PROMPTS,
  HAIWELL_RESOURCES,
  readHaiwellResource,
} from './resourcesAndPrompts';
import { HAIWELL_TOOLS, invokeHaiwellTool } from './toolRegistry';

export function createHaiwellMcpServer(store: HaiwellProjectStore = defaultProjectStore): McpServer {
  const server = new McpServer(
    {
      name: 'haiwell-cloud-scada-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        'Headless industrial automation MCP server for Haiwell Cloud SCADA Develop. Always validate Haiwell PLC registers and IEC 61131-3 logic before deployment, dry-run physical output writes, and run haiwell_project_audit_safety before export.',
    }
  );

  // Register all 27 Haiwell Cloud SCADA tools using Zod v4 raw shapes
  for (const tool of HAIWELL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.haiwellFeature,
        description: `[${tool.domain} | ${tool.safetyTier}] ${tool.description}`,
        inputSchema: tool.inputSchema.shape,
      },
      async (args: Record<string, unknown>) => {
        const result = await invokeHaiwellTool(tool.name, args, store);
        return {
          isError: !result.ok,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      }
    );
  }

  // Register all MCP resources
  for (const resource of HAIWELL_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => {
        const payload = readHaiwellResource(resource.uri, store);
        return {
          contents: [
            {
              uri: resource.uri,
              mimeType: payload.mimeType,
              text: payload.text,
            },
          ],
        };
      }
    );
  }

  // Register all reusable Agent Skill Prompts
  for (const prompt of HAIWELL_PROMPTS) {
    const argShape: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
    for (const arg of prompt.arguments) {
      argShape[arg.name] = arg.required
        ? z.string().describe(arg.description)
        : z.string().optional().describe(arg.description);
    }

    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: argShape,
      },
      async (args) => ({
        description: prompt.description,
        messages: buildPromptMessages(prompt.name, args),
      })
    );
  }

  return server;
}
