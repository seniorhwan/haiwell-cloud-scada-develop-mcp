/**
 * Hardened Haiwell Cloud SCADA Project Store with:
 * - Optimistic revision counter
 * - Named atomic snapshots & instant rollback
 * - Referential-integrity dependency analysis for safe deletion
 * - Optional atomic disk persistence (HAIWELL_WORKSPACE_DIR) via temp-file rename
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseHaiwellRegister } from './haiwellRegisters';
import { getWordSpanForType } from './plcAddressing';
import { validateStructuredText } from './iec61131';
import { generateAutoLayoutScreen } from './hmiGenerator';
import type { AuditLogEntry, HaiwellProject, TagDefinition } from './types';

function makeSeedProject(): HaiwellProject {
  const now = new Date().toISOString();

  const makeTag = (
    name: string,
    scope: TagDefinition['scope'],
    dataType: TagDefinition['dataType'],
    access: TagDefinition['access'],
    currentValue: number | boolean | string,
    opts: Partial<TagDefinition> = {}
  ): TagDefinition => {
    const parsed = opts.address ? parseHaiwellRegister(opts.address) : null;
    return {
      name,
      scope,
      dataType,
      access,
      currentValue,
      wordSpan: getWordSpanForType(dataType),
      safetyClass: opts.safetyClass ?? 'SIL0',
      requiresInterlock: opts.requiresInterlock ?? false,
      quality: 'GOOD',
      updatedAt: now,
      modbusOffset0Based: parsed && parsed.valid ? parsed.modbusOffset0Based : undefined,
      modbusAddress1Based: parsed && parsed.valid ? parsed.modbusAddress1Based : undefined,
      ...opts,
    };
  };

  const tags: Record<string, TagDefinition> = {
    EStop_OK: makeTag('EStop_OK', 'PLC', 'BOOL', 'RO', true, {
      deviceId: 'plc_chiller_01',
      address: 'X0',
      description: 'Hardware Emergency Stop healthy feedback (NC)',
      safetyClass: 'SIL3',
    }),
    Pump1_Run_Cmd: makeTag('Pump1_Run_Cmd', 'PLC', 'BOOL', 'RW', true, {
      deviceId: 'plc_chiller_01',
      address: 'Y0',
      description: 'Chilled water primary pump 1 run command',
      safetyClass: 'SIL2',
      requiresInterlock: true,
    }),
    Auto_Mode_Sel: makeTag('Auto_Mode_Sel', 'PLC', 'BOOL', 'RW', true, {
      deviceId: 'plc_chiller_01',
      address: 'M10',
      description: 'Plant automatic sequencing selector',
      safetyClass: 'SIL1',
    }),
    Supply_Temp_C: makeTag('Supply_Temp_C', 'PLC', 'FLOAT32', 'RO', 7.4, {
      deviceId: 'plc_chiller_01',
      address: 'AI0',
      unit: '°C',
      description: 'Chilled water supply header temperature',
      scaling: { rawMin: 0, rawMax: 32000, engMin: 0, engMax: 50, clamp: true },
      deadband: 0.1,
      safeMin: 2,
      safeMax: 25,
    }),
    Return_Temp_C: makeTag('Return_Temp_C', 'PLC', 'FLOAT32', 'RO', 12.1, {
      deviceId: 'plc_chiller_01',
      address: 'AI2',
      unit: '°C',
      description: 'Chilled water return header temperature',
      scaling: { rawMin: 0, rawMax: 32000, engMin: 0, engMax: 50, clamp: true },
      deadband: 0.1,
    }),
    Chiller_Setpoint_C: makeTag('Chiller_Setpoint_C', 'PLC', 'FLOAT32', 'RW', 7.0, {
      deviceId: 'plc_chiller_01',
      address: 'V100',
      unit: '°C',
      description: 'Target chilled water supply temperature setpoint',
      safeMin: 4.0,
      safeMax: 15.0,
      safetyClass: 'SIL1',
      requiresInterlock: false,
    }),
    Valve_Position_Pct: makeTag('Valve_Position_Pct', 'PLC', 'FLOAT32', 'RW', 48.5, {
      deviceId: 'plc_chiller_01',
      address: 'AQ0',
      unit: '%',
      description: 'Bypass modulating valve analog output',
      safeMin: 0,
      safeMax: 100,
      safetyClass: 'SIL1',
      requiresInterlock: true,
    }),
    Plant_DeltaT_C: makeTag('Plant_DeltaT_C', 'INTERNAL', 'FLOAT32', 'RW', 4.7, {
      unit: '°C',
      description: 'Calculated Return - Supply differential temperature',
    }),
  };

  const stSource = [
    'PROGRAM ChillerControl',
    'VAR_INPUT',
    '  EStop_OK AT %IX0.0 : BOOL;',
    '  Supply_Temp_C : REAL;',
    '  Chiller_Setpoint_C : REAL;',
    'END_VAR',
    'VAR_OUTPUT',
    '  Pump1_Run_Cmd AT %QX0.0 : BOOL;',
    '  Valve_Position_Pct : REAL;',
    'END_VAR',
    'VAR',
    '  TempError : REAL;',
    '  StartDelay : TON;',
    'END_VAR',
    'IF NOT EStop_OK THEN',
    '  Pump1_Run_Cmd := FALSE;',
    '  Valve_Position_Pct := 0.0;',
    'ELSE',
    '  StartDelay(IN := TRUE, PT := T#3s);',
    '  TempError := Supply_Temp_C - Chiller_Setpoint_C;',
    '  IF TempError > 0.5 THEN',
    '    Pump1_Run_Cmd := TRUE;',
    '    Valve_Position_Pct := 75.0;',
    '  ELSIF TempError < -0.5 THEN',
    '    Valve_Position_Pct := 25.0;',
    '  END_IF;',
    'END_IF;',
    'END_PROGRAM',
  ].join('\n');

  const stValidation = validateStructuredText(stSource);

  const mainScreen = generateAutoLayoutScreen({
    screenId: 'scr_chiller_overview',
    name: 'Chiller Plant Overview (ISA-101)',
    width: 1280,
    height: 800,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    includeAlarmBanner: true,
    includeNavBar: true,
    columns: 4,
    items: [
      { id: 'w_supply_temp', type: 'NUMERIC_DISPLAY', label: 'Supply Header Temp', tagName: 'Supply_Temp_C', unit: '°C' },
      { id: 'w_return_temp', type: 'NUMERIC_DISPLAY', label: 'Return Header Temp', tagName: 'Return_Temp_C', unit: '°C' },
      { id: 'w_setpoint', type: 'NUMERIC_INPUT', label: 'Supply Setpoint', tagName: 'Chiller_Setpoint_C', unit: '°C', writeEnabled: true, min: 4, max: 15 },
      { id: 'w_pump1', type: 'PUMP', label: 'Primary Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
      { id: 'w_valve', type: 'BAR_GRAPH', label: 'Bypass Valve Position', tagName: 'Valve_Position_Pct', unit: '%', min: 0, max: 100, colSpan: 2 },
      { id: 'w_trend', type: 'TREND_CHART', label: 'Header Thermal Trend', tagName: 'Supply_Temp_C', colSpan: 2 },
    ],
  });

  return {
    id: 'prj_chiller_plant_01',
    name: 'Chiller Plant Reference SCADA',
    version: '1.0.0',
    revision: 1,
    targetHardware: 'PC_SCADA',
    resolution: { width: 1280, height: 800 },
    defaultLanguage: 'en-US',
    cloudEnabled: true,
    networkProjectEnabled: true,
    networkProjectPort: 8888,
    targetDownloadIp: '192.168.1.100',
    startupScreenId: 'scr_chiller_overview',
    hwdevFileName: 'prj_chiller_plant_01.hwdev',
    createdAt: now,
    updatedAt: now,
    devices: [
      {
        id: 'plc_chiller_01',
        name: 'Haiwell T32S2T Chiller PLC',
        protocol: 'HAIWELL_PLC_TCP',
        transport: 'TCP',
        host: '192.168.1.50',
        port: 502,
        stationId: 1,
        pollIntervalMs: 250,
        timeoutMs: 1500,
        retryCount: 3,
        byteOrder: 'CDAB',
        enabled: true,
      },
    ],
    transparentTunnel: {
      enabled: false,
      cboxSerialNumber: 'CBOX-S7-904218',
      targetDeviceId: 'plc_chiller_01',
      abKeyRequired: true,
      allowedOperations: ['UPLOAD', 'ONLINE_DEBUG'],
      sessionTimeoutSec: 900,
      sslBits: 128,
    },
    tags,
    pous: [
      {
        id: 'pou_chiller_ctrl',
        name: 'ChillerControl',
        language: 'ST',
        pouType: 'PROGRAM',
        source: stSource,
        boundTags: ['EStop_OK', 'Supply_Temp_C', 'Chiller_Setpoint_C', 'Pump1_Run_Cmd', 'Valve_Position_Pct'],
        validatedAt: now,
        diagnostics: stValidation.diagnostics,
      },
    ],
    screens: [mainScreen],
    faceplates: [
      {
        id: 'fp_pump_std',
        name: 'Standard Pump Faceplate',
        description: 'Reusable ISA-101 pump control block',
        width: 240,
        height: 120,
        tagPlaceholders: ['Run_Cmd'],
        widgets: [
          { type: 'PUMP', label: 'Pump Control', x: 0, y: 0, width: 110, height: 56, tagName: '{{Run_Cmd}}', writeEnabled: true },
          { type: 'BIT_LAMP', label: 'Run Status', x: 120, y: 0, width: 110, height: 56, tagName: '{{Run_Cmd}}' },
        ],
      },
    ],
    scripts: [
      {
        id: 'scr_js_deltat',
        name: 'ComputePlantDeltaT',
        trigger: 'CYCLIC',
        intervalMs: 1000,
        code: [
          'var supply = Tag.Read("Supply_Temp_C");',
          'var ret = Tag.Read("Return_Temp_C");',
          'Tag.Write("Plant_DeltaT_C", Number((ret - supply).toFixed(2)));',
        ].join('\n'),
        referencedTags: ['Supply_Temp_C', 'Return_Temp_C', 'Plant_DeltaT_C'],
        validated: true,
        updatedAt: now,
      },
    ],
    eventTriggers: [],
    webhooks: [],
    alarms: [
      {
        id: 'alm_supply_hihi',
        name: 'Chilled Supply High-High Temp',
        tagName: 'Supply_Temp_C',
        condition: 'HIHI',
        threshold: 14.0,
        deadband: 0.5,
        delayOnMs: 5000,
        delayOffMs: 2000,
        priority: 1,
        group: 'THERMAL_CRITICAL',
        messageTemplate: 'Supply header temperature exceeded 14.0 °C threshold.',
        channels: ['SCREEN_POPUP', 'MOBILE_PUSH', 'EMAIL'],
        enabled: true,
      },
      {
        id: 'alm_estop_trip',
        name: 'Emergency Stop Tripped',
        tagName: 'EStop_OK',
        condition: 'DIGITAL_LOW',
        threshold: 0,
        deadband: 0,
        delayOnMs: 0,
        delayOffMs: 1000,
        priority: 1,
        group: 'SAFETY_INTERLOCK',
        messageTemplate: 'Hardware E-Stop circuit opened on PLC X0.',
        channels: ['SCREEN_POPUP', 'VOICE_TTS', 'MOBILE_PUSH', 'SMS'],
        enabled: true,
      },
    ],
    alarmHistory: [],
    mqtt: {
      mode: 'HAIWELL_CLOUD_DATA_CENTER',
      brokerUri: 'mqtts://cloud-broker.haiwell.local:8883',
      clientId: 'haiwell_chiller_plant_01',
      keepAliveSec: 60,
      cleanSession: true,
      tlsEnabled: true,
      sslBits: 128,
      lwtTopic: 'plant/chiller01/status',
      lwtPayload: '{"online":false}',
      proxyEnabled: true,
      bindings: [
        {
          id: 'mqtt_bind_telemetry',
          topic: 'spBv1.0/PlantA/DDATA/Chiller01/Telemetry',
          direction: 'PUBLISH',
          qos: 1,
          retain: false,
          format: 'SPARKPLUG_B',
          tags: ['Supply_Temp_C', 'Return_Temp_C', 'Chiller_Setpoint_C', 'Valve_Position_Pct'],
          publishIntervalMs: 5000,
          reportByException: true,
          allowRemoteWrite: false,
        },
      ],
    },
    opcua: {
      role: 'SERVER',
      endpointUrl: 'opc.tcp://0.0.0.0:4840/haiwell/chiller01',
      namespaceUri: 'urn:haiwell:scada:chiller01',
      namespaceIndex: 2,
      securityPolicy: 'Basic256Sha256',
      securityMode: 'SignAndEncrypt',
      authMode: 'Username',
      publishingIntervalMs: 500,
      nodes: [
        {
          nodeId: 'ns=2;s=Chiller01.Supply_Temp_C',
          browseName: 'Supply_Temp_C',
          displayName: 'Supply Header Temp (°C)',
          tagName: 'Supply_Temp_C',
          dataType: 'Float',
          accessLevel: 'CurrentRead',
          samplingIntervalMs: 500,
          folderPath: '/Objects/Chiller01',
        },
        {
          nodeId: 'ns=2;s=Chiller01.Chiller_Setpoint_C',
          browseName: 'Chiller_Setpoint_C',
          displayName: 'Supply Setpoint (°C)',
          tagName: 'Chiller_Setpoint_C',
          dataType: 'Float',
          accessLevel: 'CurrentReadWrite',
          samplingIntervalMs: 500,
          folderPath: '/Objects/Chiller01',
        },
      ],
    },
    recipes: [
      {
        id: 'rcp_chiller_modes',
        name: 'Seasonal Cooling Profiles',
        description: 'Pre-validated setpoint profiles for seasonal load optimization',
        tagNames: ['Chiller_Setpoint_C', 'Valve_Position_Pct'],
        records: [
          {
            recordId: 'summer_peak',
            name: 'Summer Peak Cooling',
            values: { Chiller_Setpoint_C: 6.5, Valve_Position_Pct: 60 },
            updatedAt: now,
          },
          {
            recordId: 'eco_night',
            name: 'Night Eco Setback',
            values: { Chiller_Setpoint_C: 10.0, Valve_Position_Pct: 30 },
            updatedAt: now,
          },
        ],
      },
    ],
    trends: [
      {
        id: 'trd_thermal_01',
        name: 'Primary Thermal Loop',
        tagNames: ['Supply_Temp_C', 'Return_Temp_C', 'Plant_DeltaT_C'],
        sampleIntervalMs: 10000,
        retentionDays: 90,
        deadbandPercent: 0.2,
        storageTarget: 'LOCAL_HIST',
        samples: [
          { timestamp: new Date(Date.now() - 120000).toISOString(), values: { Supply_Temp_C: 7.2, Return_Temp_C: 11.9, Plant_DeltaT_C: 4.7 } },
          { timestamp: new Date(Date.now() - 60000).toISOString(), values: { Supply_Temp_C: 7.3, Return_Temp_C: 12.0, Plant_DeltaT_C: 4.7 } },
          { timestamp: now, values: { Supply_Temp_C: 7.4, Return_Temp_C: 12.1, Plant_DeltaT_C: 4.7 } },
        ],
      },
    ],
    dataGroups: [
      {
        id: 'dg_chiller_telemetry',
        name: 'Chiller Telemetry Group',
        description: 'Primary supply/return temperatures and valve feedback for MES reporting',
        tagNames: ['Supply_Temp_C', 'Return_Temp_C', 'Valve_Position_Pct'],
        collectMode: 'CYCLIC',
        intervalMs: 10000,
        enabled: true,
      },
    ],
    dataLinks: [
      {
        id: 'dl_mes_mysql',
        name: 'MES Plant Historian Link',
        engine: 'MYSQL',
        host: '192.168.1.200',
        port: 3306,
        database: 'plant_mes',
        tableName: 'chiller_telemetry',
        syncMode: 'CYCLIC_INSERT',
        intervalMs: 60000,
        columnMappings: [
          { column: 'supply_c', tagName: 'Supply_Temp_C', sqlType: 'DECIMAL(6,2)' },
          { column: 'return_c', tagName: 'Return_Temp_C', sqlType: 'DECIMAL(6,2)' },
        ],
        parameterizedOnly: true,
      },
    ],
    dataReportingServers: [],
    cloudMonitor: {
      enabled: true,
      platform: 'HAIWELL_CLOUD',
      machineCode: 'HW-CBOX-DEMO-0001',
      networkProjectPort: 8888,
      webScadaEnabled: true,
      mobileAppEnabled: true,
      remoteAlarmPushEnabled: true,
      monitoredTags: [
        { tagName: 'Supply_Temp_C', allowRemoteWrite: false, groupLabel: 'Chiller' },
        { tagName: 'Return_Temp_C', allowRemoteWrite: false, groupLabel: 'Chiller' },
      ],
    },
    schedules: [
      {
        id: 'sch_night_eco',
        name: 'Night Eco Setback',
        cron: '0 22 * * 1-5',
        timezone: 'UTC',
        actionType: 'DOWNLOAD_RECIPE',
        targetId: 'rcp_chiller_modes:eco_night',
        enabled: true,
      },
    ],
    reports: [
      {
        id: 'rep_daily_energy',
        name: 'Daily Thermal Compliance Report',
        schedule: 'DAILY',
        format: 'CSV',
        columns: [
          { header: 'Avg Supply Temp (°C)', tagName: 'Supply_Temp_C', aggregate: 'AVG' },
          { header: 'Max Return Temp (°C)', tagName: 'Return_Temp_C', aggregate: 'MAX' },
        ],
      },
    ],
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
    translations: {
      'en-US': {
        'screen.overview.title': 'Chiller Plant Overview',
        'alarm.supply_hihi': 'Supply header temperature exceeded threshold',
      },
      'zh-CN': {
        'screen.overview.title': '冷水机组总览画面',
        'alarm.supply_hihi': '供水主管温度超过高高限阈值',
      },
    },
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
        {
          groupName: 'Operators',
          privilegeLevel: 5,
          canWriteTags: true,
          canAckAlarms: true,
          canTransferRecipes: true,
          canRemoteTunnel: false,
        },
        {
          groupName: 'Viewers',
          privilegeLevel: 1,
          canWriteTags: false,
          canAckAlarms: false,
          canTransferRecipes: false,
          canRemoteTunnel: false,
        },
      ],
    },
    auditLog: [
      {
        id: 'aud_init_001',
        timestamp: now,
        actor: 'system',
        action: 'PROJECT_SEEDED',
        target: 'prj_chiller_plant_01',
        outcome: 'ALLOWED',
        detail: 'Initialized reference Haiwell Cloud SCADA project with validated IEC 61131-3 POU, ISA-101 HMI, MQTT, and OPC UA.',
      },
    ],
  };
}

export interface ProjectSnapshot {
  snapshotId: string;
  projectId: string;
  label: string;
  revision: number;
  createdAt: string;
  payloadJson: string;
}

export class HaiwellProjectStore {
  private projects = new Map<string, HaiwellProject>();
  private snapshots = new Map<string, ProjectSnapshot[]>();
  private mqttLoopbackBuffer: { topic: string; payload: unknown; qos: number; timestamp: string }[] = [];
  private persistPath: string | null;

  constructor(workspaceDir?: string) {
    this.persistPath = workspaceDir ? path.join(workspaceDir, 'workspace.json') : null;
    if (this.persistPath && fs.existsSync(this.persistPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as {
          projects?: HaiwellProject[];
        };
        if (Array.isArray(raw.projects) && raw.projects.length > 0) {
          for (const p of raw.projects) {
            this.projects.set(p.id, {
              ...p,
              networkProjectEnabled: p.networkProjectEnabled ?? true,
              networkProjectPort: p.networkProjectPort ?? 8888,
              hwdevFileName: p.hwdevFileName ?? `${p.id}.hwdev`,
              dataGroups: p.dataGroups ?? [],
              dataReportingServers: p.dataReportingServers ?? [],
              cloudMonitor: p.cloudMonitor ?? {
                enabled: false,
                platform: 'HAIWELL_CLOUD',
                machineCode: '',
                networkProjectPort: 8888,
                webScadaEnabled: true,
                mobileAppEnabled: true,
                remoteAlarmPushEnabled: true,
                monitoredTags: [],
              },
              operationRecordPolicy: p.operationRecordPolicy ?? {
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
              fonts: p.fonts ?? [],
              rfid: p.rfid ?? {
                enabled: false,
                transport: 'USB_HID',
                portOrHost: 'USB0',
                autoLoginEnabled: false,
                autoLogoutOnRemoveSec: 30,
                cards: [],
              },
              shapeLibrary: p.shapeLibrary ?? [],
              peripherals: p.peripherals ?? [],
              audioClips: p.audioClips ?? [],
            });
          }
          return;
        }
      } catch {
        // Corrupted file falls back cleanly to seed
      }
    }
    const seed = makeSeedProject();
    this.projects.set(seed.id, seed);
  }

  private persistIfEnabled(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ projects: [...this.projects.values()] }, null, 2), 'utf8');
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // Never crash headless runtime on read-only FS
    }
  }

  listProjects() {
    return [...this.projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      revision: p.revision,
      targetHardware: p.targetHardware,
      tagCount: Object.keys(p.tags).length,
      screenCount: p.screens.length,
      updatedAt: p.updatedAt,
    }));
  }

  getProject(projectId = 'prj_chiller_plant_01'): HaiwellProject {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found. Available: ${[...this.projects.keys()].join(', ')}`);
    }
    return project;
  }

  saveProject(project: HaiwellProject): HaiwellProject {
    project.revision = (project.revision ?? 0) + 1;
    project.updatedAt = new Date().toISOString();
    this.projects.set(project.id, project);
    this.persistIfEnabled();
    return project;
  }

  deleteProject(projectId: string): boolean {
    const ok = this.projects.delete(projectId);
    if (ok) {
      this.snapshots.delete(projectId);
      this.persistIfEnabled();
    }
    return ok;
  }

  createSnapshot(projectId: string, label: string): Omit<ProjectSnapshot, 'payloadJson'> {
    const project = this.getProject(projectId);
    const snap: ProjectSnapshot = {
      snapshotId: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      label,
      revision: project.revision,
      createdAt: new Date().toISOString(),
      payloadJson: JSON.stringify(project),
    };
    const list = this.snapshots.get(projectId) ?? [];
    list.push(snap);
    if (list.length > 50) list.shift();
    this.snapshots.set(projectId, list);
    const { payloadJson: _omit, ...meta } = snap;
    return meta;
  }

  listSnapshots(projectId: string): Omit<ProjectSnapshot, 'payloadJson'>[] {
    return (this.snapshots.get(projectId) ?? []).map(({ payloadJson: _omit, ...meta }) => meta);
  }

  rollbackSnapshot(projectId: string, snapshotId: string): HaiwellProject {
    const list = this.snapshots.get(projectId) ?? [];
    const snap = list.find((s) => s.snapshotId === snapshotId);
    if (!snap) throw new Error(`Snapshot "${snapshotId}" not found for project "${projectId}".`);
    const restored = JSON.parse(snap.payloadJson) as HaiwellProject;
    return this.saveProject(restored);
  }

  /**
   * Computes referential-integrity dependents before deleting a tag, device, or screen.
   */
  findTagDependents(project: HaiwellProject, tagName: string): string[] {
    const deps: string[] = [];
    for (const s of project.screens) {
      for (const w of s.widgets) {
        if (w.tagName === tagName) deps.push(`screen:${s.id}/widget:${w.id}`);
      }
    }
    for (const a of project.alarms) {
      if (a.tagName === tagName) deps.push(`alarm:${a.id}`);
    }
    for (const sc of project.scripts) {
      if (sc.referencedTags.includes(tagName) || sc.triggerTag === tagName) deps.push(`script:${sc.id}`);
    }
    for (const b of project.mqtt.bindings) {
      if (b.tags.includes(tagName)) deps.push(`mqtt_binding:${b.id}`);
    }
    for (const n of project.opcua.nodes) {
      if (n.tagName === tagName) deps.push(`opcua_node:${n.nodeId}`);
    }
    for (const r of project.recipes) {
      if (r.tagNames.includes(tagName)) deps.push(`recipe:${r.id}`);
    }
    for (const tr of project.trends) {
      if (tr.tagNames.includes(tagName)) deps.push(`trend:${tr.id}`);
    }
    for (const dl of project.dataLinks) {
      if (dl.columnMappings.some((c) => c.tagName === tagName)) deps.push(`datalink:${dl.id}`);
    }
    for (const rp of project.reports) {
      if (rp.columns.some((c) => c.tagName === tagName)) deps.push(`report:${rp.id}`);
    }
    for (const ev of project.eventTriggers) {
      if (ev.sourceTag === tagName || (ev.actionType === 'WRITE_TAG' && ev.targetId === tagName)) {
        deps.push(`event_trigger:${ev.id}`);
      }
    }
    for (const sch of project.schedules) {
      if (sch.actionType === 'WRITE_TAG' && sch.targetId === tagName) {
        deps.push(`schedule:${sch.id}`);
      }
    }
    for (const pou of project.pous) {
      if (pou.boundTags.includes(tagName)) {
        deps.push(`pou:${pou.id}`);
      }
    }
    for (const dg of project.dataGroups ?? []) {
      if (dg.tagNames.includes(tagName) || dg.triggerTag === tagName) {
        deps.push(`data_group:${dg.id}`);
      }
    }
    if (project.rfid?.uidTargetTag === tagName || project.rfid?.cardPresentTag === tagName) {
      deps.push('rfid:config');
    }
    for (const per of project.peripherals ?? []) {
      if (per.targetTagName === tagName) {
        deps.push(`peripheral:${per.id}`);
      }
    }
    if (project.cloudMonitor?.monitoredTags.some((m) => m.tagName === tagName)) {
      deps.push('cloud_monitor:config');
    }
    for (const aud of project.audioClips ?? []) {
      if (aud.triggerTag === tagName) {
        deps.push(`audio:${aud.id}`);
      }
    }
    return deps;
  }

  appendAudit(
    project: HaiwellProject,
    entry: Omit<AuditLogEntry, 'id' | 'timestamp'>
  ): AuditLogEntry {
    const record: AuditLogEntry = {
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    project.auditLog.push(record);
    if (project.auditLog.length > 500) {
      project.auditLog.splice(0, project.auditLog.length - 500);
    }
    return record;
  }

  pushMqttLoopback(topic: string, payload: unknown, qos: number): void {
    this.mqttLoopbackBuffer.push({
      topic,
      payload,
      qos,
      timestamp: new Date().toISOString(),
    });
    if (this.mqttLoopbackBuffer.length > 200) {
      this.mqttLoopbackBuffer.shift();
    }
  }

  readMqttLoopback(topicFilter?: string): { topic: string; payload: unknown; qos: number; timestamp: string }[] {
    if (!topicFilter) return [...this.mqttLoopbackBuffer];
    return this.mqttLoopbackBuffer.filter((msg) => matchMqttTopicFilter(topicFilter, msg.topic));
  }
}

/**
 * Exact O(N) MQTT 3.1.1 §4.7 topic filter matcher (zero RegExp / zero ReDoS).
 * - Multi-level "#" matches parent level (e.g. "plant/#" matches "plant" AND "plant/a/b").
 * - Single-level "+" matches exactly one level.
 * - Leading "#" or "+" does NOT match "$"-prefixed broker system topics (§4.7.2).
 */
export function matchMqttTopicFilter(filter: string, topic: string): boolean {
  if (!filter || !topic) return false;
  if (topic.startsWith('$') && (filter.startsWith('#') || filter.startsWith('+'))) {
    return false;
  }
  const fLevels = filter.split('/');
  const tLevels = topic.split('/');

  for (let i = 0; i < fLevels.length; i++) {
    const f = fLevels[i];
    if (f === '#') {
      return i === fLevels.length - 1;
    }
    if (i >= tLevels.length) {
      return false;
    }
    if (f !== '+' && f !== tLevels[i]) {
      return false;
    }
  }

  // MQTT §4.7.1.2: "sport/tennis/player1/#" matches "sport/tennis/player1"
  if (fLevels.length === tLevels.length) return true;
  if (fLevels.length === tLevels.length + 1 && fLevels[fLevels.length - 1] === '#') return true;
  return false;
}

export const defaultProjectStore = new HaiwellProjectStore(process.env.HAIWELL_WORKSPACE_DIR);
