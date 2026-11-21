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
import {
  getToolAnnotations,
  getToolsForProfile,
  invokeHaiwellTool,
  type ToolProfile,
} from './toolRegistry';

const TOOL_OUTPUT_ENVELOPE_SCHEMA = {
  ok: z.boolean(),
  tool: z.string(),
  domain: z.string().optional(),
  safetyTier: z.string().optional(),
  executionMs: z.number(),
  idempotentReplay: z.boolean().optional(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      issues: z.unknown().optional(),
    })
    .optional(),
};

export function createHaiwellMcpServer(
  store: HaiwellProjectStore = defaultProjectStore,
  profile: ToolProfile = 'all'
): McpServer {
  const server = new McpServer(
    {
      name: 'haiwell-cloud-scada-mcp',
      version: '2.6.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        'Zero-UI headless industrial automation MCP server covering all 22 Haiwell Cloud Scada 3.50.x (.hwdev) Project Browser nodes. Always snapshot before bulk edits, validate multi-vendor PLC addresses and word-spans, dry-run physical control writes, validate IEC 61131-3 logic, compile HMI spatially via P&ID/solver tools, calibrate live WinForms UIA via haiwell_desktop_uia_calibrate before desktop bridge export, test E-Stop via haiwell_simulation_step, and verify deploymentReady=true via haiwell_project_audit_safety before export.',
    }
  );

  // Register Haiwell Cloud SCADA tools (scoped by profile to control agent context budgets)
  for (const tool of getToolsForProfile(profile)) {
    server.registerTool(
      tool.name,
      {
        title: tool.haiwellFeature,
        description: `[${tool.domain} | ${tool.safetyTier}] ${tool.description}`,
        inputSchema: {
          ...tool.inputSchema.shape,
          idempotencyKey: z.string().max(128).optional(),
          expectedRevision: z.number().int().min(0).optional(),
        },
        outputSchema: TOOL_OUTPUT_ENVELOPE_SCHEMA,
        annotations: getToolAnnotations(tool),
      },
      async (args: Record<string, unknown>) => {
        const result = await invokeHaiwellTool(tool.name, args, store);
        return {
          isError: !result.ok,
          structuredContent: result,
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
          (['summary', 'tree', 'opcua-nodeset2', 'safety-audit', 'export-bundle', 'tags-csv'] as const).map((sec) => ({
            uri: `haiwell://project/${p.id}/${sec}`,
            name: `${p.id} (${sec})`,
            mimeType: sec === 'opcua-nodeset2' ? 'application/xml' : sec === 'tags-csv' ? 'text/csv' : 'application/json',
          }))
        ),
      }),
    }),
    {
      description: 'Read summary, tree, opcua-nodeset2, safety-audit, export-bundle, or tags-csv for any projectId.',
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
