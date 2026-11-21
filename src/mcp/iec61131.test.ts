import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transpileStToHaiwellJs,
  validateFbdNetwork,
  validateLadderGraph,
  validateStructuredText,
} from './iec61131';

test('validates compliant IEC 61131-3 Structured Text program', () => {
  const st = `
PROGRAM PumpCtrl
VAR_INPUT
  EStop_OK AT %IX0.0 : BOOL;
  Flow : REAL;
END_VAR
VAR_OUTPUT
  PumpCmd AT %QX0.0 : BOOL;
END_VAR
VAR
  DelayTimer : TON;
END_VAR
IF NOT EStop_OK THEN
  PumpCmd := FALSE;
ELSE
  DelayTimer(IN := TRUE, PT := T#2s);
  IF Flow > 10.5 THEN
    PumpCmd := TRUE;
  END_IF;
END_IF;
END_PROGRAM
`;
  const res = validateStructuredText(st);
  assert.equal(res.valid, true);
  assert.equal(res.summary.errors, 0);
  assert.equal(res.pouName, 'PumpCtrl');
});

test('catches watchdog infinite loop, division by zero, float equality, VAR_INPUT write, and implicit narrowing', () => {
  const badSt = `
PROGRAM UnsafeCtrl
VAR_INPUT
  SensorIn : REAL;
END_VAR
VAR
  CountInt : INT;
  Ratio : REAL;
END_VAR
WHILE TRUE DO
  SensorIn := 1.0;
  Ratio := SensorIn / 0;
  CountInt := SensorIn;
  IF SensorIn = 5.0 THEN
    CountInt := 1;
  END_IF;
END_WHILE;
END_PROGRAM
`;
  const res = validateStructuredText(badSt);
  assert.equal(res.valid, false);
  const codes = new Set(res.diagnostics.map((d) => d.code));
  assert.equal(codes.has('IEC-SAFE-001'), true, 'should catch WHILE TRUE');
  assert.equal(codes.has('IEC-SAFE-002'), true, 'should catch div by zero');
  assert.equal(codes.has('IEC-SAFE-003'), true, 'should warn on REAL exact equality');
  assert.equal(codes.has('IEC-SAFE-005'), true, 'should block VAR_INPUT assignment');
  assert.equal(codes.has('IEC-TYPE-002'), true, 'should block REAL -> INT narrowing');
});

test('detects Ladder double-coil hazard and physical input coil write', () => {
  const rungs = JSON.stringify([
    { rungId: 'R1', contacts: [{ type: 'NO', tag: 'X0' }], coil: { type: 'OUT', tag: 'Y0' } },
    { rungId: 'R2', contacts: [{ type: 'NO', tag: 'X1' }], coil: { type: 'OUT', tag: 'Y0' } },
    { rungId: 'R3', contacts: [{ type: 'NO', tag: 'M0' }], coil: { type: 'OUT', tag: 'X2' } },
  ]);
  const res = validateLadderGraph('HazardLD', rungs);
  assert.equal(res.valid, false);
  const codes = new Set(res.diagnostics.map((d) => d.code));
  assert.equal(codes.has('IEC-LD-003'), true);
  assert.equal(codes.has('IEC-SAFE-004'), true);
});

test('validates FBD network and transpiles ST to Haiwell JavaScript', () => {
  const fbd = validateFbdNetwork(
    'ScaleNet',
    JSON.stringify([{ id: 'B1', blockType: 'LIMIT', inputs: { MN: '0', IN: 'AI0', MX: '100' }, outputs: { OUT: 'V10' } }])
  );
  assert.equal(fbd.valid, true);

  const missingPins = validateFbdNetwork(
    'BadScaleNet',
    JSON.stringify([{ id: 'B1', blockType: 'LIMIT', inputs: { IN: 'AI0' }, outputs: { OUT: 'V10' } }])
  );
  assert.equal(missingPins.valid, false);
  assert.ok(missingPins.diagnostics.some((d) => d.code === 'IEC-FBD-004'));

  const st = `
PROGRAM DeltaCalc
VAR_INPUT
  Supply : REAL;
  Ret : REAL;
END_VAR
VAR_OUTPUT
  DeltaT : REAL;
END_VAR
DeltaT := Ret - Supply;
END_PROGRAM
`;
  const js = transpileStToHaiwellJs(st, { Supply: 'Supply_Temp_C', Ret: 'Return_Temp_C', DeltaT: 'Plant_DeltaT_C' });
  assert.equal(js.success, true);
  assert.match(js.jsCode ?? '', /Variable\.GetByFullName\("Supply_Temp_C"\)/);
  assert.match(js.jsCode ?? '', /Variable\.SetByFullName\("Plant_DeltaT_C", DeltaT\)/);

  const legacyJs = transpileStToHaiwellJs(
    st,
    { Supply: 'Supply_Temp_C', Ret: 'Return_Temp_C', DeltaT: 'Plant_DeltaT_C' },
    { apiStyle: 'TAG_API' }
  );
  assert.equal(legacyJs.success, true);
  assert.match(legacyJs.jsCode ?? '', /Tag\.Read\("Supply_Temp_C"\)/);
  assert.match(legacyJs.jsCode ?? '', /Tag\.Write\("Plant_DeltaT_C", DeltaT\)/);
});
