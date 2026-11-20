import assert from 'node:assert/strict';
import test from 'node:test';
import { HaiwellProjectStore } from './projectStore';
import { HAIWELL_TOOLS, invokeHaiwellTool } from './toolRegistry';
import { REAL_HAIWELL_350_TREE_NODES } from './hmiSpatialEngine';

test('Haiwell Cloud Scada 3.50.x parity: 57 total tools cover all 22 real Project Browser nodes', () => {
  assert.equal(HAIWELL_TOOLS.length, 57);
  assert.equal(REAL_HAIWELL_350_TREE_NODES.length, 22);
});

test('Project properties match real Haiwell HMI B7H 1024x600 Enable network project 8888 & .hwdev', async () => {
  const store = new HaiwellProjectStore();
  const res = await invokeHaiwellTool(
    'haiwell_project_create',
    {
      id: 'prj_test_b7h',
      name: 'TEST 1 HMI',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
      networkProjectEnabled: true,
      networkProjectPort: 8888,
      targetDownloadIp: '10.230.74.157',
      hwdevFileName: 'Project1.hwdev',
    },
    store
  );
  assert.equal(res.ok, true);
  const data = res.data as Record<string, unknown>;
  assert.equal(data.hwdevFileName, 'Project1.hwdev');
  assert.equal(data.targetHardware, 'CLOUD_HMI_B7H');
  assert.equal(data.networkProjectPort, 8888);

  const exported = await invokeHaiwellTool(
    'haiwell_project_export',
    { projectId: 'prj_chiller_plant_01', includeArtifacts: ['hwdev_manifest', 'haiwell_variables_csv'] },
    store
  );
  assert.equal(exported.ok, true);
  const artifacts = (exported.data as { artifacts: Record<string, unknown> }).artifacts;
  assert.ok(typeof artifacts['haiwell_variables_import.csv'] === 'string');
  assert.match(artifacts['haiwell_variables_import.csv'] as string, /VariableName,VariableType,DeviceName/);
  assert.ok(artifacts['project.hwdev.manifest.json']);
});

test('Desktop UIA Calibrator & Bridge match real "Haiwell Cloud Scada[3.50.1.19] - ...\\Project1.hwdev" window title', async () => {
  const store = new HaiwellProjectStore();
  const cal = await invokeHaiwellTool('haiwell_desktop_uia_calibrate', {}, store);
  assert.equal(cal.ok, true);
  const calData = cal.data as {
    windowTitleRegex: string;
    expectedProjectBrowserNodes: string[];
    calibrationStatus: string;
    calibratorScript: string;
  };
  assert.equal(calData.calibrationStatus, 'PENDING_LIVE_CAPTURE');
  assert.equal(calData.expectedProjectBrowserNodes.length, 22);
  // Strip Python inline (?i) flag and verify case-insensitive JS match against the exact real title bar
  const jsRe = new RegExp(calData.windowTitleRegex.replace(/^\(\?i\)/, ''), 'i');
  assert.equal(
    jsRe.test('Haiwell Cloud Scada[3.50.1.19] - C:\\Users\\user\\Documents\\Haiwell Scada\\Temporary\\Project1.hwdev'),
    true
  );
  assert.match(calData.calibratorScript, /haiwell_uia_map\.json/);

  const calVerified = await invokeHaiwellTool(
    'haiwell_desktop_uia_calibrate',
    {
      capturedMap: {
        projectBrowserAutoId: 'treeProject',
        toolboxAutoId: 'paneToolbox',
        canvasAutoId: 'designSurface1',
        propertyGridAutoId: 'propGridMain',
      },
    },
    store
  );
  assert.equal(calVerified.ok, true);
  assert.equal((calVerified.data as { calibrationStatus: string }).calibrationStatus, 'CALIBRATED_AND_VERIFIED');

  const bridge = await invokeHaiwellTool(
    'haiwell_hmi_desktop_bridge_export',
    {
      projectId: 'prj_chiller_plant_01',
      screenId: 'scr_chiller_overview',
      uiaMap: {
        toolboxAutoId: 'paneToolbox',
        canvasAutoId: 'designSurface1',
        propertyGridAutoId: 'propGridMain',
      },
    },
    store
  );
  assert.equal(bridge.ok, true);
  const bData = bridge.data as { calibrationRequired: boolean; pywinautoScript: string };
  assert.equal(bData.calibrationRequired, false);
  assert.match(bData.pywinautoScript, /load_uia_map/);
  assert.match(bData.pywinautoScript, /\{F6\}/);
});

test('All 9 new Haiwell 3.50.x Project Browser node tools validate, persist, and enforce safety/security rules', async () => {
  const store = new HaiwellProjectStore();

  // Add a STRING tag for RFID & Barcode scanner tests
  const addTags = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      tags: [
        { name: 'Rfid_Badge_Uid', scope: 'INTERNAL', dataType: 'STRING', access: 'RW', initialValue: '' },
        { name: 'Rfid_Card_Present', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: false },
        { name: 'Barcode_Last_Scan', scope: 'INTERNAL', dataType: 'STRING', access: 'RW', initialValue: '' },
      ],
    },
    store
  );
  assert.equal(addTags.ok, true);

  // 1. Data group
  const dg = await invokeHaiwellTool(
    'haiwell_datagroup_configure',
    {
      id: 'dg_prod_line',
      name: 'Production Line Batch',
      tagNames: ['Supply_Temp_C', 'Return_Temp_C'],
      collectMode: 'CYCLIC',
      intervalMs: 2000,
    },
    store
  );
  assert.equal(dg.ok, true);

  // 2. Operation record configure + CSV export
  const opCfg = await invokeHaiwellTool(
    'haiwell_operation_record_configure',
    {
      action: 'CONFIGURE',
      policy: {
        enabled: true,
        recordLogins: true,
        recordVariableWrites: true,
        recordScreenChanges: true,
        recordRecipeTransfers: true,
        recordAlarmAcks: true,
        retentionDays: 365,
        maxRecords: 200000,
        storageTarget: 'SD_CARD',
      },
    },
    store
  );
  assert.equal(opCfg.ok, true);
  const opCsv = await invokeHaiwellTool('haiwell_operation_record_configure', { action: 'EXPORT_CSV', limit: 10 }, store);
  assert.equal(opCsv.ok, true);
  assert.match((opCsv.data as { csv: string }).csv, /^id,timestamp,actor,action,target,outcome,detail/);

  // 3. Font manager
  const font = await invokeHaiwellTool(
    'haiwell_font_manager',
    {
      action: 'UPSERT',
      font: { id: 'font_cjk', familyName: 'Noto Sans SC', defaultSizePt: 12, charset: 'CJK_SIMPLIFIED', embedInHmiPackage: true },
    },
    store
  );
  assert.equal(font.ok, true);

  // 4. RFID (reject unknown user group, accept valid)
  const badRfid = await invokeHaiwellTool(
    'haiwell_rfid_configure',
    {
      enabled: true,
      uidTargetTag: 'Rfid_Badge_Uid',
      cardPresentTag: 'Rfid_Card_Present',
      cards: [{ cardUid: '04A2B91C', userName: 'Bob', userGroup: 'NonExistentGroup', enabled: true }],
    },
    store
  );
  assert.equal(badRfid.ok, false);

  const okRfid = await invokeHaiwellTool(
    'haiwell_rfid_configure',
    {
      enabled: true,
      uidTargetTag: 'Rfid_Badge_Uid',
      cardPresentTag: 'Rfid_Card_Present',
      cards: [{ cardUid: '04A2B91C', userName: 'Bob', userGroup: 'Operators', enabled: true }],
    },
    store
  );
  assert.equal(okRfid.ok, true);

  // 5. Shape library (reject XSS <script>, accept clean SVG)
  const badShape = await invokeHaiwellTool(
    'haiwell_shape_library_manage',
    {
      action: 'UPSERT',
      shape: {
        id: 'shp_xss',
        name: 'Bad Shape',
        category: 'CUSTOM',
        format: 'SVG',
        svgMarkup: '<svg><script>alert(1)</script></svg>',
      },
    },
    store
  );
  assert.equal(badShape.ok, false);

  const okShape = await invokeHaiwellTool(
    'haiwell_shape_library_manage',
    {
      action: 'UPSERT',
      shape: {
        id: 'shp_conveyor',
        name: 'Belt Conveyor',
        category: 'CONVEYOR',
        format: 'SVG',
        svgMarkup: '<svg viewBox="0 0 96 32"><rect width="96" height="32" fill="#475569"/></svg>',
      },
    },
    store
  );
  assert.equal(okShape.ok, true);

  // 6. Peripheral (barcode scanner requires STRING tag)
  const badPer = await invokeHaiwellTool(
    'haiwell_peripheral_configure',
    {
      id: 'per_scan_bad',
      name: 'Bad Scanner',
      kind: 'BARCODE_SCANNER',
      connection: 'USB',
      portOrAddress: 'USB1',
      targetTagName: 'Supply_Temp_C',
    },
    store
  );
  assert.equal(badPer.ok, false);

  const okPer = await invokeHaiwellTool(
    'haiwell_peripheral_configure',
    {
      id: 'per_scan_01',
      name: 'Line Barcode Scanner',
      kind: 'BARCODE_SCANNER',
      connection: 'USB',
      portOrAddress: 'USB1',
      targetTagName: 'Barcode_Last_Scan',
    },
    store
  );
  assert.equal(okPer.ok, true);

  // 7. Data reporting server (SSRF + TLS guard)
  const ssrfDrs = await invokeHaiwellTool(
    'haiwell_data_reporting_server_configure',
    {
      id: 'drs_ssrf',
      name: 'Blocked Metadata',
      protocol: 'HTTP_REST',
      endpointUrl: 'https://169.254.169.254/latest/meta-data',
      dataGroupIds: ['dg_prod_line'],
    },
    store
  );
  assert.equal(ssrfDrs.ok, false);

  const okDrs = await invokeHaiwellTool(
    'haiwell_data_reporting_server_configure',
    {
      id: 'drs_mes_01',
      name: 'Plant MES Ingest',
      protocol: 'HTTP_REST',
      endpointUrl: 'https://mes.factory.example/api/ingest',
      dataGroupIds: ['dg_prod_line'],
      tlsRequired: true,
    },
    store
  );
  assert.equal(okDrs.ok, true);

  // 8. Cloud platform data monitor (blocks remote write on SIL3/RO tags)
  const badCloud = await invokeHaiwellTool(
    'haiwell_cloud_monitor_configure',
    {
      enabled: true,
      machineCode: 'HW-B7H-10001',
      monitoredTags: [{ tagName: 'EStop_OK', allowRemoteWrite: true }],
    },
    store
  );
  assert.equal(badCloud.ok, false);

  const okCloud = await invokeHaiwellTool(
    'haiwell_cloud_monitor_configure',
    {
      enabled: true,
      machineCode: 'HW-B7H-10001',
      monitoredTags: [{ tagName: 'Supply_Temp_C', allowRemoteWrite: false }],
    },
    store
  );
  assert.equal(okCloud.ok, true);

  // 9. Audio (checks file extension & tag reference)
  const okAud = await invokeHaiwellTool(
    'haiwell_audio_configure',
    {
      id: 'aud_alarm_1',
      name: 'High Temp Voice',
      sourceType: 'VOICE_TTS',
      filePathOrTtsText: 'Chiller supply temperature high.',
      triggerTag: 'Rfid_Card_Present',
      alarmPriority: 1,
    },
    store
  );
  assert.equal(okAud.ok, true);

  // Referential integrity: deleting Rfid_Badge_Uid must be blocked without cascade, then succeed with cascade
  const blockedDel = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { entityType: 'tag', entityId: 'Rfid_Badge_Uid', cascade: false },
    store
  );
  assert.equal(blockedDel.ok, true);
  assert.equal((blockedDel.data as { deleted: boolean }).deleted, false);

  const cascadeDel = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { entityType: 'tag', entityId: 'Rfid_Badge_Uid', cascade: true },
    store
  );
  assert.equal(cascadeDel.ok, true);
  assert.equal((cascadeDel.data as { deleted: boolean }).deleted, true);

  // Safety audit remains deployment-ready
  const audit = await invokeHaiwellTool('haiwell_project_audit_safety', {}, store);
  assert.equal(audit.ok, true);
  assert.equal((audit.data as { deploymentReady: boolean }).deploymentReady, true);
});
