/**
 * Multi-Vendor PLC Register Validator, Binary Data-Type Range Guard,
 * Linear Scaling Engine, & Multi-Word Register Overlap Detector.
 * Supports Haiwell Native, Modbus RTU/TCP, Siemens S7, Mitsubishi MC,
 * Omron FINS, Allen-Bradley EIP, Delta/Schneider Modbus, and BACnet/IP.
 */

import { HAIWELL_REGISTER_MAP, parseHaiwellRegister } from './haiwellRegisters';
import type { PlcDriverProtocol, TagDataType, TagDefinition, TagScaling } from './types';

export interface ValidatedPlcAddress {
  valid: true;
  protocol: PlcDriverProtocol;
  normalized: string;
  canonicalKey?: string;
  kind: 'BIT' | 'WORD' | 'SYMBOLIC';
  readOnly: boolean;
  modbusArea?: 'COIL' | 'DI' | 'IR' | 'HR';
  modbusOffset0Based?: number;
  modbusAddress1Based?: number;
  modbusAddressFormatted?: string;
  maxAddressIndex?: number;
  wordAddressKey?: { space: string; startIndex: number; unit?: 'WORD' | 'BYTE'; byteWidth?: number };
  enclosingWordSlot?: { space: string; index: number; unit?: 'WORD' | 'BYTE'; bitOffset: number };
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

export function getByteWidthForType(dataType: TagDataType, wordSpanOverride?: number): number {
  if (wordSpanOverride !== undefined && Number.isInteger(wordSpanOverride) && wordSpanOverride > 0) {
    return Math.min(wordSpanOverride, 1024) * 2;
  }
  switch (dataType) {
    case 'BOOL':
      return 1;
    case 'INT16':
    case 'UINT16':
    case 'BCD16':
      return 2;
    case 'INT32':
    case 'UINT32':
    case 'FLOAT32':
    case 'BCD32':
      return 4;
    case 'FLOAT64':
      return 8;
    case 'STRING':
      return 32;
  }
}

function computeModbus1Based(area: 'COIL' | 'DI' | 'IR' | 'HR', offset0Based: number): number {
  const extended = offset0Based >= 9999;
  const prefix =
    area === 'COIL'
      ? 1
      : area === 'DI'
        ? extended
          ? 100001
          : 10001
        : area === 'IR'
          ? extended
            ? 300001
            : 30001
          : extended
            ? 400001
            : 40001;
  return prefix + offset0Based;
}

function formatModbus1Based(area: 'COIL' | 'DI' | 'IR' | 'HR', offset0Based: number): string {
  const extended = offset0Based >= 9999;
  return String(computeModbus1Based(area, offset0Based)).padStart(extended ? 6 : 5, '0');
}

export function validatePlcAddress(
  protocol: PlcDriverProtocol,
  rawAddress: string,
  options: { addressOffset?: 'BASE_0' | 'BASE_1' } = {}
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

  // 1. Haiwell Native PLC (plus Haiwell HMI internal W0..W65535)
  if (protocol === 'HAIWELL_PLC_TCP' || protocol === 'HAIWELL_PLC_RTU') {
    const upper = trimmed.toUpperCase();
    const internalWMatch = /^W(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (internalWMatch) {
      const idx = Number.parseInt(internalWMatch[1], 10);
      const bitStr = internalWMatch[2];
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Internal word offset W${idx} out of range (0..65535).`,
          hint: 'Use W0..W65535.',
        };
      }
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15) for W${idx}.`,
            hint: `Use W${idx}.0 through W${idx}.15.`,
          };
        }
        return {
          valid: true,
          protocol,
          normalized: `W${idx}.${bit}`,
          canonicalKey: `HAIWELL_INTERNAL_W:${idx}.${bit}`,
          kind: 'BIT',
          readOnly: false,
          maxAddressIndex: 65535,
          enclosingWordSlot: { space: 'HAIWELL_INTERNAL_W', index: idx, unit: 'WORD', bitOffset: bit },
        };
      }
      return {
        valid: true,
        protocol,
        normalized: `W${idx}`,
        canonicalKey: `HAIWELL_INTERNAL_W:${idx}`,
        kind: 'WORD',
        readOnly: false,
        maxAddressIndex: 65535,
        wordAddressKey: { space: 'HAIWELL_INTERNAL_W', startIndex: idx },
      };
    }

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
    const maxIndex = HAIWELL_REGISTER_MAP[parsed.area].maxIndex;
    const space = `HAIWELL_${parsed.area}`;
    return {
      valid: true,
      protocol,
      normalized: parsed.normalized,
      canonicalKey:
        parsed.bitOffset !== undefined ? `${space}:${parsed.index}.${parsed.bitOffset}` : `${space}:${parsed.index}`,
      kind: parsed.kind,
      readOnly: parsed.readOnly,
      modbusArea: parsed.modbusArea,
      modbusOffset0Based: parsed.modbusOffset0Based,
      modbusAddress1Based: parsed.modbusAddress1Based,
      modbusAddressFormatted: parsed.modbusAddressFormatted,
      maxAddressIndex: maxIndex,
      wordAddressKey:
        parsed.kind === 'WORD'
          ? { space, startIndex: parsed.index }
          : undefined,
      enclosingWordSlot:
        parsed.bitOffset !== undefined
          ? { space, index: parsed.index, unit: 'WORD', bitOffset: parsed.bitOffset }
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
    const isBase1 = options.addressOffset === 'BASE_1';

    // Typed form: COIL:0, DI:0, IR:0, HR:100, optional .0..15 on IR/HR
    const typedMatch = /^(COIL|DI|IR|HR):(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (typedMatch) {
      const area = typedMatch[1] as 'COIL' | 'DI' | 'IR' | 'HR';
      const idx = Number.parseInt(typedMatch[2], 10);
      const bitStr = typedMatch[3];
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Modbus offset ${idx} out of 16-bit range (0..65535).`,
          hint: 'Use offset 0..65535.',
        };
      }
      const isCoilOrDi = area === 'COIL' || area === 'DI';
      let parsedBit: number | undefined;
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (isCoilOrDi) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Bit register ${area}:${idx} cannot have a bit suffix .${bitStr}.`,
            hint: `Use ${area}:${idx} directly.`,
          };
        }
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15).`,
            hint: `Use ${area}:${idx}.0 through ${area}:${idx}.15.`,
          };
        }
        parsedBit = bit;
      }
      const isBit = isCoilOrDi || parsedBit !== undefined;
      const isRo = area === 'DI' || area === 'IR';
      const space = `MODBUS_${area}`;
      return {
        valid: true,
        protocol,
        normalized: parsedBit !== undefined ? `${area}:${idx}.${parsedBit}` : `${area}:${idx}`,
        canonicalKey: parsedBit !== undefined ? `${space}:${idx}.${parsedBit}` : `${space}:${idx}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusArea: area,
        modbusOffset0Based: idx,
        modbusAddress1Based: computeModbus1Based(area, idx),
        modbusAddressFormatted: formatModbus1Based(area, idx),
        maxAddressIndex: 65535,
        wordAddressKey: !isBit ? { space, startIndex: idx } : undefined,
        enclosingWordSlot:
          parsedBit !== undefined ? { space, index: idx, unit: 'WORD', bitOffset: parsedBit } : undefined,
      };
    }

    // Classic 5/6-digit Modbus notation: 00001, 10001, 30001, 40001 (or 6-digit 000001..465536, optional .0..15 on 3x/4x)
    const numericMatch = /^(\d{5,6})(?:\.(\d{1,2}))?$/.exec(upper);
    if (numericMatch) {
      const numStr = numericMatch[1];
      const num = Number.parseInt(numStr, 10);
      const bitStr = numericMatch[2];
      const is6Digit = numStr.length === 6;
      const baseUnit = is6Digit ? 100000 : 10000;
      const areaDigit = Math.floor(num / baseUnit);
      const offset = num - areaDigit * baseUnit - 1;
      if (offset < 0 || offset > 65535 || ![0, 1, 3, 4].includes(areaDigit)) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Invalid Modbus register "${rawAddress}".`,
          hint: 'Use 00001..09999 (Coils), 10001..19999 (Discrete Inputs), 30001..39999 (Input Regs), 40001..49999 (Holding Regs), 6-digit extended (400001..465536), or HR:0 / IR:0 / COIL:0 / DI:0.',
        };
      }
      const isCoilOrDi = areaDigit === 0 || areaDigit === 1;
      let parsedBit: number | undefined;
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (isCoilOrDi) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Bit register ${numStr} cannot have a bit suffix .${bitStr}.`,
            hint: `Use ${numStr} directly.`,
          };
        }
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15).`,
            hint: `Use ${numStr}.0 through ${numStr}.15.`,
          };
        }
        parsedBit = bit;
      }
      const isBit = isCoilOrDi || parsedBit !== undefined;
      const isRo = areaDigit === 1 || areaDigit === 3;
      const areaKey: 'COIL' | 'DI' | 'IR' | 'HR' =
        areaDigit === 0 ? 'COIL' : areaDigit === 1 ? 'DI' : areaDigit === 3 ? 'IR' : 'HR';
      const space = `MODBUS_${areaKey}`;
      return {
        valid: true,
        protocol,
        normalized: upper,
        canonicalKey: parsedBit !== undefined ? `${space}:${offset}.${parsedBit}` : `${space}:${offset}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusArea: areaKey,
        modbusOffset0Based: offset,
        modbusAddress1Based: num,
        modbusAddressFormatted: numStr,
        maxAddressIndex: 65535,
        wordAddressKey: !isBit ? { space, startIndex: offset } : undefined,
        enclosingWordSlot:
          parsedBit !== undefined ? { space, index: offset, unit: 'WORD', bitOffset: parsedBit } : undefined,
      };
    }

    // Native Haiwell Cloud Scada Modbus notation: 0X40, 1X13312, 3X100, 4X4196 (optional .0..15 bit slice on 3X/4X)
    const haiwellModbusMatch = /^(0X|1X|3X|4X)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (haiwellModbusMatch) {
      const prefixArea = haiwellModbusMatch[1];
      const rawIdx = Number.parseInt(haiwellModbusMatch[2], 10);
      const idx = isBase1 ? rawIdx - 1 : rawIdx;
      const bitStr = haiwellModbusMatch[3];
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Haiwell Modbus offset ${rawIdx} out of 16-bit range (${isBase1 ? '1..65536' : '0..65535'}).`,
          hint: `Use ${prefixArea}${isBase1 ? '1' : '0'}..${prefixArea}${isBase1 ? '65536' : '65535'}.`,
        };
      }
      const isCoilOrDi = prefixArea === '0X' || prefixArea === '1X';
      let parsedBit: number | undefined;
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (isCoilOrDi) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Bit register ${prefixArea}${rawIdx} cannot have a bit suffix .${bitStr}.`,
            hint: `Use ${prefixArea}${rawIdx} directly.`,
          };
        }
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15).`,
            hint: `Use ${prefixArea}${rawIdx}.0 through ${prefixArea}${rawIdx}.15.`,
          };
        }
        parsedBit = bit;
      }
      const isRo = prefixArea === '1X' || prefixArea === '3X';
      const isBit = isCoilOrDi || parsedBit !== undefined;
      const areaKey =
        prefixArea === '0X' ? 'COIL' : prefixArea === '1X' ? 'DI' : prefixArea === '3X' ? 'IR' : 'HR';
      const space = `MODBUS_${areaKey}`;
      return {
        valid: true,
        protocol,
        normalized: parsedBit !== undefined ? `${prefixArea}${idx}.${parsedBit}` : `${prefixArea}${idx}`,
        canonicalKey: parsedBit !== undefined ? `${space}:${idx}.${parsedBit}` : `${space}:${idx}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: isRo,
        modbusArea: areaKey,
        modbusOffset0Based: idx,
        modbusAddress1Based: computeModbus1Based(areaKey, idx),
        modbusAddressFormatted: formatModbus1Based(areaKey, idx),
        maxAddressIndex: 65535,
        wordAddressKey: !isBit ? { space, startIndex: idx } : undefined,
        enclosingWordSlot:
          parsedBit !== undefined
            ? { space, index: idx, unit: 'WORD', bitOffset: parsedBit }
            : undefined,
      };
    }

    // Native Delta DVP-ES2/SS2 Modbus mapping (X=octal 0..377 -> 1X1024+, Y=octal 0..377 -> 0X1280+, M=0..4095 -> 0X2048+, D=0..9999 -> 4X4096+)
    if (protocol === 'DELTA_DVP_MODBUS') {
      const deltaMatch = /^(X|Y|M|D)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
      if (deltaMatch) {
        const dArea = deltaMatch[1];
        const rawNum = deltaMatch[2];
        const bitStr = deltaMatch[3];
        if ((dArea === 'X' || dArea === 'Y') && !/^[0-7]+$/.test(rawNum)) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Delta DVP ${dArea} I/O uses octal addressing, got "${rawNum}".`,
            hint: `Use octal index such as ${dArea}0..${dArea}377.`,
          };
        }
        const idx = Number.parseInt(rawNum, dArea === 'X' || dArea === 'Y' ? 8 : 10);
        const maxAreaIdx = dArea === 'X' || dArea === 'Y' ? 255 : dArea === 'M' ? 4095 : 9999;
        if (idx < 0 || idx > maxAreaIdx) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Delta DVP register ${dArea}${rawNum} out of range (${dArea === 'X' || dArea === 'Y' ? `${dArea}0..${dArea}377 octal` : `${dArea}0..${dArea}${maxAreaIdx}`}).`,
            hint: `Use valid Delta DVP ${dArea} register bounds.`,
          };
        }
        if (bitStr !== undefined && dArea !== 'D') {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Delta bit register ${dArea}${rawNum} cannot have a bit suffix .${bitStr}.`,
            hint: `Use ${dArea}${rawNum} directly.`,
          };
        }
        const parsedBit = bitStr !== undefined ? Number.parseInt(bitStr, 10) : undefined;
        if (parsedBit !== undefined && (parsedBit < 0 || parsedBit > 15)) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${parsedBit} out of range (0..15).`,
            hint: `Use D${idx}.0..D${idx}.15.`,
          };
        }
        const modbusOff =
          dArea === 'X' ? 1024 + idx : dArea === 'Y' ? 1280 + idx : dArea === 'M' ? 2048 + idx : 4096 + idx;
        const areaKey = dArea === 'X' ? 'DI' : dArea === 'Y' || dArea === 'M' ? 'COIL' : 'HR';
        const space = `MODBUS_${areaKey}`;
        const isBit = dArea !== 'D' || parsedBit !== undefined;
        const maxAddressIndex =
          dArea === 'X'
            ? 1024 + 255
            : dArea === 'Y'
              ? 1280 + 255
              : dArea === 'M'
                ? 2048 + 4095
                : 4096 + 9999;
        return {
          valid: true,
          protocol,
          normalized: parsedBit !== undefined ? `${dArea}${rawNum}.${parsedBit}` : `${dArea}${rawNum}`,
          canonicalKey: parsedBit !== undefined ? `${space}:${modbusOff}.${parsedBit}` : `${space}:${modbusOff}`,
          kind: isBit ? 'BIT' : 'WORD',
          readOnly: dArea === 'X',
          modbusArea: areaKey,
          modbusOffset0Based: modbusOff,
          modbusAddress1Based: computeModbus1Based(areaKey, modbusOff),
          modbusAddressFormatted: formatModbus1Based(areaKey, modbusOff),
          maxAddressIndex,
          wordAddressKey: !isBit ? { space, startIndex: modbusOff } : undefined,
          enclosingWordSlot:
            parsedBit !== undefined ? { space, index: modbusOff, unit: 'WORD', bitOffset: parsedBit } : undefined,
        };
      }
    }

    // Native Schneider Modbus (%MWn, %Mn, %IWn, %QWn — separate %MW and %QW memory spaces)
    if (protocol === 'SCHNEIDER_MODBUS') {
      const schMatch = /^%(MW|IW|QW|M)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
      if (schMatch) {
        const sArea = schMatch[1];
        const idx = Number.parseInt(schMatch[2], 10);
        const bitStr = schMatch[3];
        if (idx < 0 || idx > 65535) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Schneider Modbus offset ${idx} out of 16-bit range (0..65535).`,
            hint: `Use %${sArea}0..%${sArea}65535.`,
          };
        }
        if (bitStr !== undefined && sArea === 'M') {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Bit register %M${idx} cannot have a bit suffix .${bitStr}.`,
            hint: `Use %M${idx} directly.`,
          };
        }
        const parsedBit = bitStr !== undefined ? Number.parseInt(bitStr, 10) : undefined;
        if (parsedBit !== undefined && (parsedBit < 0 || parsedBit > 15)) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${parsedBit} out of range (0..15).`,
            hint: `Use %${sArea}${idx}.0..15.`,
          };
        }
        const areaKey = sArea === 'M' ? 'COIL' : sArea === 'IW' ? 'IR' : 'HR';
        const space =
          sArea === 'MW'
            ? 'SCHNEIDER_MW'
            : sArea === 'QW'
              ? 'SCHNEIDER_QW'
              : sArea === 'IW'
                ? 'MODBUS_IR'
                : 'MODBUS_COIL';
        const isBit = sArea === 'M' || parsedBit !== undefined;
        return {
          valid: true,
          protocol,
          normalized: parsedBit !== undefined ? `%${sArea}${idx}.${parsedBit}` : `%${sArea}${idx}`,
          canonicalKey: parsedBit !== undefined ? `${space}:${idx}.${parsedBit}` : `${space}:${idx}`,
          kind: isBit ? 'BIT' : 'WORD',
          readOnly: sArea === 'IW',
          modbusArea: areaKey,
          modbusOffset0Based: idx,
          modbusAddress1Based: computeModbus1Based(areaKey, idx),
          modbusAddressFormatted: formatModbus1Based(areaKey, idx),
          maxAddressIndex: 65535,
          wordAddressKey: !isBit ? { space, startIndex: idx } : undefined,
          enclosingWordSlot:
            parsedBit !== undefined ? { space, index: idx, unit: 'WORD', bitOffset: parsedBit } : undefined,
        };
      }
    }

    // Haiwell HMI/SCADA internal word memory (W0..W65535)
    const internalWMatch = /^W(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (internalWMatch) {
      const idx = Number.parseInt(internalWMatch[1], 10);
      const bitStr = internalWMatch[2];
      if (idx < 0 || idx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Internal word offset W${idx} out of range (0..65535).`,
          hint: 'Use W0..W65535.',
        };
      }
      if (bitStr !== undefined) {
        const bit = Number.parseInt(bitStr, 10);
        if (bit < 0 || bit > 15) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `Word bit offset .${bit} out of range (0..15) for W${idx}.`,
            hint: `Use W${idx}.0..W${idx}.15.`,
          };
        }
        return {
          valid: true,
          protocol,
          normalized: `W${idx}.${bit}`,
          canonicalKey: `HAIWELL_INTERNAL_W:${idx}.${bit}`,
          kind: 'BIT',
          readOnly: false,
          maxAddressIndex: 65535,
          enclosingWordSlot: { space: 'HAIWELL_INTERNAL_W', index: idx, unit: 'WORD', bitOffset: bit },
        };
      }
      return {
        valid: true,
        protocol,
        normalized: `W${idx}`,
        canonicalKey: `HAIWELL_INTERNAL_W:${idx}`,
        kind: 'WORD',
        readOnly: false,
        maxAddressIndex: 65535,
        wordAddressKey: { space: 'HAIWELL_INTERNAL_W', startIndex: idx },
      };
    }

    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: `Unrecognized Modbus address "${rawAddress}".`,
      hint: 'Use Haiwell notation (0X0, 1X1024, 3X0, 4X4096), 5/6-digit (40001, 30001, 10001, 00001, 400001), or HR:100 / IR:10 / COIL:0 / DI:0.',
    };
  }

  // 3. Siemens S7-1200 / S7-1500
  if (protocol === 'SIEMENS_S7_1200' || protocol === 'SIEMENS_S7_1500') {
    const upper = trimmed.toUpperCase();
    const dbMatch = /^DB(\d+)\.(DBX(\d+)\.([0-7])|DB([BWD])(\d+))$/.exec(upper);
    if (dbMatch) {
      const dbNum = Number.parseInt(dbMatch[1], 10);
      if (dbNum < 1 || dbNum > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Siemens S7 Data Block DB${dbNum} out of valid range (DB1..DB65535).`,
          hint: 'Use DB1..DB65535 (DB0 does not exist in Siemens S7).',
        };
      }
      const isBit = upper.includes('.DBX');
      const sizeChar = dbMatch[5];
      const byteOffset = Number.parseInt(dbMatch[3] ?? dbMatch[6], 10);
      if (byteOffset < 0 || byteOffset > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Siemens S7 DB byte offset ${byteOffset} out of range (0..65535).`,
          hint: 'Use byte offset 0..65535.',
        };
      }
      const bitNum = dbMatch[4] !== undefined ? Number.parseInt(dbMatch[4], 10) : undefined;
      const byteWidth = sizeChar === 'D' ? 4 : sizeChar === 'W' ? 2 : 1;
      const space = `S7_DB${dbNum}_B`;
      return {
        valid: true,
        protocol,
        normalized: upper,
        canonicalKey:
          isBit && bitNum !== undefined
            ? `S7_DB${dbNum}_X:${byteOffset}.${bitNum}`
            : `S7_DB${dbNum}_${sizeChar}:${byteOffset}`,
        kind: isBit ? 'BIT' : 'WORD',
        readOnly: false,
        maxAddressIndex: 65535,
        wordAddressKey: !isBit
          ? { space, startIndex: byteOffset, unit: 'BYTE', byteWidth }
          : undefined,
        enclosingWordSlot:
          isBit && bitNum !== undefined
            ? { space, index: byteOffset, unit: 'BYTE', bitOffset: bitNum }
            : undefined,
      };
    }
    const ioBitMatch = /^([IQM])(\d+)\.([0-7])$/.exec(upper);
    if (ioBitMatch) {
      const area = ioBitMatch[1];
      const byteIdx = Number.parseInt(ioBitMatch[2], 10);
      const bitNum = Number.parseInt(ioBitMatch[3], 10);
      if (byteIdx < 0 || byteIdx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Siemens S7 byte offset ${byteIdx} out of range (0..65535).`,
          hint: 'Use byte offset 0..65535.',
        };
      }
      const space = `S7_${area}_B`;
      return {
        valid: true,
        protocol,
        normalized: `${area}${byteIdx}.${bitNum}`,
        canonicalKey: `S7_${area}_X:${byteIdx}.${bitNum}`,
        kind: 'BIT',
        readOnly: area === 'I',
        maxAddressIndex: 65535,
        enclosingWordSlot: { space, index: byteIdx, unit: 'BYTE', bitOffset: bitNum },
      };
    }
    const ioWordMatch = /^([IQM])([BWD])(\d+)$/.exec(upper);
    if (ioWordMatch) {
      const area = ioWordMatch[1];
      const size = ioWordMatch[2];
      const byteIdx = Number.parseInt(ioWordMatch[3], 10);
      if (byteIdx < 0 || byteIdx > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `Siemens S7 byte offset ${byteIdx} out of range (0..65535).`,
          hint: 'Use byte offset 0..65535.',
        };
      }
      const byteWidth = size === 'D' ? 4 : size === 'W' ? 2 : 1;
      const space = `S7_${area}_B`;
      return {
        valid: true,
        protocol,
        normalized: `${area}${size}${byteIdx}`,
        canonicalKey: `S7_${area}_${size}:${byteIdx}`,
        kind: 'WORD',
        readOnly: area === 'I',
        maxAddressIndex: 65535,
        wordAddressKey: { space, startIndex: byteIdx, unit: 'BYTE', byteWidth },
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
    const isHex = hexAreas.has(area);
    if (!isHex && !/^\d+$/.test(m[2])) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Mitsubishi area ${area} uses decimal addressing, got "${m[2]}".`,
        hint: `Use decimal index such as ${area}100.`,
      };
    }
    const idx = Number.parseInt(m[2], isHex ? 16 : 10);
    const maxIdx = isHex ? 0xffff : 65535;
    if (!Number.isSafeInteger(idx) || idx < 0 || idx > maxIdx) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Mitsubishi address ${upper} out of range (0..${isHex ? maxIdx.toString(16).toUpperCase() : maxIdx}).`,
        hint: `Keep index within 0..${isHex ? 'FFFF' : '65535'}.`,
      };
    }
    const isBit = ['X', 'Y', 'M', 'B', 'L', 'F'].includes(area);
    const space = `MITSU_${area}`;
    return {
      valid: true,
      protocol,
      normalized: isHex ? `${area}${idx.toString(16).toUpperCase()}` : `${area}${idx}`,
      canonicalKey: `${space}:${idx}`,
      kind: isBit ? 'BIT' : 'WORD',
      readOnly: area === 'X',
      maxAddressIndex: maxIdx,
      wordAddressKey: !isBit ? { space, startIndex: idx } : undefined,
    };
  }

  // 5. Omron FINS TCP
  if (protocol === 'OMRON_FINS_TCP') {
    const upper = trimmed.toUpperCase();
    const m = /^(CIO|W|H|A|D|DM|EM(\d+)\.)(\d+)(?:\.(\d{1,2}))?$/.exec(upper);
    if (!m) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Invalid Omron FINS address "${rawAddress}".`,
        hint: 'Use CIO0.00, W10.05, H0.00, D100, DM100, or EM0.100.',
      };
    }
    const emBank = m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined;
    if (emBank !== undefined && (emBank < 0 || emBank > 255)) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Omron EM bank ${emBank} out of range (0..255).`,
        hint: 'Use EM0..EM255.',
      };
    }
    const bit = m[4] !== undefined ? Number.parseInt(m[4], 10) : undefined;
    if (bit !== undefined && (bit < 0 || bit > 15)) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Omron bit index .${bit} out of range (0..15).`,
        hint: 'Use bit offset .00 through .15.',
      };
    }
    const idx = Number.parseInt(m[3], 10);
    if (idx < 0 || idx > 65535) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `Omron FINS index ${idx} out of range (0..65535).`,
        hint: 'Use word index 0..65535.',
      };
    }
    const areaNorm = m[1] === 'DM' ? 'D' : emBank !== undefined ? `EM${emBank}` : m[1];
    const space = `OMRON_${areaNorm}`;
    return {
      valid: true,
      protocol,
      normalized: upper,
      canonicalKey: bit !== undefined ? `${space}:${idx}.${bit}` : `${space}:${idx}`,
      kind: bit !== undefined ? 'BIT' : 'WORD',
      readOnly: false,
      maxAddressIndex: 65535,
      wordAddressKey: bit === undefined ? { space, startIndex: idx } : undefined,
      enclosingWordSlot:
        bit !== undefined ? { space, index: idx, unit: 'WORD', bitOffset: bit } : undefined,
    };
  }

  // 6. BACnet/IP (ASHRAE 135 22-bit instance ID: 0..4194302; 4194303 reserved)
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
    const inst = Number.parseInt(m[2], 10);
    if (!Number.isSafeInteger(inst) || inst < 0 || inst > 4194302) {
      return {
        valid: false,
        protocol,
        input: rawAddress,
        error: `BACnet instance ${inst} out of ASHRAE 135 22-bit range (0..4194302).`,
        hint: 'Use instance number between 0 and 4194302.',
      };
    }
    return {
      valid: true,
      protocol,
      normalized: `${obj}:${inst}`,
      canonicalKey: `BACNET_${obj}:${inst}`,
      kind: obj.startsWith('B') ? 'BIT' : 'WORD',
      readOnly: obj.endsWith('I'),
    };
  }

  // 7. OPC UA Client (Part 6 NodeId: ns=0..65535; i=0..4294967295, s=..., g=..., b=...)
  if (protocol === 'OPC_UA_CLIENT') {
    const opcMatch = /^(?:ns=(\d+);)?(i=\d+|s=[^\r\n]{1,200}|g=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|b=[A-Za-z0-9+/=]{1,256})$/.exec(
      trimmed
    );
    if (opcMatch) {
      const ns = opcMatch[1] ? Number.parseInt(opcMatch[1], 10) : 0;
      const body = opcMatch[2];
      if (!Number.isInteger(ns) || ns < 0 || ns > 65535) {
        return {
          valid: false,
          protocol,
          input: rawAddress,
          error: `OPC UA namespace index ns=${ns} out of UInt16 range (0..65535).`,
          hint: 'Use ns=0..65535.',
        };
      }
      if (body.startsWith('i=')) {
        const numId = Number(body.slice(2));
        if (!Number.isInteger(numId) || numId < 0 || numId > 4294967295) {
          return {
            valid: false,
            protocol,
            input: rawAddress,
            error: `OPC UA numeric identifier ${body} out of UInt32 range (0..4294967295).`,
            hint: 'Use i=0..4294967295.',
          };
        }
      }
      const canonicalBody = body.startsWith('g=') ? body.toLowerCase() : body;
      return {
        valid: true,
        protocol,
        normalized: trimmed,
        canonicalKey: `OPCUA:ns=${ns};${canonicalBody}`,
        kind: 'SYMBOLIC',
        readOnly: false,
      };
    }
    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: `Invalid OPC UA NodeId "${rawAddress}".`,
      hint: 'Use OPC UA Part 6 NodeId syntax such as ns=2;s=Chiller01.Supply_Temp_C or i=2258.',
    };
  }

  // 8. MQTT Client (non-empty UTF-8 scalar topic without NUL/CR/LF or +/# wildcards)
  if (protocol === 'MQTT_CLIENT') {
    if (trimmed.length <= 256 && !/[\u0000\r\n+#]/.test(trimmed)) {
      return {
        valid: true,
        protocol,
        normalized: trimmed,
        canonicalKey: `MQTT:${trimmed}`,
        kind: 'SYMBOLIC',
        readOnly: false,
      };
    }
    return {
      valid: false,
      protocol,
      input: rawAddress,
      error: `Invalid MQTT scalar tag topic address "${rawAddress}".`,
      hint: 'Use a non-empty UTF-8 MQTT topic path up to 256 characters without + or # wildcards.',
    };
  }

  // 9. Allen-Bradley EtherNet/IP (Logix CIP symbolic tags, case-insensitive Program:Name., 1D/2D/3D arrays, optional integer bit-slice .0..31)
  if (/^(?:[Pp][Rr][Oo][Gg][Rr][Aa][Mm]:[A-Za-z_][A-Za-z0-9_]{0,39}\.)?(?:[A-Za-z_][A-Za-z0-9_]{0,39}(?:\[\d+(?:,\d+){0,2}\])?)(?:\.[A-Za-z_][A-Za-z0-9_]{0,39}(?:\[\d+(?:,\d+){0,2}\])?)*(?:\.(?:[0-9]|[1-2][0-9]|3[0-1]))?$/.test(trimmed)) {
    const hasBitSlice = /\.(?:[0-9]|[1-2][0-9]|3[0-1])$/.test(trimmed);
    return {
      valid: true,
      protocol,
      normalized: trimmed,
      canonicalKey: `EIP:${trimmed.toLowerCase()}`,
      kind: hasBitSlice ? 'BIT' : 'SYMBOLIC',
      readOnly: false,
    };
  }

  return {
    valid: false,
    protocol,
    input: rawAddress,
    error: `Invalid symbolic tag address "${rawAddress}" for ${protocol}.`,
    hint: 'Use valid CIP symbolic tag syntax (e.g., Motor1.Speed, Matrix[0,1]).',
  };
}

/**
 * Validates that a JS value strictly conforms to the PLC TagDataType binary range.
 * Prevents NaN, Infinity, integer overflow, and string-to-float memory corruption.
 */
export function validateTagValueForType(
  dataType: TagDataType,
  value: unknown,
  maxBytes = 255
): { valid: true; normalizedValue: number | boolean | string } | { valid: false; code: string; error: string } {
  switch (dataType) {
    case 'BOOL':
      if (typeof value !== 'boolean') {
        return { valid: false, code: 'TYPE_MISMATCH_BOOL', error: `BOOL tag requires boolean (true/false), received ${typeof value}.` };
      }
      return { valid: true, normalizedValue: value };

    case 'STRING': {
      if (typeof value !== 'string') {
        return { valid: false, code: 'TYPE_MISMATCH_STRING', error: `STRING tag requires string, received ${typeof value}.` };
      }
      const byteLen = Buffer.byteLength(value, 'utf8');
      const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 255;
      if (byteLen > limit) {
        return {
          valid: false,
          code: 'STRING_LENGTH_EXCEEDED',
          error: `STRING tag exceeds ${limit}-byte SCADA buffer limit (${byteLen} UTF-8 bytes).`,
        };
      }
      return { valid: true, normalizedValue: value };
    }

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
      if (dataType === 'FLOAT32' && !Number.isFinite(Math.fround(value))) {
        return { valid: false, code: 'FLOAT32_OVERFLOW', error: `Value ${value} overflows IEEE 754 FLOAT32 range.` };
      }
      return { valid: true, normalizedValue: value };
    }

    default:
      return {
        valid: false,
        code: 'UNSUPPORTED_DATA_TYPE',
        error: `Unsupported PLC tag dataType "${String(dataType)}".`,
      };
  }
}

export function applyLinearScaling(rawValue: number, scaling: TagScaling): number {
  if (
    !Number.isFinite(scaling.rawMin) ||
    !Number.isFinite(scaling.rawMax) ||
    !Number.isFinite(scaling.engMin) ||
    !Number.isFinite(scaling.engMax)
  ) {
    return 0;
  }
  if (!Number.isFinite(rawValue)) return scaling.engMin;
  const rawSpan = scaling.rawMax - scaling.rawMin;
  if (!Number.isFinite(rawSpan) || rawSpan === 0) return scaling.engMin;
  const ratio = (rawValue - scaling.rawMin) / rawSpan;
  let eng = scaling.engMin + ratio * (scaling.engMax - scaling.engMin);
  if (scaling.clamp) {
    const lo = Math.min(scaling.engMin, scaling.engMax);
    const hi = Math.max(scaling.engMin, scaling.engMax);
    eng = Math.max(lo, Math.min(hi, eng));
  }
  if (!Number.isFinite(eng)) return scaling.engMin;
  const decimals = Math.abs(scaling.engMax - scaling.engMin) < 10 ? 6 : 4;
  return Number(eng.toFixed(decimals));
}

function resolvePositiveSpan(dataType: TagDataType, wordSpanOverride?: number): number {
  const rawSpan =
    wordSpanOverride !== undefined && Number.isInteger(wordSpanOverride) && wordSpanOverride > 0
      ? wordSpanOverride
      : getWordSpanForType(dataType);
  return Math.max(1, Math.min(rawSpan, 1024));
}

export function validateAddressSpanBounds(
  parsed: ValidatedPlcAddress,
  dataType: TagDataType,
  wordSpanOverride?: number
): { valid: true } | { valid: false; error: string } {
  if (!parsed.wordAddressKey || parsed.maxAddressIndex === undefined) {
    return { valid: true };
  }
  const span =
    parsed.wordAddressKey.unit === 'BYTE'
      ? Math.max(parsed.wordAddressKey.byteWidth ?? 1, getByteWidthForType(dataType, wordSpanOverride))
      : resolvePositiveSpan(dataType, wordSpanOverride);
  const endIndex = parsed.wordAddressKey.startIndex + span - 1;
  if (endIndex > parsed.maxAddressIndex) {
    return {
      valid: false,
      error: `${dataType} (${span} ${parsed.wordAddressKey.unit === 'BYTE' ? 'bytes' : 'words'}) starting at ${parsed.normalized} (index ${parsed.wordAddressKey.startIndex}) overflows register space upper bound ${parsed.maxAddressIndex} (requires up to ${endIndex}).`,
    };
  }
  return { valid: true };
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
 * Detects exact address collisions (including mixed Modbus notations like 00001/0X0/COIL:0),
 * multi-word/byte register overlaps (e.g. FLOAT32 at V100 vs INT16 at V101), and
 * bit-in-word / bit-in-byte overlaps (e.g. DB1.DBX0.0 vs DB1.DBW0 or V100.3 vs V99 FLOAT32)
 * while permitting distinct bits within the same word/byte (e.g. V100.0 and V100.1).
 */
export function detectWordOverlapConflicts(
  tags: Record<string, TagDefinition>,
  deviceProtocols: Map<string, PlcDriverProtocol>,
  deviceOffsets?: Map<string, 'BASE_0' | 'BASE_1'>
): WordOverlapConflict[] {
  const conflicts: WordOverlapConflict[] = [];
  const reportedPairs = new Set<string>();
  const pushUniqueConflict = (c: WordOverlapConflict) => {
    const pairKey = [c.tagA, c.tagB].sort().join('\0') + ':' + c.deviceId;
    if (reportedPairs.has(pairKey)) return;
    reportedPairs.add(pairKey);
    conflicts.push(c);
  };

  const exactSeen = new Map<string, TagDefinition>();
  const wordOccupancy = new Map<string, TagDefinition[]>();
  const bitSlotOccupancy = new Map<string, TagDefinition[]>();

  for (const tag of Object.values(tags)) {
    if (tag.scope !== 'PLC' || !tag.deviceId || !tag.address) continue;
    const protocol = deviceProtocols.get(tag.deviceId) ?? 'HAIWELL_PLC_TCP';
    const addressOffset = deviceOffsets?.get(tag.deviceId);
    const parsed = validatePlcAddress(protocol, tag.address, addressOffset ? { addressOffset } : {});
    if (!parsed.valid) continue;

    const exactKey = `${tag.deviceId}:${parsed.canonicalKey ?? parsed.normalized}`;
    const existingExact = exactSeen.get(exactKey);
    if (existingExact && existingExact.name !== tag.name) {
      pushUniqueConflict({
        tagA: existingExact.name,
        tagB: tag.name,
        deviceId: tag.deviceId,
        addressA: existingExact.address ?? '',
        addressB: tag.address,
        reason: `Exact PLC address collision on ${exactKey}.`,
      });
    } else {
      exactSeen.set(exactKey, tag);
    }

    if (parsed.wordAddressKey) {
      const isByteUnit = parsed.wordAddressKey.unit === 'BYTE';
      const baseByteWidth = parsed.wordAddressKey.byteWidth ?? 1;
      const typeByteWidth = getByteWidthForType(tag.dataType, tag.wordSpan);
      const isSingleByteContainer =
        baseByteWidth === 1 &&
        tag.wordSpan === undefined &&
        (tag.dataType === 'BOOL' || tag.dataType === 'INT16' || tag.dataType === 'UINT16' || tag.dataType === 'BCD16');
      const span = isByteUnit
        ? isSingleByteContainer
          ? 1
          : Math.max(baseByteWidth, typeByteWidth)
        : resolvePositiveSpan(tag.dataType, tag.wordSpan);
      for (let offset = 0; offset < span; offset++) {
        const slotKey = `${tag.deviceId}:${parsed.wordAddressKey.space}:${parsed.wordAddressKey.startIndex + offset}`;
        const occupants = wordOccupancy.get(slotKey) ?? [];
        for (const occupant of occupants) {
          if (occupant.name !== tag.name) {
            pushUniqueConflict({
              tagA: occupant.name,
              tagB: tag.name,
              deviceId: tag.deviceId,
              addressA: `${occupant.address} (${occupant.dataType})`,
              addressB: `${tag.address} (${tag.dataType})`,
              reason: `${isByteUnit ? 'Byte' : 'Multi-word'} register overlap at slot ${slotKey}.`,
            });
          }
        }
        const bitOccupants = bitSlotOccupancy.get(slotKey) ?? [];
        for (const bitOcc of bitOccupants) {
          if (bitOcc.name !== tag.name) {
            pushUniqueConflict({
              tagA: bitOcc.name,
              tagB: tag.name,
              deviceId: tag.deviceId,
              addressA: `${bitOcc.address} (${bitOcc.dataType})`,
              addressB: `${tag.address} (${tag.dataType})`,
              reason: `Bit-in-${isByteUnit ? 'byte' : 'word'} register overlap at slot ${slotKey}.`,
            });
          }
        }
        occupants.push(tag);
        wordOccupancy.set(slotKey, occupants);
      }
    }

    if (parsed.enclosingWordSlot) {
      const isByteUnit = parsed.enclosingWordSlot.unit === 'BYTE';
      const slotKey = `${tag.deviceId}:${parsed.enclosingWordSlot.space}:${parsed.enclosingWordSlot.index}`;
      const occupants = wordOccupancy.get(slotKey) ?? [];
      for (const occupant of occupants) {
        if (occupant.name !== tag.name) {
          pushUniqueConflict({
            tagA: occupant.name,
            tagB: tag.name,
            deviceId: tag.deviceId,
            addressA: `${occupant.address} (${occupant.dataType})`,
            addressB: `${tag.address} (${tag.dataType})`,
            reason: `Bit-in-${isByteUnit ? 'byte' : 'word'} register overlap at slot ${slotKey}.`,
          });
        }
      }
      const list = bitSlotOccupancy.get(slotKey) ?? [];
      list.push(tag);
      bitSlotOccupancy.set(slotKey, list);
    }
  }

  return conflicts;
}
