/**
 * 100% HEADLESS, ZERO-UI MCP Server for Haiwell Cloud SCADA Develop.
 * Serves exclusively machine-readable JSON-RPC 2.0, JSON, OpenAPI 3.1, and text/plain endpoints:
 * - GET  /                        -> Machine-readable MCP discovery & client onboarding JSON (ZERO HTML/UI)
 * - POST /mcp                     -> MCP 2025-03-26 Streamable HTTP (JSON-RPC 2.0)
 * - POST /api/rpc                 -> Direct single or batch low-latency tool execution
 * - GET  /llms.txt                -> Plain-text agent capability index
 * - GET  /openapi.json            -> OpenAPI 3.1 machine-readable specification
 * - GET  /api/manifest            -> Full tools + Zod JSON schemas + resources + prompts + IDE configs
 * - GET  /api/skills/skill.md     -> Drop-in SKILL.md agent playbook
 * - GET  /api/skills/:client      -> Ready-to-use config for vscode, antigravity, claude-code, codex
 * - GET  /api/projects/:id/export -> Full Haiwell project bundle export
 * - GET  /api/health              -> Lightweight health probe
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHaiwellMcpServer } from './src/mcp/createMcpServer';
import { defaultProjectStore, type HaiwellProjectStore } from './src/mcp/projectStore';
import {
  generateAgentSkillMarkdown,
  generateClientConfigs,
  generateLlmsTxt,
  HAIWELL_CAPABILITY_MATRIX,
  HAIWELL_PROMPTS,
  HAIWELL_RESOURCES,
  HAIWELL_RESOURCE_TEMPLATES,
} from './src/mcp/resourcesAndPrompts';
import {
  buildProjectExportBundle,
  HAIWELL_TOOLS,
  invokeHaiwellTool,
  normalizeAgentArgs,
  serializeToolCatalog,
} from './src/mcp/toolRegistry';

const __filename = fileURLToPath(import.meta.url);
const PORT = Number(process.env.PORT ?? 3000);

function getBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

export function createApp(store: HaiwellProjectStore = defaultProjectStore) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // CORS for headless agent clients & local IDE connectors
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, X-Execution-Time-Ms');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Strict JSON error middleware: NEVER return HTML error pages on malformed JSON, oversized payloads, or errors!
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const errObj = err && typeof err === 'object' ? (err as { type?: string; status?: number; message?: string }) : {};
    if (errObj.type === 'entity.parse.failed') {
      if (req.path === '/mcp') {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: malformed JSON payload.' },
        });
        return;
      }
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_JSON', message: 'Request body contains malformed JSON.' },
      });
      return;
    }
    if (errObj.type === 'entity.too.large') {
      if (req.path === '/mcp') {
        res.status(413).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request payload exceeds 2MB headless limit.' },
        });
        return;
      }
      res.status(413).json({
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 2MB limit.' },
      });
      return;
    }
    const status = typeof errObj.status === 'number' && errObj.status >= 400 && errObj.status < 600 ? errObj.status : 500;
    if (req.path === '/mcp') {
      res.status(status).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: errObj.message ?? 'Internal server error' },
      });
      return;
    }
    res.status(status).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: errObj.message ?? 'Internal server error' },
    });
  });

  // =========================================================================
  // 0. ROOT DISCOVERY — 100% HEADLESS JSON (ZERO UI / ZERO HTML)
  // =========================================================================
  app.get('/', (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      service: 'haiwell-cloud-scada-mcp',
      version: '2.0.0',
      mode: 'headless-machine-readable-only',
      protocol: 'MCP 2025-03-26',
      transports: {
        streamableHttp: `POST ${baseUrl}/mcp`,
        stdio: 'npx tsx src/mcp/stdio.ts',
      },
      endpoints: {
        mcp: `${baseUrl}/mcp`,
        rpc: `${baseUrl}/api/rpc`,
        manifest: `${baseUrl}/api/manifest`,
        openapi: `${baseUrl}/openapi.json`,
        llmsTxt: `${baseUrl}/llms.txt`,
        skillMd: `${baseUrl}/api/skills/skill.md`,
        clientConfigs: {
          vscode: `${baseUrl}/api/skills/vscode`,
          antigravity: `${baseUrl}/api/skills/antigravity`,
          claudeCode: `${baseUrl}/api/skills/claude-code`,
          codex: `${baseUrl}/api/skills/codex`,
        },
        health: `${baseUrl}/api/health`,
      },
      counts: {
        domains: HAIWELL_CAPABILITY_MATRIX.length,
        tools: HAIWELL_TOOLS.length,
        staticResources: HAIWELL_RESOURCES.length,
        resourceTemplates: HAIWELL_RESOURCE_TEMPLATES.length,
        prompts: HAIWELL_PROMPTS.length,
      },
    });
  });

  // =========================================================================
  // 1. REAL MCP STREAMABLE HTTP TRANSPORT (JSON-RPC 2.0)
  // =========================================================================
  app.post('/mcp', async (req, res) => {
    const start = performance.now();

    if (!req.body || (typeof req.body !== 'object')) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: JSON-RPC 2.0 object or batch array required.' },
      });
      return;
    }

    // Handle pure JSON-RPC notifications (no "id", e.g., notifications/initialized) with 202 Accepted cleanly
    if (!Array.isArray(req.body) && req.body.id === undefined && typeof req.body.method === 'string' && req.body.method.startsWith('notifications/')) {
      res.setHeader('Mcp-Protocol-Version', '2025-03-26');
      res.setHeader('X-Execution-Time-Ms', (performance.now() - start).toFixed(3));
      res.status(202).end();
      return;
    }

    // Ensure Accept header satisfies MCP StreamableHTTPServerTransport for minimal agent HTTP clients
    if (!req.headers.accept || !req.headers.accept.includes('application/json')) {
      req.headers.accept = 'application/json, text/event-stream';
    } else if (!req.headers.accept.includes('text/event-stream')) {
      req.headers.accept = `${req.headers.accept}, text/event-stream`;
    }

    // Normalize common LLM serialization quirks (explicit null optionals, stringified JSON args)
    // before MCP SDK Zod validation runs on tools/call requests
    const normalizeRpcMessage = (msg: unknown): unknown => {
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
        const obj = msg as Record<string, unknown>;
        if (obj.method === 'tools/call' && obj.params && typeof obj.params === 'object') {
          const params = obj.params as Record<string, unknown>;
          return {
            ...obj,
            params: {
              ...params,
              arguments: normalizeAgentArgs(params.arguments),
            },
          };
        }
      }
      return msg;
    };
    const normalizedBody = Array.isArray(req.body) ? req.body.map(normalizeRpcMessage) : normalizeRpcMessage(req.body);

    const server = createHaiwellMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      res.setHeader('Mcp-Protocol-Version', '2025-03-26');
      res.setHeader('X-Execution-Time-Ms', (performance.now() - start).toFixed(3));
      await transport.handleRequest(req, res, normalizedBody);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: Array.isArray(req.body) ? null : (req.body?.id ?? null),
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : 'Internal MCP server error',
          },
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Stateless Streamable HTTP MCP endpoint accepts POST JSON-RPC 2.0 requests.',
      },
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(204).end();
  });

  // =========================================================================
  // 2. LOW-LATENCY HEADLESS MACHINE-READABLE API ENDPOINTS
  // =========================================================================
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'haiwell-cloud-scada-mcp',
      version: '2.0.0',
      ui: false,
      protocol: 'MCP 2025-03-26 (Streamable HTTP + stdio)',
      domains: HAIWELL_CAPABILITY_MATRIX.length,
      tools: HAIWELL_TOOLS.length,
      resources: HAIWELL_RESOURCES.length,
      resourceTemplates: HAIWELL_RESOURCE_TEMPLATES.length,
      prompts: HAIWELL_PROMPTS.length,
      projects: store.listProjects().length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/llms.txt', (req, res) => {
    res.type('text/plain; charset=utf-8').send(generateLlmsTxt(getBaseUrl(req)));
  });

  app.get('/api/manifest', (req, res) => {
    const baseUrl = getBaseUrl(req);
    const tools = serializeToolCatalog();
    res.json({
      schemaVersion: '2.0.0',
      server: {
        name: 'haiwell-cloud-scada-mcp',
        version: '2.0.0',
        mode: 'headless',
        mcpEndpoint: `${baseUrl}/mcp`,
        rpcEndpoint: `${baseUrl}/api/rpc`,
        stdioCommand: 'npx tsx src/mcp/stdio.ts',
        transports: ['streamable-http', 'stdio'],
      },
      capabilities: HAIWELL_CAPABILITY_MATRIX,
      tools,
      resources: HAIWELL_RESOURCES,
      resourceTemplates: HAIWELL_RESOURCE_TEMPLATES,
      prompts: HAIWELL_PROMPTS,
      clients: generateClientConfigs(baseUrl),
      skillMarkdown: generateAgentSkillMarkdown(`${baseUrl}/mcp`),
      projects: store.listProjects(),
    });
  });

  app.get('/api/skills/skill.md', (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.type('text/markdown; charset=utf-8').send(generateAgentSkillMarkdown(`${baseUrl}/mcp`));
  });

  app.get('/api/skills/:client', (req, res) => {
    const configs = generateClientConfigs(getBaseUrl(req));
    const key = req.params.client as keyof typeof configs;
    if (!configs[key]) {
      res.status(404).json({
        error: `Unknown client "${req.params.client}". Supported: vscode, antigravity, claude-code, codex.`,
      });
      return;
    }
    res.json(configs[key]);
  });

  app.post('/api/rpc', async (req, res) => {
    const start = performance.now();
    if (Array.isArray(req.body)) {
      if (req.body.length > 100) {
        res.status(413).json({ ok: false, error: { code: 'BATCH_TOO_LARGE', message: 'Max 100 calls per batch.' } });
        return;
      }
      const results = [];
      for (const item of req.body) {
        results.push(await invokeHaiwellTool(String(item?.tool ?? ''), item?.arguments ?? {}, store));
      }
      res.setHeader('X-Execution-Time-Ms', (performance.now() - start).toFixed(3));
      res.json({ batch: true, count: results.length, results });
      return;
    }

    const { tool, arguments: args } = req.body ?? {};
    if (!tool || typeof tool !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'Request body must include string field "tool" and optional object "arguments".' },
      });
      return;
    }

    const result = await invokeHaiwellTool(tool, args ?? {}, store);
    res.setHeader('X-Execution-Time-Ms', result.executionMs.toFixed(3));
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.get('/api/projects/:projectId/export', (req, res) => {
    try {
      const project = store.getProject(req.params.projectId);
      res.json(buildProjectExportBundle(project));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Project not found' });
    }
  });

  app.get('/openapi.json', (req, res) => {
    const baseUrl = getBaseUrl(req);
    const tools = serializeToolCatalog();
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'Haiwell Cloud SCADA Develop MCP & Headless Automation API',
        version: '2.0.0',
        description:
          'Zero-UI, machine-readable MCP Streamable HTTP and low-latency RPC API for AI agents automating Haiwell Cloud SCADA Develop.',
      },
      servers: [{ url: baseUrl }],
      paths: {
        '/': { get: { summary: 'Headless JSON server discovery index', responses: { '200': { description: 'Discovery JSON' } } } },
        '/mcp': {
          post: {
            summary: 'MCP 2025-03-26 Streamable HTTP JSON-RPC 2.0 endpoint',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['jsonrpc', 'method'],
                    properties: {
                      jsonrpc: { type: 'string', enum: ['2.0'] },
                      id: { type: ['string', 'number'] },
                      method: {
                        type: 'string',
                        enum: [
                          'initialize',
                          'notifications/initialized',
                          'ping',
                          'tools/list',
                          'tools/call',
                          'resources/list',
                          'resources/templates/list',
                          'resources/read',
                          'prompts/list',
                          'prompts/get',
                        ],
                      },
                      params: { type: 'object' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'JSON-RPC 2.0 MCP response' }, '202': { description: 'Notification accepted' } },
          },
        },
        '/api/rpc': {
          post: {
            summary: 'Direct low-latency tool invocation (single or sequential batch array up to 100 calls)',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['tool'],
                    properties: {
                      tool: { type: 'string', enum: tools.map((t) => t.name) },
                      arguments: { type: 'object' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'Structured tool output' } },
          },
        },
        '/api/manifest': { get: { summary: 'Complete capability matrix, JSON schemas, resources, prompts, and IDE configs', responses: { '200': { description: 'Manifest JSON' } } } },
        '/llms.txt': { get: { summary: 'Plain-text machine-readable agent index', responses: { '200': { description: 'text/plain' } } } },
        '/api/projects/{projectId}/export': {
          get: {
            summary: 'Export complete Haiwell Cloud SCADA project artifact bundle',
            parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Export bundle JSON' } },
          },
        },
      },
    });
  });

  // Strict JSON-only 404 fallback — ZERO HTML ever returned!
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `Endpoint ${req.method} ${req.path} does not exist. Inspect GET / or GET /llms.txt.`,
      },
    });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const app = createApp(defaultProjectStore);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[haiwell-cloud-scada-mcp] headless server listening on http://0.0.0.0:${PORT} (${HAIWELL_TOOLS.length} tools, ZERO UI)`
    );
  });
}
