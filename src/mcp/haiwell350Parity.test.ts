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
      id: 'prj_demo_b7h',
      name: 'Demo B7H Line HMI',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
      networkProjectEnabled: true,
      networkProjectPort: 8888,
      targetDownloadIp: '192.0.2.10',
      hwdevFileName: 'LineDemo.hwdev',
    },
    store
  );
  assert.equal(res.ok, true);
  const data = res.data as Record<string, unknown>;
  assert.equal(data.hwdevFileName, 'LineDemo.hwdev');
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
    jsRe.test('Haiwell Cloud Scada[3.50.1.19] - C:\\Projects\\Demo\\LineDemo.hwdev'),
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

test('v2.3.0: Native Haiwell Modbus 0X/1X/3X/4X/W addressing, 1X RO guard, and RS-485 daisy-chain bus consistency', async () => {
  const store = new HaiwellProjectStore();
  await invokeHaiwellTool(
    'haiwell_project_create',
    {
      id: 'prj_rs485_line',
      name: 'Demo 3-Station Assembly Line',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
    },
    store
  );

  // Add 3 RS-485 Modbus RTU slaves on COM2 with unified 9600-8-N-1 framing
  for (const [id, name, sid] of [
    ['plc_st1', 'Station1_PLC', 1],
    ['plc_st2', 'Station2_PLC', 2],
    ['plc_st3', 'Station3_PLC', 3],
  ] as const) {
    const r = await invokeHaiwellTool(
      'haiwell_device_add',
      {
        projectId: 'prj_rs485_line',
        id,
        name,
        protocol: 'MODBUS_RTU',
        transport: 'RTU',
        serialPort: 'COM2',
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'NONE',
        stationId: sid,
      },
      store
    );
    assert.equal(r.ok, true);
  }

  // Reject mismatched parity on the same COM2 RS-485 bus
  const badParity = await invokeHaiwellTool(
    'haiwell_device_add',
    {
      projectId: 'prj_rs485_line',
      id: 'plc_st4_bad',
      name: 'Station4_BadParity',
      protocol: 'MODBUS_RTU',
      transport: 'RTU',
      serialPort: 'COM2',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'EVEN',
      stationId: 4,
    },
    store
  );
  assert.equal(badParity.ok, false);
  assert.match(badParity.error?.message ?? '', /RS485_FRAMING_MISMATCH/);

  // Reject duplicate Slave ID on COM2
  const dupId = await invokeHaiwellTool(
    'haiwell_device_add',
    {
      projectId: 'prj_rs485_line',
      id: 'plc_st4_dup',
      name: 'Station4_DupId',
      protocol: 'MODBUS_RTU',
      transport: 'RTU',
      serialPort: 'COM2',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'NONE',
      stationId: 2,
    },
    store
  );
  assert.equal(dupId.ok, false);
  assert.match(dupId.error?.message ?? '', /RS485_DUPLICATE_SLAVE_ID/);

  // Validate Haiwell native Modbus 0X/1X/3X/4X/W + bit-slice addresses and vendor map export
  const addrCheck = await invokeHaiwellTool(
    'haiwell_device_validate_address',
    {
      protocol: 'MODBUS_RTU',
      addresses: ['0X40', '0X13056', '1X13312', '3X10', '4X200', '4X4196', '4X200.3', 'W10'],
      includeAreaTable: true,
    },
    store
  );
  assert.equal(addrCheck.ok, true);
  const addrData = addrCheck.data as { allValid: boolean; vendorModbusMaps?: Record<string, unknown> };
  assert.equal(addrData.allValid, true);
  assert.ok(addrData.vendorModbusMaps?.MITSUBISHI_FX3U_MODBUS_RTU_SLAVE);
  assert.ok(addrData.vendorModbusMaps?.DELTA_DVP_ES2_MODBUS_RTU_SLAVE);

  // Upsert tags: valid 0X coil RW + valid 1X discrete input RO + valid 4X holding register RW,
  // and REJECT a writable tag accidentally mapped to 1X (Discrete Input is RO!)
  const tagRes = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_rs485_line',
      tags: [
        { name: 'ST1_Start_Cmd', scope: 'PLC', deviceId: 'plc_st1', address: '0X40', dataType: 'BOOL', access: 'RW' },
        { name: 'ST1_Sensor_X0', scope: 'PLC', deviceId: 'plc_st1', address: '1X13312', dataType: 'BOOL', access: 'RO' },
        { name: 'ST1_Cycle_Ms', scope: 'PLC', deviceId: 'plc_st1', address: '4X200', dataType: 'UINT16', access: 'RW', alwaysCollect: false },
        { name: 'ST3_Bad_Output', scope: 'PLC', deviceId: 'plc_st3', address: '1X2148', dataType: 'BOOL', access: 'RW' },
      ],
    },
    store
  );
  assert.equal(tagRes.ok, true);
  const td = tagRes.data as { upsertedCount: number; rejectedCount: number; errors: { tag: string; code: string }[] };
  assert.equal(td.upsertedCount, 3);
  assert.equal(td.rejectedCount, 1);
  assert.equal(td.errors[0].tag, 'ST3_Bad_Output');
  assert.equal(td.errors[0].code, 'READ_ONLY_REGISTER');
});

test('v2.3.0: Strict ES5 Node v0.10.41 enforcement, native $Device.Tag / Common.* runtime trap lints, and alwaysCollect/multi-timer audits', async () => {
  const store = new HaiwellProjectStore();
  await invokeHaiwellTool(
    'haiwell_project_create',
    {
      id: 'prj_b7h_runtime',
      name: 'Demo B7H Runtime Audit',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_device_add',
    {
      projectId: 'prj_b7h_runtime',
      id: 'plc_main',
      name: 'Modbus_1',
      protocol: 'MODBUS_RTU',
      transport: 'RTU',
      serialPort: 'COM2',
      stationId: 1,
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_b7h_runtime',
      tags: [
        { name: 'ST1_SEQ', scope: 'PLC', deviceId: 'plc_main', address: '4X200', dataType: 'UINT16', access: 'RW', alwaysCollect: false },
        { name: 'START_CMD', scope: 'PLC', deviceId: 'plc_main', address: '0X40', dataType: 'BOOL', access: 'RW', alwaysCollect: true },
        { name: 'SENSOR_IN', scope: 'PLC', deviceId: 'plc_main', address: '1X13312', dataType: 'BOOL', access: 'RO', alwaysCollect: true },
      ],
    },
    store
  );

  // 1. Reject ES6 syntax (const / arrow / template literal) on CLOUD_HMI_B7H
  const es6Fail = await invokeHaiwellTool(
    'haiwell_script_validate',
    {
      projectId: 'prj_b7h_runtime',
      code: 'const seq = Variable.GetByFullName("Modbus_1.ST1_SEQ"); const fn = () => `seq=${seq}`;',
    },
    store
  );
  assert.equal(es6Fail.ok, true);
  const es6Data = es6Fail.data as { valid: boolean; diagnostics: { code: string; severity: string }[] };
  assert.equal(es6Data.valid, false);
  assert.ok(es6Data.diagnostics.some((d) => d.code === 'HWJS-ES5-001' && d.severity === 'ERROR'));

  // 2. Reject writing to RO tag via native $Device.Tag syntax
  const roDollarFail = await invokeHaiwellTool(
    'haiwell_script_validate',
    {
      projectId: 'prj_b7h_runtime',
      code: '$Modbus_1.SENSOR_IN = 1;',
    },
    store
  );
  assert.equal((roDollarFail.data as { valid: boolean }).valid, false);

  // 3. Detect all 4 real Haiwell 3.50.x runtime traps as WARNINGs while keeping Strict ES5 + Common.SetInterval valid
  const trapScript = [
    'var sqls = ["INSERT INTO logs VALUES (1)"];',
    'Common.SetInterval(function() {',
    '  var seq = Variable.GetByFullName("Modbus_1.ST1_SEQ");',
    '  $Modbus_1.START_CMD = 1;',
    '  var t0 = new Date().getTime();',
    '  while (new Date().getTime() < t0 + 300) {}',
    '  Common.database.execTransaction(sqls, function() {});',
    '  Common.Ajax({ url: "https://api.example/ingest", method: "POST" }, function(res) { Common.Log(res); });',
    '}, 1000);',
  ].join('\n');
  const trapCheck = await invokeHaiwellTool(
    'haiwell_script_validate',
    { projectId: 'prj_b7h_runtime', trigger: 'STARTUP', code: trapScript },
    store
  );
  const trapData = trapCheck.data as { valid: boolean; referencedTags: string[]; diagnostics: { code: string }[] };
  assert.equal(trapData.valid, true);
  assert.ok(trapData.referencedTags.includes('ST1_SEQ'));
  assert.ok(trapData.referencedTags.includes('START_CMD'));
  const codes = new Set(trapData.diagnostics.map((d) => d.code));
  assert.ok(codes.has('HWJS-RT-001'));
  assert.ok(codes.has('HWJS-RT-002'));
  assert.ok(codes.has('HWJS-RT-003'));
  assert.ok(codes.has('HWJS-RT-004'));

  // 4. ST -> JS transpiler emits Strict ES5 with zero const/let/=>/Math.trunc and supports HAIWELL_NATIVE_350
  const stRes = await invokeHaiwellTool(
    'haiwell_iec61131_transpile_js',
    {
      projectId: 'prj_b7h_runtime',
      apiStyle: 'HAIWELL_NATIVE_350',
      source:
        'PROGRAM SeqCalc\nVAR_INPUT\n  RawVal : REAL;\nEND_VAR\nVAR_OUTPUT\n  OutInt : INT;\nEND_VAR\nOutInt := REAL_TO_INT(LIMIT(0.0, RawVal, 100.0));\nEND_PROGRAM',
      tagBindings: { RawVal: 'Modbus_1.ST1_SEQ', OutInt: 'Modbus_1.ST1_SEQ' },
    },
    store
  );
  const jsOut = (stRes.data as { jsCode: string }).jsCode;
  assert.doesNotMatch(jsOut, /\b(const|let)\b|=>|Math\.trunc/);
  assert.match(jsOut, /Variable\.GetByFullName\("Modbus_1\.ST1_SEQ"\)/);
  assert.match(jsOut, /Variable\.SetByFullName\("Modbus_1\.ST1_SEQ", OutInt\)/);

  // 5. Safety audit detects AUD-ALWAYS-COLLECT (ST1_SEQ not on screen & alwaysCollect=false) & AUD-MULTI-TIMER (>1 CYCLIC scripts)
  await invokeHaiwellTool(
    'haiwell_script_upsert',
    {
      projectId: 'prj_b7h_runtime',
      id: 'cyc_1',
      name: 'CyclicOne',
      trigger: 'CYCLIC',
      intervalMs: 1000,
      code: 'var s = Variable.GetByFullName("Modbus_1.ST1_SEQ"); Common.Log(s);',
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_script_upsert',
    {
      projectId: 'prj_b7h_runtime',
      id: 'cyc_2',
      name: 'CyclicTwo',
      trigger: 'CYCLIC',
      intervalMs: 2000,
      code: '$Modbus_1.START_CMD = 0;',
    },
    store
  );

  const auditBefore = await invokeHaiwellTool(
    'haiwell_project_audit_safety',
    { projectId: 'prj_b7h_runtime' },
    store
  );
  const findingsBefore = (auditBefore.data as { findings: { code: string; target: string }[] }).findings;
  assert.ok(findingsBefore.some((f) => f.code === 'AUD-MULTI-TIMER'));
  assert.ok(findingsBefore.some((f) => f.code === 'AUD-ALWAYS-COLLECT' && f.target === 'ST1_SEQ'));

  // Enable alwaysCollect on ST1_SEQ -> AUD-ALWAYS-COLLECT clears
  await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: 'prj_b7h_runtime',
      tags: [
        { name: 'ST1_SEQ', scope: 'PLC', deviceId: 'plc_main', address: '4X200', dataType: 'UINT16', access: 'RW', alwaysCollect: true },
      ],
    },
    store
  );
  const auditAfter = await invokeHaiwellTool(
    'haiwell_project_audit_safety',
    { projectId: 'prj_b7h_runtime' },
    store
  );
  const findingsAfter = (auditAfter.data as { findings: { code: string; target: string }[] }).findings;
  assert.equal(findingsAfter.some((f) => f.code === 'AUD-ALWAYS-COLLECT' && f.target === 'ST1_SEQ'), false);
});

