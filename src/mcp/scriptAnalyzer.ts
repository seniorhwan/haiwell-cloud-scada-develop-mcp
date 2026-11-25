/**
 * AST-Hardened Static Analyzer for Haiwell Cloud SCADA JavaScript command scripts.
 * Uses Acorn ES2020 + Strict ES5 AST parsing with lexical scope tracking:
 * - Catches real JavaScript syntax errors (HWJS-SYN-001)
 * - Enforces Strict ES5 syntax (HWJS-ES5-001) & ES5 runtime APIs (HWJS-ES5-002) for ARM Linux HMIs (Node v0.10.41)
 * - Lexical-scope-aware forbidden host/sandbox symbol detection (allows local `var process = 1;` while blocking unbound `process`, `eval`, `Function`, `__proto__`/`constructor`/`prototype`)
 * - Full tag extraction across Tag.Read/Write, Variable.GetByFullName/SetByFullName/BatchSetByFullNames, $Device.Tag, and single-level $InternalTag
 * - Genuine AST EStop_OK interlock check (immune to comments and string literals)
 * - Haiwell 3.50.x runtime trap & official Common.logger.* lints
 */

import * as acorn from 'acorn';
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
  'CLOUD_HMI_A7_PRO',
  'CLOUD_HMI_A10_PRO',
  'CLOUD_HMI_A15_PRO',
  'CLOUD_HMI_D7_PRO',
  'CLOUD_HMI_D10_PRO',
  'CLOUD_HMI_D15_PRO',
  'CLOUD_BOX_CBOX',
]);

const FORBIDDEN_UNBOUND_GLOBALS = new Set([
  'eval',
  'Function',
  'require',
  'process',
  'child_process',
  'fs',
  'globalThis',
  'global',
  'setInterval',
  'setTimeout',
  'setImmediate',
  'Buffer',
  'WebAssembly',
  'Proxy',
  'Reflect',
]);

const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

const ES6_RUNTIME_GLOBALS = new Set(['Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'URL', 'TextEncoder', 'BigInt', 'fetch']);

const FORBIDDEN_PROTOTYPE_APIS: Record<string, Set<string>> = {
  Object: new Set(['getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors']),
  Reflect: new Set(['get', 'set', 'construct', 'apply']),
};

const ES6_STATIC_METHODS: Record<string, Set<string>> = {
  Object: new Set(['assign', 'entries', 'values', 'fromEntries', 'is', 'setPrototypeOf', 'hasOwn', 'getOwnPropertySymbols']),
  Array: new Set(['from', 'of']),
  Math: new Set(['trunc', 'sign', 'cbrt', 'hypot', 'log2', 'log10', 'imul', 'clz32']),
  Number: new Set(['isInteger', 'isSafeInteger', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'EPSILON', 'MAX_SAFE_INTEGER']),
  String: new Set(['fromCodePoint', 'raw']),
};

const ES6_PROTOTYPE_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'repeat',
  'padStart',
  'padEnd',
  'find',
  'findIndex',
  'flat',
  'flatMap',
  'fill',
  'copyWithin',
  'trimStart',
  'trimEnd',
  'replaceAll',
  'at',
]);

const JS_VALUE_PROPERTIES = new Set([
  'toFixed',
  'toString',
  'valueOf',
  'toPrecision',
  'toExponential',
  'length',
  'trim',
  'toUpperCase',
  'toLowerCase',
  'slice',
  'substring',
  'substr',
  'split',
  'indexOf',
  'lastIndexOf',
  'replace',
  'charAt',
  'charCodeAt',
  'match',
  'search',
  'concat',
]);

const PROTECTED_API_ROOTS = new Set([
  'Tag',
  'Variable',
  'Common',
  'Object',
  'Function',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Math',
  'Date',
  'JSON',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
]);

type AstNode = acorn.AnyNode & Record<string, unknown>;

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

function getStringLiteralValue(node: AstNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const q = node.quasis[0] as { value?: { cooked?: string; raw?: string } };
    return q.value?.cooked ?? q.value?.raw;
  }
  return undefined;
}

function getNumericLiteralValue(node: AstNode | null | undefined): number | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value)) {
    return node.value;
  }
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const inner = getNumericLiteralValue(node.argument as AstNode);
    if (inner !== undefined) return node.operator === '-' ? -inner : inner;
  }
  return undefined;
}

function evalStaticStringExpr(node: AstNode | null | undefined, trackedStrVars?: Map<string, string>): string | undefined {
  const lit = getStringLiteralValue(node);
  if (lit !== undefined) return lit;
  if (!node) return undefined;
  if (node.type === 'Identifier' && trackedStrVars?.has(String(node.name))) {
    return trackedStrVars.get(String(node.name));
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = evalStaticStringExpr(node.left as AstNode, trackedStrVars);
    const r = evalStaticStringExpr(node.right as AstNode, trackedStrVars);
    if (l !== undefined && r !== undefined) return l + r;
  }
  if (node.type === 'CallExpression') {
    const callee = node.callee as AstNode | undefined;
    const args = (node.arguments as AstNode[]) ?? [];
    if (callee && callee.type === 'MemberExpression') {
      const method = getMemberPropertyName(callee, trackedStrVars);
      const obj = callee.object as AstNode | undefined;
      if (method === 'fromCharCode' && obj?.type === 'Identifier' && String(obj.name) === 'String') {
        const codes: number[] = [];
        for (const a of args) {
          const n = getNumericLiteralValue(a);
          if (n === undefined) return undefined;
          codes.push(n);
        }
        return String.fromCharCode(...codes);
      }
      if (method === 'join' && obj?.type === 'ArrayExpression') {
        const sep = args.length === 0 ? ',' : evalStaticStringExpr(args[0], trackedStrVars);
        if (sep === undefined) return undefined;
        const parts: string[] = [];
        for (const el of (obj.elements as (AstNode | null)[]) ?? []) {
          if (!el) {
            parts.push('');
            continue;
          }
          const part = evalStaticStringExpr(el, trackedStrVars);
          if (part === undefined) return undefined;
          parts.push(part);
        }
        return parts.join(sep);
      }
      const baseStr = evalStaticStringExpr(obj, trackedStrVars);
      if (baseStr !== undefined && method) {
        if (method === 'slice' || method === 'substring') {
          const start = args.length >= 1 ? getNumericLiteralValue(args[0]) : 0;
          const end = args.length >= 2 ? getNumericLiteralValue(args[1]) : undefined;
          if (start === undefined || (args.length >= 2 && end === undefined)) return undefined;
          return method === 'slice' ? baseStr.slice(start, end) : baseStr.substring(start, end);
        }
        if (method === 'substr') {
          const start = args.length >= 1 ? getNumericLiteralValue(args[0]) : 0;
          const len = args.length >= 2 ? getNumericLiteralValue(args[1]) : undefined;
          if (start === undefined || (args.length >= 2 && len === undefined)) return undefined;
          return len === undefined ? baseStr.slice(start) : baseStr.slice(start, start + Math.max(0, len));
        }
        if (method === 'concat') {
          let out = baseStr;
          for (const a of args) {
            const s = evalStaticStringExpr(a, trackedStrVars);
            if (s === undefined) return undefined;
            out += s;
          }
          return out;
        }
        if (method === 'toLowerCase') return baseStr.toLowerCase();
        if (method === 'toUpperCase') return baseStr.toUpperCase();
        if (method === 'trim') return baseStr.trim();
      }
    }
  }
  return undefined;
}

function getMemberPropertyName(node: AstNode, trackedStrVars?: Map<string, string>): string | undefined {
  if (node.type !== 'MemberExpression') return undefined;
  const prop = node.property as AstNode | undefined;
  if (!prop) return undefined;
  if (!node.computed && prop.type === 'Identifier') return String(prop.name);
  if (node.computed) return evalStaticStringExpr(prop, trackedStrVars);
  return undefined;
}

function getMemberChain(node: AstNode | null | undefined, trackedStrVars?: Map<string, string>): string[] | null {
  if (!node) return null;
  if (node.type === 'Identifier') return [String(node.name)];
  if (node.type === 'MemberExpression') {
    const objChain = getMemberChain(node.object as AstNode, trackedStrVars);
    const propName = getMemberPropertyName(node, trackedStrVars);
    if (objChain && propName) return [...objChain, propName];
  }
  return null;
}

function isSafeNumericIndexExpr(node: AstNode | null | undefined, taintedStrVars: Set<string>): boolean {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'number') return true;
  if (node.type === 'Identifier') return !taintedStrVars.has(String(node.name));
  if (node.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-' || node.operator === '~')) {
    return isSafeNumericIndexExpr(node.argument as AstNode, taintedStrVars);
  }
  if (node.type === 'UpdateExpression') {
    return isSafeNumericIndexExpr(node.argument as AstNode, taintedStrVars);
  }
  if (
    node.type === 'BinaryExpression' &&
    ['-', '*', '/', '%', '<<', '>>', '>>>', '&', '|', '^'].includes(String(node.operator))
  ) {
    return (
      isSafeNumericIndexExpr(node.left as AstNode, taintedStrVars) &&
      isSafeNumericIndexExpr(node.right as AstNode, taintedStrVars)
    );
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = node.left as AstNode;
    const right = node.right as AstNode;
    if (getStringLiteralValue(left) !== undefined || getStringLiteralValue(right) !== undefined) return false;
    return isSafeNumericIndexExpr(left, taintedStrVars) && isSafeNumericIndexExpr(right, taintedStrVars);
  }
  return false;
}

function collectPatternNames(pattern: AstNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(String(pattern.name));
      break;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left as AstNode, out);
      break;
    case 'RestElement':
      collectPatternNames(pattern.argument as AstNode, out);
      break;
    case 'ArrayPattern':
      for (const el of (pattern.elements as (AstNode | null)[]) ?? []) {
        collectPatternNames(el, out);
      }
      break;
    case 'ObjectPattern':
      for (const prop of (pattern.properties as AstNode[]) ?? []) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument as AstNode, out);
        else collectPatternNames(prop.value as AstNode, out);
      }
      break;
  }
}

function collectHoistedVars(node: AstNode | null | undefined, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') {
    const id = node.id as AstNode | null;
    if (id && id.type === 'Identifier') out.add(String(id.name));
    return; // Do not cross into nested function scope
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return;
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const decl of (node.declarations as AstNode[]) ?? []) {
      collectPatternNames(decl.id as AstNode, out);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && 'type' in item) {
          collectHoistedVars(item as AstNode, out);
        }
      }
    } else if (val && typeof val === 'object' && 'type' in val) {
      collectHoistedVars(val as AstNode, out);
    }
  }
}

function isAlwaysTruthyTest(node: AstNode | null | undefined): boolean {
  if (!node) return true; // `for (;;)` has null test
  if (node.type === 'Literal') {
    return node.value === true || (typeof node.value === 'number' && node.value !== 0 && !Number.isNaN(node.value));
  }
  if (node.type === 'UnaryExpression' && node.operator === '!' && (node.argument as AstNode)?.type === 'Literal') {
    const v = (node.argument as AstNode).value;
    return v === 0 || v === false || v === '' || v === null;
  }
  if (
    node.type === 'BinaryExpression' &&
    (node.left as AstNode)?.type === 'Literal' &&
    (node.right as AstNode)?.type === 'Literal'
  ) {
    const l = (node.left as AstNode).value;
    const r = (node.right as AstNode).value;
    if (node.operator === '==' || node.operator === '===') return l === r;
    if (node.operator === '<' && typeof l === 'number' && typeof r === 'number') return l < r;
    if (node.operator === '>' && typeof l === 'number' && typeof r === 'number') return l > r;
  }
  return false;
}

function loopBodyHasExit(node: AstNode | null | undefined, inNestedBreakTarget = false): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
    return true;
  }
  if (node.type === 'BreakStatement') {
    return !inNestedBreakTarget || Boolean(node.label);
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
    return false;
  }
  const nextNested =
    inNestedBreakTarget ||
    node.type === 'SwitchStatement' ||
    node.type === 'WhileStatement' ||
    node.type === 'DoWhileStatement' ||
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement';
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      if (val.some((item) => item && typeof item === 'object' && 'type' in item && loopBodyHasExit(item as AstNode, nextNested))) {
        return true;
      }
    } else if (val && typeof val === 'object' && 'type' in val && loopBodyHasExit(val as AstNode, nextNested)) {
      return true;
    }
  }
  return false;
}

function containsDateOrGetTimeCall(node: AstNode | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'CallExpression') {
    const callee = node.callee as AstNode;
    const chain = getMemberChain(callee);
    if (chain && (chain.join('.') === 'Date.now' || chain[chain.length - 1] === 'getTime')) {
      return true;
    }
    if (callee && callee.type === 'MemberExpression' && getMemberPropertyName(callee) === 'getTime') {
      return true;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && 'type' in item && containsDateOrGetTimeCall(item as AstNode)) {
          return true;
        }
      }
    } else if (val && typeof val === 'object' && 'type' in val && containsDateOrGetTimeCall(val as AstNode)) {
      return true;
    }
  }
  return false;
}

function isFeatureDetectionNode(parent: AstNode | null, parentKey: string | null): boolean {
  if (!parent) return false;
  if ((parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') && parentKey === 'test') return true;
  if (parent.type === 'LogicalExpression') return true;
  if (parent.type === 'UnaryExpression' && (parent.operator === '!' || parent.operator === 'typeof')) return true;
  if (
    parent.type === 'BinaryExpression' &&
    (parent.operator === '==' || parent.operator === '!=' || parent.operator === '===' || parent.operator === '!==')
  ) {
    return true;
  }
  return false;
}

function astContainsIdentifierMatching(node: AstNode | null | undefined, re: RegExp): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier' && re.test(String(node.name))) return true;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      if (val.some((item) => item && typeof item === 'object' && 'type' in item && astContainsIdentifierMatching(item as AstNode, re))) {
        return true;
      }
    } else if (val && typeof val === 'object' && 'type' in val && astContainsIdentifierMatching(val as AstNode, re)) {
      return true;
    }
  }
  return false;
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
      fixHint:
        'Provide executable Strict-ES5 Haiwell JavaScript statements using $Device.Var, Variable.GetByFullName, Tag.Read/Tag.Write, or Common.* APIs.',
    });
    return { valid: false, referencedTags: [], writtenTags: [], diagnostics };
  }

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
    if (!triggerMeta.triggerTag || !resolveKnownTagName(triggerMeta.triggerTag, knownTags)) {
      diagnostics.push({
        code: 'HWJS-TRG-002',
        severity: 'ERROR',
        message: `TAG_CHANGE script triggerTag "${triggerMeta.triggerTag ?? ''}" is missing or undeclared.`,
        fixHint: 'Bind triggerTag to an existing project tag.',
      });
    }
  }

  // 1. Parse full JS AST (ES2020) — catches all syntax/delimiter errors cleanly without regex guesses
  let ast: AstNode;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2020,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      locations: true,
    }) as unknown as AstNode;
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    const locStr = e.loc ? ` at line ${e.loc.line}, col ${e.loc.column + 1}` : '';
    diagnostics.push({
      code: 'HWJS-SYN-001',
      severity: 'ERROR',
      message: `JavaScript syntax error${locStr}: ${e.message}`,
      fixHint: 'Fix syntax, missing semicolons/operands, or unbalanced (), {}, [] delimiters.',
    });
    return { valid: false, referencedTags: [], writtenTags: [], diagnostics };
  }

  // 2. Check Strict ES5 syntax compatibility via Acorn ecmaVersion: 5
  let es5ParseError: string | null = null;
  try {
    acorn.parse(code, {
      ecmaVersion: 5,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    es5ParseError = (err as Error).message;
  }

  const es6SyntaxFeatures = new Set<string>();
  const es6RuntimeApis = new Set<string>();
  const forbiddenHits = new Set<string>();
  const allIdentifierNames = new Set<string>();
  const trackedStrVars = new Map<string, string>();
  const taintedStrVars = new Set<string>();
  const localObjVars = new Set<string>();
  const pendingWrites: { rawRef: string; apiLabel: string; nodeStart: number }[] = [];
  let hasGenuineEStopCheck = false;
  let earliestEStopReadStart = Number.POSITIVE_INFINITY;
  let hasDatabaseCall = false;
  let hasUncoveredAjaxCall = false;
  let hasInfiniteLoop = false;
  let hasBusyWaitLoop = false;
  let nonOfficialLogHit: string | null = null;

  const recordRead = (rawRef: string, apiLabel: string, nodeStart = 0, isDiscarded = false) => {
    const resolved = resolveKnownTagName(rawRef, knownTags);
    const key = resolved ?? rawRef;
    referencedTags.add(key);
    const tagDef = resolved ? knownTags[resolved] : undefined;
    if (
      !isDiscarded &&
      (resolved === 'EStop_OK' ||
        rawRef === 'EStop_OK' ||
        rawRef.endsWith('.EStop_OK') ||
        (tagDef?.safetyClass === 'SIL3' && /estop|e_stop|emergency/i.test(resolved ?? rawRef)))
    ) {
      hasGenuineEStopCheck = true;
      if (nodeStart < earliestEStopReadStart) {
        earliestEStopReadStart = nodeStart;
      }
    }
    if (!resolved) {
      diagnostics.push({
        code: 'HWJS-TAG-001',
        severity: 'ERROR',
        message: `${apiLabel} references undeclared tag "${rawRef}".`,
        fixHint: `Create tag "${rawRef}" via haiwell_tag_upsert_batch before referencing it.`,
      });
    } else if (tagDef?.access === 'WO') {
      diagnostics.push({
        code: 'HWJS-SAFE-004',
        severity: 'WARNING',
        message: `${apiLabel} reads write-only tag "${tagDef.name}".`,
        fixHint: `Avoid reading write-only tag "${tagDef.name}"; use a RW tag or feedback input instead.`,
      });
    }
  };

  const recordWriteDeferred = (rawRef: string, apiLabel: string, nodeStart = 0) => {
    const resolved = resolveKnownTagName(rawRef, knownTags);
    const key = resolved ?? rawRef;
    referencedTags.add(key);
    writtenTags.add(key);
    pendingWrites.push({ rawRef, apiLabel, nodeStart });
  };

  // Lexical scope stack
  const scopes: Set<string>[] = [];
  const rootScope = new Set<string>();
  collectHoistedVars(ast, rootScope);
  scopes.push(rootScope);

  const isBoundInScope = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  };

  const isWriteTarget = (parent: AstNode | null, key: string | null): boolean => {
    if (!parent) return false;
    if (parent.type === 'AssignmentExpression' && key === 'left') return true;
    if (parent.type === 'UpdateExpression' && key === 'argument') return true;
    if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') return true;
    return false;
  };

  const walk = (node: AstNode | null | undefined, parent: AstNode | null, parentKey: string | null): void => {
    if (!node || typeof node !== 'object' || !node.type) return;

    // Push lexical scopes
    let pushedScope = false;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const fnScope = new Set<string>();
      const id = node.id as AstNode | null | undefined;
      if (id && id.type === 'Identifier') fnScope.add(String(id.name));
      for (const p of (node.params as AstNode[]) ?? []) {
        collectPatternNames(p, fnScope);
      }
      collectHoistedVars(node.body as AstNode, fnScope);
      scopes.push(fnScope);
      pushedScope = true;
    } else if (
      node.type === 'BlockStatement' ||
      node.type === 'SwitchStatement' ||
      node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement'
    ) {
      const blkScope = new Set<string>();
      const list =
        node.type === 'BlockStatement'
          ? ((node.body as AstNode[]) ?? [])
          : node.type === 'SwitchStatement'
            ? ((node.cases as AstNode[]) ?? []).flatMap((c) => ((c.consequent as AstNode[]) ?? []))
            : [];
      for (const stmt of list) {
        if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'let' || stmt.kind === 'const')) {
          for (const decl of (stmt.declarations as AstNode[]) ?? []) {
            collectPatternNames(decl.id as AstNode, blkScope);
          }
        } else if (stmt.type === 'ClassDeclaration' && (stmt.id as AstNode | null)?.type === 'Identifier') {
          blkScope.add(String((stmt.id as AstNode).name));
        }
      }
      if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        const initOrLeft = (node.init ?? node.left) as AstNode | null | undefined;
        if (initOrLeft && initOrLeft.type === 'VariableDeclaration' && (initOrLeft.kind === 'let' || initOrLeft.kind === 'const')) {
          for (const decl of (initOrLeft.declarations as AstNode[]) ?? []) {
            collectPatternNames(decl.id as AstNode, blkScope);
          }
        }
      }
      scopes.push(blkScope);
      pushedScope = true;
    } else if (node.type === 'CatchClause') {
      const catchScope = new Set<string>();
      collectPatternNames(node.param as AstNode, catchScope);
      scopes.push(catchScope);
      pushedScope = true;
    }

    // Track static string variables, compound += string mutations & local object-literal variables
    if (node.type === 'VariableDeclarator' && (node.id as AstNode)?.type === 'Identifier') {
      const varName = String((node.id as AstNode).name);
      const init = node.init as AstNode | null | undefined;
      const staticStr = evalStaticStringExpr(init, trackedStrVars);
      if (staticStr !== undefined) {
        trackedStrVars.set(varName, staticStr);
        taintedStrVars.add(varName);
      } else {
        trackedStrVars.delete(varName);
        if (init && !isSafeNumericIndexExpr(init, taintedStrVars)) {
          taintedStrVars.add(varName);
        }
      }
      if (init?.type === 'ObjectExpression') localObjVars.add(varName);
    } else if (
      node.type === 'AssignmentExpression' &&
      (node.operator === '=' || node.operator === '+=') &&
      (node.left as AstNode)?.type === 'Identifier'
    ) {
      const varName = String((node.left as AstNode).name);
      const right = node.right as AstNode | null | undefined;
      const rightStr = evalStaticStringExpr(right, trackedStrVars);
      if (node.operator === '=') {
        if (rightStr !== undefined) {
          trackedStrVars.set(varName, rightStr);
          taintedStrVars.add(varName);
        } else {
          trackedStrVars.delete(varName);
          if (right && !isSafeNumericIndexExpr(right, taintedStrVars)) {
            taintedStrVars.add(varName);
          }
        }
        if (right?.type === 'ObjectExpression') localObjVars.add(varName);
      } else {
        // Compound += string concatenation
        const prevStr = trackedStrVars.get(varName);
        if (prevStr !== undefined && rightStr !== undefined) {
          trackedStrVars.set(varName, prevStr + rightStr);
          taintedStrVars.add(varName);
        } else {
          trackedStrVars.delete(varName);
          if (rightStr !== undefined || (right && !isSafeNumericIndexExpr(right, taintedStrVars))) {
            taintedStrVars.add(varName);
          }
        }
      }
    }

    // Collect ES6+ syntax node features & forbidden statements/patterns
    if (node.type === 'WithStatement') {
      forbiddenHits.add('with');
    } else if (node.type === 'ObjectPattern') {
      es6SyntaxFeatures.add('destructuring');
      for (const prop of (node.properties as AstNode[]) ?? []) {
        if (prop.type === 'Property') {
          const k = prop.key as AstNode;
          const keyName = !prop.computed && k?.type === 'Identifier' ? String(k.name) : evalStaticStringExpr(k, trackedStrVars);
          if (keyName && FORBIDDEN_PROPERTIES.has(keyName)) {
            forbiddenHits.add(keyName);
          }
        }
      }
    } else if (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) {
      es6SyntaxFeatures.add(String(node.kind));
    } else if (node.type === 'ArrowFunctionExpression') {
      es6SyntaxFeatures.add('arrow function (=>)');
    } else if (node.type === 'TemplateLiteral') {
      es6SyntaxFeatures.add('template literal (`...`)');
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      es6SyntaxFeatures.add('class');
    } else if (node.type === 'SpreadElement' || node.type === 'RestElement') {
      es6SyntaxFeatures.add('spread/rest (...)');
    } else if (node.type === 'ForOfStatement') {
      es6SyntaxFeatures.add('for..of');
    } else if (node.type === 'ArrayPattern') {
      es6SyntaxFeatures.add('destructuring');
    } else if (node.type === 'AssignmentPattern') {
      es6SyntaxFeatures.add('default parameters');
    } else if (node.type === 'ImportExpression') {
      forbiddenHits.add('import');
    }
    if (node.async === true) es6SyntaxFeatures.add('async');
    if (node.type === 'AwaitExpression') es6SyntaxFeatures.add('await');

    // Blocking loops & busy-wait checks
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
      if (isAlwaysTruthyTest(node.test as AstNode) && !loopBodyHasExit(node.body as AstNode)) {
        hasInfiniteLoop = true;
      }
      if (containsDateOrGetTimeCall(node.test as AstNode) || containsDateOrGetTimeCall(node.body as AstNode)) {
        hasBusyWaitLoop = true;
      }
    } else if (node.type === 'ForStatement') {
      if (isAlwaysTruthyTest(node.test as AstNode | null) && !loopBodyHasExit(node.body as AstNode)) {
        hasInfiniteLoop = true;
      }
      if (containsDateOrGetTimeCall(node.test as AstNode | null) || containsDateOrGetTimeCall(node.body as AstNode)) {
        hasBusyWaitLoop = true;
      }
    }

    // Block indirect `this` aliasing (e.g. `var g = this; g.process;`, `return this;`, `this[dyn]`)
    if (node.type === 'ThisExpression') {
      const isDirectStaticMember =
        parent?.type === 'MemberExpression' && parentKey === 'object' && !parent.computed;
      if (!isDirectStaticMember) {
        forbiddenHits.add('this');
      }
    }

    // Forbidden property access (__proto__, constructor, prototype, this.<global>, dynamic computed property escapes, Object/Reflect prototype APIs) & $Device.Tag / ES6 static APIs
    if (node.type === 'MemberExpression') {
      const propName = getMemberPropertyName(node, trackedStrVars);
      if (propName && FORBIDDEN_PROPERTIES.has(propName)) {
        forbiddenHits.add(propName);
      }
      if ((node.object as AstNode)?.type === 'ThisExpression' && propName && FORBIDDEN_UNBOUND_GLOBALS.has(propName)) {
        forbiddenHits.add(propName);
      }

      if (node.computed && propName === undefined) {
        const propNode = node.property as AstNode | undefined;
        const objChainRoot = getMemberChain(node.object as AstNode, trackedStrVars)?.[0];
        const isProtectedTarget =
          (node.object as AstNode)?.type === 'ThisExpression' ||
          (objChainRoot !== undefined && PROTECTED_API_ROOTS.has(objChainRoot) && !isBoundInScope(objChainRoot)) ||
          (node.object as AstNode)?.type === 'FunctionExpression' ||
          (node.object as AstNode)?.type === 'ArrowFunctionExpression';
        const isSafeIndex = isSafeNumericIndexExpr(propNode, taintedStrVars);
        if (!isSafeIndex || isProtectedTarget) {
          forbiddenHits.add('computed-property-access');
        }
      }

      const chain = getMemberChain(node, trackedStrVars);
      if (chain && chain.length === 2) {
        const [objName, methodName] = chain;
        if (FORBIDDEN_PROTOTYPE_APIS[objName]?.has(methodName) && !isBoundInScope(objName)) {
          forbiddenHits.add(`${objName}.${methodName}`);
        }
        if (
          ES6_STATIC_METHODS[objName]?.has(methodName) &&
          !isBoundInScope(objName) &&
          !isFeatureDetectionNode(parent, parentKey)
        ) {
          es6RuntimeApis.add(`${objName}.${methodName}()`);
        }
        const parentProp = parent?.type === 'MemberExpression' ? getMemberPropertyName(parent, trackedStrVars) : undefined;
        const isAllowedValueMember =
          parent?.type !== 'MemberExpression' ||
          (parentKey === 'object' && parentProp !== undefined && JS_VALUE_PROPERTIES.has(parentProp));
        // Native Haiwell $Device.Tag access (or $InternalTag.toFixed())
        if (objName.startsWith('$') && objName.length > 1 && isAllowedValueMember) {
          const internalCandidate = objName.slice(1);
          const fullRef = `${internalCandidate}.${methodName}`;
          const nodeStart = typeof node.start === 'number' ? node.start : 0;
          const isDiscarded = parent?.type === 'ExpressionStatement' && parentKey === 'expression';
          if (
            JS_VALUE_PROPERTIES.has(methodName) &&
            resolveKnownTagName(internalCandidate, knownTags) &&
            !resolveKnownTagName(fullRef, knownTags)
          ) {
            recordRead(internalCandidate, objName, nodeStart, isDiscarded);
          } else if (isWriteTarget(parent, parentKey)) {
            recordWriteDeferred(fullRef, `$${fullRef}`, nodeStart);
          } else {
            recordRead(fullRef, `$${fullRef}`, nodeStart, isDiscarded);
          }
        }
      }
    }

    // Identifier checks (unbound globals, Object aliasing, single-level $InternalTag)
    if (node.type === 'Identifier') {
      const name = String(node.name);
      const isDeclOrPropKey =
        (parent?.type === 'VariableDeclarator' && parentKey === 'id') ||
        (parent?.type === 'FunctionDeclaration' && parentKey === 'id') ||
        (parent?.type === 'FunctionExpression' && parentKey === 'id') ||
        ((parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression') && parentKey === 'id') ||
        (parent?.type === 'MethodDefinition' && parentKey === 'key' && !parent.computed) ||
        (parent?.type === 'Property' && parentKey === 'key' && !parent.computed) ||
        (parent?.type === 'MemberExpression' && parentKey === 'property' && !parent.computed) ||
        (parent?.type === 'LabeledStatement' && parentKey === 'label') ||
        (parent?.type === 'BreakStatement' && parentKey === 'label') ||
        (parent?.type === 'ContinueStatement' && parentKey === 'label') ||
        parent?.type === 'ObjectPattern' ||
        parent?.type === 'ArrayPattern' ||
        (parent?.type === 'AssignmentPattern' && parentKey === 'left') ||
        (parent?.type === 'RestElement' && parentKey === 'argument');

      allIdentifierNames.add(name);

      if (!isDeclOrPropKey) {
        if (!isBoundInScope(name)) {
          if (FORBIDDEN_UNBOUND_GLOBALS.has(name)) {
            forbiddenHits.add(name);
          }
          // Block aliasing `Object` global (e.g. `var O = Object; O.getPrototypeOf(...)` or `Object[k]`)
          if (
            name === 'Object' &&
            !(parent?.type === 'MemberExpression' && parentKey === 'object' && !parent.computed)
          ) {
            forbiddenHits.add('Object');
          }
          if (ES6_RUNTIME_GLOBALS.has(name)) {
            es6RuntimeApis.add(name);
          }
          // Single-level $InternalTag (only when not the object of `$Device.Tag`)
          if (
            name.startsWith('$') &&
            name.length > 1 &&
            !(parent?.type === 'MemberExpression' && parentKey === 'object')
          ) {
            const bare = name.slice(1);
            const nodeStart = typeof node.start === 'number' ? node.start : 0;
            const isDiscarded = parent?.type === 'ExpressionStatement' && parentKey === 'expression';
            if (isWriteTarget(parent, parentKey)) {
              recordWriteDeferred(bare, name, nodeStart);
            } else {
              recordRead(bare, name, nodeStart, isDiscarded);
            }
          }
        }
      }
    }

    // CallExpression inspection: Tag.*, Variable.*, Common.*, ES6 prototype methods
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode;
      const args = (node.arguments as AstNode[]) ?? [];
      const chain = getMemberChain(callee, trackedStrVars);
      const nodeStart = typeof node.start === 'number' ? node.start : 0;
      const isDiscarded = parent?.type === 'ExpressionStatement' && parentKey === 'expression';

      if (callee.type === 'MemberExpression') {
        const methodName = getMemberPropertyName(callee, trackedStrVars);
        const calleeObj = callee.object as AstNode | undefined;
        const isLocalObjLiteralMethod =
          calleeObj?.type === 'ObjectExpression' ||
          (calleeObj?.type === 'Identifier' && localObjVars.has(String(calleeObj.name)));
        if (methodName && ES6_PROTOTYPE_METHODS.has(methodName) && !isLocalObjLiteralMethod) {
          es6RuntimeApis.add(`.${methodName}()`);
        }
      }

      if (chain) {
        const joined = chain.join('.');
        if (joined === 'Tag.Read' || joined === 'Variable.GetByFullName') {
          const tagArg = evalStaticStringExpr(args[0], trackedStrVars);
          if (tagArg) recordRead(tagArg, joined, nodeStart, isDiscarded);
        } else if (joined === 'Tag.Write' || joined === 'Variable.SetByFullName') {
          const tagArg = evalStaticStringExpr(args[0], trackedStrVars);
          if (tagArg) {
            recordWriteDeferred(tagArg, joined, nodeStart);
          } else if (args.length > 0) {
            diagnostics.push({
              code: 'HWJS-TAG-003',
              severity: 'WARNING',
              message: `${joined} uses a dynamic tag name expression that cannot be statically audited for RO/SIL interlock safety.`,
              fixHint: 'Use a literal tag name string in Tag.Write / Variable.SetByFullName so RO and SIL2/SIL3 interlocks can be verified.',
            });
          }
        } else if (joined === 'Variable.BatchSetByFullNames') {
          const arg0 = args[0];
          if (arg0 && arg0.type === 'ObjectExpression') {
            for (const prop of (arg0.properties as AstNode[]) ?? []) {
              if (prop.type === 'Property') {
                const k = prop.key as AstNode;
                const tagKey =
                  !prop.computed && k.type === 'Identifier'
                    ? String(k.name)
                    : evalStaticStringExpr(k, trackedStrVars);
                if (tagKey) recordWriteDeferred(tagKey, 'Variable.BatchSetByFullNames', nodeStart);
              }
            }
          }
        } else if (joined === 'System.Log' || joined === 'Common.Log') {
          nonOfficialLogHit = joined;
        } else if (joined === 'Common.database.execTransaction') {
          hasDatabaseCall = true;
          const arg0 = args[0];
          if (arg0 && arg0.type !== 'ArrayExpression') {
            const arg0Chain = arg0.type === 'CallExpression' ? getMemberChain(arg0.callee as AstNode) : null;
            const isSlice = Boolean(arg0Chain && arg0Chain[arg0Chain.length - 1] === 'slice');
            if (!isSlice) {
              const argName = arg0.type === 'Identifier' ? String(arg0.name) : 'sqls';
              diagnostics.push({
                code: 'HWJS-RT-001',
                severity: 'WARNING',
                message: `Common.database.execTransaction(${argName}) mutates the SQL array in-place in Haiwell 3.50.x database.ts.`,
                fixHint: `Pass a shallow copy: Common.database.execTransaction(${argName}.slice(), callback).`,
              });
            }
          }
        } else if (joined === 'Common.database.exec' || joined === 'Common.database.query') {
          hasDatabaseCall = true;
        } else if (joined === 'Common.Ajax') {
          const guardRe = /^(?:handled|done|settled|called|ajaxDone)$/i;
          const callbackNodes = args.filter(
            (a) =>
              a &&
              (a.type === 'FunctionExpression' ||
                a.type === 'ArrowFunctionExpression' ||
                a.type === 'ObjectExpression')
          );
          const hasGuardInCallback =
            callbackNodes.length > 0 &&
            callbackNodes.some((cb) => astContainsIdentifierMatching(cb, guardRe));
          if (!hasGuardInCallback) {
            hasUncoveredAjaxCall = true;
          }
        }
      }
    }

    // Recurse into child nodes
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && 'type' in item) {
            walk(item as AstNode, node, key);
          }
        }
      } else if (val && typeof val === 'object' && 'type' in val) {
        walk(val as AstNode, node, key);
      }
    }

    if (pushedScope) {
      scopes.pop();
    }
  };

  walk(ast, null, null);

  // Emit diagnostics collected from AST walk
  if (es5ParseError || es6SyntaxFeatures.size > 0) {
    const features = es6SyntaxFeatures.size > 0 ? [...es6SyntaxFeatures].join(', ') : es5ParseError ?? 'ES6+ syntax';
    diagnostics.push({
      code: 'HWJS-ES5-001',
      severity: enforceStrictEs5 ? 'ERROR' : 'WARNING',
      message: `ES6+ syntax [${features}] will crash with SyntaxError on real Haiwell ARM Linux HMIs (Node.js v0.10.41 runtime).`,
      fixHint:
        'Use Strict ES5: var declarations, function(){} expressions, string concatenation (+), and classic for loops instead of const/let/=>/backticks/destructuring.',
    });
  }

  if (es6RuntimeApis.size > 0) {
    diagnostics.push({
      code: 'HWJS-ES5-002',
      severity: enforceStrictEs5 ? 'ERROR' : 'WARNING',
      message: `ES6+ runtime API [${[...es6RuntimeApis].join(', ')}] is unavailable on Haiwell ARM Linux HMIs (Node.js v0.10.41 runtime).`,
      fixHint: 'Replace ES6+ runtime APIs (Object.assign, .includes, Promise, Map, Set, Math.trunc) with ES5 equivalents.',
    });
  }

  if (hasInfiniteLoop) {
    diagnostics.push({
      code: 'HWJS-SAFE-001',
      severity: 'ERROR',
      message: 'Infinite loop detected which blocks the Haiwell SCADA runtime thread.',
      fixHint:
        'Configure a CYCLIC trigger interval or Common.SetInterval inside a STARTUP task instead of looping indefinitely.',
    });
  }

  if (hasBusyWaitLoop) {
    diagnostics.push({
      code: 'HWJS-RT-004',
      severity: 'WARNING',
      message:
        'Blocking busy-wait loop on Date/getTime() freezes the single-threaded Haiwell Node.js event loop and stalls Modbus/UI responsiveness.',
      fixHint: 'Use non-blocking Common.SetTimeout(function() { ... }, delayMs) for momentary pulse unlatching.',
    });
  }

  if (hasDatabaseCall) {
    const hasQueueGuard = [...allIdentifierNames].some((n) =>
      /^(?:queue|dbQueue|fifo|inFlight|dbBusy|isBusy|mutex)$/i.test(n)
    );
    if (!hasQueueGuard) {
      diagnostics.push({
        code: 'HWJS-RT-002',
        severity: 'WARNING',
        message:
          'Common.database.* opens a fresh sqlite3 handle per call without busy_timeout on Haiwell 3.50.x, risking SQLITE_BUSY errors under concurrent triggers.',
        fixHint: 'Serialize all Common.database.* operations through a single ES5 FIFO queue (e.g., dbQueue + dbBusy flag).',
      });
    }
  }

  if (hasUncoveredAjaxCall) {
    diagnostics.push({
      code: 'HWJS-RT-003',
      severity: 'WARNING',
      message:
        'Common.Ajax callback lacks an idempotent guard flag (Haiwell goHttp.js may emit stderr warnings before stdout close).',
      fixHint: 'Add a boolean guard (e.g., var handled = false; if (handled) return; handled = true;) inside the Common.Ajax callback.',
    });
  }

  if (nonOfficialLogHit) {
    diagnostics.push({
      code: 'HWJS-API-001',
      severity: 'WARNING',
      message: `"${nonOfficialLogHit}()" is not a documented Haiwell Cloud SCADA 3.50.x JS API.`,
      fixHint:
        'Use the official Haiwell logging API: Common.logger.info("%s", message) (levels: log, debug, info, trace, warn, note, error; live viewer at http://<HMI_IP>/dev/logs.html).',
    });
  }

  for (const sym of forbiddenHits) {
    diagnostics.push({
      code: 'HWJS-SEC-001',
      severity: 'ERROR',
      message: `Forbidden sandbox/host symbol "${sym}" detected.`,
      fixHint:
        'Restrict scripts to documented Haiwell Cloud SCADA APIs: $Device.Var, Variable.GetByFullName/SetByFullName, Common.logger.*, Common.SetTimeout/SetInterval, Common.database.*, Common.Ajax, Math, Date, JSON.',
    });
  }

  // Validate deferred writes now that full AST EStop_OK check is complete
  for (const { rawRef, apiLabel, nodeStart } of pendingWrites) {
    const resolved = resolveKnownTagName(rawRef, knownTags);
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
      if (
        (tag.safetyClass === 'SIL2' || tag.safetyClass === 'SIL3') &&
        (!hasGenuineEStopCheck || earliestEStopReadStart >= nodeStart)
      ) {
        diagnostics.push({
          code: 'HWJS-SAFE-003',
          severity: 'WARNING',
          message: `Script writes to ${tag.safetyClass} tag "${tag.name}" without checking EStop_OK interlock beforehand.`,
          fixHint: 'Read and evaluate EStop_OK (e.g., var ok = Variable.GetByFullName("EStop_OK"); if (ok) { ... }) before writing to safety-critical outputs.',
        });
      }
    }
  }

  return {
    valid: diagnostics.every((d) => d.severity !== 'ERROR'),
    referencedTags: [...referencedTags],
    writtenTags: [...writtenTags],
    diagnostics,
  };
}
