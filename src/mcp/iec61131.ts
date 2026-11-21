/**
 * Hardened IEC 61131-3:2013 Static Validator, Safety Analyzer, & Haiwell JS Transpiler.
 * Handles multi-line expressions, single-line IF/END_IF, multiple statements per line,
 * ARRAY/STRING declarations, condition variable resolution, unguarded division,
 * unbounded WHILE/REPEAT loops, CASE/ELSE completeness, Ladder double-coil & schema checks,
 * and FBD algebraic-loop cycle detection.
 */

import * as acorn from 'acorn';
import type { Iec61131Diagnostic } from './types';

export const IEC_ELEMENTARY_TYPES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'TIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
  'STRING', 'WSTRING',
]);

export const IEC_STANDARD_FBS = new Set([
  'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD',
  'R_TRIG', 'F_TRIG', 'SR', 'RS', 'PID', 'HYSTERESIS', 'SCALE_LIN',
]);

const IEC_KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'FUNCTION', 'END_FUNCTION',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
  'CONSTANT', 'RETAIN', 'AT', 'ARRAY', 'OF',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'RETURN',
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
  'ABS', 'SQRT', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'TRUNC', 'ROUND',
  'INT_TO_REAL', 'REAL_TO_INT', 'DINT_TO_INT', 'INT_TO_DINT', 'BOOL_TO_INT', 'WORD_TO_INT', 'REAL_TO_DINT', 'DINT_TO_REAL', 'UINT_TO_REAL', 'REAL_TO_UINT',
  'BYTE_TO_INT', 'INT_TO_BYTE', 'INT_TO_WORD', 'DWORD_TO_DINT', 'DINT_TO_DWORD', 'STRING_TO_INT', 'INT_TO_STRING',
]);

const BIT_WIDTH: Record<string, number> = {
  BOOL: 1,
  SINT: 8, USINT: 8, BYTE: 8,
  INT: 16, UINT: 16, WORD: 16,
  DINT: 32, UDINT: 32, DWORD: 32, REAL: 32,
  LINT: 64, ULINT: 64, LWORD: 64, LREAL: 64,
};

const FLOAT_TYPES = new Set(['REAL', 'LREAL']);

export interface DeclaredVariable {
  name: string;
  dataType: string;
  isArray?: boolean;
  initialValue?: string;
  section: 'VAR' | 'VAR_INPUT' | 'VAR_OUTPUT' | 'VAR_IN_OUT' | 'VAR_GLOBAL' | 'VAR_TEMP' | 'VAR_EXTERNAL';
  constant: boolean;
  directAddress?: string;
  line: number;
}

export interface Iec61131ValidationResult {
  valid: boolean;
  standard: 'IEC 61131-3:2013 (3rd Ed.)';
  language: 'ST' | 'LD' | 'FBD';
  pouType?: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION';
  pouName?: string;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    declaredVariables: number;
    cyclomaticComplexity: number;
  };
  variables: DeclaredVariable[];
  diagnostics: Iec61131Diagnostic[];
}

function stripCommentsPreserveLines(
  source: string,
  commentStats?: { openCount: number; closeCount: number; cStyleUnclosed: boolean }
): string {
  // Handle nested (* ... *) comments, /* ... */ comments, and // single-line comments without touching strings
  let out = '';
  let i = 0;
  let blockDepth = 0;
  let inCBlock = false;
  let inSingle = false;
  let inDouble = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (inCBlock) {
      if (ch === '*' && next === '/') {
        inCBlock = false;
        out += '  ';
        i += 2;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (blockDepth > 0) {
      if (ch === '(' && next === '*') {
        blockDepth++;
        if (commentStats) commentStats.openCount++;
        out += '  ';
        i += 2;
      } else if (ch === '*' && next === ')') {
        blockDepth--;
        if (commentStats) commentStats.closeCount++;
        out += '  ';
        i += 2;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (inSingle) {
      out += ch;
      if (ch === '$' && next) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '$' && next) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === '(' && next === '*') {
      blockDepth = 1;
      if (commentStats) commentStats.openCount++;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '*' && next === ')') {
      if (commentStats) commentStats.closeCount++;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inCBlock = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;

    out += ch;
    i++;
  }
  if (commentStats && inCBlock) {
    commentStats.cStyleUnclosed = true;
  }
  return out;
}

function stripLiteralsForIdentScan(expr: string): string {
  return expr
    .replace(/'(?:[^'$]|\$.)*'/g, ' ')
    .replace(/"(?:[^"$]|\$.)*"/g, ' ')
    .replace(/\b(?:T|TIME|D|DATE|TOD|DT)#[0-9_a-zA-Z.:-]+\b/gi, ' ')
    .replace(/\b(?:2|8|16)#[0-9A-Fa-f_]+\b/g, ' ')
    .replace(/%[IQM][XBWDL]?\d+(?:\.\d+)?/gi, ' ')
    .replace(/\.[A-Za-z_][A-Za-z0-9_]*/g, ' ');
}

function validateDirectAddress(addr: string, line: number, diagnostics: Iec61131Diagnostic[]): void {
  if (!/^%[IQM]([XBWDL])?\d+(\.\d+)?$/i.test(addr)) {
    diagnostics.push({
      code: 'IEC-ADDR-001',
      severity: 'ERROR',
      line,
      column: 1,
      rule: 'IEC 61131-3 §6.5.5 Direct Representation',
      message: `Invalid direct hardware address "${addr}".`,
      fixHint: 'Use standard IEC direct address format such as %IX0.0, %QX0.1, %IW0, %QW0, %MW100, or %MD20.',
    });
  }
}

function checkExpressionIdentifiers(
  expr: string,
  lineNum: number,
  varMap: Map<string, DeclaredVariable>,
  pouName: string | undefined,
  diagnostics: Iec61131Diagnostic[]
): void {
  const scrubbed = stripLiteralsForIdentScan(expr);
  const identRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = identRegex.exec(scrubbed)) !== null) {
    const token = m[1];
    const upper = token.toUpperCase();
    if (IEC_KEYWORDS.has(upper) || IEC_ELEMENTARY_TYPES.has(upper) || IEC_STANDARD_FBS.has(upper)) continue;
    if (/^[A-Z]+_TO_[A-Z]+$/.test(upper)) continue;
    if (pouName && upper === pouName.toUpperCase()) continue;
    if (!varMap.has(upper)) {
      diagnostics.push({
        code: 'IEC-VAR-006',
        severity: 'ERROR',
        line: lineNum,
        column: m.index + 1,
        rule: 'IEC 61131-3 Strict Variable Resolution',
        message: `Undeclared identifier "${token}" referenced in expression.`,
        fixHint: `Declare "${token}" in VAR, VAR_INPUT, VAR_OUTPUT, or VAR_GLOBAL before referencing it.`,
      });
    }
  }
}

interface LogicalStatement {
  text: string;
  line: number;
}

/**
 * Quote-aware string masking: replaces IEC single-quoted ('...') and double-quoted ("...")
 * string literals with tokens so statement/VAR splitting never splits inside quotes.
 */
function maskIecStrings(input: string): { masked: string; literals: string[] } {
  const literals: string[] = [];
  let masked = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let lit = ch;
      i++;
      while (i < input.length) {
        const c = input[i];
        lit += c;
        if (c === '$' && i + 1 < input.length) {
          i++;
          lit += input[i];
        } else if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      const idx = literals.push(lit) - 1;
      masked += `__IECSTR_${idx}__`;
    } else {
      masked += ch;
      i++;
    }
  }
  return { masked, literals };
}

function unmaskIecStrings(masked: string, literals: string[]): string {
  return masked.replace(/__IECSTR_(\d+)__/g, (_, idx) => literals[Number(idx)] ?? '');
}

/**
 * Parses an IEC 61131-3 duration literal such as T#2s, TIME#500ms, T#1m30s, T#1h2m3s4ms
 * into integer milliseconds.
 */
function parseIecTimeLiteralMs(literal: string): number {
  const body = literal.replace(/^(?:TIME|T)#/i, '').trim();
  const unitFactors: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1000,
    ms: 1,
  };
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const num = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (Number.isFinite(num) && unitFactors[unit]) {
      total += num * unitFactors[unit];
    }
  }
  return Math.round(total);
}

/**
 * Splits cleaned ST body lines into logical statements cleanly OUTSIDE string literals
 * so single-line "IF a THEN b := 1; END_IF;" and strings like `'a; b THEN c'` both work!
 */
function splitTopLevelArgs(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1] ?? '';
    if (inSingle) {
      current += ch;
      if (ch === '$' && next) {
        current += next;
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '$' && next) {
        current += next;
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function expandBodyStatements(lines: { text: string; line: number }[]): LogicalStatement[] {
  const result: LogicalStatement[] = [];
  let buffer = '';
  let bufferLine = 0;

  const flushLine = (raw: string, line: number) => {
    const segment = raw.trim();
    if (!segment) return;

    const { masked, literals } = maskIecStrings(segment);
    const expanded = masked
      .replace(/^(REPEAT)\b\s+(?=\S)/i, '$1\n')
      .replace(/\bTHEN(?=\s*\S)/gi, 'THEN\n')
      .replace(/\bDO(?=\s*\S)/gi, 'DO\n')
      .replace(/;\s*(?=\S)/g, ';\n')
      .replace(/\bELSE(?=\s+\S)/gi, 'ELSE\n')
      .replace(/\s+(END_REPEAT)\b/gi, '\n$1')
      .replace(/((?:^|\n)\s*-?\d+(?:\s*\.\.\s*-?\d+)?(?:\s*,\s*-?\d+(?:\s*\.\.\s*-?\d+)?)*\s*:)\s*(?=\S)/g, '$1\n');

    for (const part of expanded.split('\n')) {
      const p = unmaskIecStrings(part, literals).trim();
      if (p) result.push({ text: p, line });
    }
  };

  for (const item of lines) {
    const t = item.text.trim();
    if (!t) continue;

    if (!buffer) bufferLine = item.line;
    buffer = buffer ? `${buffer} ${t}` : t;

    const { masked } = maskIecStrings(buffer);
    const complete =
      masked.endsWith(';') ||
      /\b(THEN|DO|ELSE|OF|REPEAT|END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\s*;?$/i.test(masked) ||
      /^[0-9,\s.-]+:\s*$/.test(masked);

    if (complete) {
      flushLine(buffer, bufferLine);
      buffer = '';
    }
  }

  if (buffer) {
    flushLine(buffer, bufferLine);
  }
  return result;
}

export function validateStructuredText(source: string): Iec61131ValidationResult {
  const diagnostics: Iec61131Diagnostic[] = [];
  const variables: DeclaredVariable[] = [];
  const varMap = new Map<string, DeclaredVariable>();

  if (!source || !source.trim()) {
    diagnostics.push({
      code: 'IEC-POU-001',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 §6.6 Program Organization Unit',
      message: 'Structured Text source is empty.',
      fixHint: 'Provide a PROGRAM, FUNCTION_BLOCK, or FUNCTION declaration.',
    });
    return {
      valid: false,
      standard: 'IEC 61131-3:2013 (3rd Ed.)',
      language: 'ST',
      summary: { errors: 1, warnings: 0, info: 0, declaredVariables: 0, cyclomaticComplexity: 1 },
      variables: [],
      diagnostics,
    };
  }

  const commentStats = { openCount: 0, closeCount: 0, cStyleUnclosed: false };
  const cleaned = stripCommentsPreserveLines(source, commentStats);
  if (commentStats.openCount !== commentStats.closeCount || commentStats.cStyleUnclosed) {
    diagnostics.push({
      code: 'IEC-SYN-003',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 Lexical Comments',
      message: commentStats.cStyleUnclosed
        ? 'Unclosed C-style /* ... */ block comment.'
        : `Unbalanced block comment delimiters: ${commentStats.openCount} "(*" vs ${commentStats.closeCount} "*)".`,
      fixHint: 'Ensure every (* comment is closed with *) and every /* with */.',
    });
  }
  const rawLines = cleaned.split(/\r?\n/);
  // Normalize single-line VAR blocks and multi-declaration lines outside string literals
  const numberedLines: { text: string; lineNum: number }[] = [];
  let preVarBlock = false;
  rawLines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const t = rawLine.trim();
    if (/^(?:VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)(?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*\b/i.test(t)) {
      preVarBlock = !/\bEND_VAR\b/i.test(t);
      const { masked, literals } = maskIecStrings(t);
      const expanded = masked
        .replace(/^((?:VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)(?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*)\s+/i, '$1\n')
        .replace(/;\s*(?=\S)/g, ';\n')
        .replace(/\s+(END_VAR)\b/gi, '\n$1');
      for (const part of expanded.split('\n')) {
        const restored = unmaskIecStrings(part, literals).trim();
        if (restored) numberedLines.push({ text: restored, lineNum });
      }
    } else if (preVarBlock && t.includes(';')) {
      if (/\bEND_VAR\b/i.test(t)) preVarBlock = false;
      const { masked, literals } = maskIecStrings(t);
      const expanded = masked.replace(/;\s*(?=\S)/g, ';\n').replace(/\s+(END_VAR)\b/gi, '\n$1');
      for (const part of expanded.split('\n')) {
        const restored = unmaskIecStrings(part, literals).trim();
        if (restored) numberedLines.push({ text: restored, lineNum });
      }
    } else {
      if (/\bEND_VAR\b/i.test(t)) preVarBlock = false;
      numberedLines.push({ text: rawLine, lineNum });
    }
  });
  const lines = rawLines;

  let pouType: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION' | undefined;
  let pouName: string | undefined;
  let expectedEndKeyword: string | undefined;
  let foundPouEnd = false;
  let inVarSection: DeclaredVariable['section'] | null = null;
  let currentVarIsConstant = false;
  let cyclomaticComplexity = 1;

  const bodyLines: { text: string; line: number }[] = [];

  for (const entry of numberedLines) {
    const lineNum = entry.lineNum;
    const trimmed = entry.text.trim();
    if (!trimmed) continue;

    if (!pouType) {
      const headerMatch = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?/i.exec(trimmed);
      if (headerMatch) {
        pouType = headerMatch[1].toUpperCase() as 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION';
        pouName = headerMatch[2];
        expectedEndKeyword = `END_${pouType}`;
        if (pouType === 'FUNCTION' && !headerMatch[3]) {
          diagnostics.push({
            code: 'IEC-POU-002',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 §6.6.1 Function Return Type',
            message: `FUNCTION "${pouName}" must declare an explicit return type (e.g., FUNCTION ${pouName} : REAL).`,
            fixHint: 'Append ": <DATA_TYPE>" to the FUNCTION header.',
          });
        }
        continue;
      }
    }

    if (expectedEndKeyword && new RegExp(`^${expectedEndKeyword}\\b`, 'i').test(trimmed)) {
      foundPouEnd = true;
      continue;
    }

    const varStartMatch = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)(?:\s+(CONSTANT|RETAIN|PERSISTENT))*\s*$/i.exec(trimmed);
    if (varStartMatch) {
      if (inVarSection) {
        diagnostics.push({
          code: 'IEC-VAR-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declarations',
          message: `Nested ${varStartMatch[1].toUpperCase()} opened before closing previous ${inVarSection} with END_VAR.`,
          fixHint: `Add END_VAR before starting ${varStartMatch[1].toUpperCase()}.`,
        });
      }
      inVarSection = varStartMatch[1].toUpperCase() as DeclaredVariable['section'];
      currentVarIsConstant = /\bCONSTANT\b/i.test(trimmed);
      continue;
    }

    if (/^END_VAR\b/i.test(trimmed)) {
      if (!inVarSection) {
        diagnostics.push({
          code: 'IEC-VAR-002',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declarations',
          message: 'Unexpected END_VAR without matching VAR block.',
          fixHint: 'Remove the stray END_VAR or open a VAR declaration block.',
        });
      }
      inVarSection = null;
      currentVarIsConstant = false;
      continue;
    }

    if (inVarSection) {
      // Quote-aware VAR declaration supporting comma-separated names (A, B : INT := 5;), STRING[N], ARRAY[lo..hi] OF TYPE, and string initializers containing `;`
      const { masked: maskedDecl, literals: declLiterals } = maskIecStrings(trimmed);
      const declMatch =
        /^([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+AT\s+(%[A-Za-z0-9_.]+))?\s*:\s*(?:(ARRAY\s*\[\s*-?\d+\s*\.\.\s*-?\d+\s*\]\s*OF\s+))?([A-Za-z_][A-Za-z0-9_]*)(?:\s*[\[(]\s*\d+\s*[\])])?(?:\s*:=\s*([^;]+))?\s*(;)?$/i.exec(
          maskedDecl
        );
      if (!declMatch) {
        diagnostics.push({
          code: 'IEC-VAR-003',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declaration Syntax',
          message: `Malformed variable declaration: "${trimmed}".`,
          fixHint: 'Use syntax "VarName [, Var2] [AT %MW0] : [ARRAY[0..9] OF] TYPE [:= InitialValue];".',
        });
        continue;
      }

      const [, rawNames, directAddr, arrayPrefix, rawType, rawInit, semicolon] = declMatch;
      const names = rawNames.split(',').map((s) => s.trim()).filter(Boolean);
      const dataType = rawType.toUpperCase();
      const initialValue = rawInit ? unmaskIecStrings(rawInit.trim(), declLiterals) : undefined;

      if (!semicolon) {
        diagnostics.push({
          code: 'IEC-SYN-001',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Missing terminating semicolon ";" on declaration of "${names.join(', ')}".`,
          fixHint: 'Append ";" at the end of the declaration.',
        });
      }

      if (!IEC_ELEMENTARY_TYPES.has(dataType) && !IEC_STANDARD_FBS.has(dataType)) {
        diagnostics.push({
          code: 'IEC-TYPE-001',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.indexOf(rawType) + 1,
          rule: 'IEC 61131-3 §6.4 Data Types',
          message: `Unknown IEC 61131-3 data type or standard function block "${rawType}".`,
          fixHint: 'Use an elementary type (BOOL, INT, DINT, REAL, TIME, STRING) or standard FB (TON, TOF, CTU, R_TRIG, PID).',
        });
      }

      if (directAddr) {
        validateDirectAddress(directAddr, lineNum, diagnostics);
      }

      for (const name of names) {
        if (varMap.has(name.toUpperCase())) {
          diagnostics.push({
            code: 'IEC-VAR-004',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 Unique Identifier Scope',
            message: `Duplicate variable declaration "${name}".`,
            fixHint: `Rename or remove duplicate declaration of "${name}".`,
          });
        }
        const declared: DeclaredVariable = {
          name,
          dataType,
          isArray: Boolean(arrayPrefix),
          initialValue,
          section: inVarSection,
          constant: currentVarIsConstant,
          directAddress: directAddr,
          line: lineNum,
        };
        variables.push(declared);
        varMap.set(name.toUpperCase(), declared);
      }
      continue;
    }

    bodyLines.push({ text: trimmed, line: lineNum });
  }

  // Analyze expanded logical body statements
  const statements = expandBodyStatements(bodyLines);
  const blockStack: { kind: string; line: number; hasElse?: boolean; hasUntil?: boolean; whileCondVars?: string[]; mutatedVars?: Set<string> }[] = [];
  const fullBodyUpper = cleaned.toUpperCase();

  for (const stmt of statements) {
    const trimmed = stmt.text;
    const lineNum = stmt.line;

    if (/^EXIT\s*;?$/i.test(trimmed) || /^RETURN\s*;?$/i.test(trimmed)) {
      if (!trimmed.endsWith(';')) {
        diagnostics.push({
          code: 'IEC-SYN-002',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Statement "${trimmed}" missing trailing semicolon ";".`,
          fixHint: `Terminate "${trimmed}" with ";".`,
        });
      }
      continue;
    }

    // Control structures
    if (/^IF\b/i.test(trimmed)) {
      blockStack.push({ kind: 'IF', line: lineNum });
      cyclomaticComplexity++;
      if (!/\bTHEN$/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-CTRL-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §7.3.3.3.2 IF Statement',
          message: 'IF statement missing THEN keyword.',
          fixHint: 'Add THEN after the IF boolean condition.',
        });
      }
      const cond = trimmed.replace(/^IF\s*/i, '').replace(/\bTHEN$/i, '').trim();
      checkExpressionIdentifiers(cond, lineNum, varMap, pouName, diagnostics);
    } else if (/^ELSIF\b/i.test(trimmed)) {
      cyclomaticComplexity++;
      if (blockStack.at(-1)?.kind !== 'IF') {
        diagnostics.push({
          code: 'IEC-CTRL-002',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §7.3.3.3.2 IF Statement',
          message: 'ELSIF outside of an open IF block.',
          fixHint: 'Ensure ELSIF belongs to a preceding IF ... THEN block.',
        });
      } else if (!/\bTHEN$/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-CTRL-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §7.3.3.3.2 IF Statement',
          message: 'ELSIF statement missing THEN keyword.',
          fixHint: 'Add THEN after the ELSIF boolean condition.',
        });
      }
      const cond = trimmed.replace(/^ELSIF\s*/i, '').replace(/\bTHEN$/i, '').trim();
      checkExpressionIdentifiers(cond, lineNum, varMap, pouName, diagnostics);
    } else if (/^ELSE\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top && (top.kind === 'IF' || top.kind === 'CASE')) {
        if (top.hasElse) {
          diagnostics.push({
            code: 'IEC-CTRL-009',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 Control Flow Integrity',
            message: `Duplicate ELSE branch inside ${top.kind} block.`,
            fixHint: `Each ${top.kind} block may have at most one ELSE branch.`,
          });
        }
        top.hasElse = true;
      } else {
        diagnostics.push({
          code: 'IEC-CTRL-009',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Control Flow Integrity',
          message: 'ELSE outside of an IF or CASE block.',
          fixHint: 'Place ELSE inside an IF ... THEN or CASE ... OF block.',
        });
      }
    } else if (/^END_IF\b/i.test(trimmed)) {
      if (blockStack.at(-1)?.kind !== 'IF') {
        diagnostics.push({
          code: 'IEC-CTRL-003',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Block Matching',
          message: 'Unexpected END_IF without matching IF.',
          fixHint: 'Remove unmatched END_IF or check inner control blocks.',
        });
      } else {
        blockStack.pop();
      }
    } else if (/^CASE\b/i.test(trimmed)) {
      blockStack.push({ kind: 'CASE', line: lineNum, hasElse: false });
      cyclomaticComplexity++;
      if (!/\bOF$/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-CTRL-004',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 CASE Statement',
          message: 'CASE statement missing OF keyword.',
          fixHint: 'Use syntax "CASE <selector> OF".',
        });
      }
      const selector = trimmed.replace(/^CASE\s+/i, '').replace(/\s+OF$/i, '');
      checkExpressionIdentifiers(selector, lineNum, varMap, pouName, diagnostics);
    } else if (/^END_CASE\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top?.kind !== 'CASE') {
        diagnostics.push({
          code: 'IEC-CTRL-004',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Block Matching',
          message: 'Unexpected END_CASE without matching CASE.',
          fixHint: 'Match every CASE ... OF with END_CASE;.',
        });
      } else {
        if (!top.hasElse) {
          diagnostics.push({
            code: 'IEC-SAFE-008',
            severity: 'WARNING',
            line: top.line,
            column: 1,
            rule: 'Defensive Industrial FSM Safety',
            message: `CASE block at line ${top.line} has no ELSE default fault handler.`,
            fixHint: 'Add an ELSE branch to safely handle unexpected state values.',
          });
        }
        blockStack.pop();
      }
    } else if (/^FOR\b/i.test(trimmed)) {
      blockStack.push({ kind: 'FOR', line: lineNum });
      cyclomaticComplexity++;
      const fm = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(trimmed);
      if (!fm) {
        diagnostics.push({
          code: 'IEC-CTRL-010',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 FOR Loop Syntax',
          message: `Malformed FOR header: "${trimmed}".`,
          fixHint: 'Use syntax "FOR i := 0 TO 10 BY 1 DO".',
        });
      } else {
        checkExpressionIdentifiers(`${fm[1]} ${fm[2]} ${fm[3]} ${fm[4] ?? ''}`, lineNum, varMap, pouName, diagnostics);
      }
    } else if (/^END_FOR\b/i.test(trimmed)) {
      if (blockStack.at(-1)?.kind !== 'FOR') {
        diagnostics.push({
          code: 'IEC-CTRL-005',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Block Matching',
          message: 'Unexpected END_FOR without matching FOR.',
          fixHint: 'Match every FOR ... DO with END_FOR;.',
        });
      } else {
        blockStack.pop();
      }
    } else if (/^WHILE\b/i.test(trimmed)) {
      if (!/\bDO$/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-CTRL-006',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 WHILE Statement',
          message: 'WHILE statement missing DO keyword.',
          fixHint: 'Use syntax "WHILE <cond> DO".',
        });
      }
      const cond = trimmed.replace(/^WHILE\s+/i, '').replace(/\s+DO$/i, '');
      const condVars = [...stripLiteralsForIdentScan(cond).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)]
        .map((m) => m[1].toUpperCase())
        .filter((u) => !IEC_KEYWORDS.has(u));
      blockStack.push({ kind: 'WHILE', line: lineNum, whileCondVars: condVars, mutatedVars: new Set() });
      cyclomaticComplexity++;
      checkExpressionIdentifiers(cond, lineNum, varMap, pouName, diagnostics);
      if (/^WHILE\s+(TRUE|1\s*=\s*1)\b/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-SAFE-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'PLC Watchdog Safety (IEC 61131-3 Scan-Cycle Determinism)',
          message: 'Unbounded "WHILE TRUE" loop detected. Unbounded loops trigger PLC scan-cycle watchdog faults.',
          fixHint: 'Use bounded FOR loops or cyclic state machines executed once per PLC scan cycle.',
        });
      }
    } else if (/^END_WHILE\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top?.kind !== 'WHILE') {
        diagnostics.push({
          code: 'IEC-CTRL-006',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Block Matching',
          message: 'Unexpected END_WHILE without matching WHILE.',
          fixHint: 'Match every WHILE ... DO with END_WHILE;.',
        });
      } else {
        if (top.whileCondVars && top.whileCondVars.length > 0 && top.mutatedVars) {
          const anyMutated = top.whileCondVars.some((v) => top.mutatedVars!.has(v));
          if (!anyMutated) {
            diagnostics.push({
              code: 'IEC-SAFE-001',
              severity: 'ERROR',
              line: top.line,
              column: 1,
              rule: 'PLC Watchdog Safety (Loop Termination)',
              message: `WHILE loop at line ${top.line} never mutates its condition variable(s) [${top.whileCondVars.join(', ')}] inside the loop body.`,
              fixHint: 'Mutate the loop counter inside the loop or replace with a bounded FOR loop.',
            });
          }
        }
        blockStack.pop();
      }
    } else if (/^REPEAT\b/i.test(trimmed)) {
      blockStack.push({ kind: 'REPEAT', line: lineNum, hasUntil: false });
      cyclomaticComplexity++;
    } else if (/^UNTIL\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top?.kind !== 'REPEAT') {
        diagnostics.push({
          code: 'IEC-CTRL-007',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 REPEAT/UNTIL Matching',
          message: 'UNTIL outside of a REPEAT block.',
          fixHint: 'Use REPEAT ... UNTIL <cond>; END_REPEAT;.',
        });
      } else {
        top.hasUntil = true;
      }
      const untilCond = trimmed.replace(/^UNTIL\s+/i, '').replace(/;$/, '').trim();
      checkExpressionIdentifiers(untilCond, lineNum, varMap, pouName, diagnostics);
      if (/^UNTIL\s+FALSE\b/i.test(trimmed)) {
        diagnostics.push({
          code: 'IEC-SAFE-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'PLC Watchdog Safety (Infinite REPEAT Loop)',
          message: 'REPEAT ... UNTIL FALSE creates an infinite loop and triggers PLC watchdog fault.',
          fixHint: 'Provide a guaranteed terminating boolean exit condition.',
        });
      }
    } else if (/^END_REPEAT\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top?.kind !== 'REPEAT') {
        diagnostics.push({
          code: 'IEC-CTRL-007',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Block Matching',
          message: 'Unexpected END_REPEAT without matching REPEAT.',
          fixHint: 'Match every REPEAT ... UNTIL with END_REPEAT;.',
        });
      } else {
        if (!top.hasUntil) {
          diagnostics.push({
            code: 'IEC-CTRL-007',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 REPEAT/UNTIL Matching',
            message: `REPEAT block at line ${top.line} is missing UNTIL condition before END_REPEAT.`,
            fixHint: 'Add UNTIL <condition>; before END_REPEAT;.',
          });
        }
        blockStack.pop();
      }
    }

    const { masked: maskedTrimmed } = maskIecStrings(trimmed);

    // Division / Modulo safety on string-masked text: literal zero (ERROR) + unguarded variable divisor (WARNING)
    if (/\/\s*0(?:\.0+)?(?:\s|;|\)|$)/.test(maskedTrimmed) || /\bMOD\s+0(?:\.0+)?(?:\s|;|\)|$)/i.test(maskedTrimmed)) {
      diagnostics.push({
        code: 'IEC-SAFE-002',
        severity: 'ERROR',
        line: lineNum,
        column: Math.max(1, maskedTrimmed.indexOf('/') + 1),
        rule: 'PLC Runtime Fault Prevention (Division / Modulo by Zero)',
        message: 'Literal division or MOD by zero will raise a PLC arithmetic exception at runtime.',
        fixHint: 'Guard divisors with an explicit non-zero check before dividing or taking MOD.',
      });
    } else {
      const varDivMatch = /\/\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(maskedTrimmed);
      if (varDivMatch) {
        const divName = varDivMatch[1].toUpperCase();
        const guarded =
          fullBodyUpper.includes(`${divName} <> 0`) ||
          fullBodyUpper.includes(`${divName} > 0`) ||
          fullBodyUpper.includes(`ABS(${divName}) >`);
        if (!guarded && varMap.has(divName)) {
          diagnostics.push({
            code: 'IEC-SAFE-007',
            severity: 'WARNING',
            line: lineNum,
            column: varDivMatch.index + 1,
            rule: 'PLC Runtime Fault Prevention (Unguarded Variable Divisor)',
            message: `Division by variable "${varDivMatch[1]}" without visible non-zero guard.`,
            fixHint: `Wrap division in "IF ${varDivMatch[1]} <> 0.0 THEN ... END_IF;".`,
          });
        }
      }
    }

    // Float exact equality check (either LHS or RHS can be a float variable)
    const eqMatch = /\b([A-Za-z0-9_.]+)\s*(=|<>)\s*([A-Za-z0-9_.]+)/g;
    let eqHit: RegExpExecArray | null;
    while ((eqHit = eqMatch.exec(maskedTrimmed)) !== null) {
      const before = maskedTrimmed.slice(0, eqHit.index + eqHit[1].length + 1);
      if (maskedTrimmed.slice(eqHit.index, eqHit.index + eqHit[0].length + 1).includes(':=')) continue;
      if (before.endsWith(':')) continue;
      const lhsVar = varMap.get(eqHit[1].toUpperCase());
      const rhsVar = varMap.get(eqHit[3].toUpperCase());
      if ((lhsVar && FLOAT_TYPES.has(lhsVar.dataType)) || (rhsVar && FLOAT_TYPES.has(rhsVar.dataType))) {
        diagnostics.push({
          code: 'IEC-SAFE-003',
          severity: 'WARNING',
          line: lineNum,
          column: eqHit.index + 1,
          rule: 'IEEE 754 Floating-Point Control Safety',
          message: `Exact equality/inequality "${eqHit[2]}" on REAL/LREAL comparison "${eqHit[1]} ${eqHit[2]} ${eqHit[3]}" can fail due to floating-point rounding.`,
          fixHint: `Use tolerance comparison: ABS(${eqHit[1]} - ${eqHit[3]}) < 0.001.`,
        });
      }
    }

    // Assignment validation (supports array element lhs like Arr[0] := 1;)
    const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?|%[IQM][XBWDL]?\d+(?:\.\d+)?)\s*:=\s*(.+?)(;)?$/i.exec(trimmed);
    if (assignMatch && !/^(IF|ELSIF|WHILE|FOR)\b/i.test(trimmed)) {
      const [, rawLhs, rhs, semi] = assignMatch;
      const lhsBase = rawLhs.replace(/\[[^\]]+\]/, '');

      // Record mutated var for enclosing WHILE loops
      for (const blk of blockStack) {
        if (blk.kind === 'WHILE' && blk.mutatedVars) blk.mutatedVars.add(lhsBase.toUpperCase());
      }

      if (!semi) {
        diagnostics.push({
          code: 'IEC-SYN-002',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Assignment to "${rawLhs}" is missing trailing semicolon ";".`,
          fixHint: 'Terminate every ST assignment with ";".',
        });
      }

      if (lhsBase.startsWith('%')) {
        validateDirectAddress(lhsBase, lineNum, diagnostics);
        if (/^%I/i.test(lhsBase)) {
          diagnostics.push({
            code: 'IEC-SAFE-004',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'Hardware Input Immutability',
            message: `Cannot write to physical input address "${lhsBase}".`,
            fixHint: 'Write to an output (%Q...) or internal memory (%M...) address instead.',
          });
        }
      } else {
        const lhsVar = varMap.get(lhsBase.toUpperCase());
        if (!lhsVar && !(pouType === 'FUNCTION' && pouName && lhsBase.toUpperCase() === pouName.toUpperCase())) {
          diagnostics.push({
            code: 'IEC-VAR-005',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 Strict Variable Resolution',
            message: `Assignment target "${lhsBase}" is not declared in any VAR block.`,
            fixHint: `Declare "${lhsBase}" in VAR, VAR_OUTPUT, or VAR_GLOBAL.`,
          });
        } else if (lhsVar) {
          if (lhsVar.section === 'VAR_INPUT') {
            diagnostics.push({
              code: 'IEC-SAFE-005',
              severity: 'ERROR',
              line: lineNum,
              column: 1,
              rule: 'IEC 61131-3 §6.6.2 VAR_INPUT Immutability',
              message: `Cannot assign to VAR_INPUT "${lhsBase}" inside POU body.`,
              fixHint: `Move "${lhsBase}" to VAR_IN_OUT or assign to a VAR_OUTPUT / local VAR.`,
            });
          }
          if (lhsVar.constant) {
            diagnostics.push({
              code: 'IEC-SAFE-006',
              severity: 'ERROR',
              line: lineNum,
              column: 1,
              rule: 'IEC 61131-3 CONSTANT Immutability',
              message: `Cannot assign to CONSTANT variable "${lhsBase}".`,
              fixHint: 'Remove CONSTANT qualifier or assign to a mutable variable.',
            });
          }
          if (lhsVar.directAddress && /^%I/i.test(lhsVar.directAddress)) {
            diagnostics.push({
              code: 'IEC-SAFE-004',
              severity: 'ERROR',
              line: lineNum,
              column: 1,
              rule: 'Hardware Input Immutability',
              message: `Variable "${lhsBase}" is bound to read-only hardware input "${lhsVar.directAddress}".`,
              fixHint: 'Bind writable outputs to %QX / %QW or internal %MW memory.',
            });
          }

          const rhsSingle = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(rhs.trim());
          if (rhsSingle) {
            const rhsVar = varMap.get(rhsSingle[1].toUpperCase());
            if (rhsVar) {
              const lhsBits = BIT_WIDTH[lhsVar.dataType];
              const rhsBits = BIT_WIDTH[rhsVar.dataType];
              const floatToInt = FLOAT_TYPES.has(rhsVar.dataType) && !FLOAT_TYPES.has(lhsVar.dataType);
              if (floatToInt || (lhsBits && rhsBits && rhsBits > lhsBits)) {
                diagnostics.push({
                  code: 'IEC-TYPE-002',
                  severity: 'ERROR',
                  line: lineNum,
                  column: 1,
                  rule: 'IEC 61131-3 Strong Typing (No Implicit Narrowing)',
                  message: `Implicit narrowing conversion from ${rhsVar.dataType} ("${rhsVar.name}") to ${lhsVar.dataType} ("${lhsVar.name}").`,
                  fixHint: `Use explicit conversion function ${rhsVar.dataType}_TO_${lhsVar.dataType}(${rhsVar.name}).`,
                });
              }
            }
          }
        }
      }

      const idxMatch = /\[([^\]]+)\]/.exec(rawLhs);
      if (idxMatch) {
        checkExpressionIdentifiers(idxMatch[1], lineNum, varMap, pouName, diagnostics);
      }
      checkExpressionIdentifiers(rhs, lineNum, varMap, pouName, diagnostics);
    } else if (/^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*;?$/.test(trimmed) && !/^(IF|ELSIF|WHILE|CASE|FOR)\b/i.test(trimmed)) {
      const fbCallMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*;?$/.exec(trimmed)!;
      const fbName = fbCallMatch[1];
      const args = fbCallMatch[2];
      if (!trimmed.endsWith(';')) {
        diagnostics.push({
          code: 'IEC-SYN-002',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Function block call "${fbName}(...)" is missing trailing semicolon ";".`,
          fixHint: 'Terminate every ST call with ";".',
        });
      }
      const fbVar = varMap.get(fbName.toUpperCase());
      if (!fbVar) {
        diagnostics.push({
          code: 'IEC-FB-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 Function Block Instantiation',
          message: `Function block instance "${fbName}" is called without being declared in VAR.`,
          fixHint: `Declare "${fbName} : TON;" (or appropriate FB type) inside VAR ... END_VAR.`,
        });
      } else {
        for (const part of splitTopLevelArgs(args)) {
          const pm = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=>)\s*(.+)$/.exec(part.trim());
          checkExpressionIdentifiers(pm ? pm[2] : part, lineNum, varMap, pouName, diagnostics);
        }
        if (fbVar.dataType === 'TON' || fbVar.dataType === 'TOF' || fbVar.dataType === 'TP') {
          if (!/\bPT\s*:=/i.test(args) || !/\bIN\s*:=/i.test(args)) {
            diagnostics.push({
              code: 'IEC-FB-002',
              severity: 'WARNING',
              line: lineNum,
              column: 1,
              rule: 'IEC 61131-3 Standard Timer Contract',
              message: `Timer FB "${fbName}" (${fbVar.dataType}) should explicitly bind both IN and PT parameters.`,
              fixHint: `Call as ${fbName}(IN := <BOOL>, PT := T#5s);.`,
            });
          }
        }
      }
    } else if (
      !/^(IF|ELSIF|ELSE|END_IF|CASE|END_CASE|FOR|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT)\b/i.test(trimmed) &&
      !/^(-?\d+(?:\s*\.\.\s*-?\d+)?(?:\s*,\s*-?\d+(?:\s*\.\.\s*-?\d+)?)*)\s*:$/i.test(trimmed)
    ) {
      diagnostics.push({
        code: 'IEC-SYN-001',
        severity: 'ERROR',
        line: lineNum,
        column: 1,
        rule: 'IEC 61131-3 Structured Text Statement Syntax',
        message: `Unrecognized or malformed ST statement: "${trimmed}".`,
        fixHint: 'Use ":=" for assignment (not "="), and ensure valid ST statement syntax.',
      });
    }
  }

  if (!pouType) {
    diagnostics.push({
      code: 'IEC-POU-001',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 §6.6 Program Organization Unit',
      message: 'Missing POU declaration header (PROGRAM, FUNCTION_BLOCK, or FUNCTION).',
      fixHint: 'Wrap logic in PROGRAM Main ... END_PROGRAM or FUNCTION_BLOCK <Name> ... END_FUNCTION_BLOCK.',
    });
  } else if (!foundPouEnd) {
    diagnostics.push({
      code: 'IEC-POU-003',
      severity: 'ERROR',
      line: lines.length,
      column: 1,
      rule: 'IEC 61131-3 §6.6 Program Organization Unit',
      message: `Missing closing "${expectedEndKeyword}" statement.`,
      fixHint: `Add "${expectedEndKeyword}" at the end of the POU.`,
    });
  }

  if (inVarSection) {
    diagnostics.push({
      code: 'IEC-VAR-007',
      severity: 'ERROR',
      line: lines.length,
      column: 1,
      rule: 'IEC 61131-3 §6.5.2 Variable Declarations',
      message: `Unclosed "${inVarSection}" block missing END_VAR.`,
      fixHint: 'Close the variable section with END_VAR.',
    });
  }

  for (const unclosed of blockStack) {
    diagnostics.push({
      code: 'IEC-CTRL-008',
      severity: 'ERROR',
      line: unclosed.line,
      column: 1,
      rule: 'IEC 61131-3 Control Flow Integrity',
      message: `Unclosed ${unclosed.kind} block opened at line ${unclosed.line}.`,
      fixHint: `Add matching END_${unclosed.kind};.`,
    });
  }

  const errors = diagnostics.filter((d) => d.severity === 'ERROR').length;
  const warnings = diagnostics.filter((d) => d.severity === 'WARNING').length;
  const info = diagnostics.filter((d) => d.severity === 'INFO').length;

  return {
    valid: errors === 0,
    standard: 'IEC 61131-3:2013 (3rd Ed.)',
    language: 'ST',
    pouType,
    pouName,
    summary: {
      errors,
      warnings,
      info,
      declaredVariables: variables.length,
      cyclomaticComplexity,
    },
    variables,
    diagnostics,
  };
}

export interface LadderRung {
  rungId: string;
  contacts: { type: 'NO' | 'NC' | 'P_TRIG' | 'N_TRIG'; tag: string }[];
  coil: { type: 'OUT' | 'SET' | 'RESET'; tag: string };
}

export function validateLadderGraph(pouName: string, rungsJson: string): Iec61131ValidationResult {
  const diagnostics: Iec61131Diagnostic[] = [];
  let rungs: LadderRung[] = [];
  try {
    const parsed = JSON.parse(rungsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Ladder source must be a non-empty JSON array of rungs.');
    }
    rungs = parsed;
  } catch (err) {
    diagnostics.push({
      code: 'IEC-LD-001',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 Ladder Graph Schema',
      message: err instanceof Error ? err.message : 'Invalid Ladder JSON.',
      fixHint: 'Provide JSON array: [{"rungId":"R1","contacts":[{"type":"NO","tag":"Start_X0"}],"coil":{"type":"OUT","tag":"Motor_Y0"}}].',
    });
  }

  const validContactTypes = new Set(['NO', 'NC', 'P_TRIG', 'N_TRIG']);
  const validCoilTypes = new Set(['OUT', 'SET', 'RESET']);
  const seenRungIds = new Set<string>();
  const writtenCoils = new Map<string, string>();

  rungs.forEach((rung, idx) => {
    const line = idx + 1;
    const rid = rung?.rungId ?? `R${line}`;
    if (seenRungIds.has(rid)) {
      diagnostics.push({
        code: 'IEC-LD-004',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 LD Unique Rung IDs',
        message: `Duplicate rungId "${rid}".`,
        fixHint: 'Assign a unique rungId to every ladder rung.',
      });
    }
    seenRungIds.add(rid);

    if (!Array.isArray(rung?.contacts) || rung.contacts.length === 0) {
      diagnostics.push({
        code: 'IEC-LD-005',
        severity: 'WARNING',
        line,
        column: 1,
        rule: 'IEC 61131-3 LD Unconditional Energize',
        message: `Rung "${rid}" has no input contacts (unconditionally energized coil).`,
        fixHint: 'Add at least one safety or interlock contact (e.g., EStop_OK).',
      });
    } else {
      for (const c of rung.contacts) {
        if (!validContactTypes.has(c?.type) || !c?.tag) {
          diagnostics.push({
            code: 'IEC-LD-006',
            severity: 'ERROR',
            line,
            column: 1,
            rule: 'IEC 61131-3 LD Contact Schema',
            message: `Invalid contact in rung "${rid}": type="${c?.type}", tag="${c?.tag}".`,
            fixHint: 'Use contact type NO | NC | P_TRIG | N_TRIG and a non-empty tag.',
          });
        }
      }
    }

    if (!rung?.coil?.tag || !validCoilTypes.has(rung.coil.type)) {
      diagnostics.push({
        code: 'IEC-LD-002',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 LD Rung Output',
        message: `Rung "${rid}" has missing or invalid output coil.`,
        fixHint: 'Assign coil type OUT | SET | RESET and a target writable tag.',
      });
      return;
    }

    if (/^(?:X|AI)\d+/i.test(rung.coil.tag) || /^%I/i.test(rung.coil.tag)) {
      diagnostics.push({
        code: 'IEC-SAFE-004',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'Hardware Input Immutability',
        message: `Rung "${rid}" attempts to energize read-only physical input "${rung.coil.tag}".`,
        fixHint: 'Target a writable coil (Y, M, S) instead of X/AI/%I.',
      });
    }

    const coilKey = rung.coil.tag.toUpperCase();
    if (rung.coil.type === 'OUT') {
      if (writtenCoils.has(coilKey)) {
        diagnostics.push({
          code: 'IEC-LD-003',
          severity: 'ERROR',
          line,
          column: 1,
          rule: 'Double-Coil Hazard Prevention',
          message: `Double-coil hazard: "${rung.coil.tag}" energized by both rung "${writtenCoils.get(coilKey)}" and "${rid}".`,
          fixHint: 'Combine parallel branch conditions into a single rung or use SET/RESET coils.',
        });
      }
      writtenCoils.set(coilKey, rid);
    } else if ((rung.coil.type === 'SET' || rung.coil.type === 'RESET') && writtenCoils.has(coilKey)) {
      diagnostics.push({
        code: 'IEC-LD-003',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'Double-Coil Hazard Prevention',
        message: `Coil "${rung.coil.tag}" mixes OUT on rung "${writtenCoils.get(coilKey)}" with ${rung.coil.type} on rung "${rid}".`,
        fixHint: 'Use either a single OUT coil or paired SET/RESET coils, not both.',
      });
    }
  });

  const errors = diagnostics.filter((d) => d.severity === 'ERROR').length;
  const warnings = diagnostics.filter((d) => d.severity === 'WARNING').length;
  return {
    valid: errors === 0,
    standard: 'IEC 61131-3:2013 (3rd Ed.)',
    language: 'LD',
    pouType: 'PROGRAM',
    pouName,
    summary: {
      errors,
      warnings,
      info: 0,
      declaredVariables: writtenCoils.size,
      cyclomaticComplexity: Math.max(1, rungs.length),
    },
    variables: [],
    diagnostics,
  };
}

export interface FbdNetworkNode {
  id: string;
  blockType: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

export function validateFbdNetwork(pouName: string, networkJson: string): Iec61131ValidationResult {
  const diagnostics: Iec61131Diagnostic[] = [];
  let nodes: FbdNetworkNode[] = [];
  try {
    const parsed = JSON.parse(networkJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('FBD network must be a non-empty JSON array of blocks.');
    }
    nodes = parsed;
  } catch (err) {
    diagnostics.push({
      code: 'IEC-FBD-001',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 FBD Schema',
      message: err instanceof Error ? err.message : 'Invalid FBD JSON.',
      fixHint: 'Provide JSON array of FBD blocks with id, blockType, inputs, and outputs.',
    });
  }

  const allowedBlocks = new Set([
    ...IEC_STANDARD_FBS,
    'AND', 'OR', 'XOR', 'NOT', 'ADD', 'SUB', 'MUL', 'DIV',
    'GT', 'GE', 'LT', 'LE', 'EQ', 'NE', 'LIMIT', 'SEL', 'MOVE',
  ]);
  const requiredPins: Record<string, string[]> = {
    DIV: ['IN1', 'IN2'],
    TON: ['IN', 'PT'],
    TOF: ['IN', 'PT'],
    TP: ['IN', 'PT'],
    LIMIT: ['MN', 'IN', 'MX'],
  };

  const seenIds = new Set<string>();
  const signalProducers = new Map<string, string[]>();
  const graph = new Map<string, string[]>();

  nodes.forEach((node, idx) => {
    const line = idx + 1;
    if (!node?.id || typeof node.id !== 'string' || seenIds.has(node.id)) {
      diagnostics.push({
        code: 'IEC-FBD-002',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 FBD Unique Node IDs',
        message: `Missing or duplicate FBD block id "${String(node?.id)}".`,
        fixHint: 'Give every FBD block a unique non-empty identifier.',
      });
      return;
    }
    seenIds.add(node.id);
    graph.set(node.id, []);

    const bType = typeof node.blockType === 'string' ? node.blockType.toUpperCase() : '';
    if (!bType || !allowedBlocks.has(bType)) {
      diagnostics.push({
        code: 'IEC-FBD-003',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 Standard FBD Library',
        message: `Unsupported FBD block type "${String(node.blockType)}".`,
        fixHint: 'Use standard IEC 61131-3 blocks (AND, OR, NOT, ADD, SUB, MUL, DIV, LIMIT, TON, TOF, CTU, PID, etc.).',
      });
    }

    const req = requiredPins[bType];
    if (req) {
      const provided = new Set(Object.keys(node.inputs ?? {}).map((k) => k.toUpperCase()));
      for (const pin of req) {
        if (!provided.has(pin)) {
          diagnostics.push({
            code: 'IEC-FBD-004',
            severity: 'ERROR',
            line,
            column: 1,
            rule: 'IEC 61131-3 FBD Required Pin Contract',
            message: `FBD block "${node.id}" (${bType}) missing required input pin "${pin}".`,
            fixHint: `Bind pin "${pin}" in inputs object.`,
          });
        }
      }
    }

    if (bType === 'DIV') {
      const inVals = Object.entries(node.inputs ?? {});
      const divInput = inVals.find(([k]) => k.toUpperCase() === 'IN2')?.[1] ?? inVals[1]?.[1];
      if (typeof divInput === 'string' && /^0(?:\.0+)?$/.test(divInput.trim())) {
        diagnostics.push({
          code: 'IEC-SAFE-002',
          severity: 'ERROR',
          line,
          column: 1,
          rule: 'PLC Runtime Fault Prevention (Division by Zero)',
          message: `FBD DIV block "${node.id}" has literal zero divisor "${divInput}".`,
          fixHint: 'Ensure DIV IN2 is non-zero.',
        });
      }
    }

    for (const outSig of Object.values(node.outputs ?? {})) {
      if (/^(?:X|AI)\d+/i.test(outSig) || /^%I/i.test(outSig)) {
        diagnostics.push({
          code: 'IEC-SAFE-004',
          severity: 'ERROR',
          line,
          column: 1,
          rule: 'Hardware Input Immutability',
          message: `FBD block "${node.id}" writes to read-only hardware input "${outSig}".`,
          fixHint: 'Connect FBD output to writable register/coil instead of %I/X/AI.',
        });
      }
      const list = signalProducers.get(outSig) ?? [];
      if (list.length > 0) {
        diagnostics.push({
          code: 'IEC-FBD-002',
          severity: 'ERROR',
          line,
          column: 1,
          rule: 'IEC 61131-3 FBD Single-Driver Output',
          message: `FBD signal "${outSig}" is driven by multiple blocks (${list.join(', ')}, ${node.id}).`,
          fixHint: 'Assign a unique output signal name per FBD block.',
        });
      }
      list.push(node.id);
      signalProducers.set(outSig, list);
    }
  });

  // Build dependency edges and detect combinational cycles (algebraic loops)
  for (const node of nodes) {
    if (!node?.id) continue;
    for (const inSig of Object.values(node.inputs ?? {})) {
      const producers = signalProducers.get(inSig) ?? [];
      for (const producer of producers) {
        graph.get(producer)?.push(node.id);
      }
    }
  }

  const visitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const activeStack: string[] = [];
  const reportedCycleMembers = new Set<string>();
  const detectCycles = (u: string) => {
    visitState.set(u, 1);
    activeStack.push(u);
    for (const v of graph.get(u) ?? []) {
      const st = visitState.get(v) ?? 0;
      if (st === 1) {
        const cycleStart = activeStack.indexOf(v);
        const cycleNodes = cycleStart >= 0 ? activeStack.slice(cycleStart) : [v];
        const key = [...cycleNodes].sort().join(',');
        if (!reportedCycleMembers.has(key)) {
          reportedCycleMembers.add(key);
          diagnostics.push({
            code: 'IEC-FBD-005',
            severity: 'ERROR',
            line: 1,
            column: 1,
            rule: 'IEC 61131-3 FBD Algebraic Loop Prevention',
            message: `Combinational feedback cycle detected involving blocks: ${cycleNodes.join(' -> ')} -> ${v}.`,
            fixHint: 'Break feedback loops with a state register or one-scan delay block.',
          });
        }
      } else if (st === 0) {
        detectCycles(v);
      }
    }
    activeStack.pop();
    visitState.set(u, 2);
  };

  for (const id of graph.keys()) {
    if ((visitState.get(id) ?? 0) === 0) detectCycles(id);
  }

  const errors = diagnostics.filter((d) => d.severity === 'ERROR').length;
  return {
    valid: errors === 0,
    standard: 'IEC 61131-3:2013 (3rd Ed.)',
    language: 'FBD',
    pouType: 'PROGRAM',
    pouName,
    summary: {
      errors,
      warnings: 0,
      info: 0,
      declaredVariables: nodes.length,
      cyclomaticComplexity: Math.max(1, nodes.length),
    },
    variables: [],
    diagnostics,
  };
}

/**
 * Transpiles a validated IEC 61131-3 Structured Text POU into a deterministic,
 * watchdog-safe Haiwell Cloud SCADA JavaScript cyclic script.
 */
const JS_RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new', 'return',
  'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'class', 'const', 'enum', 'export', 'extends', 'import', 'super', 'implements',
  'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield',
]);

function translateIecStringLiteral(rawLit: string): string {
  const quote = rawLit[0];
  const inner = rawLit.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '$' && i + 1 < inner.length) {
      const n = inner[i + 1];
      const upper = n.toUpperCase();
      if (upper === '$') out += '$';
      else if (upper === 'N') out += '\n';
      else if (upper === 'R') out += '\r';
      else if (upper === 'T') out += '\t';
      else if (upper === 'L') out += '\n';
      else if (n === "'" || n === '"') out += n;
      else out += '$' + n;
      i++;
    } else {
      out += ch;
    }
  }
  if (quote === "'") {
    const escaped = out
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `'${escaped}'`;
  }
  return JSON.stringify(out);
}

function splitTopLevelBinaryOp(expr: string, opRegex: RegExp): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let lastIdx = 0;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      opRegex.lastIndex = i;
      const m = opRegex.exec(expr);
      if (m && m.index === i) {
        parts.push(expr.slice(lastIdx, i));
        i += m[0].length;
        lastIdx = i;
        continue;
      }
    }
    i++;
  }
  if (parts.length === 0) return null;
  parts.push(expr.slice(lastIdx));
  return parts;
}

function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function convertXorAndPrecedence(maskedExpr: string): string {
  const s = maskedExpr.trim();
  if (!/\bXOR\b/i.test(s)) return s;

  const orParts = splitTopLevelBinaryOp(s, /\bOR\b/gi);
  if (orParts) {
    return orParts.map((p) => convertXorAndPrecedence(p)).join(' || ');
  }
  const xorParts = splitTopLevelBinaryOp(s, /\bXOR\b/gi);
  if (xorParts) {
    return xorParts
      .map((p) => `Boolean(${convertXorAndPrecedence(p)})`)
      .reduce((acc, cur) => `(${acc} !== ${cur})`);
  }
  const andParts = splitTopLevelBinaryOp(s, /\bAND\b/gi);
  if (andParts) {
    return andParts.map((p) => convertXorAndPrecedence(p)).join(' && ');
  }
  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = stripOuterParens(s);
    if (inner !== s) return `(${convertXorAndPrecedence(inner)})`;
  }
  return s;
}

export function transpileStToHaiwellJs(
  source: string,
  tagBindings: Record<string, string> = {},
  options?: { apiStyle?: 'TAG_API' | 'HAIWELL_NATIVE_350'; cyclicIntervalMs?: number }
): { success: boolean; jsCode?: string; validation: Iec61131ValidationResult } {
  const validation = validateStructuredText(source);
  if (!validation.valid) {
    return { success: false, validation };
  }

  const apiStyle = options?.apiStyle ?? 'HAIWELL_NATIVE_350';
  const defaultScanMs = Math.max(10, options?.cyclicIntervalMs ?? 1000);
  const cleaned = stripCommentsPreserveLines(source);
  const rawLines = cleaned.split(/\r?\n/);

  const identResolveMap = new Map<string, string>();
  const fbVarTypes = new Map<string, string>();
  const bitwiseVars = new Set<string>();
  const jsIdentFor = (name: string): string =>
    JS_RESERVED_WORDS.has(name.toLowerCase()) ? `__st_${name}` : name;

  for (const v of validation.variables) {
    const jsName = jsIdentFor(v.name);
    identResolveMap.set(v.name.toUpperCase(), jsName);
    if (IEC_STANDARD_FBS.has(v.dataType)) {
      fbVarTypes.set(v.name.toUpperCase(), v.dataType);
    }
    if (['BYTE', 'WORD', 'DWORD', 'LWORD'].includes(v.dataType)) {
      bitwiseVars.add(v.name.toUpperCase());
    }
  }
  const hasStandardFbs = fbVarTypes.size > 0;
  const hasStatefulVars = validation.variables.some((v) => v.section === 'VAR' || v.section === 'VAR_OUTPUT');

  const jsLines: string[] = [
    `// Transpiled from IEC 61131-3 ST POU: ${validation.pouName ?? 'Unnamed'}`,
    `// Standard: ${validation.standard} | Target JS: Strict ES5 (Haiwell HMI Node v0.10.41 safe)`,
    `function __LIMIT(mn, v, mx) { return Math.max(mn, Math.min(mx, v)); }`,
    `function __SEL(g, a, b) { return g ? b : a; }`,
    `function __TRUNC(x) { return x < 0 ? Math.ceil(x) : Math.floor(x); }`,
    `function __MUX(k) { var idx = Math.floor(Number(k)) + 1; return idx >= 1 && idx < arguments.length ? arguments[idx] : arguments[1]; }`,
  ];

  if (hasStandardFbs || hasStatefulVars) {
    jsLines.push(
      `var __g = (typeof globalThis !== "undefined") ? globalThis : this;`,
      `var __fbStore = (typeof __fbState !== "undefined" && __fbState) ? __fbState : (__g.__haiwellFbStore = __g.__haiwellFbStore || {});`,
      `var __scanMs = (typeof __SCAN_MS === "number" && __SCAN_MS > 0) ? __SCAN_MS : ${defaultScanMs};`,
      `function __getFb(k, def) { if (!__fbStore[k]) __fbStore[k] = def; return __fbStore[k]; }`
    );
  }
  if (hasStandardFbs) {
    jsLines.push(
      `function __FB_TON(k, args) { var s = __getFb(k, { Q: false, ET: 0 }); var pt = Number(args.PT || 0); if (args.IN) { s.ET = Math.min(pt, s.ET + __scanMs); s.Q = s.ET >= pt; } else { s.ET = 0; s.Q = false; } return s; }`,
      `function __FB_TOF(k, args) { var s = __getFb(k, { Q: false, ET: 0 }); var pt = Number(args.PT || 0); if (args.IN) { s.Q = true; s.ET = 0; } else if (s.Q) { s.ET = Math.min(pt, s.ET + __scanMs); if (s.ET >= pt) s.Q = false; } return s; }`,
      `function __FB_TP(k, args) { var s = __getFb(k, { Q: false, ET: 0 }); var pt = Number(args.PT || 0); if (args.IN && !s.Q && s.ET === 0) { if (pt > 0) { s.Q = true; s.ET = Math.min(pt, __scanMs); if (s.ET >= pt) s.Q = false; } } else if (s.Q) { s.ET = Math.min(pt, s.ET + __scanMs); if (s.ET >= pt) { s.Q = false; } } if (!s.Q && !args.IN) { s.ET = 0; } return s; }`,
      `function __FB_CTU(k, args) { var s = __getFb(k, { Q: false, CV: 0, _prev: false }); var pv = Number(args.PV || 0); if (args.R) { s.CV = 0; } else if (args.CU && !s._prev) { s.CV += 1; } s._prev = Boolean(args.CU); s.Q = s.CV >= pv; return s; }`,
      `function __FB_CTD(k, args) { var s = __getFb(k, { Q: false, CV: 0, _prev: false }); var pv = Number(args.PV || 0); if (args.LD) { s.CV = pv; } else if (args.CD && !s._prev) { s.CV -= 1; } s._prev = Boolean(args.CD); s.Q = s.CV <= 0; return s; }`,
      `function __FB_CTUD(k, args) { var s = __getFb(k, { QU: false, QD: false, CV: 0, _prevU: false, _prevD: false }); var pv = Number(args.PV || 0); if (args.R) { s.CV = 0; } else if (args.LD) { s.CV = pv; } else { if (args.CU && !s._prevU) s.CV += 1; if (args.CD && !s._prevD) s.CV -= 1; } s._prevU = Boolean(args.CU); s._prevD = Boolean(args.CD); s.QU = s.CV >= pv; s.QD = s.CV <= 0; return s; }`,
      `function __FB_R_TRIG(k, args) { var s = __getFb(k, { Q: false, _prev: false }); s.Q = Boolean(args.CLK) && !s._prev; s._prev = Boolean(args.CLK); return s; }`,
      `function __FB_F_TRIG(k, args) { var s = __getFb(k, { Q: false, _prev: false }); s.Q = !Boolean(args.CLK) && s._prev; s._prev = Boolean(args.CLK); return s; }`,
      `function __FB_SR(k, args) { var s = __getFb(k, { Q1: false }); s.Q1 = Boolean(args.S1) || (!Boolean(args.R) && s.Q1); return s; }`,
      `function __FB_RS(k, args) { var s = __getFb(k, { Q1: false }); s.Q1 = !Boolean(args.R1) && (Boolean(args.S) || s.Q1); return s; }`,
      `function __FB_PID(k, args) { var s = __getFb(k, { OUT: 0, _errPrev: 0, _i: 0 }); var sp = Number(args.SP || 0), pv = Number(args.PV || 0), kp = Number(args.KP || 1), ki = Number(args.KI || 0), kd = Number(args.KD || 0); var dt = __scanMs / 1000.0; var err = sp - pv; s._i += err * dt; var d = dt > 0 ? (err - s._errPrev) / dt : 0; s._errPrev = err; s.OUT = kp * err + ki * s._i + kd * d; return s; }`,
      `function __FB_HYSTERESIS(k, args) { var s = __getFb(k, { Q: false }); var x = Number(args.X || args.IN || 0), hi = Number(args.HIGH || args.HI || 0), lo = Number(args.LOW || args.LO || 0); if (x >= hi) s.Q = true; else if (x <= lo) s.Q = false; return s; }`,
      `function __FB_SCALE_LIN(k, args) { var s = __getFb(k, { OUT: 0 }); var x = Number(args.X || args.IN || 0), x0 = Number(args.X0 || 0), x1 = Number(args.X1 || 100), y0 = Number(args.Y0 || 0), y1 = Number(args.Y1 || 100); s.OUT = (x1 === x0) ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); return s; }`
    );
  }

  const resolveExprIdents = (s: string): string =>
    s.replace(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)(?!\s*\()/g, (full, id) => {
      const upper = id.toUpperCase();
      if (IEC_KEYWORDS.has(upper)) return full;
      return identResolveMap.get(upper) ?? full;
    });

  const convertExpr = (expr: string): string => {
    const { masked, literals } = maskIecStrings(expr);
    let converted = masked.replace(/\b(?:TIME|T)#(?:(?:\d+(?:\.\d+)?(?:ms|d|h|m|s)))+/gi, (lit) =>
      String(parseIecTimeLiteralMs(lit))
    );
    // Based literals (16#FF, 2#1010, 8#77) & numeric underscores (1_000)
    converted = converted
      .replace(/\b16#([0-9A-Fa-f_]+)\b/g, (_, hex) => String(Number.parseInt(hex.replace(/_/g, ''), 16)))
      .replace(/\b8#([0-7_]+)\b/g, (_, oct) => String(Number.parseInt(oct.replace(/_/g, ''), 8)))
      .replace(/\b2#([01_]+)\b/g, (_, bin) => String(Number.parseInt(bin.replace(/_/g, ''), 2)))
      .replace(/\b(\d[\d_]*\d)\b/g, (m) => m.replace(/_/g, ''));

    // Bitwise vs Boolean heuristic: if expression references BYTE/WORD/DWORD/LWORD vars, translate AND/OR/XOR to &/|/^
    const isBitwiseExpr = [...converted.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].some((m) =>
      bitwiseVars.has(m[1].toUpperCase())
    );

    converted = convertXorAndPrecedence(converted);
    if (isBitwiseExpr) {
      converted = converted.replace(/\bAND\b/gi, '&').replace(/\bOR\b/gi, '|').replace(/\bNOT\b/gi, '~');
    } else {
      converted = converted.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||').replace(/\bNOT\b/gi, '!');
    }

    converted = converted
      .replace(/([A-Za-z0-9_.)]+)\s*\*\*\s*([A-Za-z0-9_.()+-]+)/g, 'Math.pow($1, $2)')
      .replace(/\bMOD\b/gi, '%')
      .replace(/\bTRUE\b/gi, 'true')
      .replace(/\bFALSE\b/gi, 'false')
      .replace(/<>/g, '!==')
      .replace(/(?<![<>!=:])=(?!=)/g, '===')
      .replace(/\bABS\s*\(/gi, 'Math.abs(')
      .replace(/\bSQRT\s*\(/gi, 'Math.sqrt(')
      .replace(/\bMIN\s*\(/gi, 'Math.min(')
      .replace(/\bMAX\s*\(/gi, 'Math.max(')
      .replace(/\bSIN\s*\(/gi, 'Math.sin(')
      .replace(/\bCOS\s*\(/gi, 'Math.cos(')
      .replace(/\bTAN\s*\(/gi, 'Math.tan(')
      .replace(/\bASIN\s*\(/gi, 'Math.asin(')
      .replace(/\bACOS\s*\(/gi, 'Math.acos(')
      .replace(/\bATAN\s*\(/gi, 'Math.atan(')
      .replace(/\bLN\s*\(/gi, 'Math.log(')
      .replace(/\bLOG\s*\(([^()]+)\)/gi, '(Math.log($1)/Math.LN10)')
      .replace(/\bEXP\s*\(/gi, 'Math.exp(')
      .replace(/\bTRUNC\s*\(/gi, '__TRUNC(')
      .replace(/\bROUND\s*\(/gi, 'Math.round(')
      .replace(/\bLIMIT\s*\(/gi, '__LIMIT(')
      .replace(/\bSEL\s*\(/gi, '__SEL(')
      .replace(/\bMUX\s*\(/gi, '__MUX(')
      .replace(/\b(?:REAL_TO_INT|REAL_TO_DINT|DINT_TO_INT|REAL_TO_UINT)\s*\(/gi, '__TRUNC(')
      .replace(/\b(?:INT_TO_DINT|BOOL_TO_INT|WORD_TO_INT|BYTE_TO_INT|INT_TO_BYTE|INT_TO_WORD|DWORD_TO_DINT|DINT_TO_DWORD|INT_TO_REAL|DINT_TO_REAL|UINT_TO_REAL)\s*\(/gi, 'Number(')
      .replace(/\bINT_TO_STRING\s*\(/gi, 'String(')
      .replace(/\bSTRING_TO_INT\s*\(/gi, 'Number(');

    converted = resolveExprIdents(converted);
    const jsLiterals = literals.map(translateIecStringLiteral);
    return unmaskIecStrings(converted, jsLiterals);
  };

  const readCall = (scadaTag: string) =>
    apiStyle === 'HAIWELL_NATIVE_350'
      ? `Variable.GetByFullName(${JSON.stringify(scadaTag)})`
      : `Tag.Read(${JSON.stringify(scadaTag)})`;

  const writeCall = (scadaTag: string, expr: string) =>
    apiStyle === 'HAIWELL_NATIVE_350'
      ? `Variable.SetByFullName(${JSON.stringify(scadaTag)}, ${expr});`
      : `Tag.Write(${JSON.stringify(scadaTag)}, ${expr});`;

  const pouStateKey = `__pou_${validation.pouName ?? 'POU'}`;
  if (hasStatefulVars) {
    jsLines.push(`var __pou = __getFb(${JSON.stringify(pouStateKey)}, {});`);
  }

  if (validation.pouType === 'FUNCTION' && validation.pouName) {
    jsLines.push(`var ${jsIdentFor(validation.pouName)} = 0;`);
  }

  for (const v of validation.variables) {
    const jsName = jsIdentFor(v.name);
    const scadaTag = tagBindings[v.name] ?? v.name;
    if (v.section === 'VAR_INPUT' || v.section === 'VAR_IN_OUT' || v.section === 'VAR_GLOBAL' || v.section === 'VAR_EXTERNAL') {
      jsLines.push(`var ${jsName} = ${readCall(scadaTag)};`);
    } else if (IEC_STANDARD_FBS.has(v.dataType)) {
      jsLines.push(
        `var ${jsName} = __getFb(${JSON.stringify(`${validation.pouName ?? 'POU'}.${v.name}`)}, { Q: false, Q1: false, ET: 0, CV: 0, _prev: false });`
      );
    } else {
      const init = v.initialValue
        ? convertExpr(v.initialValue)
        : v.isArray
          ? '[]'
          : v.dataType === 'BOOL'
            ? 'false'
            : v.dataType === 'STRING'
              ? '""'
              : '0';
      if (v.section === 'VAR' || v.section === 'VAR_OUTPUT') {
        const keyLit = JSON.stringify(v.name);
        jsLines.push(
          `if (__pou[${keyLit}] === undefined) __pou[${keyLit}] = ${init};`,
          `var ${jsName} = __pou[${keyLit}];`
        );
      } else {
        jsLines.push(`var ${jsName} = ${init};`);
      }
    }
  }

  let inVar = false;
  const bodyLines: { text: string; line: number }[] = [];
  rawLines.forEach((raw, idx) => {
    const { masked, literals } = maskIecStrings(raw);
    const expandedSegments = masked
      .replace(/\b(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)\b/gi, '\n$1\n')
      .replace(/\bEND_VAR\b/gi, '\nEND_VAR\n')
      .split('\n');
    for (const seg of expandedSegments) {
      const t = unmaskIecStrings(seg, literals).trim();
      if (!t) continue;
      if (/^(PROGRAM|FUNCTION_BLOCK|FUNCTION|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i.test(t)) continue;
      if (/^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR)\b/i.test(t)) {
        inVar = true;
        continue;
      }
      if (/^END_VAR\b/i.test(t)) {
        inVar = false;
        continue;
      }
      if (!inVar) bodyLines.push({ text: t, line: idx + 1 });
    }
  });

  const statements = expandBodyStatements(bodyLines);
  const needsFinally = validation.variables.some(
    (v) => v.section === 'VAR' || v.section === 'VAR_OUTPUT' || v.section === 'VAR_IN_OUT' || v.section === 'VAR_GLOBAL'
  );
  if (needsFinally) {
    jsLines.push('try {');
  }
  let indent = needsFinally ? 1 : 0;
  const pad = () => '  '.repeat(Math.max(0, indent));

  const caseUsesRanges = new Map<number, boolean>();
  const caseIdxStack: number[] = [];
  statements.forEach((st, idx) => {
    if (/^CASE\b/i.test(st.text)) {
      caseIdxStack.push(idx);
      caseUsesRanges.set(idx, false);
    } else if (/^END_CASE\b/i.test(st.text)) {
      caseIdxStack.pop();
    } else if (caseIdxStack.length > 0 && /^-?\d[\d,\s.-]*\.\.[\d,\s.-]*:\s*$/.test(st.text)) {
      caseUsesRanges.set(caseIdxStack[caseIdxStack.length - 1], true);
    }
  });

  interface TranspileFrame {
    kind: 'IF' | 'CASE' | 'FOR' | 'WHILE' | 'REPEAT';
    caseBranchOpen?: boolean;
    caseUsesIfElse?: boolean;
    caseVar?: string;
    caseBranchCount?: number;
    watchdogVar?: string;
    loopLabel?: string;
  }
  const blockStack: TranspileFrame[] = [];
  let loopCounter = 0;
  let caseCounter = 0;
  const topFrame = () => blockStack[blockStack.length - 1];
  const innermostLoopLabel = (): string | undefined => {
    for (let i = blockStack.length - 1; i >= 0; i--) {
      if (blockStack[i].loopLabel) return blockStack[i].loopLabel;
    }
    return undefined;
  };

  const closeOpenCaseBranch = () => {
    const top = topFrame();
    if (top && top.kind === 'CASE' && top.caseBranchOpen) {
      if (top.caseUsesIfElse) {
        indent = Math.max(0, indent - 1);
        jsLines.push(`${pad()}}`);
      } else {
        jsLines.push(`${pad()}break;`);
        indent = Math.max(0, indent - 1);
      }
      top.caseBranchOpen = false;
    }
  };

  for (let stmtIdx = 0; stmtIdx < statements.length; stmtIdx++) {
    const stmt = statements[stmtIdx];
    const t = stmt.text;
    const top = topFrame();

    if (/^IF\b/i.test(t)) {
      const cond = t.replace(/^IF\s*/i, '').replace(/\bTHEN$/i, '').trim();
      jsLines.push(`${pad()}if (${convertExpr(cond)}) {`);
      indent++;
      blockStack.push({ kind: 'IF' });
    } else if (/^ELSIF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      const cond = t.replace(/^ELSIF\s*/i, '').replace(/\bTHEN$/i, '').trim();
      jsLines.push(`${pad()}} else if (${convertExpr(cond)}) {`);
      indent++;
    } else if (/^ELSE\b/i.test(t)) {
      if (top && top.kind === 'CASE') {
        if (top.caseUsesIfElse) {
          if (top.caseBranchOpen) {
            indent = Math.max(0, indent - 1);
            jsLines.push(`${pad()}} else {`);
          } else {
            jsLines.push(`${pad()}{`);
          }
          indent++;
          top.caseBranchOpen = true;
        } else {
          closeOpenCaseBranch();
          jsLines.push(`${pad()}default:`);
          indent++;
          top.caseBranchOpen = true;
        }
      } else {
        indent = Math.max(0, indent - 1);
        jsLines.push(`${pad()}} else {`);
        indent++;
      }
    } else if (/^END_IF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
      if (top && top.kind === 'IF') blockStack.pop();
    } else if (/^CASE\b/i.test(t)) {
      const sel = t.replace(/^CASE\s+/i, '').replace(/\s+OF$/i, '');
      const usesRanges = Boolean(caseUsesRanges.get(stmtIdx));
      if (usesRanges) {
        const cv = `__case_${++caseCounter}`;
        jsLines.push(`${pad()}var ${cv} = ${convertExpr(sel)};`);
        blockStack.push({ kind: 'CASE', caseBranchOpen: false, caseUsesIfElse: true, caseVar: cv, caseBranchCount: 0 });
      } else {
        jsLines.push(`${pad()}switch (${convertExpr(sel)}) {`);
        indent++;
        blockStack.push({ kind: 'CASE', caseBranchOpen: false, caseUsesIfElse: false });
      }
    } else if (/^END_CASE\b/i.test(t)) {
      closeOpenCaseBranch();
      if (top && top.kind === 'CASE' && !top.caseUsesIfElse) {
        indent = Math.max(0, indent - 1);
        jsLines.push(`${pad()}}`);
      }
      if (topFrame()?.kind === 'CASE') blockStack.pop();
    } else if (
      top &&
      top.kind === 'CASE' &&
      /^(-?\d+(?:\s*\.\.\s*-?\d+)?(?:\s*,\s*-?\d+(?:\s*\.\.\s*-?\d+)?)*)\s*:$/.test(t)
    ) {
      const parts = t.replace(/:$/, '').split(',').map((s) => s.trim());
      if (top.caseUsesIfElse && top.caseVar) {
        const conds = parts.map((p) => {
          const rm = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(p);
          if (rm) return `(${top.caseVar} >= ${rm[1]} && ${top.caseVar} <= ${rm[2]})`;
          return `(${top.caseVar} === ${p})`;
        });
        if (top.caseBranchOpen) {
          indent = Math.max(0, indent - 1);
          jsLines.push(`${pad()}} else if (${conds.join(' || ')}) {`);
        } else {
          jsLines.push(`${pad()}if (${conds.join(' || ')}) {`);
        }
        indent++;
        top.caseBranchOpen = true;
        top.caseBranchCount = (top.caseBranchCount ?? 0) + 1;
      } else {
        closeOpenCaseBranch();
        for (const n of parts) jsLines.push(`${pad()}case ${n}:`);
        indent++;
        top.caseBranchOpen = true;
      }
    } else if (/^FOR\b/i.test(t)) {
      const m = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(t);
      if (m) {
        const [, rawIter, start, end, step] = m;
        const iter = identResolveMap.get(rawIter.toUpperCase()) ?? jsIdentFor(rawIter);
        const wd = `__wd_${++loopCounter}`;
        const label = `__loop_${loopCounter}`;
        const endVar = `__end_${loopCounter}`;
        const stepVar = `__step_${loopCounter}`;
        const startJs = convertExpr(start);
        const endJs = convertExpr(end);
        const stepJsExpr = step ? convertExpr(step) : '1';
        jsLines.push(`${pad()}var ${wd} = 0, ${endVar} = ${endJs}, ${stepVar} = ${stepJsExpr};`);
        jsLines.push(`${pad()}${label}: for (${iter} = ${startJs}; (${stepVar} === 0 ? false : (${stepVar} > 0 ? ${iter} <= ${endVar} : ${iter} >= ${endVar})); ${iter} += ${stepVar}) {`);
        indent++;
        jsLines.push(`${pad()}if (++${wd} > 10000) break;`);
        blockStack.push({ kind: 'FOR', watchdogVar: wd, loopLabel: label });
      }
    } else if (/^END_FOR\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
      if (top && top.kind === 'FOR') blockStack.pop();
    } else if (/^WHILE\b/i.test(t)) {
      const cond = t.replace(/^WHILE\s+/i, '').replace(/\s+DO$/i, '');
      const wd = `__wd_${++loopCounter}`;
      const label = `__loop_${loopCounter}`;
      jsLines.push(`${pad()}var ${wd} = 0;`);
      jsLines.push(`${pad()}${label}: while (${convertExpr(cond)}) {`);
      indent++;
      jsLines.push(`${pad()}if (++${wd} > 10000) break;`);
      blockStack.push({ kind: 'WHILE', watchdogVar: wd, loopLabel: label });
    } else if (/^END_WHILE\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
      if (top && top.kind === 'WHILE') blockStack.pop();
    } else if (/^REPEAT\b/i.test(t)) {
      const wd = `__wd_${++loopCounter}`;
      const label = `__loop_${loopCounter}`;
      jsLines.push(`${pad()}var ${wd} = 0;`);
      jsLines.push(`${pad()}${label}: do {`);
      indent++;
      jsLines.push(`${pad()}if (++${wd} > 10000) break;`);
      blockStack.push({ kind: 'REPEAT', watchdogVar: wd, loopLabel: label });
    } else if (/^UNTIL\b/i.test(t)) {
      const cond = t.replace(/^UNTIL\s+/i, '').replace(/;$/, '').trim();
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}} while (!(${convertExpr(cond)}));`);
      if (top && top.kind === 'REPEAT') blockStack.pop();
    } else if (/^END_REPEAT\b/i.test(t)) {
      if (top && top.kind === 'REPEAT') {
        indent = Math.max(0, indent - 1);
        jsLines.push(`${pad()}} while (false);`);
        blockStack.pop();
      }
    } else if (/^EXIT\s*;?$/i.test(t)) {
      const loopLbl = innermostLoopLabel();
      jsLines.push(top?.kind === 'CASE' && loopLbl ? `${pad()}break ${loopLbl};` : `${pad()}break;`);
    } else if (/^RETURN\s*;?$/i.test(t)) {
      jsLines.push(`${pad()}return;`);
    } else {
      const fbCall = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*;?$/.exec(t);
      if (fbCall && fbVarTypes.has(fbCall[1].toUpperCase())) {
        const rawFbName = fbCall[1];
        const fbKey = rawFbName.toUpperCase();
        const fbJsName = identResolveMap.get(fbKey) ?? jsIdentFor(rawFbName);
        const fbType = fbVarTypes.get(fbKey)!;
        const rawArgs = fbCall[2].trim();
        const argPairs: string[] = [];
        const outAssigns: { pin: string; target: string }[] = [];
        if (rawArgs) {
          for (const part of splitTopLevelArgs(rawArgs)) {
            const outM = /^([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*(.+)$/.exec(part.trim());
            if (outM) {
              outAssigns.push({ pin: outM[1].toUpperCase(), target: resolveExprIdents(outM[2].trim()) });
              continue;
            }
            const pm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/.exec(part.trim());
            if (pm) {
              argPairs.push(`${pm[1].toUpperCase()}: ${convertExpr(pm[2].trim())}`);
            }
          }
        }
        const helper = `__FB_${fbType}`;
        const keyLit = JSON.stringify(`${validation.pouName ?? 'POU'}.${rawFbName}`);
        jsLines.push(`${pad()}${fbJsName} = ${helper}(${keyLit}, { ${argPairs.join(', ')} });`);
        for (const oa of outAssigns) {
          jsLines.push(`${pad()}${oa.target} = ${fbJsName}.${oa.pin};`);
        }
      } else if (t.includes(':=')) {
        const sep = t.indexOf(':=');
        const lhs = t.slice(0, sep).trim();
        const rhs = t.slice(sep + 2).replace(/;$/, '').trim();
        if (lhs.startsWith('%')) {
          jsLines.push(`${pad()}${writeCall(lhs, convertExpr(rhs))}`);
        } else {
          const lhsJs = resolveExprIdents(lhs).replace(/\[([^\]]+)\]/g, (_, idxExpr) => `[${convertExpr(idxExpr)}]`);
          jsLines.push(`${pad()}${lhsJs} = ${convertExpr(rhs)};`);
        }
      }
    }
  }

  if (needsFinally) {
    jsLines.push('} finally {');
    for (const v of validation.variables) {
      const jsName = jsIdentFor(v.name);
      if (v.section === 'VAR' || v.section === 'VAR_OUTPUT') {
        jsLines.push(`  __pou[${JSON.stringify(v.name)}] = ${jsName};`);
      }
      if (v.section === 'VAR_OUTPUT' || v.section === 'VAR_IN_OUT' || v.section === 'VAR_GLOBAL') {
        const scadaTag = tagBindings[v.name] ?? v.name;
        jsLines.push(`  ${writeCall(scadaTag, jsName)}`);
      }
    }
    jsLines.push('}');
  }

  const jsCode = jsLines.join('\n');

  try {
    acorn.parse(jsCode, { ecmaVersion: 5, allowReturnOutsideFunction: true, sourceType: 'script' });
  } catch (err) {
    validation.diagnostics.push({
      code: 'IEC-TRANSPILE-001',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'Strict ES5 Transpiler Output Verification',
      message: `Transpiled JavaScript failed Strict ES5 Acorn parse verification: ${(err as Error).message}`,
      fixHint: 'Review unsupported ST syntax constructs before transpiling.',
    });
    validation.valid = false;
    validation.summary.errors += 1;
    return { success: false, validation };
  }

  return {
    success: true,
    jsCode,
    validation,
  };
}
