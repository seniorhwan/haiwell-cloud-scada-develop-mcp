/**
 * Brownfield Haiwell Cloud Scada (.hwrun / recipe.db) Unencrypted SQLite Importer.
 * Uses Node.js 24 built-in `node:sqlite` (DatabaseSync) in read-only mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateHaiwellScript } from './scriptAnalyzer';
import type {
  DeviceConfig,
  EventTriggerRule,
  HaiwellProject,
  HaiwellScript,
  HaiwellTargetHardware,
  HmiScreen,
  HmiWidget,
  HmiWidgetType,
  PlcDriverProtocol,
  TagDataType,
  TagDefinition,
} from './types';

export interface HwrunImportOptions {
  filePath: string;
  projectId: string;
  projectName?: string;
  excludeWindowIds?: number[];
  includeCommStatusTags?: boolean;
}

export interface HwrunRenamedTag {
  originalFullName: string;
  importedName: string;
  deviceId: string;
  address?: string;
}

export interface HwrunLegacyScriptWarning {
  taskId: string;
  taskName: string;
  valid: boolean;
  diagnostics: { code: string; severity: string; message: string; fixHint: string }[];
}

export interface HwrunImportResult {
  imported: true;
  project: HaiwellProject;
  summary: {
    sourceFile: string;
    devicesImported: number;
    tagsImported: number;
    renamedTags: HwrunRenamedTag[];
    skippedSystemVars: number;
    screensImported: number;
    excludedWindows: { windowId: number; name: string }[];
    tasksImported: number;
    eventsImported: number;
    legacyScriptWarnings: HwrunLegacyScriptWarning[];
  };
}

function slugifyId(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned.length >= 2 ? cleaned : fallback;
}

function mapHardwareModel(hmiOrPc?: string | null): HaiwellTargetHardware {
  const s = String(hmiOrPc ?? '').toUpperCase();
  if (s.includes('B7H')) return 'CLOUD_HMI_B7H';
  if (s.includes('B7')) return 'CLOUD_HMI_B7';
  if (s.includes('B10')) return 'CLOUD_HMI_B10';
  if (s.includes('C7')) return 'CLOUD_HMI_C7';
  if (s.includes('C10')) return 'CLOUD_HMI_C10';
  if (s.includes('A15')) return 'CLOUD_HMI_A15_PRO';
  if (s.includes('A10')) return 'CLOUD_HMI_A10_PRO';
  if (s.includes('A7')) return 'CLOUD_HMI_A7_PRO';
  if (s.includes('A8')) return 'CLOUD_HMI_A8';
  if (s.includes('D15')) return 'CLOUD_HMI_D15_PRO';
  if (s.includes('D10')) return 'CLOUD_HMI_D10_PRO';
  if (s.includes('D7')) return 'CLOUD_HMI_D7_PRO';
  if (s.includes('CBOX')) return 'CLOUD_BOX_CBOX';
  if (s.includes('IPC')) return 'IPC_SCADA';
  return 'PC_SCADA';
}

function mapHaiwellVarType(dt?: string | null): TagDataType {
  const u = String(dt ?? 'USHORT').trim().toUpperCase();
  if (u === 'BOOL' || u === 'BIT') return 'BOOL';
  if (u === 'SHORT' || u === 'INT16' || u === 'INT') return 'INT16';
  if (u === 'USHORT' || u === 'UINT16' || u === 'WORD') return 'UINT16';
  if (u === 'LONG' || u === 'INT32' || u === 'DINT') return 'INT32';
  if (u === 'ULONG' || u === 'UINT32' || u === 'DWORD') return 'UINT32';
  if (u === 'FLOAT' || u === 'FLOAT32' || u === 'REAL') return 'FLOAT32';
  if (u === 'DOUBLE' || u === 'FLOAT64' || u === 'LREAL') return 'FLOAT64';
  if (u === 'STRING' || u === 'STR') return 'STRING';
  if (u === 'BCD16') return 'BCD16';
  if (u === 'BCD32') return 'BCD32';
  return 'UINT16';
}

function mapSymbolTypeToWidget(symName?: string | null): HmiWidgetType {
  const s = String(symName ?? '').toUpperCase();
  if (s.includes('BITLAMP') || s.includes('LAMP')) return 'BIT_LAMP';
  if (s.includes('BITSW') || s.includes('FUNBTN') || s.includes('BTN') || s.includes('SWITCH')) return 'BIT_BUTTON';
  if (s.includes('NUMSHOW')) return 'NUMERIC_DISPLAY';
  if (s.includes('TXTBLOCK') || s.includes('TEXT')) return 'LABEL';
  if (s.includes('TREND')) return 'TREND_CHART';
  if (s.includes('ALARM')) return 'ALARM_BANNER';
  if (s.includes('BOARD') || s.includes('PANEL')) return 'GROUP_PANEL';
  return 'LABEL';
}

function sanitizeTagIdentifier(raw: string): string {
  let out = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(out)) out = `T_${out}`;
  if (out.length < 2) out = `${out}_v`;
  return out.slice(0, 64);
}

export function importHwrunProject(opts: HwrunImportOptions): HwrunImportResult {
  const filePath = path.resolve(opts.filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`FILE_NOT_FOUND: Cannot find "${filePath}".`);
  }

  const fd = fs.openSync(filePath, 'r');
  const headerBuf = Buffer.alloc(16);
  try {
    fs.readSync(fd, headerBuf, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (headerBuf.toString('utf8') !== 'SQLite format 3\0') {
    throw new Error(
      `ENCRYPTED_HWDEV_OR_NON_SQLITE: "${path.basename(filePath)}" is not an unencrypted SQLite database (header=${JSON.stringify(
        headerBuf.toString('latin1')
      )}). Real .hwdev files are encrypted; pass the companion unencrypted "temp.hwrun" or "recipe.db" from the project's Temporary/Runtime directory.`
    );
  }

  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const tableSet = new Set<string>(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name)
    );

    const now = new Date().toISOString();
    let projName = opts.projectName ?? path.basename(filePath, path.extname(filePath));
    let targetHardware: HaiwellTargetHardware = 'PC_SCADA';
    let width = 1024;
    let height = 600;
    let networkProjectPort = 8888;
    let cloudEnabled = true;

    if (tableSet.has('project')) {
      const pRow = db.prepare(`SELECT * FROM project LIMIT 1`).get() as Record<string, unknown> | undefined;
      if (pRow) {
        if (!opts.projectName && typeof pRow.Name === 'string' && pRow.Name.trim()) {
          projName = pRow.Name.trim();
        }
        targetHardware = mapHardwareModel(typeof pRow.HMIOrPC === 'string' ? pRow.HMIOrPC : undefined);
        if (typeof pRow.Width === 'number' && pRow.Width >= 320) width = pRow.Width;
        if (typeof pRow.Height === 'number' && pRow.Height >= 240) height = pRow.Height;
        if (typeof pRow.NetPort === 'number' && pRow.NetPort >= 1024) networkProjectPort = pRow.NetPort;
      }
    }

    const devices: DeviceConfig[] = [];
    const devDbIdToConfig = new Map<number, DeviceConfig>();

    if (tableSet.has('device')) {
      const devRows = db.prepare(`SELECT * FROM device ORDER BY ID`).all() as Record<string, unknown>[];
      for (const d of devRows) {
        const rawDbId = Number(d.ID ?? devices.length + 1);
        const devName = String(d.Name ?? `Device_${rawDbId}`).trim();
        const devId = slugifyId(devName, `dev_${rawDbId}`);
        const channelType = String(d.ChannelType ?? 'COM').toUpperCase();
        const transport: DeviceConfig['transport'] = channelType === 'TCP' || channelType === 'ETH' ? 'TCP' : 'RTU';
        const isDelta =
          devName.toUpperCase().includes('3D') ||
          devName.toUpperCase().includes('DELTA') ||
          String(d.DevBrand ?? '').toUpperCase().includes('DELTA') ||
          String(d.DevModel ?? '').toUpperCase().includes('DVP');
        const protocol: PlcDriverProtocol =
          transport === 'TCP' ? 'MODBUS_TCP' : isDelta ? 'DELTA_DVP_MODBUS' : 'MODBUS_RTU';
        const parityRaw = String(d.ComParity ?? 'None').toUpperCase();
        const parity: DeviceConfig['parity'] =
          parityRaw.startsWith('E') ? 'EVEN' : parityRaw.startsWith('O') ? 'ODD' : 'NONE';
        const byteOrderRaw = String(d.HighLowSwitch ?? 'CDAB').toUpperCase();
        const byteOrder: DeviceConfig['byteOrder'] =
          byteOrderRaw === 'ABCD' || byteOrderRaw === 'BADC' || byteOrderRaw === 'DCBA' ? byteOrderRaw : 'CDAB';

        const cfg: DeviceConfig = {
          id: devId,
          name: devName,
          protocol,
          transport,
          ...(transport === 'TCP'
            ? {
                host: String(d.TcpHost ?? '192.168.1.100'),
                port: Number(d.TcpPort ?? 502),
              }
            : {
                serialPort: String(d.ComPort ?? 'COM2'),
                baudRate: Number(d.ComBaudrate ?? 9600),
                dataBits: Number(d.ComDatabits ?? 8) === 7 ? 7 : 8,
                stopBits: Number(d.ComStopbits ?? 1) === 2 ? 2 : 1,
                parity,
              }),
          stationId: Number(d.ComDevNumber ?? d.TcpDevNumber ?? 1) || 1,
          pollIntervalMs: Number(d.Interval ?? 300) || 300,
          normalSpeedMs: Number(d.Interval ?? 300) || 300,
          highSpeedMs: Number(d.Interval_H ?? 50) || 50,
          lowSpeedMs: Number(d.Interval_L ?? 1000) || 1000,
          timeoutMs: Number(d.Timeout ?? 150) || 150,
          retryCount: Number(d.TryCommCount ?? 3) || 3,
          byteOrder,
          addressOffset: 'BASE_0',
          blockLength: Number(d.BlockLength ?? 48) || 48,
          batchWriteSupported: String(d.BatchWrite ?? '1') !== '0',
          enabled: Number(d.Disable ?? 0) === 0,
        };
        devices.push(cfg);
        devDbIdToConfig.set(rawDbId, cfg);
      }
    }

    const tags: Record<string, TagDefinition> = {};
    const varIdToTagName = new Map<number, string>();
    const renamedTags: HwrunRenamedTag[] = [];
    let skippedSystemVars = 0;

    if (tableSet.has('variable')) {
      const varRows = db.prepare(`SELECT * FROM variable ORDER BY ID`).all() as Record<string, unknown>[];
      for (const v of varRows) {
        const rawVarId = Number(v.ID ?? 0);
        const rawName = String(v.Name ?? '').trim();
        const fullName = String(v.FullName ?? rawName).trim();
        const hwSys = Number(v.HwSys ?? 0);

        if (!rawName || rawName.startsWith('$') || hwSys === 1) {
          skippedSystemVars++;
          continue;
        }
        if (rawName.startsWith('_comm')) {
          if (opts.includeCommStatusTags && rawName === '_commStatus') {
            const devPrefix = fullName.includes('.') ? fullName.split('.')[0] : 'Device';
            const commName = sanitizeTagIdentifier(`${devPrefix}_Comm_OK`);
            tags[commName] = {
              name: commName,
              scope: 'INTERNAL',
              dataType: 'BOOL',
              access: 'RW',
              description: `${devPrefix} communication status (imported from ${fullName})`,
              safetyClass: 'SIL0',
              requiresInterlock: false,
              currentValue: true,
              quality: 'GOOD',
              updatedAt: now,
            };
          } else {
            skippedSystemVars++;
          }
          continue;
        }

        const devDbId = v.DevId !== null && v.DevId !== undefined ? Number(v.DevId) : 0;
        const devCfg = devDbId > 0 ? devDbIdToConfig.get(devDbId) : undefined;
        const scope: TagDefinition['scope'] = devCfg ? 'PLC' : 'INTERNAL';
        const addrDesc = typeof v.AddressDesc === 'string' ? v.AddressDesc.trim() : undefined;
        const dataType = mapHaiwellVarType(typeof v.DataType === 'string' ? v.DataType : undefined);
        const rwRaw = String(v.AddressReadWrite ?? 'rw').toLowerCase();
        const access: TagDefinition['access'] = rwRaw === 'r' ? 'RO' : rwRaw === 'w' ? 'WO' : 'RW';

        let finalName = sanitizeTagIdentifier(rawName);
        if (Object.prototype.hasOwnProperty.call(tags, finalName)) {
          const prefix = devCfg ? devCfg.name : 'Internal';
          finalName = sanitizeTagIdentifier(`${prefix}_${rawName}`);
          let suffix = 2;
          while (Object.prototype.hasOwnProperty.call(tags, finalName)) {
            finalName = sanitizeTagIdentifier(`${prefix}_${rawName}_${suffix++}`);
          }
          renamedTags.push({
            originalFullName: fullName,
            importedName: finalName,
            deviceId: devCfg?.id ?? 'internal',
            address: addrDesc,
          });
        }

        const initRaw = v.InitValue;
        let currentValue: number | boolean | string =
          dataType === 'BOOL' ? false : dataType === 'STRING' ? '' : 0;
        if (initRaw !== null && initRaw !== undefined && String(initRaw).trim() !== '') {
          if (dataType === 'BOOL') {
            currentValue = String(initRaw) === '1' || String(initRaw).toLowerCase() === 'true';
          } else if (dataType === 'STRING') {
            currentValue = String(initRaw);
          } else {
            const n = Number(initRaw);
            if (!Number.isNaN(n)) currentValue = n;
          }
        }

        const isPlcOutputCoil =
          scope === 'PLC' &&
          dataType === 'BOOL' &&
          access !== 'RO' &&
          /^(?:0X|Y\d|Q\d)/i.test(addrDesc ?? '');

        tags[finalName] = {
          name: finalName,
          scope,
          ...(devCfg ? { deviceId: devCfg.id } : {}),
          ...(addrDesc ? { address: addrDesc } : {}),
          dataType,
          access,
          description: typeof v.Memo === 'string' && v.Memo.trim() ? v.Memo.trim() : undefined,
          safetyClass: isPlcOutputCoil ? 'SIL1' : 'SIL0',
          requiresInterlock: isPlcOutputCoil,
          alwaysCollect: Number(v.CollectionAlwaysEnabled ?? 0) === 1,
          collectFrequency: 'NORMAL',
          currentValue,
          quality: 'GOOD',
          updatedAt: now,
        };
        if (rawVarId > 0) {
          varIdToTagName.set(rawVarId, finalName);
        }
      }
    }

    const excludeSet = new Set(opts.excludeWindowIds ?? []);
    const excludedWindows: { windowId: number; name: string }[] = [];
    const screens: HmiScreen[] = [];

    if (tableSet.has('window')) {
      const winRows = db
        .prepare(`SELECT ID, HwSys, WindowID, Name, Width, Height, CanvasColor FROM window WHERE HwSys = 0 ORDER BY WindowID, ID`)
        .all() as Record<string, unknown>[];

      for (const w of winRows) {
        const winIdNum = Number(w.WindowID ?? w.ID ?? 0);
        const winDbId = Number(w.ID ?? winIdNum);
        const winName = String(w.Name ?? `Screen_${winIdNum}`).trim();
        if (excludeSet.has(winIdNum)) {
          excludedWindows.push({ windowId: winIdNum, name: winName });
          continue;
        }
        const screenId = slugifyId(`scr_${winName}`, `scr_${winIdNum}`);
        const widgets: HmiWidget[] = [
          {
            id: `${screenId}_alarm_banner`,
            type: 'ALARM_BANNER',
            label: 'Active Process Alarms',
            x: 20,
            y: 20,
            width: Math.max(300, width - 40),
            height: 44,
          },
        ];

        if (tableSet.has('ProjectSymbol')) {
          const syms = db
            .prepare(
              `SELECT SymbolName, Name, SymbolVariableUsing FROM ProjectSymbol WHERE WinId = ? AND Name NOT IN ('HWBoard2','HWBoard3','HWBoard4','TxtBlock') ORDER BY ID`
            )
            .all(winDbId) as Record<string, unknown>[];
          const cols = 4;
          const pad = 20;
          const gap = 12;
          const colW = Math.floor((width - pad * 2 - gap * (cols - 1)) / cols);
          syms.slice(0, 20).forEach((sym, idx) => {
            const symLabel = String(sym.SymbolName ?? `Widget_${idx + 1}`).slice(0, 48);
            const wType = mapSymbolTypeToWidget(String(sym.Name ?? sym.SymbolName ?? ''));
            let boundTag: string | undefined;
            const vuse = typeof sym.SymbolVariableUsing === 'string' ? sym.SymbolVariableUsing : '';
            const m = /"VariableID"\s*:\s*(\d+)/.exec(vuse);
            if (m) {
              boundTag = varIdToTagName.get(Number(m[1]));
            }
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const wy = 78 + row * 72;
            if (wy + 56 <= height - 76) {
              widgets.push({
                id: slugifyId(`${screenId}_${symLabel}_${idx + 1}`, `w_${idx + 1}`),
                type: wType,
                label: symLabel,
                x: pad + col * (colW + gap),
                y: wy,
                width: colW,
                height: 56,
                ...(boundTag ? { tagName: boundTag } : {}),
                writeEnabled: wType === 'BIT_BUTTON' && Boolean(boundTag) && tags[boundTag!]?.access !== 'RO',
              });
            }
          });
        }

        widgets.push({
          id: `${screenId}_nav_bar`,
          type: 'NAV_BAR',
          label: 'Screen Navigation',
          x: 20,
          y: height - 64,
          width: Math.max(240, width - 40),
          height: 44,
        });

        screens.push({
          id: screenId,
          name: winName,
          width: Number(w.Width ?? width) || width,
          height: Number(w.Height ?? height) || height,
          layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
          backgroundColor: '#E5E7EB',
          autoScaleMobile: true,
          autoScaleWeb: true,
          widgets,
          createdAt: now,
        });
      }
    }

    const scripts: HaiwellScript[] = [];
    const taskDbIdToScriptId = new Map<number, string>();
    const legacyScriptWarnings: HwrunLegacyScriptWarning[] = [];

    if (tableSet.has('task') && tableSet.has('taskDocument')) {
      const taskRows = db
        .prepare(
          `SELECT t.ID, t.Name, t.Type, td.Script FROM task t LEFT JOIN taskDocument td ON t.ContentId = td.ID WHERE t.HwSys = 0 AND t.Type = 'SCRIPT' ORDER BY t.ID`
        )
        .all() as Record<string, unknown>[];

      for (const tr of taskRows) {
        const tIdNum = Number(tr.ID ?? scripts.length + 1);
        const tName = String(tr.Name ?? `Task_${tIdNum}`).trim();
        const code = String(tr.Script ?? '').trim();
        if (!code) continue;
        const scriptId = slugifyId(`scr_js_${tName}`, `scr_js_${tIdNum}`);
        const validation = validateHaiwellScript(code, tags, { strictEs5: true, trigger: 'SCREEN_EVENT' });
        if (!validation.valid || validation.diagnostics.length > 0) {
          legacyScriptWarnings.push({
            taskId: scriptId,
            taskName: tName,
            valid: validation.valid,
            diagnostics: validation.diagnostics.map((d) => ({
              code: d.code,
              severity: d.severity,
              message: d.message,
              fixHint: d.fixHint,
            })),
          });
        }
        scripts.push({
          id: scriptId,
          name: tName,
          trigger: 'SCREEN_EVENT',
          code,
          referencedTags: validation.referencedTags,
          validated: validation.valid,
          updatedAt: now,
        });
        taskDbIdToScriptId.set(tIdNum, scriptId);
      }
    }

    const eventTriggers: EventTriggerRule[] = [];
    if (tableSet.has('eventItem')) {
      const evRows = db.prepare(`SELECT * FROM eventItem ORDER BY ID`).all() as Record<string, unknown>[];
      for (const ev of evRows) {
        const evIdNum = Number(ev.ID ?? eventTriggers.length + 1);
        const evName = String(ev.Name ?? `Event_${evIdNum}`).trim();
        const taskId = Number(ev.TaskId ?? 0);
        const targetScriptId = taskDbIdToScriptId.get(taskId);
        if (!targetScriptId) continue;

        const cfg = String(ev.EventConfig ?? '');
        const varMatch = /varId="(\d+)"/.exec(cfg);
        const sourceTag = varMatch ? varIdToTagName.get(Number(varMatch[1])) : undefined;
        if (!sourceTag) continue;

        eventTriggers.push({
          id: slugifyId(`evt_${evName}`, `evt_${evIdNum}`),
          name: evName,
          sourceTag,
          condition: 'ON_CHANGE',
          actionType: 'RUN_SCRIPT',
          targetId: targetScriptId,
          enabled: Number(ev.Disable ?? 0) === 0,
        });
      }
    }

    const project: HaiwellProject = {
      id: opts.projectId,
      name: projName,
      version: '1.0.0',
      revision: 1,
      targetHardware,
      resolution: { width, height },
      defaultLanguage: 'en-US',
      cloudEnabled,
      networkProjectEnabled: true,
      networkProjectPort,
      startupScreenId: screens[0]?.id,
      hwdevFileName: 'Project1.hwdev',
      createdAt: now,
      updatedAt: now,
      devices,
      transparentTunnel: null,
      tags,
      pous: [],
      screens,
      faceplates: [],
      scripts,
      eventTriggers,
      webhooks: [],
      alarms: [],
      alarmHistory: [],
      mqtt: {
        mode: 'HAIWELL_CLOUD_DATA_CENTER',
        brokerUri: 'mqtts://cloud-broker.haiwell.local:8883',
        clientId: `${opts.projectId}_client`,
        keepAliveSec: 60,
        cleanSession: true,
        tlsEnabled: true,
        sslBits: 128,
        proxyEnabled: false,
        bindings: [],
      },
      opcua: {
        role: 'SERVER',
        endpointUrl: 'opc.tcp://localhost:4840/haiwell/server',
        namespaceUri: 'urn:haiwell:scada:imported',
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
      dataGroups: [],
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
        autoLogoutOnRemoveSec: 0,
        cards: [],
      },
      shapeLibrary: [],
      peripherals: [],
      dataReportingServers: [],
      cloudMonitor: {
        enabled: true,
        platform: 'HAIWELL_CLOUD',
        machineCode: 'HW-CBOX-IMPORTED-01',
        networkProjectPort,
        webScadaEnabled: true,
        mobileAppEnabled: true,
        remoteAlarmPushEnabled: true,
        monitoredTags: [],
      },
      audioClips: [],
      translations: {},
      security: {
        sslBits: 128,
        abKeyEnabled: true,
        requireInterlockForOutputs: true,
        auditTrailEnabled: true,
        userGroups: [
          { groupName: 'Operator', privilegeLevel: 5, canWriteTags: true, canAckAlarms: true, canTransferRecipes: false, canRemoteTunnel: false },
          { groupName: 'Engineer', privilegeLevel: 15, canWriteTags: true, canAckAlarms: true, canTransferRecipes: true, canRemoteTunnel: true },
          { groupName: 'Admin', privilegeLevel: 20, canWriteTags: true, canAckAlarms: true, canTransferRecipes: true, canRemoteTunnel: true },
        ],
      },
      auditLog: [],
    };

    return {
      imported: true,
      project,
      summary: {
        sourceFile: filePath,
        devicesImported: devices.length,
        tagsImported: Object.keys(tags).length,
        renamedTags,
        skippedSystemVars,
        screensImported: screens.length,
        excludedWindows,
        tasksImported: scripts.length,
        eventsImported: eventTriggers.length,
        legacyScriptWarnings,
      },
    };
  } finally {
    db.close();
  }
}
