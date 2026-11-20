/**
 * Strict IEC 61131-3 Static Validator, Safety Analyzer, & Haiwell JS Transpiler.
 * Validates Structured Text (ST), Ladder Diagram (LD) JSON graphs, and Function Block Diagram (FBD) networks
 * to prevent PLC watchdog faults, type-narrowing bugs, float comparison errors, and unsafe hardware writes.
 */

import type { Iec61131Diagnostic } from './types';

export const IEC_ELEMENTARY_TYPES = new Set([
  'BOOL',
  'BYTE',
  'WORD',
  'DWORD',
  'LWORD',
  'SINT',
  'INT',
  'DINT',
  'LINT',
  'USINT',
  'UINT',
  'UDINT',
  'ULINT',
  'REAL',
  'LREAL',
  'TIME',
  'DATE',
  'TIME_OF_DAY',
  'TOD',
  'DATE_AND_TIME',
  'DT',
  'STRING',
  'WSTRING',
]);

export const IEC_STANDARD_FBS = new Set([
  'TON',
  'TOF',
  'TP',
  'CTU',
  'CTD',
  'CTUD',
  'R_TRIG',
  'F_TRIG',
  'SR',
  'RS',
  'PID',
  'HYSTERESIS',
  'SCALE_LIN',
]);

const IEC_KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'FUNCTION', 'END_FUNCTION',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
  'CONSTANT', 'RETAIN', 'AT', 'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'RETURN',
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
  'ABS', 'SQRT', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX',
  'INT_TO_REAL', 'REAL_TO_INT', 'DINT_TO_INT', 'INT_TO_DINT', 'BOOL_TO_INT', 'WORD_TO_INT', 'REAL_TO_DINT',
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
  // Replace (* ... *) and // ... comments while keeping newlines for accurate line numbers
  let out = source.replace(/\(\*[\s\S]*?\*\)/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

function validateDirectAddress(addr: string, line: number, diagnostics: Iec61131Diagnostic[]): void {
  const validDirect = /^%[IQM]([XBWDL])?\d+(\.\d+)?$/i;
  if (!validDirect.test(addr)) {
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

export function validateStructuredText(source: string): Iec61131ValidationResult {
  const diagnostics: Iec61131Diagnostic[] = [];
  const variables: DeclaredVariable[] = [];
  const varMap = new Map<string, DeclaredVariable>();
  const cleaned = stripCommentsPreserveLines(source);
  const lines = cleaned.split(/\r?\n/);

  let pouType: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION' | undefined;
  let pouName: string | undefined;
  let expectedEndKeyword: string | undefined;
  let foundPouEnd = false;
  let inVarSection: DeclaredVariable['section'] | null = null;
  let currentVarIsConstant = false;
  let cyclomaticComplexity = 1;

  const blockStack: { kind: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // 1. POU Header detection
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
            fixHint: `Append ": <DATA_TYPE>" to the FUNCTION header.`,
          });
        }
        continue;
      }
    }

    // 2. POU End detection
    if (expectedEndKeyword && new RegExp(`^${expectedEndKeyword}\\b`, 'i').test(trimmed)) {
      foundPouEnd = true;
      continue;
    }

    // 3. VAR block start/end
    const varStartMatch = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)(?:\s+(CONSTANT|RETAIN))?\b/i.exec(trimmed);
    if (varStartMatch && !/^VAR_/i.test(trimmed) ? /^VAR(\s+(CONSTANT|RETAIN))?$/i.test(trimmed) : Boolean(varStartMatch)) {
      if (inVarSection) {
        diagnostics.push({
          code: 'IEC-VAR-001',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declarations',
          message: `Nested ${varStartMatch![1].toUpperCase()} opened before closing previous ${inVarSection} with END_VAR.`,
          fixHint: `Add END_VAR before starting ${varStartMatch![1].toUpperCase()}.`,
        });
      }
      inVarSection = varStartMatch![1].toUpperCase() as DeclaredVariable['section'];
      currentVarIsConstant = (varStartMatch![2] ?? '').toUpperCase() === 'CONSTANT';
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

    // 4. Inside VAR block: parse declarations
    if (inVarSection) {
      const declMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+AT\s+(%[A-Za-z0-9_.]+))?\s*:\s*([A-Za-z_][A-Za-z0-9_]*)(?:\[\d+\.\.\d+\])?(?:\s*:=\s*([^;]+))?\s*(;)?$/i.exec(trimmed);
      if (!declMatch) {
        diagnostics.push({
          code: 'IEC-VAR-003',
          severity: 'ERROR',
          line: lineNum,
          column: 1,
          rule: 'IEC 61131-3 §6.5.2 Variable Declaration Syntax',
          message: `Malformed variable declaration: "${trimmed}".`,
          fixHint: 'Use syntax "VarName [AT %MW0] : TYPE [:= InitialValue];".',
        });
        continue;
      }

      const [, name, directAddr, rawType, , semicolon] = declMatch;
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

      if (!IEC_ELEMENTARY_TYPES.has(dataType) && !IEC_STANDARD_FBS.has(dataType) && !/^STRING\(\d+\)$/i.test(rawType)) {
        diagnostics.push({
          code: 'IEC-TYPE-001',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.indexOf(rawType) + 1,
          rule: 'IEC 61131-3 §6.4 Data Types',
          message: `Unknown IEC 61131-3 data type or standard function block "${rawType}".`,
          fixHint: `Use an elementary type (BOOL, INT, DINT, REAL, TIME, STRING) or standard FB (TON, TOF, CTU, R_TRIG, PID).`,
        });
      }

      if (directAddr) {
        validateDirectAddress(directAddr, lineNum, diagnostics);
      }

      const declared: DeclaredVariable = {
        name,
        dataType,
        section: inVarSection,
        constant: currentVarIsConstant,
        directAddress: directAddr,
        line: lineNum,
      };
      variables.push(declared);
      varMap.set(name.toUpperCase(), declared);
      continue;
    }

    // 5. Executable ST statements
    // Control block tracking
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
          message: 'IF statement missing THEN keyword on condition line.',
          fixHint: 'Add THEN after the IF boolean condition.',
        });
      }
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
      blockStack.push({ kind: 'CASE', line: lineNum });
      cyclomaticComplexity++;
    } else if (/^END_CASE\b/i.test(trimmed)) {
      if (blockStack.at(-1)?.kind !== 'CASE') {
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
        blockStack.pop();
      }
    } else if (/^FOR\b/i.test(trimmed)) {
      blockStack.push({ kind: 'FOR', line: lineNum });
      cyclomaticComplexity++;
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
      blockStack.push({ kind: 'WHILE', line: lineNum });
      cyclomaticComplexity++;
      if (/^WHILE\s+TRUE\b/i.test(trimmed) || /^WHILE\s+1\s*=\s*1\b/i.test(trimmed)) {
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
      if (blockStack.at(-1)?.kind !== 'WHILE') {
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
        blockStack.pop();
      }
    } else if (/^REPEAT\b/i.test(trimmed)) {
      blockStack.push({ kind: 'REPEAT', line: lineNum });
      cyclomaticComplexity++;
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

    // 6. Safety rule: Division by literal zero
    if (/\/\s*0(?:\.0+)?(?:\s|;|\)|$)/.test(trimmed)) {
      diagnostics.push({
        code: 'IEC-SAFE-002',
        severity: 'ERROR',
        line: lineNum,
        column: trimmed.indexOf('/') + 1,
        rule: 'PLC Runtime Fault Prevention (Division by Zero)',
        message: 'Literal division by zero will raise a PLC arithmetic exception at runtime.',
        fixHint: 'Guard divisors with an explicit non-zero check before dividing.',
      });
    }

    // 7. Safety rule: Exact equality comparison on REAL / LREAL
    const eqMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(=|<>)\s*([A-Za-z0-9_.]+)/g;
    let eqHit: RegExpExecArray | null;
    while ((eqHit = eqMatch.exec(trimmed)) !== null) {
      // Skip assignment :=
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

    // 8. Assignment validation (target mutability, narrowing conversion, undeclared vars)
    const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*|%[IQM][XBWDL]?\d+(?:\.\d+)?)\s*:=\s*(.+?);?$/i.exec(trimmed);
    if (assignMatch && !/^(IF|ELSIF|WHILE|FOR)\b/i.test(trimmed)) {
      const [, lhs, rhs] = assignMatch;
      if (!trimmed.endsWith(';')) {
        diagnostics.push({
          code: 'IEC-SYN-002',
          severity: 'ERROR',
          line: lineNum,
          column: trimmed.length,
          rule: 'IEC 61131-3 Statement Termination',
          message: `Assignment to "${lhs}" is missing trailing semicolon ";".`,
          fixHint: 'Terminate every ST assignment with ";".',
        });
      }

      if (lhs.startsWith('%')) {
        validateDirectAddress(lhs, lineNum, diagnostics);
        if (/^%I/i.test(lhs)) {
          diagnostics.push({
            code: 'IEC-SAFE-004',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'Hardware Input Immutability',
            message: `Cannot write to physical input address "${lhs}".`,
            fixHint: 'Write to an output (%Q...) or internal memory (%M...) address instead.',
          });
        }
      } else {
        const lhsVar = varMap.get(lhs.toUpperCase());
        if (!lhsVar && !(pouType === 'FUNCTION' && pouName && lhs.toUpperCase() === pouName.toUpperCase())) {
          diagnostics.push({
            code: 'IEC-VAR-005',
            severity: 'ERROR',
            line: lineNum,
            column: 1,
            rule: 'IEC 61131-3 Strict Variable Resolution',
            message: `Assignment target "${lhs}" is not declared in any VAR block.`,
            fixHint: `Declare "${lhs}" in VAR, VAR_OUTPUT, or VAR_GLOBAL.`,
          });
        } else if (lhsVar) {
          if (lhsVar.section === 'VAR_INPUT') {
            diagnostics.push({
              code: 'IEC-SAFE-005',
              severity: 'ERROR',
              line: lineNum,
              column: 1,
              rule: 'IEC 61131-3 §6.6.2 VAR_INPUT Immutability',
              message: `Cannot assign to VAR_INPUT "${lhs}" inside POU body.`,
              fixHint: `Move "${lhs}" to VAR_IN_OUT or assign to a VAR_OUTPUT / local VAR.`,
            });
          }
          if (lhsVar.constant) {
            diagnostics.push({
              code: 'IEC-SAFE-006',
              severity: 'ERROR',
              line: lineNum,
              column: 1,
              rule: 'IEC 61131-3 CONSTANT Immutability',
              message: `Cannot assign to CONSTANT variable "${lhs}".`,
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
              message: `Variable "${lhs}" is bound to read-only hardware input "${lhsVar.directAddress}".`,
              fixHint: 'Bind writable outputs to %QX / %QW or internal %MW memory.',
            });
          }

          // Check implicit narrowing when RHS is a single declared variable
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

      // Check undeclared identifiers on RHS (ignoring string literals, time literals T#..., numbers, member fields .Q/.ET)
      const rhsWithoutStrings = rhs
        .replace(/'[^']*'/g, ' ')
        .replace(/"[^"]*"/g, ' ')
        .replace(/\b(?:T|TIME)#[0-9_a-zA-Z.]+\b/gi, ' ')
        .replace(/\.[A-Za-z_][A-Za-z0-9_]*/g, ' ');
      const identRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = identRegex.exec(rhsWithoutStrings)) !== null) {
        const token = idMatch[1];
        const upper = token.toUpperCase();
        if (IEC_KEYWORDS.has(upper) || IEC_ELEMENTARY_TYPES.has(upper) || IEC_STANDARD_FBS.has(upper)) continue;
        if (/^[A-Z]+_TO_[A-Z]+$/.test(upper)) continue;
        if (!varMap.has(upper)) {
          diagnostics.push({
            code: 'IEC-VAR-006',
            severity: 'ERROR',
            line: lineNum,
            column: trimmed.indexOf(token) + 1,
            rule: 'IEC 61131-3 Strict Variable Resolution',
            message: `Undeclared identifier "${token}" referenced in expression.`,
            fixHint: `Declare "${token}" in VAR, VAR_INPUT, or VAR_GLOBAL before referencing it.`,
          });
        }
      }
    }

    // 9. Function block invocation check: e.g. Timer1(IN := StartCmd, PT := T#5s);
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
      } else if (fbVar.dataType === 'TON' || fbVar.dataType === 'TOF' || fbVar.dataType === 'TP') {
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
    if (!Array.isArray(parsed)) {
      throw new Error('Ladder source must be a JSON array of rungs.');
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

  const writtenCoils = new Map<string, string>();
  rungs.forEach((rung, idx) => {
    const line = idx + 1;
    if (!rung.coil?.tag) {
      diagnostics.push({
        code: 'IEC-LD-002',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 LD Rung Output',
        message: `Rung "${rung.rungId ?? line}" has no output coil.`,
        fixHint: 'Assign a target output coil (OUT, SET, or RESET) to every rung.',
      });
      return;
    }
    if (/^X\d+/i.test(rung.coil.tag) || /^%I/i.test(rung.coil.tag)) {
      diagnostics.push({
        code: 'IEC-SAFE-004',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'Hardware Input Immutability',
        message: `Rung "${rung.rungId}" attempts to energize read-only input "${rung.coil.tag}".`,
        fixHint: 'Target a writable coil (Y, M, S) instead of X/%I.',
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
          message: `Double-coil hazard: "${rung.coil.tag}" energized by both rung "${writtenCoils.get(rung.coil.tag)}" and "${rung.rungId}".`,
          fixHint: 'Combine parallel branch conditions into a single rung or use SET/RESET coils.',
        });
      }
      writtenCoils.set(rung.coil.tag, rung.rungId);
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
    if (!Array.isArray(parsed)) throw new Error('FBD network must be a JSON array of blocks.');
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

  const allowedBlocks = new Set([...IEC_STANDARD_FBS, 'AND', 'OR', 'XOR', 'NOT', 'ADD', 'SUB', 'MUL', 'DIV', 'GT', 'GE', 'LT', 'LE', 'EQ', 'LIMIT', 'SEL', 'MOVE']);
  const seenIds = new Set<string>();
  nodes.forEach((node, idx) => {
    const line = idx + 1;
    if (seenIds.has(node.id)) {
      diagnostics.push({
        code: 'IEC-FBD-002',
        severity: 'ERROR',
        line,
        column: 1,
        rule: 'IEC 61131-3 FBD Unique Node IDs',
        message: `Duplicate FBD block id "${node.id}".`,
        fixHint: 'Give every FBD block a unique identifier.',
      });
    }
    seenIds.add(node.id);
    if (!allowedBlocks.has(node.blockType?.toUpperCase())) {
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
  });

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
  const lines = cleaned.split(/\r?\n/);
  const jsLines: string[] = [
    `// Transpiled from IEC 61131-3 ST POU: ${validation.pouName ?? 'Unnamed'}`,
    `// Standard: ${validation.standard}`,
  ];

  // Read bound variables from Haiwell SCADA Tag database
  for (const v of validation.variables) {
    const scadaTag = tagBindings[v.name] ?? v.name;
    if (v.section === 'VAR_INPUT' || v.section === 'VAR_IN_OUT' || v.section === 'VAR_GLOBAL') {
      jsLines.push(`let ${v.name} = Tag.Read(${JSON.stringify(scadaTag)});`);
    } else if (!IEC_STANDARD_FBS.has(v.dataType)) {
      const init = v.dataType === 'BOOL' ? 'false' : v.dataType === 'STRING' ? '""' : '0';
      jsLines.push(`let ${v.name} = ${init};`);
    }
  }

  let inVar = false;
  let indent = 0;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(PROGRAM|FUNCTION_BLOCK|FUNCTION|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i.test(t)) continue;
    if (/^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)\b/i.test(t)) {
      inVar = true;
      continue;
    }
    if (/^END_VAR\b/i.test(t)) {
      inVar = false;
      continue;
    }
    if (inVar) continue;

    const convertExpr = (expr: string): string =>
      expr
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
        .replace(/\b(?:REAL_TO_INT|REAL_TO_DINT|DINT_TO_INT)\s*\(/gi, 'Math.trunc(')
        .replace(/\b(?:INT_TO_REAL|DINT_TO_REAL)\s*\(/gi, 'Number(');

    const pad = () => '  '.repeat(Math.max(0, indent));

    if (/^IF\b/i.test(t)) {
      const cond = t.replace(/^IF\s+/i, '').replace(/\s+THEN$/i, '');
      jsLines.push(`${pad()}if (${convertExpr(cond)}) {`);
      indent++;
    } else if (/^ELSIF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      const cond = t.replace(/^ELSIF\s+/i, '').replace(/\s+THEN$/i, '');
      jsLines.push(`${pad()}} else if (${convertExpr(cond)}) {`);
      indent++;
    } else if (/^ELSE$/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}} else {`);
      indent++;
    } else if (/^END_IF\b/i.test(t)) {
      indent = Math.max(0, indent - 1);
      jsLines.push(`${pad()}}`);
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
    } else if (t.includes(':=')) {
      const [lhs, rhs] = t.replace(/;$/, '').split(':=');
      jsLines.push(`${pad()}${lhs.trim()} = ${convertExpr(rhs.trim())};`);
    }
  }

  // Write outputs back to Haiwell SCADA Tag database
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
