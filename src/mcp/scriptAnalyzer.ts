/**
 * Hardened Static Analyzer for Haiwell Cloud SCADA JavaScript command scripts.
 * Strips strings and comments properly before syntax/delimiter balance checks,
 * blocks prototype/sandbox escapes and infinite loops, validates Tag.Read/Tag.Write,
 * and enforces SIL2/SIL3 interlock awareness.
 */

import type { HaiwellTargetHardware, TagDefinition } from './types';

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

const EMBEDDED_ARM_HMI_TARGETS = new Set<HaiwellTargetHardware>([
  'CLOUD_HMI_B7H',
  'CLOUD_HMI_B7',
  'CLOUD_HMI_B10',
  'CLOUD_HMI_C7',
  'CLOUD_HMI_C10',
  'CLOUD_HMI_A8',
  'CLOUD_BOX_CBOX',
]);

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

function resolveKnownTagName(rawRef: string, knownTags: Record<string, TagDefinition>): string | undefined {
  if (hasOwn(knownTags, rawRef)) return rawRef;
  const dotIdx = rawRef.indexOf('.');
  if (dotIdx > 0) {
    const bare = rawRef.slice(dotIdx + 1);
    if (hasOwn(knownTags, bare)) return bare;
  }
  return undefined;
}

export function validateHaiwellScript(
  code: string,
  knownTags: Record<string, TagDefinition>,
  triggerMeta?: {
    trigger?: string;
    intervalMs?: number;
    triggerTag?: string;
    strictEs5?: boolean;
    targetHardware?: HaiwellTargetHardware;
  }
): ScriptValidationResult {
  const diagnostics: ScriptDiagnostic[] = [];
  const referencedTags = new Set<string>();
  const writtenTags = new Set<string>();

  if (!code.trim()) {
    diagnostics.push({
      code: 'HWJS-001',
      severity: 'ERROR',
      message: 'Script body cannot be empty.',
      fixHint: 'Provide executable Strict-ES5 Haiwell JavaScript statements using $Device.Var, Variable.GetByFullName, Tag.Read/Tag.Write, or Common.* APIs.',
    });
    return { valid: false, referencedTags: [], writtenTags: [], diagnostics };
  }

  const noComments = stripJsCommentsOnly(code);
  const scrubbed = stripJsCommentsAndStrings(code);
  const enforceStrictEs5 =
    triggerMeta?.strictEs5 === true ||
    (triggerMeta?.strictEs5 !== false &&
      triggerMeta?.targetHardware !== undefined &&
      EMBEDDED_ARM_HMI_TARGETS.has(triggerMeta.targetHardware));

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

  // Strict ES5 check for real Haiwell Cloud HMI ARM Linux runtime (Node.js v0.10.41)
  const es6Matches: string[] = [];
  const es6Keyword = /\b(const|let|class|async|await)\b/.exec(scrubbed);
  if (es6Keyword) es6Matches.push(es6Keyword[1]);
  if (/=>/.test(scrubbed)) es6Matches.push('arrow function (=>)');
  if (/`/.test(noComments)) es6Matches.push('template literal (`...`)');
  if (/\bMath\.trunc\b/.test(scrubbed)) es6Matches.push('Math.trunc()');
  if (/\.\.\.[A-Za-z_$]/.test(scrubbed)) es6Matches.push('spread/rest (...)');

  if (es6Matches.length > 0) {
    diagnostics.push({
      code: 'HWJS-ES5-001',
      severity: enforceStrictEs5 ? 'ERROR' : 'WARNING',
      message: `ES6+ syntax [${es6Matches.join(', ')}] will crash with SyntaxError on real Haiwell ARM Linux HMIs (Node.js v0.10.41 runtime).`,
      fixHint: 'Use Strict ES5: var declarations, function(){} expressions, string concatenation (+), and Math.floor/Math.ceil instead of const/let/=>/backticks/Math.trunc.',
    });
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
      fixHint: 'Configure a CYCLIC trigger interval or Common.SetInterval inside a STARTUP task instead of looping indefinitely.',
    });
  }

  // Real Haiwell B7H-W runtime trap lints (warnings)
  // 1. Busy-wait delay loops freeze the single-threaded Node.js v0.10.41 event loop
  if (/\bwhile\s*\([^{;]*(?:getTime\s*\(\s*\)|Date\.now\s*\(\s*\))[^{;]*\)/.test(scrubbed)) {
    diagnostics.push({
      code: 'HWJS-RT-004',
      severity: 'WARNING',
      message: 'Blocking busy-wait loop on Date/getTime() freezes the single-threaded Haiwell Node.js event loop and stalls Modbus/UI responsiveness.',
      fixHint: 'Use non-blocking Common.SetTimeout(function() { ... }, delayMs) for momentary pulse unlatching.',
    });
  }

  // 2. Common.database.execTransaction(sqls) mutates the passed array in-place in Haiwell 3.50.x database.ts
  const execTxMatch = /Common\.database\.execTransaction\s*\(\s*([^,)]+)/g;
  let txHit: RegExpExecArray | null;
  while ((txHit = execTxMatch.exec(noComments)) !== null) {
    const arg = txHit[1].trim();
    if (!arg.startsWith('[') && !/\.slice\s*\(\s*\)$/.test(arg)) {
      diagnostics.push({
        code: 'HWJS-RT-001',
        severity: 'WARNING',
        message: `Common.database.execTransaction(${arg}) mutates the SQL array in-place in Haiwell 3.50.x database.ts.`,
        fixHint: `Pass a shallow copy: Common.database.execTransaction(${arg}.slice(), callback).`,
      });
    }
  }

  // 3. Common.database.* without a FIFO queue/mutex risks SQLITE_BUSY crashes (no busy_timeout in Haiwell wrapper)
  if (/Common\.database\.(?:exec|query|execTransaction)\s*\(/.test(noComments)) {
    if (!/\b(?:queue|dbQueue|fifo|inFlight|dbBusy|isBusy|mutex)\b/i.test(scrubbed)) {
      diagnostics.push({
        code: 'HWJS-RT-002',
        severity: 'WARNING',
        message: 'Common.database.* opens a fresh sqlite3 handle per call without busy_timeout on Haiwell 3.50.x, risking SQLITE_BUSY errors under concurrent triggers.',
        fixHint: 'Serialize all Common.database.* operations through a single ES5 FIFO queue (e.g., dbQueue + dbBusy flag).',
      });
    }
  }

  // 4. Common.Ajax double-callback quirk in webserver/utils/goHttp.js
  if (/Common\.Ajax\s*\(/.test(noComments)) {
    if (!/\b(?:handled|done|settled|called|ajaxDone)\b/i.test(scrubbed)) {
      diagnostics.push({
        code: 'HWJS-RT-003',
        severity: 'WARNING',
        message: 'Common.Ajax callback lacks an idempotent guard flag (Haiwell goHttp.js may emit stderr warnings before stdout close).',
        fixHint: 'Add a boolean guard (e.g., var handled = false; if (handled) return; handled = true;) inside the Common.Ajax callback.',
      });
    }
  }

  // 5. Real Haiwell 3.50.x official logging API check (/docs/userScriptLogs):
  // Official API is Common.logger.log/debug/info/trace/warn/note/error (viewable at http://<HMI_IP>/dev/logs.html),
  // NOT guessed System.Log() or Common.Log().
  const nonOfficialLog = /\b(System\.Log|Common\.Log)\s*\(/.exec(noComments);
  if (nonOfficialLog) {
    diagnostics.push({
      code: 'HWJS-API-001',
      severity: 'WARNING',
      message: `"${nonOfficialLog[1]}()" is not a documented Haiwell Cloud SCADA 3.50.x JS API.`,
      fixHint: 'Use the official Haiwell logging API: Common.logger.info("%s", message) (levels: log, debug, info, trace, warn, note, error; live viewer at http://<HMI_IP>/dev/logs.html).',
    });
  }

  // Forbidden dynamic execution, sandbox escape, or bare host globals
  // Note: Haiwell managed Common.SetInterval / Common.SetTimeout are PascalCase and ALLOWED.
  const forbidden = /\b(eval|Function|require|process|child_process|fs|globalThis|__proto__|constructor|prototype|setInterval|setTimeout|import)\b/.exec(
    scrubbed
  );
  if (forbidden) {
    diagnostics.push({
      code: 'HWJS-SEC-001',
      severity: 'ERROR',
      message: `Forbidden sandbox/host symbol "${forbidden[1]}" detected.`,
      fixHint: 'Restrict scripts to documented Haiwell Cloud SCADA APIs: $Device.Var, Variable.GetByFullName/SetByFullName, Common.logger.*, Common.SetTimeout/SetInterval, Common.DelAlertRecord, Common.readAttachFile, Common.MobileBarcodescanner, Common.database.*, Common.Ajax, Window.ClearData, Math, Date, JSON.',
    });
  }

  const recordRead = (rawRef: string, apiLabel: string) => {
    const resolved = resolveKnownTagName(rawRef, knownTags);
    const key = resolved ?? rawRef;
    referencedTags.add(key);
    if (!resolved) {
      diagnostics.push({
        code: 'HWJS-TAG-001',
        severity: 'ERROR',
        message: `${apiLabel} references undeclared tag "${rawRef}".`,
        fixHint: `Create tag "${rawRef}" via haiwell_tag_upsert_batch before referencing it.`,
      });
    }
  };

  const recordWrite = (rawRef: string, apiLabel: string) => {
    const resolved = resolveKnownTagName(rawRef, knownTags);
    const key = resolved ?? rawRef;
    referencedTags.add(key);
    writtenTags.add(key);
    const tag = resolved ? knownTags[resolved] : undefined;
    if (!tag) {
      diagnostics.push({
        code: 'HWJS-TAG-002',
        severity: 'ERROR',
        message: `${apiLabel} targets undeclared tag "${rawRef}".`,
        fixHint: `Declare writable tag "${rawRef}" first.`,
      });
    } else {
      if (tag.access === 'RO') {
        diagnostics.push({
          code: 'HWJS-SAFE-002',
          severity: 'ERROR',
          message: `${apiLabel} targets read-only hardware tag "${tag.name}" (${tag.address ?? tag.scope}).`,
          fixHint: `Write to a RW coil/register instead of read-only input "${tag.name}".`,
        });
      }
      if ((tag.safetyClass === 'SIL2' || tag.safetyClass === 'SIL3') && !noComments.includes('EStop_OK')) {
        diagnostics.push({
          code: 'HWJS-SAFE-003',
          severity: 'WARNING',
          message: `Script writes to ${tag.safetyClass} tag "${tag.name}" without checking EStop_OK interlock.`,
          fixHint: 'Check EStop_OK before writing to safety-critical outputs.',
        });
      }
    }
  };

  // 1. Tag.Read("...") / Tag.Write("...", val)
  const readRegex = /Tag\.Read\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = readRegex.exec(noComments)) !== null) {
    recordRead(m[1], 'Tag.Read');
  }
  const writeRegex = /Tag\.Write\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  while ((m = writeRegex.exec(noComments)) !== null) {
    recordWrite(m[1], 'Tag.Write');
  }

  // 2. Native Haiwell 3.50.x Variable.GetByFullName("Device.Tag") / Variable.SetByFullName("Device.Tag", val)
  const varGetRegex = /Variable\.GetByFullName\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = varGetRegex.exec(noComments)) !== null) {
    recordRead(m[1], 'Variable.GetByFullName');
  }
  const varSetRegex = /Variable\.SetByFullName\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  while ((m = varSetRegex.exec(noComments)) !== null) {
    recordWrite(m[1], 'Variable.SetByFullName');
  }

  // 3. Native Haiwell task direct tag syntax: $DeviceName.VarName (assignment vs read)
  const dollarRegex = /\$([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*([=+-/*]?=)?/g;
  while ((m = dollarRegex.exec(scrubbed)) !== null) {
    const fullRef = m[1];
    const op = m[2];
    const isAssignment = op !== undefined && op !== '==' && op !== '===';
    if (isAssignment) {
      recordWrite(fullRef, `$${fullRef}`);
    } else {
      recordRead(fullRef, `$${fullRef}`);
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
