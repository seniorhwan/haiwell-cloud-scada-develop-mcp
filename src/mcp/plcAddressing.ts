/**
 * Multi-Vendor PLC Register Validator, Binary Data-Type Range Guard,
 * Linear Scaling Engine, & Multi-Word Register Overlap Detector.
 * Supports Haiwell Native, Modbus RTU/TCP, Siemens S7, Mitsubishi MC,
 * Omron FINS, Allen-Bradley EIP, Delta/Schneider Modbus, and BACnet/IP.
 */

import { parseHaiwellRegister } from './haiwellRegisters';
import type { PlcDriverProtocol, TagDataType, TagDefinition, TagScaling } from './types';

export interface ValidatedPlcAddress {
  valid: true;
  protocol: PlcDriverProtocol;
  normalized: string;
  kind: 'BIT' | 'WORD' | 'SYMBOLIC';
  readOnly: boolean;
  modbusOffset0Based?: number;
  modbusAddress1Based?: number;
  wordAddressKey?: { space: string; startIndex: number; unit?: 'WORD' | 'BYTE'; byteWidth?: number };
}

export interface InvalidPlcAddress {
  valid: false;
  protocol: PlcDriverProtocol;
  input: string;
  error: string;
  hint: string;
}

/**
 * Verified field-commissioned Modbus RTU Slave address mappings used inside
 * Haiwell Cloud Scada 3.50.x Variable tables (0X=Coil, 1X=Discrete Input, 3X=Input Reg, 4X=Holding Reg).
 */
export const VENDOR_MODBUS_REGISTER_MAPS = {
  HAIWELL_NATIVE_NOTATION: {
    '0X': 'Coil (BOOL, RW, FC01/05/15, 0..65535)',
    '1X': 'Discrete Input (BOOL, RO, FC02, 0..65535)',
    '3X': 'Input Register (WORD, RO, FC04, 0..65535)',
    '4X': 'Holding Register (WORD, RW, FC03/06/16, 0..65535)',
    W: 'Internal HMI Word Memory (WORD/STRING, RW, 0..65535)',
  },
  MITSUBISHI_FX3U_MODBUS_RTU_SLAVE: {
    serialConfigNote: 'FX3U-485ADP-MB: D8400=H3081 (9600-8-N-1 RTU), D8401=H10 (Slave), D8414=SlaveID',
    areas: {
      X0: '1X13312 (Discrete Input RO, octal X0..X7 -> 1X13312..1X13319)',
      Y0: '0X13056 (Coil RW, octal Y0..Y7 -> 0X13056..0X13063)',
      M0: '0X0 (Coil RW, M0..M7679 -> 0X0..0X7679)',
      D0: '4X0 (Holding Register RW, D0..D7999 -> 4X0..4X7999)',
    },
  },
  DELTA_DVP_ES2_MODBUS_RTU_SLAVE: {
    serialConfigNote: 'DVP-ES2 COM2 RS-485: D1120=16#0081 (9600-8-N-1), D1121=SlaveID, SET M1143 (RTU), SET M1120',
    areas: {
      X0: '1X1024 (Discrete Input RO, octal X0..X7 -> 1X1024..1X1031)',
      Y0: '0X1280 (Coil RW, octal Y0..Y7 -> 0X1280..0X1287)',
      M0: '0X2048 (Coil RW, M0..M1535 -> 0X2048..0X3583)',
      D0: '4X4096 (Holding Register RW, D0..D4999 -> 4X4096..4X9095)',
    },
  },
} as const;

export function getWordSpanForType(dataType: TagDataType): number {
  switch (dataType) {
    case 'BOOL':
      return 0;
    case 'INT16':
    case 'UINT16':
    case 'BCD16':
      return 1;
    case 'INT32':
    case 'UINT32':
    case 'FLOAT32':
    case 'BCD32':
      return 2;
    case 'FLOAT64':
      return 4;
    case 'STRING':
      return 16; // default 32-char SCADA register block
  }
}

export function validatePlcAddress(
  protocol: PlcDriverProtocol,
  rawAddress: string
): ValidatedPlcAddress | InvalidPlcAddress {
  const trimmed = rawAddress.trim();
  if (!trimmed) {
    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: 'PLC address cannot be empty.',
      hint: 'Provide a valid protocol-specific register address.',
    };
  }

  // 1. Haiwell Native PLC
  if (protocol === 'HAIWELL_PLC_TCP' || protocol === 'HAIWELL_PLC_RTU') {
    const parsed = parseHaiwellRegister(trimmed);
    if (!parsed.valid) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: parsed.error,
        hint: parsed.hint,
      };
    }
    return {
      valid: true,
      protocol,
      normalized: parsed.normalized,
      kind: parsed.kind,
      readOnly: parsed.readOnly,
      modbusOffset0Based: parsed.modbusOffset0Based,
      modbusAddress1Based: parsed.modbusAddress1Based,
      wordAddressKey:
        parsed.kind === 'WORD'
          ? { space: `HAIWELL_${parsed.area}`, startIndex: parsed.index }
          : undefined,
    };
  }

  // 2. Standard Modbus TCP / RTU (Delta, Schneider, generic)
  if (
    protocol === 'MODBUS_TCP' ||
    protocol === 'MODBUS_RTU' ||
    protocol === 'DELTA_DVP_MODBUS' ||
    protocol === 'SCHNEIDER_MODBUS'
  ) {
    const upper = trimmed.toUpperCase();
    // Typed form: COIL:0, DI:0, IR:0, HR:100
    const typedMatch = /^(COIL|DI|IR|HR):(\d+)$/.exec(upper);
    if (typedMatch) {
      const area = typedMatch[1];
      const idx = Number.parseInt(typedMatch[2], 10);
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Modbus offset ${idx} out of 16-bit range (0..65535).`,
          hint: 'Use offset 0..65535.',
        };
      }
      const isBit = area === 'COIL' || area === 'DI';
      const isRo = area === 'DI' || area === 'IR';
      const prefix = area === 'COIL' ? 1 : area === 'DI' ? 10001 : area === 'IR' ? 30001 : 40001;
      return {
        valid: true,
        protocol,
        normalized: `${area}:${idx}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusOffset0Based: idx,
        modbusAddress1Based: prefix + idx,
        wordAddressKey: !isBit ? { space: `MODBUS_${area}`, startIndex: idx } : undefined,
      };
    }

    // Classic 5/6-digit Modbus notation: 00001, 10001, 30001, 40001 (or 400001)
    const numericMatch = /^(\d{5,6})$/.exec(upper);
    if (numericMatch) {
      const num = Number.parseInt(numericMatch[1], 10);
      const is6Digit = upper.length === 6;
      const baseUnit = is6Digit ? 100000 : 10000;
      const areaDigit = Math.floor(num / baseUnit);
      const offset = num - areaDigit * baseUnit - 1;
      if (offset < 0 || offset > 65535 || ![0, 1, 3, 4].includes(areaDigit)) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Invalid Modbus register "${rawAddress}".`,
          hint: 'Use 00001..09999 (Coils), 10001..19999 (Discrete Inputs), 30001..39999 (Input Regs), 40001..49999 (Holding Regs), or HR:0 / IR:0 / COIL:0 / DI:0.',
        };
      }
      const isBit = areaDigit === 0 || areaDigit === 1;
      const isRo = areaDigit === 1 || areaDigit === 3;
      const space = areaDigit === 3 ? 'MODBUS_IR' : 'MODBUS_HR';
      return {
        valid: true,
        protocol,
        normalized: upper,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusOffset0Based: offset,
        modbusAddress1Based: num,
        wordAddressKey: !isBit ? { space, startIndex: offset } : undefined,
      };
    }

    // Native Haiwell Cloud Scada Modbus notation: 0X40, 1X13312, 3X100, 4X4196 (optional .0..15 bit slice on 3X/4X)
    const haiwellModbusMatch = /^(0X|1X|3X|4X)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (haiwellModbusMatch) {
      const prefixArea = haiwellModbusMatch[1];
      const idx = Number.parseInt(haiwellModbusMatch[2], 10);
      const bitStr = haiwellModbusMatch[3];
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Haiwell Modbus offset ${idx} out of 16-bit range (0..65535).`,
          hint: `Use ${prefixArea}0..${prefixArea}65535.`,
        };
      }
      const isCoilOrDi = prefixArea === '0X' || prefixArea === '1X';
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (isCoilOrDi) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Bit register ${prefixArea}${idx} cannot have a bit suffix .${bitStr}.`,
            hint: `Use ${prefixArea}${idx} directly.`,
          };
        }
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15).`,
            hint: `Use ${prefixArea}${idx}.0 through ${prefixArea}${idx}.15.`,
          };
        }
      }
      const isRo = prefixArea === '1X' || prefixArea === '3X';
      const isBit = isCoilOrDi || bitStr !== undefined;
      const base1 = prefixArea === '0X' ? 1 : prefixArea === '1X' ? 10001 : prefixArea === '3X' ? 30001 : 40001;
      const space = prefixArea === '3X' ? 'MODBUS_IR' : 'MODBUS_HR';
      return {
        valid: true,
        protocol,
        normalized: bitStr !== undefined ? `${prefixArea}${idx}.${Number.parseInt(bitStr, 10)}` : `${prefixArea}${idx}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusOffset0Based: idx,
        modbusAddress1Based: base1 + idx,
        wordAddressKey: !isBit ? { space, startIndex: idx } : undefined,
      };
    }

    // Haiwell HMI internal word memory (e.g. W0..W65535)
    const internalWMatch = /^W(\d+)$/.exec(upper);
    if (internalWMatch) {
      const idx = Number.parseInt(internalWMatch[1], 10);
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Internal word offset W${idx} out of range (0..65535).`,
          hint: 'Use W0..W65535.',
        };
      }
      return {
        valid: true,
        protocol,
        normalized: `W${idx}`,
        kind: 'WORD',
        readOnly: false,
        wordAddressKey: { space: 'HAIWELL_INTERNAL_W', startIndex: idx },
      };
    }

    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: `Unrecognized Modbus address "${rawAddress}".`,
      hint: 'Use Haiwell notation (0X0, 1X1024, 3X0, 4X4096), 5/6-digit (40001, 30001, 10001, 00001), or HR:100 / IR:10 / COIL:0 / DI:0.',
    };
  }

  // 3. Siemens S7-1200 / S7-1500
  if (protocol === 'SIEMENS_S7_1200' || protocol === 'SIEMENS_S7_1500') {
    const upper = trimmed.toUpperCase();
    const dbMatch = /^DB(\d+)\.(DBX(\d+)\.([0-7])|DB([BWD])(\d+))$/.exec(upper);
    if (dbMatch) {
      const dbNum = Number.parseInt(dbMatch[1], 10);
      const isBit = upper.includes('.DBX');
      const sizeChar = dbMatch[5];
      const byteOffset = Number.parseInt(dbMatch[3] ?? dbMatch[6], 10);
      const byteWidth = sizeChar === 'D' ? 4 : sizeChar === 'W' ? 2 : 1;
      return {
        valid: true,
        protocol,
        normalized: upper,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: false,
        wordAddressKey: !isBit
          ? { space: `S7_DB${dbNum}_B`, startIndex: byteOffset, unit: 'BYTE', byteWidth }
          : undefined,
      };
    }
    const ioMatch = /^([IQM])([BWD])?(\d+)(?:\.([0-7]))?$/.exec(upper);
    if (ioMatch) {
      const area = ioMatch[1];
      const size = ioMatch[2];
      const byteIdx = Number.parseInt(ioMatch[3], 10);
      const bitIdx = ioMatch[4];
      const isBit = !size && bitIdx !== undefined;
      if (!size && bitIdx === undefined) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Siemens S7 address "${rawAddress}" requires either a bit (.0..7) or width (B/W/D).`,
          hint: 'Use I0.0, Q0.1, M10.2, IW64, MW100, MD200, or DB1.DBD0.',
        };
      }
      const byteWidth = size === 'D' ? 4 : size === 'W' ? 2 : 1;
      return {
        valid: true,
        protocol,
        normalized: upper,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: area === 'I',
        wordAddressKey: !isBit
          ? { space: `S7_${area}_B`, startIndex: byteIdx, unit: 'BYTE', byteWidth }
          : undefined,
      };
    }
    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: `Invalid Siemens S7 address "${rawAddress}".`,
      hint: 'Use I0.0, Q0.0, M0.0, IW0, QW0, MW10, MD20, DB1.DBX0.0, DB1.DBW2, or DB1.DBD4.',
    };
  }

  // 4. Mitsubishi MC 3E (FX / Q / iQ-R)
  if (protocol === 'MITSUBISHI_MC_3E') {
    const upper = trimmed.toUpperCase();
    const m = /^(X|Y|M|B|L|F|D|W|R|ZR)([0-9A-F]+)$/.exec(upper);
    if (!m) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Invalid Mitsubishi MELSEC address "${rawAddress}".`,
        hint: 'Use X0..XFFF, Y0..YFFF, M0..M32767, D0..D65535, W0..WFFF, R0..R32767.',
      };
    }
    const area = m[1];
    const hexAreas = new Set(['X', 'Y', 'B', 'W']);
    if (!hexAreas.has(area) && !/^\d+$/.test(m[2])) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Mitsubishi area ${area} uses decimal addressing, got "${m[2]}".`,
        hint: `Use decimal index such as ${area}100.`,
      };
    }
    const idx = Number.parseInt(m[2], hexAreas.has(area) ? 16 : 10);
    const isBit = ['X', 'Y', 'M', 'B', 'L', 'F'].includes(area);
    return {
      valid: true,
      protocol,
      normalized: upper,
      kind: isBit ? 'BIT' : 'WORD',
      readOnly: area === 'X',
      wordAddressKey: !isBit ? { space: `MITSU_${area}`, startIndex: idx } : undefined,
    };
  }

  // 5. Omron FINS TCP
  if (protocol === 'OMRON_FINS_TCP') {
    const upper = trimmed.toUpperCase();
    const m = /^(CIO|W|H|A|D|DM|EM\d+\.)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (!m) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Invalid Omron FINS address "${rawAddress}".`,
        hint: 'Use CIO0.00, W10.05, H0.00, D100, or DM100.',
      };
    }
    const bit = m[3] !== undefined ? Number.parseInt(m[3], 10) : undefined;
    if (bit !== undefined && (bit < 0 || bit > 15)) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Omron bit index .${bit} out of range (0..15).`,
        hint: 'Use bit offset .00 through .15.',
      };
    }
    const idx = Number.parseInt(m[2], 10);
    return {
      valid: true,
      protocol,
      normalized: upper,
      kind: bit !== undefined ? 'BIT' : 'WORD',
      readOnly: false,
      wordAddressKey: bit === undefined ? { space: `OMRON_${m[1] === 'DM' ? 'D' : m[1]}`, startIndex: idx } : undefined,
    };
  }

  // 6. BACnet/IP
  if (protocol === 'BACNET_IP') {
    const upper = trimmed.toUpperCase();
    const m = /^(AI|AO|AV|BI|BO|BV|MSI|MSO|MSV):(\d+)$/.exec(upper);
    if (!m) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Invalid BACnet object identifier "${rawAddress}".`,
        hint: 'Use AI:0, AO:1, AV:2, BI:0, BO:1, BV:2, MSI:0, MSO:1, MSV:2.',
      };
    }
    const obj = m[1];
    return {
      valid: true,
      protocol,
      normalized: upper,
      kind: obj.startsWith('B') ? 'BIT' : 'WORD',
      readOnly: obj.endsWith('I'),
    };
  }

  // 7. Allen-Bradley EtherNet/IP, OPC UA Client, MQTT Client (Symbolic)
  if (/^[A-Za-z_][A-Za-z0-9_.:/\-[\]]{0,127}$/.test(trimmed)) {
    return {
      valid: true,
      protocol,
      normalized: trimmed,
      kind: 'SYMBOLIC',
      readOnly: false,
    };
  }

  return {
    valid: false,
    protocol,
    input: rawAddress,
    error: `Invalid symbolic tag address "${rawAddress}" for ${protocol}.`,
    hint: 'Use valid symbolic identifier characters (A-Z, 0-9, _, ., :, /, -, []).',
  };
}

/**
 * Validates that a JS value strictly conforms to the PLC TagDataType binary range.
 * Prevents NaN, Infinity, integer overflow, and string-to-float memory corruption.
 */
export function validateTagValueForType(
  dataType: TagDataType,
  value: unknown
): { valid: true; normalizedValue: number | boolean | string } | { valid: false; code: string; error: string } {
  switch (dataType) {
    case 'BOOL':
      if (typeof value !== 'boolean') {
        return { valid: false, code: 'TYPE_MISMATCH_BOOL', error: `BOOL tag requires boolean (true/false), received ${typeof value}.` };
      }
      return { valid: true, normalizedValue: value };

    case 'STRING':
      if (typeof value !== 'string') {
        return { valid: false, code: 'TYPE_MISMATCH_STRING', error: `STRING tag requires string, received ${typeof value}.` };
      }
      if (value.length > 255) {
        return { valid: false, code: 'STRING_LENGTH_EXCEEDED', error: `STRING tag exceeds 255-character SCADA buffer limit (${value.length} chars).` };
      }
      return { valid: true, normalizedValue: value };

    case 'INT16':
    case 'UINT16':
    case 'INT32':
    case 'UINT32':
    case 'BCD16':
    case 'BCD32': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { valid: false, code: 'TYPE_MISMATCH_INT', error: `${dataType} tag requires finite integer, received ${String(value)}.` };
      }
      const ranges: Record<string, [number, number]> = {
        INT16: [-32768, 32767],
        UINT16: [0, 65535],
        INT32: [-2147483648, 2147483647],
        UINT32: [0, 4294967295],
        BCD16: [0, 9999],
        BCD32: [0, 99999999],
      };
      const [min, max] = ranges[dataType];
      if (value < min || value > max) {
        return {
          valid: false,
          code: 'BINARY_RANGE_OVERFLOW',
          error: `Value ${value} overflows ${dataType} binary range [${min}..${max}].`,
        };
      }
      return { valid: true, normalizedValue: value };
    }

    case 'FLOAT32':
    case 'FLOAT64': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { valid: false, code: 'TYPE_MISMATCH_FLOAT', error: `${dataType} tag requires finite number (no NaN/Infinity), received ${String(value)}.` };
      }
      if (dataType === 'FLOAT32' && Math.abs(value) > 3.4028235e38) {
        return { valid: false, code: 'FLOAT32_OVERFLOW', error: `Value ${value} overflows IEEE 754 FLOAT32 range.` };
      }
      return { valid: true, normalizedValue: value };
    }
  }
}

export function applyLinearScaling(rawValue: number, scaling: TagScaling): number {
  const rawSpan = scaling.rawMax - scaling.rawMin;
  if (rawSpan === 0) return scaling.engMin;
  const ratio = (rawValue - scaling.rawMin) / rawSpan;
  let eng = scaling.engMin + ratio * (scaling.engMax - scaling.engMin);
  if (scaling.clamp) {
    const lo = Math.min(scaling.engMin, scaling.engMax);
    const hi = Math.max(scaling.engMin, scaling.engMax);
    eng = Math.max(lo, Math.min(hi, eng));
  }
  return Number(eng.toFixed(4));
}

export interface WordOverlapConflict {
  tagA: string;
  tagB: string;
  deviceId: string;
  addressA: string;
  addressB: string;
  reason: string;
}

/**
 * Detects both exact address collisions AND multi-word register overlap collisions
 * (e.g., FLOAT32 at V100 occupies V100..V101 and collides with INT16 at V101).
 */
export function detectWordOverlapConflicts(
  tags: Record<string, TagDefinition>,
  deviceProtocols: Map<string, PlcDriverProtocol>
): WordOverlapConflict[] {
  const conflicts: WordOverlapConflict[] = [];
  const exactSeen = new Map<string, TagDefinition>();
  const wordOccupancy = new Map<string, TagDefinition>();

  for (const tag of Object.values(tags)) {
    if (tag.scope !== 'PLC' || !tag.deviceId || !tag.address) continue;
    const protocol = deviceProtocols.get(tag.deviceId) ?? 'HAIWELL_PLC_TCP';
    const parsed = validatePlcAddress(protocol, tag.address);
    if (!parsed.valid) continue;

    const exactKey = `${tag.deviceId}:${parsed.normalized}`;
    const existingExact = exactSeen.get(exactKey);
    if (existingExact && existingExact.name !== tag.name) {
      conflicts.push({
        tagA: existingExact.name,
        tagB: tag.name,
        deviceId: tag.deviceId,
        addressA: existingExact.address ?? '',
        addressB: tag.address,
        reason: `Exact PLC address collision on ${exactKey}.`,
      });
      continue;
    }
    exactSeen.set(exactKey, tag);

    if (parsed.wordAddressKey) {
      const isByteUnit = parsed.wordAddressKey.unit === 'BYTE';
      const span = isByteUnit
        ? Math.max(1, parsed.wordAddressKey.byteWidth ?? 1)
        : Math.max(1, tag.wordSpan ?? getWordSpanForType(tag.dataType));
      for (let offset = 0; offset < span; offset++) {
        const slotKey = `${tag.deviceId}:${parsed.wordAddressKey.space}:${parsed.wordAddressKey.startIndex + offset}`;
        const occupant = wordOccupancy.get(slotKey);
        if (occupant && occupant.name !== tag.name) {
          conflicts.push({
            tagA: occupant.name,
            tagB: tag.name,
            deviceId: tag.deviceId,
            addressA: `${occupant.address} (${occupant.dataType})`,
            addressB: `${tag.address} (${tag.dataType})`,
            reason: `${isByteUnit ? 'Byte' : 'Multi-word'} register overlap at slot ${slotKey}.`,
          });
          break;
        }
        wordOccupancy.set(slotKey, tag);
      }
    }
  }

  return conflicts;
}
