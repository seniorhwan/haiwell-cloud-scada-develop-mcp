import { Check, Copy, Download } from 'lucide-react';
import { useState } from 'react';

export interface ClientConfigSpec {
  client: string;
  filename: string;
  transport: string;
  cliCommand?: string;
  config: string;
}

interface AgentIntegrationPanelProps {
  clients: Record<'vscode' | 'antigravity' | 'claude-code' | 'codex', ClientConfigSpec>;
  skillMarkdown: string;
}

type TabKey = 'vscode' | 'antigravity' | 'claude-code' | 'codex' | 'skill-md';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'vscode', label: 'VS Code' },
  { key: 'antigravity', label: 'Google Antigravity' },
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex CLI' },
  { key: 'skill-md', label: 'SKILL.md' },
];

export function AgentIntegrationPanel({ clients, skillMarkdown }: AgentIntegrationPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('vscode');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeContent =
    activeTab === 'skill-md' ? skillMarkdown : clients[activeTab].config;

  const activeFilename =
    activeTab === 'skill-md' ? 'SKILL.md' : clients[activeTab].filename;

  const activeCli =
    activeTab !== 'skill-md' ? clients[activeTab].cliCommand : undefined;

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopiedId(null);
    }
  };

  const downloadContent = () => {
    const blob = new Blob([activeContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFilename.split('/').pop() || 'mcp-config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="agent-skills" className="py-12 border-b border-slate-200">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
            02. Agent Integration and Skill Manifests
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-xl">
            Drop-in MCP server definitions for Streamable HTTP and local stdio runtimes across IDE and CLI coding agents.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Agent client configurations"
          className="flex items-center gap-1 p-1 bg-slate-100 rounded-md border border-slate-200 overflow-x-auto max-w-full shrink-0"
        >
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab.key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="border border-slate-200 rounded-md bg-slate-50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-slate-600 font-mono">
            <span className="font-semibold text-slate-900">{activeFilename}</span>
            <span aria-hidden="true">·</span>
            <span>{activeTab === 'skill-md' ? 'Agent Playbook (Markdown)' : clients[activeTab].transport}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => copyText('config', activeContent)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedId === 'config' ? <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              {copiedId === 'config' ? 'Copied' : 'Copy File'}
            </button>
            <button
              type="button"
              onClick={downloadContent}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              Download
            </button>
          </div>
        </div>

        {activeCli && (
          <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-100/70 flex items-center justify-between gap-4">
            <code className="text-xs text-slate-800 overflow-x-auto">{activeCli}</code>
            <button
              type="button"
              onClick={() => copyText('cli', activeCli)}
              className="text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedId === 'cli' ? 'Copied CLI' : 'Copy Command'}
            </button>
          </div>
        )}

        <pre className="p-4 text-xs leading-relaxed text-slate-800 overflow-x-auto max-h-80 font-mono">
          <code>{activeContent}</code>
        </pre>
      </div>
    </section>
  );
}
