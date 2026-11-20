import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SerializedToolItem } from './CapabilityCatalog';

interface RpcWireHarnessProps {
  tools: SerializedToolItem[];
  selectedTool: SerializedToolItem | null;
}

type ProtocolPreset =
  | 'tools/call'
  | 'initialize'
  | 'tools/list'
  | 'resources/list'
  | 'resources/read'
  | 'prompts/list';

export function RpcWireHarness({ tools, selectedTool }: RpcWireHarnessProps) {
  const [preset, setPreset] = useState<ProtocolPreset>('tools/call');
  const [toolName, setToolName] = useState<string>('haiwell_iec61131_validate');
  const [requestJson, setRequestJson] = useState<string>('');
  const [responseJson, setResponseJson] = useState<string>('');
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const buildPayloadForTool = (name: string) => {
    const tool = tools.find((t) => t.name === name) ?? tools[0];
    return JSON.stringify(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool?.name ?? name,
          arguments: tool?.sampleInput ?? {},
        },
      },
      null,
      2
    );
  };

  useEffect(() => {
    if (selectedTool) {
      setPreset('tools/call');
      setToolName(selectedTool.name);
      setRequestJson(buildPayloadForTool(selectedTool.name));
    } else if (!requestJson && tools.length > 0) {
      setRequestJson(buildPayloadForTool('haiwell_iec61131_validate'));
    }
  }, [selectedTool, tools]);

  const applyPreset = (nextPreset: ProtocolPreset) => {
    setPreset(nextPreset);
    setErrorText(null);
    if (nextPreset === 'tools/call') {
      setRequestJson(buildPayloadForTool(toolName));
    } else if (nextPreset === 'initialize') {
      setRequestJson(
        JSON.stringify(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'antigravity-agent', version: '1.0.0' },
            },
          },
          null,
          2
        )
      );
    } else if (nextPreset === 'resources/read') {
      setRequestJson(
        JSON.stringify(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'resources/read',
            params: { uri: 'haiwell://project/prj_chiller_plant_01/opcua-nodeset2' },
          },
          null,
          2
        )
      );
    } else {
      setRequestJson(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: nextPreset, params: {} }, null, 2)
      );
    }
  };

  const handleToolSelect = (nextName: string) => {
    setPreset('tools/call');
    setToolName(nextName);
    setRequestJson(buildPayloadForTool(nextName));
    setErrorText(null);
  };

  const handleSend = async () => {
    setErrorText(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(requestJson);
    } catch (err) {
      setErrorText(err instanceof Error ? `Invalid JSON payload: ${err.message}` : 'Invalid JSON payload');
      return;
    }

    setIsSending(true);
    const start = performance.now();
    try {
      const res = await fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(parsed),
      });
      const elapsed = (performance.now() - start).toFixed(2);
      setHttpStatus(res.status);
      setLatencyMs(res.headers.get('X-Execution-Time-Ms') ?? elapsed);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        setResponseJson(JSON.stringify(json, null, 2));
      } catch {
        setResponseJson(text);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Network error invoking /mcp');
    } finally {
      setIsSending(false);
    }
  };

  const [responseView, setResponseView] = useState<'parsed' | 'raw'>('parsed');

  const decodedToolPayload = (() => {
    if (!responseJson) return '';
    try {
      const outer = JSON.parse(responseJson);
      const innerText = outer?.result?.content?.[0]?.text;
      if (typeof innerText === 'string') {
        return JSON.stringify(JSON.parse(innerText), null, 2);
      }
      return responseJson;
    } catch {
      return responseJson;
    }
  })();

  return (
    <section id="wire-harness" className="py-12">
      <div className="flex flex-col gap-4 mb-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
            04. Headless JSON-RPC 2.0 Wire Harness
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Execute raw MCP Streamable HTTP requests directly against <code className="text-xs font-mono text-slate-800">POST /mcp</code> and inspect exact machine-readable responses.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md border border-slate-200 overflow-x-auto w-fit max-w-full">
          {(['tools/call', 'initialize', 'tools/list', 'resources/list', 'resources/read', 'prompts/list'] as ProtocolPreset[]).map(
            (p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  preset === p ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p}
              </button>
            )
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-slate-200 rounded-md bg-white flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">POST /mcp</span>
              {preset === 'tools/call' && (
                <select
                  aria-label="Select MCP tool for wire harness"
                  value={toolName}
                  onChange={(e) => handleToolSelect(e.target.value)}
                  className="text-xs font-mono bg-white border border-slate-200 rounded px-2 py-1 text-slate-800 focus:outline-none focus:border-blue-700 max-w-[240px] truncate"
                >
                  {tools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <button
              type="button"
              disabled={isSending}
              onClick={handleSend}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              {isSending ? 'Executing...' : 'Send JSON-RPC'}
            </button>
          </div>

          <label htmlFor="mcp-request-json" className="sr-only">
            JSON-RPC 2.0 Request Body
          </label>
          <textarea
            id="mcp-request-json"
            value={requestJson}
            onChange={(e) => setRequestJson(e.target.value)}
            spellCheck={false}
            rows={16}
            className="w-full p-4 font-mono text-xs leading-relaxed text-slate-900 bg-white focus:outline-none resize-y"
          />

          {errorText && (
            <div role="alert" className="px-4 py-2.5 border-t border-rose-200 bg-rose-50 text-xs text-rose-800 font-mono">
              {errorText}
            </div>
          )}
        </div>

        <div className="border border-slate-200 rounded-md bg-slate-50 flex flex-col overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded border border-slate-200">
              <button
                type="button"
                onClick={() => setResponseView('parsed')}
                className={`px-2 py-1 rounded text-xs font-sans font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  responseView === 'parsed' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Decoded Payload
              </button>
              <button
                type="button"
                onClick={() => setResponseView('raw')}
                className={`px-2 py-1 rounded text-xs font-sans font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  responseView === 'raw' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Raw Wire JSON-RPC
              </button>
            </div>
            <span className="text-slate-500 tabular-nums whitespace-nowrap">
              {httpStatus !== null
                ? `HTTP ${httpStatus} · ${latencyMs} ms`
                : 'Awaiting request'}
            </span>
          </div>

          <pre
            data-testid="mcp-wire-response"
            className="p-4 font-mono text-xs leading-relaxed text-slate-800 overflow-auto max-h-[360px] flex-1"
          >
            <code>
              {(responseView === 'parsed' ? decodedToolPayload : responseJson) ||
                '// Click "Send JSON-RPC" to invoke the live MCP Streamable HTTP endpoint.'}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
