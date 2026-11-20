import { useEffect, useState } from 'react';
import { AgentIntegrationPanel, type ClientConfigSpec } from './components/AgentIntegrationPanel';
import {
  CapabilityCatalog,
  type CapabilitySummaryItem,
  type SerializedToolItem,
} from './components/CapabilityCatalog';
import { ProtocolHeader } from './components/ProtocolHeader';
import { RpcWireHarness } from './components/RpcWireHarness';

interface ManifestPayload {
  schemaVersion: string;
  server: {
    name: string;
    version: string;
    mcpEndpoint: string;
    rpcEndpoint: string;
    stdioCommand: string;
    transports: string[];
  };
  capabilities: CapabilitySummaryItem[];
  tools: SerializedToolItem[];
  resources: { uri: string; name: string; mimeType: string; description: string }[];
  prompts: { name: string; description: string }[];
  clients: Record<'vscode' | 'antigravity' | 'claude-code' | 'codex', ClientConfigSpec>;
  skillMarkdown: string;
}

export default function App() {
  const [manifest, setManifest] = useState<ManifestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harnessTool, setHarnessTool] = useState<SerializedToolItem | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/manifest')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ManifestPayload) => {
        if (active) setManifest(data);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load MCP manifest');
      });
    return () => {
      active = false;
    };
  }, []);

  const handleLoadInHarness = (tool: SerializedToolItem) => {
    setHarnessTool(tool);
    document.getElementById('wire-harness')?.scrollIntoView({ behavior: 'smooth' });
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const mcpEndpoint = manifest?.server.mcpEndpoint ?? `${origin}/mcp`;
  const rpcEndpoint = manifest?.server.rpcEndpoint ?? `${origin}/api/rpc`;

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <ProtocolHeader mcpEndpoint={mcpEndpoint} />

      <main className="max-w-6xl mx-auto px-6">
        {/* Protocol Specification Header — Strictly Non-Dashboard */}
        <section id="endpoints" className="py-12 border-b border-slate-200">
          <p className="text-xs font-mono text-slate-500">
            Model Context Protocol 2025-03-26 · Streamable HTTP and stdio · IEC 61131-3 · ISA-101 · MQTT · OPC UA
          </p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mt-3 max-w-3xl [text-wrap:balance]">
            Headless MCP Server for Haiwell Cloud SCADA Develop
          </h1>
          <p className="text-base text-slate-600 mt-3 max-w-3xl leading-relaxed">
            Machine-readable automation skills for AI agents in VS Code, Google Antigravity, Claude Code, and Codex. Exposes all 14 Haiwell Cloud SCADA engineering domains behind strict Zod validation, IEC 61131-3 safety analysis, ISA-101 HMI generation, and guarded MQTT/OPC UA primitives.
          </p>

          {/* Direct Machine-Readable Endpoints Table */}
          <div className="mt-8 border border-slate-200 rounded-md overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                  <th className="py-2.5 px-4">Interface</th>
                  <th className="py-2.5 px-4">Endpoint / Transport</th>
                  <th className="py-2.5 px-4">Format</th>
                  <th className="py-2.5 px-4">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono">
                <tr>
                  <td className="py-2.5 px-4 font-sans font-medium text-slate-900 whitespace-nowrap">MCP Streamable HTTP</td>
                  <td className="py-2.5 px-4 text-blue-700 break-all">POST {mcpEndpoint}</td>
                  <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">JSON-RPC 2.0</td>
                  <td className="py-2.5 px-4 font-sans text-slate-600">Primary headless agent transport (tools, resources, prompts)</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 font-sans font-medium text-slate-900 whitespace-nowrap">Local MCP stdio</td>
                  <td className="py-2.5 px-4 text-slate-800 whitespace-nowrap">npx tsx src/mcp/stdio.ts</td>
                  <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">NDJSON / stdio</td>
                  <td className="py-2.5 px-4 font-sans text-slate-600">Zero-network subprocess transport for local IDE agents</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 font-sans font-medium text-slate-900 whitespace-nowrap">Direct Batch RPC</td>
                  <td className="py-2.5 px-4 text-slate-800 break-all">POST {rpcEndpoint}</td>
                  <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">application/json</td>
                  <td className="py-2.5 px-4 font-sans text-slate-600">Low-latency single or parallel batch tool execution</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 font-sans font-medium text-slate-900 whitespace-nowrap">Agent Discovery Index</td>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <a href="/llms.txt" className="text-blue-700 hover:underline">GET /llms.txt</a>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <a href="/openapi.json" className="text-blue-700 hover:underline">GET /openapi.json</a>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <a href="/api/manifest" className="text-blue-700 hover:underline">GET /api/manifest</a>
                  </td>
                  <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">text/plain · JSON</td>
                  <td className="py-2.5 px-4 font-sans text-slate-600">Machine-readable capability manifests and OpenAPI 3.1 spec</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 font-sans font-medium text-slate-900 whitespace-nowrap">Skill Playbook & Export</td>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <a href="/api/skills/skill.md" className="text-blue-700 hover:underline">GET /api/skills/skill.md</a>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <a href="/api/projects/prj_chiller_plant_01/export" className="text-blue-700 hover:underline">GET /api/projects/.../export</a>
                  </td>
                  <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">text/markdown · JSON</td>
                  <td className="py-2.5 px-4 font-sans text-slate-600">Agent SKILL.md ruleset and full Haiwell bundle (.hwsp/CSV/SVG/XML)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {error && (
          <div role="alert" className="my-8 p-4 border border-rose-200 bg-rose-50 text-xs font-mono text-rose-800 rounded-md">
            Failed to load protocol manifest: {error}
          </div>
        )}

        {!manifest && !error && (
          <div className="py-12 text-xs font-mono text-slate-500">
            Loading Haiwell MCP protocol manifest...
          </div>
        )}

        {manifest && (
          <>
            <AgentIntegrationPanel
              clients={manifest.clients}
              skillMarkdown={manifest.skillMarkdown}
            />

            <CapabilityCatalog
              capabilities={manifest.capabilities}
              tools={manifest.tools}
              onLoadInHarness={handleLoadInHarness}
            />

            {/* Compact MCP Resources & Prompts Reference */}
            <section className="py-10 border-b border-slate-200 grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div>
                <h2 className="text-base font-semibold text-slate-900 mb-3">
                  MCP Resources ({manifest.resources.length})
                </h2>
                <ul className="divide-y divide-slate-200 border border-slate-200 rounded-md bg-white">
                  {manifest.resources.map((r) => (
                    <li key={r.uri} className="px-4 py-2.5">
                      <div className="font-mono text-xs font-medium text-slate-900 break-all">{r.uri}</div>
                      <div className="text-xs text-slate-600 mt-0.5">{r.description}</div>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h2 className="text-base font-semibold text-slate-900 mb-3">
                  MCP Agent Skill Prompts ({manifest.prompts.length})
                </h2>
                <ul className="divide-y divide-slate-200 border border-slate-200 rounded-md bg-white">
                  {manifest.prompts.map((p) => (
                    <li key={p.name} className="px-4 py-2.5">
                      <div className="font-mono text-xs font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-600 mt-0.5">{p.description}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <RpcWireHarness tools={manifest.tools} selectedTool={harnessTool} />
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 mt-8">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>Haiwell Cloud SCADA Develop MCP Protocol Specification</span>
          <span className="font-mono">
            {manifest ? `${manifest.tools.length} tools · ${manifest.resources.length} resources · ${manifest.prompts.length} prompts` : 'MCP 2025-03-26'}
          </span>
        </div>
      </footer>
    </div>
  );
}
