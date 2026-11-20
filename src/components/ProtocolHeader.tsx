import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

interface ProtocolHeaderProps {
  mcpEndpoint: string;
}

export function ProtocolHeader({ mcpEndpoint }: ProtocolHeaderProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
        <a
          href="#endpoints"
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Haiwell SCADA MCP
        </a>

        <nav aria-label="Primary specification navigation" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#endpoints" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Endpoints
          </a>
          <a href="#agent-skills" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Agent Skills
          </a>
          <a href="#tool-schemas" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Tool Schemas
          </a>
          <a href="#wire-harness" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Wire Harness
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
            {copied ? 'Copied /mcp URL' : 'Copy MCP URL'}
          </button>
        </div>
      </div>
    </header>
  );
}
