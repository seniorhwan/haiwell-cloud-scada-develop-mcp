/**
 * Shared @modelcontextprotocol/sdk McpServer factory binding all Haiwell tools,
 * static resources, dynamic ResourceTemplates, and workflow prompts.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
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
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        'Zero-UI headless industrial automation MCP server for Haiwell Cloud SCADA Develop. Always snapshot before bulk edits, validate multi-vendor PLC addresses and word-spans, dry-run physical control writes, validate IEC 61131-3 logic, test E-Stop via haiwell_simulation_step, and verify deploymentReady=true via haiwell_project_audit_safety before export.',
    }
  );

  // Register all Haiwell Cloud SCADA tools
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

  // Register static MCP resources
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

  // Register dynamic MCP ResourceTemplates so ANY agent-created project/screen is readable!
  server.registerResource(
    'Dynamic Project Artifact',
    new ResourceTemplate('haiwell://project/{projectId}/{section}', {
      list: async () => ({
        resources: store.listProjects().flatMap((p) =>
          (['tree', 'opcua-nodeset2', 'safety-audit', 'export-bundle', 'tags-csv'] as const).map((sec) => ({
            uri: `haiwell://project/${p.id}/${sec}`,
            name: `${p.id} (${sec})`,
            mimeType: sec === 'opcua-nodeset2' ? 'application/xml' : sec === 'tags-csv' ? 'text/csv' : 'application/json',
          }))
        ),
      }),
    }),
    {
      description: 'Read tree, opcua-nodeset2, safety-audit, export-bundle, or tags-csv for any projectId.',
    },
    async (uri) => {
      const payload = readHaiwellResource(uri.href, store);
      return {
        contents: [{ uri: uri.href, mimeType: payload.mimeType, text: payload.text }],
      };
    }
  );

  server.registerResource(
    'Dynamic HMI Screen SVG',
    new ResourceTemplate('haiwell://project/{projectId}/screen/{screenId}/svg', {
      list: async () => ({
        resources: store.listProjects().flatMap((p) => {
          const prj = store.getProject(p.id);
          return prj.screens.map((s) => ({
            uri: `haiwell://project/${p.id}/screen/${s.id}/svg`,
            name: `${p.id}/${s.id}.svg`,
            mimeType: 'image/svg+xml',
          }));
        }),
      }),
    }),
    {
      description: 'Deterministic SVG blueprint for any screenId inside any projectId.',
      mimeType: 'image/svg+xml',
    },
    async (uri) => {
      const payload = readHaiwellResource(uri.href, store);
      return {
        contents: [{ uri: uri.href, mimeType: payload.mimeType, text: payload.text }],
      };
    }
  );

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
