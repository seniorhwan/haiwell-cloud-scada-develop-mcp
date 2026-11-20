import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHaiwellRegister } from './haiwellRegisters';

test('parses Haiwell bit coils and computes exact Modbus offsets', () => {
  const x0 = parseHaiwellRegister('X0');
  assert.equal(x0.valid, true);
  if (x0.valid) {
    assert.equal(x0.readOnly, true);
    assert.equal(x0.modbusOffset0Based, 0);
    assert.equal(x0.modbusHexAddress, '0x0000');
    assert.equal(x0.iecDirectAddress, '%IX0.0');
  }

  const y10 = parseHaiwellRegister('Y10');
  assert.equal(y10.valid, true);
  if (y10.valid) {
    assert.equal(y10.readOnly, false);
    assert.equal(y10.modbusOffset0Based, 1546);
    assert.equal(y10.iecDirectAddress, '%QX1.2');
  }

  const m0 = parseHaiwellRegister('M0');
  assert.equal(m0.valid, true);
  if (m0.valid) {
    assert.equal(m0.modbusOffset0Based, 3072);
    assert.equal(m0.modbusHexAddress, '0x0C00');
  }
});

test('parses Haiwell word registers and bit-addressed words', () => {
  const v0 = parseHaiwellRegister('V0');
  assert.equal(v0.valid, true);
  if (v0.valid) {
    assert.equal(v0.modbusOffset0Based, 512);
    assert.equal(v0.modbusAddress1Based, 40513);
    assert.equal(v0.kind, 'WORD');
  }

  const v100b3 = parseHaiwellRegister('v100.3');
  assert.equal(v100b3.valid, true);
  if (v100b3.valid) {
    assert.equal(v100b3.normalized, 'V100.3');
    assert.equal(v100b3.kind, 'BIT');
    assert.equal(v100b3.bitOffset, 3);
  }
});

test('rejects out-of-range registers and invalid bit suffixes', () => {
  const badRange = parseHaiwellRegister('AI999');
  assert.equal(badRange.valid, false);

  const badBit = parseHaiwellRegister('V10.16');
  assert.equal(badBit.valid, false);

  const bitOnCoil = parseHaiwellRegister('M10.1');
  assert.equal(bitOnCoil.valid, false);
});
