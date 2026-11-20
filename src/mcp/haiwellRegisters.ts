/**
 * Native Haiwell PLC Memory Register Parser & Modbus RTU/TCP Address Translator.
 * Reference: Official Haiwell PLC Communication Protocol & Modbus Mapping Table.
 */

export interface HaiwellRegisterSpec {
  area: 'X' | 'Y' | 'M' | 'T' | 'C' | 'S' | 'AI' | 'AQ' | 'V' | 'TV' | 'CV' | 'SV';
  name: string;
  kind: 'BIT' | 'WORD';
  readOnly: boolean;
  minIndex: number;
  maxIndex: number;
  modbusHexBase: number;
  modbusDecBase: number;
  modbusType: '0x_COIL_OR_1x_INPUT' | '3x_INPUT_OR_4x_HOLDING';
  functionCodes: number[];
  oneBasedPrefix: number;
}

export const HAIWELL_REGISTER_MAP: Record<HaiwellRegisterSpec['area'], HaiwellRegisterSpec> = {
  X: {
    area: 'X',
    name: 'External Discrete Input',
    kind: 'BIT',
    readOnly: true,
    minIndex: 0,
    maxIndex: 1023,
    modbusHexBase: 0x0000,
    modbusDecBase: 0,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2],
    oneBasedPrefix: 10001,
  },
  Y: {
    area: 'Y',
    name: 'External Discrete Output',
    kind: 'BIT',
    readOnly: false,
    minIndex: 0,
    maxIndex: 1023,
    modbusHexBase: 0x0600,
    modbusDecBase: 1536,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2, 5, 15],
    oneBasedPrefix: 1,
  },
  M: {
    area: 'M',
    name: 'Auxiliary Internal Relay',
    kind: 'BIT',
    readOnly: false,
    minIndex: 0,
    maxIndex: 12287,
    modbusHexBase: 0x0c00,
    modbusDecBase: 3072,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2, 5, 15],
    oneBasedPrefix: 1,
  },
  T: {
    area: 'T',
    name: 'Timer Coil',
    kind: 'BIT',
    readOnly: false,
    minIndex: 0,
    maxIndex: 1023,
    modbusHexBase: 0x3c00,
    modbusDecBase: 15360,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2, 5, 15],
    oneBasedPrefix: 1,
  },
  C: {
    area: 'C',
    name: 'Counter Coil',
    kind: 'BIT',
    readOnly: false,
    minIndex: 0,
    maxIndex: 255,
    modbusHexBase: 0x4000,
    modbusDecBase: 16384,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2, 5, 15],
    oneBasedPrefix: 1,
  },
  S: {
    area: 'S',
    name: 'Step Relay',
    kind: 'BIT',
    readOnly: false,
    minIndex: 0,
    maxIndex: 2047,
    modbusHexBase: 0x7000,
    modbusDecBase: 28672,
    modbusType: '0x_COIL_OR_1x_INPUT',
    functionCodes: [1, 2, 5, 15],
    oneBasedPrefix: 1,
  },
  AI: {
    area: 'AI',
    name: 'Analog Input Register',
    kind: 'WORD',
    readOnly: true,
    minIndex: 0,
    maxIndex: 255,
    modbusHexBase: 0x0000,
    modbusDecBase: 0,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4],
    oneBasedPrefix: 30001,
  },
  AQ: {
    area: 'AQ',
    name: 'Analog Output Register',
    kind: 'WORD',
    readOnly: false,
    minIndex: 0,
    maxIndex: 255,
    modbusHexBase: 0x0100,
    modbusDecBase: 256,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4, 6, 16],
    oneBasedPrefix: 40001,
  },
  V: {
    area: 'V',
    name: 'Internal Data Register',
    kind: 'WORD',
    readOnly: false,
    minIndex: 0,
    maxIndex: 14847,
    modbusHexBase: 0x0200,
    modbusDecBase: 512,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4, 6, 16],
    oneBasedPrefix: 40001,
  },
  TV: {
    area: 'TV',
    name: 'Timer Current Value Register',
    kind: 'WORD',
    readOnly: false,
    minIndex: 0,
    maxIndex: 1023,
    modbusHexBase: 0x3c00,
    modbusDecBase: 15360,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4, 6, 16],
    oneBasedPrefix: 40001,
  },
  CV: {
    area: 'CV',
    name: 'Counter Current Value Register',
    kind: 'WORD',
    readOnly: false,
    minIndex: 0,
    maxIndex: 255,
    modbusHexBase: 0x4000,
    modbusDecBase: 16384,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4, 6, 16],
    oneBasedPrefix: 40001,
  },
  SV: {
    area: 'SV',
    name: 'System Special Register',
    kind: 'WORD',
    readOnly: false,
    minIndex: 0,
    maxIndex: 900,
    modbusHexBase: 0x4400,
    modbusDecBase: 17408,
    modbusType: '3x_INPUT_OR_4x_HOLDING',
    functionCodes: [3, 4, 6, 16],
    oneBasedPrefix: 40001,
  },
};

export interface ParsedHaiwellAddress {
  valid: true;
  normalized: string;
  area: HaiwellRegisterSpec['area'];
  areaName: string;
  index: number;
  bitOffset?: number;
  kind: 'BIT' | 'WORD';
  readOnly: boolean;
  modbusOffset0Based: number;
  modbusHexAddress: string;
  modbusAddress1Based: number;
  functionCodes: number[];
  iecDirectAddress: string;
}

export interface InvalidHaiwellAddress {
  valid: false;
  input: string;
  error: string;
  hint: string;
}

const REGISTER_REGEX = /^(AI|AQ|TV|CV|SV|X|Y|M|T|C|S|V)(\d+)(?:\.(\d+))?$/i;

export function parseHaiwellRegister(address: string): ParsedHaiwellAddress | InvalidHaiwellAddress {
  const trimmed = address.trim().toUpperCase();
  const match = REGISTER_REGEX.exec(trimmed);
  if (!match) {
    return {
      valid: false,
      input: address,
      error: `Unrecognized Haiwell PLC register syntax "${address}".`,
      hint: 'Use valid Haiwell area + index such as X0, Y12, M100, AI0, AQ2, V500, V100.3, TV0, CV0, SV10.',
    };
  }

  const area = match[1] as HaiwellRegisterSpec['area'];
  const index = Number.parseInt(match[2], 10);
  const bitOffset = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
  const spec = HAIWELL_REGISTER_MAP[area];

  if (index < spec.minIndex || index > spec.maxIndex) {
    return {
      valid: false,
      input: address,
      error: `Register index ${area}${index} out of bounds for Haiwell ${spec.name} (${spec.minIndex}..${spec.maxIndex}).`,
      hint: `Choose an index between ${area}${spec.minIndex} and ${area}${spec.maxIndex}.`,
    };
  }

  if (bitOffset !== undefined) {
    if (spec.kind !== 'WORD') {
      return {
        valid: false,
        input: address,
        error: `Bit offset .${bitOffset} is only valid on 16-bit WORD registers (V, AI, AQ, TV, CV, SV), not bit coil ${area}.`,
        hint: `Remove the bit suffix and use ${area}${index}.`,
      };
    }
    if (bitOffset < 0 || bitOffset > 15) {
      return {
        valid: false,
        input: address,
        error: `Bit offset .${bitOffset} out of range (0..15) for 16-bit register ${area}${index}.`,
        hint: `Use bit offset between .0 and .15.`,
      };
    }
  }

  const modbusOffset0Based = spec.modbusDecBase + index;
  const modbusHexAddress = `0x${modbusOffset0Based.toString(16).toUpperCase().padStart(4, '0')}`;
  const modbusAddress1Based = spec.oneBasedPrefix + modbusOffset0Based;
  const effectiveKind: 'BIT' | 'WORD' = bitOffset !== undefined ? 'BIT' : spec.kind;

  let iecDirectAddress: string;
  if (area === 'X') iecDirectAddress = `%IX${Math.floor(index / 8)}.${index % 8}`;
  else if (area === 'Y') iecDirectAddress = `%QX${Math.floor(index / 8)}.${index % 8}`;
  else if (area === 'AI') iecDirectAddress = `%IW${index}`;
  else if (area === 'AQ') iecDirectAddress = `%QW${index}`;
  else if (effectiveKind === 'BIT') iecDirectAddress = `%MX${Math.floor(index / 8)}.${bitOffset ?? index % 8}`;
  else iecDirectAddress = `%MW${index}`;

  return {
    valid: true,
    normalized: bitOffset !== undefined ? `${area}${index}.${bitOffset}` : `${area}${index}`,
    area,
    areaName: spec.name,
    index,
    bitOffset,
    kind: effectiveKind,
    readOnly: spec.readOnly,
    modbusOffset0Based,
    modbusHexAddress,
    modbusAddress1Based,
    functionCodes: spec.functionCodes,
    iecDirectAddress,
  };
}
