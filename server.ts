/**
 * Production Express server hosting:
 * 1. MCP Streamable HTTP endpoint (POST /mcp) via @modelcontextprotocol/sdk
 * 2. Low-latency machine-readable REST/RPC endpoints (/api/rpc, /api/manifest, /openapi.json, /llms.txt, /api/skills/*)
 * 3. Minimal headless protocol documentation & wire-level JSON-RPC harness SPA
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHaiwellMcpServer } from './src/mcp/createMcpServer';
import { defaultProjectStore } from './src/mcp/projectStore';
import {
  generateAgentSkillMarkdown,
  generateClientConfigs,
  generateLlmsTxt,
  HAIWELL_CAPABILITY_MATRIX,
  HAIWELL_PROMPTS,
  HAIWELL_RESOURCES,
} from './src/mcp/resourcesAndPrompts';
import {
  buildProjectExportBundle,
  invokeHaiwellTool,
  serializeToolCatalog,
} from './src/mcp/toolRegistry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 3000);

function getBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // CORS for headless agent clients & local IDE connectors
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // =========================================================================
  // 1. REAL MCP STREAMABLE HTTP TRANSPORT (JSON-RPC 2.0)
  // =========================================================================
  app.post('/mcp', async (req, res) => {
    const start = performance.now();
    // Ensure Accept header satisfies MCP StreamableHTTPServerTransport even for simple curl/agent clients
    if (!req.headers.accept || !req.headers.accept.includes('application/json')) {
      req.headers.accept = 'application/json, text/event-stream';
    } else if (!req.headers.accept.includes('text/event-stream')) {
      req.headers.accept = `${req.headers.accept}, text/event-stream`;
    }

    const server = createHaiwellMcpServer(defaultProjectStore);
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
      res.setHeader('X-MCP-Protocol', '2025-03-26');
      res.setHeader('X-Execution-Time-Ms', (performance.now() - start).toFixed(2));
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? null,
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
      protocol: 'MCP 2025-03-26 (Streamable HTTP + stdio)',
      tools: serializeToolCatalog().length,
      resources: HAIWELL_RESOURCES.length,
      prompts: HAIWELL_PROMPTS.length,
      projects: defaultProjectStore.listProjects().length,
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
      schemaVersion: '1.0.0',
      server: {
        name: 'haiwell-cloud-scada-mcp',
        version: '1.0.0',
        mcpEndpoint: `${baseUrl}/mcp`,
        rpcEndpoint: `${baseUrl}/api/rpc`,
        stdioCommand: 'npx tsx src/mcp/stdio.ts',
        transports: ['streamable-http', 'stdio'],
      },
      capabilities: HAIWELL_CAPABILITY_MATRIX,
      tools,
      resources: HAIWELL_RESOURCES,
      prompts: HAIWELL_PROMPTS,
      clients: generateClientConfigs(baseUrl),
      skillMarkdown: generateAgentSkillMarkdown(`${baseUrl}/mcp`),
      projects: defaultProjectStore.listProjects(),
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
    // Support single call { tool, arguments } or batch array [{ tool, arguments }]
    if (Array.isArray(req.body)) {
      const results = await Promise.all(
        req.body.map((item) => invokeHaiwellTool(String(item?.tool ?? ''), item?.arguments ?? {}, defaultProjectStore))
      );
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

    const result = await invokeHaiwellTool(tool, args ?? {}, defaultProjectStore);
    res.setHeader('X-Execution-Time-Ms', result.executionMs.toFixed(3));
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.get('/api/projects/:projectId/export', (req, res) => {
    try {
      const project = defaultProjectStore.getProject(req.params.projectId);
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
        version: '1.0.0',
        description:
          'Machine-readable MCP Streamable HTTP and low-latency RPC API for AI agents automating Haiwell Cloud SCADA Develop projects, IEC 61131-3 validation, ISA-101 HMI generation, MQTT, and OPC UA.',
      },
      servers: [{ url: baseUrl }],
      paths: {
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
                        enum: ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'],
                      },
                      params: { type: 'object' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'JSON-RPC 2.0 MCP response' } },
          },
        },
        '/api/rpc': {
          post: {
            summary: 'Direct low-latency tool invocation (single or batch array)',
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
        '/api/manifest': {
          get: {
            summary: 'Complete capability matrix, JSON schemas, resources, prompts, and IDE configs',
            responses: { '200': { description: 'Manifest JSON' } },
          },
        },
        '/llms.txt': {
          get: {
            summary: 'Plain-text machine-readable agent index',
            responses: { '200': { description: 'text/plain' } },
          },
        },
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

  return app;
}

async function startServer() {
  const app = createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[haiwell-cloud-scada-mcp] listening on http://0.0.0.0:${PORT} (MCP Streamable HTTP: /mcp)`);
  });
}

// Only bind HTTP port when executed directly (not when imported in unit tests)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void startServer();
}
