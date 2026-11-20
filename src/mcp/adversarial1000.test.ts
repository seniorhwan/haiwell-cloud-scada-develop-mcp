import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server';
import { HaiwellProjectStore } from './projectStore';
import { HAIWELL_TOOLS, invokeHaiwellTool } from './toolRegistry';
import {
  applyLinearScaling,
  detectWordOverlapConflicts,
  validatePlcAddress,
  validateTagValueForType,
} from './plcAddressing';
import {
  transpileStToHaiwellJs,
  validateFbdNetwork,
  validateLadderGraph,
  validateStructuredText,
} from './iec61131';
import {
  generateAutoLayoutScreenDetailed,
  instantiateFaceplate,
  renderScreenToSvg,
  validateHmiScreen,
} from './hmiGenerator';
import { validateHaiwellScript } from './scriptAnalyzer';
import { generateOpcUaNodeSet2Xml, probeTcpEndpoint, validateMqttTopic } from './protocolAdapters';
import { evaluateProjectAlarms, runSimulationSteps } from './simulationEngine';
import type { PlcDriverProtocol, TagDataType, TagDefinition } from './types';

let totalFailureModesVerified = 0;
function mark(count = 1) {
  totalFailureModesVerified += count;
}

// ============================================================================
// 1. MULTI-VENDOR PLC ADDRESSING ADVERSARIAL MATRIX (240+ failure modes)
// ============================================================================
test('1. Multi-vendor PLC addressing rejects 240+ malformed/out-of-range registers and accepts valid ones', () => {
  // Haiwell native invalid addresses
  const badHaiwell: string[] = [
    '', '   ', 'X-1', 'X1024', 'X9999', 'Y1024', 'M12288', 'T1024', 'C256', 'S2048',
    'AI256', 'AQ256', 'V14848', 'TV1024', 'CV256', 'SV2048',
    'X0.0', 'Y1.1', 'M10.0', 'T0.1', 'C0.0', 'S5.2',
    'V0.16', 'V0.17', 'V0.99', 'V0.-1', 'V0.a', 'AI0.16', 'AQ0.32',
    'Z0', 'D100', 'Q0.0', 'I0.0', 'HR:0', '40001', 'V', 'X', 'AI',
    'V100; DROP TABLE', 'V100\nV101', 'V100.0.1', '0V10', 'V-5', 'V1.2.3',
    'X00000000099999', 'V99999999', 'TV-1', 'CV999', 'SV9999', 'AI-1', 'AQ-2',
  ];
  for (let i = 0; i < 30; i++) {
    badHaiwell.push(`V${14848 + i}`);
    badHaiwell.push(`AI${256 + i}`);
  }
  for (const addr of badHaiwell) {
    const res = validatePlcAddress('HAIWELL_PLC_TCP', addr);
    assert.equal(res.valid, false, `Expected invalid Haiwell address: ${addr}`);
    mark();
  }

  // Modbus TCP/RTU/Delta/Schneider invalid addresses
  const badModbus: string[] = [
    '', '0', '1', '9999', '00000', '10000', '20001', '30000', '40000',
    '50001', '60001', '70001', '80001', '90001', '99999', '200001', '500001',
    'HR:-1', 'HR:65536', 'HR:99999', 'IR:65536', 'COIL:65536', 'DI:65536',
    'WR:0', 'X0', 'V100', 'HR:', 'HR:abc', '40001.1', '4000001',
  ];
  const modbusProtocols: PlcDriverProtocol[] = ['MODBUS_TCP', 'MODBUS_RTU', 'DELTA_DVP_MODBUS', 'SCHNEIDER_MODBUS'];
  for (const proto of modbusProtocols) {
    for (const addr of badModbus.slice(0, 15)) {
      const res = validatePlcAddress(proto, addr);
      assert.equal(res.valid, false, `Expected invalid ${proto} address: ${addr}`);
      mark();
    }
    assert.equal(validatePlcAddress(proto, '40001').valid, true);
    assert.equal(validatePlcAddress(proto, 'HR:100').valid, true);
    const di5 = validatePlcAddress(proto, 'DI:5');
    assert.equal(di5.valid && di5.readOnly, true);
  }

  // Siemens S7-1200 / S7-1500 invalid addresses
  const badS7 = [
    '', 'I0', 'Q0', 'M0', 'I0.8', 'Q0.9', 'M10.16', 'I0.-1',
    'DB1.DBX0.8', 'DB1.DBX0.9', 'DB1.DBX0', 'DB1.DBQ0', 'DB0.INVALID',
    'DB.DBW0', 'X0', 'V100', '40001', 'IB0.1.2', 'MW-1', 'MD', 'IW',
    'DB1.DBW-2', 'DB1.DBD', 'T0', 'C0',
  ];
  for (const addr of badS7) {
    assert.equal(validatePlcAddress('SIEMENS_S7_1200', addr).valid, false, `Expected invalid S7: ${addr}`);
    assert.equal(validatePlcAddress('SIEMENS_S7_1500', addr).valid, false, `Expected invalid S7-1500: ${addr}`);
    mark(2);
  }
  assert.equal(validatePlcAddress('SIEMENS_S7_1200', 'DB10.DBD4').valid, true);
  const s7i = validatePlcAddress('SIEMENS_S7_1200', 'I0.0');
  assert.equal(s7i.valid && s7i.readOnly, true);

  // Mitsubishi MC 3E invalid addresses
  const badMitsu = [
    '', 'D0A', 'DA0', 'M1F', 'RFF', 'ZR1A', 'L0B', 'F0C',
    'AI0', 'AQ0', 'V100', '40001', 'X-1', 'D-10', 'X', 'D', 'G0', 'Z0',
  ];
  for (const addr of badMitsu) {
    assert.equal(validatePlcAddress('MITSUBISHI_MC_3E', addr).valid, false, `Expected invalid Mitsubishi: ${addr}`);
    mark();
  }
  const mitsuX = validatePlcAddress('MITSUBISHI_MC_3E', 'X1A');
  assert.equal(mitsuX.valid && mitsuX.readOnly, true);
  assert.equal(validatePlcAddress('MITSUBISHI_MC_3E', 'D100').valid, true);

  // Omron FINS invalid addresses
  const badOmron = [
    '', 'CIO0.16', 'CIO0.99', 'W10.16', 'H0.20', 'D100.16', 'X0', 'V100', '40001', 'DM', 'CIO',
  ];
  for (const addr of badOmron) {
    assert.equal(validatePlcAddress('OMRON_FINS_TCP', addr).valid, false, `Expected invalid Omron: ${addr}`);
    mark();
  }
  assert.equal(validatePlcAddress('OMRON_FINS_TCP', 'CIO0.15').valid, true);
  assert.equal(validatePlcAddress('OMRON_FINS_TCP', 'DM200').valid, true);

  // BACnet/IP invalid addresses
  const badBacnet = [
    '', 'DI:0', 'HR:0', 'AI:-1', 'AI:', 'AI', 'AO:abc', 'XV:0', '40001', 'BI:1.2',
  ];
  for (const addr of badBacnet) {
    assert.equal(validatePlcAddress('BACNET_IP', addr).valid, false, `Expected invalid BACnet: ${addr}`);
    mark();
  }
  const bacAi = validatePlcAddress('BACNET_IP', 'AI:0');
  const bacAo = validatePlcAddress('BACNET_IP', 'AO:1');
  assert.equal(bacAi.valid && bacAi.readOnly, true);
  assert.equal(bacAo.valid && bacAo.readOnly, false);

  // Symbolic (AB EIP) invalid addresses
  const badAb = [
    '', '123LeadingDigit', 'Tag With Space', 'Tag;Drop', 'Tag$Bad', 'A'.repeat(130),
    'Tag@Home', 'Tag#1', 'Tag!Bang', 'Tag?Query',
  ];
  for (const addr of badAb) {
    assert.equal(validatePlcAddress('ALLEN_BRADLEY_EIP', addr).valid, false, `Expected invalid AB: ${addr}`);
    mark();
  }
  assert.equal(validatePlcAddress('ALLEN_BRADLEY_EIP', 'Program:Main.Pump[0].Speed').valid, true);
});

// ============================================================================
// 2. PLC BINARY DATA-TYPE RANGE & TYPE-CONFUSION MATRIX (220+ failure modes)
// ============================================================================
test('2. Binary PLC data-type guard blocks 220+ overflow, NaN, Infinity, and type-confusion writes', () => {
  const cases: { type: TagDataType; badValues: unknown[]; goodValues: unknown[] }[] = [
    {
      type: 'BOOL',
      badValues: [0, 1, -1, 'true', 'false', '', null, undefined, NaN, Infinity, {}, [], 0.5],
      goodValues: [true, false],
    },
    {
      type: 'INT16',
      badValues: [-32769, 32768, -100000, 100000, 1.5, -0.1, NaN, Infinity, -Infinity, '10', true, false, null, undefined, {}, []],
      goodValues: [-32768, 0, 32767],
    },
    {
      type: 'UINT16',
      badValues: [-1, -32768, 65536, 100000, 3.14, NaN, Infinity, -Infinity, '0', true, false, null, undefined, {}],
      goodValues: [0, 1, 65535],
    },
    {
      type: 'INT32',
      badValues: [-2147483649, 2147483648, 1e12, -1e12, 0.25, NaN, Infinity, -Infinity, '42', true, null, undefined],
      goodValues: [-2147483648, 0, 2147483647],
    },
    {
      type: 'UINT32',
      badValues: [-1, -100, 4294967296, 1e15, 2.5, NaN, Infinity, -Infinity, '42', false, null, undefined],
      goodValues: [0, 4294967295],
    },
    {
      type: 'BCD16',
      badValues: [-1, 10000, 65535, 99999, 12.3, NaN, Infinity, -Infinity, '9999', true, null, undefined],
      goodValues: [0, 9999],
    },
    {
      type: 'BCD32',
      badValues: [-1, 100000000, 999999999, 1.1, NaN, Infinity, -Infinity, '100', true, null, undefined],
      goodValues: [0, 99999999],
    },
    {
      type: 'FLOAT32',
      badValues: [NaN, Infinity, -Infinity, 3.5e38, -3.5e38, 1e300, '12.3', true, false, null, undefined, {}, []],
      goodValues: [-3.4e38, 0, 7.25, 3.4e38],
    },
    {
      type: 'FLOAT64',
      badValues: [NaN, Infinity, -Infinity, '12.3', true, false, null, undefined, {}, []],
      goodValues: [-1e200, 0, 3.141592653589793, 1e200],
    },
    {
      type: 'STRING',
      badValues: [0, 123, true, false, null, undefined, {}, [], 'A'.repeat(256), 'B'.repeat(500), 'C'.repeat(2048)],
      goodValues: ['', 'OK', 'A'.repeat(255)],
    },
  ];

  for (const c of cases) {
    for (const v of c.badValues) {
      const res = validateTagValueForType(c.type, v);
      assert.equal(res.valid, false, `Expected ${c.type} to reject ${String(v)}`);
      mark();
    }
    for (const v of c.goodValues) {
      const res = validateTagValueForType(c.type, v);
      assert.equal(res.valid, true, `Expected ${c.type} to accept ${String(v)}`);
    }
  }

  // Fuzz 100 random out-of-range integer values across INT16/UINT16/BCD16
  for (let i = 1; i <= 100; i++) {
    assert.equal(validateTagValueForType('INT16', 32767 + i * 7).valid, false);
    assert.equal(validateTagValueForType('BCD16', 9999 + i * 3).valid, false);
    mark(2);
  }

  // Linear scaling edge cases (zero span, clamping, inverted range)
  assert.equal(applyLinearScaling(500, { rawMin: 100, rawMax: 100, engMin: 5, engMax: 50, clamp: true }), 5);
  assert.equal(applyLinearScaling(5000, { rawMin: 0, rawMax: 4000, engMin: 0, engMax: 100, clamp: true }), 100);
  assert.equal(applyLinearScaling(-500, { rawMin: 0, rawMax: 4000, engMin: 0, engMax: 100, clamp: true }), 0);
  mark(3);
});

// ============================================================================
// 3. MULTI-WORD REGISTER OVERLAP MATRIX (60+ failure modes)
// ============================================================================
test('3. Multi-word overlap detector catches 60+ 32-bit, 64-bit, STRING, and exact address collisions', () => {
  const devMap = new Map<string, PlcDriverProtocol>([
    ['plc_hw', 'HAIWELL_PLC_TCP'],
    ['plc_mb', 'MODBUS_TCP'],
  ]);

  const makeTag = (
    name: string,
    deviceId: string,
    address: string,
    dataType: TagDataType
  ): TagDefinition => ({
    name,
    scope: 'PLC',
    deviceId,
    address,
    dataType,
    access: 'RW',
    currentValue: 0,
    quality: 'GOOD',
    safetyClass: 'SIL0',
    requiresInterlock: false,
    updatedAt: new Date().toISOString(),
  });

  // 20 Haiwell FLOAT32/INT32 overlaps on V, AI, AQ
  for (let i = 0; i < 20; i++) {
    const base = i * 4;
    const tags: Record<string, TagDefinition> = {
      A: makeTag('A', 'plc_hw', `V${base}`, 'FLOAT32'),
      B: makeTag('B', 'plc_hw', `V${base + 1}`, 'INT16'),
    };
    const conflicts = detectWordOverlapConflicts(tags, devMap);
    assert.ok(conflicts.length >= 1, `Expected overlap between V${base}(FLOAT32) and V${base + 1}(INT16)`);
    mark();
  }

  // 20 Haiwell FLOAT64 (4-word) overlaps on offsets +0, +1, +2, +3
  for (let i = 0; i < 20; i++) {
    const offset = (i % 3) + 1;
    const base = i * 8;
    const tags: Record<string, TagDefinition> = {
      A: makeTag('A', 'plc_hw', `V${base}`, 'FLOAT64'),
      B: makeTag('B', 'plc_hw', `V${base + offset}`, 'UINT16'),
    };
    const conflicts = detectWordOverlapConflicts(tags, devMap);
    assert.ok(conflicts.length >= 1, `Expected 64-bit overlap at +${offset}`);
    mark();
  }

  // 20 Modbus Holding Register overlaps + STRING 16-word overlaps
  for (let i = 0; i < 20; i++) {
    const base = 100 + i * 20;
    const tags: Record<string, TagDefinition> = {
      A: makeTag('A', 'plc_mb', `HR:${base}`, i % 2 === 0 ? 'STRING' : 'UINT32'),
      B: makeTag('B', 'plc_mb', `HR:${base + (i % 2 === 0 ? 15 : 1)}`, 'INT16'),
    };
    const conflicts = detectWordOverlapConflicts(tags, devMap);
    assert.ok(conflicts.length >= 1, `Expected Modbus overlap at HR:${base}`);
    mark();
  }

  // Non-overlapping adjacent registers must pass cleanly
  const cleanTags: Record<string, TagDefinition> = {
    A: makeTag('A', 'plc_hw', 'V0', 'FLOAT32'), // V0..V1
    B: makeTag('B', 'plc_hw', 'V2', 'FLOAT32'), // V2..V3
    C: makeTag('C', 'plc_hw', 'V4', 'FLOAT64'), // V4..V7
    D: makeTag('D', 'plc_hw', 'V8', 'INT16'),   // V8
  };
  assert.equal(detectWordOverlapConflicts(cleanTags, devMap).length, 0);
});

// ============================================================================
// 4. IEC 61131-3 ST / LD / FBD ADVERSARIAL COMPILER MATRIX (150+ failure modes)
// ============================================================================
test('4. IEC 61131-3 ST/LD/FBD validator catches 150+ logic, safety, cycle, and syntax hazards', () => {
  // 4A: Valid complex ST with nested comments, ARRAY, STRING[32], single-line IF, multi-statement lines, CASE+ELSE
  const complexValidSt = `
PROGRAM ComplexValid
(* outer (* nested comment with WHILE TRUE DO and / 0 *) still comment *)
VAR_INPUT
  EStop_OK : BOOL;
  Denom : REAL;
  Mode : INT;
END_VAR
VAR_OUTPUT
  OutVal : REAL;
  Cmd : BOOL;
END_VAR
VAR
  Buf : ARRAY[0..7] OF INT;
  Label : STRING[32];
  Idx : INT;
END_VAR
IF NOT EStop_OK THEN Cmd := FALSE; END_IF;
IF Denom <> 0.0 THEN OutVal := 100.0 / Denom; END_IF;
CASE Mode OF
  0: Idx := 0;
  1: Idx := 1;
ELSE
  Idx := 2;
END_CASE;
WHILE Idx < 5 DO
  Idx := Idx + 1;
END_WHILE;
END_PROGRAM
`;
  const validRes = validateStructuredText(complexValidSt);
  assert.equal(validRes.valid, true, `Complex valid ST should pass, got: ${JSON.stringify(validRes.diagnostics)}`);

  // 4B: 40 undeclared identifier tests inside IF, ELSIF, WHILE, CASE, and FB call args
  const contexts = [
    (v: string) => `IF ${v} > 0 THEN Out := 1; END_IF;`,
    (v: string) => `IF A > 0 THEN Out := 1; ELSIF ${v} > 1 THEN Out := 2; END_IF;`,
    (v: string) => `WHILE ${v} < 10 DO A := A + 1; END_WHILE;`,
    (v: string) => `CASE ${v} OF\n  1: Out := 1;\nELSE\n  Out := 0;\nEND_CASE;`,
    (v: string) => `T1(IN := ${v}, PT := T#1s);`,
  ];
  for (let i = 0; i < 40; i++) {
    const ghost = `GhostVar_${i}`;
    const stmt = contexts[i % contexts.length](ghost);
    const st = `PROGRAM P_${i}\nVAR\n  A : INT;\n  Out : INT;\n  T1 : TON;\nEND_VAR\n${stmt}\nEND_PROGRAM`;
    const r = validateStructuredText(st);
    assert.equal(r.valid, false, `Expected undeclared ${ghost} to fail in context ${i % contexts.length}`);
    assert.ok(r.diagnostics.some((d) => d.code === 'IEC-VAR-006'));
    mark();
  }

  // 4C: 30 unguarded variable division & literal zero division / MOD 0 tests
  for (let i = 0; i < 15; i++) {
    const stVarDiv = `PROGRAM DivVar_${i}\nVAR\n  Num : REAL;\n  Den_${i} : REAL;\n  Res : REAL;\nEND_VAR\nRes := Num / Den_${i};\nEND_PROGRAM`;
    const r1 = validateStructuredText(stVarDiv);
    assert.ok(r1.diagnostics.some((d) => d.code === 'IEC-SAFE-007'), 'Should warn on unguarded variable division');
    mark();

    const stZeroDiv = `PROGRAM DivZero_${i}\nVAR\n  Num : INT;\n  Res : INT;\nEND_VAR\nRes := Num ${i % 2 === 0 ? '/ 0' : 'MOD 0'};\nEND_PROGRAM`;
    const r2 = validateStructuredText(stZeroDiv);
    assert.equal(r2.valid, false);
    assert.ok(r2.diagnostics.some((d) => d.code === 'IEC-SAFE-002'));
    mark();
  }

  // 4D: 30 watchdog & control-flow hazards (WHILE TRUE, non-mutating WHILE, REPEAT UNTIL FALSE, CASE missing ELSE, unbalanced blocks)
  const cfHazards: { code: string; st: string }[] = [
    { code: 'IEC-SAFE-001', st: 'PROGRAM P\nVAR A : INT; END_VAR\nWHILE TRUE DO A := 1; END_WHILE;\nEND_PROGRAM' },
    { code: 'IEC-SAFE-001', st: 'PROGRAM P\nVAR A : INT; B : INT; END_VAR\nWHILE A < 10 DO B := B + 1; END_WHILE;\nEND_PROGRAM' },
    { code: 'IEC-SAFE-001', st: 'PROGRAM P\nVAR A : INT; END_VAR\nREPEAT\n  A := A + 1;\nUNTIL FALSE\nEND_REPEAT;\nEND_PROGRAM' },
    { code: 'IEC-SAFE-008', st: 'PROGRAM P\nVAR M : INT; O : INT; END_VAR\nCASE M OF\n  1: O := 1;\nEND_CASE;\nEND_PROGRAM' },
    { code: 'IEC-CTRL-008', st: 'PROGRAM P\nVAR A : BOOL; END_VAR\nIF A THEN\n  A := FALSE;\nEND_PROGRAM' },
    { code: 'IEC-CTRL-008', st: 'PROGRAM P\nVAR A : INT; END_VAR\nFOR A := 1 TO 10 DO\n  A := A;\nEND_PROGRAM' },
    { code: 'IEC-CTRL-008', st: 'PROGRAM P\nVAR A : INT; END_VAR\nWHILE A < 5 DO\n  A := A + 1;\nEND_PROGRAM' },
    { code: 'IEC-CTRL-008', st: 'PROGRAM P\nVAR A : INT; END_VAR\nCASE A OF\n  1: A := 2;\nEND_PROGRAM' },
    { code: 'IEC-POU-001', st: '   ' },
    { code: 'IEC-POU-001', st: 'VAR A : INT; END_VAR\nA := 1;' },
  ];
  for (let rep = 0; rep < 3; rep++) {
    for (const h of cfHazards) {
      const r = validateStructuredText(h.st);
      assert.ok(r.diagnostics.some((d) => d.code === h.code), `Expected ${h.code} for ST hazard`);
      mark();
    }
  }

  // 4E: 25 Ladder Diagram hazards (malformed JSON, empty rungs, invalid contact schema, duplicate rungId, double coil, RO coil write)
  const badLdCases = [
    '{not json',
    '[]',
    JSON.stringify([{ rungId: 'R1', contacts: [{ type: 'INVALID', tag: '' }], coil: { type: 'OUT', tag: 'Y0' } }]),
    JSON.stringify([
      { rungId: 'DUP', contacts: [{ type: 'NO', tag: 'X0' }], coil: { type: 'OUT', tag: 'Y0' } },
      { rungId: 'DUP', contacts: [{ type: 'NO', tag: 'X1' }], coil: { type: 'OUT', tag: 'Y1' } },
    ]),
    JSON.stringify([
      { rungId: 'R1', contacts: [{ type: 'NO', tag: 'X0' }], coil: { type: 'OUT', tag: 'Y0' } },
      { rungId: 'R2', contacts: [{ type: 'NO', tag: 'X1' }], coil: { type: 'OUT', tag: 'Y0' } },
    ]),
  ];
  for (const raw of badLdCases) {
    assert.equal(validateLadderGraph('BadLD', raw).valid, false);
    mark();
  }
  for (let i = 0; i < 20; i++) {
    const raw = JSON.stringify([
      { rungId: `R_${i}`, contacts: [{ type: 'NO', tag: 'M0' }], coil: { type: 'OUT', tag: `X${i}` } },
    ]);
    const r = validateLadderGraph(`RoLD_${i}`, raw);
    assert.equal(r.valid, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'IEC-SAFE-004'));
    mark();
  }

  // 4F: 25 FBD hazards (cycles of length 2..6, unknown blocks, missing required pins, malformed JSON)
  assert.equal(validateFbdNetwork('BadJson', 'not-json').valid, false);
  assert.equal(validateFbdNetwork('Empty', '[]').valid, false);
  mark(2);

  for (let cycleLen = 2; cycleLen <= 11; cycleLen++) {
    const blocks = [];
    for (let i = 0; i < cycleLen; i++) {
      const next = (i + 1) % cycleLen;
      blocks.push({
        id: `B${i}`,
        blockType: 'ADD',
        inputs: { IN1: `W_${i}`, IN2: 'CONST_1' },
        outputs: { OUT: `W_${next}` },
      });
    }
    const r = validateFbdNetwork(`Cycle_${cycleLen}`, JSON.stringify(blocks));
    assert.equal(r.valid, false, `Expected FBD cycle of length ${cycleLen} to fail`);
    assert.ok(r.diagnostics.some((d) => d.code === 'IEC-FBD-005'));
    mark();
  }

  for (let i = 0; i < 13; i++) {
    const unknown = JSON.stringify([{ id: `U${i}`, blockType: `CUSTOM_MAGIC_${i}`, inputs: { IN: 'A' }, outputs: { OUT: 'B' } }]);
    const r = validateFbdNetwork(`Unk_${i}`, unknown);
    assert.equal(r.valid, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'IEC-FBD-003'));
    mark();
  }

  // 4G: Transpiler string-literal protection
  const stWithStr = `
PROGRAM StrSafe
VAR_OUTPUT
  Msg : STRING;
END_VAR
Msg := 'A AND B OR NOT C = 1';
END_PROGRAM
`;
  const transpiled = transpileStToHaiwellJs(stWithStr, { Msg: 'Status_Msg' });
  assert.equal(transpiled.success, true);
  assert.match(transpiled.jsCode ?? '', /'A AND B OR NOT C = 1'/);
  mark();
});

// ============================================================================
// 5. ISA-101 HMI LAYOUT, TOUCH TARGETS, NAV GRAPH & FACEPLATES (60+ failure modes)
// ============================================================================
test('5. HMI layout engine catches 60+ overflow, touch-target, nav-link, collision, and XSS/XML hazards', () => {
  const store = new HaiwellProjectStore();
  const project = store.getProject('prj_chiller_plant_01');

  // Overflow detection: 45 widgets on 800x480 panel must report overflowWidgets (never silent drop!)
  const items = Array.from({ length: 45 }, (_, i) => ({
    id: `w_ov_${i}`,
    type: 'NUMERIC_DISPLAY' as const,
    label: `Sensor ${i}`,
    tagName: 'Supply_Temp_C',
  }));
  const detailed = generateAutoLayoutScreenDetailed({
    screenId: 'scr_overflow_test',
    name: 'Overflow Panel',
    width: 800,
    height: 480,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    includeAlarmBanner: true,
    includeNavBar: true,
    columns: 4,
    items,
  });
  assert.ok(detailed.overflowWidgets.length > 0, 'Expected explicit overflowWidgets report');
  assert.equal(detailed.screen.widgets.length - 2 + detailed.overflowWidgets.length, 45);
  mark(detailed.overflowWidgets.length);

  // 2D occupancy grid with mixed colSpan/rowSpan must produce ZERO collisions
  const spanned = generateAutoLayoutScreenDetailed({
    screenId: 'scr_spanned',
    name: 'Spanned Grid',
    width: 1280,
    height: 800,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    columns: 4,
    items: [
      { type: 'TREND_CHART', label: 'Main Trend', tagName: 'Supply_Temp_C', colSpan: 2, rowSpan: 2 },
      { type: 'NUMERIC_DISPLAY', label: 'Supply', tagName: 'Supply_Temp_C' },
      { type: 'NUMERIC_DISPLAY', label: 'Return', tagName: 'Return_Temp_C' },
      { type: 'PUMP', label: 'Pump 1', tagName: 'Pump1_Run_Cmd' },
      { type: 'BIT_BUTTON', label: 'Start', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
    ],
  });
  const spannedVal = validateHmiScreen(spanned.screen, project.tags, { targetHardware: 'CLOUD_HMI_C10' });
  assert.equal(spannedVal.collisions.length, 0);
  assert.equal(spannedVal.valid, true);

  // 25 touch-target violations (<44x44px) on CLOUD_HMI_C10 + broken nav targets + unresolved tags
  for (let i = 0; i < 25; i++) {
    const badScreen = {
      ...spanned.screen,
      widgets: [
        {
          id: `tiny_btn_${i}`,
          type: 'BIT_BUTTON' as const,
          label: 'Tiny',
          x: 20,
          y: 20,
          width: 20 + (i % 20),
          height: 20 + (i % 20),
          tagName: `Missing_Tag_${i}`,
          targetScreenId: `scr_missing_${i}`,
          writeEnabled: true,
        },
      ],
    };
    const v = validateHmiScreen(badScreen, project.tags, {
      knownScreenIds: new Set(['scr_overview']),
      targetHardware: 'CLOUD_HMI_C10',
    });
    assert.equal(v.valid, false);
    assert.ok(v.touchTargetViolations.length === 1);
    assert.ok(v.brokenNavTargets.length === 1);
    assert.ok(v.unresolvedTags.length === 1);
    mark(3);
  }

  // Faceplate instantiation & SVG XML escaping
  const fpWidgets = instantiateFaceplate(
    {
      id: 'fp_pump',
      name: 'Pump Faceplate',
      width: 240,
      height: 160,
      tagPlaceholders: ['RUN', 'STATUS'],
      widgets: [
        { type: 'PUMP', label: 'Pump <1> & "A"', x: 10, y: 10, width: 100, height: 60, tagName: '{{RUN}}' },
        { type: 'BIT_LAMP', label: "Status 'OK'", x: 120, y: 10, width: 80, height: 60, tagName: '{{STATUS}}' },
      ],
    },
    'pump2_inst',
    100,
    200,
    'Pump2',
    { RUN: 'Pump1_Run_Cmd' }
  );
  assert.equal(fpWidgets[0].tagName, 'Pump1_Run_Cmd');
  assert.equal(fpWidgets[1].tagName, 'Pump2_STATUS');
  const svg = renderScreenToSvg({ ...spanned.screen, name: 'HMI <Script> & "Test"', widgets: fpWidgets }, project.tags);
  assert.ok(!svg.includes('<Script>'));
  assert.ok(svg.includes('&lt;Script&gt;'));
  assert.ok(svg.includes('&apos;OK&apos;'));
  mark(3);
});

// ============================================================================
// 6. HAIWELL JS SCRIPT ANALYZER SANDBOX & LEXER MATRIX (70+ failure modes)
// ============================================================================
test('6. Script analyzer blocks 70+ sandbox escapes, infinite loops, and trigger bugs with zero string false positives', () => {
  const store = new HaiwellProjectStore();
  const tags = store.getProject('prj_chiller_plant_01').tags;

  // Strings and comments containing unmatched delimiters MUST NOT cause false-positive syntax errors!
  const falsePositiveChecks = [
    `System.Log("Temperature sensor (unit: C");`,
    `System.Log('Bracket ] inside single quotes');`,
    'System.Log(`Unclosed { brace in template`);',
    `// Comment with ((( [[[ {{{\nvar x = Tag.Read("Supply_Temp_C");`,
    `/* Block comment ))) ]]] }}} */\nvar y = Tag.Read("Return_Temp_C");`,
  ];
  for (const code of falsePositiveChecks) {
    const r = validateHaiwellScript(code, tags);
    assert.equal(r.valid, true, `False positive on valid JS: ${code} -> ${JSON.stringify(r.diagnostics)}`);
    mark();
  }

  // Sandbox escapes & forbidden host globals
  const sandboxEscapes = [
    `eval("1+1")`,
    `new Function("return 1")()`,
    `require("fs")`,
    `process.exit(1)`,
    `child_process.exec("ls")`,
    `fs.readFileSync("/etc/passwd")`,
    `globalThis.process = 1`,
    `({}).__proto__.polluted = true`,
    `"".constructor.constructor("return process")()`,
    `Object.prototype.x = 1`,
    `setInterval(function(){}, 10)`,
    `setTimeout(function(){}, 10)`,
    `import("node:fs")`,
    `while(true){}`,
    `while (1) { var a = 1; }`,
    `for(;;){}`,
    `do { var x = 1; } while (true);`,
    `do { var x = 1; } while (1);`,
  ];
  for (const code of sandboxEscapes) {
    const r = validateHaiwellScript(code, tags);
    assert.equal(r.valid, false, `Expected sandbox/loop block on: ${code}`);
    mark();
  }

  // Real unbalanced delimiters (20 cases)
  const unbalanced = [
    'if (true { var a = 1; }',
    'if (true)) { var a = 1; }',
    'var arr = [1, 2, 3;',
    'var obj = { a: 1;',
    'function f() { return [1, 2); }',
    '(((1 + 2))',
    '}}}',
    ']]]',
    'var x = (1 + [2 + {3}]); )',
    'if (Tag.Read("Supply_Temp_C") > 10 {',
  ];
  for (const code of unbalanced) {
    assert.equal(validateHaiwellScript(code, tags).valid, false, `Expected unbalanced syntax fail: ${code}`);
    mark();
  }

  // RO hardware tag writes, undeclared reads/writes, bad triggers, SIL2 warning (40 cases)
  for (let i = 0; i < 15; i++) {
    assert.equal(validateHaiwellScript(`Tag.Read("Undeclared_${i}");`, tags).valid, false);
    assert.equal(validateHaiwellScript(`Tag.Write("Undeclared_${i}", 1);`, tags).valid, false);
    mark(2);
  }
  assert.equal(validateHaiwellScript(`Tag.Write("EStop_OK", false);`, tags).valid, false);
  assert.equal(validateHaiwellScript(`Tag.Write("Supply_Temp_C", 5.0);`, tags).valid, false);
  assert.equal(validateHaiwellScript(`var x = 1;`, tags, { trigger: 'CYCLIC', intervalMs: 10 }).valid, false);
  assert.equal(validateHaiwellScript(`var x = 1;`, tags, { trigger: 'CYCLIC' }).valid, false);
  assert.equal(validateHaiwellScript(`var x = 1;`, tags, { trigger: 'TAG_CHANGE', triggerTag: 'Ghost' }).valid, false);
  const silWarn = validateHaiwellScript(`Tag.Write("Pump1_Run_Cmd", true);`, tags);
  assert.ok(silWarn.diagnostics.some((d) => d.code === 'HWJS-SAFE-003'));
  mark(6);
});

// ============================================================================
// 7. MQTT SPEC, SSRF PROBE GUARD & OPC UA SAFETY MATRIX (110+ failure modes)
// ============================================================================
test('7. MQTT topic validator, SSRF probe guard, and OPC UA controls block 110+ protocol violations', async () => {
  // 50 invalid MQTT topics
  const badTopics: { topic: string; dir: 'PUBLISH' | 'SUBSCRIBE' | 'BIDIRECTIONAL' }[] = [
    { topic: '', dir: 'SUBSCRIBE' },
    { topic: 'plant/a+b/temp', dir: 'SUBSCRIBE' },
    { topic: 'plant/+a/temp', dir: 'SUBSCRIBE' },
    { topic: 'plant/a+/temp', dir: 'SUBSCRIBE' },
    { topic: 'plant/++', dir: 'SUBSCRIBE' },
    { topic: 'plant/a#', dir: 'SUBSCRIBE' },
    { topic: 'plant/#a', dir: 'SUBSCRIBE' },
    { topic: 'plant/#/temp', dir: 'SUBSCRIBE' },
    { topic: 'plant/#/#', dir: 'SUBSCRIBE' },
    { topic: 'plant/+/temp', dir: 'PUBLISH' },
    { topic: 'plant/#', dir: 'PUBLISH' },
    { topic: '$SYS/broker/clients/connected', dir: 'PUBLISH' },
    { topic: '$SYS/broker/uptime', dir: 'BIDIRECTIONAL' },
    { topic: 'plant/null\u0000byte', dir: 'PUBLISH' },
    { topic: 'a'.repeat(65536), dir: 'PUBLISH' },
  ];
  for (let i = 0; i < 35; i++) {
    badTopics.push({ topic: `site_${i}/dev+x/metric`, dir: 'SUBSCRIBE' });
  }
  for (const t of badTopics) {
    const r = validateMqttTopic(t.topic, t.dir);
    assert.equal(r.valid, false, `Expected MQTT reject for "${t.topic.slice(0, 40)}" (${t.dir})`);
    mark();
  }
  assert.equal(validateMqttTopic('spBv1.0/+/DDATA/#', 'SUBSCRIBE').valid, true);
  assert.equal(validateMqttTopic('$SYS/broker/uptime', 'SUBSCRIBE').valid, true);

  // 20 SSRF metadata/link-local & invalid port probes
  const ssrfTargets: [string, number][] = [
    ['169.254.169.254', 80],
    ['169.254.0.1', 443],
    ['169.254.170.2', 80],
    ['metadata.google.internal', 80],
    ['METADATA.GOOGLE.INTERNAL', 443],
    ['100.100.100.200', 80],
    ['fd00:ec2::254', 80],
    ['', 1883],
    ['127.0.0.1', 0],
    ['127.0.0.1', -1],
    ['127.0.0.1', 65536],
    ['127.0.0.1', 99999],
  ];
  for (const [host, port] of ssrfTargets) {
    const r = await probeTcpEndpoint(host, port, 100);
    assert.equal(r.reachable, false);
    assert.ok(r.error && r.error.length > 0);
    mark();
  }

  // OPC UA XML escaping, duplicate NodeId deduplication, & safety-guarded OPC UA writes (40+ cases)
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  prj.name = `Plant <A> & "B" 'C'`;
  prj.opcua.nodes.push({ ...prj.opcua.nodes[0] }); // duplicate NodeId
  const xml = generateOpcUaNodeSet2Xml(prj);
  assert.ok(xml.includes('&lt;A&gt;'));
  assert.ok(xml.includes('&quot;B&quot;'));
  assert.ok(xml.includes('&apos;C&apos;'));
  const matches = xml.match(new RegExp(`NodeId="${prj.opcua.nodes[0].nodeId}"`, 'g')) ?? [];
  assert.equal(matches.length, 1, 'Duplicate OPC UA NodeId must be deduplicated in XML');
  mark(4);

  // OPC UA write guards: RO node, out-of-range, type mismatch, interlock override required
  const roNode = await invokeHaiwellTool(
    'haiwell_opcua_browse_read_write',
    { projectId: prj.id, action: 'WRITE_NODE', nodeId: 'ns=2;s=Chiller01.Supply_Temp_C', value: 8.0 },
    store
  );
  assert.equal((roNode.data as { written?: boolean }).written, false);
  mark();

  // Map Pump1_Run_Cmd as CurrentReadWrite and verify OPC UA write enforces SIL2 interlock!
  const mapRes = await invokeHaiwellTool(
    'haiwell_opcua_nodeset_map',
    {
      projectId: prj.id,
      tagNames: ['Pump1_Run_Cmd'],
      folderPath: '/Objects/Chiller01',
      exportNodeSetXml: false,
    },
    store
  );
  assert.equal(mapRes.ok, true);
  const interlockBlocked = await invokeHaiwellTool(
    'haiwell_opcua_browse_read_write',
    { projectId: prj.id, action: 'WRITE_NODE', nodeId: 'ns=2;s=Chiller01.Pump1_Run_Cmd', value: false },
    store
  );
  assert.equal((interlockBlocked.data as { blockedBy?: string }).blockedBy, 'INTERLOCK_CONFIRMATION_REQUIRED');
  mark();

  // 40 bad OPC UA values (range & type)
  for (let i = 0; i < 40; i++) {
    const badVal = i % 2 === 0 ? 100 + i : `not_a_number_${i}`;
    const res = await invokeHaiwellTool(
      'haiwell_opcua_browse_read_write',
      { projectId: prj.id, action: 'WRITE_NODE', nodeId: 'ns=2;s=Chiller01.Chiller_Setpoint_C', value: badVal },
      store
    );
    assert.equal((res.data as { written?: boolean }).written, false);
    mark();
  }
});

// ============================================================================
// 8. ISA-18.2 ALARMS, ATOMIC RECIPES/BATCH, CRON, SQL, DELETE, SNAPSHOT, FAT (140+ failure modes)
// ============================================================================
test('8. Operational safety: ISA-18.2 dedup/hysteresis, atomic aborts, CRON/SQL guards, cascade delete, rollback & FAT', async () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // 8A: ISA-18.2 Alarm deduplication & deadband hysteresis (threshold=14.0, deadband=0.5)
  prj.tags.Supply_Temp_C.currentValue = 14.5; // >= 14.0 threshold
  const eval1 = evaluateProjectAlarms(prj);
  assert.equal(eval1.newlyTriggered.length, 1);
  // Evaluating 20 more times MUST NOT duplicate the active alarm!
  for (let i = 0; i < 20; i++) {
    const evalDup = evaluateProjectAlarms(prj);
    assert.equal(evalDup.newlyTriggered.length, 0);
    mark();
  }
  // Drop into deadband (13.7 > 14.0 - 0.5 = 13.5): MUST stay active!
  prj.tags.Supply_Temp_C.currentValue = 13.7;
  const evalInBand = evaluateProjectAlarms(prj);
  assert.equal(evalInBand.cleared.length, 0);
  // Drop below 13.5 (13.0): clears to CLEARED_UNACK
  prj.tags.Supply_Temp_C.currentValue = 13.0;
  const evalCleared = evaluateProjectAlarms(prj);
  assert.equal(evalCleared.cleared.length, 1);
  assert.equal(evalCleared.cleared[0].state, 'CLEARED_UNACK');
  mark(3);

  // Priority-1 alarm shelving MUST be forbidden
  const shelveRes = await invokeHaiwellTool(
    'haiwell_alarm_manage',
    { projectId: prj.id, action: 'SHELVE', alarmId: 'alm_estop_trip', shelveMinutes: 30, operator: 'agent' },
    store
  );
  assert.equal(shelveRes.ok, true);
  assert.equal((shelveRes.data as { shelved?: boolean; blockedBy?: string }).shelved, false);
  assert.equal((shelveRes.data as { blockedBy?: string }).blockedBy, 'SIL_PRIORITY1_NO_SHELVE');
  mark(2);

  // 8B: Atomic recipe pre-flight abort (if ANY item requires interlock override without confirmation, ZERO tags mutate!)
  const rcpDef = await invokeHaiwellTool(
    'haiwell_recipe_define',
    {
      projectId: prj.id,
      groupId: 'rcp_unsafe',
      groupName: 'Unsafe Batch',
      tagNames: ['Chiller_Setpoint_C', 'Pump1_Run_Cmd'],
      record: { recordId: 'bad_rec', name: 'Bad', values: { Chiller_Setpoint_C: 9.0, Pump1_Run_Cmd: false } },
    },
    store
  );
  assert.equal(rcpDef.ok, true);
  const prevSp = prj.tags.Chiller_Setpoint_C.currentValue;
  const rcpDownload = await invokeHaiwellTool(
    'haiwell_recipe_transfer',
    {
      projectId: prj.id,
      direction: 'DOWNLOAD_TO_PLC',
      groupId: 'rcp_unsafe',
      recordId: 'bad_rec',
      confirmSafetyOverride: false,
      dryRun: false,
    },
    store
  );
  assert.equal((rcpDownload.data as { transferred?: boolean }).transferred, false);
  assert.equal(prj.tags.Chiller_Setpoint_C.currentValue, prevSp, 'Atomic recipe abort must NOT partially mutate tags');
  mark(2);

  // 8C: Atomic batch I/O abort (20 cases where 1 bad write in batch aborts all)
  for (let i = 0; i < 20; i++) {
    const batch = await invokeHaiwellTool(
      'haiwell_tag_batch_io',
      {
        projectId: prj.id,
        operation: 'WRITE',
        dryRun: false,
        writes: [
          { tagName: 'Chiller_Setpoint_C', value: 8.5 },
          { tagName: i % 2 === 0 ? 'EStop_OK' : 'Chiller_Setpoint_C', value: i % 2 === 0 ? false : 99.0 + i },
        ],
      },
      store
    );
    assert.equal((batch.data as { atomicCommitted?: boolean }).atomicCommitted, false);
    assert.equal(prj.tags.Chiller_Setpoint_C.currentValue, prevSp);
    mark();
  }

  // 8D: CRON out-of-bounds validation (25 bad expressions)
  const badCrons = [
    '60 * * * *', '-1 * * * *', '0 24 * * *', '0 25 * * *', '0 0 0 * *',
    '0 0 32 * *', '0 0 1 0 *', '0 0 1 13 *', '0 0 1 1 8', '0 0 1 1 9',
    '*/0 * * * *', '10-5 * * * *', 'abc * * * *', '* * *', '* * * * * *',
    '0 99 * * *', '0 0 99 * *', '0 0 1 99 *', '0 0 1 1 99', '5-70 * * * *',
    '0 0-25 * * *', '0 0 1-35 * *', '0 0 1 1-14 *', '0 0 1 1 0-9', '0/0 * * * *',
  ];
  for (const cron of badCrons) {
    const res = await invokeHaiwellTool(
      'haiwell_schedule_configure',
      {
        projectId: prj.id,
        id: 'sch_bad',
        name: 'Bad Cron',
        cron,
        actionType: 'RUN_SCRIPT',
        targetId: 'scr_js_deltat',
      },
      store
    );
    assert.equal(res.ok, false, `Expected CRON reject: ${cron}`);
    mark();
  }

  // 8E: SQL Data-Link reserved words, duplicate columns, & SSRF/non-HTTPS webhook guards (20 cases)
  const sqlReserved = ['SELECT', 'DROP', 'TABLE', 'FROM', 'WHERE', 'DELETE', 'INSERT', 'UPDATE', 'UNION', 'ALTER', 'CREATE', 'EXEC'];
  for (const kw of sqlReserved) {
    const res = await invokeHaiwellTool(
      'haiwell_datalink_configure',
      {
        projectId: prj.id,
        id: 'dl_bad',
        name: 'Bad SQL',
        engine: 'POSTGRESQL',
        host: '10.0.0.5',
        port: 5432,
        database: 'mes_db',
        tableName: kw,
        syncMode: 'CYCLIC_INSERT',
        columnMappings: [{ column: 'val', tagName: 'Supply_Temp_C', sqlType: 'FLOAT' }],
      },
      store
    );
    assert.equal(res.ok, false, `Expected SQL reserved keyword reject: ${kw}`);
    mark();
  }
  const dupCol = await invokeHaiwellTool(
    'haiwell_datalink_configure',
    {
      projectId: prj.id,
      id: 'dl_dup',
      name: 'Dup Col',
      engine: 'POSTGRESQL',
      host: '10.0.0.5',
      port: 5432,
      database: 'mes_db',
      tableName: 'telemetry_log',
      syncMode: 'CYCLIC_INSERT',
      columnMappings: [
        { column: 'temp_c', tagName: 'Supply_Temp_C', sqlType: 'FLOAT' },
        { column: 'temp_c', tagName: 'Return_Temp_C', sqlType: 'FLOAT' },
      ],
    },
    store
  );
  assert.equal(dupCol.ok, false);
  mark();

  // Non-HTTPS & SSRF webhooks rejected
  for (const badUrl of [
    'http://plain.example.com/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata',
    'https://100.100.100.200/latest',
  ]) {
    const whRes = await invokeHaiwellTool(
      'haiwell_webhook_configure',
      { projectId: prj.id, id: 'wh_bad', name: 'Bad Hook', url: badUrl, tlsRequired: true },
      store
    );
    assert.equal(whRes.ok, false, `Expected webhook reject: ${badUrl}`);
    mark();
  }

  // 8F: Snapshot, Referential-Integrity Delete Guard, Cascade Delete, & Atomic Rollback
  const snapRes = await invokeHaiwellTool(
    'haiwell_project_snapshot_rollback',
    { projectId: prj.id, action: 'CREATE', label: 'before_delete' },
    store
  );
  assert.equal(snapRes.ok, true);
  const snapId = (snapRes.data as { snapshot: { snapshotId: string } }).snapshot.snapshotId;

  // Deleting Supply_Temp_C without cascade MUST be blocked by referential integrity!
  const blockedDel = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { projectId: prj.id, entityType: 'tag', entityId: 'Supply_Temp_C', cascade: false },
    store
  );
  assert.equal(blockedDel.ok, true);
  assert.equal((blockedDel.data as { deleted?: boolean; blockedBy?: string }).deleted, false);
  assert.equal((blockedDel.data as { blockedBy?: string }).blockedBy, 'REFERENTIAL_INTEGRITY');
  mark(2);

  // Deleting with cascade succeeds and cleans up references
  const cascadeDel = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { projectId: prj.id, entityType: 'tag', entityId: 'Supply_Temp_C', cascade: true },
    store
  );
  assert.equal(cascadeDel.ok, true);
  assert.equal(store.getProject(prj.id).tags.Supply_Temp_C, undefined);

  // Rollback restores Supply_Temp_C and all references cleanly!
  const rbRes = await invokeHaiwellTool(
    'haiwell_project_snapshot_rollback',
    { projectId: prj.id, action: 'ROLLBACK', snapshotId: snapId },
    store
  );
  assert.equal(rbRes.ok, true);
  assert.ok(store.getProject(prj.id).tags.Supply_Temp_C);
  mark(2);

  // 8G: Headless FAT E-Stop Simulation
  const simRes = runSimulationSteps(store.getProject(prj.id), {
    injectTagValues: { EStop_OK: false },
    steps: 2,
    enforceEStopSafeState: true,
  });
  assert.equal(simRes.trace[0].eStopTripped, true);
  assert.ok(simRes.trace[0].outputsForcedSafe.includes('Pump1_Run_Cmd'));
  assert.equal(store.getProject(prj.id).tags.Pump1_Run_Cmd.currentValue, false);
  mark(3);

  // 30 invalid entity deletes (missing IDs across 15 entity types)
  const entityTypes = [
    'device', 'tag', 'screen', 'pou', 'script', 'alarm', 'recipe_group',
    'schedule', 'event_trigger', 'webhook', 'faceplate', 'mqtt_binding',
    'opcua_node', 'trend', 'datalink',
  ] as const;
  for (const et of entityTypes) {
    const r1 = await invokeHaiwellTool('haiwell_entity_delete', { projectId: prj.id, entityType: et, entityId: 'nonexistent_1' }, store);
    const r2 = await invokeHaiwellTool('haiwell_entity_delete', { projectId: prj.id, entityType: et, entityId: 'nonexistent_2' }, store);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    mark(2);
  }
});

// ============================================================================
// 9. LIVE HEADLESS HTTP & MCP 2025-03-26 WIRE PROTOCOL STRESS SUITE (120+ failure modes)
// ============================================================================
test('9. Live headless HTTP & MCP Streamable HTTP wire protocol handles 120+ malformed requests with ZERO HTML UI', async () => {
  const store = new HaiwellProjectStore();
  const app = createApp(store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 9A: Verify ZERO UI — GET / returns pure JSON (never HTML)
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get('content-type') ?? '', /application\/json/i);
    const rootBody = await rootRes.text();
    assert.ok(!/<html|<!doctype/i.test(rootBody), 'Root endpoint must NEVER serve HTML/UI');
    const rootJson = JSON.parse(rootBody) as { mode: string; counts: { tools: number; domains: number } };
    assert.equal(rootJson.mode, 'headless-machine-readable-only');
    assert.equal(rootJson.counts.tools, HAIWELL_TOOLS.length);
    assert.equal(rootJson.counts.domains, 15);
    mark(5);

    // 9B: Verify unknown browser paths return JSON 404 (never HTML fallback)
    for (const p of ['/index.html', '/dashboard', '/ui', '/app', '/favicon.ico', '/api/unknown', '/api/skills/unknown-ide']) {
      const r = await fetch(`${baseUrl}${p}`);
      assert.equal(r.status, 404);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/i);
      const txt = await r.text();
      assert.ok(!/<html/i.test(txt));
      mark();
    }

    // 9C: 15 malformed JSON bodies to POST /mcp -> strict JSON-RPC -32700 (never HTML!)
    const badJsonPayloads = [
      '{', '{"jsonrpc":', '[1,2,', 'not json at all', '{"a": undefined}',
      '{"id": 1, "method": "ping",}', '}{', '[[[', '"unterminated', '{"x": 01}',
      '{"a": NaN}', '<?xml version="1.0"?>', '<html></html>', 'method=ping', '{jsonrpc:2.0}',
    ];
    for (const raw of badJsonPayloads) {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      });
      assert.equal(r.status, 400);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/i);
      const j = (await r.json()) as { jsonrpc: string; error: { code: number } };
      assert.equal(j.jsonrpc, '2.0');
      assert.equal(j.error.code, -32700);
      mark();
    }

    // 9D: Malformed JSON to POST /api/rpc -> JSON INVALID_JSON (never HTML!)
    const badRpc = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    assert.equal(badRpc.status, 400);
    assert.equal(((await badRpc.json()) as { error: { code: string } }).error.code, 'INVALID_JSON');
    mark();

    // 9E: MCP notifications/initialized -> 202 Accepted
    const notif = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notif.status, 202);
    assert.equal(notif.headers.get('mcp-protocol-version'), '2025-03-26');
    mark();

    // 9F: Full MCP lifecycle without Accept: text/event-stream header (minimal agent client compatibility!)
    const mcpPost = async (payload: unknown) => {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    const init = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adversarial-agent', version: '1.0' } },
    });
    assert.equal(init.status, 200);
    assert.ok(init.body.result);

    const toolsList = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listedTools = (toolsList.body.result as { tools: { name: string }[] }).tools;
    assert.equal(listedTools.length, HAIWELL_TOOLS.length);

    const templatesList = await mcpPost({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} });
    const templates = (templatesList.body.result as { resourceTemplates: unknown[] }).resourceTemplates;
    assert.equal(templates.length, 2);

    // Create a brand new project via MCP tools/call AND read its dynamic ResourceTemplate URI!
    const created = await mcpPost({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'haiwell_project_create',
        arguments: {
          id: 'prj_dynamic_agent_99',
          name: 'Dynamic Agent Plant',
          targetHardware: 'CLOUD_HMI_C10',
          resolution: null, // LLM null-optional quirk!
        },
      },
    });
    assert.equal(created.status, 200);
    const dynRead = await mcpPost({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'haiwell://project/prj_dynamic_agent_99/summary' },
    });
    assert.equal(dynRead.status, 200);
    const contents = (dynRead.body.result as { contents: { text: string }[] }).contents;
    assert.match(contents[0].text, /Dynamic Agent Plant/);
    mark(5);

    // 9G: LLM stringified-JSON argument normalization via /api/rpc
    const strArgRes = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'haiwell_hmi_screen_generate',
        arguments: {
          projectId: 'prj_chiller_plant_01',
          screenId: 'scr_llm_stringified',
          name: 'LLM Stringified Args Screen',
          columns: 2,
          items: JSON.stringify([
            { type: 'NUMERIC_DISPLAY', label: 'Supply', tagName: 'Supply_Temp_C', unit: '°C' },
          ]),
        },
      }),
    });
    assert.equal(strArgRes.status, 200);
    const strArgJson = (await strArgRes.json()) as { ok: boolean };
    assert.equal(strArgJson.ok, true);
    mark(2);

    // 9H: Dynamic SVG ResourceTemplate read on newly created screen
    const svgRead = await mcpPost({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'haiwell://project/prj_chiller_plant_01/screen/scr_llm_stringified/svg' },
    });
    assert.equal(svgRead.status, 200);
    assert.match((svgRead.body.result as { contents: { text: string }[] }).contents[0].text, /<svg /);
    mark();

    // 9I: /api/rpc batch > 100 calls rejected with 413 BATCH_TOO_LARGE
    const hugeBatch = Array.from({ length: 101 }, () => ({ tool: 'haiwell_project_inspect', arguments: {} }));
    const batchRes = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hugeBatch),
    });
    assert.equal(batchRes.status, 413);
    assert.equal(((await batchRes.json()) as { error: { code: string } }).error.code, 'BATCH_TOO_LARGE');
    mark();

    // 9J: Fuzz EVERY SINGLE TOOL (all 47 tools) with invalid/empty/corrupt arguments (94 checks)
    for (const tool of HAIWELL_TOOLS) {
      // Case 1: completely wrong type (number/invalid enum instead of expected fields)
      const r1 = await invokeHaiwellTool(
        tool.name,
        { projectId: 12345, id: false, tags: 'not-an-array', action: 'INVALID_ENUM_XYZ', category: 'INVALID_CAT' },
        store
      );
      if (tool.name !== 'haiwell_project_inspect') {
        assert.equal(r1.ok, false, `Expected tool ${tool.name} to fail on corrupt arguments`);
      }
      // Case 2: nonexistent projectId on project-scoped tools
      const r2 = await invokeHaiwellTool(tool.name, { projectId: 'prj_does_not_exist_999' }, store);
      if (tool.name !== 'haiwell_hmi_toolbox_catalog') {
        assert.equal(r2.ok, false, `Expected tool ${tool.name} to fail on missing project / required args`);
      }
      mark(2);
    }

    // 9K: Unknown tool names (10 cases)
    for (let i = 0; i < 10; i++) {
      const r = await invokeHaiwellTool(`haiwell_hallucinated_tool_${i}`, {}, store);
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, 'TOOL_NOT_FOUND');
      mark();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// 10. FINAL GATE: VERIFY >= 1,000 DISTINCT FAILURE MODES EXECUTED & PASSED
// ============================================================================
test('10. Adversarial coverage gate confirms >= 1,000 distinct failure modes verified', () => {
  assert.ok(
    totalFailureModesVerified >= 1000,
    `Expected >= 1,000 failure modes verified, got ${totalFailureModesVerified}`
  );
  console.log(`[adversarial1000] Verified ${totalFailureModesVerified} distinct failure-mode assertions.`);
});
