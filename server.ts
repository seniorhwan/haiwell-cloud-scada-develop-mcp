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

import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHaiwellMcpServer } from './src/mcp/createMcpServer';
import { defaultProjectStore, type HaiwellProjectStore } from './src/mcp/projectStore';
import { SERVER_VERSION } from './src/mcp/version';
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
  computeToolCatalogHash,
  getToolsForProfile,
  HAIWELL_TOOLS,
  invokeHaiwellTool,
  normalizeAgentArgs,
  resolveToolProfile,
  serializeToolCatalog,
} from './src/mcp/toolRegistry';

const __filename = fileURLToPath(import.meta.url);
const PORT = Number(process.env.PORT ?? 3000);

const VALID_HOST_REGEX = /^[a-zA-Z0-9._-]+(?::\d{1,5})?$/;

function getBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const rawProto = trustProxy
    ? String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
    : req.protocol || 'http';
  const proto = rawProto === 'https' ? 'https' : 'http';
  const rawHost = trustProxy
    ? String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim()
    : String(req.get('host') || '').trim();
  const host = VALID_HOST_REGEX.test(rawHost) ? rawHost : `localhost:${PORT}`;
  return `${proto}://${host}`;
}

export interface ServerSecurityOptions {
  authToken?: string;
  allowedOrigins?: string[];
  rateLimitPerMin?: number;
}

function timingSafeBearerMatch(headerVal: string | undefined, expectedToken: string): boolean {
  if (!headerVal || !headerVal.startsWith('Bearer ')) return false;
  const provided = Buffer.from(headerVal.slice(7).trim(), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

export function createApp(
  store: HaiwellProjectStore = defaultProjectStore,
  securityOpts: ServerSecurityOptions = {}
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const authToken = securityOpts.authToken ?? process.env.HAIWELL_MCP_AUTH_TOKEN?.trim() ?? '';
  const allowedOrigins = (
    securityOpts.allowedOrigins ??
    (process.env.HAIWELL_MCP_ALLOWED_ORIGINS
      ? process.env.HAIWELL_MCP_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [])
  ).map((o) => o.toLowerCase());
  const rateLimitPerMin =
    securityOpts.rateLimitPerMin ?? Number(process.env.HAIWELL_MCP_RATE_LIMIT_PER_MIN ?? 600);

  // Bounded idle McpServer pool per profile to avoid rebuilding 61 Zod tool schemas on every HTTP request
  const mcpServerPool = new Map<string, McpServer[]>();
  const MAX_POOL_PER_PROFILE = 8;
  const borrowMcpServer = (profile: ReturnType<typeof resolveToolProfile>): McpServer => {
    const bucket = mcpServerPool.get(profile);
    if (bucket && bucket.length > 0) {
      return bucket.pop()!;
    }
    return createHaiwellMcpServer(store, profile);
  };
  const releaseMcpServer = async (
    profile: ReturnType<typeof resolveToolProfile>,
    srv: McpServer
  ): Promise<void> => {
    try {
      await srv.close();
      const bucket = mcpServerPool.get(profile) ?? [];
      if (bucket.length < MAX_POOL_PER_PROFILE) {
        bucket.push(srv);
        mcpServerPool.set(profile, bucket);
      }
    } catch {
      // Drop unhealthy server instance instead of returning it to pool
    }
  };

  // Per-IP Token Bucket rate limiter (prevents runaway agent retry loops)
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();
  const consumeRateToken = (ip: string): { allowed: boolean; retryAfterSec: number } => {
    if (!Number.isFinite(rateLimitPerMin) || rateLimitPerMin <= 0) return { allowed: true, retryAfterSec: 0 };
    const now = Date.now();
    const capacity = Math.max(20, Math.min(rateLimitPerMin, 240));
    const refillPerMs = rateLimitPerMin / 60000;
    const entry = buckets.get(ip) ?? { tokens: capacity, lastRefill: now };
    const elapsed = Math.max(0, now - entry.lastRefill);
    entry.tokens = Math.min(capacity, entry.tokens + elapsed * refillPerMs);
    entry.lastRefill = now;
    if (entry.tokens < 1) {
      buckets.set(ip, entry);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - entry.tokens) / (refillPerMs * 1000))) };
    }
    entry.tokens -= 1;
    buckets.set(ip, entry);
    if (buckets.size > 2000) {
      const oldest = buckets.keys().next().value;
      if (oldest) buckets.delete(oldest);
    }
    return { allowed: true, retryAfterSec: 0 };
  };

  // Request correlation ID + CORS + Origin DNS-rebinding protection
  app.use((req, res, next) => {
    const reqId = (req.headers['x-request-id'] as string | undefined)?.trim() || crypto.randomUUID();
    res.setHeader('X-Request-Id', reqId);

    const origin = (req.headers.origin as string | undefined)?.toLowerCase();
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) {
      res.status(403).json({
        ok: false,
        error: {
          code: 'ORIGIN_FORBIDDEN',
          message: `Origin "${req.headers.origin}" is rejected by DNS-rebinding policy (HAIWELL_MCP_ALLOWED_ORIGINS).`,
        },
      });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.length > 0 && origin ? req.headers.origin! : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, X-Execution-Time-Ms, X-Request-Id, Retry-After');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    // Enforce Bearer auth on execution/export endpoints when HAIWELL_MCP_AUTH_TOKEN is configured
    const requiresAuth = req.path === '/mcp' || req.path === '/api/rpc' || req.path.startsWith('/api/projects/');
    if (authToken && requiresAuth && !timingSafeBearerMatch(req.headers.authorization, authToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="haiwell-cloud-scada-mcp"');
      res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Valid Authorization: Bearer <token> header required.' },
      });
      return;
    }

    // Apply token-bucket rate limiting on execution endpoints
    if (req.path === '/mcp' || req.path === '/api/rpc') {
      const clientKey = req.ip || req.socket.remoteAddress || 'local';
      const rl = consumeRateToken(clientKey);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Agent rate limit exceeded (${rateLimitPerMin}/min). Retry after ${rl.retryAfterSec}s.`,
            retryAfterSec: rl.retryAfterSec,
          },
        });
        return;
      }
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
    const profile = resolveToolProfile(typeof req.query.profile === 'string' ? req.query.profile : undefined);
    res.json({
      service: 'haiwell-cloud-scada-mcp',
      version: SERVER_VERSION,
      mode: 'headless-machine-readable-only',
      protocol: 'MCP 2025-03-26',
      profile,
      catalogSha256: computeToolCatalogHash(profile),
      availableProfiles: ['all', 'core', 'hmi', 'plc', 'iiot'],
      security: {
        bearerAuthEnabled: Boolean(authToken),
        originAllowlistEnabled: allowedOrigins.length > 0,
        rateLimitPerMin,
        toolAnnotations: true,
        structuredContent: true,
        idempotencyAndOptimisticLocking: true,
      },
      transports: {
        streamableHttp: `POST ${baseUrl}/mcp`,
        scopedProfiles: `POST ${baseUrl}/mcp?profile=core|hmi|plc|iiot|all`,
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
        tools: getToolsForProfile(profile).length,
        totalToolsAllProfiles: HAIWELL_TOOLS.length,
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

    const profile = resolveToolProfile(
      typeof req.query.profile === 'string' ? req.query.profile : process.env.HAIWELL_MCP_PROFILE
    );
    const server = borrowMcpServer(profile);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void releaseMcpServer(profile, server);
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
      version: SERVER_VERSION,
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
    const profile = resolveToolProfile(typeof req.query.profile === 'string' ? req.query.profile : undefined);
    const tools = serializeToolCatalog(profile);
    const isAuthenticated = !authToken || timingSafeBearerMatch(req.headers.authorization, authToken);
    res.json({
      schemaVersion: SERVER_VERSION,
      profile,
      catalogSha256: computeToolCatalogHash(profile),
      server: {
        name: 'haiwell-cloud-scada-mcp',
        version: SERVER_VERSION,
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
      ...(isAuthenticated ? { projects: store.listProjects() } : { projectsRedacted: true }),
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
        version: SERVER_VERSION,
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

  // Final strict JSON error handler for any synchronous/async route throw (ZERO HTML ever!)
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const errObj = err && typeof err === 'object' ? (err as { status?: number; message?: string }) : {};
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

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const app = createApp(defaultProjectStore);
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[haiwell-cloud-scada-mcp] headless server listening on http://0.0.0.0:${PORT} (${HAIWELL_TOOLS.length} tools, ZERO UI)`
    );
  });
  const shutdown = (signal: string) => {
    console.log(`[haiwell-cloud-scada-mcp] received ${signal}, shutting down gracefully...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
