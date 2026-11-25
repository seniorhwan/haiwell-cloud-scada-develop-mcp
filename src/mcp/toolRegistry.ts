/**
 * Hardened Single-Source-of-Truth MCP Tool Registry:
 * 61 production-grade tools across 15 Haiwell Cloud SCADA Develop domains.
 * Features LLM-tolerant input normalization (prototype-pollution safe), strict Zod v4 validation,
 * multi-vendor PLC register & multi-word/byte overlap detection, binary type/range guards,
 * spatial HMI P&ID compilation & desktop bridge export, ISA-18.2 deduplicating alarm state machine,
 * atomic batch I/O, snapshots/rollback, full referential-integrity deletion, faceplates, webhooks,
 * and headless FAT simulation.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { HAIWELL_REGISTER_MAP } from './haiwellRegisters';
import {
  applyLinearScaling,
  detectWordOverlapConflicts,
  getWordSpanForType,
  validateAddressSpanBounds,
  validatePlcAddress,
  validateTagValueForType,
  VENDOR_MODBUS_REGISTER_MAPS,
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
import {
  auditScreenSpatially,
  compileDesktopAutomationBridge,
  compileFullOpenProjectBridge,
  compilePidScreen,
  generateDesktopUiaCalibrator,
  getToolboxComponentsWithStyle,
  HAIWELL_GRAPHICS_LIBRARY_CATALOG,
  HAIWELL_GRAPHICS_LIBRARY_METADATA,
  HAIWELL_HMI_TOOLBOX,
  REAL_HAIWELL_350_TREE_NODES,
  solveAndRepairScreenLayout,
} from './hmiSpatialEngine';
import { importHwrunProject } from './hwrunImporter';
import { compileProjectToHwExport } from './hwExportCompiler';
import { instantiateHmiTemplate } from './hmiTemplates';
import {
  buildMqttPayload,
  generateOpcUaNodeSet2Xml,
  isBlockedSsrfHost,
  mapTagTypeToOpcUa,
  probeTcpEndpoint,
  validateMqttTopic,
} from './protocolAdapters';
import { validateHaiwellScript } from './scriptAnalyzer';
import { evaluateProjectAlarms, runSimulationSteps } from './simulationEngine';
import {
  createNewHaiwellProjectOnDesktop,
  deployHwExportToDesktop,
  inspectHaiwellDesktopInstallation,
  launchHaiwellDesktop,
} from './desktopAutomation';
import type { HaiwellProjectStore } from './projectStore';
import type { HaiwellDomain, HaiwellProject, PlcDriverProtocol, TagDefinition, ToolSafetyTier } from './types';

export interface HaiwellToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  domain: HaiwellDomain;
  haiwellFeature: string;
  safetyTier: ToolSafetyTier;
  description: string;
  inputSchema: z.ZodObject<TShape>;
  sampleInput: Record<string, unknown>;
  handler: (input: z.infer<z.ZodObject<TShape>>, store: HaiwellProjectStore) => Promise<unknown> | unknown;
}

function defineTool<TShape extends z.ZodRawShape>(
  def: HaiwellToolDefinition<TShape>
): HaiwellToolDefinition<z.ZodRawShape> {
  return def as unknown as HaiwellToolDefinition<z.ZodRawShape>;
}

const DEFAULT_PROJECT_ID = 'prj_chiller_plant_01';

const PLC_PROTOCOLS = [
  'HAIWELL_PLC_TCP',
  'HAIWELL_PLC_RTU',
  'MODBUS_TCP',
  'MODBUS_RTU',
  'SIEMENS_S7_1200',
  'SIEMENS_S7_1500',
  'MITSUBISHI_MC_3E',
  'OMRON_FINS_TCP',
  'ALLEN_BRADLEY_EIP',
  'DELTA_DVP_MODBUS',
  'SCHNEIDER_MODBUS',
  'BACNET_IP',
  'OPC_UA_CLIENT',
  'MQTT_CLIENT',
] as const;

const WIDGET_TYPES = [
  'NUMERIC_DISPLAY',
  'NUMERIC_INPUT',
  'BIT_BUTTON',
  'BIT_LAMP',
  'MULTI_STATE_INDICATOR',
  'BAR_GRAPH',
  'GAUGE',
  'TANK',
  'PUMP',
  'VALVE',
  'PIPELINE',
  'STATION',
  'CONVEYOR',
  'ACTUATOR',
  'GROUP_PANEL',
  'TREND_CHART',
  'ALARM_BANNER',
  'RECIPE_SELECTOR',
  'CAMERA_VIEW',
  'DATA_TABLE',
  'NAV_BAR',
  'LABEL',
  'FACEPLATE_INSTANCE',
] as const;

const VISUAL_ROLES = [
  'DEFAULT',
  'PRIMARY_ACTION',
  'DANGER_ACTION',
  'WARNING_ACTION',
  'STATUS_READONLY',
  'KPI_HERO',
] as const;

const SQL_RESERVED = new Set(['SELECT', 'DROP', 'DELETE', 'INSERT', 'UPDATE', 'TABLE', 'FROM', 'WHERE', 'UNION', 'ORDER', 'GROUP', 'INDEX', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'TRUNCATE', 'JOIN']);

function validateCronExpression(cron: string): { valid: boolean; error?: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { valid: false, error: 'CRON must have exactly 5 fields: minute hour dom month dow.' };
  const bounds: [string, number, number][] = [
    ['minute', 0, 59],
    ['hour', 0, 23],
    ['day-of-month', 1, 31],
    ['month', 1, 12],
    ['day-of-week', 0, 7],
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const [name, min, max] = bounds[i];
    for (const seg of field.split(',')) {
      const stepParts = seg.split('/');
      if (stepParts.length > 2) return { valid: false, error: `Invalid step in CRON ${name}: "${seg}".` };
      if (stepParts[1] !== undefined) {
        const step = Number(stepParts[1]);
        if (!Number.isInteger(step) || step < 1 || step > max) {
          return { valid: false, error: `Invalid step "${stepParts[1]}" in CRON ${name}.` };
        }
      }
      const rangeStr = stepParts[0];
      if (rangeStr === '*') continue;
      const rangeParts = rangeStr.split('-');
      if (rangeParts.length > 2) return { valid: false, error: `Invalid range "${rangeStr}" in CRON ${name}.` };
      for (const nStr of rangeParts) {
        if (!/^\d+$/.test(nStr)) return { valid: false, error: `Non-numeric token "${nStr}" in CRON ${name}.` };
        const n = Number(nStr);
        if (n < min || n > max) return { valid: false, error: `CRON ${name} value ${n} out of bounds [${min}..${max}].` };
      }
      if (rangeParts.length === 2 && Number(rangeParts[0]) > Number(rangeParts[1])) {
        return { valid: false, error: `CRON ${name} range start > end in "${rangeStr}".` };
      }
    }
  }
  return { valid: true };
}

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getOwnTag(project: HaiwellProject, tagName: string): TagDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(project.tags, tagName) ? project.tags[tagName] : undefined;
}

function hasOwnTag(project: HaiwellProject, tagName: string): boolean {
  return Object.prototype.hasOwnProperty.call(project.tags, tagName);
}

function stripPrototypeKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(stripPrototypeKeysDeep);
  }
  if (val && typeof val === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
      clean[k] = stripPrototypeKeysDeep(v);
    }
    return clean;
  }
  return val;
}

/**
 * Safely normalizes common LLM client serialization quirks before strict Zod validation:
 * - Recursively strips prototype-pollution keys (__proto__, constructor, prototype)
 * - Converts explicit `null` on optional keys to `undefined`
 * - Parses stringified JSON arrays/objects when a client double-encodes complex arguments
 */
const LITERAL_STRING_ARG_KEYS = new Set([
  'code',
  'source',
  'description',
  'messageTemplate',
  'payloadTemplate',
  'projectName',
  'name',
  'label',
  'reason',
  'filePathOrTtsText',
  'lwtPayload',
  'value',
  'actionValue',
  'svgMarkup',
]);

export function normalizeAgentArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeAgentArgs(parsed);
      }
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
    if (v === null) continue;
    if (typeof v === 'string' && !LITERAL_STRING_ARG_KEYS.has(k)) {
      const trimmed = v.trim();
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          out[k] = stripPrototypeKeysDeep(JSON.parse(trimmed));
          continue;
        } catch {
          // Keep literal string (e.g., LD/FBD JSON source intentionally passed as string!)
        }
      }
    }
    out[k] = stripPrototypeKeysDeep(v);
  }
  // Keep `source` as string for IEC 61131-3 tools even if LD/FBD JSON array was passed as array
  if (out.source !== undefined && typeof out.source !== 'string') {
    out.source = JSON.stringify(out.source);
  }
  return out;
}

function escapeCsvCell(val: unknown, protectFormula = false): string {
  let s = val === undefined || val === null ? '' : String(val);
  if (protectFormula && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildProjectExportBundle(project: HaiwellProject) {
  const tagCsvHeader =
    'name,scope,deviceId,address,modbus0Based,modbus1Based,wordSpan,dataType,access,unit,safeMin,safeMax,safetyClass,requiresInterlock';
  const tagCsvRows = Object.values(project.tags).map((t) =>
    [
      escapeCsvCell(t.name, true),
      escapeCsvCell(t.scope),
      escapeCsvCell(t.deviceId ?? '', true),
      escapeCsvCell(t.address ?? '', true),
      escapeCsvCell(t.modbusOffset0Based ?? ''),
      escapeCsvCell(t.modbusAddress1Based ?? ''),
      escapeCsvCell(t.wordSpan ?? ''),
      escapeCsvCell(t.dataType),
      escapeCsvCell(t.access),
      escapeCsvCell(t.unit ?? '', true),
      escapeCsvCell(t.safeMin ?? ''),
      escapeCsvCell(t.safeMax ?? ''),
      escapeCsvCell(t.safetyClass),
      escapeCsvCell(t.requiresInterlock),
    ].join(',')
  );

  const deviceMap = new Map(project.devices.map((d) => [d.id, d]));

  const formatHaiwellRegisterType = (t: TagDefinition): string => {
    if (t.scope !== 'PLC') return t.scope === 'INTERNAL' ? 'Internal' : t.scope;
    const dev = t.deviceId ? deviceMap.get(t.deviceId) : undefined;
    if (dev && t.address) {
      const parsed = validatePlcAddress(dev.protocol, t.address, {
        addressOffset: dev.addressOffset ?? 'BASE_0',
      });
      if (parsed.valid && parsed.modbusArea) {
        if (parsed.modbusArea === 'DI') return '1X(Digital input,Function code 02)';
        if (parsed.modbusArea === 'COIL') return '0X(Digital output,Function code 01 05)';
        if (parsed.modbusArea === 'IR') return '3X(Analog input,Function code 04)';
        if (parsed.modbusArea === 'HR') return '4X(Analog output,Function code 03 06)';
      }
    }
    const addr = (t.address ?? '').trim().toUpperCase();
    const m1 = t.modbusAddress1Based;
    // Check 3X/IR and 4X/HR BEFORE 1X/I and 0X/COIL so "IR:0" is never captured by /^I/
    if (/^(IR:|3X|AI|IW|PIW)/.test(addr) || (m1 !== undefined && ((m1 >= 30001 && m1 < 40000) || (m1 >= 300001 && m1 <= 365536)))) {
      return '3X(Analog input,Function code 04)';
    }
    if (/^(HR:|4X|AQ|MW|QW|VW|DB|V\d|TV\d|CV\d|SV\d|DM\d|D\d)/.test(addr) || (m1 !== undefined && ((m1 >= 40001 && m1 < 50000) || (m1 >= 400001 && m1 <= 465536)))) {
      return '4X(Analog output,Function code 03 06)';
    }
    if (/^(DI:|1X|X\d|I\d|%I)/.test(addr) || (m1 !== undefined && ((m1 >= 10001 && m1 < 20000) || (m1 >= 100001 && m1 <= 165536)))) {
      return '1X(Digital input,Function code 02)';
    }
    if (/^(COIL:|0X|Y\d|Q\d|M\d|T\d|C\d|S\d|%Q)/.test(addr) || (m1 !== undefined && m1 >= 1 && m1 < 10000)) {
      return '0X(Digital output,Function code 01 05)';
    }
    return '4X(Analog output,Function code 03 06)';
  };
  const formatHaiwellRegisterAddress = (t: TagDefinition): string => {
    const rawAddr = (t.address ?? '').trim();
    const bitSuffixMatch = /\.(\d+)$/.exec(rawAddr);
    if (t.modbusOffset0Based !== undefined) {
      // Preserve bit-slice suffix on word registers (e.g., V200.3 -> "200.3")
      if (bitSuffixMatch && t.dataType === 'BOOL' && /^(?:V|TV|CV|SV|4X|3X|HR:|IR:|D|DM|MW|QW)/i.test(rawAddr)) {
        return `${t.modbusOffset0Based}.${bitSuffixMatch[1]}`;
      }
      return String(t.modbusOffset0Based);
    }
    const prefixedMatch = /^(?:HR:|IR:|COIL:|DI:|4X|3X|1X|0X)(\d+(?:\.\d+)?)$/i.exec(rawAddr);
    if (prefixedMatch) {
      return prefixedMatch[1];
    }
    return rawAddr;
  };
  const formatHaiwellDataType = (dt: TagDefinition['dataType']): string => {
    switch (dt) {
      case 'BOOL':
        return 'Bool';
      case 'INT16':
        return 'Integer';
      case 'UINT16':
        return 'UInteger';
      case 'INT32':
        return 'Long';
      case 'UINT32':
        return 'ULong';
      case 'FLOAT32':
        return 'Float';
      case 'FLOAT64':
        return 'Double';
      case 'STRING':
        return 'String';
      case 'BCD16':
        return '16-bit BCD';
      case 'BCD32':
        return '32-bit BCD';
    }
  };
  const formatHaiwellAccess = (access: TagDefinition['access']): string =>
    access === 'RO' ? 'Read only' : access === 'WO' ? 'Write only' : 'Read and write';
  const formatHaiwellFreq = (freq?: TagDefinition['collectFrequency']): string =>
    freq === 'HIGH' ? 'High speed' : freq === 'LOW' ? 'Low speed' : 'Normal';

  const haiwellVarHeader =
    'Variable name,Register type,Address format,Register address,Address length,Data type,Read-write mode,Acquisition frequency,Always Collect,Description';
  const allTags = Object.values(project.tags);
  const plcTags = allTags.filter((t) => t.scope === 'PLC');
  const internalTags = allTags.filter((t) => t.scope !== 'PLC');
  const formatHaiwellRow = (t: TagDefinition) =>
    [
      escapeCsvCell(t.name, true),
      escapeCsvCell(formatHaiwellRegisterType(t)),
      escapeCsvCell('Decimal'),
      escapeCsvCell(formatHaiwellRegisterAddress(t), true),
      escapeCsvCell(Math.max(1, t.wordSpan ?? getWordSpanForType(t.dataType))),
      escapeCsvCell(formatHaiwellDataType(t.dataType)),
      escapeCsvCell(formatHaiwellAccess(t.access)),
      escapeCsvCell(formatHaiwellFreq(t.collectFrequency)),
      escapeCsvCell(t.alwaysCollect ? 'TRUE' : 'FALSE'),
      escapeCsvCell(t.description ?? '', true),
    ].join(',');
  const haiwellVarRows = plcTags.map(formatHaiwellRow);
  const haiwellInternalHeader = 'Variable name,Scope,Register address,Data type,Initial value,Description';
  let nextInternalWord = 0;
  const haiwellInternalRows = internalTags.map((t) => {
    let regAddr = (t.address ?? '').trim();
    if (!regAddr) {
      const span = t.dataType === 'STRING' ? 16 : Math.max(1, t.wordSpan ?? getWordSpanForType(t.dataType));
      regAddr = `W${nextInternalWord}`;
      nextInternalWord += span;
    }
    return [
      escapeCsvCell(t.name, true),
      escapeCsvCell(t.scope),
      escapeCsvCell(regAddr),
      escapeCsvCell(formatHaiwellDataType(t.dataType)),
      escapeCsvCell(t.currentValue ?? '', true),
      escapeCsvCell(t.description ?? '', true),
    ].join(',');
  });

  return {
    format: 'haiwell-cloud-scada-bundle/v2.8',
    exportedAt: new Date().toISOString(),
    projectMeta: {
      id: project.id,
      name: project.name,
      hwdevFileName: project.hwdevFileName,
      version: project.version,
      revision: project.revision,
      targetHardware: project.targetHardware,
      resolution: project.resolution,
      defaultLanguage: project.defaultLanguage,
      cloudEnabled: project.cloudEnabled,
      networkProjectEnabled: project.networkProjectEnabled,
      networkProjectPort: project.networkProjectPort,
      targetDownloadIp: project.targetDownloadIp,
      startupScreenId: project.startupScreenId,
    },
    artifacts: {
      'project.hwdev.manifest.json': {
        schema: 'haiwell.cloud.scada.3.50.hwdev-manifest/v1',
        artifactRole: 'MCP_INTERMEDIATE_PROJECT_MANIFEST',
        hwdevDirectBinaryWriteSupported: false,
        hwdevBinaryFormatNote:
          'Real .hwdev files are encrypted proprietary binary containers (1024-byte page-aligned ciphertext) and cannot be written directly offline; use haiwell_open_project_bridge_export against an open Haiwell Cloud Scada window.',
        variablesCsvNote:
          'haiwell_variables_import.csv exports PLC device variables with headers matching the Haiwell Cloud Scada 3.50.1.19 Device Variable Grid (Variable name, Register type, Address format, Register address, Address length, Data type, Read-write mode, Acquisition frequency, Always Collect, Description). Non-PLC internal/system variables are exported separately in haiwell_internal_variables.csv.',
        hwdevFileName: project.hwdevFileName,
        projectBrowserNodesCovered: [...REAL_HAIWELL_350_TREE_NODES],
        project,
      },
      'project.hwsp.json': project,
      'haiwell_variables_import.csv': [haiwellVarHeader, ...haiwellVarRows].join('\n'),
      'haiwell_internal_variables.csv': [haiwellInternalHeader, ...haiwellInternalRows].join('\n'),
      'tags.csv': [tagCsvHeader, ...tagCsvRows].join('\n'),
      'opcua/nodeset2.xml': generateOpcUaNodeSet2Xml(project),
      'mqtt/bindings.json': project.mqtt,
      'screens/svg': Object.fromEntries(
        project.screens.map((s) => [`${s.id}.svg`, renderScreenToSvg(s, project.tags)])
      ),
      'plc/pous': Object.fromEntries(project.pous.map((p) => [`${p.name}.${p.language.toLowerCase()}`, p.source])),
      'scripts/js': Object.fromEntries(project.scripts.map((s) => [`${s.name}.js`, s.code])),
      ...(project.screens.length > 0 ? { 'project.hwExport': compileProjectToHwExport(project).xml } : {}),
    },
  };
}

export function runProjectSafetyAudit(project: HaiwellProject) {
  const findings: {
    code: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    domain: HaiwellDomain;
    target: string;
    message: string;
    remediation: string;
  }[] = [];

  const deviceProtocols = new Map<string, PlcDriverProtocol>(project.devices.map((d) => [d.id, d.protocol]));
  const deviceOffsets = new Map<string, 'BASE_0' | 'BASE_1'>(
    project.devices.map((d) => [d.id, d.addressOffset ?? 'BASE_0'])
  );

  // 1. Multi-word & exact register overlap check (honoring per-device BASE_0 / BASE_1 addressOffset)
  for (const conflict of detectWordOverlapConflicts(project.tags, deviceProtocols, deviceOffsets)) {
    findings.push({
      code: 'AUD-TAG-OVERLAP',
      severity: 'CRITICAL',
      domain: 'tags',
      target: `${conflict.tagA} <-> ${conflict.tagB}`,
      message: conflict.reason,
      remediation: 'Reassign non-overlapping PLC registers accounting for 32-bit (2-word) and 64-bit (4-word) spans.',
    });
  }

  for (const tag of Object.values(project.tags)) {
    if (tag.scope === 'PLC') {
      if (!tag.deviceId || !deviceProtocols.has(tag.deviceId)) {
        findings.push({
          code: 'AUD-TAG-ORPHAN-DEVICE',
          severity: 'HIGH',
          domain: 'tags',
          target: tag.name,
          message: `PLC tag "${tag.name}" references unknown deviceId "${tag.deviceId ?? ''}".`,
          remediation: 'Add the missing device via haiwell_device_add or rebind deviceId.',
        });
      } else if (tag.address) {
        const parsed = validatePlcAddress(deviceProtocols.get(tag.deviceId)!, tag.address, {
          addressOffset: deviceOffsets.get(tag.deviceId) ?? 'BASE_0',
        });
        if (!parsed.valid) {
          findings.push({
            code: 'AUD-TAG-BAD-ADDR',
            severity: 'CRITICAL',
            domain: 'tags',
            target: tag.name,
            message: parsed.error,
            remediation: parsed.hint,
          });
        } else {
          const spanCheck = validateAddressSpanBounds(parsed, tag.dataType, tag.wordSpan);
          if (!spanCheck.valid) {
            findings.push({
              code: 'AUD-TAG-BAD-ADDR',
              severity: 'CRITICAL',
              domain: 'tags',
              target: tag.name,
              message: spanCheck.error,
              remediation: 'Assign a lower starting register index so the full multi-word span fits within hardware bounds.',
            });
          } else if (parsed.readOnly && tag.access !== 'RO') {
            findings.push({
              code: 'AUD-TAG-RO-VIOLATION',
              severity: 'CRITICAL',
              domain: 'tags',
              target: tag.name,
              message: `Tag "${tag.name}" allows ${tag.access} access on physical read-only register ${tag.address}.`,
              remediation: 'Set tag access mode to RO.',
            });
          }
        }
      }
    }
    if ((tag.safetyClass === 'SIL2' || tag.safetyClass === 'SIL3') && tag.access !== 'RO' && !tag.requiresInterlock) {
      findings.push({
        code: 'AUD-SIL-INTERLOCK',
        severity: 'CRITICAL',
        domain: 'security',
        target: tag.name,
        message: `Writable ${tag.safetyClass} tag "${tag.name}" does not enforce requiresInterlock=true.`,
        remediation: 'Enable requiresInterlock on all SIL2/SIL3 writable outputs.',
      });
    }
  }

  // 2. Validate IEC 61131-3 POUs (ST, LD, FBD)
  for (const pou of project.pous) {
    const res =
      pou.language === 'ST'
        ? validateStructuredText(pou.source)
        : pou.language === 'LD'
          ? validateLadderGraph(pou.name, pou.source)
          : validateFbdNetwork(pou.name, pou.source);
    if (!res.valid) {
      findings.push({
        code: 'AUD-IEC-INVALID',
        severity: 'CRITICAL',
        domain: 'iec61131',
        target: pou.name,
        message: `POU "${pou.name}" (${pou.language}) has ${res.summary.errors} IEC 61131-3 error(s).`,
        remediation: 'Fix diagnostics reported by haiwell_iec61131_validate before deployment.',
      });
    }
  }

  // 3. Validate HMI screens (collisions, bounds, tags, nav links, touch targets, RO writes, duplicates, ranges, pipes)
  const screenIds = new Set(project.screens.map((s) => s.id));
  if (project.startupScreenId && !screenIds.has(project.startupScreenId)) {
    findings.push({
      code: 'AUD-STARTUP-SCREEN',
      severity: 'HIGH',
      domain: 'hmi',
      target: project.startupScreenId,
      message: `Project startupScreenId "${project.startupScreenId}" does not match any HMI screen in project "${project.id}".`,
      remediation: 'Create the missing startup screen or update startupScreenId to an existing screen ID.',
    });
  } else if (!project.startupScreenId && project.screens.length > 0) {
    findings.push({
      code: 'AUD-STARTUP-SCREEN',
      severity: 'MEDIUM',
      domain: 'hmi',
      target: project.id,
      message: `Project "${project.id}" defines ${project.screens.length} HMI screen(s) but has no startupScreenId configured.`,
      remediation: 'Assign startupScreenId to the primary operator overview screen.',
    });
  }
  for (const screen of project.screens) {
    const res = validateHmiScreen(screen, project.tags, {
      knownScreenIds: screenIds,
      targetHardware: project.targetHardware,
    });
    if (!res.valid) {
      findings.push({
        code: 'AUD-HMI-LAYOUT',
        severity: 'HIGH',
        domain: 'hmi',
        target: screen.id,
        message: `Screen "${screen.name}" issues: collisions=${res.collisions.length}, outOfBounds=${res.outOfBounds.length}, unresolvedTags=${res.unresolvedTags.length}, brokenNav=${res.brokenNavTargets.length}, touchTargets=${res.touchTargetViolations.length}, duplicateIds=${res.duplicateWidgetIds.length}, roWriteWidgets=${res.readOnlyWriteWidgets.length}, invalidRanges=${res.invalidRanges.length}, disconnectedPipes=${res.disconnectedPipes.length}.`,
        remediation: 'Regenerate or fix widget geometry, bindings, read-only write flags, ranges, pipes, and navigation links.',
      });
    }
  }

  // 1b. RS-485 RTU Daisy-Chain Bus Framing & Slave ID Uniqueness Check
  const rtuByPort = new Map<string, typeof project.devices>();
  for (const dev of project.devices) {
    if (dev.enabled && dev.transport === 'RTU' && dev.serialPort) {
      const key = dev.serialPort.trim().toUpperCase();
      const list = rtuByPort.get(key) ?? [];
      list.push(dev);
      rtuByPort.set(key, list);
    }
  }
  for (const [port, devs] of rtuByPort.entries()) {
    const seenIds = new Set<number>();
    const ref = devs[0];
    for (const d of devs) {
      if (seenIds.has(d.stationId)) {
        findings.push({
          code: 'AUD-RS485-BUS',
          severity: 'CRITICAL',
          domain: 'devices',
          target: `${port}:${d.id}`,
          message: `Duplicate Modbus RTU Slave ID ${d.stationId} on shared serial bus ${port}.`,
          remediation: 'Assign unique stationId (1..247) to every PLC on the RS-485 daisy-chain.',
        });
      }
      seenIds.add(d.stationId);
      if (
        d.baudRate !== ref.baudRate ||
        d.dataBits !== ref.dataBits ||
        d.parity !== ref.parity ||
        d.stopBits !== ref.stopBits
      ) {
        findings.push({
          code: 'AUD-RS485-BUS',
          severity: 'CRITICAL',
          domain: 'devices',
          target: `${port}:${d.id}`,
          message: `Serial framing mismatch on ${port}: "${d.name}" (${d.baudRate}-${d.dataBits}-${d.parity}-${d.stopBits}) differs from "${ref.name}" (${ref.baudRate}-${ref.dataBits}-${ref.parity}-${ref.stopBits}).`,
          remediation: 'Unify baudRate, dataBits, parity, and stopBits across all slaves sharing an RS-485 bus.',
        });
      }
    }
  }

  // 4. Validate JavaScript scripts (Strict ES5 on ARM HMIs + Haiwell 3.50.x runtime traps)
  const displayedTags = new Set<string>();
  for (const screen of project.screens) {
    for (const w of screen.widgets) {
      if (w.tagName) displayedTags.add(w.tagName);
    }
  }
  const cyclicScripts = project.scripts.filter((s) => s.trigger === 'CYCLIC');
  if (cyclicScripts.length > 1) {
    findings.push({
      code: 'AUD-MULTI-TIMER',
      severity: 'MEDIUM',
      domain: 'scripts',
      target: cyclicScripts.map((s) => s.id).join(', '),
      message: `${cyclicScripts.length} separate CYCLIC scripts defined. Haiwell Cloud SCADA 3.50.x www.js timerEventActions() has a multi-timer return bug that can skip subsequent cyclic tasks.`,
      remediation: 'Consolidate periodic tasks into a single STARTUP script driving one Common.SetInterval(workerTick, ms) loop.',
    });
  }

  const bgPolledTagsWarned = new Set<string>();
  for (const script of project.scripts) {
    const res = validateHaiwellScript(script.code, project.tags, {
      trigger: script.trigger,
      intervalMs: script.intervalMs,
      triggerTag: script.triggerTag,
      targetHardware: project.targetHardware,
    });
    if (!res.valid) {
      findings.push({
        code: 'AUD-SCRIPT-INVALID',
        severity: 'HIGH',
        domain: 'scripts',
        target: script.name,
        message: `Script "${script.name}" failed static validation (${res.diagnostics.filter((d) => d.severity === 'ERROR').length} error(s)).`,
        remediation: 'Run haiwell_script_validate and resolve ES5 syntax, referenced tags, or forbidden APIs.',
      });
    }
    if (script.trigger === 'STARTUP' || script.trigger === 'CYCLIC' || script.trigger === 'TAG_CHANGE') {
      const refs = new Set<string>([...res.referencedTags, ...(script.triggerTag ? [script.triggerTag] : [])]);
      for (const tagName of refs) {
        const tag = getOwnTag(project, tagName);
        if (tag && tag.scope === 'PLC' && !displayedTags.has(tagName) && !tag.alwaysCollect && !bgPolledTagsWarned.has(tagName)) {
          bgPolledTagsWarned.add(tagName);
          findings.push({
            code: 'AUD-ALWAYS-COLLECT',
            severity: 'MEDIUM',
            domain: 'tags',
            target: tagName,
            message: `PLC tag "${tagName}" is used by background script "${script.name}" but is not bound to any HMI screen and has alwaysCollect=false (Haiwell HMI skips polling unrendered PLC tags unless Always Collect is enabled).`,
            remediation: `Set alwaysCollect=true on tag "${tagName}" via haiwell_tag_upsert_batch.`,
          });
        }
      }
    }
  }

  // 5. Security & IIoT protocol checks
  if (project.cloudEnabled && !project.security.abKeyEnabled) {
    findings.push({
      code: 'AUD-SEC-ABKEY',
      severity: 'HIGH',
      domain: 'security',
      target: project.id,
      message: 'Cloud access enabled without Haiwell A/B Key verification.',
      remediation: 'Enable abKeyEnabled via haiwell_security_policy.',
    });
  }
  if (project.opcua.securityPolicy === 'None' || project.opcua.securityMode === 'None') {
    findings.push({
      code: 'AUD-OPCUA-INSECURE',
      severity: 'HIGH',
      domain: 'opcua',
      target: project.opcua.endpointUrl,
      message: 'OPC UA endpoint is configured without message signing/encryption.',
      remediation: 'Use Basic256Sha256 + SignAndEncrypt in production.',
    });
  }
  if (project.mqtt.bindings.some((b) => b.allowRemoteWrite && !project.mqtt.tlsEnabled)) {
    findings.push({
      code: 'AUD-MQTT-TLS',
      severity: 'CRITICAL',
      domain: 'mqtt',
      target: project.mqtt.brokerUri,
      message: 'MQTT remote tag write is enabled over plaintext (non-TLS) broker.',
      remediation: 'Enable TLS (mqtts://) or disable allowRemoteWrite.',
    });
  }

  // 6. Dangling tag reference audit across alarms, OPC UA, MQTT, triggers, recipes, trends, Data-Link, reports
  const pushDangling = (domain: HaiwellDomain, target: string, tagName: string) => {
    findings.push({
      code: 'AUD-DANGLING-TAG',
      severity: 'HIGH',
      domain,
      target,
      message: `${target} references missing SCADA tag "${tagName}".`,
      remediation: `Create tag "${tagName}" or remove the stale reference before deployment.`,
    });
  };
  for (const alm of project.alarms) {
    if (!hasOwnTag(project, alm.tagName)) pushDangling('alarms', `alarm:${alm.id}`, alm.tagName);
  }
  for (const node of project.opcua.nodes) {
    if (!hasOwnTag(project, node.tagName)) pushDangling('opcua', `opcua_node:${node.nodeId}`, node.tagName);
  }
  for (const bind of project.mqtt.bindings) {
    for (const tn of bind.tags) {
      if (!hasOwnTag(project, tn)) pushDangling('mqtt', `mqtt_binding:${bind.id}`, tn);
    }
  }
  const scriptIds = new Set(project.scripts.map((s) => s.id));
  const webhookIds = new Set(project.webhooks.map((w) => w.id));
  const reportIds = new Set(project.reports.map((r) => r.id));
  const hasRecipeTarget = (targetId: string): boolean => {
    const [grpId, recId] = targetId.split(':');
    const grp = project.recipes.find((r) => r.id === grpId);
    return Boolean(grp && recId && grp.records.some((rec) => rec.recordId === recId));
  };
  const pushDanglingRef = (domain: HaiwellDomain, target: string, refKind: string, targetId: string) => {
    findings.push({
      code: 'AUD-DANGLING-REF',
      severity: 'HIGH',
      domain,
      target,
      message: `${target} references missing ${refKind} "${targetId}".`,
      remediation: `Create the missing ${refKind} "${targetId}" or remove the stale reference before deployment.`,
    });
  };
  for (const ev of project.eventTriggers) {
    if (!hasOwnTag(project, ev.sourceTag)) pushDangling('scripts', `event_trigger:${ev.id}`, ev.sourceTag);
    if (ev.actionType === 'WRITE_TAG' && !hasOwnTag(project, ev.targetId)) {
      pushDangling('scripts', `event_trigger:${ev.id}`, ev.targetId);
    } else if (ev.actionType === 'OPEN_SCREEN' && !screenIds.has(ev.targetId)) {
      pushDanglingRef('scripts', `event_trigger:${ev.id}`, 'screen', ev.targetId);
    } else if (ev.actionType === 'RUN_SCRIPT' && !scriptIds.has(ev.targetId)) {
      pushDanglingRef('scripts', `event_trigger:${ev.id}`, 'script', ev.targetId);
    } else if (ev.actionType === 'SEND_WEBHOOK' && !webhookIds.has(ev.targetId)) {
      pushDanglingRef('scripts', `event_trigger:${ev.id}`, 'webhook', ev.targetId);
    } else if (ev.actionType === 'DOWNLOAD_RECIPE' && !hasRecipeTarget(ev.targetId)) {
      pushDanglingRef('scripts', `event_trigger:${ev.id}`, 'recipe', ev.targetId);
    }
  }
  for (const sch of project.schedules) {
    if (sch.actionType === 'WRITE_TAG' && !hasOwnTag(project, sch.targetId)) {
      pushDangling('operations', `schedule:${sch.id}`, sch.targetId);
    } else if (sch.actionType === 'RUN_SCRIPT' && !scriptIds.has(sch.targetId)) {
      pushDanglingRef('operations', `schedule:${sch.id}`, 'script', sch.targetId);
    } else if (sch.actionType === 'DOWNLOAD_RECIPE' && !hasRecipeTarget(sch.targetId)) {
      pushDanglingRef('operations', `schedule:${sch.id}`, 'recipe', sch.targetId);
    } else if (sch.actionType === 'EXPORT_REPORT' && !reportIds.has(sch.targetId)) {
      pushDanglingRef('operations', `schedule:${sch.id}`, 'report', sch.targetId);
    }
  }
  for (const rcp of project.recipes) {
    for (const tn of rcp.tagNames) {
      if (!hasOwnTag(project, tn)) pushDangling('recipes', `recipe:${rcp.id}`, tn);
    }
  }
  for (const trd of project.trends) {
    for (const tn of trd.tagNames) {
      if (!hasOwnTag(project, tn)) pushDangling('trends', `trend:${trd.id}`, tn);
    }
  }
  for (const dl of project.dataLinks) {
    for (const col of dl.columnMappings) {
      if (!hasOwnTag(project, col.tagName)) pushDangling('datalink', `datalink:${dl.id}`, col.tagName);
    }
  }
  for (const rp of project.reports) {
    for (const col of rp.columns) {
      if (!hasOwnTag(project, col.tagName)) pushDangling('operations', `report:${rp.id}`, col.tagName);
    }
  }
  for (const dg of project.dataGroups ?? []) {
    for (const tn of dg.tagNames) {
      if (!hasOwnTag(project, tn)) pushDangling('datalink', `data_group:${dg.id}`, tn);
    }
    if (dg.triggerTag && !hasOwnTag(project, dg.triggerTag)) {
      pushDangling('datalink', `data_group:${dg.id}`, dg.triggerTag);
    }
  }
  if (project.rfid?.uidTargetTag && !hasOwnTag(project, project.rfid.uidTargetTag)) {
    pushDangling('security', 'rfid:uidTargetTag', project.rfid.uidTargetTag);
  }
  if (project.rfid?.cardPresentTag && !hasOwnTag(project, project.rfid.cardPresentTag)) {
    pushDangling('security', 'rfid:cardPresentTag', project.rfid.cardPresentTag);
  }
  for (const per of project.peripherals ?? []) {
    if (per.targetTagName && !hasOwnTag(project, per.targetTagName)) {
      pushDangling('operations', `peripheral:${per.id}`, per.targetTagName);
    }
  }
  for (const mt of project.cloudMonitor?.monitoredTags ?? []) {
    const tag = getOwnTag(project, mt.tagName);
    if (!tag) {
      pushDangling('datalink', 'cloud_monitor', mt.tagName);
    } else if (mt.allowRemoteWrite && (tag.access === 'RO' || tag.safetyClass === 'SIL3')) {
      findings.push({
        code: 'AUD-CLOUD-INTERLOCK',
        severity: 'CRITICAL',
        domain: 'security',
        target: `cloud_monitor:${mt.tagName}`,
        message: `Cloud platform data monitor allows remote write to ${tag.access === 'RO' ? 'read-only' : 'SIL3'} tag "${mt.tagName}".`,
        remediation: 'Disable allowRemoteWrite on RO/SIL3 tags in haiwell_cloud_monitor_configure.',
      });
    }
  }
  for (const aud of project.audioClips ?? []) {
    if (aud.triggerTag && !hasOwnTag(project, aud.triggerTag)) {
      pushDangling('operations', `audio:${aud.id}`, aud.triggerTag);
    }
  }
  const dataGroupIds = new Set((project.dataGroups ?? []).map((dg) => dg.id));
  for (const srv of project.dataReportingServers ?? []) {
    if (srv.enabled && !srv.tlsRequired && (srv.protocol === 'HTTP_REST' || srv.protocol === 'MQTT')) {
      findings.push({
        code: 'AUD-REPORTING-TLS',
        severity: 'HIGH',
        domain: 'datalink',
        target: `data_reporting_server:${srv.id}`,
        message: `Data reporting server "${srv.id}" pushes plant data over unencrypted ${srv.protocol}.`,
        remediation: 'Enable tlsRequired=true and use https:// or mqtts://.',
      });
    }
    for (const dgId of srv.dataGroupIds ?? []) {
      if (!dataGroupIds.has(dgId)) {
        pushDanglingRef('datalink', `data_reporting_server:${srv.id}`, 'data_group', dgId);
      }
    }
  }
  for (const cam of project.cameras ?? []) {
    if (cam.screenId && !screenIds.has(cam.screenId)) {
      pushDanglingRef('operations', `camera:${cam.id}`, 'screen', cam.screenId);
    }
  }
  if (project.transparentTunnel?.targetDeviceId && !deviceProtocols.has(project.transparentTunnel.targetDeviceId)) {
    pushDanglingRef('devices', 'transparent_tunnel', 'device', project.transparentTunnel.targetDeviceId);
  }
  const userGroupNames = new Set((project.security?.userGroups ?? []).map((g) => g.groupName));
  for (const card of project.rfid?.cards ?? []) {
    if (card.userGroup && !userGroupNames.has(card.userGroup)) {
      pushDanglingRef('security', `rfid_card:${card.cardUid}`, 'user_group', card.userGroup);
    }
  }
  for (const pou of project.pous ?? []) {
    for (const tn of pou.boundTags ?? []) {
      if (!hasOwnTag(project, tn)) pushDangling('iec61131', `pou:${pou.name}`, tn);
    }
  }

  // 7. Hardware compatibility check (official Haiwell /docs/RTSP): RTSP camera display requires PRO-series HMI or PC/IPC SCADA
  const nonProHardware = new Set<string>([
    'CLOUD_HMI_B7H',
    'CLOUD_HMI_B7',
    'CLOUD_HMI_B10',
    'CLOUD_HMI_C7',
    'CLOUD_HMI_C10',
    'CLOUD_HMI_A8',
    'CLOUD_BOX_CBOX',
  ]);
  if (nonProHardware.has(project.targetHardware)) {
    const rtspCameras = (project.cameras ?? []).filter((c) => c.protocol === 'RTSP');
    for (const cam of rtspCameras) {
      findings.push({
        code: 'AUD-HW-COMPAT-RTSP',
        severity: 'HIGH',
        domain: 'operations',
        target: `camera:${cam.id}`,
        message: `RTSP camera "${cam.name}" (${cam.id}) is not supported on ${project.targetHardware}. Official Haiwell documentation (/docs/RTSP) restricts RTSP camera playback to PRO-series HMIs (D7/D10/D15 PRO, A7/A10/A15 PRO) or PC/IPC SCADA.`,
        remediation: 'Remove RTSP cameras for non-PRO hardware or target PC_SCADA / IPC_SCADA / a PRO-series HMI.',
      });
    }
    for (const scr of project.screens) {
      if (scr.widgets.some((w) => w.type === 'CAMERA_VIEW') && rtspCameras.length === 0) {
        findings.push({
          code: 'AUD-HW-COMPAT-RTSP',
          severity: 'HIGH',
          domain: 'hmi',
          target: `screen:${scr.id}`,
          message: `Screen "${scr.name}" places a Camera display widget on ${project.targetHardware}. Official Haiwell documentation (/docs/RTSP) restricts RTSP Camera display to PRO-series HMIs or PC/IPC SCADA.`,
          remediation: 'Remove CAMERA_VIEW widget on non-PRO HMIs or upgrade targetHardware.',
        });
      }
    }
  }

  // Official Haiwell en.lng (A8SWITCHPLATFORMTIPS2): A8 does not support COM serial devices or printers
  if (project.targetHardware === 'CLOUD_HMI_A8') {
    for (const dev of project.devices) {
      if (dev.enabled && dev.transport === 'RTU') {
        findings.push({
          code: 'AUD-HW-COMPAT-A8',
          severity: 'HIGH',
          domain: 'devices',
          target: `device:${dev.id}`,
          message: `Serial RTU device "${dev.name}" (${dev.id}) is not supported on CLOUD_HMI_A8 (Haiwell A8 does not support COM serial devices or printers).`,
          remediation: 'Switch device transport to TCP/Ethernet or select a non-A8 targetHardware.',
        });
      }
    }
    for (const per of project.peripherals ?? []) {
      if (
        per.enabled &&
        (per.kind === 'PRINTER' ||
          per.kind === 'SERIAL_PORT' ||
          per.connection === 'SERIAL_RS232' ||
          per.connection === 'SERIAL_RS485')
      ) {
        findings.push({
          code: 'AUD-HW-COMPAT-A8',
          severity: 'HIGH',
          domain: 'operations',
          target: `peripheral:${per.id}`,
          message: `Peripheral "${per.name}" (${per.kind}/${per.connection}) is not supported on CLOUD_HMI_A8 (Haiwell A8 does not support COM devices or printers).`,
          remediation: 'Remove the printer/serial peripheral or target a supported HMI/SCADA platform.',
        });
      }
    }
    if (project.rfid?.enabled && project.rfid.transport === 'SERIAL_COM') {
      findings.push({
        code: 'AUD-HW-COMPAT-A8',
        severity: 'HIGH',
        domain: 'security',
        target: `rfid:${project.rfid.portOrHost}`,
        message: `Serial COM RFID reader (${project.rfid.portOrHost}) is not supported on CLOUD_HMI_A8 (Haiwell A8 does not support COM serial devices).`,
        remediation: 'Use USB_HID / NETWORK_TCP RFID transport or select a non-A8 targetHardware.',
      });
    }
  }

  // Official Haiwell en.lng (ERROR_AUDIO_PLAY_IPC): IPC does not support audio playing
  if (project.targetHardware === 'IPC_SCADA') {
    for (const aud of project.audioClips ?? []) {
      if (aud.enabled) {
        findings.push({
          code: 'AUD-HW-COMPAT-IPC-AUDIO',
          severity: 'HIGH',
          domain: 'operations',
          target: `audio:${aud.id}`,
          message: `Audio clip "${aud.name}" (${aud.id}) is enabled on IPC_SCADA, which does not support Haiwell audio playback.`,
          remediation: 'Disable/remove audio clips on IPC_SCADA or target a supported Cloud HMI / PC_SCADA platform.',
        });
      }
    }
  }

  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
  const high = findings.filter((f) => f.severity === 'HIGH').length;
  return {
    projectId: project.id,
    revision: project.revision,
    deploymentReady: critical === 0 && high === 0,
    counts: {
      total: findings.length,
      critical,
      high,
      medium: findings.filter((f) => f.severity === 'MEDIUM').length,
      low: findings.filter((f) => f.severity === 'LOW').length,
    },
    findings,
  };
}

function checkTagWriteSafety(
  project: HaiwellProject,
  tagName: string,
  value: unknown,
  confirmSafetyOverride: boolean
) {
  const tag = getOwnTag(project, tagName);
  if (!tag) return { ok: false as const, blockedBy: 'TAG_NOT_FOUND', message: `Tag "${tagName}" not found.` };
  if (tag.access === 'RO') {
    return {
      ok: false as const,
      blockedBy: 'READ_ONLY_GUARD',
      message: `Tag "${tag.name}" (${tag.address ?? tag.scope}) is read-only (RO).`,
    };
  }
  const typeCheck = validateTagValueForType(tag.dataType, value);
  if (!typeCheck.valid) {
    return { ok: false as const, blockedBy: typeCheck.code, message: typeCheck.error };
  }
  if (typeof typeCheck.normalizedValue === 'number') {
    if (tag.safeMin !== undefined && typeCheck.normalizedValue < tag.safeMin) {
      return {
        ok: false as const,
        blockedBy: 'SAFE_RANGE_MIN',
        message: `Rejected value ${typeCheck.normalizedValue} for "${tag.name}": below safeMin (${tag.safeMin}).`,
      };
    }
    if (tag.safeMax !== undefined && typeCheck.normalizedValue > tag.safeMax) {
      return {
        ok: false as const,
        blockedBy: 'SAFE_RANGE_MAX',
        message: `Rejected value ${typeCheck.normalizedValue} for "${tag.name}": above safeMax (${tag.safeMax}).`,
      };
    }
  }
  const isPhysicalPlcOutput =
    tag.scope === 'PLC' && /^(?:Y\d|AQ\d|%Q|Q\d|QW\d)/i.test((tag.address ?? '').trim());
  const effectiveRequiresInterlock =
    tag.requiresInterlock || (Boolean(project.security?.requireInterlockForOutputs) && isPhysicalPlcOutput);
  const interlockName = (tag as TagDefinition & { interlockTag?: string }).interlockTag || 'EStop_OK';
  const estop = getOwnTag(project, interlockName);
  if (effectiveRequiresInterlock && !estop) {
    return {
      ok: false as const,
      blockedBy: 'ESTOP_TAG_MISSING',
      message: `Write to "${tag.name}" blocked (fail-closed): required safety interlock tag "${interlockName}" is not defined in project.`,
    };
  }
  if (effectiveRequiresInterlock && estop && (estop.currentValue === false || estop.currentValue === 0)) {
    return {
      ok: false as const,
      blockedBy: 'ESTOP_INTERLOCK_ACTIVE',
      message: `Write to "${tag.name}" blocked: ${interlockName} is FALSE.`,
    };
  }
  if (effectiveRequiresInterlock && !confirmSafetyOverride) {
    return {
      ok: false as const,
      blockedBy: 'INTERLOCK_CONFIRMATION_REQUIRED',
      safetyClass: tag.safetyClass,
      message: `Tag "${tag.name}" (${tag.safetyClass}) requires confirmSafetyOverride=true before writing.`,
    };
  }
  return { ok: true as const, tag, normalizedValue: typeCheck.normalizedValue };
}

export const HAIWELL_TOOLS: HaiwellToolDefinition[] = [
  // =========================================================================
  // 1. PROJECT LIFECYCLE, SNAPSHOTS, SAFE DELETE & AUDIT
  // =========================================================================
  defineTool({
    name: 'haiwell_project_create',
    domain: 'project',
    haiwellFeature: 'Project Workspace & Target Hardware Setup',
    safetyTier: 'design',
    description:
      'Create a new Haiwell Cloud Scada 3.50.x (.hwdev) project targeting PC SCADA, Cloud HMI (C7/C10/B7/B7H/B10/A8, A7/A10/A15 PRO, D7/D10/D15 PRO), Cloud Box (CBOX), or IPC with resolution, network project port (8888), language, and security defaults.',
    inputSchema: z.object({
      id: z.string().regex(/^[a-z0-9_-]{3,48}$/, 'Use lowercase alphanumeric, dash, or underscore (3-48 chars)'),
      name: z.string().min(2).max(120),
      targetHardware: z
        .enum([
          'PC_SCADA',
          'CLOUD_HMI_C7',
          'CLOUD_HMI_C10',
          'CLOUD_HMI_B7',
          'CLOUD_HMI_B7H',
          'CLOUD_HMI_B10',
          'CLOUD_HMI_A8',
          'CLOUD_HMI_A7_PRO',
          'CLOUD_HMI_A10_PRO',
          'CLOUD_HMI_A15_PRO',
          'CLOUD_HMI_D7_PRO',
          'CLOUD_HMI_D10_PRO',
          'CLOUD_HMI_D15_PRO',
          'CLOUD_BOX_CBOX',
          'IPC_SCADA',
        ])
        .default('PC_SCADA'),
      width: z.number().int().min(320).max(3840).default(1280),
      height: z.number().int().min(240).max(2160).default(800),
      defaultLanguage: z.string().min(2).max(12).default('en-US'),
      cloudEnabled: z.boolean().default(true),
      networkProjectEnabled: z.boolean().default(true),
      networkProjectPort: z.number().int().min(1024).max(65535).default(8888),
      targetDownloadIp: z.string().max(64).optional(),
      startupScreenId: z.string().max(64).optional(),
      hwdevFileName: z.string().max(120).optional(),
      overwrite: z.boolean().default(false),
    }),
    sampleInput: {
      id: 'prj_pump_station_02',
      name: 'Municipal Booster Pump Station',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
      networkProjectEnabled: true,
      networkProjectPort: 8888,
    },
    handler: (input, store) => {
      if (!input.overwrite && store.listProjects().some((p) => p.id === input.id)) {
        throw new Error(
          `PROJECT_ALREADY_EXISTS: Project "${input.id}" already exists. Choose a new id or pass overwrite=true explicitly.`
        );
      }
      const now = new Date().toISOString();
      const hwdevFile = input.hwdevFileName
        ? input.hwdevFileName.endsWith('.hwdev')
          ? input.hwdevFileName
          : `${input.hwdevFileName}.hwdev`
        : `${input.id}.hwdev`;
      const project: HaiwellProject = {
        id: input.id,
        name: input.name,
        version: '1.0.0',
        revision: 0,
        targetHardware: input.targetHardware,
        resolution: { width: input.width, height: input.height },
        defaultLanguage: input.defaultLanguage,
        cloudEnabled: input.cloudEnabled,
        networkProjectEnabled: input.networkProjectEnabled,
        networkProjectPort: input.networkProjectPort,
        targetDownloadIp: input.targetDownloadIp,
        startupScreenId: input.startupScreenId,
        hwdevFileName: hwdevFile,
        createdAt: now,
        updatedAt: now,
        devices: [],
        transparentTunnel: null,
        tags: {},
        pous: [],
        screens: [],
        faceplates: [],
        scripts: [],
        eventTriggers: [],
        webhooks: [],
        alarms: [],
        alarmHistory: [],
        mqtt: {
          mode: 'BUILTIN_BROKER',
          brokerUri: 'mqtts://localhost:8883',
          clientId: `haiwell_${input.id}`,
          keepAliveSec: 60,
          cleanSession: true,
          tlsEnabled: true,
          sslBits: 128,
          proxyEnabled: false,
          bindings: [],
        },
        opcua: {
          role: 'SERVER',
          endpointUrl: `opc.tcp://localhost:4840/haiwell/${input.id}`,
          namespaceUri: `urn:haiwell:scada:${input.id}`,
          namespaceIndex: 2,
          securityPolicy: 'Basic256Sha256',
          securityMode: 'SignAndEncrypt',
          authMode: 'Username',
          publishingIntervalMs: 500,
          nodes: [],
        },
        recipes: [],
        trends: [],
        dataGroups: [],
        dataLinks: [],
        dataReportingServers: [],
        cloudMonitor: {
          enabled: input.cloudEnabled,
          platform: 'HAIWELL_CLOUD',
          machineCode: '',
          networkProjectPort: input.networkProjectPort,
          webScadaEnabled: input.cloudEnabled,
          mobileAppEnabled: input.cloudEnabled,
          remoteAlarmPushEnabled: input.cloudEnabled,
          monitoredTags: [],
        },
        schedules: [],
        reports: [],
        operationRecordPolicy: {
          enabled: true,
          recordLogins: true,
          recordVariableWrites: true,
          recordScreenChanges: true,
          recordRecipeTransfers: true,
          recordAlarmAcks: true,
          retentionDays: 180,
          maxRecords: 100000,
          storageTarget: 'LOCAL_SQLITE',
        },
        fonts: [
          {
            id: 'font_ms_sans',
            familyName: 'Microsoft Sans Serif',
            defaultSizePt: 12,
            weight: 'NORMAL',
            charset: 'LATIN_EXT',
            embedInHmiPackage: true,
          },
        ],
        rfid: {
          enabled: false,
          transport: 'USB_HID',
          portOrHost: 'USB0',
          autoLoginEnabled: false,
          autoLogoutOnRemoveSec: 30,
          cards: [],
        },
        shapeLibrary: [],
        peripherals: [],
        cameras: [],
        audioClips: [],
        translations: { [input.defaultLanguage]: {} },
        security: {
          sslBits: 128,
          abKeyEnabled: true,
          requireInterlockForOutputs: true,
          auditTrailEnabled: true,
          userGroups: [
            {
              groupName: 'Engineers',
              privilegeLevel: 15,
              canWriteTags: true,
              canAckAlarms: true,
              canTransferRecipes: true,
              canRemoteTunnel: true,
            },
          ],
        },
        auditLog: [],
      };
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'PROJECT_CREATE',
        target: project.id,
        outcome: 'ALLOWED',
        detail: `Created Haiwell project ${project.hwdevFileName} (${project.targetHardware} ${project.resolution.width}x${project.resolution.height}, netPort=${project.networkProjectPort}).`,
      });
      return {
        projectId: project.id,
        hwdevFileName: project.hwdevFileName,
        revision: project.revision,
        name: project.name,
        targetHardware: project.targetHardware,
        resolution: project.resolution,
        networkProjectEnabled: project.networkProjectEnabled,
        networkProjectPort: project.networkProjectPort,
      };
    },
  }),

  defineTool({
    name: 'haiwell_project_inspect',
    domain: 'project',
    haiwellFeature: 'Project Tree Inspection',
    safetyTier: 'read',
    description:
      'Return a compact, token-efficient snapshot of the Haiwell Cloud SCADA project tree including revision, devices, tags, POUs, screens, faceplates, scripts, triggers, webhooks, alarms, MQTT, OPC UA, recipes, trends, Data-Link, schedules, reports, and cameras.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      includeAllProjects: z.boolean().default(false),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, includeAllProjects: true },
    handler: (input, store) => {
      const p = store.getProject(input.projectId);
      return {
        project: {
          id: p.id,
          name: p.name,
          hwdevFileName: p.hwdevFileName,
          version: p.version,
          revision: p.revision,
          targetHardware: p.targetHardware,
          resolution: p.resolution,
          cloudEnabled: p.cloudEnabled,
          networkProjectEnabled: p.networkProjectEnabled,
          networkProjectPort: p.networkProjectPort,
          targetDownloadIp: p.targetDownloadIp,
          startupScreenId: p.startupScreenId,
          updatedAt: p.updatedAt,
        },
        tree: {
          devices: p.devices.map((d) => ({ id: d.id, name: d.name, protocol: d.protocol, transport: d.transport, stationId: d.stationId })),
          transparentTunnel: p.transparentTunnel,
          tagCount: Object.keys(p.tags).length,
          tagNames: Object.keys(p.tags),
          pous: p.pous.map((pou) => ({ id: pou.id, name: pou.name, language: pou.language, pouType: pou.pouType })),
          screens: p.screens.map((s) => ({ id: s.id, name: s.name, layoutStandard: s.layoutStandard, widgetCount: s.widgets.length })),
          faceplates: p.faceplates.map((f) => ({ id: f.id, name: f.name, placeholders: f.tagPlaceholders })),
          scripts: p.scripts.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger, validated: s.validated })),
          eventTriggers: p.eventTriggers.map((e) => ({ id: e.id, sourceTag: e.sourceTag, condition: e.condition, actionType: e.actionType })),
          webhooks: p.webhooks.map((w) => ({ id: w.id, name: w.name, url: w.url, enabled: w.enabled })),
          alarms: p.alarms.map((a) => ({ id: a.id, name: a.name, tagName: a.tagName, condition: a.condition, priority: a.priority })),
          mqtt: { mode: p.mqtt.mode, brokerUri: p.mqtt.brokerUri, tlsEnabled: p.mqtt.tlsEnabled, bindingCount: p.mqtt.bindings.length },
          opcua: { role: p.opcua.role, endpointUrl: p.opcua.endpointUrl, securityPolicy: p.opcua.securityPolicy, nodeCount: p.opcua.nodes.length },
          recipes: p.recipes.map((r) => ({ id: r.id, name: r.name, recordCount: r.records.length })),
          trends: p.trends.map((t) => ({ id: t.id, name: t.name, sampleIntervalMs: t.sampleIntervalMs, tagCount: t.tagNames.length })),
          dataGroups: (p.dataGroups ?? []).map((dg) => ({ id: dg.id, name: dg.name, tagCount: dg.tagNames.length, collectMode: dg.collectMode })),
          dataLinks: p.dataLinks.map((d) => ({ id: d.id, engine: d.engine, tableName: d.tableName })),
          dataReportingServers: (p.dataReportingServers ?? []).map((s) => ({ id: s.id, name: s.name, protocol: s.protocol, dataGroupCount: s.dataGroupIds.length, enabled: s.enabled })),
          cloudMonitor: {
            enabled: p.cloudMonitor?.enabled ?? false,
            platform: p.cloudMonitor?.platform ?? 'HAIWELL_CLOUD',
            machineCode: p.cloudMonitor?.machineCode ?? '',
            monitoredTagCount: p.cloudMonitor?.monitoredTags.length ?? 0,
          },
          schedules: p.schedules.map((s) => ({ id: s.id, cron: s.cron, actionType: s.actionType, enabled: s.enabled })),
          reports: p.reports.map((r) => ({ id: r.id, name: r.name, format: r.format })),
          operationRecordPolicy: p.operationRecordPolicy,
          fonts: (p.fonts ?? []).map((f) => ({ id: f.id, familyName: f.familyName, defaultSizePt: f.defaultSizePt, charset: f.charset })),
          rfid: { enabled: p.rfid?.enabled ?? false, transport: p.rfid?.transport ?? 'USB_HID', cardCount: p.rfid?.cards.length ?? 0 },
          shapeLibrary: (p.shapeLibrary ?? []).map((sh) => ({ id: sh.id, name: sh.name, category: sh.category, format: sh.format })),
          peripherals: (p.peripherals ?? []).map((per) => ({ id: per.id, name: per.name, kind: per.kind, connection: per.connection })),
          cameras: p.cameras.map((c) => ({ id: c.id, protocol: c.protocol, screenId: c.screenId })),
          audioClips: (p.audioClips ?? []).map((a) => ({ id: a.id, name: a.name, sourceType: a.sourceType, enabled: a.enabled })),
          languages: Object.keys(p.translations),
          security: { sslBits: p.security.sslBits, abKeyEnabled: p.security.abKeyEnabled, groupCount: p.security.userGroups.length },
        },
        ...(input.includeAllProjects ? { workspaceProjects: store.listProjects() } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_project_import_hwrun',
    domain: 'project',
    haiwellFeature: 'Brownfield .hwrun / recipe.db Unencrypted SQLite Importer',
    safetyTier: 'design',
    description:
      'Import an existing unencrypted Haiwell Cloud Scada .hwrun (e.g., Temporary/temp.hwrun) or recipe.db SQLite file into the MCP workspace—extracting devices, tags (auto-resolving cross-device duplicates), user screens (with optional excludeWindowIds), JS tasks (with Strict-ES5 diagnostics), and events in a single call.',
    inputSchema: z.object({
      filePath: z.string().min(3).max(500),
      projectId: z.string().regex(/^[a-z0-9_-]{3,48}$/),
      projectName: z.string().min(2).max(120).optional(),
      excludeWindowIds: z.array(z.number().int().min(0)).default([]),
      includeCommStatusTags: z.boolean().default(true),
      overwrite: z.boolean().default(false),
    }),
    sampleInput: {
      filePath: 'C:\\Haiwell\\Temporary\\temp.hwrun',
      projectId: 'prj_imported_01',
      excludeWindowIds: [5, 6, 7],
      includeCommStatusTags: true,
      overwrite: true,
    },
    handler: (input, store) => {
      if (!input.overwrite && store.listProjects().some((p) => p.id === input.projectId)) {
        throw new Error(
          `PROJECT_EXISTS: Project "${input.projectId}" already exists. Pass overwrite: true to replace it.`
        );
      }
      const res = importHwrunProject({
        filePath: input.filePath,
        projectId: input.projectId,
        projectName: input.projectName,
        excludeWindowIds: input.excludeWindowIds,
        includeCommStatusTags: input.includeCommStatusTags,
      });
      store.saveProject(res.project);
      return {
        imported: true,
        projectId: res.project.id,
        name: res.project.name,
        targetHardware: res.project.targetHardware,
        resolution: res.project.resolution,
        summary: res.summary,
      };
    },
  }),

  defineTool({
    name: 'haiwell_project_snapshot_rollback',
    domain: 'project',
    haiwellFeature: 'Atomic Project Checkpoints & Rollback',
    safetyTier: 'design',
    description:
      'Create named project checkpoints before risky multi-step agent edits, list snapshots, or atomically roll back to a known-good snapshot.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['CREATE', 'LIST', 'ROLLBACK']),
      label: z.string().max(80).default('agent-checkpoint'),
      snapshotId: z.string().optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'CREATE', label: 'pre-plc-refactor' },
    handler: (input, store) => {
      if (input.action === 'CREATE') {
        return { created: true, snapshot: store.createSnapshot(input.projectId, input.label) };
      }
      if (input.action === 'LIST') {
        return { projectId: input.projectId, snapshots: store.listSnapshots(input.projectId) };
      }
      if (!input.snapshotId) throw new Error('ROLLBACK requires snapshotId.');
      const restored = store.rollbackSnapshot(input.projectId, input.snapshotId);
      return { rolledBack: true, projectId: restored.id, revision: restored.revision, snapshotId: input.snapshotId };
    },
  }),

  defineTool({
    name: 'haiwell_entity_delete',
    domain: 'project',
    haiwellFeature: 'Referential-Integrity Protected Entity Deletion',
    safetyTier: 'design',
    description:
      'Safely remove any project entity (project, device, tag, pou, screen, widget, faceplate, script, event_trigger, webhook, alarm, mqtt_binding, opcua_node, recipe_group, trend, datalink, schedule, report, camera). Blocks deletion if dependent references exist unless cascade=true.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      entityType: z.enum([
        'project',
        'device',
        'tag',
        'pou',
        'screen',
        'widget',
        'faceplate',
        'script',
        'event_trigger',
        'webhook',
        'alarm',
        'mqtt_binding',
        'opcua_node',
        'recipe_group',
        'trend',
        'data_group',
        'datalink',
        'data_reporting_server',
        'schedule',
        'report',
        'font',
        'shape',
        'peripheral',
        'camera',
        'audio',
      ]),
      entityId: z.string().min(1),
      parentScreenId: z.string().optional(),
      cascade: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      entityType: 'tag',
      entityId: 'Supply_Temp_C',
      cascade: false,
    },
    handler: (input, store) => {
      if (input.entityType === 'project') {
        const deleted = store.deleteProject(input.entityId);
        return { deleted, entityType: 'project', entityId: input.entityId };
      }
      const project = store.getProject(input.projectId);

      if (input.entityType === 'tag') {
        if (!hasOwnTag(project, input.entityId)) throw new Error(`Tag "${input.entityId}" not found.`);
        const deps = store.findTagDependents(project, input.entityId);
        if (deps.length > 0 && !input.cascade) {
          return {
            deleted: false,
            blockedBy: 'REFERENTIAL_INTEGRITY',
            dependents: deps,
            message: `Cannot delete tag "${input.entityId}" because ${deps.length} object(s) reference it. Pass cascade=true to prune references.`,
          };
        }
        delete project.tags[input.entityId];
        if (input.cascade) {
          project.alarms = project.alarms.filter((a) => a.tagName !== input.entityId);
          project.opcua.nodes = project.opcua.nodes.filter((n) => n.tagName !== input.entityId);
          project.mqtt.bindings = project.mqtt.bindings
            .map((b) => ({ ...b, tags: b.tags.filter((t) => t !== input.entityId) }))
            .filter((b) => b.tags.length > 0);
          project.screens.forEach((s) => {
            s.widgets = s.widgets.filter((w) => w.tagName !== input.entityId);
            if (s.pipes) {
              s.pipes.forEach((p) => {
                if (p.flowTagName === input.entityId) {
                  delete p.flowTagName;
                }
              });
            }
          });
          project.recipes = project.recipes
            .map((r) => ({
              ...r,
              tagNames: r.tagNames.filter((t) => t !== input.entityId),
              records: r.records.map((rec) => {
                const nextValues = { ...rec.values };
                delete nextValues[input.entityId];
                return { ...rec, values: nextValues };
              }),
            }))
            .filter((r) => r.tagNames.length > 0);
          project.trends = project.trends
            .map((tr) => ({ ...tr, tagNames: tr.tagNames.filter((t) => t !== input.entityId) }))
            .filter((tr) => tr.tagNames.length > 0);
          project.dataLinks = project.dataLinks
            .map((dl) => ({
              ...dl,
              columnMappings: dl.columnMappings.filter((c) => c.tagName !== input.entityId),
            }))
            .filter((dl) => dl.columnMappings.length > 0);
          project.reports = project.reports
            .map((rp) => ({ ...rp, columns: rp.columns.filter((c) => c.tagName !== input.entityId) }))
            .filter((rp) => rp.columns.length > 0);
          project.eventTriggers = project.eventTriggers.filter(
            (ev) => ev.sourceTag !== input.entityId && !(ev.actionType === 'WRITE_TAG' && ev.targetId === input.entityId)
          );
          project.schedules = project.schedules.filter(
            (sch) => !(sch.actionType === 'WRITE_TAG' && sch.targetId === input.entityId)
          );
          project.pous = project.pous.map((pou) => ({
            ...pou,
            boundTags: pou.boundTags.filter((t) => t !== input.entityId),
          }));
          project.scripts = project.scripts.filter(
            (sc) => sc.triggerTag !== input.entityId && !sc.referencedTags.includes(input.entityId)
          );
          project.dataGroups = (project.dataGroups ?? [])
            .map((dg) => ({
              ...dg,
              tagNames: dg.tagNames.filter((t) => t !== input.entityId),
              triggerTag: dg.triggerTag === input.entityId ? undefined : dg.triggerTag,
            }))
            .filter((dg) => dg.tagNames.length > 0);
          if (project.rfid?.uidTargetTag === input.entityId) project.rfid.uidTargetTag = undefined;
          if (project.rfid?.cardPresentTag === input.entityId) project.rfid.cardPresentTag = undefined;
          project.peripherals = (project.peripherals ?? []).map((per) =>
            per.targetTagName === input.entityId ? { ...per, targetTagName: undefined } : per
          );
          if (project.cloudMonitor) {
            project.cloudMonitor.monitoredTags = project.cloudMonitor.monitoredTags.filter(
              (m) => m.tagName !== input.entityId
            );
          }
          project.audioClips = (project.audioClips ?? []).map((aud) =>
            aud.triggerTag === input.entityId ? { ...aud, triggerTag: undefined } : aud
          );
          project.faceplates = (project.faceplates ?? []).map((fp) => ({
            ...fp,
            widgets: fp.widgets.filter((w) => w.tagName !== input.entityId),
          }));
          const tagTokenRe = new RegExp(`\\{\\{\\s*${input.entityId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
          project.webhooks = (project.webhooks ?? []).map((wh) => ({
            ...wh,
            payloadTemplate: wh.payloadTemplate.replace(tagTokenRe, ''),
          }));
        }
        store.saveProject(project);
        return { deleted: true, entityType: 'tag', entityId: input.entityId, cascadedDependents: deps };
      }

      if (input.entityType === 'device') {
        const boundTags = Object.values(project.tags)
          .filter((t) => t.deviceId === input.entityId)
          .map((t) => t.name);
        if (boundTags.length > 0 && !input.cascade) {
          return {
            deleted: false,
            blockedBy: 'REFERENTIAL_INTEGRITY',
            dependents: boundTags,
            message: `Device "${input.entityId}" has ${boundTags.length} bound tag(s). Pass cascade=true to detach.`,
          };
        }
        const before = project.devices.length;
        project.devices = project.devices.filter((d) => d.id !== input.entityId);
        if (project.devices.length === before) throw new Error(`Device "${input.entityId}" not found.`);
        if (input.cascade) {
          for (const t of boundTags) {
            project.tags[t].deviceId = undefined;
            project.tags[t].scope = 'INTERNAL';
          }
          if (project.transparentTunnel?.targetDeviceId === input.entityId) {
            project.transparentTunnel = null;
          }
        }
        store.saveProject(project);
        return { deleted: true, entityType: 'device', entityId: input.entityId };
      }

      if (input.entityType === 'screen') {
        if (!project.screens.some((s) => s.id === input.entityId)) {
          throw new Error(`screen "${input.entityId}" not found.`);
        }
        const screenDeps: string[] = [];
        if (project.startupScreenId === input.entityId) {
          screenDeps.push('project:startupScreenId');
        }
        for (const s of project.screens) {
          if (s.id === input.entityId) continue;
          for (const w of s.widgets) {
            if (w.targetScreenId === input.entityId) screenDeps.push(`screen:${s.id}/widget:${w.id}`);
          }
        }
        for (const cam of project.cameras) {
          if (cam.screenId === input.entityId) screenDeps.push(`camera:${cam.id}`);
        }
        for (const ev of project.eventTriggers) {
          if (ev.actionType === 'OPEN_SCREEN' && ev.targetId === input.entityId) {
            screenDeps.push(`event_trigger:${ev.id}`);
          }
        }
        if (screenDeps.length > 0 && !input.cascade) {
          return {
            deleted: false,
            blockedBy: 'REFERENTIAL_INTEGRITY',
            dependents: screenDeps,
            message: `Cannot delete screen "${input.entityId}" because ${screenDeps.length} reference(s) point to it. Pass cascade=true to prune.`,
          };
        }
        project.screens = project.screens.filter((s) => s.id !== input.entityId);
        if (input.cascade) {
          if (project.startupScreenId === input.entityId) {
            project.startupScreenId = project.screens[0]?.id;
          }
          for (const s of project.screens) {
            s.widgets = s.widgets.map((w) =>
              w.targetScreenId === input.entityId ? { ...w, targetScreenId: undefined } : w
            );
          }
          project.cameras = project.cameras.map((c) =>
            c.screenId === input.entityId ? { ...c, screenId: undefined } : c
          );
          project.eventTriggers = project.eventTriggers.filter(
            (ev) => !(ev.actionType === 'OPEN_SCREEN' && ev.targetId === input.entityId)
          );
        }
        store.saveProject(project);
        return { deleted: true, entityType: 'screen', entityId: input.entityId, cascadedDependents: screenDeps, revision: project.revision };
      }

      if (input.entityType === 'widget') {
        const scr = project.screens.find((s) => s.id === input.parentScreenId);
        if (!scr) throw new Error(`Widget deletion requires valid parentScreenId.`);
        const pipeDeps = (scr.pipes ?? [])
          .filter((p) => p.fromWidgetId === input.entityId || p.toWidgetId === input.entityId)
          .map((p) => `pipe:${p.id}`);
        if (pipeDeps.length > 0 && !input.cascade) {
          return {
            deleted: false,
            blockedBy: 'REFERENTIAL_INTEGRITY',
            dependents: pipeDeps,
            message: `Cannot delete widget "${input.entityId}" because ${pipeDeps.length} pipe(s) connect to it. Pass cascade=true to prune.`,
          };
        }
        const before = scr.widgets.length;
        scr.widgets = scr.widgets.filter((w) => w.id !== input.entityId);
        if (scr.widgets.length === before) throw new Error(`Widget "${input.entityId}" not found.`);
        if (input.cascade && scr.pipes) {
          scr.pipes = scr.pipes.filter((p) => p.fromWidgetId !== input.entityId && p.toWidgetId !== input.entityId);
        }
        store.saveProject(project);
        return { deleted: true, entityType: 'widget', entityId: input.entityId, cascadedDependents: pipeDeps };
      }

      const removeById = <T extends { id: string }>(arr: T[]): T[] => {
        const next = arr.filter((x) => x.id !== input.entityId);
        if (next.length === arr.length) throw new Error(`${input.entityType} "${input.entityId}" not found.`);
        return next;
      };

      const checkEntityDeps = (deps: string[]) => {
        if (deps.length > 0 && !input.cascade) {
          return {
            deleted: false,
            blockedBy: 'REFERENTIAL_INTEGRITY',
            dependents: deps,
            message: `Cannot delete ${input.entityType} "${input.entityId}" because ${deps.length} object(s) reference it. Pass cascade=true to prune.`,
          };
        }
        return null;
      };

      switch (input.entityType) {
        case 'pou': project.pous = removeById(project.pous); break;
        case 'faceplate': project.faceplates = removeById(project.faceplates); break;
        case 'script': {
          const targetScript = project.scripts.find((s) => s.id === input.entityId);
          if (!targetScript) throw new Error(`script "${input.entityId}" not found.`);
          const deps = [
            ...project.eventTriggers
              .filter((ev) => ev.actionType === 'RUN_SCRIPT' && (ev.targetId === input.entityId || ev.targetId === targetScript.name))
              .map((ev) => `event_trigger:${ev.id}`),
            ...project.schedules
              .filter((sch) => sch.actionType === 'RUN_SCRIPT' && (sch.targetId === input.entityId || sch.targetId === targetScript.name))
              .map((sch) => `schedule:${sch.id}`),
          ];
          const blocked = checkEntityDeps(deps);
          if (blocked) return blocked;
          project.scripts = removeById(project.scripts);
          if (input.cascade) {
            project.eventTriggers = project.eventTriggers.filter(
              (ev) => !(ev.actionType === 'RUN_SCRIPT' && (ev.targetId === input.entityId || ev.targetId === targetScript.name))
            );
            project.schedules = project.schedules.filter(
              (sch) => !(sch.actionType === 'RUN_SCRIPT' && (sch.targetId === input.entityId || sch.targetId === targetScript.name))
            );
          }
          break;
        }
        case 'event_trigger': project.eventTriggers = removeById(project.eventTriggers); break;
        case 'webhook': {
          const deps = project.eventTriggers
            .filter((ev) => ev.actionType === 'SEND_WEBHOOK' && ev.targetId === input.entityId)
            .map((ev) => `event_trigger:${ev.id}`);
          const blocked = checkEntityDeps(deps);
          if (blocked) return blocked;
          project.webhooks = removeById(project.webhooks);
          if (input.cascade) {
            project.eventTriggers = project.eventTriggers.filter(
              (ev) => !(ev.actionType === 'SEND_WEBHOOK' && ev.targetId === input.entityId)
            );
          }
          break;
        }
        case 'alarm': {
          project.alarms = removeById(project.alarms);
          if (input.cascade) {
            project.alarmHistory = project.alarmHistory.filter((h) => h.alarmId !== input.entityId);
          }
          break;
        }
        case 'mqtt_binding': project.mqtt.bindings = removeById(project.mqtt.bindings); break;
        case 'opcua_node': {
          const before = project.opcua.nodes.length;
          project.opcua.nodes = project.opcua.nodes.filter((n) => n.nodeId !== input.entityId);
          if (project.opcua.nodes.length === before) throw new Error(`OPC UA node "${input.entityId}" not found.`);
          break;
        }
        case 'recipe_group': {
          const prefix = `${input.entityId}:`;
          const deps = [
            ...project.eventTriggers
              .filter((ev) => ev.actionType === 'DOWNLOAD_RECIPE' && ev.targetId.startsWith(prefix))
              .map((ev) => `event_trigger:${ev.id}`),
            ...project.schedules
              .filter((sch) => sch.actionType === 'DOWNLOAD_RECIPE' && sch.targetId.startsWith(prefix))
              .map((sch) => `schedule:${sch.id}`),
          ];
          const blocked = checkEntityDeps(deps);
          if (blocked) return blocked;
          project.recipes = removeById(project.recipes);
          if (input.cascade) {
            project.eventTriggers = project.eventTriggers.filter(
              (ev) => !(ev.actionType === 'DOWNLOAD_RECIPE' && ev.targetId.startsWith(prefix))
            );
            project.schedules = project.schedules.filter(
              (sch) => !(sch.actionType === 'DOWNLOAD_RECIPE' && sch.targetId.startsWith(prefix))
            );
          }
          break;
        }
        case 'trend': project.trends = removeById(project.trends); break;
        case 'data_group': {
          const deps = (project.dataReportingServers ?? [])
            .filter((srv) => srv.dataGroupIds.includes(input.entityId))
            .map((srv) => `data_reporting_server:${srv.id}`);
          const blocked = checkEntityDeps(deps);
          if (blocked) return blocked;
          project.dataGroups = removeById(project.dataGroups);
          if (input.cascade) {
            project.dataReportingServers = (project.dataReportingServers ?? [])
              .map((srv) => ({
                ...srv,
                dataGroupIds: srv.dataGroupIds.filter((id) => id !== input.entityId),
              }))
              .filter((srv) => srv.dataGroupIds.length > 0);
          }
          break;
        }
        case 'datalink': project.dataLinks = removeById(project.dataLinks); break;
        case 'data_reporting_server': project.dataReportingServers = removeById(project.dataReportingServers); break;
        case 'schedule': project.schedules = removeById(project.schedules); break;
        case 'report': {
          const deps = project.schedules
            .filter((sch) => sch.actionType === 'EXPORT_REPORT' && sch.targetId === input.entityId)
            .map((sch) => `schedule:${sch.id}`);
          const blocked = checkEntityDeps(deps);
          if (blocked) return blocked;
          project.reports = removeById(project.reports);
          if (input.cascade) {
            project.schedules = project.schedules.filter(
              (sch) => !(sch.actionType === 'EXPORT_REPORT' && sch.targetId === input.entityId)
            );
          }
          break;
        }
        case 'font': project.fonts = removeById(project.fonts); break;
        case 'shape': project.shapeLibrary = removeById(project.shapeLibrary); break;
        case 'peripheral': project.peripherals = removeById(project.peripherals); break;
        case 'camera': project.cameras = removeById(project.cameras); break;
        case 'audio': project.audioClips = removeById(project.audioClips); break;
      }
      store.saveProject(project);
      return { deleted: true, entityType: 'entityType' in input ? input.entityType : 'unknown', entityId: input.entityId, revision: project.revision };
    },
  }),

  defineTool({
    name: 'haiwell_project_audit_safety',
    domain: 'project',
    haiwellFeature: 'Pre-Deployment Industrial Safety & Integrity Audit',
    safetyTier: 'read',
    description:
      'Run full safety audit across multi-word PLC register overlaps, orphan devices, SIL2/SIL3 interlocks, IEC 61131-3 ST/LD/FBD POUs, HMI collisions/touch-targets/nav links, JS scripts, MQTT TLS, OPC UA encryption, and A/B Key policy.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID },
    handler: (input, store) => runProjectSafetyAudit(store.getProject(input.projectId)),
  }),

  defineTool({
    name: 'haiwell_project_export',
    domain: 'project',
    haiwellFeature: 'Full Project Bundle Export (.hwsp.json, CSV, SVG, ST, JS, OPC UA NodeSet2)',
    safetyTier: 'read',
    description:
      'Export all project artifacts in a deterministic machine-readable bundle including project JSON, tag CSV, HMI SVG blueprints, IEC 61131-3 ST POUs, Haiwell JS scripts, MQTT bindings, and OPC UA NodeSet2 XML.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      includeArtifacts: z
        .array(
          z.enum([
            'hwdev_manifest',
            'project_json',
            'haiwell_variables_csv',
            'tags_csv',
            'opcua_xml',
            'mqtt_json',
            'hmi_svg',
            'pous',
            'scripts',
            'hwexport_xml',
          ])
        )
        .optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      includeArtifacts: ['haiwell_variables_csv', 'opcua_xml', 'mqtt_json'],
    },
    handler: (input, store) => {
      const bundle = buildProjectExportBundle(store.getProject(input.projectId));
      if (!input.includeArtifacts || input.includeArtifacts.length === 0) return bundle;
      const selected: Record<string, unknown> = {};
      if (input.includeArtifacts.includes('hwdev_manifest'))
        selected['project.hwdev.manifest.json'] = bundle.artifacts['project.hwdev.manifest.json'];
      if (input.includeArtifacts.includes('project_json')) selected['project.hwsp.json'] = bundle.artifacts['project.hwsp.json'];
      if (input.includeArtifacts.includes('haiwell_variables_csv')) {
        selected['haiwell_variables_import.csv'] = bundle.artifacts['haiwell_variables_import.csv'];
        selected['haiwell_internal_variables.csv'] = bundle.artifacts['haiwell_internal_variables.csv'];
      }
      if (input.includeArtifacts.includes('tags_csv')) selected['tags.csv'] = bundle.artifacts['tags.csv'];
      if (input.includeArtifacts.includes('opcua_xml')) selected['opcua/nodeset2.xml'] = bundle.artifacts['opcua/nodeset2.xml'];
      if (input.includeArtifacts.includes('mqtt_json')) selected['mqtt/bindings.json'] = bundle.artifacts['mqtt/bindings.json'];
      if (input.includeArtifacts.includes('hmi_svg')) selected['screens/svg'] = bundle.artifacts['screens/svg'];
      if (input.includeArtifacts.includes('pous')) selected['plc/pous'] = bundle.artifacts['plc/pous'];
      if (input.includeArtifacts.includes('scripts')) selected['scripts/js'] = bundle.artifacts['scripts/js'];
      if (input.includeArtifacts.includes('hwexport_xml')) selected['project.hwExport'] = bundle.artifacts['project.hwExport'];
      return { ...bundle, artifacts: selected };
    },
  }),

  defineTool({
    name: 'haiwell_project_export_hwexport',
    domain: 'project',
    haiwellFeature: 'Native Haiwell Cloud Scada .hwExport XML Export (Zero-UIA Import)',
    safetyTier: 'read',
    description:
      'Compile validated HMI screens and their bound PLC/Internal variables directly into an official Haiwell Cloud Scada 3.50.x <HwExportModel> .hwExport XML file for native Project(P) -> Import(I) without Windows UI automation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenIds: z.array(z.string().min(1)).optional(),
      startWindowId: z.number().int().min(1).max(9999).default(5),
      language: z.enum(['en_0', 'zh_0']).default('en_0'),
      variableFullNameOverrides: z.record(z.string(), z.string()).optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      startWindowId: 5,
      language: 'en_0',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const compiled = compileProjectToHwExport(project, {
        screenIds: input.screenIds,
        startWindowId: input.startWindowId,
        language: input.language,
        variableFullNameOverrides: input.variableFullNameOverrides,
      });
      return {
        fileName: compiled.fileName,
        format: 'HAIWELL_NATIVE_HWEXPORT_XML',
        importInstructions:
          'In Haiwell Cloud Scada 3.50.x, open your .hwdev project, expand Display in the left Project Browser, right-click "Project display" -> Import, and select the .hwExport file.',
        screensExported: compiled.screensExported,
        widgetsExported: compiled.widgetsExported,
        variablesBound: compiled.variablesBound,
        warnings: compiled.warnings,
        xml: compiled.xml,
      };
    },
  }),

  // =========================================================================
  // 2. MULTI-VENDOR PLC DRIVERS, ADDRESS MAP & CLOUD TUNNEL
  // =========================================================================
  defineTool({
    name: 'haiwell_device_add',
    domain: 'devices',
    haiwellFeature: 'Multi-Vendor PLC & Fieldbus Driver Configuration',
    safetyTier: 'design',
    description:
      'Add or update a PLC/field device communication driver (Haiwell PLC TCP/RTU, Modbus TCP/RTU, Siemens S7-1200/1500, Mitsubishi MC 3E, Omron FINS, Allen-Bradley EIP, Delta, Schneider, BACnet/IP).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,40}$/),
      name: z.string().min(2).max(100),
      protocol: z.enum(PLC_PROTOCOLS),
      transport: z.enum(['TCP', 'RTU', 'CLOUD_TUNNEL']).default('TCP'),
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).default(502),
      serialPort: z.string().optional(),
      baudRate: z.number().int().default(9600),
      dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
      stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
      parity: z.enum(['NONE', 'EVEN', 'ODD']).default('NONE'),
      stationId: z.number().int().min(1).max(247).default(1),
      pollIntervalMs: z.number().int().min(20).max(60000).default(250),
      timeoutMs: z.number().int().min(100).max(30000).default(1500),
      byteOrder: z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA']).default('CDAB'),
      addressOffset: z.enum(['BASE_0', 'BASE_1']).optional(),
      blockLength: z.number().int().min(1).max(125).optional(),
      normalSpeedMs: z.number().int().min(20).max(60000).optional(),
      highSpeedMs: z.number().int().min(10).max(60000).optional(),
      lowSpeedMs: z.number().int().min(50).max(300000).optional(),
      batchWriteSupported: z.boolean().optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'plc_siemens_02',
      name: 'Siemens S7-1200 Cooling Tower PLC',
      protocol: 'SIEMENS_S7_1200',
      transport: 'TCP',
      host: '192.168.1.60',
      port: 102,
      stationId: 1,
    },
    handler: (input, store) => {
      if (input.transport === 'TCP' && !input.host) {
        throw new Error('TCP transport requires a host IP or hostname.');
      }
      if (input.transport === 'RTU' && !input.serialPort) {
        throw new Error('RTU transport requires serialPort (e.g., COM1, COM2, or /dev/ttyUSB0).');
      }
      const project = store.getProject(input.projectId);
      if (input.transport === 'RTU' && input.serialPort) {
        const normPort = input.serialPort.trim().toUpperCase();
        const peers = project.devices.filter(
          (d) => d.id !== input.id && d.enabled && d.transport === 'RTU' && d.serialPort?.trim().toUpperCase() === normPort
        );
        for (const peer of peers) {
          if (peer.stationId === input.stationId) {
            throw new Error(
              `RS485_DUPLICATE_SLAVE_ID: Station ID ${input.stationId} on ${normPort} is already used by device "${peer.name}" (${peer.id}).`
            );
          }
          if (
            peer.baudRate !== input.baudRate ||
            peer.dataBits !== input.dataBits ||
            peer.parity !== input.parity ||
            peer.stopBits !== input.stopBits
          ) {
            throw new Error(
              `RS485_FRAMING_MISMATCH: Serial bus ${normPort} uses ${peer.baudRate}-${peer.dataBits}-${peer.parity}-${peer.stopBits} (device "${peer.name}"), but "${input.name}" requested ${input.baudRate}-${input.dataBits}-${input.parity}-${input.stopBits}. Unify framing across all RS-485 daisy-chain slaves.`
            );
          }
        }
      }
      const cfg = {
        id: input.id,
        name: input.name,
        protocol: input.protocol,
        transport: input.transport,
        host: input.host,
        port: input.port,
        serialPort: input.serialPort,
        baudRate: input.baudRate,
        dataBits: input.dataBits,
        stopBits: input.stopBits,
        parity: input.parity,
        stationId: input.stationId,
        pollIntervalMs: input.pollIntervalMs,
        timeoutMs: input.timeoutMs,
        retryCount: 3,
        byteOrder: input.byteOrder,
        addressOffset: input.addressOffset,
        blockLength: input.blockLength,
        normalSpeedMs: input.normalSpeedMs,
        highSpeedMs: input.highSpeedMs,
        lowSpeedMs: input.lowSpeedMs,
        batchWriteSupported: input.batchWriteSupported,
        enabled: true,
      };
      const idx = project.devices.findIndex((d) => d.id === cfg.id);
      if (idx >= 0) project.devices[idx] = cfg;
      else project.devices.push(cfg);
      store.saveProject(project);
      return { upserted: true, device: cfg, totalDevices: project.devices.length };
    },
  }),

  defineTool({
    name: 'haiwell_device_validate_address',
    domain: 'devices',
    haiwellFeature: 'Multi-Vendor PLC Register & Modbus Offset Translator',
    safetyTier: 'read',
    description:
      'Validate registers for Haiwell PLC (X/Y/M/T/C/S/AI/AQ/V/TV/CV/SV), Haiwell native Modbus (0X/1X/3X/4X/W), standard Modbus (40001/HR:0), Siemens S7 (I0.0/DB1.DBD0), Mitsubishi MC (D100/X0F), Omron FINS (DM100/CIO0.00), BACnet (AI:0), or Allen-Bradley EIP symbolic tags.',
    inputSchema: z.object({
      protocol: z.enum(PLC_PROTOCOLS).default('HAIWELL_PLC_TCP'),
      addresses: z.array(z.string().min(1)).min(1).max(200),
      addressOffset: z.enum(['BASE_0', 'BASE_1']).default('BASE_0'),
      includeAreaTable: z.boolean().default(false),
    }),
    sampleInput: {
      protocol: 'HAIWELL_PLC_TCP',
      addresses: ['X0', 'Y0', 'M100', 'AI0', 'AQ2', 'V100', 'V100.3', 'SV10'],
    },
    handler: (input) => {
      const results = input.addresses.map((addr) =>
        validatePlcAddress(input.protocol, addr, { addressOffset: input.addressOffset })
      );
      return {
        protocol: input.protocol,
        addressOffset: input.addressOffset,
        allValid: results.every((r) => r.valid),
        results,
        ...(input.includeAreaTable
          ? { haiwellRegisterMap: HAIWELL_REGISTER_MAP, vendorModbusMaps: VENDOR_MODBUS_REGISTER_MAPS }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_cloud_transparent_tunnel',
    domain: 'devices',
    haiwellFeature: 'Cloud Transparent Transmission (Remote PLC Program/Debug)',
    safetyTier: 'control_guarded',
    description:
      'Configure Haiwell Cloud Transparent Transmission via CBOX/Cloud HMI for remote PLC upload, download, online debug, or firmware update with mandatory A/B Key and SSL interlock checks.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      enabled: z.boolean(),
      cboxSerialNumber: z.string().min(4).max(64),
      targetDeviceId: z.string().min(2),
      abKeyRequired: z.boolean().default(true),
      allowedOperations: z.array(z.enum(['UPLOAD', 'DOWNLOAD', 'ONLINE_DEBUG', 'FIRMWARE_UPDATE'])).min(1),
      sessionTimeoutSec: z.number().int().min(60).max(7200).default(900),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      enabled: true,
      cboxSerialNumber: 'CBOX-S7-904218',
      targetDeviceId: 'plc_chiller_01',
      abKeyRequired: true,
      allowedOperations: ['UPLOAD', 'ONLINE_DEBUG'],
      sessionTimeoutSec: 600,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (!project.devices.some((d) => d.id === input.targetDeviceId)) {
        throw new Error(`Target device "${input.targetDeviceId}" does not exist in project "${project.id}".`);
      }
      if (input.enabled && !input.abKeyRequired) {
        throw new Error('SAFETY_BLOCK: Enabling remote Cloud Transparent Transmission requires abKeyRequired=true.');
      }
      project.transparentTunnel = {
        enabled: input.enabled,
        cboxSerialNumber: input.cboxSerialNumber,
        targetDeviceId: input.targetDeviceId,
        abKeyRequired: input.abKeyRequired,
        allowedOperations: input.allowedOperations,
        sessionTimeoutSec: input.sessionTimeoutSec,
        sslBits: project.security.sslBits,
      };
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'CLOUD_TUNNEL_CONFIG',
        target: input.targetDeviceId,
        outcome: 'ALLOWED',
        detail: `Transparent tunnel ${input.enabled ? 'ENABLED' : 'DISABLED'} ops=${input.allowedOperations.join(',')}`,
      });
      return { configured: true, transparentTunnel: project.transparentTunnel };
    },
  }),

  // =========================================================================
  // 3. TAG DATABASE, MULTI-WORD OVERLAP GUARD & ATOMIC BATCH I/O
  // =========================================================================
  defineTool({
    name: 'haiwell_tag_upsert_batch',
    domain: 'tags',
    haiwellFeature: 'Variable / Tag Database Management (Multi-Vendor & Overlap Checked)',
    safetyTier: 'design',
    description:
      'Batch upsert PLC, internal, system, or cloud-shared variables. Validates deviceId existence, multi-vendor PLC addressing, dataType-to-register-kind compatibility, linear scaling, binary initial values, and 32-bit/64-bit multi-word register overlap collisions.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      autoPrefixOnDeviceConflict: z.boolean().default(false),
      allowDeviceReassign: z.boolean().default(false),
      tags: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{1,63}$/),
            scope: z.enum(['PLC', 'INTERNAL', 'SYSTEM', 'CLOUD_SHARED']).default('PLC'),
            deviceId: z.string().optional(),
            address: z.string().optional(),
            dataType: z.enum(['BOOL', 'INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64', 'STRING', 'BCD16', 'BCD32']),
            access: z.enum(['RO', 'RW', 'WO']).default('RW'),
            unit: z.string().max(16).optional(),
            description: z.string().max(200).optional(),
            scaling: z
              .object({
                rawMin: z.number(),
                rawMax: z.number(),
                engMin: z.number(),
                engMax: z.number(),
                clamp: z.boolean().default(true),
              })
              .optional(),
            deadband: z.number().min(0).optional(),
            safeMin: z.number().optional(),
            safeMax: z.number().optional(),
            safetyClass: z.enum(['SIL0', 'SIL1', 'SIL2', 'SIL3']).default('SIL0'),
            requiresInterlock: z.boolean().default(false),
            alwaysCollect: z.boolean().optional(),
            collectFrequency: z.enum(['HIGH', 'NORMAL', 'LOW']).optional(),
            initialValue: z.union([z.number(), z.boolean(), z.string()]).optional(),
          })
        )
        .min(1)
        .max(200),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      tags: [
        {
          name: 'Flow_Rate_LPM',
          scope: 'PLC',
          deviceId: 'plc_chiller_01',
          address: 'AI4',
          dataType: 'FLOAT32',
          access: 'RO',
          unit: 'L/min',
          scaling: { rawMin: 0, rawMax: 32000, engMin: 0, engMax: 500, clamp: true },
          safeMin: 0,
          safeMax: 500,
          initialValue: 185.4,
        },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const deviceProtocols = new Map<string, PlcDriverProtocol>(project.devices.map((d) => [d.id, d.protocol]));
      const deviceNames = new Map<string, string>(project.devices.map((d) => [d.id, d.name]));
      const deviceOffsets = new Map<string, 'BASE_0' | 'BASE_1'>(
        project.devices.map((d) => [d.id, d.addressOffset ?? 'BASE_0'])
      );
      const now = new Date().toISOString();
      const errors: { tag: string; code: string; error: string }[] = [];
      const upsertedSet = new Set<string>();
      const autoPrefixedTags: { requestedName: string; assignedName: string; deviceId: string }[] = [];

      // Candidate map so multi-word overlaps are caught BEFORE committing
      const candidateTags = { ...project.tags };

      for (const t of input.tags) {
        let effectiveName = t.name;
        if (FORBIDDEN_PROTO_KEYS.has(effectiveName) || Object.prototype.hasOwnProperty.call(Object.prototype, effectiveName)) {
          errors.push({
            tag: effectiveName,
            code: 'RESERVED_IDENTIFIER',
            error: `Tag name "${effectiveName}" is a reserved JavaScript Object.prototype identifier.`,
          });
          continue;
        }
        const existingCandidate = Object.prototype.hasOwnProperty.call(candidateTags, effectiveName)
          ? candidateTags[effectiveName]
          : undefined;
        const incomingScopeOwner = t.scope === 'PLC' ? `PLC:${t.deviceId ?? ''}` : `SCOPE:${t.scope}`;
        const existingScopeOwner = existingCandidate
          ? existingCandidate.scope === 'PLC'
            ? `PLC:${existingCandidate.deviceId ?? ''}`
            : `SCOPE:${existingCandidate.scope}`
          : undefined;

        if (existingCandidate && existingScopeOwner !== incomingScopeOwner && !input.allowDeviceReassign) {
          if (input.autoPrefixOnDeviceConflict && t.scope === 'PLC' && t.deviceId) {
            const devPrefix = (deviceNames.get(t.deviceId) ?? t.deviceId).replace(/[^A-Za-z0-9_]/g, '_');
            let prefixed = `${devPrefix}_${t.name}`.slice(0, 64);
            let n = 2;
            while (Object.prototype.hasOwnProperty.call(candidateTags, prefixed)) {
              prefixed = `${devPrefix}_${t.name}_${n++}`.slice(0, 64);
            }
            autoPrefixedTags.push({ requestedName: t.name, assignedName: prefixed, deviceId: t.deviceId });
            effectiveName = prefixed;
          } else {
            errors.push({
              tag: t.name,
              code: 'DUPLICATE_TAG_NAME_CROSS_DEVICE',
              error: `Tag name "${t.name}" is already bound to ${existingScopeOwner}; cannot silently overwrite from ${incomingScopeOwner}. Use a device-prefixed name, pass autoPrefixOnDeviceConflict: true, or pass allowDeviceReassign: true.`,
            });
            continue;
          }
        }
        let modbus0: number | undefined;
        let modbus1: number | undefined;
        let normalizedAddr = t.address;
        let effectiveAccess = t.access;

        if (t.scope === 'PLC') {
          if (!t.deviceId || !deviceProtocols.has(t.deviceId)) {
            errors.push({
              tag: t.name,
              code: 'UNKNOWN_DEVICE_ID',
              error: `PLC tag "${t.name}" references unknown deviceId "${t.deviceId ?? ''}". Add device first.`,
            });
            continue;
          }
          if (!t.address) {
            errors.push({ tag: t.name, code: 'MISSING_ADDRESS', error: `PLC tag "${t.name}" requires an address.` });
            continue;
          }
          const protocol = deviceProtocols.get(t.deviceId)!;
          const addressOffset = deviceOffsets.get(t.deviceId) ?? 'BASE_0';
          const parsed = validatePlcAddress(protocol, t.address, { addressOffset });
          if (!parsed.valid) {
            errors.push({ tag: t.name, code: 'INVALID_PLC_ADDRESS', error: `${parsed.error} ${parsed.hint}` });
            continue;
          }
          if (parsed.readOnly && t.access !== 'RO') {
            errors.push({
              tag: t.name,
              code: 'READ_ONLY_REGISTER',
              error: `Hardware register ${parsed.normalized} is read-only; access must be RO.`,
            });
            continue;
          }
          if (parsed.kind === 'BIT' && t.dataType !== 'BOOL') {
            errors.push({
              tag: t.name,
              code: 'REGISTER_TYPE_MISMATCH',
              error: `Bit register ${parsed.normalized} can only be bound to BOOL, not ${t.dataType}.`,
            });
            continue;
          }
          if (parsed.kind === 'WORD' && t.dataType === 'BOOL') {
            errors.push({
              tag: t.name,
              code: 'REGISTER_TYPE_MISMATCH',
              error: `WORD register ${parsed.normalized} cannot bind BOOL without bit suffix (e.g., ${parsed.normalized}.0).`,
            });
            continue;
          }
          const spanCheck = validateAddressSpanBounds(parsed, t.dataType);
          if (!spanCheck.valid) {
            errors.push({
              tag: t.name,
              code: 'ADDRESS_SPAN_OVERFLOW',
              error: spanCheck.error,
            });
            continue;
          }
          modbus0 = parsed.modbusOffset0Based;
          modbus1 = parsed.modbusAddress1Based;
          normalizedAddr = parsed.normalized;
          if (parsed.readOnly) effectiveAccess = 'RO';
        }

        if (t.scaling && t.scaling.rawMin === t.scaling.rawMax) {
          errors.push({ tag: t.name, code: 'INVALID_SCALING', error: 'scaling.rawMin and scaling.rawMax cannot be equal (division by zero).' });
          continue;
        }
        if (t.safeMin !== undefined && t.safeMax !== undefined && t.safeMin > t.safeMax) {
          errors.push({ tag: t.name, code: 'INVALID_RANGE', error: `safeMin (${t.safeMin}) cannot exceed safeMax (${t.safeMax}).` });
          continue;
        }

        const defaultVal = t.dataType === 'BOOL' ? false : t.dataType === 'STRING' ? '' : 0;
        const existingTag = getOwnTag(project, effectiveName);
        const proposedInit = t.initialValue ?? existingTag?.currentValue ?? defaultVal;
        const valCheck = validateTagValueForType(t.dataType, proposedInit);
        if (!valCheck.valid) {
          errors.push({ tag: effectiveName, code: valCheck.code, error: valCheck.error });
          continue;
        }
        if (t.initialValue !== undefined && typeof valCheck.normalizedValue === 'number') {
          if (t.safeMin !== undefined && valCheck.normalizedValue < t.safeMin) {
            errors.push({
              tag: effectiveName,
              code: 'INITIAL_VALUE_OUT_OF_SAFE_RANGE',
              error: `initialValue (${valCheck.normalizedValue}) is below safeMin (${t.safeMin}).`,
            });
            continue;
          }
          if (t.safeMax !== undefined && valCheck.normalizedValue > t.safeMax) {
            errors.push({
              tag: effectiveName,
              code: 'INITIAL_VALUE_OUT_OF_SAFE_RANGE',
              error: `initialValue (${valCheck.normalizedValue}) exceeds safeMax (${t.safeMax}).`,
            });
            continue;
          }
        }

        const candidate = {
          name: effectiveName,
          scope: t.scope,
          deviceId: t.deviceId,
          address: normalizedAddr,
          modbusOffset0Based: modbus0,
          modbusAddress1Based: modbus1,
          wordSpan: getWordSpanForType(t.dataType),
          dataType: t.dataType,
          access: effectiveAccess,
          unit: t.unit,
          description: t.description,
          scaling: t.scaling,
          deadband: t.deadband,
          safeMin: t.safeMin,
          safeMax: t.safeMax,
          safetyClass: t.safetyClass,
          requiresInterlock: t.requiresInterlock || t.safetyClass === 'SIL2' || t.safetyClass === 'SIL3',
          alwaysCollect: t.alwaysCollect ?? existingTag?.alwaysCollect,
          collectFrequency: t.collectFrequency ?? existingTag?.collectFrequency,
          currentValue: valCheck.normalizedValue,
          quality: 'GOOD' as const,
          updatedAt: now,
        };

        const testMap = { ...candidateTags, [effectiveName]: candidate };
        const overlaps = detectWordOverlapConflicts(testMap, deviceProtocols, deviceOffsets).filter(
          (c) => c.tagA === effectiveName || c.tagB === effectiveName
        );
        if (overlaps.length > 0) {
          errors.push({
            tag: effectiveName,
            code: 'REGISTER_OVERLAP_COLLISION',
            error: overlaps[0].reason,
          });
          continue;
        }

        candidateTags[effectiveName] = candidate;
        upsertedSet.add(effectiveName);
      }

      const upserted = Array.from(upsertedSet);
      if (upserted.length > 0) {
        project.tags = candidateTags;
        store.saveProject(project);
      }

      return {
        upsertedCount: upserted.length,
        upserted,
        ...(autoPrefixedTags.length > 0 ? { autoPrefixedTags } : {}),
        rejectedCount: errors.length,
        errors,
        totalTags: Object.keys(project.tags).length,
      };
    },
  }),

  defineTool({
    name: 'haiwell_tag_query',
    domain: 'tags',
    haiwellFeature: 'Tag Database Query & Telemetry Snapshot',
    safetyTier: 'read',
    description:
      'Query SCADA tags with lightweight machine-readable projections filtered by deviceId, scope, prefix, safetyClass, or dataType.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      prefix: z.string().optional(),
      deviceId: z.string().optional(),
      scope: z.enum(['PLC', 'INTERNAL', 'SYSTEM', 'CLOUD_SHARED']).optional(),
      safetyClass: z.enum(['SIL0', 'SIL1', 'SIL2', 'SIL3']).optional(),
      dataType: z.enum(['BOOL', 'INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64', 'STRING', 'BCD16', 'BCD32']).optional(),
      compact: z.boolean().default(true),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, compact: true },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const filtered = Object.values(project.tags).filter((t) => {
        if (input.prefix && !t.name.toLowerCase().startsWith(input.prefix.toLowerCase())) return false;
        if (input.deviceId && t.deviceId !== input.deviceId) return false;
        if (input.scope && t.scope !== input.scope) return false;
        if (input.safetyClass && t.safetyClass !== input.safetyClass) return false;
        if (input.dataType && t.dataType !== input.dataType) return false;
        return true;
      });
      return {
        count: filtered.length,
        tags: input.compact
          ? filtered.map((t) => ({
              name: t.name,
              address: t.address ?? t.scope,
              type: t.dataType,
              access: t.access,
              value: t.currentValue,
              unit: t.unit,
              safety: t.safetyClass,
              interlock: t.requiresInterlock,
            }))
          : filtered,
      };
    },
  }),

  defineTool({
    name: 'haiwell_tag_read_write',
    domain: 'tags',
    haiwellFeature: 'Low-Latency Telemetry Read & Safety-Interlocked Write Primitive',
    safetyTier: 'control_guarded',
    description:
      'Execute granular telemetry reads (with optional raw ADC linear scaling preview) or strictly type/range/interlock-guarded control writes. Rejects RO writes, NaN/overflow, out-of-range values, and unconfirmed SIL interlocks.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      operation: z.enum(['READ', 'WRITE']),
      tagName: z.string().min(1),
      value: z.union([z.number(), z.boolean(), z.string()]).optional(),
      rawAdcInput: z.number().optional(),
      dryRun: z.boolean().default(false),
      confirmSafetyOverride: z.boolean().default(false),
      reason: z.string().max(200).optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      operation: 'WRITE',
      tagName: 'Chiller_Setpoint_C',
      value: 8.5,
      dryRun: true,
      reason: 'Agent setpoint verification',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const tag = getOwnTag(project, input.tagName);
      if (!tag) throw new Error(`Tag "${input.tagName}" not found in project "${project.id}".`);

      if (input.operation === 'READ') {
        const scaledPreview =
          input.rawAdcInput !== undefined && tag.scaling
            ? applyLinearScaling(input.rawAdcInput, tag.scaling)
            : undefined;
        return {
          tagName: tag.name,
          value: tag.currentValue,
          ...(scaledPreview !== undefined ? { scaledFromRawAdc: scaledPreview } : {}),
          unit: tag.unit,
          dataType: tag.dataType,
          quality: tag.quality,
          address: tag.address,
          modbusOffset0Based: tag.modbusOffset0Based,
          updatedAt: tag.updatedAt,
        };
      }

      if (input.value === undefined) throw new Error('WRITE operation requires an explicit "value".');

      const guard = checkTagWriteSafety(project, input.tagName, input.value, input.confirmSafetyOverride);
      if (!guard.ok) {
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'TAG_WRITE',
          target: tag.name,
          outcome: 'BLOCKED',
          detail: `${guard.blockedBy}: ${guard.message}`,
        });
        return { written: false, ...guard };
      }

      const previousValue = tag.currentValue;
      if (input.dryRun) {
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'TAG_WRITE_DRY_RUN',
          target: tag.name,
          outcome: 'SIMULATED',
          detail: `Dry-run ${previousValue} -> ${guard.normalizedValue} (${input.reason ?? 'no reason'})`,
        });
        return {
          written: false,
          dryRun: true,
          wouldPassGuards: true,
          tagName: tag.name,
          previousValue,
          proposedValue: guard.normalizedValue,
        };
      }

      tag.previousValue = previousValue;
      tag.currentValue = guard.normalizedValue;
      tag.updatedAt = new Date().toISOString();
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'TAG_WRITE',
        target: tag.name,
        outcome: 'ALLOWED',
        detail: `${previousValue} -> ${guard.normalizedValue} (${input.reason ?? 'agent control'})`,
      });
      return {
        written: true,
        tagName: tag.name,
        previousValue,
        currentValue: tag.currentValue,
        updatedAt: tag.updatedAt,
      };
    },
  }),

  defineTool({
    name: 'haiwell_tag_batch_io',
    domain: 'tags',
    haiwellFeature: 'Atomic All-or-Nothing Multi-Tag Telemetry Read & Control Write',
    safetyTier: 'control_guarded',
    description:
      'High-throughput batch telemetry READ across multiple tags or atomic all-or-nothing guarded WRITE (if ANY tag fails RO/type/range/E-Stop/interlock checks, ZERO tags are mutated).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      operation: z.enum(['READ', 'WRITE']),
      tagNames: z.array(z.string()).optional(),
      writes: z
        .array(
          z.object({
            tagName: z.string().min(1),
            value: z.union([z.number(), z.boolean(), z.string()]),
          })
        )
        .optional(),
      dryRun: z.boolean().default(true),
      confirmSafetyOverride: z.boolean().default(false),
      reason: z.string().max(200).optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      operation: 'READ',
      tagNames: ['EStop_OK', 'Supply_Temp_C', 'Chiller_Setpoint_C', 'Pump1_Run_Cmd'],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.operation === 'READ') {
        const names = input.tagNames ?? Object.keys(project.tags);
        const values: Record<string, unknown> = {};
        const missing: string[] = [];
        for (const n of names) {
          const t = getOwnTag(project, n);
          if (!t) missing.push(n);
          else values[n] = { value: t.currentValue, unit: t.unit, quality: t.quality, type: t.dataType };
        }
        return { count: Object.keys(values).length, values, missing };
      }

      if (!input.writes || input.writes.length === 0) {
        throw new Error('Batch WRITE requires non-empty writes array.');
      }

      // Phase 1: pre-flight ALL writes atomically
      const rejections: { tagName: string; blockedBy: string; message: string }[] = [];
      const validated: { tagName: string; normalizedValue: number | boolean | string; previousValue: number | boolean | string }[] = [];

      for (const w of input.writes) {
        const check = checkTagWriteSafety(project, w.tagName, w.value, input.confirmSafetyOverride);
        if (!check.ok) {
          rejections.push({ tagName: w.tagName, blockedBy: check.blockedBy, message: check.message });
        } else {
          validated.push({
            tagName: w.tagName,
            normalizedValue: check.normalizedValue,
            previousValue: check.tag.currentValue,
          });
        }
      }

      if (rejections.length > 0) {
        return {
          atomicCommitted: false,
          writtenCount: 0,
          rejections,
          message: 'Atomic batch write aborted: zero tags were modified.',
        };
      }

      if (input.dryRun) {
        return { atomicCommitted: false, dryRun: true, wouldPassGuards: true, plannedCount: validated.length, planned: validated };
      }

      // Phase 2: commit all
      const now = new Date().toISOString();
      for (const item of validated) {
        const t = project.tags[item.tagName];
        t.previousValue = t.currentValue;
        t.currentValue = item.normalizedValue;
        t.updatedAt = now;
      }
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'TAG_BATCH_WRITE',
        target: validated.map((v) => v.tagName).join(','),
        outcome: 'ALLOWED',
        detail: `Atomically wrote ${validated.length} tags (${input.reason ?? 'batch control'}).`,
      });
      return { atomicCommitted: true, writtenCount: validated.length, committed: validated };
    },
  }),

  // =========================================================================
  // 4. IEC 61131-3 PLC LOGIC VALIDATION, POU MANAGEMENT & TRANSPILATION
  // =========================================================================
  defineTool({
    name: 'haiwell_iec61131_validate',
    domain: 'iec61131',
    haiwellFeature: 'Hardened IEC 61131-3 Validator (ST / LD / FBD)',
    safetyTier: 'read',
    description:
      'Strictly validate IEC 61131-3 Structured Text (ST), Ladder Diagram (LD JSON graph), or Function Block Diagram (FBD JSON network) against runtime safety rules: multi-line/single-line blocks, ARRAYs, condition var resolution, unguarded division, unbounded WHILE/REPEAT watchdog hazards, REAL exact equality, CASE/ELSE completeness, VAR_INPUT/%I writes, implicit narrowing, LD double-coil hazards, and FBD cycle detection.',
    inputSchema: z.object({
      language: z.enum(['ST', 'LD', 'FBD']).default('ST'),
      pouName: z.string().default('Main'),
      source: z.string().min(1),
    }),
    sampleInput: {
      language: 'ST',
      pouName: 'PumpSafetyInterlock',
      source:
        'PROGRAM PumpSafetyInterlock\nVAR_INPUT\n  EStop_OK AT %IX0.0 : BOOL;\n  FlowRate : REAL;\nEND_VAR\nVAR_OUTPUT\n  PumpCmd AT %QX0.0 : BOOL;\nEND_VAR\nIF NOT EStop_OK THEN\n  PumpCmd := FALSE;\nELSIF FlowRate > 15.0 THEN\n  PumpCmd := TRUE;\nEND_IF;\nEND_PROGRAM',
    },
    handler: (input) => {
      if (input.language === 'ST') return validateStructuredText(input.source);
      if (input.language === 'LD') return validateLadderGraph(input.pouName, input.source);
      return validateFbdNetwork(input.pouName, input.source);
    },
  }),

  defineTool({
    name: 'haiwell_iec61131_pou_save',
    domain: 'iec61131',
    haiwellFeature: 'IEC 61131-3 POU Registration & Tag Binding',
    safetyTier: 'design',
    description:
      'Validate and persist an IEC 61131-3 POU (ST, LD, or FBD) into the Haiwell project. Automatically rejects saving if any ERROR-level IEC 61131-3 violation exists.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(64),
      language: z.enum(['ST', 'LD', 'FBD']).default('ST'),
      source: z.string().min(1),
      boundTags: z.array(z.string()).default([]),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'pou_lead_lag',
      name: 'LeadLagPump',
      language: 'ST',
      source:
        'PROGRAM LeadLagPump\nVAR_INPUT\n  Auto_Mode_Sel : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Pump1_Run_Cmd : BOOL;\nEND_VAR\nIF Auto_Mode_Sel THEN\n  Pump1_Run_Cmd := TRUE;\nEND_IF;\nEND_PROGRAM',
      boundTags: ['Auto_Mode_Sel', 'Pump1_Run_Cmd'],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const validation =
        input.language === 'ST'
          ? validateStructuredText(input.source)
          : input.language === 'LD'
            ? validateLadderGraph(input.name, input.source)
            : validateFbdNetwork(input.name, input.source);

      if (!validation.valid) {
        return { saved: false, reason: 'IEC_61131_3_VALIDATION_FAILED', validation };
      }

      const missingTags = input.boundTags.filter((t) => !hasOwnTag(project, t));
      const pou = {
        id: input.id,
        name: validation.pouName ?? input.name,
        language: input.language,
        pouType: validation.pouType ?? 'PROGRAM',
        source: input.source,
        boundTags: input.boundTags,
        validatedAt: new Date().toISOString(),
        diagnostics: validation.diagnostics,
      };
      const idx = project.pous.findIndex((p) => p.id === pou.id);
      if (idx >= 0) project.pous[idx] = pou;
      else project.pous.push(pou);
      store.saveProject(project);
      return { saved: true, pou, missingBoundTags: missingTags, validationSummary: validation.summary };
    },
  }),

  defineTool({
    name: 'haiwell_iec61131_transpile_js',
    domain: 'iec61131',
    haiwellFeature: 'IEC 61131-3 ST to Haiwell SCADA JavaScript Transpiler',
    safetyTier: 'design',
    description:
      'Transpile validated IEC 61131-3 Structured Text (including IF/CASE/FOR/LIMIT/SEL) into watchdog-safe Haiwell Cloud SCADA JavaScript and optionally register as a cyclic SCADA script.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      source: z.string().min(1),
      tagBindings: z.record(z.string(), z.string()).default({}),
      apiStyle: z.enum(['TAG_API', 'HAIWELL_NATIVE_350']).default('HAIWELL_NATIVE_350'),
      registerScriptId: z.string().optional(),
      cyclicIntervalMs: z.number().int().min(100).max(60000).default(1000),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      source:
        'PROGRAM DeltaCalc\nVAR_INPUT\n  Supply_Temp_C : REAL;\n  Return_Temp_C : REAL;\nEND_VAR\nVAR_OUTPUT\n  Plant_DeltaT_C : REAL;\nEND_VAR\nPlant_DeltaT_C := Return_Temp_C - Supply_Temp_C;\nEND_PROGRAM',
    },
    handler: (input, store) => {
      const result = transpileStToHaiwellJs(input.source, input.tagBindings, { apiStyle: input.apiStyle });
      if (!result.success || !result.jsCode) {
        return { transpiled: false, validation: result.validation };
      }
      if (input.registerScriptId) {
        const project = store.getProject(input.projectId);
        const scriptCheck = validateHaiwellScript(result.jsCode, project.tags, {
          trigger: 'CYCLIC',
          intervalMs: input.cyclicIntervalMs,
          targetHardware: project.targetHardware,
        });
        if (!scriptCheck.valid) {
          return {
            transpiled: true,
            registered: false,
            jsCode: result.jsCode,
            scriptValidation: scriptCheck,
            message: 'Transpiled JS failed SCADA script validation (e.g., undeclared tag or RO write); script was NOT registered.',
          };
        }
        const entry = {
          id: input.registerScriptId,
          name: result.validation.pouName ?? input.registerScriptId,
          trigger: 'CYCLIC' as const,
          intervalMs: input.cyclicIntervalMs,
          code: result.jsCode,
          referencedTags: scriptCheck.referencedTags,
          validated: true,
          updatedAt: new Date().toISOString(),
        };
        const idx = project.scripts.findIndex((s) => s.id === entry.id);
        if (idx >= 0) project.scripts[idx] = entry;
        else project.scripts.push(entry);
        store.saveProject(project);
        return { transpiled: true, registered: true, registeredScript: entry, scriptValidation: scriptCheck };
      }
      return { transpiled: true, jsCode: result.jsCode, validationSummary: result.validation.summary };
    },
  }),

  // =========================================================================
  // 5. AUTOMATED ISA-101 HMI LAYOUTS & REUSABLE FACEPLATES
  // =========================================================================
  defineTool({
    name: 'haiwell_hmi_screen_generate',
    domain: 'hmi',
    haiwellFeature: 'Automated ISA-101 HMI Screen & Responsive Layout Generator',
    safetyTier: 'design',
    description:
      'Generate a collision-free Haiwell Cloud SCADA / Cloud HMI screen using 2D occupancy auto-layout (zero silent drops), touch-target >=44px checks, navigation verification, and optional SVG export.',
    inputSchema: z
      .object({
        projectId: z.string().default(DEFAULT_PROJECT_ID),
        screenId: z.string().regex(/^[a-z0-9_-]{2,48}$/),
        name: z.string().min(2).max(100),
        width: z.number().int().min(320).max(3840).default(1280),
        height: z.number().int().min(240).max(2160).default(800),
        layoutStandard: z
          .enum(['ISA_101_HIGH_PERFORMANCE', 'STANDARD_INDUSTRIAL', 'MOBILE_UNIFIED'])
          .default('ISA_101_HIGH_PERFORMANCE'),
        columns: z.number().int().min(1).max(8).default(4),
        includeAlarmBanner: z.boolean().default(true),
        includeNavBar: z.boolean().default(true),
        items: z
          .array(
            z.object({
              id: z.string().optional(),
              type: z.enum(WIDGET_TYPES),
              label: z.string().min(1).max(80),
              tagName: z.string().optional(),
              writeEnabled: z.boolean().default(false),
              targetScreenId: z.string().optional(),
              visualRole: z.enum(VISUAL_ROLES).optional(),
              unit: z.string().optional(),
              min: z.number().optional(),
              max: z.number().optional(),
              colSpan: z.number().int().min(1).max(8).default(1),
              rowSpan: z.number().int().min(1).max(3).default(1),
            })
          )
          .min(1)
          .optional(),
        sections: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string().min(1).max(80),
              columns: z.number().int().min(1).max(6).default(2),
              colSpan: z.number().int().min(1).max(4).default(1),
              items: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    type: z.enum(WIDGET_TYPES),
                    label: z.string().min(1).max(80),
                    tagName: z.string().optional(),
                    writeEnabled: z.boolean().default(false),
                    targetScreenId: z.string().optional(),
                    visualRole: z.enum(VISUAL_ROLES).optional(),
                    unit: z.string().optional(),
                    min: z.number().optional(),
                    max: z.number().optional(),
                    colSpan: z.number().int().min(1).max(6).default(1),
                    rowSpan: z.number().int().min(1).max(3).default(1),
                  })
                )
                .min(1),
            })
          )
          .min(1)
          .optional(),
        returnSvg: z.boolean().default(false),
      })
      .refine((d) => (d.items && d.items.length > 0) || (d.sections && d.sections.length > 0), {
        message: 'Provide either non-empty items or non-empty sections.',
      }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      screenId: 'scr_pump_detail',
      name: 'Pump Loop Control',
      columns: 3,
      items: [
        { type: 'PUMP', label: 'Primary Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { type: 'NUMERIC_DISPLAY', label: 'Supply Temp', tagName: 'Supply_Temp_C', unit: '°C' },
        { type: 'BAR_GRAPH', label: 'Bypass Valve', tagName: 'Valve_Position_Pct', unit: '%', min: 0, max: 100 },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const { screen, overflowWidgets } = generateAutoLayoutScreenDetailed(input);
      const screenIds = new Set([...project.screens.map((s) => s.id), screen.id]);
      const validation = validateHmiScreen(screen, project.tags, {
        knownScreenIds: screenIds,
        targetHardware: project.targetHardware,
      });
      const idx = project.screens.findIndex((s) => s.id === screen.id);
      if (idx >= 0) project.screens[idx] = screen;
      else project.screens.push(screen);
      store.saveProject(project);
      return {
        generated: true,
        overflowWidgets,
        screen,
        validation: {
          ...validation,
          valid: validation.valid && overflowWidgets.length === 0,
        },
        ...(input.returnSvg ? { svg: renderScreenToSvg(screen, project.tags) } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_widget_upsert',
    domain: 'hmi',
    haiwellFeature: 'Granular HMI Widget Placement, Touch-Target & Collision Check',
    safetyTier: 'design',
    description:
      'Add or update an individual HMI control widget on an existing Haiwell screen, validating bounds, collisions, touch-target dimensions, navigation links, and tag access rights.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().min(1),
      widget: z.object({
        id: z.string().min(1),
        type: z.enum(WIDGET_TYPES),
        label: z.string().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(16),
        height: z.number().int().min(16),
        tagName: z.string().optional(),
        writeEnabled: z.boolean().default(false),
        targetScreenId: z.string().optional(),
        parentGroupId: z.string().optional(),
        visualRole: z.enum(VISUAL_ROLES).optional(),
        unit: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        precision: z.number().int().min(0).max(6).optional(),
      }),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      screenId: 'scr_chiller_overview',
      widget: {
        id: 'w_deltat_readout',
        type: 'NUMERIC_DISPLAY',
        label: 'Plant Delta-T',
        x: 20,
        y: 350,
        width: 280,
        height: 90,
        tagName: 'Plant_DeltaT_C',
        unit: '°C',
      },
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = project.screens.find((s) => s.id === input.screenId);
      if (!screen) throw new Error(`Screen "${input.screenId}" not found.`);
      const idx = screen.widgets.findIndex((w) => w.id === input.widget.id);
      if (idx >= 0) screen.widgets[idx] = input.widget;
      else screen.widgets.push(input.widget);
      const validation = validateHmiScreen(screen, project.tags, {
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
      });
      store.saveProject(project);
      return { upserted: true, screenId: screen.id, widgetCount: screen.widgets.length, validation };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_faceplate_manage',
    domain: 'hmi',
    haiwellFeature: 'Reusable Parameterized HMI Faceplate Templates',
    safetyTier: 'design',
    description:
      'Define reusable Haiwell HMI faceplate templates with {{PLACEHOLDER}} tag bindings or instantiate a faceplate onto a target screen with collision and tag validation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['DEFINE', 'INSTANTIATE', 'LIST']),
      faceplateId: z.string().optional(),
      name: z.string().optional(),
      width: z.number().int().min(40).default(240),
      height: z.number().int().min(40).default(120),
      tagPlaceholders: z.array(z.string()).default([]),
      widgets: z
        .array(
          z.object({
            type: z.enum(WIDGET_TYPES),
            label: z.string().min(1),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(16),
            height: z.number().int().min(16),
            tagName: z.string().optional(),
            writeEnabled: z.boolean().default(false),
          })
        )
        .optional(),
      targetScreenId: z.string().optional(),
      instanceId: z.string().optional(),
      originX: z.number().int().min(0).default(20),
      originY: z.number().int().min(0).default(460),
      tagPrefix: z.string().default('Pump1'),
      tagOverrides: z.record(z.string(), z.string()).default({}),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      action: 'LIST',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'LIST') {
        return { count: project.faceplates.length, faceplates: project.faceplates };
      }
      if (input.action === 'DEFINE') {
        if (!input.faceplateId || !input.name || !input.widgets?.length) {
          throw new Error('DEFINE requires faceplateId, name, and widgets.');
        }
        const tpl = {
          id: input.faceplateId,
          name: input.name,
          width: input.width,
          height: input.height,
          tagPlaceholders: input.tagPlaceholders,
          widgets: input.widgets,
        };
        const idx = project.faceplates.findIndex((f) => f.id === tpl.id);
        if (idx >= 0) project.faceplates[idx] = tpl;
        else project.faceplates.push(tpl);
        store.saveProject(project);
        return { defined: true, faceplate: tpl };
      }
      const tpl = project.faceplates.find((f) => f.id === input.faceplateId);
      if (!tpl) throw new Error(`Faceplate "${input.faceplateId}" not found.`);
      const scr = project.screens.find((s) => s.id === input.targetScreenId);
      if (!scr) throw new Error(`Target screen "${input.targetScreenId}" not found.`);
      const instId = input.instanceId ?? `${tpl.id}_${Date.now()}`;
      const expanded = instantiateFaceplate(tpl, instId, input.originX, input.originY, input.tagPrefix, input.tagOverrides);
      scr.widgets.push(...expanded);
      const validation = validateHmiScreen(scr, project.tags, {
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
      });
      store.saveProject(project);
      return { instantiated: true, addedWidgets: expanded, validation };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_screen_render_svg',
    domain: 'hmi',
    haiwellFeature: 'Headless Vector SVG HMI Blueprint Generator',
    safetyTier: 'read',
    description:
      'Render any configured Haiwell HMI screen into a deterministic SVG blueprint with current tag bindings and geometry metadata.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().default('scr_chiller_overview'),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, screenId: 'scr_chiller_overview' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = project.screens.find((s) => s.id === input.screenId);
      if (!screen) throw new Error(`Screen "${input.screenId}" not found.`);
      return {
        screenId: screen.id,
        name: screen.name,
        dimensions: { width: screen.width, height: screen.height },
        svg: renderScreenToSvg(screen, project.tags),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_toolbox_catalog',
    domain: 'hmi',
    haiwellFeature: 'Haiwell Graphics Library Catalog & Modal Property Schema',
    safetyTier: 'read',
    description:
      'Return the verified machine-readable Haiwell Cloud SCADA Develop HMI component toolbox (display, control, P&ID equipment with port geometry, min touch dimensions, allowed PLC data types, documented modal Property Setting dialog fields, and live-calibration metadata for numbered Graphics library packs).',
    inputSchema: z.object({
      category: z
        .enum(['ALL', 'DISPLAY', 'CONTROL', 'PID_EQUIPMENT', 'CHART_HISTORIAN', 'ALARM_RECIPE', 'NAVIGATION'])
        .default('ALL'),
    }),
    sampleInput: { category: 'PID_EQUIPMENT' },
    handler: (input) => {
      const styled = getToolboxComponentsWithStyle();
      const items =
        input.category === 'ALL'
          ? styled
          : styled.filter((c) => c.category === input.category);
      return {
        count: items.length,
        gridSnapPx: 8,
        minTouchPx: 48,
        graphicsLibraryPanelTitle: 'Graphics library',
        graphicsLibraryCategories: HAIWELL_GRAPHICS_LIBRARY_CATALOG,
        graphicsLibraryMetadata: HAIWELL_GRAPHICS_LIBRARY_METADATA,
        components: items,
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_pid_compile',
    domain: 'hmi',
    haiwellFeature: 'Semantic P&ID Process Flow Graph -> Collision-Free HMI Compiler',
    safetyTier: 'design',
    description:
      'Compile a declarative P&ID process flow graph (equipment nodes + directed fluid pipes, including recirculation return loops) into an 8px-snapped, collision-free HMI screen with exact 0px port-connected orthogonal pipelines, auto-attached telemetry callouts, ASCII occupancy map, and SVG blueprint—eliminating pixel guesswork and drag-and-drop errors.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      width: z.number().int().min(480).max(3840).default(1280),
      height: z.number().int().min(320).max(2160).default(800),
      layoutStandard: z
        .enum(['ISA_101_HIGH_PERFORMANCE', 'STANDARD_INDUSTRIAL', 'MOBILE_UNIFIED'])
        .default('ISA_101_HIGH_PERFORMANCE'),
      includeAlarmBanner: z.boolean().default(true),
      includeNavBar: z.boolean().default(true),
      nodes: z
        .array(
          z.object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{2,48}$/),
            type: z.enum(['TANK', 'PUMP', 'VALVE', 'STATION', 'CONVEYOR', 'ACTUATOR', 'NUMERIC_DISPLAY', 'NUMERIC_INPUT', 'BIT_BUTTON', 'BIT_LAMP', 'GAUGE', 'BAR_GRAPH']),
            label: z.string().min(1).max(80),
            tagName: z.string().optional(),
            writeEnabled: z.boolean().default(false),
            visualRole: z.enum(VISUAL_ROLES).optional(),
            unit: z.string().optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            calloutTagName: z.string().optional(),
            calloutLabel: z.string().optional(),
            calloutUnit: z.string().optional(),
          })
        )
        .min(1),
      edges: z
        .array(
          z.object({
            id: z.string().optional(),
            from: z.string().min(1),
            to: z.string().min(1),
            fluid: z.enum(['CHILLED_WATER', 'HOT_WATER', 'STEAM', 'AIR', 'CHEMICAL', 'PROCESS', 'RETURN', 'TRANSFER', 'SIGNAL']).default('PROCESS'),
            label: z.string().optional(),
            flowTagName: z.string().optional(),
          })
        )
        .default([]),
      returnSvg: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      screenId: 'scr_chiller_pid',
      name: 'Chiller Loop P&ID (Auto-Compiled)',
      nodes: [
        { id: 'tank_buffer', type: 'TANK', label: 'Buffer Tank', calloutTagName: 'Return_Temp_C', calloutLabel: 'Return Temp' },
        { id: 'pump_primary', type: 'PUMP', label: 'Primary Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { id: 'valve_bypass', type: 'VALVE', label: 'Bypass Valve', tagName: 'Valve_Position_Pct', writeEnabled: true, calloutTagName: 'Supply_Temp_C', calloutLabel: 'Supply Temp' },
      ],
      edges: [
        { from: 'tank_buffer', to: 'pump_primary', fluid: 'CHILLED_WATER', label: 'Suction' },
        { from: 'pump_primary', to: 'valve_bypass', fluid: 'CHILLED_WATER', label: 'Supply Header' },
        { from: 'valve_bypass', to: 'tank_buffer', fluid: 'RETURN', label: 'Return Loop' },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const compiled = compilePidScreen(input, project.tags, {
        knownScreenIds: new Set([...project.screens.map((s) => s.id), input.screenId]),
        targetHardware: project.targetHardware,
      });
      const idx = project.screens.findIndex((s) => s.id === compiled.screen.id);
      if (idx >= 0) project.screens[idx] = compiled.screen;
      else project.screens.push(compiled.screen);
      store.saveProject(project);
      return {
        compiled: true,
        screen: compiled.screen,
        portAttachmentProof: compiled.portAttachmentProof,
        spatialAudit: compiled.spatialAudit,
        ...(input.returnSvg ? { svg: compiled.svg } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_layout_solve',
    domain: 'hmi',
    haiwellFeature: 'Deterministic 8px-Grid Alignment, Touch-Target & Collision Auto-Repair Solver',
    safetyTier: 'design',
    description:
      'Automatically repair ANY overlapping, out-of-bounds, off-grid, or undersized (<48px touch) widgets on an existing Haiwell HMI screen via deterministic minimum-displacement packing and re-anchor P&ID pipes.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().min(1),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, screenId: 'scr_chiller_overview' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const idx = project.screens.findIndex((s) => s.id === input.screenId);
      if (idx < 0) throw new Error(`Screen "${input.screenId}" not found.`);
      const result = solveAndRepairScreenLayout(project.screens[idx], project.targetHardware);
      project.screens[idx] = result.screen;
      store.saveProject(project);
      const audit = auditScreenSpatially(result.screen, project.tags, {
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
      });
      return {
        repaired: true,
        movedWidgets: result.movedWidgets,
        resizedForTouch: result.resizedForTouch,
        remainingCollisions: result.remainingCollisions,
        remainingOutOfBounds: result.remainingOutOfBounds,
        spatialAudit: audit,
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_spatial_verify',
    domain: 'hmi',
    haiwellFeature: 'Closed-Loop Spatial Proof & 2D ASCII Occupancy Map Verifier',
    safetyTier: 'read',
    description:
      'Run closed-loop spatial verification on any Haiwell HMI screen: proves 0px overlaps, checks >=44px touch targets, computes pairwise clearance and screen density %, verifies 0px pipe-to-port attachment, and returns a 48x18 ASCII occupancy map (plus optional SVG) so text-only and multimodal agents can visually inspect layout quality.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().default('scr_chiller_overview'),
      includeSvg: z.boolean().default(false),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, screenId: 'scr_chiller_overview' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = project.screens.find((s) => s.id === input.screenId);
      if (!screen) throw new Error(`Screen "${input.screenId}" not found.`);
      const audit = auditScreenSpatially(screen, project.tags, {
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
      });
      return {
        ...audit,
        ...(input.includeSvg ? { svg: renderScreenToSvg(screen, project.tags) } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_desktop_bridge_export',
    domain: 'hmi',
    haiwellFeature: 'Calibrated Haiwell Cloud Scada 3.50.x Windows UIA (pywinauto) Canvas & Property Modal Bridge',
    safetyTier: 'design',
    description:
      'Export a validated HMI screen for Haiwell Cloud Scada 3.50.x (*.hwdev, .NET WinForms) via BOTH (1) an intermediate layout plan manifest AND (2) a calibrated Windows UI Automation (pywinauto) script matching the real "Haiwell Cloud Scada[3.50.x]" window title, selecting components in Graphics library, drawing exact bounding boxes on the Display canvas, configuring documented Property Setting modal dialog fields, saving .hwdev (Ctrl+S), and triggering Offline Simulation (F6).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().default('scr_chiller_overview'),
      windowTitleRegex: z.string().default('(?i)^Haiwell Cloud Scada\\[.*'),
      uiaMap: z
        .object({
          windowTitleRegex: z.string().optional(),
          projectBrowserAutoId: z.string().optional(),
          toolboxAutoId: z.string().optional(),
          canvasAutoId: z.string().optional(),
          propertyGridAutoId: z.string().optional(),
          toolboxTitle: z.string().optional(),
          propertyGridTitle: z.string().optional(),
          haiwellVersion: z.string().optional(),
        })
        .optional(),
      catalogOverrides: z.record(z.string(), z.string()).optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, screenId: 'scr_chiller_overview' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = project.screens.find((s) => s.id === input.screenId);
      if (!screen) throw new Error(`Screen "${input.screenId}" not found.`);
      return compileDesktopAutomationBridge(screen, project.tags, {
        windowTitleRegex: input.windowTitleRegex,
        uiaMap: input.uiaMap,
        catalogOverrides: input.catalogOverrides,
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
      });
    },
  }),

  defineTool({
    name: 'haiwell_desktop_uia_calibrate',
    domain: 'hmi',
    haiwellFeature: 'Live Windows UIA Calibrator for Haiwell Cloud Scada 3.50.x (.NET WinForms)',
    safetyTier: 'read',
    description:
      'Generate calibrate_haiwell_uia.py to inspect a live Haiwell Cloud Scada 3.50.x desktop window (all 22 Project browser nodes, Display canvas, Graphics library panel + visible catalog items) and output haiwell_uia_map.json + haiwell_graphics_catalog_dump.json, OR validate a captured UIA map before running desktop automation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['GENERATE_SCRIPT', 'VALIDATE_MAP']).default('GENERATE_SCRIPT'),
      windowTitleRegex: z.string().default('(?i)^Haiwell Cloud Scada\\[.*'),
      capturedMap: z
        .object({
          windowTitleRegex: z.string().optional(),
          projectBrowserAutoId: z.string().optional(),
          toolboxAutoId: z.string().optional(),
          canvasAutoId: z.string().optional(),
          propertyGridAutoId: z.string().optional(),
          toolboxTitle: z.string().optional(),
          propertyGridTitle: z.string().optional(),
          haiwellVersion: z.string().optional(),
        })
        .optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'GENERATE_SCRIPT', windowTitleRegex: '(?i)^Haiwell Cloud Scada\\[.*' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'VALIDATE_MAP' && !input.capturedMap) {
        throw new Error('VALIDATE_MAP requires capturedMap object from haiwell_uia_map.json.');
      }
      return {
        projectId: project.id,
        hwdevFileName: project.hwdevFileName,
        ...generateDesktopUiaCalibrator({
          windowTitleRegex: input.windowTitleRegex,
          capturedMap: input.capturedMap,
        }),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_template_instantiate',
    domain: 'hmi',
    haiwellFeature: 'Zero-Pixel-Math Hard-Coded ISA-101 HMI Screen Templates',
    safetyTier: 'design',
    description:
      'Instantiate a hard-coded, guaranteed zero-overlap ISA-101 HMI screen template (INDUSTRIAL_LINE_OVERVIEW, MULTI_STATION_PROCESS_FLOW, ALARMS_TRENDS_DIAGNOSTICS, STATION_IO_DETAIL, STATION_IO_MONITOR, MAIN_NAVIGATION_HUB, STATION_ALARMS_SIMPLE, EDGE_LOGGER_CONSOLE) using only semantic tag/title inputs. Eliminates manual x/y/width/height math and validates 0 collisions.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      template: z.enum([
        'INDUSTRIAL_LINE_OVERVIEW',
        'MULTI_STATION_PROCESS_FLOW',
        'ALARMS_TRENDS_DIAGNOSTICS',
        'STATION_IO_DETAIL',
        'STATION_IO_MONITOR',
        'MAIN_NAVIGATION_HUB',
        'STATION_ALARMS_SIMPLE',
        'EDGE_LOGGER_CONSOLE',
      ]),
      screenId: z.string().regex(/^[a-zA-Z0-9_-]{2,64}$/),
      name: z.string().min(2).max(80),
      title: z.string().min(2).max(120),
      width: z.number().int().min(320).max(3840).default(1024),
      height: z.number().int().min(240).max(2160).default(600),
      eStopTag: z.string().optional(),
      navTabs: z
        .array(
          z.object({
            label: z.string().min(1),
            targetScreenName: z.string().min(1),
            targetWindowId: z.number().int().min(1).max(9999).optional(),
            active: z.boolean().optional(),
          })
        )
        .optional(),
      subtitle: z.string().optional(),
      brandingLogos: z
        .array(
          z.object({
            base64: z.string().min(1),
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
        )
        .optional(),
      hubNavCards: z
        .array(
          z.object({
            label: z.string().min(1),
            targetScreenName: z.string().min(1),
            targetWindowId: z.number().int().min(1).max(9999).optional(),
            active: z.boolean().optional(),
          })
        )
        .optional(),
      commands: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      commIndicators: z
        .array(z.object({ label: z.string().min(1), tagName: z.string().min(1) }))
        .optional(),
      leftReadouts: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            unit: z.string().optional(),
            precision: z.number().int().min(0).max(4).optional(),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      gauge: z
        .object({
          label: z.string().min(1),
          tagName: z.string().min(1),
          min: z.number().optional(),
          max: z.number().optional(),
          unit: z.string().optional(),
          precision: z.number().int().min(0).max(4).optional(),
        })
        .optional(),
      bar: z
        .object({
          label: z.string().min(1),
          tagName: z.string().min(1),
          min: z.number().optional(),
          max: z.number().optional(),
          unit: z.string().optional(),
        })
        .optional(),
      heroKpis: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            unit: z.string().optional(),
            precision: z.number().int().min(0).max(4).optional(),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      stationCycles: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            unit: z.string().optional(),
            precision: z.number().int().min(0).max(4).optional(),
          })
        )
        .optional(),
      ioIndicators: z
        .array(z.object({ label: z.string().min(1), tagName: z.string().min(1) }))
        .optional(),
      includeAlarmTable: z.boolean().default(true),
      stations: z
        .array(
          z.object({
            title: z.string().min(1),
            icon: z.enum(['HWReactor25', 'HWCursor3', 'Motor1']),
            secondaryIcon: z.enum(['HWGear1']).optional(),
            tagName: z.string().optional(),
            ioIndicators: z
              .array(z.object({ label: z.string().min(1), tagName: z.string().min(1) }))
              .optional(),
            kpi: z
              .object({
                label: z.string().min(1),
                tagName: z.string().min(1),
                unit: z.string().optional(),
                precision: z.number().int().min(0).max(4).optional(),
              })
              .optional(),
          })
        )
        .optional(),
      transfers: z
        .array(
          z.object({
            label: z.string().min(1),
            fluid: z.enum(['TRANSFER', 'SIGNAL']),
            conveyorTagName: z.string().optional(),
          })
        )
        .optional(),
      quickCommands: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      bottomReadouts: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            unit: z.string().optional(),
            precision: z.number().int().min(0).max(4).optional(),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      trendTagName: z.string().optional(),
      runIdTagName: z.string().optional(),
      sequenceCounters: z
        .array(z.object({ label: z.string().min(1), tagName: z.string().min(1) }))
        .optional(),
      inputs: z
        .array(z.object({ label: z.string().min(1), tagName: z.string().min(1) }))
        .optional(),
      outputs: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      outputIndicators: z
        .array(
          z.object({
            label: z.string().min(1),
            tagName: z.string().min(1),
            role: z.enum(VISUAL_ROLES).optional(),
          })
        )
        .optional(),
      commTagName: z.string().min(1).optional(),
      commLabel: z.string().min(1).optional(),
      stationCounter: z
        .object({
          label: z.string().min(1),
          tagName: z.string().min(1),
          unit: z.string().optional(),
        })
        .optional(),
      returnSvg: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      template: 'INDUSTRIAL_LINE_OVERVIEW',
      screenId: 'scr_tpl_overview',
      name: 'Line_Overview',
      title: 'PLANT OVERVIEW',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = instantiateHmiTemplate(input);
      const knownScreenIds = new Set(project.screens.map((s) => s.id));
      knownScreenIds.add(screen.id);
      const validation = validateHmiScreen(screen, project.tags, {
        knownScreenIds,
        targetHardware: project.targetHardware,
      });
      const existingIdx = project.screens.findIndex((s) => s.id === screen.id);
      if (existingIdx >= 0) project.screens[existingIdx] = screen;
      else project.screens.push(screen);
      if (!project.startupScreenId) project.startupScreenId = screen.id;
      store.saveProject(project);
      return {
        screen,
        validation,
        ...(input.returnSvg ? { svg: renderScreenToSvg(screen, project.tags) } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_open_project_bridge_export',
    domain: 'hmi',
    haiwellFeature: 'Full Open-.hwdev Project Windows UIA Automator (Devices, Variables, Tasks, Events, Displays)',
    safetyTier: 'design',
    description:
      'Compile an entire safety-verified Haiwell Cloud Scada 3.50.x project into a single Windows UIA automation bundle for an already-open blank .hwdev window, covering all 5 core sections: Devices (4-tab Property Setting dialog), Variables (Device Variable grid / Batch Add), Tasks (Strict-ES5 clipboard paste), Events (Event selection modal), and Displays (Graphics library canvas draw + component Property Setting modal). Refuses export if deploymentReady is false.',
    inputSchema: z.object({
      projectId: z.string().min(2).default(DEFAULT_PROJECT_ID),
      sections: z
        .array(z.enum(['devices', 'variables', 'tasks', 'events', 'displays']))
        .min(1)
        .default(['devices', 'variables', 'tasks', 'events', 'displays']),
      existingProjectMode: z.enum(['BLANK', 'MERGE', 'REPLACE_DISPLAYS']).default('BLANK'),
      deleteScreenNames: z.array(z.string().min(1)).default([]),
      windowTitleRegex: z.string().min(3).default('(?i)^Haiwell Cloud Scada\\[.*'),
      uiaMap: z
        .object({
          windowTitleRegex: z.string().optional(),
          projectBrowserAutoId: z.string().optional(),
          toolboxAutoId: z.string().optional(),
          canvasAutoId: z.string().optional(),
          propertyGridAutoId: z.string().optional(),
        })
        .optional(),
      catalogOverrides: z.record(z.string(), z.string()).optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      sections: ['devices', 'variables', 'tasks', 'events', 'displays'],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const audit = runProjectSafetyAudit(project);
      if (!audit.deploymentReady) {
        throw new Error(
          `SAFETY_BLOCK: Project "${project.id}" failed safety audit (critical=${audit.counts.critical}, high=${audit.counts.high}). Fix critical/high findings before exporting the open-project desktop bridge.`
        );
      }
      return compileFullOpenProjectBridge(project, {
        sections: input.sections,
        existingProjectMode: input.existingProjectMode,
        deleteScreenNames: input.deleteScreenNames,
        windowTitleRegex: input.windowTitleRegex,
        uiaMap: input.uiaMap,
        catalogOverrides: input.catalogOverrides,
      });
    },
  }),

  // =========================================================================
  // 6. HAIWELL JAVASCRIPT ENGINE & DECLARATIVE EVENT TRIGGERS
  // =========================================================================
  defineTool({
    name: 'haiwell_script_validate',
    domain: 'scripts',
    haiwellFeature: 'Lexer-Hardened Haiwell JavaScript Static Analyzer',
    safetyTier: 'read',
    description:
      'Validate Haiwell Cloud SCADA JavaScript scripts with Strict ES5 (Node v0.10.41 ARM HMI) enforcement, native $Device.Var / Variable.GetByFullName / Tag.Read cross-referencing, Haiwell 3.50.x SQLite/Ajax/busy-wait runtime trap lints, sandbox escape blocking, RO tag protection, and SIL interlock warnings.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      code: z.string().min(1),
      trigger: z.enum(['STARTUP', 'SHUTDOWN', 'CYCLIC', 'TAG_CHANGE', 'SCREEN_EVENT', 'ALARM_EVENT']).optional(),
      intervalMs: z.number().int().optional(),
      triggerTag: z.string().optional(),
      strictEs5: z.boolean().optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      code: 'var t = Tag.Read("Supply_Temp_C");\nif (t > 12) { Common.logger.info("%s", "High supply temp: " + t); }',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      return validateHaiwellScript(input.code, project.tags, {
        trigger: input.trigger,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
        strictEs5: input.strictEs5,
        targetHardware: project.targetHardware,
      });
    },
  }),

  defineTool({
    name: 'haiwell_script_upsert',
    domain: 'scripts',
    haiwellFeature: 'Haiwell JavaScript Script Registration',
    safetyTier: 'design',
    description:
      'Validate and save a Haiwell Cloud SCADA JavaScript task (STARTUP, SHUTDOWN, CYCLIC, TAG_CHANGE, SCREEN_EVENT, ALARM_EVENT). Enforces Strict ES5 on embedded ARM HMIs (B7H/B7/C7/C10) and blocks saving on static validation or trigger configuration errors.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      trigger: z.enum(['STARTUP', 'SHUTDOWN', 'CYCLIC', 'TAG_CHANGE', 'SCREEN_EVENT', 'ALARM_EVENT']),
      intervalMs: z.number().int().min(50).max(3600000).optional(),
      triggerTag: z.string().optional(),
      strictEs5: z.boolean().optional(),
      code: z.string().min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'scr_js_setpoint_guard',
      name: 'SetpointClampGuard',
      trigger: 'TAG_CHANGE',
      triggerTag: 'Chiller_Setpoint_C',
      code: 'var sp = Tag.Read("Chiller_Setpoint_C");\nif (sp < 4.0) { Tag.Write("Chiller_Setpoint_C", 4.0); }',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const validation = validateHaiwellScript(input.code, project.tags, {
        trigger: input.trigger,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
        strictEs5: input.strictEs5,
        targetHardware: project.targetHardware,
      });
      if (!validation.valid) return { saved: false, validation };
      const script = {
        id: input.id,
        name: input.name,
        trigger: input.trigger,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
        code: input.code,
        referencedTags: validation.referencedTags,
        validated: true,
        updatedAt: new Date().toISOString(),
      };
      const idx = project.scripts.findIndex((s) => s.id === script.id);
      if (idx >= 0) project.scripts[idx] = script;
      else project.scripts.push(script);
      store.saveProject(project);
      return { saved: true, script, validation };
    },
  }),

  defineTool({
    name: 'haiwell_event_trigger_configure',
    domain: 'scripts',
    haiwellFeature: 'Declarative Tag-to-Action Event Triggers',
    safetyTier: 'design',
    description:
      'Configure non-script Haiwell Cloud SCADA Event Triggers (RISING_EDGE, FALLING_EDGE, ON_CHANGE, GT, LT, EQ) bound to OPEN_SCREEN, WRITE_TAG, RUN_SCRIPT, DOWNLOAD_RECIPE, or SEND_WEBHOOK with referential integrity validation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      sourceTag: z.string().min(1),
      condition: z.enum(['RISING_EDGE', 'FALLING_EDGE', 'ON_CHANGE', 'GT', 'LT', 'EQ']),
      threshold: z.number().optional(),
      actionType: z.enum(['OPEN_SCREEN', 'WRITE_TAG', 'RUN_SCRIPT', 'DOWNLOAD_RECIPE', 'SEND_WEBHOOK']),
      targetId: z.string().min(1),
      actionValue: z.union([z.number(), z.boolean(), z.string()]).optional(),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'trg_high_temp_valve',
      name: 'Open Bypass Valve On High Supply Temp',
      sourceTag: 'Supply_Temp_C',
      condition: 'GT',
      threshold: 12.0,
      actionType: 'WRITE_TAG',
      targetId: 'Chiller_Setpoint_C',
      actionValue: 6.5,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (!hasOwnTag(project, input.sourceTag)) throw new Error(`sourceTag "${input.sourceTag}" does not exist.`);
      if ((input.condition === 'GT' || input.condition === 'LT' || input.condition === 'EQ') && input.threshold === undefined) {
        throw new Error(`Condition "${input.condition}" requires an explicit numeric threshold.`);
      }
      if (input.actionType === 'WRITE_TAG') {
        const t = getOwnTag(project, input.targetId);
        if (!t) throw new Error(`Target tag "${input.targetId}" does not exist.`);
        if (t.access === 'RO') throw new Error(`Target tag "${input.targetId}" is read-only.`);
        if (input.actionValue === undefined) throw new Error('WRITE_TAG event trigger requires actionValue.');
        const valCheck = validateTagValueForType(t.dataType, input.actionValue);
        if (!valCheck.valid) throw new Error(`Invalid actionValue for "${t.name}": ${valCheck.error}`);
      } else if (input.actionType === 'OPEN_SCREEN' && !project.screens.some((s) => s.id === input.targetId)) {
        throw new Error(`Target screen "${input.targetId}" does not exist.`);
      } else if (input.actionType === 'RUN_SCRIPT' && !project.scripts.some((s) => s.id === input.targetId)) {
        throw new Error(`Target script "${input.targetId}" does not exist.`);
      } else if (input.actionType === 'DOWNLOAD_RECIPE') {
        const [grpId, recId] = input.targetId.split(':');
        const grp = project.recipes.find((r) => r.id === grpId);
        if (!grp || !grp.records.some((r) => r.recordId === recId)) {
          throw new Error(`Target recipe "${input.targetId}" not found (use format groupId:recordId).`);
        }
      } else if (input.actionType === 'SEND_WEBHOOK' && !project.webhooks.some((w) => w.id === input.targetId)) {
        throw new Error(`Target webhook "${input.targetId}" does not exist.`);
      }
      const idx = project.eventTriggers.findIndex((e) => e.id === input.id);
      if (idx >= 0) project.eventTriggers[idx] = input;
      else project.eventTriggers.push(input);
      store.saveProject(project);
      return { configured: true, eventTrigger: input };
    },
  }),

  // =========================================================================
  // 7. ISA-18.2 ALARMS & MULTI-CHANNEL CLOUD NOTIFICATIONS
  // =========================================================================
  defineTool({
    name: 'haiwell_alarm_configure',
    domain: 'alarms',
    haiwellFeature: 'ISA-18.2 Alarm Rules & Cloud Multi-Channel Notifications',
    safetyTier: 'design',
    description:
      'Create or update digital/analog alarms (HIHI, HI, LO, LOLO, ROC, DEV) with deadband hysteresis, debounce delays, priority (1-4), and multi-channel Cloud routing (Screen Pop-up, Voice TTS, Mobile App Push, WeChat, SMS, Email).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      tagName: z.string().min(1),
      condition: z.enum(['DIGITAL_HIGH', 'DIGITAL_LOW', 'HIHI', 'HI', 'LO', 'LOLO', 'ROC', 'DEV']),
      threshold: z.number(),
      referenceValue: z.number().optional(),
      deadband: z.number().min(0).default(0.2),
      delayOnMs: z.number().int().min(0).default(2000),
      delayOffMs: z.number().int().min(0).default(1000),
      priority: z.number().int().min(1).max(4).default(2),
      group: z.string().default('PROCESS'),
      messageTemplate: z.string().min(3).max(240),
      channels: z.array(z.enum(['SCREEN_POPUP', 'VOICE_TTS', 'MOBILE_PUSH', 'WECHAT', 'SMS', 'EMAIL'])).min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'alm_return_hi',
      name: 'Return Header High Temp',
      tagName: 'Return_Temp_C',
      condition: 'HI',
      threshold: 16.0,
      deadband: 0.5,
      priority: 2,
      group: 'THERMAL',
      messageTemplate: 'Return water temperature exceeded 16.0 °C.',
      channels: ['SCREEN_POPUP', 'MOBILE_PUSH', 'WECHAT'],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (!hasOwnTag(project, input.tagName)) {
        throw new Error(`Alarm tag "${input.tagName}" does not exist in project "${project.id}".`);
      }
      const alarm = { ...input, priority: input.priority as 1 | 2 | 3 | 4, enabled: true };
      const idx = project.alarms.findIndex((a) => a.id === alarm.id);
      if (idx >= 0) project.alarms[idx] = alarm;
      else project.alarms.push(alarm);
      store.saveProject(project);
      return { configured: true, alarm, totalAlarms: project.alarms.length };
    },
  }),

  defineTool({
    name: 'haiwell_alarm_manage',
    domain: 'alarms',
    haiwellFeature: 'ISA-18.2 Deduplicating Alarm Evaluation, Shelving & Acknowledgment',
    safetyTier: 'control_guarded',
    description:
      'Run the deduplicating ISA-18.2 alarm state machine (deadband hysteresis, ROC/DEV, auto-clear to CLEARED_UNACK/NORMAL), list alarm history, acknowledge alarms, or temporarily shelve maintenance alarms.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['EVALUATE', 'LIST', 'ACKNOWLEDGE', 'SHELVE']),
      eventId: z.string().optional(),
      alarmId: z.string().optional(),
      shelveMinutes: z.number().int().min(1).max(1440).default(30),
      operator: z.string().default('mcp-agent'),
      scanIntervalMs: z.number().int().min(10).max(60000).optional(),
      enforceDelays: z.boolean().optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'EVALUATE' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'EVALUATE') {
        const summary = evaluateProjectAlarms(project, {
          scanIntervalMs: input.scanIntervalMs,
          enforceDelays: input.enforceDelays,
        });
        store.saveProject(project);
        return summary;
      }
      if (input.action === 'ACKNOWLEDGE') {
        if (!input.eventId) throw new Error('ACKNOWLEDGE requires eventId.');
        const ev = project.alarmHistory.find((e) => e.eventId === input.eventId);
        if (!ev) throw new Error(`Alarm event "${input.eventId}" not found.`);
        ev.state = ev.state === 'CLEARED_UNACK' ? 'NORMAL' : 'ACTIVE_ACK';
        ev.acknowledgedAt = new Date().toISOString();
        ev.acknowledgedBy = input.operator;
        store.saveProject(project);
        return { acknowledged: true, event: ev };
      }
      if (input.action === 'SHELVE') {
        if (!input.alarmId) throw new Error('SHELVE requires alarmId.');
        const alm = project.alarms.find((a) => a.id === input.alarmId);
        if (!alm) throw new Error(`Alarm "${input.alarmId}" not found.`);
        if (alm.priority === 1) {
          return { shelved: false, blockedBy: 'SIL_PRIORITY1_NO_SHELVE', message: 'ISA-18.2 safety policy forbids shelving Priority-1 alarms.' };
        }
        alm.shelvedUntil = new Date(Date.now() + input.shelveMinutes * 60000).toISOString();
        store.saveProject(project);
        return { shelved: true, alarmId: alm.id, shelvedUntil: alm.shelvedUntil };
      }
      return {
        definedCount: project.alarms.length,
        activeCount: project.alarmHistory.filter((e) => e.state.startsWith('ACTIVE')).length,
        history: project.alarmHistory,
      };
    },
  }),

  // =========================================================================
  // 8. MQTT 3.1.1/5.0, SPARKPLUG B & HAIWELL CLOUD IOT
  // =========================================================================
  defineTool({
    name: 'haiwell_mqtt_configure',
    domain: 'mqtt',
    haiwellFeature: 'MQTT Broker / Haiwell Cloud Data Center / Proxy Config',
    safetyTier: 'protocol_io',
    description:
      'Configure Haiwell built-in MQTT server, external MQTT broker, or Haiwell Cloud Data Center with TLS 128/256-bit, proxy routing, and Last Will & Testament (LWT).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      mode: z.enum(['BUILTIN_BROKER', 'EXTERNAL_BROKER', 'HAIWELL_CLOUD_DATA_CENTER']),
      brokerUri: z.string().regex(/^(mqtt|mqtts|ws|wss):\/\/.+$/i, 'Must start with mqtt://, mqtts://, ws://, or wss://'),
      clientId: z.string().min(2).max(64),
      keepAliveSec: z.number().int().min(5).max(3600).default(60),
      tlsEnabled: z.boolean().default(true),
      proxyEnabled: z.boolean().default(false),
      lwtTopic: z.string().optional(),
      lwtPayload: z.string().optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      mode: 'EXTERNAL_BROKER',
      brokerUri: 'mqtts://broker.factory.local:8883',
      clientId: 'haiwell_edge_chiller_01',
      keepAliveSec: 30,
      tlsEnabled: true,
      proxyEnabled: true,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.lwtTopic) {
        const lwtCheck = validateMqttTopic(input.lwtTopic, 'PUBLISH');
        if (!lwtCheck.valid) throw new Error(`Invalid lwtTopic: ${lwtCheck.errors.join(' ')}`);
      }
      project.mqtt = {
        ...project.mqtt,
        mode: input.mode,
        brokerUri: input.brokerUri,
        clientId: input.clientId,
        keepAliveSec: input.keepAliveSec,
        tlsEnabled: input.tlsEnabled,
        proxyEnabled: input.proxyEnabled,
        lwtTopic: input.lwtTopic ?? project.mqtt.lwtTopic,
        lwtPayload: input.lwtPayload ?? project.mqtt.lwtPayload,
      };
      store.saveProject(project);
      return { configured: true, mqtt: project.mqtt };
    },
  }),

  defineTool({
    name: 'haiwell_mqtt_topic_bind',
    domain: 'mqtt',
    haiwellFeature: 'MQTT Sparkplug B / JSON Topic-to-Tag Binding',
    safetyTier: 'design',
    description:
      'Bind Haiwell SCADA tags to an MQTT publish/subscribe topic with strict MQTT 3.1.1/5.0 per-level wildcard validation (+/#), $SYS guard, Sparkplug B or JSON serialization, QoS, and TLS write guards.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      topic: z.string().min(1),
      direction: z.enum(['PUBLISH', 'SUBSCRIBE', 'BIDIRECTIONAL']),
      qos: z.number().int().min(0).max(2).default(1),
      retain: z.boolean().default(false),
      format: z.enum(['JSON', 'SPARKPLUG_B', 'RAW_VALUE']).default('SPARKPLUG_B'),
      tags: z.array(z.string()).min(1),
      publishIntervalMs: z.number().int().min(100).max(3600000).default(5000),
      reportByException: z.boolean().default(true),
      allowRemoteWrite: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'mqtt_erp_energy',
      topic: 'plant/chiller01/erp/thermal',
      direction: 'PUBLISH',
      qos: 1,
      format: 'JSON',
      tags: ['Supply_Temp_C', 'Return_Temp_C', 'Plant_DeltaT_C'],
      publishIntervalMs: 10000,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const topicCheck = validateMqttTopic(input.topic, input.direction);
      if (!topicCheck.valid) return { bound: false, topicValidation: topicCheck };
      const missingTags = input.tags.filter((t) => !hasOwnTag(project, t));
      if (missingTags.length > 0) return { bound: false, error: `Unknown tags: ${missingTags.join(', ')}` };
      if (input.allowRemoteWrite && !project.mqtt.tlsEnabled) {
        return { bound: false, error: 'SAFETY_BLOCK: Remote MQTT write requires TLS enabled on broker config.' };
      }
      const binding = { ...input, qos: input.qos as 0 | 1 | 2 };
      const idx = project.mqtt.bindings.findIndex((b) => b.id === binding.id);
      if (idx >= 0) project.mqtt.bindings[idx] = binding;
      else project.mqtt.bindings.push(binding);
      store.saveProject(project);
      return { bound: true, binding, topicValidation: topicCheck, samplePayload: buildMqttPayload(project, binding) };
    },
  }),

  defineTool({
    name: 'haiwell_mqtt_exchange',
    domain: 'mqtt',
    haiwellFeature: 'MQTT Publish / Loopback Inspect / SSRF-Safe Broker TCP Probe',
    safetyTier: 'protocol_io',
    description:
      'Execute a deterministic MQTT publish (Sparkplug B/JSON), inspect loopback broker messages by topic filter (+/#), or run an SSRF-safe TCP reachability probe against a broker host:port.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['PUBLISH_BINDING', 'READ_LOOPBACK', 'PROBE_BROKER']),
      bindingId: z.string().optional(),
      topicFilter: z.string().optional(),
      probeHost: z.string().optional(),
      probePort: z.number().int().min(1).max(65535).optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'PUBLISH_BINDING', bindingId: 'mqtt_bind_telemetry' },
    handler: async (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'PUBLISH_BINDING') {
        const binding = project.mqtt.bindings.find((b) => b.id === input.bindingId) ?? project.mqtt.bindings[0];
        if (!binding) throw new Error('No MQTT binding found.');
        const payload = buildMqttPayload(project, binding);
        store.pushMqttLoopback(binding.topic, payload, binding.qos);
        return {
          published: true,
          simulatedLoopback: true,
          transport: 'IN_MEMORY_LOOPBACK',
          topic: binding.topic,
          qos: binding.qos,
          format: binding.format,
          payload,
        };
      }
      if (input.action === 'READ_LOOPBACK') {
        if (input.topicFilter) {
          const check = validateMqttTopic(input.topicFilter, 'SUBSCRIBE');
          if (!check.valid) throw new Error(`Invalid topicFilter: ${check.errors.join(' ')}`);
        }
        const messages = store.readMqttLoopback(input.topicFilter);
        return {
          simulatedLoopback: true,
          transport: 'IN_MEMORY_LOOPBACK',
          count: messages.length,
          messages,
        };
      }
      let host = input.probeHost;
      let port = input.probePort;
      if (!host || !port) {
        const parsedUrl = new URL(project.mqtt.brokerUri);
        host = host ?? parsedUrl.hostname;
        port = port ?? (Number(parsedUrl.port) || (project.mqtt.tlsEnabled ? 8883 : 1883));
      }
      const probe = await probeTcpEndpoint(host, port, 1200);
      return {
        simulatedLoopback: false,
        transport: 'TCP_SOCKET_PROBE',
        brokerUri: project.mqtt.brokerUri,
        host,
        port,
        ...probe,
      };
    },
  }),

  // =========================================================================
  // 9. OPC UA INTEROPERABILITY & UANODESET2 XML
  // =========================================================================
  defineTool({
    name: 'haiwell_opcua_configure',
    domain: 'opcua',
    haiwellFeature: 'OPC UA Server & Client Security Profile',
    safetyTier: 'protocol_io',
    description:
      'Configure Haiwell OPC UA Server/Client endpoint URL, namespace URI, security policy (Basic256Sha256 / Aes128 / Aes256), security mode (SignAndEncrypt), and authentication.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      role: z.enum(['SERVER', 'CLIENT', 'DUAL']),
      endpointUrl: z.string().regex(/^opc\.tcp:\/\/.+$/i, 'OPC UA endpoint must start with opc.tcp://'),
      namespaceUri: z.string().min(5),
      namespaceIndex: z.number().int().min(1).max(65535).default(2),
      securityPolicy: z.enum(['None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss']).default('Basic256Sha256'),
      securityMode: z.enum(['None', 'Sign', 'SignAndEncrypt']).default('SignAndEncrypt'),
      authMode: z.enum(['Anonymous', 'Username', 'X509Certificate']).default('Username'),
      publishingIntervalMs: z.number().int().min(50).max(60000).default(500),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      role: 'SERVER',
      endpointUrl: 'opc.tcp://localhost:4840/haiwell/chiller01',
      namespaceUri: 'urn:haiwell:scada:chiller01',
      securityPolicy: 'Basic256Sha256',
      securityMode: 'SignAndEncrypt',
      authMode: 'Username',
    },
    handler: (input, store) => {
      if ((input.securityPolicy === 'None') !== (input.securityMode === 'None')) {
        throw new Error(
          `OPCUA_SECURITY_MISMATCH: securityPolicy="${input.securityPolicy}" cannot be combined with securityMode="${input.securityMode}". Per OPC UA Part 6, None policy requires None mode and vice versa.`
        );
      }
      const project = store.getProject(input.projectId);
      project.opcua = {
        ...project.opcua,
        role: input.role,
        endpointUrl: input.endpointUrl,
        namespaceUri: input.namespaceUri,
        namespaceIndex: input.namespaceIndex,
        securityPolicy: input.securityPolicy,
        securityMode: input.securityMode,
        authMode: input.authMode,
        publishingIntervalMs: input.publishingIntervalMs,
      };
      store.saveProject(project);
      return { configured: true, opcua: project.opcua };
    },
  }),

  defineTool({
    name: 'haiwell_opcua_nodeset_map',
    domain: 'opcua',
    haiwellFeature: 'OPC UA AddressSpace Mapping & UANodeSet2 XML Generation',
    safetyTier: 'design',
    description:
      'Map Haiwell SCADA tags into OPC UA Variable nodes (deduplicated NodeIds, read/write access alignment) and optionally export OPC Foundation Part 6 UANodeSet2 XML.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      tagNames: z.array(z.string()).default([]),
      folderPath: z.string().default('/Objects/Plant'),
      samplingIntervalMs: z.number().int().min(50).max(60000).default(500),
      exportNodeSetXml: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      tagNames: ['Supply_Temp_C', 'Return_Temp_C', 'Chiller_Setpoint_C', 'Pump1_Run_Cmd'],
      folderPath: '/Objects/Chiller01',
      exportNodeSetXml: true,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const ns = project.opcua.namespaceIndex;
      const mapped: typeof project.opcua.nodes = [];
      for (const tagName of input.tagNames) {
        const tag = getOwnTag(project, tagName);
        if (!tag) throw new Error(`Tag "${tagName}" not found in project "${project.id}".`);
        const uaType = mapTagTypeToOpcUa(tag.dataType);
        const node = {
          nodeId: `ns=${ns};s=${input.folderPath.replace(/^\/Objects\//, '').replace(/\//g, '.')}.${tag.name}`,
          browseName: tag.name,
          displayName: tag.description ?? tag.name,
          tagName: tag.name,
          dataType: uaType.name,
          accessLevel: (tag.access === 'RO' ? 'CurrentRead' : 'CurrentReadWrite') as 'CurrentRead' | 'CurrentReadWrite',
          samplingIntervalMs: input.samplingIntervalMs,
          folderPath: input.folderPath,
        };
        const idx = project.opcua.nodes.findIndex((n) => n.tagName === tag.name || n.nodeId === node.nodeId);
        if (idx >= 0) project.opcua.nodes[idx] = node;
        else project.opcua.nodes.push(node);
        mapped.push(node);
      }
      store.saveProject(project);
      return {
        mappedCount: mapped.length,
        totalNodes: project.opcua.nodes.length,
        nodes: project.opcua.nodes,
        ...(input.exportNodeSetXml ? { nodeSet2Xml: generateOpcUaNodeSet2Xml(project) } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_opcua_browse_read_write',
    domain: 'opcua',
    haiwellFeature: 'OPC UA AddressSpace Browse, Read & Interlock-Guarded Write',
    safetyTier: 'protocol_io',
    description:
      'Browse mapped OPC UA AddressSpace nodes, read live node values with StatusCode/SourceTimestamp, or perform a binary-type, range, E-Stop, and interlock-guarded write.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['BROWSE', 'READ_NODE', 'WRITE_NODE']),
      nodeId: z.string().optional(),
      value: z.union([z.number(), z.boolean(), z.string()]).optional(),
      confirmSafetyOverride: z.boolean().default(false),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'BROWSE' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'BROWSE') {
        return {
          simulatedAddressSpace: true,
          endpointUrl: project.opcua.endpointUrl,
          namespaceUri: project.opcua.namespaceUri,
          nodes: project.opcua.nodes.map((n) => ({
            nodeId: n.nodeId,
            browseName: n.browseName,
            dataType: n.dataType,
            accessLevel: n.accessLevel,
            value: project.tags[n.tagName]?.currentValue,
          })),
        };
      }
      const node = project.opcua.nodes.find((n) => n.nodeId === input.nodeId);
      if (!node) throw new Error(`OPC UA nodeId "${input.nodeId}" not found.`);
      const tag = getOwnTag(project, node.tagName);
      if (!tag) throw new Error(`Bound SCADA tag "${node.tagName}" missing.`);
      if (input.action === 'READ_NODE') {
        return {
          simulatedAddressSpace: true,
          nodeId: node.nodeId,
          statusCode: 'Good (0x00000000)',
          dataType: node.dataType,
          value: tag.currentValue,
          sourceTimestamp: tag.updatedAt,
        };
      }
      if (node.accessLevel !== 'CurrentReadWrite') {
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'OPCUA_WRITE_NODE',
          target: node.nodeId,
          outcome: 'BLOCKED',
          detail: `Blocked write to OPC UA node ${node.nodeId} with non-writable accessLevel=${node.accessLevel}.`,
        });
        return {
          simulatedAddressSpace: true,
          written: false,
          statusCode: 'BadNotWritable (0x803B0000)',
          message: `OPC UA Node ${node.nodeId} has accessLevel "${node.accessLevel}" and is not writable (requires CurrentReadWrite).`,
        };
      }
      if (input.value === undefined) throw new Error('WRITE_NODE requires value.');
      const guard = checkTagWriteSafety(project, tag.name, input.value, input.confirmSafetyOverride);
      if (!guard.ok) {
        const uaStatus =
          guard.blockedBy === 'READ_ONLY_GUARD'
            ? 'BadNotWritable (0x803B0000)'
            : guard.blockedBy.startsWith('SAFE_RANGE') || guard.blockedBy.includes('OVERFLOW')
              ? 'BadOutOfRange (0x803C0000)'
              : guard.blockedBy.startsWith('TYPE_MISMATCH')
                ? 'BadTypeMismatch (0x80740000)'
                : 'BadUserAccessDenied (0x801F0000)';
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'OPCUA_WRITE_NODE',
          target: node.nodeId,
          outcome: 'BLOCKED',
          detail: `OPC UA write to ${tag.name} blocked by ${guard.blockedBy}: ${guard.message}`,
        });
        return {
          simulatedAddressSpace: true,
          written: false,
          statusCode: uaStatus,
          blockedBy: guard.blockedBy,
          message: guard.message,
        };
      }
      tag.previousValue = tag.currentValue;
      tag.currentValue = guard.normalizedValue;
      tag.updatedAt = new Date().toISOString();
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'OPCUA_WRITE_NODE',
        target: node.nodeId,
        outcome: 'ALLOWED',
        detail: `OPC UA write ${tag.name}=${JSON.stringify(tag.currentValue)}`,
      });
      return {
        simulatedAddressSpace: true,
        written: true,
        statusCode: 'Good (0x00000000)',
        nodeId: node.nodeId,
        value: tag.currentValue,
      };
    },
  }),

  // =========================================================================
  // 10. RECIPES & ATOMIC INTERLOCK-GUARDED BATCH TRANSFER
  // =========================================================================
  defineTool({
    name: 'haiwell_recipe_define',
    domain: 'recipes',
    haiwellFeature: 'Recipe Group & Production Formula Management',
    safetyTier: 'design',
    description:
      'Define a Haiwell SCADA recipe group bound to writable PLC/SCADA tags and upsert named production formula records with strict binary-type and safeMin/safeMax validation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      groupId: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      groupName: z.string().min(2).max(80),
      tagNames: z.array(z.string()).min(1),
      record: z.object({
        recordId: z.string().min(1),
        name: z.string().min(1),
        values: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
      }),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      groupId: 'rcp_chiller_modes',
      groupName: 'Seasonal Cooling Profiles',
      tagNames: ['Chiller_Setpoint_C', 'Valve_Position_Pct'],
      record: {
        recordId: 'winter_free_cool',
        name: 'Winter Free Cooling',
        values: { Chiller_Setpoint_C: 11.5, Valve_Position_Pct: 20 },
      },
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const sanitizedValues: Record<string, number | boolean | string> = {};
      for (const tagName of input.tagNames) {
        const tag = getOwnTag(project, tagName);
        if (!tag) throw new Error(`Recipe tag "${tagName}" does not exist.`);
        if (tag.access === 'RO') throw new Error(`Recipe tag "${tagName}" is read-only (RO).`);
        const val = Object.prototype.hasOwnProperty.call(input.record.values, tagName)
          ? input.record.values[tagName]
          : undefined;
        if (val === undefined) throw new Error(`Recipe record missing value for tag "${tagName}".`);
        const tc = validateTagValueForType(tag.dataType, val);
        if (!tc.valid) throw new Error(`Recipe value for "${tagName}": ${tc.error}`);
        if (typeof tc.normalizedValue === 'number') {
          if (tag.safeMin !== undefined && tc.normalizedValue < tag.safeMin) {
            throw new Error(`Recipe value ${tc.normalizedValue} for "${tagName}" violates safeMin (${tag.safeMin}).`);
          }
          if (tag.safeMax !== undefined && tc.normalizedValue > tag.safeMax) {
            throw new Error(`Recipe value ${tc.normalizedValue} for "${tagName}" violates safeMax (${tag.safeMax}).`);
          }
        }
        sanitizedValues[tagName] = tc.normalizedValue;
      }
      let group = project.recipes.find((r) => r.id === input.groupId);
      if (!group) {
        group = { id: input.groupId, name: input.groupName, tagNames: [...input.tagNames], records: [] };
        project.recipes.push(group);
      } else {
        group.name = input.groupName;
        group.tagNames = Array.from(new Set([...group.tagNames, ...input.tagNames]));
      }
      const rec = { ...input.record, values: sanitizedValues, updatedAt: new Date().toISOString() };
      const rIdx = group.records.findIndex((r) => r.recordId === rec.recordId);
      if (rIdx >= 0) group.records[rIdx] = rec;
      else group.records.push(rec);
      store.saveProject(project);
      return { saved: true, group };
    },
  }),

  defineTool({
    name: 'haiwell_recipe_transfer',
    domain: 'recipes',
    haiwellFeature: 'Atomic Interlock-Guarded Recipe Download / Upload',
    safetyTier: 'control_guarded',
    description:
      'Atomically download a recipe formula to PLC/SCADA tags (full pre-flight check of E-Stop, SIL interlocks, binary types, and safeMin/safeMax before writing a single tag!) or upload live PLC tag values.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      direction: z.enum(['DOWNLOAD_TO_PLC', 'UPLOAD_FROM_PLC']),
      groupId: z.string().min(1),
      recordId: z.string().min(1),
      recordName: z.string().optional(),
      confirmSafetyOverride: z.boolean().default(false),
      dryRun: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      direction: 'DOWNLOAD_TO_PLC',
      groupId: 'rcp_chiller_modes',
      recordId: 'eco_night',
      confirmSafetyOverride: true,
      dryRun: true,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const group = project.recipes.find((r) => r.id === input.groupId);
      if (!group) throw new Error(`Recipe group "${input.groupId}" not found.`);

      if (input.direction === 'UPLOAD_FROM_PLC') {
        const snapshot: Record<string, number | boolean | string> = {};
        for (const t of group.tagNames) snapshot[t] = project.tags[t]?.currentValue ?? 0;
        const rec = {
          recordId: input.recordId,
          name: input.recordName ?? input.recordId,
          values: snapshot,
          updatedAt: new Date().toISOString(),
        };
        if (!input.dryRun) {
          const idx = group.records.findIndex((r) => r.recordId === rec.recordId);
          if (idx >= 0) group.records[idx] = rec;
          else group.records.push(rec);
          store.saveProject(project);
        }
        return { uploaded: !input.dryRun, dryRun: input.dryRun, record: rec };
      }

      const rec = group.records.find((r) => r.recordId === input.recordId);
      if (!rec) throw new Error(`Recipe record "${input.recordId}" not found in "${group.id}".`);

      // Atomic pre-flight validation of ALL recipe tags before mutating ANY tag!
      const rejections: { tagName: string; blockedBy: string; message: string }[] = [];
      const rollbackSnapshot: Record<string, number | boolean | string> = {};
      const normalizedWrites: Record<string, number | boolean | string> = {};
      for (const [k, v] of Object.entries(rec.values)) {
        const check = checkTagWriteSafety(project, k, v, input.confirmSafetyOverride);
        if (!check.ok) {
          rejections.push({ tagName: k, blockedBy: check.blockedBy, message: check.message });
        } else {
          rollbackSnapshot[k] = check.tag.currentValue;
          normalizedWrites[k] = check.normalizedValue;
        }
      }
      if (rejections.length > 0) {
        return {
          transferred: false,
          atomicAborted: true,
          rejections,
          message: 'Recipe download aborted in pre-flight safety check; zero PLC tags modified.',
        };
      }

      if (!input.dryRun) {
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(normalizedWrites)) {
          const tag = getOwnTag(project, k)!;
          tag.previousValue = tag.currentValue;
          tag.currentValue = v;
          tag.updatedAt = now;
        }
        store.saveProject(project);
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'RECIPE_DOWNLOAD',
          target: `${group.id}:${rec.recordId}`,
          outcome: 'ALLOWED',
          detail: `Atomically downloaded ${Object.keys(rec.values).length} parameters.`,
        });
      }
      return { transferred: !input.dryRun, dryRun: input.dryRun, appliedValues: rec.values, rollbackSnapshot };
    },
  }),

  // =========================================================================
  // 11. HISTORICAL TRENDS & DATA LOGGING
  // =========================================================================
  defineTool({
    name: 'haiwell_trend_configure',
    domain: 'trends',
    haiwellFeature: 'Real-Time & Historical Trend Historian',
    safetyTier: 'design',
    description:
      'Configure historical sampling groups (interval, retention days, compression deadband, storage target) or capture/query structured trend time-series samples.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['UPSERT_GROUP', 'CAPTURE_SAMPLE', 'QUERY_SAMPLES']),
      groupId: z.string().min(1),
      name: z.string().optional(),
      tagNames: z.array(z.string()).optional(),
      sampleIntervalMs: z.number().int().min(100).max(3600000).default(10000),
      retentionDays: z.number().int().min(1).max(3650).default(90),
      deadbandPercent: z.number().min(0).max(50).default(0.2),
      storageTarget: z.enum(['LOCAL_HIST', 'CLOUD_HIST', 'SQL_DATALINK']).default('LOCAL_HIST'),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'QUERY_SAMPLES', groupId: 'trd_thermal_01' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'UPSERT_GROUP') {
        if (!input.name || !input.tagNames?.length) throw new Error('UPSERT_GROUP requires name and tagNames.');
        for (const tn of input.tagNames) {
          if (!hasOwnTag(project, tn)) throw new Error(`Trend tag "${tn}" does not exist.`);
        }
        const group = {
          id: input.groupId,
          name: input.name,
          tagNames: input.tagNames,
          sampleIntervalMs: input.sampleIntervalMs,
          retentionDays: input.retentionDays,
          deadbandPercent: input.deadbandPercent,
          storageTarget: input.storageTarget,
          samples: [],
        };
        const idx = project.trends.findIndex((t) => t.id === group.id);
        if (idx >= 0) project.trends[idx] = { ...group, samples: project.trends[idx].samples };
        else project.trends.push(group);
        store.saveProject(project);
        return { configured: true, trendGroup: group };
      }
      const group = project.trends.find((t) => t.id === input.groupId);
      if (!group) throw new Error(`Trend group "${input.groupId}" not found.`);
      if (input.action === 'CAPTURE_SAMPLE') {
        const values: Record<string, number> = {};
        for (const t of group.tagNames) values[t] = Number(getOwnTag(project, t)?.currentValue ?? 0);
        const sample = { timestamp: new Date().toISOString(), values };
        group.samples.push(sample);
        if (group.samples.length > 2000) {
          group.samples.splice(0, group.samples.length - 2000);
        }
        store.saveProject(project);
        return { captured: true, sample, totalSamples: group.samples.length };
      }
      return { groupId: group.id, name: group.name, sampleIntervalMs: group.sampleIntervalMs, samples: group.samples };
    },
  }),

  // =========================================================================
  // 12. HAIWELL DATA-LINK DATABASES & OUTBOUND WEBHOOKS
  // =========================================================================
  defineTool({
    name: 'haiwell_datalink_configure',
    domain: 'datalink',
    haiwellFeature: 'Haiwell Data-Link (MySQL / SQL Server / PostgreSQL / SQLite)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Data-Link connectors for ERP/MES database logging with identifier sanitization, duplicate-column & SQL-reserved-word rejection, and parameterized SQL generation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      engine: z.enum(['MYSQL', 'SQL_SERVER', 'POSTGRESQL', 'SQLITE']),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      tableName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      syncMode: z.enum(['CYCLIC_INSERT', 'TAG_TRIGGER', 'UPSERT_LATEST']).default('CYCLIC_INSERT'),
      intervalMs: z.number().int().min(1000).max(86400000).default(60000),
      columnMappings: z
        .array(
          z.object({
            column: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            tagName: z.string().min(1),
            sqlType: z.string().min(2).max(32),
          })
        )
        .min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'dl_erp_sqlserver',
      name: 'ERP Energy SQL Server Sync',
      engine: 'SQL_SERVER',
      host: '10.0.10.15',
      port: 1433,
      database: 'factory_erp',
      tableName: 'scada_chiller_log',
      columnMappings: [
        { column: 'supply_temp', tagName: 'Supply_Temp_C', sqlType: 'FLOAT' },
        { column: 'delta_t', tagName: 'Plant_DeltaT_C', sqlType: 'FLOAT' },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (SQL_RESERVED.has(input.tableName.toUpperCase())) {
        throw new Error(`tableName "${input.tableName}" is a reserved SQL keyword.`);
      }
      const seenCols = new Set<string>();
      for (const m of input.columnMappings) {
        if (SQL_RESERVED.has(m.column.toUpperCase())) throw new Error(`Column "${m.column}" is a reserved SQL keyword.`);
        if (seenCols.has(m.column.toLowerCase())) throw new Error(`Duplicate column mapping "${m.column}".`);
        seenCols.add(m.column.toLowerCase());
        if (!hasOwnTag(project, m.tagName)) throw new Error(`Data-Link mapped tag "${m.tagName}" does not exist.`);
      }
      const cfg = { ...input, parameterizedOnly: true };
      const idx = project.dataLinks.findIndex((d) => d.id === cfg.id);
      if (idx >= 0) project.dataLinks[idx] = cfg;
      else project.dataLinks.push(cfg);
      store.saveProject(project);

      const cols = cfg.columnMappings.map((c) => c.column).join(', ');
      const placeholders = cfg.columnMappings.map((_, i) => (cfg.engine === 'POSTGRESQL' ? `$${i + 2}` : '?')).join(', ');
      return {
        configured: true,
        dataLink: cfg,
        generatedParameterizedSql: `INSERT INTO ${cfg.tableName} (recorded_at, ${cols}) VALUES (${cfg.engine === 'POSTGRESQL' ? '$1' : '?'}, ${placeholders});`,
      };
    },
  }),

  defineTool({
    name: 'haiwell_webhook_configure',
    domain: 'datalink',
    haiwellFeature: 'Outbound HTTPS REST / Webhook Connector (ERP / MES / WeCom / DingTalk)',
    safetyTier: 'protocol_io',
    description:
      'Configure outbound HTTPS webhooks for ERP/MES/notification pipelines with TLS enforcement, SSRF metadata-host blocking, and JSON payload template validation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      url: z.string().url(),
      method: z.enum(['POST', 'PUT']).default('POST'),
      tlsRequired: z.boolean().default(true),
      timeoutMs: z.number().int().min(500).max(30000).default(5000),
      headers: z.record(z.string(), z.string()).default({ 'Content-Type': 'application/json' }),
      payloadTemplate: z.string().default('{"project":"{{projectId}}","tag":"{{tagName}}","value":"{{value}}"}'),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'wh_mes_alerts',
      name: 'MES Critical Alarm Webhook',
      url: 'https://mes.factory.example/api/v1/scada-events',
      method: 'POST',
      tlsRequired: true,
    },
    handler: (input, store) => {
      const parsed = new URL(input.url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`SAFETY_BLOCK: Unsupported webhook protocol "${parsed.protocol}". Only https:// (or http:// when tlsRequired=false) is allowed.`);
      }
      if (input.tlsRequired && parsed.protocol !== 'https:') {
        throw new Error('SAFETY_BLOCK: tlsRequired=true forbids non-HTTPS webhook URLs.');
      }
      if (isBlockedSsrfHost(parsed.hostname, { blockLoopback: true })) {
        throw new Error(`SSRF_BLOCK: Forbidden loopback/metadata/link-local/unspecified host "${parsed.hostname}".`);
      }
      const testRendered = input.payloadTemplate.replace(/\{\{[A-Za-z0-9_]+\}\}/g, 'sample');
      try {
        JSON.parse(testRendered);
      } catch {
        throw new Error('INVALID_PAYLOAD_TEMPLATE: payloadTemplate must produce valid JSON when {{placeholders}} are substituted.');
      }
      const project = store.getProject(input.projectId);
      const idx = project.webhooks.findIndex((w) => w.id === input.id);
      if (idx >= 0) project.webhooks[idx] = input;
      else project.webhooks.push(input);
      store.saveProject(project);
      return { configured: true, webhook: input };
    },
  }),

  // =========================================================================
  // 13. OPERATIONS: SCHEDULES, REPORTS, CAMERAS & MULTI-LANGUAGE
  // =========================================================================
  defineTool({
    name: 'haiwell_schedule_configure',
    domain: 'operations',
    haiwellFeature: 'Validated POSIX CRON Plan & Shift Scheduler',
    safetyTier: 'design',
    description:
      'Configure Haiwell SCADA scheduled tasks with strict 5-field POSIX CRON bounds checking and target existence verification (script, writable tag, recipe, or report).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      cron: z.string().min(9),
      timezone: z.string().default('UTC'),
      actionType: z.enum(['RUN_SCRIPT', 'WRITE_TAG', 'DOWNLOAD_RECIPE', 'EXPORT_REPORT']),
      targetId: z.string().min(1),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'sch_morning_peak',
      name: 'Morning Peak Pre-Cool',
      cron: '30 6 * * 1-5',
      timezone: 'UTC',
      actionType: 'DOWNLOAD_RECIPE',
      targetId: 'rcp_chiller_modes:summer_peak',
      enabled: true,
    },
    handler: (input, store) => {
      const cronCheck = validateCronExpression(input.cron);
      if (!cronCheck.valid) throw new Error(cronCheck.error);
      const project = store.getProject(input.projectId);
      if (input.actionType === 'RUN_SCRIPT' && !project.scripts.some((s) => s.id === input.targetId)) {
        throw new Error(`Scheduled target script "${input.targetId}" does not exist.`);
      }
      if (input.actionType === 'WRITE_TAG') {
        const t = getOwnTag(project, input.targetId);
        if (!t) throw new Error(`Scheduled target tag "${input.targetId}" does not exist.`);
        if (t.access === 'RO') throw new Error(`Scheduled target tag "${input.targetId}" is read-only.`);
      }
      if (input.actionType === 'DOWNLOAD_RECIPE') {
        const [grpId, recId] = input.targetId.split(':');
        const grp = project.recipes.find((r) => r.id === grpId);
        if (!grp || !grp.records.some((r) => r.recordId === recId)) {
          throw new Error(`Scheduled target recipe "${input.targetId}" not found (use format groupId:recordId).`);
        }
      }
      if (input.actionType === 'EXPORT_REPORT' && !project.reports.some((r) => r.id === input.targetId)) {
        throw new Error(`Scheduled target report "${input.targetId}" does not exist.`);
      }
      const idx = project.schedules.findIndex((s) => s.id === input.id);
      if (idx >= 0) project.schedules[idx] = input;
      else project.schedules.push(input);
      store.saveProject(project);
      return { configured: true, schedule: input, totalSchedules: project.schedules.length };
    },
  }),

  defineTool({
    name: 'haiwell_report_configure',
    domain: 'operations',
    haiwellFeature: 'Shift & Compliance Data Report Templates',
    safetyTier: 'design',
    description:
      'Create structured shift/daily/monthly SCADA report templates (CSV/XLSX/JSON/HTML) with tag aggregate columns (RAW, MIN, MAX, AVG, SUM).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      schedule: z.enum(['HOURLY', 'SHIFT', 'DAILY', 'MONTHLY', 'ON_DEMAND']).default('SHIFT'),
      format: z.enum(['CSV', 'XLSX', 'JSON', 'HTML']).default('CSV'),
      columns: z
        .array(
          z.object({
            header: z.string().min(1),
            tagName: z.string().min(1),
            aggregate: z.enum(['RAW', 'MIN', 'MAX', 'AVG', 'SUM']),
          })
        )
        .min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'rep_shift_summary',
      name: 'Shift Thermal Summary',
      schedule: 'SHIFT',
      format: 'JSON',
      columns: [
        { header: 'Supply Min (°C)', tagName: 'Supply_Temp_C', aggregate: 'MIN' },
        { header: 'Supply Avg (°C)', tagName: 'Supply_Temp_C', aggregate: 'AVG' },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      for (const c of input.columns) {
        if (!hasOwnTag(project, c.tagName)) throw new Error(`Report column tag "${c.tagName}" does not exist.`);
      }
      const idx = project.reports.findIndex((r) => r.id === input.id);
      if (idx >= 0) project.reports[idx] = input;
      else project.reports.push(input);
      store.saveProject(project);
      return { configured: true, report: input };
    },
  }),

  defineTool({
    name: 'haiwell_camera_bind',
    domain: 'operations',
    haiwellFeature: 'IP Camera / RTSP / ONVIF / EZVIZ Screen Integration',
    safetyTier: 'design',
    description:
      'Bind live RTSP, ONVIF, EZVIZ, or HLS surveillance streams to a Haiwell HMI screen with optional PTZ and alarm-triggered snapshot linkage.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      protocol: z.enum(['RTSP', 'ONVIF', 'EZVIZ', 'HLS']),
      streamUri: z.string().regex(/^(rtsp|rtsps|http|https|ezviz):\/\/.+$/i),
      screenId: z.string().optional(),
      ptzEnabled: z.boolean().default(false),
      alarmSnapshotTriggerId: z.string().optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'cam_chiller_bay',
      name: 'Chiller Room North Bay',
      protocol: 'RTSP',
      streamUri: 'rtsp://192.168.1.90:554/stream1',
      screenId: 'scr_chiller_overview',
      ptzEnabled: true,
      alarmSnapshotTriggerId: 'alm_estop_trip',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.screenId && !project.screens.some((s) => s.id === input.screenId)) {
        throw new Error(`Screen "${input.screenId}" not found.`);
      }
      if (input.alarmSnapshotTriggerId && !project.alarms.some((a) => a.id === input.alarmSnapshotTriggerId)) {
        throw new Error(`Alarm "${input.alarmSnapshotTriggerId}" not found.`);
      }
      const idx = project.cameras.findIndex((c) => c.id === input.id);
      if (idx >= 0) project.cameras[idx] = input;
      else project.cameras.push(input);
      store.saveProject(project);
      return { bound: true, camera: input, totalCameras: project.cameras.length };
    },
  }),

  defineTool({
    name: 'haiwell_i18n_manage',
    domain: 'operations',
    haiwellFeature: 'Multi-Language HMI/Alarm Dictionary',
    safetyTier: 'design',
    description:
      'Upsert or query Haiwell Cloud SCADA multi-language translation keys across HMI screens, alarms, and labels (e.g., en-US, zh-CN, de-DE, es-ES, ja-JP).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
      entries: z.record(z.string(), z.string()).default({}),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      locale: 'de-DE',
      entries: {
        'screen.overview.title': 'Kaltwassersatz Übersicht',
        'alarm.supply_hihi': 'Vorlauftemperatur Grenzwert überschritten',
      },
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const safeEntries: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.entries)) {
        if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
        safeEntries[k] = v;
      }
      const existing = Object.prototype.hasOwnProperty.call(project.translations, input.locale)
        ? project.translations[input.locale]
        : {};
      project.translations[input.locale] = { ...existing, ...safeEntries };
      store.saveProject(project);
      return {
        locale: input.locale,
        keyCount: Object.keys(project.translations[input.locale]).length,
        entries: project.translations[input.locale],
      };
    },
  }),

  // =========================================================================
  // 14. SECURITY, RBAC & A/B KEY POLICY
  // =========================================================================
  defineTool({
    name: 'haiwell_security_policy',
    domain: 'security',
    haiwellFeature: 'RBAC User Groups, 128/256-bit SSL & Haiwell A/B Key Access Control',
    safetyTier: 'control_guarded',
    description:
      'Configure Haiwell Cloud SCADA security policy: SSL encryption strength (128/256), Haiwell A/B Key remote cloud authentication, output interlock enforcement, and official User Security RBAC privilege levels (1-20 per /docs/Usersecurity; 0 retained for backwards compatibility).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      sslBits: z.enum(['128', '256']).or(z.number().int()).default(128),
      abKeyEnabled: z.boolean().default(true),
      requireInterlockForOutputs: z.boolean().default(true),
      userGroups: z
        .array(
          z.object({
            groupName: z.string().min(2).max(40),
            privilegeLevel: z.number().int().min(0).max(20),
            canWriteTags: z.boolean(),
            canAckAlarms: z.boolean(),
            canTransferRecipes: z.boolean(),
            canRemoteTunnel: z.boolean(),
          })
        )
        .optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      sslBits: 256,
      abKeyEnabled: true,
      requireInterlockForOutputs: true,
    },
    handler: (input, store) => {
      const bits = Number(input.sslBits);
      if (bits !== 128 && bits !== 256) throw new Error('sslBits must be 128 or 256.');
      const project = store.getProject(input.projectId);
      project.security = {
        ...project.security,
        sslBits: bits as 128 | 256,
        abKeyEnabled: input.abKeyEnabled,
        requireInterlockForOutputs: input.requireInterlockForOutputs,
        userGroups: input.userGroups ?? project.security.userGroups,
      };
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'SECURITY_POLICY_UPDATE',
        target: project.id,
        outcome: 'ALLOWED',
        detail: `SSL=${bits}-bit, abKey=${input.abKeyEnabled}, interlock=${input.requireInterlockForOutputs}`,
      });
      return { updated: true, security: project.security };
    },
  }),

  // =========================================================================
  // 15. HEADLESS PLC/SCADA FAT SCAN-CYCLE SIMULATOR
  // =========================================================================
  defineTool({
    name: 'haiwell_simulation_step',
    domain: 'simulation',
    haiwellFeature: 'Headless PLC/SCADA Scan-Cycle FAT Verification Simulator',
    safetyTier: 'design',
    description:
      'Deterministically simulate N scan cycles with injected tag overrides or raw ADC sensor counts (with linear scaling), executing saved IEC 61131-3 ST POUs and validated Haiwell JS scripts in a sandboxed VM with persistent timer/counter state, E-Stop fail-safe de-energization, declarative event triggers, and ISA-18.2 alarm state transitions.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      injectTagValues: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
      injectRawAdcValues: z.record(z.string(), z.number()).optional(),
      steps: z.number().int().min(1).max(50).default(1),
      scanIntervalMs: z.number().int().min(50).max(60000).default(1000),
      eStopTagName: z.string().max(80).optional(),
      enforceEStopSafeState: z.boolean().default(true),
      persistState: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      injectTagValues: { EStop_OK: false },
      steps: 1,
      scanIntervalMs: 1000,
      enforceEStopSafeState: true,
      persistState: false,
    },
    handler: (input, store) => {
      const liveProject = store.getProject(input.projectId);
      // By default simulate on an isolated deep clone so FAT verification doesn't pollute live plant state!
      const targetProject = input.persistState
        ? liveProject
        : (JSON.parse(JSON.stringify(liveProject)) as HaiwellProject);
      const result = runSimulationSteps(targetProject, input);
      if (input.persistState) store.saveProject(liveProject);
      return { isolatedClone: !input.persistState, ...result };
    },
  }),

  // =========================================================================
  // 16. HAIWELL CLOUD SCADA 3.50.x FULL PROJECT BROWSER PARITY TOOLS
  //     (Data group, Operation record, Font manager, RFID, Shape library,
  //      Peripheral, Data reporting server, Cloud platform data monitor, Audio)
  // =========================================================================
  defineTool({
    name: 'haiwell_datagroup_configure',
    domain: 'datalink',
    haiwellFeature: 'Data Group (Batch Variable Collection for Logging & Data Reporting)',
    safetyTier: 'design',
    description:
      'Create or update a Haiwell Cloud Scada Data group that batches validated Variables for cyclic, change-driven, or trigger-driven collection, history tables, and Data reporting server push.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      description: z.string().max(240).optional(),
      tagNames: z.array(z.string().min(1)).min(1),
      collectMode: z.enum(['CYCLIC', 'TAG_TRIGGER', 'ON_CHANGE']).default('CYCLIC'),
      intervalMs: z.number().int().min(100).max(86400000).default(10000),
      triggerTag: z.string().optional(),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'dg_energy_kpi',
      name: 'Energy KPI Data Group',
      tagNames: ['Supply_Temp_C', 'Return_Temp_C'],
      collectMode: 'CYCLIC',
      intervalMs: 5000,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const uniqueTags = [...new Set(input.tagNames)];
      const missing = uniqueTags.filter((tn) => !hasOwnTag(project, tn));
      if (missing.length > 0) {
        throw new Error(`Unknown Variable(s) in Data group: ${missing.join(', ')}`);
      }
      if (input.collectMode === 'TAG_TRIGGER') {
        if (!input.triggerTag || !hasOwnTag(project, input.triggerTag)) {
          throw new Error(`TAG_TRIGGER Data group requires an existing triggerTag.`);
        }
      }
      const cfg = {
        id: input.id,
        name: input.name,
        description: input.description,
        tagNames: uniqueTags,
        collectMode: input.collectMode,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
        enabled: input.enabled,
      };
      project.dataGroups = project.dataGroups ?? [];
      const idx = project.dataGroups.findIndex((d) => d.id === cfg.id);
      if (idx >= 0) project.dataGroups[idx] = cfg;
      else project.dataGroups.push(cfg);
      store.saveProject(project);
      return { saved: true, dataGroup: cfg, totalDataGroups: project.dataGroups.length };
    },
  }),

  defineTool({
    name: 'haiwell_operation_record_configure',
    domain: 'security',
    haiwellFeature: 'Operation Record (Operator Audit Trail Policy, Query & CSV Export)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada Operation record policy (which operator actions are captured, retention days, storage target) OR query/export recorded operator audit entries with action/actor filtering.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['CONFIGURE', 'QUERY', 'EXPORT_CSV']).default('CONFIGURE'),
      policy: z
        .object({
          enabled: z.boolean().default(true),
          recordLogins: z.boolean().default(true),
          recordVariableWrites: z.boolean().default(true),
          recordScreenChanges: z.boolean().default(true),
          recordRecipeTransfers: z.boolean().default(true),
          recordAlarmAcks: z.boolean().default(true),
          retentionDays: z.number().int().min(1).max(3650).default(180),
          maxRecords: z.number().int().min(100).max(5000000).default(100000),
          storageTarget: z.enum(['LOCAL_SQLITE', 'SD_CARD', 'USB_STORAGE']).default('LOCAL_SQLITE'),
        })
        .optional(),
      filterActor: z.string().optional(),
      filterAction: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'QUERY', limit: 20 },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'CONFIGURE') {
        if (!input.policy) throw new Error('CONFIGURE requires policy object.');
        project.operationRecordPolicy = { ...input.policy };
        project.security.auditTrailEnabled = input.policy.enabled;
        store.saveProject(project);
        return { updated: true, operationRecordPolicy: project.operationRecordPolicy };
      }
      let rows = [...project.auditLog];
      if (input.filterActor) {
        const needle = input.filterActor.toLowerCase();
        rows = rows.filter((r) => r.actor.toLowerCase().includes(needle));
      }
      if (input.filterAction) {
        const needle = input.filterAction.toLowerCase();
        rows = rows.filter((r) => r.action.toLowerCase().includes(needle));
      }
      const sliced = rows.slice(-input.limit);
      if (input.action === 'EXPORT_CSV') {
        const header = 'id,timestamp,actor,action,target,outcome,detail';
        const csvRows = sliced.map((r) =>
          [
            escapeCsvCell(r.id, true),
            escapeCsvCell(r.timestamp),
            escapeCsvCell(r.actor, true),
            escapeCsvCell(r.action, true),
            escapeCsvCell(r.target, true),
            escapeCsvCell(r.outcome),
            escapeCsvCell(r.detail, true),
          ].join(',')
        );
        return { count: sliced.length, csv: [header, ...csvRows].join('\n') };
      }
      return { policy: project.operationRecordPolicy, totalMatches: rows.length, records: sliced };
    },
  }),

  defineTool({
    name: 'haiwell_font_manager',
    domain: 'hmi',
    haiwellFeature: 'Font Manager (Embedded HMI Panel Fonts & Charset Packaging)',
    safetyTier: 'design',
    description:
      'Register or list fonts in Haiwell Cloud Scada Font manager (e.g. Microsoft Sans Serif, Noto Sans CJK) with point size, charset, and HMI package embedding so B7H/C10 panels render text without clipping or glyph fallback.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['UPSERT', 'LIST']).default('UPSERT'),
      font: z
        .object({
          id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
          familyName: z.string().min(2).max(80),
          defaultSizePt: z.number().int().min(8).max(72).default(12),
          weight: z.enum(['NORMAL', 'BOLD']).default('NORMAL'),
          charset: z.enum(['ASCII', 'LATIN_EXT', 'CJK_SIMPLIFIED', 'UNICODE_FULL']).default('LATIN_EXT'),
          embedInHmiPackage: z.boolean().default(true),
          fallbackFamily: z.string().max(80).optional(),
        })
        .optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      action: 'UPSERT',
      font: {
        id: 'font_cjk_ui',
        familyName: 'Noto Sans SC',
        defaultSizePt: 14,
        charset: 'CJK_SIMPLIFIED',
        embedInHmiPackage: true,
      },
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      project.fonts = project.fonts ?? [];
      if (input.action === 'LIST') {
        return { projectId: project.id, fonts: project.fonts };
      }
      if (!input.font) throw new Error('UPSERT requires font definition.');
      const idx = project.fonts.findIndex((f) => f.id === input.font!.id);
      if (idx >= 0) project.fonts[idx] = input.font;
      else project.fonts.push(input.font);
      store.saveProject(project);
      return { saved: true, font: input.font, totalFonts: project.fonts.length };
    },
  }),

  defineTool({
    name: 'haiwell_rfid_configure',
    domain: 'security',
    haiwellFeature: 'RFID Card Reader & Operator Badge Auto-Login',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada RFID module: USB/Serial/TCP card reader binding, UID STRING Variable & card-present BOOL Variable checks, badge-to-User-Security-Group mapping, and auto-logout timeout.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      enabled: z.boolean().default(true),
      transport: z.enum(['USB_HID', 'SERIAL_COM', 'TCP_READER']).default('USB_HID'),
      portOrHost: z.string().min(2).max(120).default('USB0'),
      baudRate: z.number().int().min(1200).max(115200).optional(),
      uidTargetTag: z.string().optional(),
      cardPresentTag: z.string().optional(),
      autoLoginEnabled: z.boolean().default(true),
      autoLogoutOnRemoveSec: z.number().int().min(0).max(3600).default(30),
      cards: z
        .array(
          z.object({
            cardUid: z.string().regex(/^[A-Fa-f0-9:-]{4,32}$/, 'Card UID must be hex/colon/dash (4-32 chars)'),
            userName: z.string().min(1).max(64),
            userGroup: z.string().min(1).max(64),
            enabled: z.boolean().default(true),
          })
        )
        .default([]),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      enabled: true,
      transport: 'USB_HID',
      portOrHost: 'USB0',
      autoLoginEnabled: true,
      cards: [{ cardUid: '04A2B91C', userName: 'LineLead_01', userGroup: 'Operators', enabled: true }],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.uidTargetTag) {
        const t = getOwnTag(project, input.uidTargetTag);
        if (!t) throw new Error(`RFID uidTargetTag "${input.uidTargetTag}" does not exist.`);
        if (t.dataType !== 'STRING' && t.dataType !== 'UINT32' && t.dataType !== 'INT32') {
          throw new Error(`RFID uidTargetTag "${input.uidTargetTag}" must be STRING, UINT32, or INT32.`);
        }
      }
      if (input.cardPresentTag) {
        const t = getOwnTag(project, input.cardPresentTag);
        if (!t) throw new Error(`RFID cardPresentTag "${input.cardPresentTag}" does not exist.`);
        if (t.dataType !== 'BOOL') {
          throw new Error(`RFID cardPresentTag "${input.cardPresentTag}" must be BOOL.`);
        }
      }
      const knownGroups = new Set(project.security.userGroups.map((g) => g.groupName));
      for (const card of input.cards) {
        if (!knownGroups.has(card.userGroup)) {
          throw new Error(
            `RFID card "${card.cardUid}" references unknown User security group "${card.userGroup}". Known groups: ${[...knownGroups].join(', ')}`
          );
        }
      }
      project.rfid = {
        enabled: input.enabled,
        transport: input.transport,
        portOrHost: input.portOrHost,
        baudRate: input.baudRate,
        uidTargetTag: input.uidTargetTag,
        cardPresentTag: input.cardPresentTag,
        autoLoginEnabled: input.autoLoginEnabled,
        autoLogoutOnRemoveSec: input.autoLogoutOnRemoveSec,
        cards: input.cards,
      };
      store.saveProject(project);
      return { configured: true, rfid: project.rfid };
    },
  }),

  defineTool({
    name: 'haiwell_shape_library_manage',
    domain: 'hmi',
    haiwellFeature: 'Shape Library (Custom Vector/SVG & Multi-State Equipment Graphics)',
    safetyTier: 'design',
    description:
      'Register or list custom industrial equipment shapes in Haiwell Cloud Scada Shape library (pumps, valves, conveyors, switchgear, sensors) with strict SVG XSS sanitization (<script> and event handlers rejected).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['UPSERT', 'LIST']).default('UPSERT'),
      shape: z
        .object({
          id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
          name: z.string().min(2).max(100),
          category: z.enum(['PUMP', 'VALVE', 'TANK', 'MOTOR', 'CONVEYOR', 'SWITCHGEAR', 'SENSOR', 'CUSTOM']),
          format: z.enum(['SVG', 'PNG_REF', 'MULTI_STATE_VECTOR']).default('SVG'),
          width: z.number().int().min(16).max(1024).default(96),
          height: z.number().int().min(16).max(1024).default(96),
          stateCount: z.number().int().min(1).max(32).default(2),
          svgMarkup: z.string().max(50000).optional(),
          assetPath: z.string().max(260).optional(),
        })
        .optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      action: 'UPSERT',
      shape: {
        id: 'shp_breaker_iec',
        name: 'IEC Circuit Breaker',
        category: 'SWITCHGEAR',
        format: 'SVG',
        width: 64,
        height: 64,
        stateCount: 3,
        svgMarkup: '<svg viewBox="0 0 64 64"><rect x="12" y="12" width="40" height="40" fill="none" stroke="#334155" stroke-width="4"/></svg>',
      },
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      project.shapeLibrary = project.shapeLibrary ?? [];
      if (input.action === 'LIST') {
        return { projectId: project.id, shapes: project.shapeLibrary };
      }
      if (!input.shape) throw new Error('UPSERT requires shape object.');
      if (input.shape.svgMarkup) {
        const svgError = validateSafeSvgMarkup(input.shape.svgMarkup);
        if (svgError) {
          throw new Error(`SVG_SECURITY_REJECTED: ${svgError}`);
        }
      }
      const idx = project.shapeLibrary.findIndex((s) => s.id === input.shape!.id);
      if (idx >= 0) project.shapeLibrary[idx] = input.shape;
      else project.shapeLibrary.push(input.shape);
      store.saveProject(project);
      return { saved: true, shape: input.shape, totalShapes: project.shapeLibrary.length };
    },
  }),

  defineTool({
    name: 'haiwell_peripheral_configure',
    domain: 'operations',
    haiwellFeature: 'Peripheral Devices (Printers, Barcode/QR Scanners, USB/SD Storage, 4G Modem)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada Peripheral hardware (ESC-POS/network thermal printers, USB/RS232 barcode/QR scanners bound to STRING Variables, USB/SD storage auto-backup, and 4G/serial modems).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      kind: z.enum(['PRINTER', 'BARCODE_SCANNER', 'USB_STORAGE', 'SD_CARD', 'MODEM_4G', 'SERIAL_PORT']),
      connection: z.enum(['USB', 'SERIAL_RS232', 'SERIAL_RS485', 'ETHERNET', 'INTERNAL_SLOT']),
      portOrAddress: z.string().min(1).max(120),
      baudRate: z.number().int().min(1200).max(115200).optional(),
      targetTagName: z.string().optional(),
      driverModel: z.string().max(80).optional(),
      autoBackupEnabled: z.boolean().optional(),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'per_label_printer',
      name: 'Packing Line Zebra Printer',
      kind: 'PRINTER',
      connection: 'ETHERNET',
      portOrAddress: '192.168.1.210:9100',
      driverModel: 'ZPL-II',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.targetTagName) {
        const tag = getOwnTag(project, input.targetTagName);
        if (!tag) throw new Error(`Peripheral targetTagName "${input.targetTagName}" does not exist.`);
        if (input.kind === 'BARCODE_SCANNER' && tag.dataType !== 'STRING') {
          throw new Error(`BARCODE_SCANNER targetTagName "${input.targetTagName}" must be STRING.`);
        }
      }
      const per = {
        id: input.id,
        name: input.name,
        kind: input.kind,
        connection: input.connection,
        portOrAddress: input.portOrAddress,
        baudRate: input.baudRate,
        targetTagName: input.targetTagName,
        driverModel: input.driverModel,
        autoBackupEnabled: input.autoBackupEnabled,
        enabled: input.enabled,
      };
      project.peripherals = project.peripherals ?? [];
      const idx = project.peripherals.findIndex((p) => p.id === per.id);
      if (idx >= 0) project.peripherals[idx] = per;
      else project.peripherals.push(per);
      store.saveProject(project);
      return { saved: true, peripheral: per, totalPeripherals: project.peripherals.length };
    },
  }),

  defineTool({
    name: 'haiwell_data_reporting_server_configure',
    domain: 'datalink',
    haiwellFeature: 'Data Reporting Server (Data Group Push to MES/ERP/Cloud with Offline Buffer)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada Data reporting server to push one or more Data groups over HTTP REST, MQTT, SQL, or Custom TCP with SSRF host validation, TLS enforcement, and SQLite offline store-and-forward buffering.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      protocol: z.enum(['HTTP_REST', 'MQTT', 'SQL_DIRECT', 'CUSTOM_TCP']),
      endpointUrl: z.string().min(6).max(300),
      dataGroupIds: z.array(z.string().min(1)).min(1),
      reportMode: z.enum(['CYCLIC', 'ON_CHANGE', 'EVENT_TRIGGER']).default('CYCLIC'),
      intervalMs: z.number().int().min(500).max(86400000).default(30000),
      tlsRequired: z.boolean().default(true),
      offlineBufferEnabled: z.boolean().default(true),
      offlineBufferMaxRecords: z.number().int().min(100).max(1000000).default(50000),
      retryIntervalSec: z.number().int().min(5).max(3600).default(30),
      authMode: z.enum(['NONE', 'BEARER', 'BASIC', 'API_KEY']).default('BEARER'),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'drs_mes_cloud',
      name: 'MES Telemetry Reporting Server',
      protocol: 'HTTP_REST',
      endpointUrl: 'https://mes.example.com/api/v1/ingest',
      dataGroupIds: ['dg_chiller_telemetry'],
      tlsRequired: true,
      offlineBufferEnabled: true,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const knownGroups = new Set((project.dataGroups ?? []).map((dg) => dg.id));
      const missingGroups = input.dataGroupIds.filter((id) => !knownGroups.has(id));
      if (missingGroups.length > 0) {
        throw new Error(`Unknown Data group ID(s): ${missingGroups.join(', ')}. Create them via haiwell_datagroup_configure first.`);
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(input.endpointUrl);
      } catch {
        throw new Error(`Invalid endpointUrl "${input.endpointUrl}".`);
      }
      if (isBlockedSsrfHost(parsedUrl.hostname, { blockLoopback: true })) {
        throw new Error(`SSRF_BLOCKED: Data reporting server host "${parsedUrl.hostname}" is blocked (loopback/metadata).`);
      }
      if (input.tlsRequired && input.protocol === 'HTTP_REST' && parsedUrl.protocol !== 'https:') {
        throw new Error('HTTP_REST Data reporting server with tlsRequired=true must use https://.');
      }
      if (input.tlsRequired && input.protocol === 'MQTT' && parsedUrl.protocol !== 'mqtts:') {
        throw new Error('MQTT Data reporting server with tlsRequired=true must use mqtts://.');
      }
      const cfg = {
        id: input.id,
        name: input.name,
        protocol: input.protocol,
        endpointUrl: input.endpointUrl,
        dataGroupIds: [...new Set(input.dataGroupIds)],
        reportMode: input.reportMode,
        intervalMs: input.intervalMs,
        tlsRequired: input.tlsRequired,
        offlineBufferEnabled: input.offlineBufferEnabled,
        offlineBufferMaxRecords: input.offlineBufferMaxRecords,
        retryIntervalSec: input.retryIntervalSec,
        authMode: input.authMode,
        enabled: input.enabled,
      };
      project.dataReportingServers = project.dataReportingServers ?? [];
      const idx = project.dataReportingServers.findIndex((s) => s.id === cfg.id);
      if (idx >= 0) project.dataReportingServers[idx] = cfg;
      else project.dataReportingServers.push(cfg);
      store.saveProject(project);
      return { saved: true, dataReportingServer: cfg };
    },
  }),

  defineTool({
    name: 'haiwell_cloud_monitor_configure',
    domain: 'datalink',
    haiwellFeature: 'Cloud Platform Data Monitor (Haiwell Cloud / HaiwellLink Remote Web & App)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada Cloud platform data monitor: machine code, network project port (8888), Web/Mobile SCADA remote access, and exposed read/write Variables with RO and SIL3 remote-write safety guardrails.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      enabled: z.boolean().default(true),
      platform: z.enum(['HAIWELL_CLOUD', 'HAIWELL_PRIVATE_CLOUD', 'HAIWELL_LINK_LAN']).default('HAIWELL_CLOUD'),
      machineCode: z.string().min(4).max(64),
      networkProjectPort: z.number().int().min(1024).max(65535).default(8888),
      webScadaEnabled: z.boolean().default(true),
      mobileAppEnabled: z.boolean().default(true),
      remoteAlarmPushEnabled: z.boolean().default(true),
      monitoredTags: z
        .array(
          z.object({
            tagName: z.string().min(1),
            allowRemoteWrite: z.boolean().default(false),
            groupLabel: z.string().max(64).optional(),
          })
        )
        .default([]),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      enabled: true,
      platform: 'HAIWELL_CLOUD',
      machineCode: 'HW-B7H-8849201',
      networkProjectPort: 8888,
      monitoredTags: [{ tagName: 'Supply_Temp_C', allowRemoteWrite: false, groupLabel: 'Chiller' }],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      for (const m of input.monitoredTags) {
        const tag = getOwnTag(project, m.tagName);
        if (!tag) throw new Error(`Unknown monitored Variable "${m.tagName}".`);
        if (m.allowRemoteWrite && tag.access === 'RO') {
          throw new Error(`SAFETY_BLOCKED: Cannot enable cloud remote write on read-only Variable "${m.tagName}".`);
        }
        if (m.allowRemoteWrite && tag.safetyClass === 'SIL3') {
          throw new Error(`SAFETY_BLOCKED: Cannot expose SIL3 safety Variable "${m.tagName}" for remote cloud writes.`);
        }
      }
      project.cloudEnabled = input.enabled;
      project.networkProjectPort = input.networkProjectPort;
      project.cloudMonitor = {
        enabled: input.enabled,
        platform: input.platform,
        machineCode: input.machineCode,
        networkProjectPort: input.networkProjectPort,
        webScadaEnabled: input.webScadaEnabled,
        mobileAppEnabled: input.mobileAppEnabled,
        remoteAlarmPushEnabled: input.remoteAlarmPushEnabled,
        monitoredTags: input.monitoredTags,
      };
      store.saveProject(project);
      return { configured: true, cloudMonitor: project.cloudMonitor };
    },
  }),

  defineTool({
    name: 'haiwell_audio_configure',
    domain: 'operations',
    haiwellFeature: 'Audio Manager (WAV/MP3 Clips & Voice TTS Alarm Playback)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Cloud Scada Audio module: register WAV/MP3 files or Voice TTS announcements bound to BOOL trigger Variables or ISA-18.2 alarm priorities with volume and repeat count.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      sourceType: z.enum(['WAV_FILE', 'MP3_FILE', 'VOICE_TTS']),
      filePathOrTtsText: z.string().min(1).max(300),
      volumePercent: z.number().int().min(0).max(100).default(85),
      repeatCount: z.number().int().min(1).max(20).default(2),
      triggerTag: z.string().optional(),
      alarmPriority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      enabled: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'aud_estop_voice',
      name: 'Emergency Stop Voice Alert',
      sourceType: 'VOICE_TTS',
      filePathOrTtsText: 'Attention: Emergency stop activated on chiller line.',
      volumePercent: 100,
      repeatCount: 3,
      alarmPriority: 1,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.triggerTag && !hasOwnTag(project, input.triggerTag)) {
        throw new Error(`Audio triggerTag "${input.triggerTag}" does not exist.`);
      }
      if (input.sourceType === 'WAV_FILE' && !/\.wav$/i.test(input.filePathOrTtsText)) {
        throw new Error(`WAV_FILE audio clip must end with .wav.`);
      }
      if (input.sourceType === 'MP3_FILE' && !/\.mp3$/i.test(input.filePathOrTtsText)) {
        throw new Error(`MP3_FILE audio clip must end with .mp3.`);
      }
      const clip = {
        id: input.id,
        name: input.name,
        sourceType: input.sourceType,
        filePathOrTtsText: input.filePathOrTtsText,
        volumePercent: input.volumePercent,
        repeatCount: input.repeatCount,
        triggerTag: input.triggerTag,
        alarmPriority: input.alarmPriority,
        enabled: input.enabled,
      };
      project.audioClips = project.audioClips ?? [];
      const idx = project.audioClips.findIndex((a) => a.id === clip.id);
      if (idx >= 0) project.audioClips[idx] = clip;
      else project.audioClips.push(clip);
      store.saveProject(project);
      return { saved: true, audioClip: clip, totalAudioClips: project.audioClips.length };
    },
  }),

  // =========================================================================
  // 17. LIVE WINDOWS DESKTOP AUTOMATION BRIDGE (Scada.Develop.exe)
  // =========================================================================
  defineTool({
    name: 'haiwell_desktop_inspect',
    domain: 'hmi',
    haiwellFeature: 'Haiwell Cloud Scada Desktop Installation & Localized UI Label Inspector',
    safetyTier: 'read',
    description:
      'Inspect the local Windows HaiwellScada3 installation directory, locate Scada.Develop.exe, read config.ini language settings, and parse Language/*.lng to resolve localized UI menu/dialog labels.',
    inputSchema: z
      .object({
        installDir: z.string().max(260).optional(),
      })
      .strict(),
    sampleInput: {},
    handler: (input) => inspectHaiwellDesktopInstallation(input.installDir),
  }),

  defineTool({
    name: 'haiwell_desktop_launch',
    domain: 'hmi',
    haiwellFeature: 'Splash-Safe Haiwell Cloud Scada Desktop Launcher & Window Attacher',
    safetyTier: 'design',
    description:
      'Launch Scada.Develop.exe (or attach to an already-running instance), wait strictly for the main "Haiwell Cloud Scada" window (skipping the startup splash screen), and optionally open an existing .hwdev file. On non-Windows hosts or when dryRun=true, returns the verified PowerShell script without executing.',
    inputSchema: z
      .object({
        installDir: z.string().max(260).optional(),
        projectFilePath: z.string().max(300).optional(),
        timeoutSec: z.number().int().min(5).max(120).default(25),
        dryRun: z.boolean().default(false),
      })
      .strict(),
    sampleInput: { timeoutSec: 25, dryRun: true },
    handler: async (input) => launchHaiwellDesktop(input),
  }),

  defineTool({
    name: 'haiwell_desktop_new_project',
    domain: 'hmi',
    haiwellFeature: 'Windows UIA New .hwdev Project Wizard Automator',
    safetyTier: 'design',
    description:
      'Automate creating a new .hwdev project inside a running Haiwell Cloud Scada desktop window using UIA MenuItem traversal, adjacent-Label ComboBox selection (runtime platform, device model, resolution), network port configuration, and try/finally clipboard restoration. Supports dryRun=true and non-Windows script generation.',
    inputSchema: z.object({
      projectName: z
        .string()
        .min(1)
        .max(50, 'Haiwell project name length limit is 50 characters.')
        .refine((v) => !/[,|=]/.test(v), 'Haiwell project name cannot contain illegal characters (, | =).'),
      saveDirectory: z.string().max(300).optional(),
      runtimePlatform: z.string().min(1).max(64).default('Cloud HMI'),
      deviceModel: z.string().min(1).max(64).default('Haiwell HMI B7H'),
      resolution: z.string().min(3).max(32).default('1024x600'),
      networkProjectPort: z.number().int().min(1024).max(65535).default(8888),
      installDir: z.string().max(260).optional(),
      dryRun: z.boolean().default(false),
    }),
    sampleInput: {
      projectName: 'Chiller_Plant_01',
      runtimePlatform: 'Cloud HMI',
      deviceModel: 'Haiwell HMI B7H',
      resolution: '1024x600',
      networkProjectPort: 8888,
      dryRun: true,
    },
    handler: async (input) => createNewHaiwellProjectOnDesktop(input),
  }),

  defineTool({
    name: 'haiwell_desktop_deploy_hwexport',
    domain: 'hmi',
    haiwellFeature: 'Zero-Touch Headless .hwExport Direct Deployer into Haiwell .hwdev',
    safetyTier: 'design',
    description:
      'Compiles the project to official Haiwell .hwExport XML (with WordSw->$ShowWindowId navigation, embedded PNG icons, optional variable groups & tasks) and imports it DIRECTLY and HEADLESSLY into the target encrypted .hwdev via Haiwell 3.50.x official 32-bit .NET assemblies — zero GUI, zero mouse/keyboard, zero UAC, zero Python, with automatic .hwdev.bak backup and rollback on error. Supports dryRun=true and legacy watcher_or_bat fallback.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      hwdevPath: z.string().min(1).max(300),
      outputDir: z.string().min(1).max(300),
      inboxDir: z.string().max(300).optional(),
      installDir: z.string().max(260).optional(),
      fileName: z.string().max(120).optional(),
      screenIds: z.array(z.string()).optional(),
      startWindowId: z.number().int().min(1).max(9999).default(2),
      language: z.enum(['en_0', 'zh_0']).default('en_0'),
      variableFullNameOverrides: z.record(z.string(), z.string()).optional(),
      exportVariableGroups: z
        .array(
          z.object({
            groupName: z.string().min(1).max(80),
            tagNames: z.array(z.string().min(1)).min(1),
          })
        )
        .optional(),
      exportTasks: z
        .array(
          z.object({
            name: z.string().min(1).max(80),
            script: z.string(),
            memo: z.string().max(200).optional(),
          })
        )
        .optional(),
      deleteWindowPrefixes: z.array(z.string()).optional(),
      enableAlwaysCollectFullNames: z.array(z.string().min(1)).optional(),
      upsertTasks: z
        .array(
          z.object({
            name: z.string().min(1).max(80),
            script: z.string(),
            memo: z.string().max(200).optional(),
          })
        )
        .optional(),
      replaceExistingVariableGroups: z.boolean().default(true),
      deployMode: z.enum(['auto', 'headless', 'watcher_or_bat']).default('auto'),
      createBackup: z.boolean().default(true),
      dryRun: z.boolean().default(false),
      waitTimeoutMs: z.number().int().min(1000).max(120000).default(45000),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      hwdevPath: 'C:\\Users\\<user>\\Documents\\Haiwell Scada\\Temporary\\Project1.hwdev',
      outputDir: 'C:\\Users\\<user>\\Documents\\haiwell_exports',
      startWindowId: 2,
      dryRun: true,
    },
    handler: async (input, store) => {
      const project = store.getProject(input.projectId);
      const resolvedVarGroups = input.exportVariableGroups?.map((vg) => ({
        groupName: vg.groupName,
        tags: vg.tagNames.map((tn) => {
          const found = getOwnTag(project, tn);
          if (!found) {
            throw new Error(`TAG_NOT_FOUND: Tag "${tn}" referenced in exportVariableGroups "${vg.groupName}" does not exist.`);
          }
          return found;
        }),
      }));
      const compiled = compileProjectToHwExport(project, {
        screenIds: input.screenIds,
        startWindowId: input.startWindowId,
        language: input.language,
        variableFullNameOverrides: input.variableFullNameOverrides,
        exportVariableGroups: resolvedVarGroups,
        exportTasks: input.exportTasks,
      });
      const deployment = await deployHwExportToDesktop({
        xml: compiled.xml,
        fileName: input.fileName ?? compiled.fileName,
        hwdevPath: input.hwdevPath,
        outputDir: input.outputDir,
        inboxDir: input.inboxDir,
        installDir: input.installDir,
        deleteWindowPrefixes: input.deleteWindowPrefixes,
        enableAlwaysCollectFullNames: input.enableAlwaysCollectFullNames,
        upsertTasks: input.upsertTasks,
        replaceExistingVariableGroups: input.replaceExistingVariableGroups,
        deployMode: input.deployMode,
        createBackup: input.createBackup,
        dryRun: input.dryRun,
        waitTimeoutMs: input.waitTimeoutMs,
      });
      return {
        screensExported: compiled.screensExported,
        widgetsExported: compiled.widgetsExported,
        variablesBound: compiled.variablesBound,
        ...deployment,
      };
    },
  }),
];

const SAFE_SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'marker', 'pattern', 'filter',
  'fegaussianblur', 'feoffset', 'feblend', 'fedropshadow', 'fecolormatrix',
]);

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16) || 0))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10) || 0))
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n')
    .replace(/&lt;?/gi, '<')
    .replace(/&gt;?/gi, '>')
    .replace(/&quot;?/gi, '"')
    .replace(/&apos;?/gi, "'")
    .replace(/&amp;?/gi, '&');
}

function validateSafeSvgMarkup(svg: string): string | null {
  if (/<!(?:DOCTYPE|ENTITY|\[CDATA\[)/i.test(svg) || /<\?xml-stylesheet\b/i.test(svg)) {
    return 'SVG markup cannot contain DOCTYPE, ENTITY, CDATA, or xml-stylesheet directives.';
  }
  // Remove XML comments before tag/attribute parsing
  const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
  const tagRegex = /<\s*\/?\s*([a-zA-Z_][a-zA-Z0-9_:-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;
  let sawSvgRoot = false;
  while ((match = tagRegex.exec(stripped)) !== null) {
    const rawTag = match[1];
    const attrsRaw = match[2] ?? '';
    const localTag = (rawTag.includes(':') ? rawTag.split(':').pop()! : rawTag).toLowerCase();
    if (localTag === 'svg') sawSvgRoot = true;
    if (!SAFE_SVG_TAGS.has(localTag)) {
      return `Disallowed SVG/XML element <${rawTag}> (only static vector graphics elements are permitted).`;
    }
    const attrRegex = /([a-zA-Z_][a-zA-Z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsRaw)) !== null) {
      const attrNameRaw = attrMatch[1];
      const attrName = (attrNameRaw.includes(':') ? attrNameRaw.split(':').pop()! : attrNameRaw).toLowerCase();
      const attrValRaw = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      const decodedVal = decodeXmlEntities(attrValRaw);
      const compactVal = decodedVal.replace(/[\u0000-\u0020]+/g, '').toLowerCase();

      if (attrName.startsWith('on')) {
        return `Inline event handler attribute "${attrNameRaw}" is forbidden in SVG markup.`;
      }
      if (attrName === 'style') {
        return 'Inline style attributes are forbidden in SVG shapes; use explicit SVG presentation attributes (fill, stroke, opacity).';
      }
      if (attrName === 'href' || attrName === 'src' || attrName === 'from' || attrName === 'to' || attrName === 'values') {
        if (
          compactVal.includes('javascript:') ||
          compactVal.includes('vbscript:') ||
          compactVal.includes('data:') ||
          (attrName === 'href' && !/^#[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(decodedVal.trim()))
        ) {
          return `Forbidden URI/reference in attribute "${attrNameRaw}" (only local #id fragment references are allowed).`;
        }
      }
      if (compactVal.includes('javascript:') || compactVal.includes('vbscript:') || compactVal.includes('data:text/html')) {
        return `Attribute "${attrNameRaw}" contains a forbidden script URI scheme.`;
      }
    }
  }
  if (!sawSvgRoot) {
    return 'SVG markup must contain a valid <svg> root element.';
  }
  return null;
}

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const NON_IDEMPOTENT_TOOLS = new Set([
  'haiwell_project_create',
  'haiwell_project_snapshot_rollback',
  'haiwell_entity_delete',
  'haiwell_tag_read_write',
  'haiwell_tag_batch_write',
  'haiwell_alarm_manage',
  'haiwell_recipe_manage',
  'haiwell_simulation_step',
  'haiwell_mqtt_exchange',
  'haiwell_opcua_browse_read_write',
  'haiwell_desktop_launch',
  'haiwell_desktop_new_project',
  'haiwell_desktop_deploy_hwexport',
]);

export function getToolAnnotations(tool: HaiwellToolDefinition): McpToolAnnotations {
  const isRead = tool.safetyTier === 'read';
  const isDestructive =
    tool.name === 'haiwell_entity_delete' ||
    tool.name === 'haiwell_project_snapshot_rollback' ||
    tool.safetyTier === 'control_guarded' ||
    tool.name === 'haiwell_mqtt_exchange' ||
    tool.name === 'haiwell_opcua_browse_read_write';
  const isIdempotent =
    isRead ||
    (!NON_IDEMPOTENT_TOOLS.has(tool.name) &&
      /(_upsert|_upsert_batch|_configure|_bind|_define|_save|_map|_policy|_solve|_library_manage)$/.test(tool.name));
  const isOpenWorld =
    tool.name === 'haiwell_mqtt_exchange' ||
    tool.name === 'haiwell_webhook_configure' ||
    tool.name === 'haiwell_data_reporting_server_configure' ||
    tool.name === 'haiwell_cloud_transparent_tunnel' ||
    tool.name === 'haiwell_desktop_launch' ||
    tool.name === 'haiwell_desktop_new_project' ||
    tool.name === 'haiwell_desktop_deploy_hwexport';

  return {
    title: tool.haiwellFeature,
    readOnlyHint: isRead,
    destructiveHint: isDestructive,
    idempotentHint: isIdempotent,
    openWorldHint: isOpenWorld,
  };
}

export type ToolProfile = 'all' | 'core' | 'hmi' | 'plc' | 'iiot';

const CORE_PROFILE_TOOLS = new Set([
  'haiwell_project_create',
  'haiwell_project_inspect',
  'haiwell_project_snapshot_rollback',
  'haiwell_project_audit_safety',
  'haiwell_project_export',
  'haiwell_device_add',
  'haiwell_tag_upsert_batch',
  'haiwell_tag_read_write',
  'haiwell_iec61131_validate',
  'haiwell_iec61131_pou_save',
  'haiwell_hmi_pid_compile',
  'haiwell_hmi_spatial_verify',
  'haiwell_alarm_configure',
  'haiwell_simulation_step',
]);

const PROFILE_DOMAINS: Record<Exclude<ToolProfile, 'all' | 'core'>, Set<HaiwellDomain>> = {
  hmi: new Set(['project', 'tags', 'hmi', 'trends', 'recipes']),
  plc: new Set(['project', 'devices', 'tags', 'iec61131', 'scripts', 'simulation']),
  iiot: new Set(['project', 'tags', 'mqtt', 'opcua', 'datalink', 'alarms', 'security', 'operations']),
};

export function resolveToolProfile(raw?: string): ToolProfile {
  const norm = (raw ?? 'all').trim().toLowerCase();
  if (norm === 'core' || norm === 'hmi' || norm === 'plc' || norm === 'iiot') return norm;
  return 'all';
}

export function getToolsForProfile(profile: ToolProfile = 'all'): HaiwellToolDefinition[] {
  if (profile === 'all') return HAIWELL_TOOLS;
  if (profile === 'core') return HAIWELL_TOOLS.filter((t) => CORE_PROFILE_TOOLS.has(t.name));
  const domains = PROFILE_DOMAINS[profile];
  return HAIWELL_TOOLS.filter((t) => domains.has(t.domain));
}

export function serializeToolCatalog(profile: ToolProfile = 'all') {
  return getToolsForProfile(profile).map((tool) => {
    const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    if (tool.safetyTier !== 'read' && schema && typeof schema.properties === 'object' && schema.properties !== null) {
      schema.properties = {
        ...(schema.properties as Record<string, unknown>),
        idempotencyKey: {
          type: 'string',
          description: 'Optional client-supplied idempotency key for safe retries.',
        },
        expectedRevision: {
          type: 'integer',
          description: 'Optional optimistic concurrency guard matching project.revision.',
        },
      };
    }
    return {
      name: tool.name,
      domain: tool.domain,
      haiwellFeature: tool.haiwellFeature,
      safetyTier: tool.safetyTier,
      description: tool.description,
      annotations: getToolAnnotations(tool),
      inputSchema: schema,
      sampleInput: tool.sampleInput,
    };
  });
}

/**
 * Deterministic SHA-256 fingerprint of tool definitions (names, descriptions,
 * annotations, JSON schemas) so enterprise MCP clients/gateways can pin definitions
 * and detect mid-session "rug-pull" tool-poisoning mutations.
 */
export function computeToolCatalogHash(profile: ToolProfile = 'all'): string {
  const canonical = serializeToolCatalog(profile).map((t) => ({
    name: t.name,
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.inputSchema,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface InvokeToolResult {
  [key: string]: unknown;
  ok: boolean;
  tool: string;
  domain?: HaiwellDomain;
  safetyTier?: ToolSafetyTier;
  executionMs: number;
  idempotentReplay?: boolean;
  data?: unknown;
  error?: { code: string; message: string; issues?: unknown };
}

const idempotencyCaches = new WeakMap<HaiwellProjectStore, Map<string, InvokeToolResult>>();

function getIdempotencyCache(store: HaiwellProjectStore): Map<string, InvokeToolResult> {
  let cache = idempotencyCaches.get(store);
  if (!cache) {
    cache = new Map<string, InvokeToolResult>();
    idempotencyCaches.set(store, cache);
  }
  return cache;
}

function stableJsonForHash(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJsonForHash(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonForHash(obj[k])}`).join(',')}}`;
}

function resolveTargetProjectId(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'haiwell_entity_delete' && args.entityType === 'project' && typeof args.entityId === 'string') {
    return args.entityId;
  }
  if (toolName === 'haiwell_project_create' && typeof args.id === 'string') {
    return args.id;
  }
  if (typeof args.projectId === 'string' && args.projectId.trim().length > 0) {
    return args.projectId.trim();
  }
  return DEFAULT_PROJECT_ID;
}

export async function invokeHaiwellTool(
  toolName: string,
  rawArgs: unknown,
  store: HaiwellProjectStore
): Promise<InvokeToolResult> {
  const start = performance.now();
  const tool = HAIWELL_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return {
      ok: false,
      tool: toolName,
      executionMs: Number((performance.now() - start).toFixed(3)),
      error: {
        code: 'TOOL_NOT_FOUND',
        message: `Unknown MCP tool "${toolName}". Call tools/list to inspect all ${HAIWELL_TOOLS.length} Haiwell tools.`,
      },
    };
  }

  const normalizedArgs = normalizeAgentArgs(rawArgs);

  // Extract optional cross-cutting enterprise control headers from arguments before Zod parsing
  const idempotencyKey =
    typeof normalizedArgs.idempotencyKey === 'string' && normalizedArgs.idempotencyKey.trim().length > 0
      ? normalizedArgs.idempotencyKey.trim()
      : undefined;
  const expectedRevision =
    typeof normalizedArgs.expectedRevision === 'number' && Number.isInteger(normalizedArgs.expectedRevision)
      ? normalizedArgs.expectedRevision
      : undefined;

  const argsForSchema: Record<string, unknown> = { ...normalizedArgs };
  delete argsForSchema.idempotencyKey;
  delete argsForSchema.expectedRevision;

  const targetProjectIdPreview = resolveTargetProjectId(tool.name, argsForSchema);
  const argsSha256 = idempotencyKey
    ? crypto.createHash('sha256').update(stableJsonForHash(argsForSchema)).digest('hex').slice(0, 16)
    : '';
  const idempotencyCacheKey = idempotencyKey
    ? `${tool.name}:${targetProjectIdPreview}:${argsSha256}:${idempotencyKey}`
    : undefined;

  if (idempotencyCacheKey) {
    const cached = getIdempotencyCache(store).get(idempotencyCacheKey);
    if (cached) {
      return {
        ...cached,
        executionMs: Number((performance.now() - start).toFixed(3)),
        idempotentReplay: true,
      };
    }
  }

  const parsed = tool.inputSchema.safeParse(argsForSchema);
  if (!parsed.success) {
    return {
      ok: false,
      tool: tool.name,
      domain: tool.domain,
      safetyTier: tool.safetyTier,
      executionMs: Number((performance.now() - start).toFixed(3)),
      error: {
        code: 'SCHEMA_VALIDATION_ERROR',
        message: 'Input payload failed strict Zod schema validation.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      },
    };
  }

  // Optimistic concurrency guard: reject stale writes when expectedRevision != current project.revision
  if (expectedRevision !== undefined && tool.safetyTier !== 'read') {
    const targetProjectId = resolveTargetProjectId(tool.name, parsed.data as Record<string, unknown>);
    try {
      const current = store.getProject(targetProjectId);
      if (current.revision !== expectedRevision) {
        return {
          ok: false,
          tool: tool.name,
          domain: tool.domain,
          safetyTier: tool.safetyTier,
          executionMs: Number((performance.now() - start).toFixed(3)),
          error: {
            code: 'REVISION_CONFLICT',
            message: `Optimistic concurrency conflict on project "${targetProjectId}": expected revision ${expectedRevision}, actual revision is ${current.revision}. Re-read via haiwell_project_inspect before retrying.`,
          },
        };
      }
    } catch {
      // Let handler report project-not-found cleanly if project doesn't exist yet
    }
  }

  try {
    const data = await tool.handler(parsed.data, store);
    const result: InvokeToolResult = {
      ok: true,
      tool: tool.name,
      domain: tool.domain,
      safetyTier: tool.safetyTier,
      executionMs: Number((performance.now() - start).toFixed(3)),
      data,
    };
    if (idempotencyCacheKey) {
      const cache = getIdempotencyCache(store);
      cache.set(idempotencyCacheKey, result);
      if (cache.size > 500) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
      }
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      tool: tool.name,
      domain: tool.domain,
      safetyTier: tool.safetyTier,
      executionMs: Number((performance.now() - start).toFixed(3)),
      error: {
        code: 'EXECUTION_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
