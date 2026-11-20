/**
 * Hardened IEC 61131-3:2013 Static Validator, Safety Analyzer, & Haiwell JS Transpiler.
 * Handles multi-line expressions, single-line IF/END_IF, multiple statements per line,
 * ARRAY/STRING declarations, condition variable resolution, unguarded division,
 * unbounded WHILE/REPEAT loops, CASE/ELSE completeness, Ladder double-coil & schema checks,
 * and FBD algebraic-loop cycle detection.
 */

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
  'ABS', 'SQRT', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'TRUNC', 'ROUND',
  'INT_TO_REAL', 'REAL_TO_INT', 'DINT_TO_INT', 'INT_TO_DINT', 'BOOL_TO_INT', 'WORD_TO_INT', 'REAL_TO_DINT', 'DINT_TO_REAL', 'UINT_TO_REAL', 'REAL_TO_UINT',
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
  section: 'VAR' | 'VAR_INPUT' | 'VAR_OUTPUT' | 'VAR_IN_OUT' | 'VAR_GLOBAL' | 'VAR_TEMP';
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

function stripCommentsPreserveLines(source: string): string {
  // Handle nested (* ... *) comments safely and // single-line comments without touching strings
  let out = '';
  let i = 0;
  let blockDepth = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (blockDepth > 0) {
      if (ch === '(' && next === '*') {
        blockDepth++;
        out += '  ';
        i += 2;
      } else if (ch === '*' && next === ')') {
        blockDepth--;
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
      if (ch === "'" && source[i - 1] !== '$') inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"' && source[i - 1] !== '$') inDouble = false;
      i++;
      continue;
    }

    if (ch === '(' && next === '*') {
      blockDepth = 1;
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
 * Splits cleaned ST body lines into logical statements so single-line
 * "IF a THEN b := 1; END_IF;" and multi-statement lines "a := 1; b := 2;"
 * and multi-line "IF a AND\n b THEN" are all analyzed accurately!
 */
function expandBodyStatements(lines: { text: string; line: number }[]): LogicalStatement[] {
  const result: LogicalStatement[] = [];
  let buffer = '';
  let bufferLine = 0;

  const flushLine = (raw: string, line: number) => {
    // Expand inline IF ... THEN <stmt>; END_IF; cleanly
    let segment = raw.trim();
    if (!segment) return;

    // Split on keyword boundaries that begin/end blocks on the same line
    const expanded = segment
      .replace(/\bTHEN\b\s+(?=\S)/gi, 'THEN\n')
      .replace(/\bDO\b\s+(?=\S)/gi, 'DO\n')
      .replace(/;\s*(?=\S)/g, ';\n')
      .replace(/\bELSE\b\s+(?=\S)/gi, 'ELSE\n');

    for (const part of expanded.split('\n')) {
      const p = part.trim();
      if (p) result.push({ text: p, line });
    }
  };

  for (const item of lines) {
    const t = item.text.trim();
    if (!t) continue;

    if (!buffer) bufferLine = item.line;
    buffer = buffer ? `${buffer} ${t}` : t;

    const complete =
      buffer.endsWith(';') ||
      /^UNTIL\b/i.test(buffer) ||
      /\b(THEN|DO|ELSE|OF|REPEAT|END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\s*;?$/i.test(buffer) ||
      /^[0-9,\s.-]+:\s*$/.test(buffer);

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

  // Check unclosed (* comment
  const openComments = (source.match(/\(\*/g) ?? []).length;
  const closeComments = (source.match(/\*\)/g) ?? []).length;
  if (openComments !== closeComments) {
    diagnostics.push({
      code: 'IEC-SYN-003',
      severity: 'ERROR',
      line: 1,
      column: 1,
      rule: 'IEC 61131-3 Lexical Comments',
      message: `Unbalanced block comment delimiters: ${openComments} "(*" vs ${closeComments} "*)".`,
      fixHint: 'Ensure every (* comment is closed with *).',
    });
  }

  const cleaned = stripCommentsPreserveLines(source);
  const rawLines = cleaned.split(/\r?\n/);
  // Normalize single-line VAR blocks (e.g., "VAR A : INT; B : INT; END_VAR") while preserving original line numbers
  const numberedLines: { text: string; lineNum: number }[] = [];
  rawLines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const t = rawLine.trim();
    if (/^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)(?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*\s+\S/i.test(t)) {
      const expanded = t
        .replace(/^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR(?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*)\s+/i, '$1\n')
        .replace(/;\s*(?=\S)/g, ';\n')
        .replace(/\s+(END_VAR)\b/gi, '\n$1');
      for (const part of expanded.split('\n')) {
        if (part.trim()) numberedLines.push({ text: part.trim(), lineNum });
      }
    } else {
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

    const varStartMatch = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)(?:\s+(CONSTANT|RETAIN|PERSISTENT))*\s*$/i.exec(trimmed);
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
      // Support scalar, STRING[N]/STRING(N), and ARRAY[lo..hi] OF TYPE
      const declMatch =
        /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+AT\s+(%[A-Za-z0-9_.]+))?\s*:\s*(?:(ARRAY\s*\[\s*-?\d+\s*\.\.\s*-?\d+\s*\]\s*OF\s+))?([A-Za-z_][A-Za-z0-9_]*)(?:\s*[\[(]\s*\d+\s*[\])])?(?:\s*:=\s*([^;]+))?\s*(;)?$/i.exec(
          trimmed
        );
      if (!declMatch) {
        diagnostics.push({
          code: 'IEC-VAR-003',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declaration Syntax',
          message: `Malformed variable declaration: "${trimmed}".`,
          fixHint: 'Use syntax "VarName [AT %MW0] : [ARRAY[0..9] OF] TYPE [:= InitialValue];".',
        });
        continue;
      }

      const [, name, directAddr, arrayPrefix, rawType, , semicolon] = declMatch;
      const dataType = rawType.toUpperCase();
      if (!semicolon) {
        diagnostics.push({
          code: 'IEC-SYN-001',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Missing terminating semicolon ";" on declaration of "${name}".`,
          fixHint: 'Append ";" at the end of the declaration.',
        });
      }

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

      const declared: DeclaredVariable = {
        name,
        dataType,
        isArray: Boolean(arrayPrefix),
        section: inVarSection,
        constant: currentVarIsConstant,
        directAddress: directAddr,
        line: lineNum,
      };
      variables.push(declared);
      varMap.set(name.toUpperCase(), declared);
      continue;
    }

    bodyLines.push({ text: trimmed, line: lineNum });
  }

  // Analyze expanded logical body statements
  const statements = expandBodyStatements(bodyLines);
  const blockStack: { kind: string; line: number; hasElse?: boolean; whileCondVars?: string[]; mutatedVars?: Set<string> }[] = [];
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
      if (!/\bTHEN\b/i.test(trimmed)) {
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
      const cond = trimmed.replace(/^IF\s+/i, '').replace(/\s+THEN$/i, '');
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
      }
      const cond = trimmed.replace(/^ELSIF\s+/i, '').replace(/\s+THEN$/i, '');
      checkExpressionIdentifiers(cond, lineNum, varMap, pouName, diagnostics);
    } else if (/^ELSE\b/i.test(trimmed)) {
      const top = blockStack.at(-1);
      if (top && (top.kind === 'IF' || top.kind === 'CASE')) {
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
      blockStack.push({ kind: 'REPEAT', line: lineNum });
      cyclomaticComplexity++;
    } else if (/^UNTIL\b/i.test(trimmed)) {
      if (blockStack.at(-1)?.kind !== 'REPEAT') {
        diagnostics.push({
          code: 'IEC-CTRL-007',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 REPEAT/UNTIL Matching',
          message: 'UNTIL outside of a REPEAT block.',
          fixHint: 'Use REPEAT ... UNTIL <cond>; END_REPEAT;.',
        });
      }
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
      if (blockStack.at(-1)?.kind !== 'REPEAT') {
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
        blockStack.pop();
      }
    }

    // Division / Modulo safety: literal zero (ERROR) + unguarded variable divisor (WARNING)
    if (/\/\s*0(?:\.0+)?(?:\s|;|\)|$)/.test(trimmed) || /\bMOD\s+0(?:\.0+)?(?:\s|;|\)|$)/i.test(trimmed)) {
      diagnostics.push({
        code: 'IEC-SAFE-002',
        severity: 'ERROR',
        line: lineNum,
        column: Math.max(1, trimmed.indexOf('/') + 1),
        rule: 'PLC Runtime Fault Prevention (Division / Modulo by Zero)',
        message: 'Literal division or MOD by zero will raise a PLC arithmetic exception at runtime.',
        fixHint: 'Guard divisors with an explicit non-zero check before dividing or taking MOD.',
      });
    } else {
      const varDivMatch = /\/\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
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

    // Float exact equality check
    const eqMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(=|<>)\s*([A-Za-z0-9_.]+)/g;
    let eqHit: RegExpExecArray | null;
    while ((eqHit = eqMatch.exec(trimmed)) !== null) {
      const before = trimmed.slice(0, eqHit.index + eqHit[1].length + 1);
      if (trimmed.slice(eqHit.index, eqHit.index + eqHit[0].length + 1).includes(':=')) continue;
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
          message: `Exact equality/inequality "${eqHit[2]}" on REAL/LREAL variable "${eqHit[1]}" can fail due to floating-point rounding.`,
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

      checkExpressionIdentifiers(rhs, lineNum, varMap, pouName, diagnostics);
    }

    // Function block invocation check
    const fbCallMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*;?$/.exec(trimmed);
    if (fbCallMatch && !/^(IF|ELSIF|WHILE|CASE|FOR)\b/i.test(trimmed)) {
      const fbName = fbCallMatch[1];
      const args = fbCallMatch[2];
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
        // Validate RHS expressions of named FB params (e.g., IN := SomeVar)
        const paramRhs = [...args.matchAll(/:=\s*([^,]+)/g)].map((m) => m[1]);
        for (const expr of paramRhs) {
          checkExpressionIdentifiers(expr, lineNum, varMap, pouName, diagnostics);
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

    if (rung.coil.type === 'OUT') {
      if (writtenCoils.has(rung.coil.tag)) {
        diagnostics.push({
          code: 'IEC-LD-003',
          severity: 'ERROR',
          line,
          column: 1,
          rule: 'Double-Coil Hazard Prevention',
          message: `Double-coil hazard: "${rung.coil.tag}" energized by both rung "${writtenCoils.get(rung.coil.tag)}" and "${rid}".`,
          fixHint: 'Combine parallel branch conditions into a single rung or use SET/RESET coils.',
        });
      }
      writtenCoils.set(rung.coil.tag, rid);
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
  const signalProducer = new Map<string, string>();
  const graph = new Map<string, string[]>();

  nodes.forEach((node, idx) => {
    const line = idx + 1;
    if (!node?.id || seenIds.has(node.id)) {
      diagnostics.push({
        code: 'IEC-FBD-002',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 FBD Unique Node IDs',
        message: `Missing or duplicate FBD block id "${node?.id}".`,
        fixHint: 'Give every FBD block a unique non-empty identifier.',
      });
      return;
    }
    seenIds.add(node.id);
    graph.set(node.id, []);

    const bType = node.blockType?.toUpperCase();
    if (!allowedBlocks.has(bType)) {
      diagnostics.push({
        code: 'IEC-FBD-003',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 Standard FBD Library',
        message: `Unsupported FBD block type "${node.blockType}".`,
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
      signalProducer.set(outSig, node.id);
    }
  });

  // Build dependency edges and detect combinational cycles (algebraic loops)
  for (const node of nodes) {
    if (!node?.id) continue;
    for (const inSig of Object.values(node.inputs ?? {})) {
      const producer = signalProducer.get(inSig);
      if (producer) {
        graph.get(producer)?.push(node.id);
      }
    }
  }

  const visitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const hasCycleDfs = (u: string): boolean => {
    visitState.set(u, 1);
    for (const v of graph.get(u) ?? []) {
      const st = visitState.get(v) ?? 0;
      if (st === 1) return true;
      if (st === 0 && hasCycleDfs(v)) return true;
    }
    visitState.set(u, 2);
    return false;
  };

  for (const id of graph.keys()) {
    if ((visitState.get(id) ?? 0) === 0 && hasCycleDfs(id)) {
      diagnostics.push({
        code: 'IEC-FBD-005',
        severity: 'ERROR',
        line: 1,
        column: 1,
        rule: 'IEC 61131-3 FBD Algebraic Loop Prevention',
        message: `Combinational feedback cycle detected involving block "${id}".`,
        fixHint: 'Break feedback loops with a state register or one-scan delay block.',
      });
      break;
    }
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
export function transpileStToHaiwellJs(
  source: string,
  tagBindings: Record<string, string> = {}
): { success: boolean; jsCode?: string; validation: Iec61131ValidationResult } {
  const validation = validateStructuredText(source);
  if (!validation.valid) {
    return { success: false, validation };
  }

  const cleaned = stripCommentsPreserveLines(source);
  const rawLines = cleaned.split(/\r?\n/);

  const jsLines: string[] = [
    `// Transpiled from IEC 61131-3 ST POU: ${validation.pouName ?? 'Unnamed'}`,
    `// Standard: ${validation.standard}`,
    `const __LIMIT = (mn, v, mx) => Math.max(mn, Math.min(mx, v));`,
    `const __SEL = (g, a, b) => (g ? b : a);`,
  ];

  for (const v of validation.variables) {
    const scadaTag = tagBindings[v.name] ?? v.name;
    if (v.section === 'VAR_INPUT' || v.section === 'VAR_IN_OUT' || v.section === 'VAR_GLOBAL') {
      jsLines.push(`let ${v.name} = Tag.Read(${JSON.stringify(scadaTag)});`);
    } else if (!IEC_STANDARD_FBS.has(v.dataType)) {
      const init = v.isArray ? '[]' : v.dataType === 'BOOL' ? 'false' : v.dataType === 'STRING' ? '""' : '0';
      jsLines.push(`let ${v.name} = ${init};`);
    }
  }

  let inVar = false;
  const bodyLines: { text: string; line: number }[] = [];
  rawLines.forEach((raw, idx) => {
    const t = raw.trim();
    if (!t) return;
    if (/^(PROGRAM|FUNCTION_BLOCK|FUNCTION|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i.test(t)) return;
    if (/^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)\b/i.test(t)) {
      inVar = true;
      return;
    }
    if (/^END_VAR\b/i.test(t)) {
      inVar = false;
      return;
    }
    if (!inVar) bodyLines.push({ text: t, line: idx + 1 });
  });

  const statements = expandBodyStatements(bodyLines);
  let indent = 0;
  const pad = () => '  '.repeat(Math.max(0, indent));

  const convertExpr = (expr: string): string => {
    // Preserve string literals while translating IEC operators outside strings
    const tokens: string[] = [];
    const masked = expr.replace(/'(?:[^'$]|\$.)*'|"(?:[^"$]|\$.)*"/g, (lit) => {
      const idx = tokens.push(lit) - 1;
      return `__STR_${idx}__`;
    });
    const converted = masked
      .replace(/\bAND\b/gi, '&&')
      .replace(/\bOR\b/gi, '||')
      .replace(/\bNOT\b/gi, '!')
      .replace(/\bMOD\b/gi, '%')
      .replace(/\bTRUE\b/gi, 'true')
      .replace(/\bFALSE\b/gi, 'false')
      .replace(/<>/g, '!==')
      .replace(/(?<![<>!=:])=(?!=)/g, '===')
      .replace(/\bABS\s*\(/gi, 'Math.abs(')
      .replace(/\bSQRT\s*\(/gi, 'Math.sqrt(')
      .replace(/\bMIN\s*\(/gi, 'Math.min(')
      .replace(/\bMAX\s*\(/gi, 'Math.max(')
      .replace(/\bLIMIT\s*\(/gi, '__LIMIT(')
      .replace(/\bSEL\s*\(/gi, '__SEL(')
      .replace(/\b(?:REAL_TO_INT|REAL_TO_DINT|DINT_TO_INT|REAL_TO_UINT)\s*\(/gi, 'Math.trunc(')
      .replace(/\b(?:INT_TO_REAL|DINT_TO_REAL|UINT_TO_REAL)\s*\(/gi, 'Number(');
    return converted.replace(/__STR_(\d+)__/g, (_, idx) => tokens[Number(idx)]);
  };

  let inCase = false;

  for (const stmt of statements) {
    const t = stmt.text;
    if (/^IF\b/i.test(t)) {
      const cond = t.replace(/^IF\s+/i, '').replace(/\s+THEN$/i, '');
      jsLines.push(`${pad()}if (${convertExpr(cond)}) {`);
      indent++;
    } else if (/^ELSIF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      const cond = t.replace(/^ELSIF\s+/i, '').replace(/\s+THEN$/i, '');
      jsLines.push(`${pad()}} else if (${convertExpr(cond)}) {`);
      indent++;
    } else if (/^ELSE\b/i.test(t)) {
      if (inCase) {
        jsLines.push(`${pad()}default:`);
      } else {
        indent = Math.max(0, indent - 1);
        jsLines.push(`${pad()}} else {`);
        indent++;
      }
    } else if (/^END_IF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
    } else if (/^CASE\b/i.test(t)) {
      const sel = t.replace(/^CASE\s+/i, '').replace(/\s+OF$/i, '');
      jsLines.push(`${pad()}switch (${convertExpr(sel)}) {`);
      indent++;
      inCase = true;
    } else if (/^END_CASE\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
      inCase = false;
    } else if (inCase && /^(-?\d+(?:\s*,\s*-?\d+)*)\s*:$/.test(t)) {
      const nums = t.replace(/:$/, '').split(',').map((s) => s.trim());
      for (const n of nums) jsLines.push(`${pad()}case ${n}:`);
    } else if (/^FOR\b/i.test(t)) {
      const m = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(t);
      if (m) {
        const [, iter, start, end, step] = m;
        const stepExpr = step ? `${iter} += ${convertExpr(step)}` : `${iter}++`;
        jsLines.push(`${pad()}for (${iter} = ${convertExpr(start)}; ${iter} <= ${convertExpr(end)}; ${stepExpr}) {`);
        indent++;
      }
    } else if (/^END_FOR\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
    } else if (/^EXIT\s*;?$/i.test(t)) {
      jsLines.push(`${pad()}break;`);
    } else if (/^RETURN\s*;?$/i.test(t)) {
      jsLines.push(`${pad()}return;`);
    } else if (t.includes(':=')) {
      const sep = t.indexOf(':=');
      const lhs = t.slice(0, sep).trim();
      const rhs = t.slice(sep + 2).replace(/;$/, '').trim();
      jsLines.push(`${pad()}${lhs} = ${convertExpr(rhs)};`);
      if (inCase) jsLines.push(`${pad()}break;`);
    }
  }

  for (const v of validation.variables) {
    if (v.section === 'VAR_OUTPUT' || v.section === 'VAR_IN_OUT') {
      const scadaTag = tagBindings[v.name] ?? v.name;
      jsLines.push(`Tag.Write(${JSON.stringify(scadaTag)}, ${v.name});`);
    }
  }

  return {
    success: true,
    jsCode: jsLines.join('\n'),
    validation,
  };
}
