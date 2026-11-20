import { ArrowRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

export interface CapabilitySummaryItem {
  id: string;
  title: string;
  haiwellModules: string[];
  tools: string[];
  standards: string[];
}

export interface SerializedToolItem {
  name: string;
  domain: string;
  haiwellFeature: string;
  safetyTier: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sampleInput: Record<string, unknown>;
}

interface CapabilityCatalogProps {
  capabilities: CapabilitySummaryItem[];
  tools: SerializedToolItem[];
  onLoadInHarness: (tool: SerializedToolItem) => void;
}

const SAFETY_LABELS: Record<string, string> = {
  read: 'Read-Only',
  design: 'Design Mutation',
  control_guarded: 'Control Guarded (Interlock)',
  protocol_io: 'Protocol I/O',
};

export function CapabilityCatalog({
  capabilities,
  tools,
  onLoadInHarness,
}: CapabilityCatalogProps) {
  const [selectedDomain, setSelectedDomain] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selectedToolName, setSelectedToolName] = useState<string>(
    tools[0]?.name ?? 'haiwell_iec61131_validate'
  );

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (selectedDomain !== 'all' && t.domain !== selectedDomain) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.haiwellFeature.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    });
  }, [tools, selectedDomain, query]);

  const activeTool =
    filteredTools.find((t) => t.name === selectedToolName) ??
    filteredTools[0] ??
    tools[0];

  return (
    <section id="tool-schemas" className="py-12 border-b border-slate-200">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
          03. Haiwell Cloud SCADA Develop Capability Matrix and Tool Schemas
        </h2>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          Every functional module of Haiwell Cloud SCADA Develop mapped to strictly validated Zod v4 MCP tool contracts.
        </p>
      </div>

      {/* Compact 14-domain matrix table */}
      <div className="mb-8 border border-slate-200 rounded-md overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
              <th className="py-2.5 px-4">Domain</th>
              <th className="py-2.5 px-4">Haiwell Cloud SCADA Modules Covered</th>
              <th className="py-2.5 px-4">MCP Tools</th>
              <th className="py-2.5 px-4">Standards</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {capabilities.map((cap) => (
              <tr
                key={cap.id}
                className={selectedDomain === cap.id ? 'bg-blue-50/40' : 'hover:bg-slate-50/60'}
              >
                <td className="py-2.5 px-4 align-top whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setSelectedDomain(selectedDomain === cap.id ? 'all' : cap.id)}
                    className="font-semibold text-slate-900 hover:text-blue-700 text-left cursor-pointer"
                  >
                    {cap.title}
                  </button>
                </td>
                <td className="py-2.5 px-4 align-top text-slate-600">
                  {cap.haiwellModules.join(' · ')}
                </td>
                <td className="py-2.5 px-4 align-top font-mono text-slate-800">
                  {cap.tools.join(', ')}
                </td>
                <td className="py-2.5 px-4 align-top text-slate-600 whitespace-nowrap">
                  {cap.standards.join(' / ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Filter bar + Split Schema Inspector */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md border border-slate-200">
          <button
            type="button"
            onClick={() => setSelectedDomain('all')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
              selectedDomain === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Domains ({tools.length})
          </button>
          {['iec61131', 'hmi', 'tags', 'mqtt', 'opcua', 'devices', 'alarms', 'recipes'].map((dom) => (
            <button
              key={dom}
              type="button"
              onClick={() => setSelectedDomain(dom)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                selectedDomain === dom ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {dom}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter MCP tools"
            placeholder="Filter tool name or capability..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-700"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 border border-slate-200 rounded-md overflow-hidden bg-white">
        <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200 max-h-[460px] overflow-y-auto divide-y divide-slate-200">
          {filteredTools.length === 0 ? (
            <div className="p-6 text-xs text-slate-500">
              No MCP tools match the current filter.
            </div>
          ) : (
            filteredTools.map((tool) => {
              const isSelected = activeTool?.name === tool.name;
              return (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => setSelectedToolName(tool.name)}
                  className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                    isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="font-mono text-xs font-semibold text-slate-900 truncate">
                    {tool.name}
                  </div>
                  <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
                    <span>{tool.domain}</span>
                    <span aria-hidden="true">·</span>
                    <span>{SAFETY_LABELS[tool.safetyTier] ?? tool.safetyTier}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="lg:col-span-7 p-5 bg-slate-50/50 flex flex-col justify-between gap-4">
          {activeTool && (
            <>
              <div>
                <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
                  <div>
                    <h3 className="font-mono text-sm font-semibold text-slate-900">
                      {activeTool.name}
                    </h3>
                    <p className="text-xs text-slate-600 mt-1">
                      {activeTool.haiwellFeature} · {SAFETY_LABELS[activeTool.safetyTier] ?? activeTool.safetyTier}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onLoadInHarness(activeTool)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Invoke in Wire Harness
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>

                <p className="text-xs leading-relaxed text-slate-700 mt-3">
                  {activeTool.description}
                </p>

                <div className="mt-4">
                  <div className="text-xs font-semibold text-slate-700 mb-1.5">
                    Strict Input JSON Schema (Zod v4)
                  </div>
                  <pre className="p-3 text-xs leading-relaxed text-slate-800 bg-white border border-slate-200 rounded overflow-x-auto max-h-64 font-mono">
                    <code>{JSON.stringify(activeTool.inputSchema, null, 2)}</code>
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
