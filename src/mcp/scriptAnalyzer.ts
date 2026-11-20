/**
 * Hardened Static Analyzer for Haiwell Cloud SCADA JavaScript command scripts.
 * Strips strings and comments properly before syntax/delimiter balance checks,
 * blocks prototype/sandbox escapes and infinite loops, validates Tag.Read/Tag.Write,
 * and enforces SIL2/SIL3 interlock awareness.
 */

import type { TagDefinition } from './types';

export interface ScriptDiagnostic {
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  fixHint: string;
}

export interface ScriptValidationResult {
  valid: boolean;
  referencedTags: string[];
  writtenTags: string[];
  diagnostics: ScriptDiagnostic[];
}

function stripJsCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  let state: 'NORMAL' | 'SINGLE' | 'DOUBLE' | 'TEMPLATE' | 'LINE_COMMENT' | 'BLOCK_COMMENT' = 'NORMAL';

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1] ?? '';

    if (state === 'LINE_COMMENT') {
      if (ch === '\n') {
        state = 'NORMAL';
        out += '\n';
      }
      i++;
      continue;
    }
    if (state === 'BLOCK_COMMENT') {
      if (ch === '*' && next === '/') {
        state = 'NORMAL';
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (state === 'SINGLE' || state === 'DOUBLE' || state === 'TEMPLATE') {
      const quote = state === 'SINGLE' ? "'" : state === 'DOUBLE' ? '"' : '`';
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) state = 'NORMAL';
      out += ' ';
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'LINE_COMMENT';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'BLOCK_COMMENT';
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = 'SINGLE';
      out += ' ';
      i++;
      continue;
    }
    if (ch === '"') {
      state = 'DOUBLE';
      out += ' ';
      i++;
      continue;
    }
    if (ch === '`') {
      state = 'TEMPLATE';
      out += ' ';
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function stripJsCommentsOnly(code: string): string {
  let out = '';
  let i = 0;
  let state: 'NORMAL' | 'SINGLE' | 'DOUBLE' | 'TEMPLATE' | 'LINE_COMMENT' | 'BLOCK_COMMENT' = 'NORMAL';

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1] ?? '';

    if (state === 'LINE_COMMENT') {
      if (ch === '\n') {
        state = 'NORMAL';
        out += '\n';
      }
      i++;
      continue;
    }
    if (state === 'BLOCK_COMMENT') {
      if (ch === '*' && next === '/') {
        state = 'NORMAL';
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (state === 'SINGLE' || state === 'DOUBLE' || state === 'TEMPLATE') {
      const quote = state === 'SINGLE' ? "'" : state === 'DOUBLE' ? '"' : '`';
      if (ch === '\\') {
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === quote) state = 'NORMAL';
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'LINE_COMMENT';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'BLOCK_COMMENT';
      i += 2;
      continue;
    }
    if (ch === "'") state = 'SINGLE';
    else if (ch === '"') state = 'DOUBLE';
    else if (ch === '`') state = 'TEMPLATE';

    out += ch;
    i++;
  }
  return out;
}

const hasOwn = (obj: Record<string, TagDefinition>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

export function validateHaiwellScript(
  code: string,
  knownTags: Record<string, TagDefinition>,
  triggerMeta?: { trigger?: string; intervalMs?: number; triggerTag?: string }
): ScriptValidationResult {
  const diagnostics: ScriptDiagnostic[] = [];
  const referencedTags = new Set<string>();
  const writtenTags = new Set<string>();

  if (!code.trim()) {
    diagnostics.push({
      code: 'HWJS-001',
      severity: 'ERROR',
      message: 'Script body cannot be empty.',
      fixHint: 'Provide executable Haiwell JavaScript statements using Tag.Read / Tag.Write / System.Log.',
    });
    return { valid: false, referencedTags: [], writtenTags: [], diagnostics };
  }

  const noComments = stripJsCommentsOnly(code);
  const scrubbed = stripJsCommentsAndStrings(code);

  // Trigger metadata sanity checks
  if (triggerMeta?.trigger === 'CYCLIC' && (!triggerMeta.intervalMs || triggerMeta.intervalMs < 50)) {
    diagnostics.push({
      code: 'HWJS-TRG-001',
      severity: 'ERROR',
      message: 'CYCLIC script requires intervalMs >= 50 ms to avoid starving the SCADA runtime.',
      fixHint: 'Set intervalMs (e.g., 500 or 1000).',
    });
  }
  if (triggerMeta?.trigger === 'TAG_CHANGE') {
    if (!triggerMeta.triggerTag || !hasOwn(knownTags, triggerMeta.triggerTag)) {
      diagnostics.push({
        code: 'HWJS-TRG-002',
        severity: 'ERROR',
        message: `TAG_CHANGE script triggerTag "${triggerMeta.triggerTag ?? ''}" is missing or undeclared.`,
        fixHint: 'Bind triggerTag to an existing project tag.',
      });
    }
  }

  // Forbidden blocking loops (while(true), for(;;), do{}while(true))
  if (
    /\bwhile\s*\(\s*(?:true|1)\s*\)/i.test(scrubbed) ||
    /\bfor\s*\(\s*;\s*;\s*\)/.test(scrubbed) ||
    /\bdo\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:true|1)\s*\)/i.test(scrubbed)
  ) {
    diagnostics.push({
      code: 'HWJS-SAFE-001',
      severity: 'ERROR',
      message: 'Infinite loop detected which blocks the Haiwell SCADA runtime thread.',
      fixHint: 'Configure a CYCLIC trigger interval instead of looping indefinitely inside the script.',
    });
  }

  // Forbidden dynamic execution, sandbox escape, or host globals
  const forbidden = /\b(eval|Function|require|process|child_process|fs|globalThis|__proto__|constructor|prototype|setInterval|setTimeout|import)\b/.exec(
    scrubbed
  );
  if (forbidden) {
    diagnostics.push({
      code: 'HWJS-SEC-001',
      severity: 'ERROR',
      message: `Forbidden sandbox/host symbol "${forbidden[1]}" detected.`,
      fixHint: 'Restrict scripts to Haiwell Cloud SCADA APIs: Tag, System, Screen, Recipe, Alarm, Math, Date, JSON.',
    });
  }

  // Extract Tag.Read("...") from comment-stripped code
  const readRegex = /Tag\.Read\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = readRegex.exec(noComments)) !== null) {
    const tagName = m[1];
    referencedTags.add(tagName);
    if (!hasOwn(knownTags, tagName)) {
      diagnostics.push({
        code: 'HWJS-TAG-001',
        severity: 'ERROR',
        message: `Tag.Read references undeclared tag "${tagName}".`,
        fixHint: `Create tag "${tagName}" via haiwell_tag_upsert_batch before referencing it.`,
      });
    }
  }

  // Extract Tag.Write("...", val) from comment-stripped code
  const writeRegex = /Tag\.Write\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  while ((m = writeRegex.exec(noComments)) !== null) {
    const tagName = m[1];
    referencedTags.add(tagName);
    writtenTags.add(tagName);
    const tag = hasOwn(knownTags, tagName) ? knownTags[tagName] : undefined;
    if (!tag) {
      diagnostics.push({
        code: 'HWJS-TAG-002',
        severity: 'ERROR',
        message: `Tag.Write targets undeclared tag "${tagName}".`,
        fixHint: `Declare writable tag "${tagName}" first.`,
      });
    } else {
      if (tag.access === 'RO') {
        diagnostics.push({
          code: 'HWJS-SAFE-002',
          severity: 'ERROR',
          message: `Tag.Write targets read-only hardware tag "${tagName}" (${tag.address ?? tag.scope}).`,
          fixHint: `Write to a RW coil/register instead of read-only input "${tagName}".`,
        });
      }
      if ((tag.safetyClass === 'SIL2' || tag.safetyClass === 'SIL3') && !noComments.includes('EStop_OK')) {
        diagnostics.push({
          code: 'HWJS-SAFE-003',
          severity: 'WARNING',
          message: `Script writes to ${tag.safetyClass} tag "${tagName}" without checking EStop_OK interlock.`,
          fixHint: 'Check Tag.Read("EStop_OK") before writing to safety-critical outputs.',
        });
      }
    }
  }

  // Balanced delimiter check on comment- & string-stripped code
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  for (const ch of scrubbed) {
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== pairs[ch]) {
        diagnostics.push({
          code: 'HWJS-SYN-001',
          severity: 'ERROR',
          message: `Unbalanced delimiter "${ch}" in JavaScript script.`,
          fixHint: 'Check matching (), {}, and [] delimiters.',
        });
        break;
      }
    }
  }
  if (stack.length > 0 && !diagnostics.some((d) => d.code === 'HWJS-SYN-001')) {
    diagnostics.push({
      code: 'HWJS-SYN-001',
      severity: 'ERROR',
      message: `Unclosed delimiter "${stack[stack.length - 1]}" in JavaScript script.`,
      fixHint: 'Close all opened (), {}, and [] blocks.',
    });
  }

  return {
    valid: diagnostics.every((d) => d.severity !== 'ERROR'),
    referencedTags: [...referencedTags],
    writtenTags: [...writtenTags],
    diagnostics,
  };
}
