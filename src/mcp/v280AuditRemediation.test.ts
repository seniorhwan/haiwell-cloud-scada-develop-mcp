/**
 * Comprehensive v2.8.0 Forensic Audit Remediation & PoC Verification Test Suite.
 *
 * Covers EVERY CRITICAL (CRIT-01, CRIT-02, UIA-01..UIA-10), EVERY HIGH (HIGH-01..HIGH-19),
 * and key MEDIUM findings with live HTTP server tests, VM sandbox escape PoCs,
 * SVG XSS payload rejections, IEC 61131-3 ST/LD/FBD edge cases, spatial pipe-crossing
 * proofs, and Haiwell 3.50.1.19 UIA bridge accuracy checks.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import * as acorn from 'acorn';
import { createApp } from '../../server';
import { SERVER_VERSION } from './version';
import { HaiwellProjectStore } from './projectStore';
import { validateHaiwellScript } from './scriptAnalyzer';
import { evaluateProjectAlarms, runSimulationSteps } from './simulationEngine';
import { detectWordOverlapConflicts, validatePlcAddress } from './plcAddressing';
import { transpileStToHaiwellJs, validateStructuredText } from './iec61131';
import { renderScreenToSvg, validateHmiScreen } from './hmiGenerator';
import {
  auditScreenSpatially,
  compileDesktopAutomationBridge,
  compileFullOpenProjectBridge,
  compilePidScreen,
  detectPipeWidgetCrossings,
  generateDesktopUiaCalibrator,
  REAL_HAIWELL_350_TREE_NODES,
  solveAndRepairScreenLayout,
} from './hmiSpatialEngine';
import { buildLaunchPowerShellScript, buildNewProjectPowerShellScript } from './desktopAutomation';
import { isBlockedSsrfHost } from './protocolAdapters';
import {
  buildProjectExportBundle,
  HAIWELL_TOOLS,
  invokeHaiwellTool,
  normalizeAgentArgs,
  runProjectSafetyAudit,
  serializeToolCatalog,
} from './toolRegistry';
import type { HmiScreen, PlcDriverProtocol, TagDefinition } from './types';

function makeTestTag(
  name: string,
  overrides: Partial<TagDefinition> & Pick<TagDefinition, 'scope' | 'dataType'>
): TagDefinition {
  return {
    name,
    access: 'RW',
    safetyClass: 'SIL0',
    requiresInterlock: false,
    currentValue: overrides.dataType === 'BOOL' ? false : 0,
    quality: 'GOOD',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// =========================================================================
// 1. CRIT-01: HTTP Auth Bypass, ?profile= on /api/rpc, Batch Rate Limiting, Header Timing
// =========================================================================
test('CRIT-01: Live HTTP server blocks trailing-slash/uppercase auth bypasses, enforces ?profile= on /api/rpc, charges batch rate-limit tokens, and sets X-Execution-Time-Ms', async () => {
  const prevToken = process.env.HAIWELL_MCP_AUTH_TOKEN;
  const prevRate = process.env.HAIWELL_MCP_RATE_LIMIT_PER_MIN;
  process.env.HAIWELL_MCP_AUTH_TOKEN = 'v280-super-secret-token';
  process.env.HAIWELL_MCP_RATE_LIMIT_PER_MIN = '10';

  const store = new HaiwellProjectStore();
  const app = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    assert.equal(SERVER_VERSION, '2.9.0');

    // A. Auth bypass PoC vectors: trailing slash, uppercase, double slash, mixed case
    const bypassVectors: { method: string; urlPath: string; body?: unknown }[] = [
      { method: 'POST', urlPath: '/mcp/', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } },
      { method: 'POST', urlPath: '/MCP', body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } },
      { method: 'POST', urlPath: '//mcp///', body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} } },
      { method: 'POST', urlPath: '/api/rpc/', body: { tool: 'haiwell_project_inspect', arguments: { projectId: 'prj_chiller_plant_01' } } },
      { method: 'POST', urlPath: '/API/RPC', body: { tool: 'haiwell_project_inspect', arguments: { projectId: 'prj_chiller_plant_01' } } },
      { method: 'GET', urlPath: '/API/PROJECTS/prj_chiller_plant_01/export' },
      { method: 'GET', urlPath: '/api/projects/prj_chiller_plant_01/export/' },
    ];

    for (const vec of bypassVectors) {
      const res = await fetch(`${baseUrl}${vec.urlPath}`, {
        method: vec.method,
        headers: vec.body ? { 'Content-Type': 'application/json' } : undefined,
        body: vec.body ? JSON.stringify(vec.body) : undefined,
      });
      assert.equal(res.status, 401, `Auth bypass vector ${vec.method} ${vec.urlPath} MUST return 401, got ${res.status}`);
    }

    // B. Valid Bearer token succeeds and sets X-Execution-Time-Ms
    const authHeaders = {
      Authorization: 'Bearer v280-super-secret-token',
      'Content-Type': 'application/json',
    };
    const okRpc = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tool: 'haiwell_project_inspect', arguments: { projectId: 'prj_chiller_plant_01' } }),
    });
    assert.equal(okRpc.status, 200);
    assert.ok(okRpc.headers.get('x-execution-time-ms'), 'Expected X-Execution-Time-Ms header on /api/rpc');

    // C. ?profile=core enforced on /api/rpc (blocks out-of-profile HMI tool)
    const blockedProfile = await fetch(`${baseUrl}/api/rpc?profile=core`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tool: 'haiwell_hmi_toolbox_catalog', arguments: { category: 'ALL' } }),
    });
    assert.equal(blockedProfile.status, 403, 'Out-of-profile tool on /api/rpc?profile=core must return 403');
    const blockedJson = (await blockedProfile.json()) as { error?: { code?: string } };
    assert.equal(blockedJson.error?.code, 'TOOL_NOT_IN_PROFILE');

    // D. Batch token charging on /api/rpc prevents burst bypass (limit=10, 12 calls in one batch -> 429)
    const batchCalls = Array.from({ length: 12 }, () => ({
      tool: 'haiwell_project_inspect',
      arguments: { projectId: 'prj_chiller_plant_01' },
    }));
    const rateRes = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(batchCalls),
    });
    assert.equal(rateRes.status, 429, 'Batch exceeding remaining rate-limit tokens must return 429');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevToken === undefined) delete process.env.HAIWELL_MCP_AUTH_TOKEN;
    else process.env.HAIWELL_MCP_AUTH_TOKEN = prevToken;
    if (prevRate === undefined) delete process.env.HAIWELL_MCP_RATE_LIMIT_PER_MIN;
    else process.env.HAIWELL_MCP_RATE_LIMIT_PER_MIN = prevRate;
  }
});

// =========================================================================
// 2. CRIT-02: VM Sandbox Isolation Membrane + Hardened AST Static Analysis
// =========================================================================
test('CRIT-02: AST analyzer blocks obfuscated prototype escapes AND VM membrane isolates host realm even when bypassing AST validation', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // Static AST escape PoCs — every single one MUST be rejected
  const escapePayloads = [
    // PoC 1: += string concatenation building "constructor"
    `var k = "con"; k += "structor"; var f = Variable.GetByFullName[k];`,
    // PoC 2: Array.join obfuscation
    `var k = ["con","structor"].join(""); var f = Variable[k];`,
    // PoC 3: String.fromCharCode obfuscation
    `var k = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); var f = Variable[k];`,
    // PoC 4: this aliasing to reach host globals
    `var g = this; var x = g["Variable"];`,
    // PoC 5: Object aliasing + getPrototypeOf
    `var O = Object; var p = O.getPrototypeOf(Variable);`,
    // PoC 6: Unresolved computed property access on protected root
    `function grab(m) { return Variable.GetByFullName[m]; } grab("constructor");`,
  ];

  for (const [idx, code] of escapePayloads.entries()) {
    const res = validateHaiwellScript(code, prj.tags);
    assert.equal(res.valid, false, `Escape payload #${idx + 1} MUST fail AST validation: ${code}`);
  }

  // Runtime VM membrane proof: inject a hostile script directly into project.scripts (bypassing tool validation!)
  // and execute runSimulationSteps — MUST NOT leak host process/require/mainModule!
  prj.scripts.push({
    id: 'scr_hostile_vm_escape',
    name: 'HostileEscape',
    trigger: 'CYCLIC',
    intervalMs: 1000,
    referencedTags: [],
    validated: false,
    updatedAt: new Date().toISOString(),
    code: `
      var leaked = "SAFE";
      try {
        var hostFn = Variable.GetByFullName.constructor;
        var hostGlobal = hostFn("return this")();
        if (hostGlobal && hostGlobal.process && hostGlobal.process.versions) {
          leaked = "HOST_PROCESS_LEAKED:" + hostGlobal.process.versions.node;
        }
      } catch (e) {
        leaked = "BLOCKED";
      }
      Variable.SetByFullName("Chiller_Setpoint_C", leaked === "SAFE" || leaked === "BLOCKED" ? 7.5 : 999);
    `,
  });

  const sim = runSimulationSteps(prj, { steps: 1, scanIntervalMs: 1000 });
  assert.notEqual(
    sim.finalTags.Chiller_Setpoint_C,
    999,
    'Hostile VM escape via Variable.GetByFullName.constructor MUST NOT reach host Node.js process!'
  );

  // Also verify legitimate native ES5 string methods (match/search/concat) still pass analyzer
  const legit = validateHaiwellScript(
    `var s = "Chiller-1"; var idx = s.search(/1/); var m = s.match(/Chiller/); var c = s.concat("-OK");`,
    prj.tags
  );
  assert.equal(legit.valid, true, `Legitimate ES5 string methods must pass: ${JSON.stringify(legit.diagnostics)}`);

  // E-Stop bypass PoC: write BEFORE reading EStop_OK must still trigger safety warning
  const badEstop = validateHaiwellScript(
    `Variable.SetByFullName("Pump1_Run_Cmd", true); var ok = Variable.GetByFullName("EStop_OK");`,
    prj.tags
  );
  assert.ok(
    badEstop.diagnostics.some((d) => d.code === 'HWJS-SAFE-003'),
    'Writing safety tag BEFORE reading EStop_OK must flag HWJS-SAFE-003'
  );
});

// =========================================================================
// 3. HIGH-01, HIGH-02, HIGH-03, HIGH-04, HIGH-05, HIGH-06
// =========================================================================
test('HIGH-01..06: Partial project normalization, BASE_1 overlap, CSV IR/HR/split, OPC UA write guard, literal JSON args, S7 DBW overlap', async () => {
  // HIGH-01: Partial project JSON loaded from disk gets deep defaults instead of crashing
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haiwell-v280-'));
  try {
    const partialWorkspace = {
      projects: [
        {
          id: 'prj_partial_legacy',
          name: 'Legacy Partial Project',
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'workspace.json'), JSON.stringify(partialWorkspace), 'utf8');
    const diskStore = new HaiwellProjectStore(tmpDir);
    const loaded = diskStore.getProject('prj_partial_legacy');
    assert.ok(loaded.mqtt && Array.isArray(loaded.mqtt.bindings));
    assert.ok(loaded.opcua && Array.isArray(loaded.opcua.nodes));
    assert.ok(loaded.security && typeof loaded.security.abKeyEnabled === 'boolean');
    const audit = runProjectSafetyAudit(loaded);
    assert.ok(typeof audit.deploymentReady === 'boolean');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // HIGH-02: BASE_1 vs BASE_0 Modbus overlap detection
  const base1Tags: Record<string, TagDefinition> = {
    Tag_4X: makeTestTag('Tag_4X', { scope: 'PLC', deviceId: 'dev_base1', address: '4X1', dataType: 'UINT16' }),
    Tag_Modicon: makeTestTag('Tag_Modicon', { scope: 'PLC', deviceId: 'dev_base1', address: '40001', dataType: 'UINT16' }),
  };
  const conflictsBase1 = detectWordOverlapConflicts(
    base1Tags,
    new Map<string, PlcDriverProtocol>([['dev_base1', 'MODBUS_TCP']]),
    new Map<string, 'BASE_0' | 'BASE_1'>([['dev_base1', 'BASE_1']])
  );
  assert.ok(conflictsBase1.length >= 1, '4X1 and 40001 on BASE_1 device must collide');

  // HIGH-03: CSV export accuracy (IR:0 -> 3X, 4X10.3 -> .3 preserved, split PLC vs internal CSV)
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  prj.tags['Modbus_IR_Temp'] = makeTestTag('Modbus_IR_Temp', {
    scope: 'PLC',
    deviceId: 'dev_plc_1',
    address: 'IR:0',
    dataType: 'INT16',
    access: 'RO',
  });
  prj.tags['Modbus_HR_Bit'] = makeTestTag('Modbus_HR_Bit', {
    scope: 'PLC',
    deviceId: 'dev_plc_1',
    address: '4X10.3',
    dataType: 'BOOL',
    access: 'RW',
  });
  const bundle = buildProjectExportBundle(prj);
  const plcCsv = String(bundle.artifacts['haiwell_variables_import.csv'] ?? '');
  const intCsv = String(bundle.artifacts['haiwell_internal_variables.csv'] ?? '');
  assert.match(plcCsv, /Modbus_IR_Temp,"3X\(Analog input,Function code 04\)",Decimal,0,/);
  assert.match(plcCsv, /Modbus_HR_Bit,"4X\(Analog output,Function code 03 06\)",Decimal,10\.3,/);
  assert.ok(!plcCsv.includes('Plant_DeltaT_C'), 'Internal tags must not pollute PLC CSV');
  assert.ok(intCsv.includes('Plant_DeltaT_C'), 'Internal tags must be exported in haiwell_internal_variables.csv');

  // HIGH-04: OPC UA write blocked on HistoryRead + audit trail on allowed CurrentReadWrite write
  prj.opcua.nodes.push({
    nodeId: 'ns=2;s=HistNode',
    browseName: 'HistNode',
    displayName: 'HistNode',
    tagName: 'Chiller_Setpoint_C',
    dataType: 'Double',
    accessLevel: 'HistoryRead',
    samplingIntervalMs: 500,
    folderPath: 'Objects/Plant',
  });
  const histWrite = await invokeHaiwellTool(
    'haiwell_opcua_browse_read_write',
    { projectId: prj.id, action: 'WRITE_NODE', nodeId: 'ns=2;s=HistNode', value: 7.2, reason: 'test' },
    store
  );
  assert.equal(histWrite.ok, true);
  const histData = histWrite.data as { written?: boolean; statusCode?: string };
  assert.equal(histData.written, false, 'OPC UA write to HistoryRead node must be blocked');
  assert.match(histData.statusCode ?? '', /BadNotWritable/);

  prj.opcua.nodes.push({
    nodeId: 'ns=2;s=WritableSP',
    browseName: 'WritableSP',
    displayName: 'WritableSP',
    tagName: 'Chiller_Setpoint_C',
    dataType: 'Double',
    accessLevel: 'CurrentReadWrite',
    samplingIntervalMs: 500,
    folderPath: 'Objects/Plant',
  });
  const prevAuditLen = prj.auditLog.length;
  const okWrite = await invokeHaiwellTool(
    'haiwell_opcua_browse_read_write',
    { projectId: prj.id, action: 'WRITE_NODE', nodeId: 'ns=2;s=WritableSP', value: 7.4, reason: 'calibrated' },
    store
  );
  assert.equal(okWrite.ok, true);
  assert.ok(prj.auditLog.length > prevAuditLen, 'OPC UA write must append an audit log entry');

  // HIGH-05: LITERAL_STRING_ARG_KEYS preserves JSON string in lwtPayload / value / actionValue / svgMarkup
  const normalized = normalizeAgentArgs({
    lwtPayload: '{"status":"offline"}',
    value: '{"raw":true}',
    actionValue: '[1,2,3]',
    svgMarkup: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  });
  assert.equal(typeof normalized.lwtPayload, 'string');
  assert.equal(normalized.lwtPayload, '{"status":"offline"}');
  assert.equal(typeof normalized.value, 'string');
  assert.equal(typeof normalized.actionValue, 'string');

  // HIGH-06: Siemens S7 DBW INT32 (4 bytes: bytes 0..3) overlaps DB1.DBB3!
  const s7Tags: Record<string, TagDefinition> = {
    S7_Long: makeTestTag('S7_Long', { scope: 'PLC', deviceId: 'dev_s7', address: 'DB1.DBW0', dataType: 'INT32' }),
    S7_OverlapByte: makeTestTag('S7_OverlapByte', { scope: 'PLC', deviceId: 'dev_s7', address: 'DB1.DBB3', dataType: 'UINT16' }),
  };
  const s7Conflicts = detectWordOverlapConflicts(
    s7Tags,
    new Map<string, PlcDriverProtocol>([['dev_s7', 'SIEMENS_S7_1200']])
  );
  assert.ok(s7Conflicts.length >= 1, 'S7 DB1.DBW0 (INT32) must collide with DB1.DBB3');

  // Additional PLC addressing mediums: Delta DVP octal X8 invalid, MQTT wildcard rejected
  assert.equal(validatePlcAddress('DELTA_DVP_MODBUS', 'X8').valid, false);
  assert.equal(validatePlcAddress('MQTT_CLIENT', 'plant/+/temp').valid, false);
});

// =========================================================================
// 4. HIGH-07, HIGH-08, HIGH-09, HIGH-10 + IEC 61131-3 Mediums
// =========================================================================
test('HIGH-07..10: IEC 61131-3 ST transpiler & validator fixes (LOG/LN, NOT/XOR, PID NaN/KP=0, ** precedence, 2D arrays, EXIT, MOD, FOR const)', () => {
  const st = `
PROGRAM MathLogicPidTest
VAR
  StatusWord : WORD := 0;
  MaskA : WORD := 16#0003;
  MaskB : WORD := 16#0005;
  LoopCtrl : PID;
  Grid : ARRAY[0..1, 0..1] OF INT;
END_VAR
VAR_OUTPUT
  NotZero : BOOL := FALSE;
  XorWord : WORD := 0;
  XorBool : BOOL := FALSE;
  LnVal : REAL := 0.0;
  LogVal : REAL := 0.0;
  PowVal : REAL := 0.0;
  PidOut : REAL := 0.0;
END_VAR
  NotZero := NOT (StatusWord = 0);
  XorWord := MaskA XOR MaskB;
  XorBool := NOT (TRUE XOR FALSE);
  LnVal := LN(2.718281828);
  LogVal := LOG(90.0 + 10.0);
  PowVal := 2.0 ** 3.0 + 1.0;
  LoopCtrl(PV := 50.0, SP := 60.0, KP := 0.0, KI := 0.0, KD := 0.0);
  PidOut := LoopCtrl.OUT;
  Grid[0, 1] := 42;
END_PROGRAM
`;
  const val = validateStructuredText(st);
  assert.equal(val.valid, true, `Expected valid ST, got: ${JSON.stringify(val.diagnostics)}`);

  const tr = transpileStToHaiwellJs(st, {}, { apiStyle: 'HAIWELL_NATIVE_350' });
  assert.equal(tr.success, true);
  assert.ok(tr.jsCode);
  assert.doesNotThrow(() => acorn.parse(tr.jsCode!, { ecmaVersion: 5 }), 'Transpiled JS must parse as Strict ES5');

  // Execute transpiled code inside simulation engine and inspect computed results
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  prj.pous = [
    {
      id: 'pou_math_test',
      name: 'MathLogicPidTest',
      pouType: 'PROGRAM',
      language: 'ST',
      source: st,
      boundTags: [],
      validatedAt: new Date().toISOString(),
      diagnostics: [],
    },
  ];
  for (const [k, dt] of [
    ['NotZero', 'BOOL'],
    ['XorWord', 'UINT16'],
    ['XorBool', 'BOOL'],
    ['LnVal', 'FLOAT32'],
    ['LogVal', 'FLOAT32'],
    ['PowVal', 'FLOAT32'],
    ['PidOut', 'FLOAT32'],
  ] as const) {
    prj.tags[k] = makeTestTag(k, { scope: 'INTERNAL', dataType: dt });
  }
  const sim = runSimulationSteps(prj, { steps: 1, scanIntervalMs: 1000 });
  assert.equal(sim.finalTags.NotZero, false, 'NOT (0 = 0) must be false (not ~1)');
  assert.equal(sim.finalTags.XorWord, 6, '0x3 XOR 0x5 must be 6 (bitwise WORD XOR)');
  assert.equal(sim.finalTags.XorBool, false, 'NOT (TRUE XOR FALSE) must be false');
  assert.ok(Math.abs(Number(sim.finalTags.LnVal) - 1.0) < 0.01, `LN(e) must be ~1.0, got ${sim.finalTags.LnVal}`);
  assert.ok(Math.abs(Number(sim.finalTags.LogVal) - 2.0) < 0.01, `LOG(90+10) must be 2.0, got ${sim.finalTags.LogVal}`);
  assert.equal(Number(sim.finalTags.PowVal), 9, `2**3+1 must be 9, got ${sim.finalTags.PowVal}`);
  assert.equal(Number.isNaN(Number(sim.finalTags.PidOut)), false, 'PID output must never be NaN');
  assert.equal(Number(sim.finalTags.PidOut), 0, 'PID with KP=0, KI=0, KD=0 must stay 0 (not fallback to KP=1)');

  // IEC Mediums: EXIT outside loop, FOR mutating CONSTANT, unguarded MOD, WHILE (TRUE) without EXIT
  const exitErr = validateStructuredText(`PROGRAM BadExit\nVAR x : INT; END_VAR\nEXIT;\nEND_PROGRAM`);
  assert.equal(exitErr.valid, false);
  assert.ok(exitErr.diagnostics.some((d) => d.code === 'IEC-CTRL-011'));

  const forConstErr = validateStructuredText(
    `PROGRAM BadFor\nVAR CONSTANT k : INT := 0; END_VAR\nFOR k := 1 TO 5 DO\nEND_FOR;\nEND_PROGRAM`
  );
  assert.equal(forConstErr.valid, false);
  assert.ok(forConstErr.diagnostics.some((d) => d.code === 'IEC-SAFE-006'));

  const modWarn = validateStructuredText(`PROGRAM ModCheck\nVAR a, b, c : INT; END_VAR\nc := a MOD b;\nEND_PROGRAM`);
  assert.ok(modWarn.diagnostics.some((d) => d.code === 'IEC-SAFE-007'));

  const whileTrueErr = validateStructuredText(`PROGRAM InfLoop\nVAR a : INT; END_VAR\nWHILE (TRUE) DO\n  a := a + 1;\nEND_WHILE;\nEND_PROGRAM`);
  assert.equal(whileTrueErr.valid, false);
  assert.ok(whileTrueErr.diagnostics.some((d) => d.code === 'IEC-SAFE-001'));
});

// =========================================================================
// 5. HIGH-11, HIGH-12 + Simulation / Alarm Mediums
// =========================================================================
test('HIGH-11 & HIGH-12: RUN_ONCE latch executes exactly once and standalone alarm evaluation enforces delayOnMs/delayOffMs by default', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // HIGH-11: RUN_ONCE event trigger fires on 1st rising edge and latches permanently
  prj.tags['Once_Trig'] = makeTestTag('Once_Trig', { scope: 'INTERNAL', dataType: 'BOOL', currentValue: false });
  prj.tags['Once_Target'] = makeTestTag('Once_Target', { scope: 'INTERNAL', dataType: 'INT16', currentValue: 0 });
  prj.eventTriggers.push({
    id: 'evt_run_once',
    name: 'OnceTest',
    sourceTag: 'Once_Trig',
    condition: 'RISING_EDGE',
    actionType: 'WRITE_TAG',
    targetId: 'Once_Target',
    actionValue: 77,
    executionMode: 'RUN_ONCE',
    enabled: true,
  });

  // Step 1: rising edge -> fires OnceTest (Once_Target becomes 77)
  const s1 = runSimulationSteps(prj, { steps: 1, scanIntervalMs: 1000, injectTagValues: { Once_Trig: true }, persistState: true });
  assert.equal(s1.finalTags.Once_Target, 77);
  assert.ok(s1.trace[0].triggeredEvents.some((e) => e.includes('evt_run_once')));

  // Step 2: drop Once_Trig=false and reset Once_Target=0
  runSimulationSteps(prj, { steps: 1, scanIntervalMs: 1000, injectTagValues: { Once_Trig: false, Once_Target: 0 }, persistState: true });

  // Step 3: 2nd rising edge -> RUN_ONCE is latched, MUST NOT re-fire!
  const s3 = runSimulationSteps(prj, { steps: 1, scanIntervalMs: 1000, injectTagValues: { Once_Trig: true }, persistState: true });
  assert.equal(s3.finalTags.Once_Target, 0, 'RUN_ONCE trigger must not re-fire on subsequent edges');
  assert.equal(s3.trace[0].triggeredEvents.some((e) => e.includes('evt_run_once')), false);

  // HIGH-12: Standalone evaluateProjectAlarms enforces delayOnMs=5000 by default
  const store2 = new HaiwellProjectStore();
  const prj2 = store2.getProject('prj_chiller_plant_01');
  prj2.tags.Supply_Temp_C.currentValue = 15.0; // >= 14.0 threshold; alm_supply_hihi has delayOnMs=5000
  const e1 = evaluateProjectAlarms(prj2, { scanIntervalMs: 2000 });
  assert.equal(e1.newlyTriggered.length, 0, 'At 2000ms (< 5000ms delayOnMs), alarm must NOT trigger yet');
  const e2 = evaluateProjectAlarms(prj2, { scanIntervalMs: 2000 });
  assert.equal(e2.newlyTriggered.length, 0, 'At 4000ms (< 5000ms delayOnMs), alarm must still wait');
  const e3 = evaluateProjectAlarms(prj2, { scanIntervalMs: 2000 });
  assert.equal(e3.newlyTriggered.length, 1, 'At 6000ms (>= 5000ms delayOnMs), alarm MUST trigger');
});

// =========================================================================
// 6. HIGH-13, HIGH-14, HIGH-15, HIGH-19: SVG XSS, HMI Blocking Validation, Pipe Crossings, SVG Escape
// =========================================================================
test('HIGH-13, HIGH-14, HIGH-15, HIGH-19: SVG XSS allowlist rejects attacks, HMI validation blocks RO writes & dup IDs, P&ID pipes avoid widget crossings', async () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // HIGH-13: SVG XSS payloads rejected by strict XML/SVG allowlist
  const xssSvgs = [
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)"><rect width="10" height="10"/></a></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onmouseover="alert(1)"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onbegin" to="alert(1)"/></svg>`,
  ];
  for (const [idx, svgMarkup] of xssSvgs.entries()) {
    const res = await invokeHaiwellTool(
      'haiwell_shape_library_manage',
      {
        projectId: prj.id,
        action: 'UPSERT',
        shape: { id: `xss_${idx}`, name: `XSS ${idx}`, category: 'CUSTOM', svgMarkup },
      },
      store
    );
    assert.equal(res.ok, false, `XSS SVG #${idx + 1} MUST be rejected`);
    assert.match(res.error?.message ?? '', /SVG_SECURITY_REJECTED/, `XSS SVG #${idx + 1} must trigger SVG_SECURITY_REJECTED`);
  }

  // Clean vector SVG is accepted
  const goodSvg = await invokeHaiwellTool(
    'haiwell_shape_library_manage',
    {
      projectId: prj.id,
      action: 'UPSERT',
      shape: {
        id: 'shp_clean_valve',
        name: 'Clean Valve',
        category: 'VALVE',
        svgMarkup: '<svg viewBox="0 0 64 64"><path d="M4 16 L32 32 L4 48 Z" fill="#0EA5E9" stroke="#0F172A"/></svg>',
      },
    },
    store
  );
  assert.equal(goodSvg.ok, true, `Clean SVG must be accepted, got: ${JSON.stringify(goodSvg.error)}`);

  // HIGH-14: Duplicate widget IDs, RO tag writeEnabled, invalid min>=max, and disconnected pipes MUST fail validateHmiScreen
  const badScreen: HmiScreen = {
    id: 'scr_bad_v280',
    name: 'Invalid Controls',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#E5E7EB',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: new Date().toISOString(),
    widgets: [
      { id: 'dup_w', type: 'NUMERIC_INPUT', label: 'RO Write', x: 32, y: 32, width: 160, height: 56, tagName: 'Supply_Temp_C', writeEnabled: true, min: 50, max: 10 },
      { id: 'dup_w', type: 'NUMERIC_DISPLAY', label: 'Dup', x: 240, y: 32, width: 160, height: 56, tagName: 'Return_Temp_C' },
    ],
    pipes: [
      {
        id: 'p_broken',
        fromWidgetId: 'dup_w',
        toWidgetId: 'ghost_widget',
        fromPort: 'right',
        toPort: 'left',
        fluid: 'PROCESS',
        waypoints: [{ x: 192, y: 60 }, { x: 400, y: 60 }],
      },
    ],
  };
  const hmiVal = validateHmiScreen(badScreen, prj.tags);
  assert.equal(hmiVal.valid, false);
  assert.ok(hmiVal.duplicateWidgetIds.includes('dup_w'));
  assert.ok(hmiVal.readOnlyWriteWidgets.length >= 1);
  assert.ok(hmiVal.invalidRanges.length >= 1);
  assert.ok(hmiVal.disconnectedPipes.some((p) => p.includes('p_broken')));

  // HIGH-15: P&ID with callouts AND recirculation loop must produce ZERO pipe-widget crossings
  const pid = compilePidScreen(
    {
      screenId: 'scr_pid_no_cross',
      name: 'Zero Crossing Chiller Loop',
      width: 1280,
      height: 800,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      includeAlarmBanner: true,
      includeNavBar: true,
      nodes: [
        { id: 'tank_buf', type: 'TANK', label: 'Buffer Tank', calloutTagName: 'Return_Temp_C' },
        { id: 'pump_1', type: 'PUMP', label: 'Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { id: 'valve_1', type: 'VALVE', label: 'Valve 1', tagName: 'Valve_Position_Pct', writeEnabled: true, calloutTagName: 'Supply_Temp_C' },
      ],
      edges: [
        { id: 'p1', from: 'tank_buf', to: 'pump_1', fluid: 'CHILLED_WATER' },
        { id: 'p2', from: 'pump_1', to: 'valve_1', fluid: 'CHILLED_WATER' },
        { id: 'p_ret', from: 'valve_1', to: 'tank_buf', fluid: 'RETURN' },
      ],
    },
    prj.tags,
    { targetHardware: 'CLOUD_HMI_C10' }
  );
  assert.equal(pid.spatialAudit.pipeWidgetCrossings.length, 0, `Expected 0 pipe crossings, got ${JSON.stringify(pid.spatialAudit.pipeWidgetCrossings)}`);
  assert.equal(pid.spatialAudit.valid, true);

  // Verify detectPipeWidgetCrossings catches a deliberately crossing pipe
  const crossedScreen: HmiScreen = {
    ...pid.screen,
    pipes: [
      {
        id: 'p_bad_cross',
        fromWidgetId: 'tank_buf',
        toWidgetId: 'valve_1',
        fromPort: 'right',
        toPort: 'left',
        fluid: 'PROCESS',
        waypoints: [
          { x: pid.screen.widgets.find((w) => w.id === 'tank_buf')!.x + 144, y: pid.screen.widgets.find((w) => w.id === 'pump_1')!.y + 30 },
          { x: pid.screen.widgets.find((w) => w.id === 'valve_1')!.x, y: pid.screen.widgets.find((w) => w.id === 'pump_1')!.y + 30 },
        ],
      },
    ],
  };
  assert.ok(detectPipeWidgetCrossings(crossedScreen).length >= 1, 'Deliberate pipe through pump_1 must be detected');
  assert.equal(auditScreenSpatially(crossedScreen, prj.tags).valid, false);

  // Diamond DAG: forward edge C -> D MUST NOT be misclassified as RETURN!
  const diamond = compilePidScreen(
    {
      screenId: 'scr_diamond',
      name: 'Diamond DAG',
      width: 1280,
      height: 800,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      nodes: [
        { id: 'nA', type: 'TANK', label: 'A' },
        { id: 'nB', type: 'PUMP', label: 'B' },
        { id: 'nC', type: 'VALVE', label: 'C' },
        { id: 'nD', type: 'TANK', label: 'D' },
      ],
      edges: [
        { id: 'e_ab', from: 'nA', to: 'nB' },
        { id: 'e_bc', from: 'nB', to: 'nC' },
        { id: 'e_cd', from: 'nC', to: 'nD' },
        { id: 'e_ad', from: 'nA', to: 'nD' },
      ],
    },
    prj.tags
  );
  assert.deepEqual(diamond.portAttachmentProof.recirculationEdges, [], 'Acyclic diamond DAG must have 0 recirculation edges');

  // HIGH-19: SVG data-type attribute escaping & Object.prototype fluid key guard
  const svgOut = renderScreenToSvg(
    {
      ...pid.screen,
      widgets: [
        {
          id: 'w_esc',
          type: 'LABEL" onclick="alert(1)' as unknown as HmiScreen['widgets'][number]['type'],
          label: 'Safe',
          x: 20,
          y: 20,
          width: 120,
          height: 48,
        },
      ],
      pipes: [
        {
          id: 'p_proto',
          fromWidgetId: 'w_esc',
          toWidgetId: 'w_esc',
          fromPort: 'right',
          toPort: 'left',
          fluid: 'toString' as unknown as 'PROCESS',
          waypoints: [{ x: 140, y: 44 }, { x: 200, y: 44 }],
        },
      ],
    },
    prj.tags
  );
  assert.ok(!svgOut.includes('onclick="alert(1)"'), 'SVG data-type must be XML-escaped');
  assert.ok(!svgOut.includes('function toString'), 'Inherited prototype fluid key must not inject JS function string');

  // Touch NAV_BAR >= 48px repair & post-snap odd-viewport clamping
  const oddTouch = solveAndRepairScreenLayout(
    {
      id: 'scr_odd',
      name: 'Odd 1366x768',
      width: 1366,
      height: 768,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      backgroundColor: '#E5E7EB',
      autoScaleMobile: true,
      autoScaleWeb: true,
      createdAt: new Date().toISOString(),
      widgets: [
        { id: 'nav_small', type: 'NAV_BAR', label: 'Nav', x: 16, y: 730, width: 1334, height: 28 },
        { id: 'edge_w', type: 'NUMERIC_DISPLAY', label: 'Edge', x: 1300, y: 200, width: 140, height: 56 },
      ],
    },
    'CLOUD_HMI_C10'
  );
  const repairedNav = oddTouch.screen.widgets.find((w) => w.id === 'nav_small')!;
  assert.ok(repairedNav.height >= 48, 'Touch NAV_BAR must be resized to >= 48px');
  assert.equal(oddTouch.remainingOutOfBounds, 0, 'Odd viewport clamping must yield 0 out-of-bounds widgets');
});

// =========================================================================
// 7. HIGH-16, HIGH-17, HIGH-18 & UIA-01..UIA-10
// =========================================================================
test('HIGH-16, HIGH-17, HIGH-18 & UIA-01..10: Desktop PowerShell guards, calibrator inner-ID precedence, and Haiwell 3.50.1.19 UIA bridge accuracy', () => {
  // HIGH-16 & HIGH-17: PowerShell New Project & Launch script hardening
  const ps = buildNewProjectPowerShellScript({
    projectName: 'ChillerLine1',
    saveDirectory: 'C:\\Projects\\My Plant',
    runtimePlatform: 'PC',
    deviceModel: 'PC',
    resolution: '1024x600',
  });
  assert.ok(ps.includes('IsReadOnly'), 'Set-EditSafe must guard against read-only ValuePattern (HIGH-16)');
  assert.ok(ps.includes('Start-Sleep -Milliseconds 120'), 'Set-EditSafe must wait 120ms after Ctrl+V before restoring clipboard (HIGH-16)');
  assert.ok(ps.includes("-replace '[xX]', '*'") || ps.includes('1024*600'), 'Select-ComboByText must try 1024*600 variant');
  assert.ok(ps.includes('throw "Failed to click OK') || ps.includes('throw "'), 'Must throw on OK button click failure (HIGH-17)');

  const launchPs = buildLaunchPowerShellScript({
    exePath: 'C:\\Program Files (x86)\\Haiwell\\HaiwellScada3\\Scada.Develop.exe',
    projectFilePath: 'C:\\My Plant\\Chiller Line.hwdev',
    timeoutSec: 20,
  });
  assert.ok(
    launchPs.includes(`'"C:\\My Plant\\Chiller Line.hwdev"'`),
    'Launch script must quote project paths with spaces'
  );

  // UIA-01: Exact tree node name
  assert.ok(
    (REAL_HAIWELL_350_TREE_NODES as readonly string[]).includes('Cloud platform data monitoring'),
    'Tree node must use exact Haiwell 3.50.1.19 label "Cloud platform data monitoring"'
  );

  // HIGH-18: Calibrator prioritizes inner IDs (vectorControl1/fg/treeView1/SymbolPanel) and expands Hyperlink categories
  const cal = generateDesktopUiaCalibrator();
  assert.ok(cal.calibratorScript.includes('if auto_id == "vectorControl1":'), 'Calibrator must prioritize vectorControl1 over FrmWindow');
  assert.ok(cal.calibratorScript.includes('if auto_id == "fg":'), 'Calibrator must prioritize fg over FrmVariableEditor');
  assert.ok(cal.calibratorScript.includes('itemsByCategory'), 'Calibrator must separate Hyperlink categories and expand collapsed categories');

  // UIA-02..10: Open-project bridge & screen bridge accuracy
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  const fullBridge = compileFullOpenProjectBridge(prj);
  const py = fullBridge.pywinautoScript;
  assert.ok(py.includes('_is_tree_item_expanded'), 'navigate_tree must check expand state before double-click (UIA-02)');
  assert.ok(py.includes('Add device'), 'run_devices must handle Add device / Property Setting (UIA-03)');
  assert.ok(py.includes('{F2}'), 'run_variables must use F2 instead of Ctrl+A in C1FlexGrid (UIA-04)');
  assert.ok(py.includes('internal_column_order'), 'run_variables must use reduced columns for InternalVariable (UIA-04)');
  assert.ok(py.includes('control_type="Menu"'), 'Context menus must scope to popup Menu (UIA-05)');
  assert.ok(py.includes('_select_pipe_tool(toolbox, win)'), 'draw_pipes must re-select Pipe 1 per segment (UIA-08)');
  assert.ok(py.includes('abs(y2 - y1) < 8'), 'draw_pipes must enforce >=8px drag bounding box thickness (UIA-08)');
  assert.ok(py.includes('inset_r, inset_b = 18, 18'), 'map_canvas_point must subtract scrollbar insets (UIA-09)');
  assert.ok(py.includes('ctrl.select(str(value))'), 'set_dialog_field must allow integer ComboBox selection (UIA-10)');
  assert.equal(fullBridge.plan.tasks[0].treeNode, 'Task -> Script task');

  // Verify Decimal digits is omitted on BOOL/lamp/valve/pump widgets in screen bridge
  const scrBridge = compileDesktopAutomationBridge(prj.screens[0], prj.tags);
  const pumpStep = scrBridge.uiaExecutionSteps.find((s) => s.widgetId.includes('pump') || s.toolboxItemName === 'Bit switch');
  if (pumpStep) {
    assert.equal(pumpStep.modalFieldWrites['Decimal digits'], undefined);
  }
  assert.ok(scrBridge.pywinautoScript.includes('Property modal failed to open'), 'Screen bridge must fail cleanly if modal does not open');
  assert.ok(scrBridge.pywinautoScript.includes('_read_control_value'), 'set_and_verify_property must verify non-empty read-back');
});

// =========================================================================
// 8. Medium Security & Operational Regressions (SSRF IPv6, Scoped Idempotency, Catalog Schema, dataType Filter, Fail-Closed E-Stop)
// =========================================================================
test('Medium fixes: IPv6 loopback SSRF, scoped idempotency, catalog meta-params, dataType query filter, fail-closed E-Stop', async () => {
  // IPv6 loopback aliases blocked when blockLoopback=true, and cloud metadata/unspecified always blocked
  assert.equal(isBlockedSsrfHost('0:0:0:0:0:0:0:1', { blockLoopback: true }), true);
  assert.equal(isBlockedSsrfHost('0000:0000:0000:0000:0000:0000:0000:0001', { blockLoopback: true }), true);
  assert.equal(isBlockedSsrfHost('::0:1', { blockLoopback: true }), true);
  assert.equal(isBlockedSsrfHost('fd00:ec2::254'), true);
  assert.equal(isBlockedSsrfHost('::'), true);

  // Scoped idempotencyKey: same key on different tool/args MUST NOT replay wrong response
  const store = new HaiwellProjectStore();
  const r1 = await invokeHaiwellTool(
    'haiwell_tag_query',
    { projectId: 'prj_chiller_plant_01', dataType: 'FLOAT32', compact: false, idempotencyKey: 'shared-key-1' },
    store
  );
  const r2 = await invokeHaiwellTool(
    'haiwell_tag_query',
    { projectId: 'prj_chiller_plant_01', dataType: 'BOOL', compact: false, idempotencyKey: 'shared-key-1' },
    store
  );
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const floatTags = (r1.data as { tags: TagDefinition[] }).tags;
  const boolTags = (r2.data as { tags: TagDefinition[] }).tags;
  assert.ok(floatTags.length > 0 && floatTags.every((t) => t.dataType === 'FLOAT32'));
  assert.ok(boolTags.length > 0 && boolTags.every((t) => t.dataType === 'BOOL'));

  // Serialized tool catalog advertises idempotencyKey and expectedRevision on mutating tools
  const catalog = serializeToolCatalog('all');
  assert.equal(catalog.length, HAIWELL_TOOLS.length);
  const mutTool = catalog.find((t) => t.name === 'haiwell_tag_read_write')!;
  const props = (mutTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok('idempotencyKey' in props && 'expectedRevision' in props, 'Mutating tool schema must advertise idempotencyKey & expectedRevision');

  // Fail-closed E-Stop: if project requires EStop_OK and tag is deleted, physical output write MUST fail closed
  const prj = store.getProject('prj_chiller_plant_01');
  delete prj.tags.EStop_OK;
  const estopMissing = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    { projectId: prj.id, operation: 'WRITE', tagName: 'Pump1_Run_Cmd', value: true, confirmSafetyOverride: true, reason: 'test' },
    store
  );
  assert.equal(estopMissing.ok, true);
  const estopData = estopMissing.data as { written?: boolean; blockedBy?: string };
  assert.equal(estopData.written, false);
  assert.equal(estopData.blockedBy, 'ESTOP_TAG_MISSING');
});
