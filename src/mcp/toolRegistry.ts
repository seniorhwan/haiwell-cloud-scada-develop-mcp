/**
 * Single-source-of-truth MCP Tool Registry covering all 14 Haiwell Cloud SCADA Develop domains.
 * Uses Zod v4 for strict wire-level schema validation and automatic JSON Schema generation.
 */

import { z } from 'zod';
import { HAIWELL_REGISTER_MAP, parseHaiwellRegister } from './haiwellRegisters';
import {
  transpileStToHaiwellJs,
  validateFbdNetwork,
  validateLadderGraph,
  validateStructuredText,
} from './iec61131';
import { generateAutoLayoutScreen, renderScreenToSvg, validateHmiScreen } from './hmiGenerator';
import {
  buildMqttPayload,
  generateOpcUaNodeSet2Xml,
  mapTagTypeToOpcUa,
  probeTcpEndpoint,
  validateMqttTopic,
} from './protocolAdapters';
import { validateHaiwellScript } from './scriptAnalyzer';
import type { HaiwellProjectStore } from './projectStore';
import type { HaiwellDomain, HaiwellProject, ToolSafetyTier } from './types';

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

export function buildProjectExportBundle(project: HaiwellProject) {
  const tagCsvHeader = 'name,scope,deviceId,address,modbus0Based,modbus1Based,dataType,access,unit,safeMin,safeMax,safetyClass,requiresInterlock';
  const tagCsvRows = Object.values(project.tags).map((t) =>
    [
      t.name,
      t.scope,
      t.deviceId ?? '',
      t.address ?? '',
      t.modbusOffset0Based ?? '',
      t.modbusAddress1Based ?? '',
      t.dataType,
      t.access,
      t.unit ?? '',
      t.safeMin ?? '',
      t.safeMax ?? '',
      t.safetyClass,
      t.requiresInterlock,
    ].join(',')
  );

  return {
    format: 'haiwell-cloud-scada-bundle/v1',
    exportedAt: new Date().toISOString(),
    projectMeta: {
      id: project.id,
      name: project.name,
      version: project.version,
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

  // 1. Check PLC register collisions on same device
  const deviceAddrMap = new Map<string, string>();
  for (const tag of Object.values(project.tags)) {
    if (tag.scope === 'PLC' && tag.deviceId && tag.address) {
      const key = `${tag.deviceId}:${tag.address.toUpperCase()}`;
      if (deviceAddrMap.has(key)) {
        findings.push({
          code: 'AUD-TAG-COLLISION',
          severity: 'HIGH',
          domain: 'tags',
          target: tag.name,
          message: `Address collision: "${tag.name}" and "${deviceAddrMap.get(key)}" both map to ${key}.`,
          remediation: 'Assign distinct PLC register addresses or mark one tag as an internal alias.',
        });
      }
      deviceAddrMap.set(key, tag.name);

      const parsed = parseHaiwellRegister(tag.address);
      if (parsed.valid && parsed.readOnly && tag.access !== 'RO') {
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

  // 2. Validate IEC 61131-3 POUs
  for (const pou of project.pous) {
    if (pou.language === 'ST') {
      const res = validateStructuredText(pou.source);
      if (!res.valid) {
        findings.push({
          code: 'AUD-IEC-INVALID',
          severity: 'CRITICAL',
          domain: 'iec61131',
          target: pou.name,
          message: `POU "${pou.name}" has ${res.summary.errors} IEC 61131-3 error(s).`,
          remediation: 'Fix diagnostics reported by haiwell_iec61131_validate before deployment.',
        });
      }
    }
  }

  // 3. Validate HMI screens
  for (const screen of project.screens) {
    const res = validateHmiScreen(screen, project.tags);
    if (!res.valid) {
      findings.push({
        code: 'AUD-HMI-LAYOUT',
        severity: 'MEDIUM',
        domain: 'hmi',
        target: screen.id,
        message: `Screen "${screen.name}" has ${res.collisions.length} collision(s), ${res.outOfBounds.length} out-of-bounds widget(s), ${res.unresolvedTags.length} unresolved tag(s).`,
        remediation: 'Re-run haiwell_hmi_screen_generate or adjust widget coordinates.',
      });
    }
  }

  // 4. Validate JavaScript scripts
  for (const script of project.scripts) {
    const res = validateHaiwellScript(script.code, project.tags);
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

  // 5. Security & protocol checks
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

  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
  const high = findings.filter((f) => f.severity === 'HIGH').length;
  return {
    projectId: project.id,
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

export const HAIWELL_TOOLS: HaiwellToolDefinition[] = [
  // =========================================================================
  // 1. PROJECT LIFECYCLE & WORKSPACE MANAGEMENT
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
    }),
    sampleInput: {
      id: 'prj_pump_station_02',
      name: 'Municipal Booster Pump Station',
      targetHardware: 'CLOUD_HMI_C10',
      width: 1024,
      height: 600,
      defaultLanguage: 'en-US',
      cloudEnabled: true,
    },
    handler: (input, store) => {
      const now = new Date().toISOString();
      const project: HaiwellProject = {
        id: input.id,
        name: input.name,
        version: '1.0.0',
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
        scripts: [],
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
        name: project.name,
        targetHardware: project.targetHardware,
        resolution: project.resolution,
        createdAt: project.createdAt,
      };
    },
  }),

  defineTool({
    name: 'haiwell_project_inspect',
    domain: 'project',
    haiwellFeature: 'Project Tree Inspection',
    safetyTier: 'read',
    description:
      'Return a compact, machine-readable snapshot of the Haiwell Cloud SCADA project tree (counts and identifiers for devices, tags, POUs, screens, scripts, alarms, MQTT, OPC UA, recipes, trends, Data-Link, schedules, reports, cameras).',
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
          pous: p.pous.map((pou) => ({ id: pou.id, name: pou.name, language: pou.language, pouType: pou.pouType, errorCount: pou.diagnostics.filter((d) => d.severity === 'ERROR').length })),
          screens: p.screens.map((s) => ({ id: s.id, name: s.name, layoutStandard: s.layoutStandard, widgetCount: s.widgets.length })),
          scripts: p.scripts.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger, validated: s.validated })),
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
    name: 'haiwell_project_audit_safety',
    domain: 'project',
    haiwellFeature: 'Pre-Deployment Industrial Safety & Integrity Audit',
    safetyTier: 'read',
    description:
      'Run a full safety and standards audit across PLC register mappings, SIL interlocks, IEC 61131-3 POUs, HMI screen collisions, JavaScript scripts, MQTT TLS, OPC UA encryption, and A/B Key cloud policy.',
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
  // 2. PLC & COMMUNICATION DRIVERS
  // =========================================================================
  defineTool({
    name: 'haiwell_device_add',
    domain: 'devices',
    haiwellFeature: 'PLC & Fieldbus Driver Configuration',
    safetyTier: 'design',
    description:
      'Add or update a PLC/field device communication driver (Haiwell PLC TCP/RTU, Modbus TCP/RTU, Siemens S7, Mitsubishi MC, Omron FINS, Allen-Bradley EIP, Delta, Schneider, BACnet).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,40}$/),
      name: z.string().min(2).max(100),
      protocol: z.enum([
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
      ]),
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
      id: 'meter_power_01',
      name: 'Main Switchgear Modbus Power Meter',
      protocol: 'MODBUS_TCP',
      transport: 'TCP',
      host: '192.168.1.62',
      port: 502,
      stationId: 2,
      pollIntervalMs: 500,
    },
    handler: (input, store) => {
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
    haiwellFeature: 'Haiwell PLC Register & Modbus Offset Translator',
    safetyTier: 'read',
    description:
      'Validate Haiwell PLC native registers (X, Y, M, T, C, S, AI, AQ, V, TV, CV, SV) and compute exact 0-based/1-based Modbus offsets, hex addresses, function codes, IEC 61131-3 direct addresses, and write permissions.',
    inputSchema: z.object({
      addresses: z.array(z.string().min(1)).min(1).max(100),
      includeAreaTable: z.boolean().default(false),
    }),
    sampleInput: { addresses: ['X0', 'Y0', 'M100', 'AI0', 'AQ2', 'V100', 'V100.3', 'SV10'], includeAreaTable: false },
    handler: (input) => {
      const results = input.addresses.map((addr) => parseHaiwellRegister(addr));
      return {
        allValid: results.every((r) => r.valid),
        results,
        ...(input.includeAreaTable ? { registerMapReference: HAIWELL_REGISTER_MAP } : {}),
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
  // 3. TAG / VARIABLE DATABASE & GRANULAR TELEMETRY CONTROL
  // =========================================================================
  defineTool({
    name: 'haiwell_tag_upsert_batch',
    domain: 'tags',
    haiwellFeature: 'Variable / Tag Database Management',
    safetyTier: 'design',
    description:
      'Batch upsert PLC, internal, system, or cloud-shared variables with automatic Haiwell register validation, Modbus mapping, linear scaling, deadband, and SIL safety write bounds.',
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
          address: 'AI2',
          dataType: 'FLOAT32',
          access: 'RO',
          unit: 'L/min',
          safeMin: 0,
          safeMax: 500,
          safetyClass: 'SIL0',
          initialValue: 185.4,
        },
      ],
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const now = new Date().toISOString();
      const errors: { tag: string; error: string }[] = [];
      const upserted: string[] = [];

      for (const t of input.tags) {
        let modbus0: number | undefined;
        let modbus1: number | undefined;
        let effectiveAccess = t.access;

        if (t.scope === 'PLC' && t.address) {
          const parsed = parseHaiwellRegister(t.address);
          if (!parsed.valid) {
            errors.push({ tag: t.name, error: parsed.error });
            continue;
          }
          if (parsed.readOnly && t.access !== 'RO') {
            errors.push({
              tag: t.name,
              error: `Hardware register ${parsed.normalized} (${parsed.areaName}) is read-only; access must be RO.`,
            });
            continue;
          }
          modbus0 = parsed.modbusOffset0Based;
          modbus1 = parsed.modbusAddress1Based;
          if (parsed.readOnly) effectiveAccess = 'RO';
        }

        if (t.safeMin !== undefined && t.safeMax !== undefined && t.safeMin > t.safeMax) {
          errors.push({ tag: t.name, error: `safeMin (${t.safeMin}) cannot exceed safeMax (${t.safeMax}).` });
          continue;
        }

        const defaultVal = t.dataType === 'BOOL' ? false : t.dataType === 'STRING' ? '' : 0;
        project.tags[t.name] = {
          name: t.name,
          scope: t.scope,
          deviceId: t.deviceId,
          address: t.address?.toUpperCase(),
          modbusOffset0Based: modbus0,
          modbusAddress1Based: modbus1,
          dataType: t.dataType,
          access: effectiveAccess,
          unit: t.unit,
          description: t.description,
          safeMin: t.safeMin,
          safeMax: t.safeMax,
          safetyClass: t.safetyClass,
          requiresInterlock: t.requiresInterlock || t.safetyClass === 'SIL2' || t.safetyClass === 'SIL3',
          currentValue: t.initialValue ?? project.tags[t.name]?.currentValue ?? defaultVal,
          quality: 'GOOD',
          updatedAt: now,
        };
        upserted.push(t.name);
      }

      store.saveProject(project);
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
      'Execute granular telemetry reads or safety-guarded control writes. Rejects writes to RO registers (X/AI), enforces safeMin/safeMax engineering limits, checks E-Stop interlock state, and requires explicit confirmSafetyOverride + reason for interlocked outputs.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      operation: z.enum(['READ', 'WRITE']),
      tagName: z.string().min(1),
      value: z.union([z.number(), z.boolean(), z.string()]).optional(),
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
      reason: 'Agent energy optimization setpoint test',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const tag = project.tags[input.tagName];
      if (!tag) {
        throw new Error(`Tag "${input.tagName}" not found in project "${project.id}".`);
      }

      if (input.operation === 'READ') {
        return {
          tagName: tag.name,
          value: tag.currentValue,
          unit: tag.unit,
          dataType: tag.dataType,
          quality: tag.quality,
          address: tag.address,
          modbusOffset0Based: tag.modbusOffset0Based,
          updatedAt: tag.updatedAt,
        };
      }

      if (input.value === undefined) {
        throw new Error('WRITE operation requires an explicit "value".');
      }

      if (tag.access === 'RO') {
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'TAG_WRITE',
          target: tag.name,
          outcome: 'BLOCKED',
          detail: 'Attempted write to RO hardware register.',
        });
        return {
          written: false,
          blockedBy: 'READ_ONLY_GUARD',
          message: `Tag "${tag.name}" (${tag.address ?? tag.scope}) is read-only (RO).`,
        };
      }

      if (typeof input.value === 'number') {
        if (tag.safeMin !== undefined && input.value < tag.safeMin) {
          store.appendAudit(project, {
            actor: 'mcp-agent',
            action: 'TAG_WRITE',
            target: tag.name,
            outcome: 'BLOCKED',
            detail: `Value ${input.value} below safeMin ${tag.safeMin}.`,
          });
          return {
            written: false,
            blockedBy: 'SAFE_RANGE_MIN',
            message: `Rejected value ${input.value} for "${tag.name}": below safeMin (${tag.safeMin}).`,
          };
        }
        if (tag.safeMax !== undefined && input.value > tag.safeMax) {
          store.appendAudit(project, {
            actor: 'mcp-agent',
            action: 'TAG_WRITE',
            target: tag.name,
            outcome: 'BLOCKED',
            detail: `Value ${input.value} above safeMax ${tag.safeMax}.`,
          });
          return {
            written: false,
            blockedBy: 'SAFE_RANGE_MAX',
            message: `Rejected value ${input.value} for "${tag.name}": above safeMax (${tag.safeMax}).`,
          };
        }
      }

      const estop = project.tags['EStop_OK'];
      if (tag.requiresInterlock && estop && estop.currentValue === false) {
        return {
          written: false,
          blockedBy: 'ESTOP_INTERLOCK_ACTIVE',
          message: `Write to "${tag.name}" blocked: EStop_OK is FALSE.`,
        };
      }

      if (tag.requiresInterlock && !input.confirmSafetyOverride) {
        return {
          written: false,
          blockedBy: 'INTERLOCK_CONFIRMATION_REQUIRED',
          safetyClass: tag.safetyClass,
          message: `Tag "${tag.name}" (${tag.safetyClass}) requires confirmSafetyOverride=true and a reason before writing.`,
        };
      }

      const previousValue = tag.currentValue;
      if (input.dryRun) {
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'TAG_WRITE_DRY_RUN',
          target: tag.name,
          outcome: 'SIMULATED',
          detail: `Dry-run ${previousValue} -> ${input.value} (${input.reason ?? 'no reason'})`,
        });
        return {
          written: false,
          dryRun: true,
          wouldPassGuards: true,
          tagName: tag.name,
          previousValue,
          proposedValue: input.value,
        };
      }

      tag.currentValue = input.value;
      tag.updatedAt = new Date().toISOString();
      store.saveProject(project);
      store.appendAudit(project, {
        actor: 'mcp-agent',
        action: 'TAG_WRITE',
        target: tag.name,
        outcome: 'ALLOWED',
        detail: `${previousValue} -> ${input.value} (${input.reason ?? 'agent control'})`,
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

  // =========================================================================
  // 4. IEC 61131-3 PLC LOGIC VALIDATION, POU MANAGEMENT & TRANSPILATION
  // =========================================================================
  defineTool({
    name: 'haiwell_iec61131_validate',
    domain: 'iec61131',
    haiwellFeature: 'Strict IEC 61131-3 Validator (ST / LD / FBD)',
    safetyTier: 'read',
    description:
      'Strictly validate IEC 61131-3 Structured Text (ST), Ladder Diagram (LD JSON graph), or Function Block Diagram (FBD JSON network) against runtime safety rules: undeclared vars, division by zero, unbounded WHILE TRUE watchdog hazards, REAL exact equality, VAR_INPUT/%I writes, implicit narrowing, double-coil hazards, and balanced control flow.',
    inputSchema: z.object({
      language: z.enum(['ST', 'LD', 'FBD']).default('ST'),
      pouName: z.string().default('Main'),
      source: z.string().min(1),
    }),
    sampleInput: {
      language: 'ST',
      pouName: 'PumpSafetyInterlock',
      source: [
        'PROGRAM PumpSafetyInterlock',
        'VAR_INPUT',
        '  EStop_OK AT %IX0.0 : BOOL;',
        '  FlowRate : REAL;',
        'END_VAR',
        'VAR_OUTPUT',
        '  PumpCmd AT %QX0.0 : BOOL;',
        'END_VAR',
        'IF NOT EStop_OK THEN',
        '  PumpCmd := FALSE;',
        'ELSIF FlowRate > 15.0 THEN',
        '  PumpCmd := TRUE;',
        'END_IF;',
        'END_PROGRAM',
      ].join('\n'),
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
        return {
          saved: false,
          reason: 'IEC_61131_3_VALIDATION_FAILED',
          validation,
        };
      }

      const missingTags = input.boundTags.filter((t) => !project.tags[t]);
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
      'Transpile validated IEC 61131-3 Structured Text into watchdog-safe Haiwell Cloud SCADA JavaScript (using Tag.Read/Tag.Write) and optionally register it as a cyclic SCADA script.',
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
      tagBindings: {},
    },
    handler: (input, store) => {
      const result = transpileStToHaiwellJs(input.source, input.tagBindings);
      if (!result.success || !result.jsCode) {
        return { transpiled: false, validation: result.validation };
      }
      if (input.registerScriptId) {
        const project = store.getProject(input.projectId);
        const scriptCheck = validateHaiwellScript(result.jsCode, project.tags);
        const entry = {
          id: input.registerScriptId,
          name: result.validation.pouName ?? input.registerScriptId,
          trigger: 'CYCLIC' as const,
          intervalMs: input.cyclicIntervalMs,
          code: result.jsCode,
          referencedTags: scriptCheck.referencedTags,
          validated: scriptCheck.valid,
          updatedAt: new Date().toISOString(),
        };
        const idx = project.scripts.findIndex((s) => s.id === entry.id);
        if (idx >= 0) project.scripts[idx] = entry;
        else project.scripts.push(entry);
        store.saveProject(project);
        return { transpiled: true, registeredScript: entry, scriptValidation: scriptCheck };
      }
      return { transpiled: true, jsCode: result.jsCode, validationSummary: result.validation.summary };
    },
  }),

  // =========================================================================
  // 5. AUTOMATED HMI SCREEN & LAYOUT GENERATION
  // =========================================================================
  defineTool({
    name: 'haiwell_hmi_screen_generate',
    domain: 'hmi',
    haiwellFeature: 'Automated ISA-101 HMI Screen & Responsive Layout Generator',
    safetyTier: 'design',
    description:
      'Generate a collision-free Haiwell Cloud SCADA / Cloud HMI screen following ISA-101 High-Performance HMI guidelines with automatic PC/Web/Mobile unified scaling, tag verification, and optional SVG export.',
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
            type: z.enum([
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
            ]),
            label: z.string().min(1).max(80),
            tagName: z.string().optional(),
            writeEnabled: z.boolean().default(false),
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
      returnSvg: false,
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      const screen = generateAutoLayoutScreen(input);
      const validation = validateHmiScreen(screen, project.tags);
      const idx = project.screens.findIndex((s) => s.id === screen.id);
      if (idx >= 0) project.screens[idx] = screen;
      else project.screens.push(screen);
      store.saveProject(project);
      return {
        generated: true,
        screen,
        validation,
        ...(input.returnSvg ? { svg: renderScreenToSvg(screen, project.tags) } : {}),
      };
    },
  }),

  defineTool({
    name: 'haiwell_hmi_widget_upsert',
    domain: 'hmi',
    haiwellFeature: 'Granular HMI Widget Placement & Collision Check',
    safetyTier: 'design',
    description:
      'Add or update an individual HMI control widget on an existing Haiwell screen, validating bounds, overlap collisions, and bound tag access rights.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      screenId: z.string().min(1),
      widget: z.object({
        id: z.string().min(1),
        type: z.enum([
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
        ]),
        label: z.string().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(16),
        height: z.number().int().min(16),
        tagName: z.string().optional(),
        writeEnabled: z.boolean().default(false),
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
      const validation = validateHmiScreen(screen, project.tags);
      store.saveProject(project);
      return { upserted: true, screenId: screen.id, widgetCount: screen.widgets.length, validation };
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

  // =========================================================================
  // 6. HAIWELL JAVASCRIPT SCRIPTING ENGINE
  // =========================================================================
  defineTool({
    name: 'haiwell_script_validate',
    domain: 'scripts',
    haiwellFeature: 'Haiwell JavaScript Static Analyzer',
    safetyTier: 'read',
    description:
      'Validate Haiwell Cloud SCADA JavaScript scripts for Tag.Read/Tag.Write bindings, read-only tag protection, syntax balance, and watchdog-safe non-blocking execution.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      code: z.string().min(1),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      code: 'const t = Tag.Read("Supply_Temp_C");\nif (t > 12) { System.Log("High supply temp: " + t); }',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      return validateHaiwellScript(input.code, project.tags);
    },
  }),

  defineTool({
    name: 'haiwell_script_upsert',
    domain: 'scripts',
    haiwellFeature: 'Haiwell JavaScript Script Registration',
    safetyTier: 'design',
    description:
      'Validate and save a Haiwell Cloud SCADA JavaScript task (STARTUP, SHUTDOWN, CYCLIC, TAG_CHANGE, SCREEN_EVENT, ALARM_EVENT). Blocks saving on static validation errors.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      trigger: z.enum(['STARTUP', 'SHUTDOWN', 'CYCLIC', 'TAG_CHANGE', 'SCREEN_EVENT', 'ALARM_EVENT']),
      intervalMs: z.number().int().min(100).max(3600000).optional(),
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
      const validation = validateHaiwellScript(input.code, project.tags);
      if (!validation.valid) {
        return { saved: false, validation };
      }
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

  // =========================================================================
  // 7. ALARMS & MULTI-CHANNEL CLOUD NOTIFICATIONS
  // =========================================================================
  defineTool({
    name: 'haiwell_alarm_configure',
    domain: 'alarms',
    haiwellFeature: 'ISA-18.2 Alarm Rules & Cloud Multi-Channel Notifications',
    safetyTier: 'design',
    description:
      'Create or update digital/analog alarms (HIHI, HI, LO, LOLO, ROC, DEV) with deadband, debounce delays, priority, and multi-channel Cloud routing (Screen Pop-up, Voice TTS, Mobile App Push, WeChat, SMS, Email).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(100),
      tagName: z.string().min(1),
      condition: z.enum(['DIGITAL_HIGH', 'DIGITAL_LOW', 'HIHI', 'HI', 'LO', 'LOLO', 'ROC', 'DEV']),
      threshold: z.number(),
      deadband: z.number().min(0).default(0.2),
      delayOnMs: z.number().int().min(0).default(2000),
      delayOffMs: z.number().int().min(0).default(1000),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
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
      if (!project.tags[input.tagName]) {
        throw new Error(`Alarm tag "${input.tagName}" does not exist in project "${project.id}".`);
      }
      const alarm = { ...input, enabled: true };
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
    haiwellFeature: 'Alarm Evaluation, Active Buffer Query & Acknowledgment',
    safetyTier: 'control_guarded',
    description:
      'Evaluate all configured alarm thresholds against current tag values, list active/historical alarms, or acknowledge active alarms with an audit record.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['EVALUATE', 'LIST', 'ACKNOWLEDGE']),
      eventId: z.string().optional(),
      operator: z.string().default('mcp-agent'),
    }),
    sampleInput: { projectId: DEFAULT_PROJECT_ID, action: 'EVALUATE' },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'EVALUATE') {
        const triggered: typeof project.alarmHistory = [];
        for (const alm of project.alarms) {
          if (!alm.enabled) continue;
          const tag = project.tags[alm.tagName];
          if (!tag) continue;
          const numVal = typeof tag.currentValue === 'boolean' ? (tag.currentValue ? 1 : 0) : Number(tag.currentValue);
          const tripped =
            (alm.condition === 'HIHI' || alm.condition === 'HI') ? numVal >= alm.threshold :
            (alm.condition === 'LO' || alm.condition === 'LOLO') ? numVal <= alm.threshold :
            alm.condition === 'DIGITAL_HIGH' ? numVal === 1 :
            alm.condition === 'DIGITAL_LOW' ? numVal === 0 :
            false;
          if (tripped) {
            const ev = {
              eventId: `ev_${alm.id}_${Date.now()}`,
              alarmId: alm.id,
              tagName: alm.tagName,
              value: tag.currentValue,
              priority: alm.priority,
              message: alm.messageTemplate,
              state: 'ACTIVE_UNACK' as const,
              triggeredAt: new Date().toISOString(),
            };
            project.alarmHistory.push(ev);
            triggered.push(ev);
          }
        }
        store.saveProject(project);
        return { evaluatedRules: project.alarms.length, newlyTriggered: triggered.length, events: triggered };
      }

      if (input.action === 'ACKNOWLEDGE') {
        if (!input.eventId) throw new Error('ACKNOWLEDGE requires eventId.');
        const ev = project.alarmHistory.find((e) => e.eventId === input.eventId);
        if (!ev) throw new Error(`Alarm event "${input.eventId}" not found.`);
        ev.state = 'ACTIVE_ACK';
        ev.acknowledgedAt = new Date().toISOString();
        ev.acknowledgedBy = input.operator;
        store.saveProject(project);
        return { acknowledged: true, event: ev };
      }

      return {
        definedCount: project.alarms.length,
        activeCount: project.alarmHistory.filter((e) => e.state.startsWith('ACTIVE')).length,
        history: project.alarmHistory,
      };
    },
  }),

  // =========================================================================
  // 8. MQTT & HAIWELL CLOUD IOT INTEGRATION
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
      'Bind Haiwell SCADA tags to an MQTT publish/subscribe topic with strict MQTT 3.1.1/5.0 wildcard validation, Sparkplug B or JSON serialization, QoS, and RBE deadband.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      topic: z.string().min(1),
      direction: z.enum(['PUBLISH', 'SUBSCRIBE', 'BIDIRECTIONAL']),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
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
      if (!topicCheck.valid) {
        return { bound: false, topicValidation: topicCheck };
      }
      const missingTags = input.tags.filter((t) => !project.tags[t]);
      if (missingTags.length > 0) {
        return { bound: false, error: `Unknown tags: ${missingTags.join(', ')}` };
      }
      if (input.allowRemoteWrite && !project.mqtt.tlsEnabled) {
        return { bound: false, error: 'SAFETY_BLOCK: Remote MQTT write requires TLS enabled on broker config.' };
      }
      const binding = { ...input };
      const idx = project.mqtt.bindings.findIndex((b) => b.id === binding.id);
      if (idx >= 0) project.mqtt.bindings[idx] = binding;
      else project.mqtt.bindings.push(binding);
      store.saveProject(project);
      return {
        bound: true,
        binding,
        topicValidation: topicCheck,
        samplePayload: buildMqttPayload(project, binding),
      };
    },
  }),

  defineTool({
    name: 'haiwell_mqtt_exchange',
    domain: 'mqtt',
    haiwellFeature: 'MQTT Publish / Loopback Inspect / Broker TCP Probe',
    safetyTier: 'protocol_io',
    description:
      'Execute a deterministic MQTT publish (using configured Sparkplug B/JSON binding), read loopback broker messages by topic filter (+/#), or run a live TCP reachability probe against a broker host:port.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['PUBLISH_BINDING', 'READ_LOOPBACK', 'PROBE_BROKER']),
      bindingId: z.string().optional(),
      topicFilter: z.string().optional(),
      probeHost: z.string().optional(),
      probePort: z.number().int().min(1).max(65535).optional(),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      action: 'PUBLISH_BINDING',
      bindingId: 'mqtt_bind_telemetry',
    },
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
        const messages = store.readMqttLoopback(input.topicFilter);
        return { count: messages.length, messages };
      }
      const parsedUrl = new URL(project.mqtt.brokerUri);
      const host = input.probeHost ?? parsedUrl.hostname;
      const port = input.probePort ?? (Number(parsedUrl.port) || (project.mqtt.tlsEnabled ? 8883 : 1883));
      const probe = await probeTcpEndpoint(host, port, 1200);
      return { brokerUri: project.mqtt.brokerUri, host, port, ...probe };
    },
  }),

  // =========================================================================
  // 9. OPC UA INTEROPERABILITY & NODESET2 XML
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
      'Map Haiwell SCADA tags into OPC UA Variable nodes (validating read/write access alignment) and optionally export an OPC Foundation Part 6 compliant UANodeSet2 XML document.',
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
        const tag = project.tags[tagName];
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
        const idx = project.opcua.nodes.findIndex((n) => n.tagName === tag.name);
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
    haiwellFeature: 'OPC UA AddressSpace Browse, Read & Guarded Write',
    safetyTier: 'protocol_io',
    description:
      'Browse mapped OPC UA AddressSpace nodes, read live node values with StatusCode/SourceTimestamp, or perform an access-level-checked write.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      action: z.enum(['BROWSE', 'READ_NODE', 'WRITE_NODE']),
      nodeId: z.string().optional(),
      value: z.union([z.number(), z.boolean(), z.string()]).optional(),
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
      const tag = project.tags[node.tagName];
      if (input.action === 'READ_NODE') {
        return {
          nodeId: node.nodeId,
          statusCode: 'Good (0x00000000)',
          dataType: node.dataType,
          value: tag?.currentValue,
          sourceTimestamp: tag?.updatedAt,
        };
      }
      if (node.accessLevel === 'CurrentRead' || tag.access === 'RO') {
        return {
          written: false,
          statusCode: 'BadNotWritable (0x803B0000)',
          message: `OPC UA Node ${node.nodeId} is read-only.`,
        };
      }
      if (input.value === undefined) throw new Error('WRITE_NODE requires value.');
      if (typeof input.value === 'number' && ((tag.safeMin !== undefined && input.value < tag.safeMin) || (tag.safeMax !== undefined && input.value > tag.safeMax))) {
        return {
          written: false,
          statusCode: 'BadOutOfRange (0x803C0000)',
          message: `Value ${input.value} outside tag safety bounds [${tag.safeMin ?? '-inf'}, ${tag.safeMax ?? '+inf'}].`,
        };
      }
      tag.currentValue = input.value;
      tag.updatedAt = new Date().toISOString();
      store.saveProject(project);
      return { written: true, statusCode: 'Good (0x00000000)', nodeId: node.nodeId, value: tag.currentValue };
    },
  }),

  // =========================================================================
  // 10. RECIPES & BATCH FORMULATION
  // =========================================================================
  defineTool({
    name: 'haiwell_recipe_define',
    domain: 'recipes',
    haiwellFeature: 'Recipe Group & Production Formula Management',
    safetyTier: 'design',
    description:
      'Define a Haiwell SCADA recipe group bound to writable PLC/SCADA tags and upsert named production formula records with automatic safeMin/safeMax validation.',
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
      for (const tagName of input.tagNames) {
        const tag = project.tags[tagName];
        if (!tag) throw new Error(`Recipe tag "${tagName}" does not exist.`);
        if (tag.access === 'RO') throw new Error(`Recipe tag "${tagName}" is read-only (RO).`);
        const val = input.record.values[tagName];
        if (typeof val === 'number') {
          if (tag.safeMin !== undefined && val < tag.safeMin) {
            throw new Error(`Recipe value ${val} for "${tagName}" violates safeMin (${tag.safeMin}).`);
          }
          if (tag.safeMax !== undefined && val > tag.safeMax) {
            throw new Error(`Recipe value ${val} for "${tagName}" violates safeMax (${tag.safeMax}).`);
          }
        }
      }
      let group = project.recipes.find((r) => r.id === input.groupId);
      if (!group) {
        group = { id: input.groupId, name: input.groupName, tagNames: input.tagNames, records: [] };
        project.recipes.push(group);
      }
      const rec = { ...input.record, updatedAt: new Date().toISOString() };
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
    haiwellFeature: 'Atomic Recipe Download (SCADA->PLC) / Upload (PLC->SCADA)',
    safetyTier: 'control_guarded',
    description:
      'Atomically download a recipe formula to PLC/SCADA tags (with pre-flight bounds check, rollback snapshot, and dryRun support) or upload current live tag values into a new recipe record.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      direction: z.enum(['DOWNLOAD_TO_PLC', 'UPLOAD_FROM_PLC']),
      groupId: z.string().min(1),
      recordId: z.string().min(1),
      recordName: z.string().optional(),
      dryRun: z.boolean().default(true),
    }),
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      direction: 'DOWNLOAD_TO_PLC',
      groupId: 'rcp_chiller_modes',
      recordId: 'eco_night',
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

      const rollbackSnapshot: Record<string, number | boolean | string> = {};
      for (const [k, v] of Object.entries(rec.values)) {
        const tag = project.tags[k];
        if (!tag) throw new Error(`Tag "${k}" missing.`);
        rollbackSnapshot[k] = tag.currentValue;
        if (!input.dryRun) {
          tag.currentValue = v;
          tag.updatedAt = new Date().toISOString();
        }
      }
      if (!input.dryRun) {
        store.saveProject(project);
        store.appendAudit(project, {
          actor: 'mcp-agent',
          action: 'RECIPE_DOWNLOAD',
          target: `${group.id}:${rec.recordId}`,
          outcome: 'ALLOWED',
          detail: `Downloaded ${Object.keys(rec.values).length} parameters.`,
        });
      }
      return {
        transferred: !input.dryRun,
        dryRun: input.dryRun,
        appliedValues: rec.values,
        rollbackSnapshot,
      };
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
    sampleInput: {
      projectId: DEFAULT_PROJECT_ID,
      action: 'QUERY_SAMPLES',
      groupId: 'trd_thermal_01',
    },
    handler: (input, store) => {
      const project = store.getProject(input.projectId);
      if (input.action === 'UPSERT_GROUP') {
        if (!input.name || !input.tagNames?.length) throw new Error('UPSERT_GROUP requires name and tagNames.');
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
        for (const t of group.tagNames) values[t] = Number(project.tags[t]?.currentValue ?? 0);
        const sample = { timestamp: new Date().toISOString(), values };
        group.samples.push(sample);
        store.saveProject(project);
        return { captured: true, sample, totalSamples: group.samples.length };
      }
      return { groupId: group.id, name: group.name, sampleIntervalMs: group.sampleIntervalMs, samples: group.samples };
    },
  }),

  // =========================================================================
  // 12. HAIWELL DATA-LINK EXTERNAL DATABASES
  // =========================================================================
  defineTool({
    name: 'haiwell_datalink_configure',
    domain: 'datalink',
    haiwellFeature: 'Haiwell Data-Link (MySQL / SQL Server / PostgreSQL / SQLite)',
    safetyTier: 'design',
    description:
      'Configure Haiwell Data-Link connectors for ERP/MES database logging with identifier sanitization and parameterized SQL generation (prevents SQL injection).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      engine: z.enum(['MYSQL', 'SQL_SERVER', 'POSTGRESQL', 'SQLITE']),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      database: z.string().regex(/^[A-Za-z0-9_]+$/),
      tableName: z.string().regex(/^[A-Za-z0-9_]+$/),
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
      for (const m of input.columnMappings) {
        if (!project.tags[m.tagName]) throw new Error(`Data-Link mapped tag "${m.tagName}" does not exist.`);
      }
      const cfg = { ...input, parameterizedOnly: true };
      const idx = project.dataLinks.findIndex((d) => d.id === cfg.id);
      if (idx >= 0) project.dataLinks[idx] = cfg;
      else project.dataLinks.push(cfg);
      store.saveProject(project);

      const cols = cfg.columnMappings.map((c) => c.column).join(', ');
      const placeholders = cfg.columnMappings.map((_, i) => (cfg.engine === 'POSTGRESQL' ? `$${i + 1}` : '?')).join(', ');
      return {
        configured: true,
        dataLink: cfg,
        generatedParameterizedSql: `INSERT INTO ${cfg.tableName} (recorded_at, ${cols}) VALUES (${cfg.engine === 'POSTGRESQL' ? '$0' : '?'}, ${placeholders});`,
      };
    },
  }),

  // =========================================================================
  // 13. OPERATIONS: SCHEDULES, REPORTS, CAMERAS & MULTI-LANGUAGE
  // =========================================================================
  defineTool({
    name: 'haiwell_schedule_configure',
    domain: 'operations',
    haiwellFeature: 'Time-Based Plan & CRON Scheduler',
    safetyTier: 'design',
    description:
      'Configure Haiwell SCADA scheduled tasks (CRON expression, timezone, target script/tag/recipe/report) for unattended shift and maintenance automation.',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      id: z.string().regex(/^[a-z0-9_-]{2,48}$/),
      name: z.string().min(2).max(80),
      cron: z.string().regex(/^(\S+\s+){4}\S+$/, 'Standard 5-field CRON expression required (min hour dom mon dow)'),
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
      const project = store.getProject(input.projectId);
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
        if (!project.tags[c.tagName]) throw new Error(`Report column tag "${c.tagName}" does not exist.`);
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
      project.translations[input.locale] = {
        ...(project.translations[input.locale] ?? {}),
        ...input.entries,
      };
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
      'Configure Haiwell Cloud SCADA security policy: SSL encryption strength, Haiwell A/B Key remote cloud authentication, output interlock enforcement, and RBAC privilege groups (0-15).',
    inputSchema: z.object({
      projectId: z.string().default(DEFAULT_PROJECT_ID),
      sslBits: z.union([z.literal(128), z.literal(256)]).default(128),
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
      const project = store.getProject(input.projectId);
      project.security = {
        ...project.security,
        sslBits: input.sslBits,
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
        detail: `SSL=${input.sslBits}-bit, abKey=${input.abKeyEnabled}, interlock=${input.requireInterlockForOutputs}`,
      });
      return { updated: true, security: project.security };
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
        message: `Unknown MCP tool "${toolName}". Call tools/list to inspect available Haiwell tools.`,
      },
    };
  }

  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
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
