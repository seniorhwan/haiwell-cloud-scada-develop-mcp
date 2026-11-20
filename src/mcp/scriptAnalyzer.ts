/**
 * Static analyzer for Haiwell Cloud SCADA JavaScript command language scripts.
 * Verifies Tag.Read/Tag.Write bindings, prevents runtime freezes/security escapes,
 * and validates read-only hardware tag write protection.
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

export function validateHaiwellScript(
  code: string,
  knownTags: Record<string, TagDefinition>
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
  }

  // Forbidden blocking or unsafe runtime patterns
  if (/\bwhile\s*\(\s*(?:true|1)\s*\)/i.test(code) || /\bfor\s*\(\s*;\s*;\s*\)/.test(code)) {
    diagnostics.push({
      code: 'HWJS-SAFE-001',
      severity: 'ERROR',
      message: 'Infinite loop detected (while(true) / for(;;)) which blocks the Haiwell SCADA UI/runtime thread.',
      fixHint: 'Configure a CYCLIC trigger interval instead of looping indefinitely inside the script.',
    });
  }

  if (/\b(eval|Function|require|process|child_process|fs)\b/.test(code)) {
    diagnostics.push({
      code: 'HWJS-SEC-001',
      severity: 'ERROR',
      message: 'Forbidden dynamic execution or host OS symbol detected.',
      fixHint: 'Restrict scripts to Haiwell Cloud SCADA APIs: Tag, System, Screen, Recipe, Alarm, Math, Date, JSON.',
    });
  }

  // Extract Tag.Read("...")
  const readRegex = /Tag\.Read\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = readRegex.exec(code)) !== null) {
    const tagName = m[1];
    referencedTags.add(tagName);
    if (!knownTags[tagName]) {
      diagnostics.push({
        code: 'HWJS-TAG-001',
        severity: 'ERROR',
        message: `Tag.Read references undeclared tag "${tagName}".`,
        fixHint: `Create tag "${tagName}" via haiwell_tag_upsert_batch before referencing it.`,
      });
    }
  }

  // Extract Tag.Write("...", val)
  const writeRegex = /Tag\.Write\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  while ((m = writeRegex.exec(code)) !== null) {
    const tagName = m[1];
    referencedTags.add(tagName);
    writtenTags.add(tagName);
    const tag = knownTags[tagName];
    if (!tag) {
      diagnostics.push({
        code: 'HWJS-TAG-002',
        severity: 'ERROR',
        message: `Tag.Write targets undeclared tag "${tagName}".`,
        fixHint: `Declare writable tag "${tagName}" first.`,
      });
    } else if (tag.access === 'RO') {
      diagnostics.push({
        code: 'HWJS-SAFE-002',
        severity: 'ERROR',
        message: `Tag.Write targets read-only hardware tag "${tagName}" (${tag.address ?? tag.scope}).`,
        fixHint: `Write to a RW coil/register instead of read-only input "${tagName}".`,
      });
    }
  }

  // Basic brace/paren balance check
  let parens = 0;
  let braces = 0;
  for (const ch of code) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
    if (parens < 0 || braces < 0) break;
  }
  if (parens !== 0 || braces !== 0) {
    diagnostics.push({
      code: 'HWJS-SYN-001',
      severity: 'ERROR',
      message: 'Unbalanced parentheses or curly braces in JavaScript script.',
      fixHint: 'Check matching "(" / ")" and "{" / "}" delimiters.',
    });
  }

  return {
    valid: diagnostics.every((d) => d.severity !== 'ERROR'),
    referencedTags: [...referencedTags],
    writtenTags: [...writtenTags],
    diagnostics,
  };
}
