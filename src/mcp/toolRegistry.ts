/**
 * Hardened Single-Source-of-Truth MCP Tool Registry:
 * 47 production-grade tools across 15 Haiwell Cloud SCADA Develop domains.
 * Features LLM-tolerant input normalization (prototype-pollution safe), strict Zod v4 validation,
 * multi-vendor PLC register & multi-word/byte overlap detection, binary type/range guards,
 * spatial HMI P&ID compilation & desktop bridge export, ISA-18.2 deduplicating alarm state machine,
 * atomic batch I/O, snapshots/rollback, full referential-integrity deletion, faceplates, webhooks,
 * and headless FAT simulation.
 */

import { z } from 'zod';
import { HAIWELL_REGISTER_MAP } from './haiwellRegisters';
import {
  applyLinearScaling,
  detectWordOverlapConflicts,
  getWordSpanForType,
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
import {
  auditScreenSpatially,
  compileDesktopAutomationBridge,
  compilePidScreen,
  HAIWELL_HMI_TOOLBOX,
  solveAndRepairScreenLayout,
} from './hmiSpatialEngine';
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
  'TREND_CHART',
  'ALARM_BANNER',
  'RECIPE_SELECTOR',
  'CAMERA_VIEW',
  'DATA_TABLE',
  'NAV_BAR',
  'LABEL',
  'FACEPLATE_INSTANCE',
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
    if (typeof v === 'string') {
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

  return {
    format: 'haiwell-cloud-scada-bundle/v2',
    exportedAt: new Date().toISOString(),
    projectMeta: {
      id: project.id,
      name: project.name,
      version: project.version,
      revision: project.revision,
      targetHardware: project.targetHardware,
      resolution: project.resolution,
      defaultLanguage: project.defaultLanguage,
      cloudEnabled: project.cloudEnabled,
    },
    artifacts: {
      'project.hwsp.json': project,
      'tags.csv': [tagCsvHeader, ...tagCsvRows].join('\n'),
      'opcua/nodeset2.xml': generateOpcUaNodeSet2Xml(project),
      'mqtt/bindings.json': project.mqtt,
      'screens/svg': Object.fromEntries(
        project.screens.map((s) => [`${s.id}.svg`, renderScreenToSvg(s, project.tags)])
      ),
      'plc/pous': Object.fromEntries(project.pous.map((p) => [`${p.name}.${p.language.toLowerCase()}`, p.source])),
      'scripts/js': Object.fromEntries(project.scripts.map((s) => [`${s.name}.js`, s.code])),
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

  // 1. Multi-word & exact register overlap check
  for (const conflict of detectWordOverlapConflicts(project.tags, deviceProtocols)) {
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
        const parsed = validatePlcAddress(deviceProtocols.get(tag.deviceId)!, tag.address);
        if (!parsed.valid) {
          findings.push({
            code: 'AUD-TAG-BAD-ADDR',
            severity: 'CRITICAL',
            domain: 'tags',
            target: tag.name,
            message: parsed.error,
            remediation: parsed.hint,
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

  // 3. Validate HMI screens (collisions, bounds, tags, nav links, touch targets)
  const screenIds = new Set(project.screens.map((s) => s.id));
  for (const screen of project.screens) {
    const res = validateHmiScreen(screen, project.tags, {
      knownScreenIds: screenIds,
      targetHardware: project.targetHardware,
    });
    if (!res.valid) {
      findings.push({
        code: 'AUD-HMI-LAYOUT',
        severity: 'MEDIUM',
        domain: 'hmi',
        target: screen.id,
        message: `Screen "${screen.name}" issues: collisions=${res.collisions.length}, outOfBounds=${res.outOfBounds.length}, unresolvedTags=${res.unresolvedTags.length}, brokenNav=${res.brokenNavTargets.length}, touchTargets=${res.touchTargetViolations.length}.`,
        remediation: 'Regenerate or fix widget geometry, bindings, and navigation links.',
      });
    }
  }

  // 4. Validate JavaScript scripts
  for (const script of project.scripts) {
    const res = validateHaiwellScript(script.code, project.tags, {
      trigger: script.trigger,
      intervalMs: script.intervalMs,
      triggerTag: script.triggerTag,
    });
    if (!res.valid) {
      findings.push({
        code: 'AUD-SCRIPT-INVALID',
        severity: 'HIGH',
        domain: 'scripts',
        target: script.name,
        message: `Script "${script.name}" failed static validation (${res.diagnostics.length} issue(s)).`,
        remediation: 'Run haiwell_script_validate and resolve referenced tags or forbidden APIs.',
      });
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
  for (const ev of project.eventTriggers) {
    if (!hasOwnTag(project, ev.sourceTag)) pushDangling('scripts', `event_trigger:${ev.id}`, ev.sourceTag);
    if (ev.actionType === 'WRITE_TAG' && !hasOwnTag(project, ev.targetId)) {
      pushDangling('scripts', `event_trigger:${ev.id}`, ev.targetId);
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
  const estop = getOwnTag(project, 'EStop_OK');
  if (tag.requiresInterlock && estop && estop.currentValue === false) {
    return {
      ok: false as const,
      blockedBy: 'ESTOP_INTERLOCK_ACTIVE',
      message: `Write to "${tag.name}" blocked: EStop_OK is FALSE.`,
    };
  }
  if (tag.requiresInterlock && !confirmSafetyOverride) {
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
      'Create a new Haiwell Cloud SCADA Develop project targeting PC SCADA, Cloud HMI (C7/C10/B7/B10/A8), Cloud Box (CBOX), or IPC with resolution, language, and security defaults.',
    inputSchema: z.object({
      id: z.string().regex(/^[a-z0-9_-]{3,48}$/, 'Use lowercase alphanumeric, dash, or underscore (3-48 chars)'),
      name: z.string().min(2).max(120),
      targetHardware: z
        .enum(['PC_SCADA', 'CLOUD_HMI_C7', 'CLOUD_HMI_C10', 'CLOUD_HMI_B7', 'CLOUD_HMI_B10', 'CLOUD_HMI_A8', 'CLOUD_BOX_CBOX', 'IPC_SCADA'])
        .default('PC_SCADA'),
      width: z.number().int().min(320).max(3840).default(1280),
      height: z.number().int().min(240).max(2160).default(800),
      defaultLanguage: z.string().min(2).max(12).default('en-US'),
      cloudEnabled: z.boolean().default(true),
      overwrite: z.boolean().default(false),
    }),
    sampleInput: {
      id: 'prj_pump_station_02',
      name: 'Municipal Booster Pump Station',
      targetHardware: 'CLOUD_HMI_C10',
      width: 1024,
      height: 600,
    },
    handler: (input, store) => {
      if (!input.overwrite && store.listProjects().some((p) => p.id === input.id)) {
        throw new Error(
          `PROJECT_ALREADY_EXISTS: Project "${input.id}" already exists. Choose a new id or pass overwrite=true explicitly.`
        );
      }
      const now = new Date().toISOString();
      const project: HaiwellProject = {
        id: input.id,
        name: input.name,
        version: '1.0.0',
        revision: 0,
        targetHardware: input.targetHardware,
        resolution: { width: input.width, height: input.height },
        defaultLanguage: input.defaultLanguage,
        cloudEnabled: input.cloudEnabled,
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
          endpointUrl: `opc.tcp://0.0.0.0:4840/haiwell/${input.id}`,
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
        dataLinks: [],
        schedules: [],
        reports: [],
        cameras: [],
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
        detail: `Created Haiwell project (${project.targetHardware} ${project.resolution.width}x${project.resolution.height}).`,
      });
      return {
        projectId: project.id,
        revision: project.revision,
        name: project.name,
        targetHardware: project.targetHardware,
        resolution: project.resolution,
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
          version: p.version,
          revision: p.revision,
          targetHardware: p.targetHardware,
          resolution: p.resolution,
          cloudEnabled: p.cloudEnabled,
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
          dataLinks: p.dataLinks.map((d) => ({ id: d.id, engine: d.engine, tableName: d.tableName })),
          schedules: p.schedules.map((s) => ({ id: s.id, cron: s.cron, actionType: s.actionType, enabled: s.enabled })),
          reports: p.reports.map((r) => ({ id: r.id, name: r.name, format: r.format })),
          cameras: p.cameras.map((c) => ({ id: c.id, protocol: c.protocol, screenId: c.screenId })),
          languages: Object.keys(p.translations),
          security: { sslBits: p.security.sslBits, abKeyEnabled: p.security.abKeyEnabled, groupCount: p.security.userGroups.length },
        },
        ...(input.includeAllProjects ? { workspaceProjects: store.listProjects() } : {}),
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
        'datalink',
        'schedule',
        'report',
        'camera',
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
        const before = scr.widgets.length;
        scr.widgets = scr.widgets.filter((w) => w.id !== input.entityId);
        if (scr.widgets.length === before) throw new Error(`Widget "${input.entityId}" not found.`);
        store.saveProject(project);
        return { deleted: true, entityType: 'widget', entityId: input.entityId };
      }

      const removeById = <T extends { id: string }>(arr: T[]): T[] => {
        const next = arr.filter((x) => x.id !== input.entityId);
        if (next.length === arr.length) throw new Error(`${input.entityType} "${input.entityId}" not found.`);
        return next;
      };

      switch (input.entityType) {
        case 'pou': project.pous = removeById(project.pous); break;
        case 'faceplate': project.faceplates = removeById(project.faceplates); break;
        case 'script': project.scripts = removeById(project.scripts); break;
        case 'event_trigger': project.eventTriggers = removeById(project.eventTriggers); break;
        case 'webhook': project.webhooks = removeById(project.webhooks); break;
        case 'alarm': project.alarms = removeById(project.alarms); break;
        case 'mqtt_binding': project.mqtt.bindings = removeById(project.mqtt.bindings); break;
        case 'opcua_node': {
          const before = project.opcua.nodes.length;
          project.opcua.nodes = project.opcua.nodes.filter((n) => n.nodeId !== input.entityId);
          if (project.opcua.nodes.length === before) throw new Error(`OPC UA node "${input.entityId}" not found.`);
          break;
        }
        case 'recipe_group': project.recipes = removeById(project.recipes); break;
        case 'trend': project.trends = removeById(project.trends); break;
        case 'datalink': project.dataLinks = removeById(project.dataLinks); break;
        case 'schedule': project.schedules = removeById(project.schedules); break;
        case 'report': project.reports = removeById(project.reports); break;
        case 'camera': project.cameras = removeById(project.cameras); break;
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
        .array(z.enum(['project_json', 'tags_csv', 'opcua_xml', 'mqtt_json', 'hmi_svg', 'pous', 'scripts']))
        .optional(),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, includeArtifacts: ['tags_csv', 'opcua_xml', 'mqtt_json'] },
    handler: (input, store) => {
      const bundle = buildProjectExportBundle(store.getProject(input.projectId));
      if (!input.includeArtifacts || input.includeArtifacts.length === 0) return bundle;
      const selected: Record<string, unknown> = {};
      if (input.includeArtifacts.includes('project_json')) selected['project.hwsp.json'] = bundle.artifacts['project.hwsp.json'];
      if (input.includeArtifacts.includes('tags_csv')) selected['tags.csv'] = bundle.artifacts['tags.csv'];
      if (input.includeArtifacts.includes('opcua_xml')) selected['opcua/nodeset2.xml'] = bundle.artifacts['opcua/nodeset2.xml'];
      if (input.includeArtifacts.includes('mqtt_json')) selected['mqtt/bindings.json'] = bundle.artifacts['mqtt/bindings.json'];
      if (input.includeArtifacts.includes('hmi_svg')) selected['screens/svg'] = bundle.artifacts['screens/svg'];
      if (input.includeArtifacts.includes('pous')) selected['plc/pous'] = bundle.artifacts['plc/pous'];
      if (input.includeArtifacts.includes('scripts')) selected['scripts/js'] = bundle.artifacts['scripts/js'];
      return { ...bundle, artifacts: selected };
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
      stationId: z.number().int().min(1).max(247).default(1),
      pollIntervalMs: z.number().int().min(20).max(60000).default(250),
      timeoutMs: z.number().int().min(100).max(30000).default(1500),
      byteOrder: z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA']).default('CDAB'),
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
        throw new Error('RTU transport requires serialPort (e.g., COM1 or /dev/ttyUSB0).');
      }
      const project = store.getProject(input.projectId);
      const cfg = {
        id: input.id,
        name: input.name,
        protocol: input.protocol,
        transport: input.transport,
        host: input.host,
        port: input.port,
        serialPort: input.serialPort,
        baudRate: input.baudRate,
        dataBits: 8 as const,
        stopBits: 1 as const,
        parity: 'NONE' as const,
        stationId: input.stationId,
        pollIntervalMs: input.pollIntervalMs,
        timeoutMs: input.timeoutMs,
        retryCount: 3,
        byteOrder: input.byteOrder,
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
      'Validate registers for Haiwell PLC (X/Y/M/T/C/S/AI/AQ/V/TV/CV/SV), Modbus (40001/HR:0), Siemens S7 (I0.0/DB1.DBD0), Mitsubishi MC (D100/X0F), Omron FINS (DM100/CIO0.00), BACnet (AI:0), or Allen-Bradley EIP symbolic tags.',
    inputSchema: z.object({
      protocol: z.enum(PLC_PROTOCOLS).default('HAIWELL_PLC_TCP'),
      addresses: z.array(z.string().min(1)).min(1).max(200),
      includeAreaTable: z.boolean().default(false),
    }),
    sampleInput: {
      protocol: 'HAIWELL_PLC_TCP',
      addresses: ['X0', 'Y0', 'M100', 'AI0', 'AQ2', 'V100', 'V100.3', 'SV10'],
    },
    handler: (input) => {
      const results = input.addresses.map((addr) => validatePlcAddress(input.protocol, addr));
      return {
        protocol: input.protocol,
        allValid: results.every((r) => r.valid),
        results,
        ...(input.includeAreaTable ? { haiwellRegisterMap: HAIWELL_REGISTER_MAP } : {}),
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
      const now = new Date().toISOString();
      const errors: { tag: string; code: string; error: string }[] = [];
      const upserted: string[] = [];

      // Candidate map so multi-word overlaps are caught BEFORE committing
      const candidateTags = { ...project.tags };

      for (const t of input.tags) {
        if (FORBIDDEN_PROTO_KEYS.has(t.name) || Object.prototype.hasOwnProperty.call(Object.prototype, t.name)) {
          errors.push({
            tag: t.name,
            code: 'RESERVED_IDENTIFIER',
            error: `Tag name "${t.name}" is a reserved JavaScript Object.prototype identifier.`,
          });
          continue;
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
          const parsed = validatePlcAddress(protocol, t.address);
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
        const existingTag = getOwnTag(project, t.name);
        const proposedInit = t.initialValue ?? existingTag?.currentValue ?? defaultVal;
        const valCheck = validateTagValueForType(t.dataType, proposedInit);
        if (!valCheck.valid) {
          errors.push({ tag: t.name, code: valCheck.code, error: valCheck.error });
          continue;
        }

        const candidate = {
          name: t.name,
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
          currentValue: valCheck.normalizedValue,
          quality: 'GOOD' as const,
          updatedAt: now,
        };

        const testMap = { ...candidateTags, [t.name]: candidate };
        const overlaps = detectWordOverlapConflicts(testMap, deviceProtocols).filter(
          (c) => c.tagA === t.name || c.tagB === t.name
        );
        if (overlaps.length > 0) {
          errors.push({
            tag: t.name,
            code: 'REGISTER_OVERLAP_COLLISION',
            error: overlaps[0].reason,
          });
          continue;
        }

        candidateTags[t.name] = candidate;
        upserted.push(t.name);
      }

      if (upserted.length > 0) {
        project.tags = candidateTags;
        store.saveProject(project);
      }

      return {
        upsertedCount: upserted.length,
        upserted,
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
      registerScriptId: z.string().optional(),
      cyclicIntervalMs: z.number().int().min(100).max(60000).default(1000),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      source:
        'PROGRAM DeltaCalc\nVAR_INPUT\n  Supply_Temp_C : REAL;\n  Return_Temp_C : REAL;\nEND_VAR\nVAR_OUTPUT\n  Plant_DeltaT_C : REAL;\nEND_VAR\nPlant_DeltaT_C := Return_Temp_C - Supply_Temp_C;\nEND_PROGRAM',
    },
    handler: (input, store) => {
      const result = transpileStToHaiwellJs(input.source, input.tagBindings);
      if (!result.success || !result.jsCode) {
        return { transpiled: false, validation: result.validation };
      }
      if (input.registerScriptId) {
        const project = store.getProject(input.projectId);
        const scriptCheck = validateHaiwellScript(result.jsCode, project.tags, {
          trigger: 'CYCLIC',
          intervalMs: input.cyclicIntervalMs,
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
    inputSchema: z.object({
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
            unit: z.string().optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            colSpan: z.number().int().min(1).max(8).default(1),
            rowSpan: z.number().int().min(1).max(3).default(1),
          })
        )
        .min(1),
      returnSvg: z.boolean().default(false),
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
        unit: z.string().optional(),
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
    haiwellFeature: 'Haiwell Component Toolbox Catalog & Property-Grid Schema',
    safetyTier: 'read',
    description:
      'Return the complete machine-readable Haiwell Cloud SCADA Develop HMI component toolbox (display, control, P&ID equipment with port geometry, min touch dimensions, allowed PLC data types, and Windows Property Grid field names).',
    inputSchema: z.object({
      category: z
        .enum(['ALL', 'DISPLAY', 'CONTROL', 'PID_EQUIPMENT', 'CHART_HISTORIAN', 'ALARM_RECIPE', 'NAVIGATION'])
        .default('ALL'),
    }),
    sampleInput: { category: 'PID_EQUIPMENT' },
    handler: (input) => {
      const items =
        input.category === 'ALL'
          ? HAIWELL_HMI_TOOLBOX
          : HAIWELL_HMI_TOOLBOX.filter((c) => c.category === input.category);
      return { count: items.length, gridSnapPx: 8, minTouchPx: 48, components: items };
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
            type: z.enum(['TANK', 'PUMP', 'VALVE', 'NUMERIC_DISPLAY', 'NUMERIC_INPUT', 'BIT_BUTTON', 'BIT_LAMP', 'GAUGE', 'BAR_GRAPH']),
            label: z.string().min(1).max(80),
            tagName: z.string().optional(),
            writeEnabled: z.boolean().default(false),
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
            fluid: z.enum(['CHILLED_WATER', 'HOT_WATER', 'STEAM', 'AIR', 'CHEMICAL', 'PROCESS', 'RETURN']).default('PROCESS'),
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
    haiwellFeature: 'Zero-Error Native Screen Manifest & Windows UIA (pywinauto) Property-Grid Bridge',
    safetyTier: 'design',
    description:
      'Export a validated HMI screen for zero-error deployment into Haiwell Cloud SCADA Develop desktop software via BOTH (1) a native structured screen import manifest AND (2) a closed-loop Windows UI Automation (pywinauto) Python script that drops components by Toolbox Name and injects mathematically proven Left/Top/Width/Height/Variable values into the Property Grid with UIA read-back verification (eliminating pixel drag-and-drop errors).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().default('scr_chiller_overview'),
      windowTitleRegex: z.string().default('.*Haiwell Cloud SCADA Develop.*'),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, screenId: 'scr_chiller_overview' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = project.screens.find((s) => s.id === input.screenId);
      if (!screen) throw new Error(`Screen "${input.screenId}" not found.`);
      return compileDesktopAutomationBridge(screen, project.tags, {
        windowTitleRegex: input.windowTitleRegex,
        knownScreenIds: new Set(project.screens.map((s) => s.id)),
        targetHardware: project.targetHardware,
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
      'Validate Haiwell Cloud SCADA JavaScript scripts with string/comment-aware delimiter balancing, sandbox escape blocking, Tag.Read/Tag.Write cross-referencing, RO tag protection, and SIL interlock warnings.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      code: z.string().min(1),
      trigger: z.enum(['STARTUP', 'SHUTDOWN', 'CYCLIC', 'TAG_CHANGE', 'SCREEN_EVENT', 'ALARM_EVENT']).optional(),
      intervalMs: z.number().int().optional(),
      triggerTag: z.string().optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      code: 'const t = Tag.Read("Supply_Temp_C");\nif (t > 12) { System.Log("High supply temp: " + t); }',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      return validateHaiwellScript(input.code, project.tags, {
        trigger: input.trigger,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
      });
    },
  }),

  defineTool({
    name: 'haiwell_script_upsert',
    domain: 'scripts',
    haiwellFeature: 'Haiwell JavaScript Script Registration',
    safetyTier: 'design',
    description:
      'Validate and save a Haiwell Cloud SCADA JavaScript task (STARTUP, SHUTDOWN, CYCLIC, TAG_CHANGE, SCREEN_EVENT, ALARM_EVENT). Blocks saving on static validation or trigger configuration errors.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      trigger: z.enum(['STARTUP', 'SHUTDOWN', 'CYCLIC', 'TAG_CHANGE', 'SCREEN_EVENT', 'ALARM_EVENT']),
      intervalMs: z.number().int().min(50).max(3600000).optional(),
      triggerTag: z.string().optional(),
      code: z.string().min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      id: 'scr_js_setpoint_guard',
      name: 'SetpointClampGuard',
      trigger: 'TAG_CHANGE',
      triggerTag: 'Chiller_Setpoint_C',
      code: 'const sp = Tag.Read("Chiller_Setpoint_C");\nif (sp < 4.0) { Tag.Write("Chiller_Setpoint_C", 4.0); }',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const validation = validateHaiwellScript(input.code, project.tags, {
        trigger: input.trigger,
        intervalMs: input.intervalMs,
        triggerTag: input.triggerTag,
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
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'EVALUATE' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'EVALUATE') {
        const summary = evaluateProjectAlarms(project);
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
        return { published: true, topic: binding.topic, qos: binding.qos, format: binding.format, payload };
      }
      if (input.action === 'READ_LOOPBACK') {
        if (input.topicFilter) {
          const check = validateMqttTopic(input.topicFilter, 'SUBSCRIBE');
          if (!check.valid) throw new Error(`Invalid topicFilter: ${check.errors.join(' ')}`);
        }
        const messages = store.readMqttLoopback(input.topicFilter);
        return { count: messages.length, messages };
      }
      let host = input.probeHost;
      let port = input.probePort;
      if (!host || !port) {
        const parsedUrl = new URL(project.mqtt.brokerUri);
        host = host ?? parsedUrl.hostname;
        port = port ?? (Number(parsedUrl.port) || (project.mqtt.tlsEnabled ? 8883 : 1883));
      }
      const probe = await probeTcpEndpoint(host, port, 1200);
      return { brokerUri: project.mqtt.brokerUri, host, port, ...probe };
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
      endpointUrl: 'opc.tcp://0.0.0.0:4840/haiwell/chiller01',
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
          nodeId: node.nodeId,
          statusCode: 'Good (0x00000000)',
          dataType: node.dataType,
          value: tag.currentValue,
          sourceTimestamp: tag.updatedAt,
        };
      }
      if (node.accessLevel === 'CurrentRead') {
        return { written: false, statusCode: 'BadNotWritable (0x803B0000)', message: `OPC UA Node ${node.nodeId} is CurrentRead only.` };
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
        return { written: false, statusCode: uaStatus, blockedBy: guard.blockedBy, message: guard.message };
      }
      tag.previousValue = tag.currentValue;
      tag.currentValue = guard.normalizedValue;
      tag.updatedAt = new Date().toISOString();
      store.saveProject(project);
      return { written: true, statusCode: 'Good (0x00000000)', nodeId: node.nodeId, value: tag.currentValue };
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
      if (isBlockedSsrfHost(parsed.hostname)) {
        throw new Error(`SSRF_BLOCK: Forbidden cloud metadata/link-local/unspecified host "${parsed.hostname}".`);
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
      'Configure Haiwell Cloud SCADA security policy: SSL encryption strength (128/256), Haiwell A/B Key remote cloud authentication, output interlock enforcement, and RBAC privilege groups (0-15).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      sslBits: z.enum(['128', '256']).or(z.number().int()).default(128),
      abKeyEnabled: z.boolean().default(true),
      requireInterlockForOutputs: z.boolean().default(true),
      userGroups: z
        .array(
          z.object({
            groupName: z.string().min(2).max(40),
            privilegeLevel: z.number().int().min(0).max(15),
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
      'Deterministically simulate N scan cycles with injected tag overrides or raw ADC sensor counts (with linear scaling), verifying E-Stop fail-safe output de-energization, declarative event triggers, and ISA-18.2 alarm state transitions.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      injectTagValues: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
      injectRawAdcValues: z.record(z.string(), z.number()).optional(),
      steps: z.number().int().min(1).max(50).default(1),
      enforceEStopSafeState: z.boolean().default(true),
      persistState: z.boolean().default(false),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      injectTagValues: { EStop_OK: false },
      steps: 1,
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
];

export function serializeToolCatalog() {
  return HAIWELL_TOOLS.map((tool) => ({
    name: tool.name,
    domain: tool.domain,
    haiwellFeature: tool.haiwellFeature,
    safetyTier: tool.safetyTier,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
    sampleInput: tool.sampleInput,
  }));
}

export async function invokeHaiwellTool(
  toolName: string,
  rawArgs: unknown,
  store: HaiwellProjectStore
): Promise<{
  ok: boolean;
  tool: string;
  domain?: HaiwellDomain;
  safetyTier?: ToolSafetyTier;
  executionMs: number;
  data?: unknown;
  error?: { code: string; message: string; issues?: unknown };
}> {
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
  const parsed = tool.inputSchema.safeParse(normalizedArgs);
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

  try {
    const data = await tool.handler(parsed.data, store);
    return {
      ok: true,
      tool: tool.name,
      domain: tool.domain,
      safetyTier: tool.safetyTier,
      executionMs: Number((performance.now() - start).toFixed(3)),
      data,
    };
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
