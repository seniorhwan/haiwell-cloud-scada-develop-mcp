/**
 * v2.9.0 Field Remediation & AI-Design Upgrade Test Suite
 * Verifies all 9 P0/P1/P2 fixes discovered during real-world Festo MPS Project1.hwdev testing.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HaiwellProjectStore } from './projectStore';
import { invokeHaiwellTool } from './toolRegistry';
import { SERVER_VERSION } from './version';

function makeStore() {
  return new HaiwellProjectStore();
}

test('v2.9.0 P0-1: haiwell_project_import_hwrun imports unencrypted .hwrun SQLite & rejects encrypted .hwdev', async () => {
  assert.equal(SERVER_VERSION, '2.11.0');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwrun-test-'));
  const hwrunPath = path.join(tmpDir, 'sample.hwrun');
  const fakeHwdevPath = path.join(tmpDir, 'encrypted.hwdev');

  try {
    // Write a non-SQLite encrypted-like file
    fs.writeFileSync(fakeHwdevPath, Buffer.from([0xcc, 0x78, 0x45, 0xe0, 0x47, 0x56, 0x6b, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]));

    // Build a portable synthetic .hwrun SQLite DB
    const db = new DatabaseSync(hwrunPath);
    db.exec(`
      CREATE TABLE project (ID INTEGER, Name TEXT, HMIOrPC TEXT, Width INTEGER, Height INTEGER, NetPort INTEGER);
      INSERT INTO project VALUES (1, 'Festo_Test', 'Haiwell HMI B7H', 1024, 600, 8888);
      CREATE TABLE device (ID INTEGER, Name TEXT, ChannelType TEXT, ComPort TEXT, ComDevNumber INTEGER, ComBaudrate TEXT, ComDatabits TEXT, ComParity TEXT, ComStopbits TEXT, HighLowSwitch TEXT, BlockLength INTEGER, Interval INTEGER, Timeout INTEGER, Disable INTEGER);
      INSERT INTO device VALUES (9, 'Modbus_1', 'COM', 'COM2', 1, '9600', '8', 'None', '1', 'CDAB', 48, 300, 150, 0);
      INSERT INTO device VALUES (10, 'Modbus_2', 'COM', 'COM2', 2, '9600', '8', 'None', '1', 'CDAB', 48, 300, 150, 0);
      CREATE TABLE variable (ID INTEGER, HwSys INTEGER, DevId INTEGER, Name TEXT, FullName TEXT, AddressDesc TEXT, DataType TEXT, AddressReadWrite TEXT, InitValue TEXT, CollectionAlwaysEnabled INTEGER, Memo TEXT);
      INSERT INTO variable VALUES (1, 1, 0, '$Year', '$Year', 'W1', 'USHORT', 'rw', '', 0, 'System');
      INSERT INTO variable VALUES (2, 0, 9, 'X0', 'Modbus_1.X0', '1X13312', 'BOOL', 'r', '', 0, 'ST1 X0');
      INSERT INTO variable VALUES (3, 0, 10, 'X0', 'Modbus_2.X0', '1X13312', 'BOOL', 'r', '', 0, 'ST2 X0');
      INSERT INTO variable VALUES (4, 0, 9, 'Y0', 'Modbus_1.Y0', '0X13056', 'BOOL', 'rw', '', 0, 'ST1 Y0');
      CREATE TABLE window (ID INTEGER, HwSys INTEGER, WindowID INTEGER, Name TEXT, Width INTEGER, Height INTEGER, CanvasColor TEXT);
      INSERT INTO window VALUES (1, 0, 1, 'Main_display', 1024, 600, '#ffffff');
      INSERT INTO window VALUES (27, 0, 5, 'OUTPUT_DISTRIBUTION', 1024, 600, '#ffffff');
      CREATE TABLE ProjectSymbol (ID INTEGER, WinId INTEGER, SymbolName TEXT, Name TEXT, SymbolVariableUsing TEXT);
      INSERT INTO ProjectSymbol VALUES (1, 1, 'Lamp1', 'BitLamp', '[{"PropName":"RdVar-id","VariableID":2}]');
      CREATE TABLE task (ID INTEGER, HwSys INTEGER, Name TEXT, Type TEXT, ContentId INTEGER);
      INSERT INTO task VALUES (13, 0, 'Task_StartAll', 'SCRIPT', 13);
      CREATE TABLE taskDocument (ID INTEGER, Script TEXT);
      INSERT INTO taskDocument VALUES (13, 'var t = new Date().getTime(); while (new Date().getTime() < t + 300) { continue; }');
      CREATE TABLE eventItem (ID INTEGER, Name TEXT, TaskId INTEGER, EventConfig TEXT, Disable INTEGER);
      INSERT INTO eventItem VALUES (1, 'Event_1', 13, '<VAR_CHANGE varId="2" />', 0);
    `);
    db.close();

    const store = makeStore();
    const encRes = await invokeHaiwellTool(
      'haiwell_project_import_hwrun',
      { filePath: fakeHwdevPath, projectId: 'prj_enc_fail', overwrite: true },
      store
    );
    assert.equal(encRes.ok, false);
    assert.match(JSON.stringify(encRes.error), /ENCRYPTED_HWDEV_OR_NON_SQLITE/);

    const impRes = await invokeHaiwellTool(
      'haiwell_project_import_hwrun',
      {
        filePath: hwrunPath,
        projectId: 'prj_imported_v290',
        excludeWindowIds: [5],
        includeCommStatusTags: true,
        overwrite: true,
      },
      store
    );
    assert.equal(impRes.ok, true);
    const data = impRes.data as {
      targetHardware: string;
      summary: {
        devicesImported: number;
        tagsImported: number;
        renamedTags: { originalFullName: string; importedName: string }[];
        screensImported: number;
        excludedWindows: { windowId: number; name: string }[];
        tasksImported: number;
        eventsImported: number;
        legacyScriptWarnings: { taskName: string; diagnostics: { code: string }[] }[];
      };
    };
    assert.equal(data.targetHardware, 'CLOUD_HMI_B7H');
    assert.equal(data.summary.devicesImported, 2);
    assert.equal(data.summary.renamedTags.length, 1);
    assert.equal(data.summary.renamedTags[0].importedName, 'Modbus_2_X0');
    assert.equal(data.summary.screensImported, 1);
    assert.equal(data.summary.excludedWindows[0].windowId, 5);
    assert.equal(data.summary.tasksImported, 1);
    assert.equal(data.summary.eventsImported, 1);
    assert.ok(
      data.summary.legacyScriptWarnings.some((w) => w.diagnostics.some((d) => d.code === 'HWJS-RT-004')),
      'Importer should flag legacy busy-wait script with HWJS-RT-004'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v2.9.0 P0-2: haiwell_tag_upsert_batch prevents silent cross-device overwrite & supports autoPrefixOnDeviceConflict', async () => {
  const store = makeStore();
  await invokeHaiwellTool(
    'haiwell_project_create',
    { id: 'prj_tag_guard', name: 'Tag Guard Test', overwrite: true },
    store
  );
  const d1Res = await invokeHaiwellTool(
    'haiwell_device_add',
    { id: 'plc_1', name: 'Modbus_1', protocol: 'MODBUS_RTU', transport: 'RTU', serialPort: 'COM2', stationId: 1, projectId: 'prj_tag_guard' },
    store
  );
  assert.equal(d1Res.ok, true);
  const d2Res = await invokeHaiwellTool(
    'haiwell_device_add',
    { id: 'plc_2', name: 'Modbus_2', protocol: 'MODBUS_RTU', transport: 'RTU', serialPort: 'COM2', stationId: 2, projectId: 'prj_tag_guard' },
    store
  );
  assert.equal(d2Res.ok, true);

  // Default behavior: reject cross-device duplicate name instead of silent overwrite
  const resReject = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_tag_guard',
      tags: [
        { name: 'X0', scope: 'PLC', deviceId: 'plc_1', address: '1X13312', dataType: 'BOOL', access: 'RO' },
        { name: 'X0', scope: 'PLC', deviceId: 'plc_2', address: '1X13312', dataType: 'BOOL', access: 'RO' },
      ],
    },
    store
  );
  assert.equal(resReject.ok, true);
  const d1 = resReject.data as { upsertedCount: number; rejectedCount: number; errors: { code: string }[]; totalTags: number };
  assert.equal(d1.upsertedCount, 1);
  assert.equal(d1.rejectedCount, 1);
  assert.equal(d1.errors[0].code, 'DUPLICATE_TAG_NAME_CROSS_DEVICE');
  assert.equal(d1.totalTags, 1);

  // Opt-in autoPrefixOnDeviceConflict
  const resPrefix = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_tag_guard',
      autoPrefixOnDeviceConflict: true,
      tags: [{ name: 'X0', scope: 'PLC', deviceId: 'plc_2', address: '1X13312', dataType: 'BOOL', access: 'RO' }],
    },
    store
  );
  assert.equal(resPrefix.ok, true);
  const d2 = resPrefix.data as { upsertedCount: number; upserted: string[]; autoPrefixedTags?: { assignedName: string }[]; totalTags: number };
  assert.equal(d2.upsertedCount, 1);
  assert.equal(d2.upserted[0], 'Modbus_2_X0');
  assert.equal(d2.totalTags, 2);
});

test('v2.9.0 P1-3: E-Stop simulation forces SIL1 and Modbus 0X output coils to safe state', async () => {
  const store = makeStore();
  await invokeHaiwellTool('haiwell_project_create', { id: 'prj_estop_v290', name: 'EStop Test', overwrite: true }, store);
  const dmRes = await invokeHaiwellTool(
    'haiwell_device_add',
    { id: 'modbus_1', name: 'Modbus_1', protocol: 'MODBUS_RTU', transport: 'RTU', serialPort: 'COM2', stationId: 1, projectId: 'prj_estop_v290' },
    store
  );
  assert.equal(dmRes.ok, true);
  const tRes = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_estop_v290',
      tags: [
        { name: 'Line_EStop_OK', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', safetyClass: 'SIL2', initialValue: true },
        { name: 'ST1_Y0_Pusher', scope: 'PLC', deviceId: 'modbus_1', address: '0X13056', dataType: 'BOOL', access: 'RW', safetyClass: 'SIL1', initialValue: true },
        { name: 'ST1_Y1_Vacuum', scope: 'PLC', deviceId: 'modbus_1', address: '0X13057', dataType: 'BOOL', access: 'RW', safetyClass: 'SIL0', initialValue: true },
      ],
    },
    store
  );
  assert.equal(tRes.ok, true);

  const sim = await invokeHaiwellTool(
    'haiwell_simulation_step',
    {
      projectId: 'prj_estop_v290',
      eStopTagName: 'Line_EStop_OK',
      enforceEStopSafeState: true,
      injectTagValues: { Line_EStop_OK: false, ST1_Y0_Pusher: true, ST1_Y1_Vacuum: true },
      steps: 1,
    },
    store
  );
  assert.equal(sim.ok, true);
  const sdata = sim.data as { trace: { eStopTripped: boolean; outputsForcedSafe: string[] }[]; finalTags: Record<string, unknown> };
  assert.equal(sdata.trace[0].eStopTripped, true);
  assert.ok(sdata.trace[0].outputsForcedSafe.includes('ST1_Y0_Pusher'));
  assert.ok(sdata.trace[0].outputsForcedSafe.includes('ST1_Y1_Vacuum'));
  assert.equal(sdata.finalTags['ST1_Y0_Pusher'], false);
  assert.equal(sdata.finalTags['ST1_Y1_Vacuum'], false);
});

test('v2.9.0 AI-Design & P2: sections/GROUP_PANEL, discrete P&ID, styled SVG with clipPath, toolbox styles, internal W CSV, & brownfield UIA bridge', async () => {
  const store = makeStore();
  await invokeHaiwellTool(
    'haiwell_project_create',
    { id: 'prj_design_v290', name: 'Design v290', targetHardware: 'CLOUD_HMI_B7H', width: 1024, height: 600, startupScreenId: 'scr_sec_v290', overwrite: true },
    store
  );
  await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_design_v290',
      tags: [
        { name: 'RUN_ID', scope: 'INTERNAL', dataType: 'STRING', access: 'RW', initialValue: 'festo_mps_lab' },
        { name: 'Line_Yield_Pct', scope: 'INTERNAL', dataType: 'FLOAT32', access: 'RW', initialValue: 92.5, unit: '%' },
        { name: 'ST1_Start', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: false },
        { name: 'Line_EStop_OK', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', safetyClass: 'SIL2', initialValue: true },
      ],
    },
    store
  );

  // 1. Sectioned screen with GROUP_PANEL & visualRole
  const scrRes = await invokeHaiwellTool(
    'haiwell_hmi_screen_generate',
    {
      projectId: 'prj_design_v290',
      screenId: 'scr_sec_v290',
      name: 'Sectioned Overview',
      width: 1024,
      height: 600,
      columns: 2,
      returnSvg: true,
      sections: [
        {
          id: 'sec_cmds',
          title: 'Line Commands & Safety',
          columns: 2,
          items: [
            { type: 'BIT_BUTTON', label: 'START ALL', tagName: 'ST1_Start', writeEnabled: true, visualRole: 'PRIMARY_ACTION' },
            { type: 'BIT_LAMP', label: 'E-STOP LOOP OK', tagName: 'Line_EStop_OK', visualRole: 'DANGER_ACTION' },
          ],
        },
        {
          id: 'sec_kpi',
          title: 'Production KPIs',
          columns: 2,
          items: [
            { type: 'GAUGE', label: 'Line First-Pass Yield', tagName: 'Line_Yield_Pct', min: 0, max: 100, unit: '%', visualRole: 'KPI_HERO' },
            { type: 'BAR_GRAPH', label: 'Yield Bar', tagName: 'Line_Yield_Pct', min: 0, max: 100, unit: '%' },
          ],
        },
      ],
    },
    store
  );
  assert.equal(scrRes.ok, true);
  const sdata = scrRes.data as {
    overflowWidgets: string[];
    validation: { valid: boolean; collisions: unknown[] };
    screen: { widgets: { type: string }[] };
    svg: string;
  };
  assert.equal(sdata.overflowWidgets.length, 0);
  assert.equal(sdata.validation.valid, true);
  assert.equal(sdata.validation.collisions.length, 0);
  assert.ok(sdata.screen.widgets.some((w) => w.type === 'GROUP_PANEL'));
  assert.ok(sdata.svg.includes('<clipPath id="clip_'), 'SVG should include per-widget clipPath');
  assert.ok(sdata.svg.includes('#16A34A'), 'SVG should include PRIMARY_ACTION / LED accent');
  assert.ok(sdata.svg.includes('<path d="M '), 'GAUGE should render SVG arc path');

  // 2. Discrete P&ID compile (STATION + TRANSFER)
  const pidRes = await invokeHaiwellTool(
    'haiwell_hmi_pid_compile',
    {
      projectId: 'prj_design_v290',
      screenId: 'scr_discrete_flow',
      name: 'MPS Line Flow',
      width: 1024,
      height: 600,
      nodes: [
        { id: 'st1', type: 'STATION', label: 'ST1 Distributing', tagName: 'ST1_Start' },
        { id: 'conv', type: 'CONVEYOR', label: 'Transfer Slide', tagName: 'Line_EStop_OK' },
        { id: 'st2', type: 'ACTUATOR', label: 'ST2 Testing', tagName: 'Line_Yield_Pct' },
      ],
      edges: [
        { from: 'st1', to: 'conv', fluid: 'TRANSFER', label: 'Part Feed' },
        { from: 'conv', to: 'st2', fluid: 'SIGNAL', label: 'IP_FI' },
      ],
      returnSvg: true,
    },
    store
  );
  assert.equal(pidRes.ok, true);
  const pdata = pidRes.data as { portAttachmentProof: { maxPortGapPx: number }; spatialAudit: { valid: boolean }; svg: string };
  assert.equal(pdata.portAttachmentProof.maxPortGapPx, 0);
  assert.equal(pdata.spatialAudit.valid, true);
  assert.ok(pdata.svg.includes('stroke-dasharray="6,4"'), 'SIGNAL edge should render dashed');

  // 3. Toolbox style metadata
  const catRes = await invokeHaiwellTool('haiwell_hmi_toolbox_catalog', { category: 'ALL' }, store);
  assert.equal(catRes.ok, true);
  const cdata = catRes.data as {
    graphicsLibraryMetadata: Record<string, { visualStyle: string; isa101Recommended: boolean }>;
    components: { type: string; visualStyle: string; isa101Recommended: boolean }[];
  };
  assert.equal(cdata.graphicsLibraryMetadata['Switch'].visualStyle, 'SKEUOMORPHIC_3D');
  assert.equal(cdata.graphicsLibraryMetadata['Switch'].isa101Recommended, false);
  assert.ok(cdata.components.some((c) => c.type === 'STATION' && c.isa101Recommended === true));

  // 4. Internal CSV W address allocation
  const expRes = await invokeHaiwellTool(
    'haiwell_project_export',
    { projectId: 'prj_design_v290', includeArtifacts: ['haiwell_variables_csv'] },
    store
  );
  assert.equal(expRes.ok, true);
  const intCsv = String((expRes.data as { artifacts: Record<string, unknown> }).artifacts['haiwell_internal_variables.csv']);
  assert.ok(intCsv.startsWith('Variable name,Scope,Register address,Data type,Initial value,Description'));
  assert.ok(intCsv.includes(',W0,'));

  // 5. Brownfield UIA bridge export + py_compile
  const brRes = await invokeHaiwellTool(
    'haiwell_open_project_bridge_export',
    {
      projectId: 'prj_design_v290',
      existingProjectMode: 'REPLACE_DISPLAYS',
      deleteScreenNames: ['OUTPUT_DISTRIBUTION', 'OUTPUT_TESTING', 'OUTPUT_PROCESSING'],
    },
    store
  );
  assert.equal(brRes.ok, true);
  const bdata = brRes.data as { existingProjectMode: string; deleteScreenNames: string[]; pywinautoScript: string };
  assert.equal(bdata.existingProjectMode, 'REPLACE_DISPLAYS');
  assert.equal(bdata.deleteScreenNames.length, 3);
  assert.ok(bdata.pywinautoScript.includes('def delete_existing_displays'));
  assert.ok(bdata.pywinautoScript.includes('top_level_only=True, found_index=0'));
  const bareWindowCalls = bdata.pywinautoScript
    .split('\n')
    .filter((line) => line.includes('app.window(') && !line.includes('found_index=0'));
  assert.deepEqual(bareWindowCalls, []);

  const pyTmp = path.join(os.tmpdir(), `bridge_v290_${Date.now()}.py`);
  fs.writeFileSync(pyTmp, bdata.pywinautoScript, 'utf8');
  try {
    execFileSync('python', ['-m', 'py_compile', pyTmp], { stdio: 'pipe' });
  } finally {
    fs.rmSync(pyTmp, { force: true });
  }
});
