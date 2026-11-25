import assert from 'node:assert/strict';
import test from 'node:test';
import { HaiwellProjectStore } from './projectStore';
import { invokeHaiwellTool } from './toolRegistry';
import { generateLedLampPng, generatePushbuttonPng } from './hwPngIcons';
import { SERVER_VERSION } from './version';

test('v2.12.0: Hard-coded HMI templates instantiate with 0 collisions/OOB at 1024x600 & 800x480 and emit image-backed BitSw/BitLamp', async () => {
  assert.equal(SERVER_VERSION, '2.12.0');

  // 1. PNG icon generator produces distinct valid 96x96 PNGs with deterministic MD5s
  const btn0 = generatePushbuttonPng('#16A34A', false);
  const btn1 = generatePushbuttonPng('#22C55E', true);
  const led0 = generateLedLampPng('#64748B', false);
  const led1 = generateLedLampPng('#22C55E', true);
  assert.notEqual(btn0.md5, btn1.md5);
  assert.notEqual(led0.md5, led1.md5);
  assert.equal(Buffer.from(btn0.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(Buffer.from(led1.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const store = new HaiwellProjectStore();
  await invokeHaiwellTool('haiwell_project_create', { id: 'prj_tpl_v212', name: 'TplDemo', targetHardware: 'CLOUD_HMI_B7H' }, store);
  await invokeHaiwellTool('haiwell_device_add', {
    projectId: 'prj_tpl_v212',
    id: 'plc1',
    name: 'PLC1',
    protocol: 'MODBUS_RTU',
    transport: 'RTU',
    serialPort: 'COM2',
    stationId: 1,
  }, store);
  await invokeHaiwellTool('haiwell_tag_upsert_batch', {
    projectId: 'prj_tpl_v212',
    tags: [
      { name: 'START', scope: 'PLC', deviceId: 'plc1', address: '0X0', dataType: 'BOOL', access: 'RW', initialValue: false },
      { name: 'STOP', scope: 'PLC', deviceId: 'plc1', address: '0X1', dataType: 'BOOL', access: 'RW', initialValue: false },
      { name: 'ESTOP', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: true },
      { name: 'YIELD', scope: 'INTERNAL', dataType: 'FLOAT32', access: 'RW', initialValue: 95.0, unit: '%' },
      { name: 'CNT', scope: 'PLC', deviceId: 'plc1', address: '4X0', dataType: 'UINT16', access: 'RW', initialValue: 10 },
      { name: 'RUN_ID', scope: 'INTERNAL', dataType: 'STRING', access: 'RW', initialValue: 'R1' },
    ],
  }, store);

  // 2. Instantiate all 4 templates with ZERO pixel coordinates
  const t1 = await invokeHaiwellTool('haiwell_hmi_template_instantiate', {
    projectId: 'prj_tpl_v212',
    template: 'INDUSTRIAL_LINE_OVERVIEW',
    screenId: 'scr_t1',
    name: 'Overview',
    title: 'LINE OVERVIEW',
    eStopTag: 'ESTOP',
    commands: [
      { label: 'START', tagName: 'START', role: 'PRIMARY_ACTION' },
      { label: 'STOP', tagName: 'STOP', role: 'DANGER_ACTION' },
    ],
    commIndicators: [{ label: 'PLC1 Online', tagName: 'ESTOP' }],
    gauge: { label: 'Yield', tagName: 'YIELD', unit: '%' },
    bar: { label: 'Count', tagName: 'CNT', unit: 'pcs' },
    heroKpis: [{ label: 'Finished', tagName: 'CNT', unit: 'pcs', role: 'KPI_HERO' }],
    stationCycles: [{ label: 'ST1', tagName: 'YIELD', unit: 's' }],
    ioIndicators: [{ label: 'Ready', tagName: 'START' }],
  }, store);
  assert.equal(t1.ok, true);
  assert.equal((t1.data as any).validation.valid, true);
  assert.equal((t1.data as any).validation.collisions.length, 0);

  const t2 = await invokeHaiwellTool('haiwell_hmi_template_instantiate', {
    projectId: 'prj_tpl_v212',
    template: 'MULTI_STATION_PROCESS_FLOW',
    screenId: 'scr_t2',
    name: 'Flow',
    title: 'LINE FLOW',
    width: 800,
    height: 480,
    stations: [
      { title: 'ST1', icon: 'HWReactor25', ioIndicators: [{ label: 'X0', tagName: 'START' }] },
      { title: 'ST2', icon: 'Motor1', secondaryIcon: 'HWGear1', kpi: { label: 'Out', tagName: 'CNT', unit: 'pcs' } },
    ],
    transfers: [{ label: 'Feed', fluid: 'TRANSFER' }],
  }, store);
  assert.equal(t2.ok, true);
  assert.equal((t2.data as any).validation.valid, true);
  assert.equal((t2.data as any).screen.width, 800);

  const t3 = await invokeHaiwellTool('haiwell_hmi_template_instantiate', {
    projectId: 'prj_tpl_v212',
    template: 'ALARMS_TRENDS_DIAGNOSTICS',
    screenId: 'scr_t3',
    name: 'Alarms',
    title: 'ALARMS & TRENDS',
    trendTagName: 'YIELD',
    runIdTagName: 'RUN_ID',
    sequenceCounters: [{ label: 'Seq1', tagName: 'CNT' }],
  }, store);
  assert.equal(t3.ok, true);
  assert.equal((t3.data as any).validation.valid, true);

  const t4 = await invokeHaiwellTool('haiwell_hmi_template_instantiate', {
    projectId: 'prj_tpl_v212',
    template: 'STATION_IO_DETAIL',
    screenId: 'scr_t4',
    name: 'StationIO',
    title: 'STATION I/O',
    inputs: [{ label: 'In0', tagName: 'START' }],
    outputs: [{ label: 'Out0', tagName: 'STOP', role: 'DANGER_ACTION' }],
  }, store);
  assert.equal(t4.ok, true);
  assert.equal((t4.data as any).validation.valid, true);

  const t5 = await invokeHaiwellTool('haiwell_hmi_template_instantiate', {
    projectId: 'prj_tpl_v212',
    template: 'STATION_IO_MONITOR',
    screenId: 'scr_t5',
    name: 'StationMonitor',
    title: 'STATION 1 — DISTRIBUTION',
    commTagName: 'START',
    commLabel: 'PLC ONLINE',
    outputs: [
      { label: 'START', tagName: 'START', role: 'PRIMARY_ACTION' },
      { label: 'STOP', tagName: 'STOP', role: 'DANGER_ACTION' },
      { label: 'RESET', tagName: 'STOP', role: 'WARNING_ACTION' },
    ],
    stationCounter: { label: 'TOTAL', tagName: 'CNT', unit: 'pcs' },
    inputs: Array.from({ length: 8 }, (_, i) => ({ label: `X${i} - SENSOR ${i}`, tagName: 'START' })),
    outputIndicators: Array.from({ length: 8 }, (_, i) => ({ label: `Y${i} - COIL ${i}`, tagName: 'STOP' })),
    navTabs: [
      { label: 'HOME', targetScreenName: 'Main_display' },
      { label: 'ST1', targetScreenName: 'StationMonitor', active: true },
    ],
  }, store);
  assert.equal(t5.ok, true);
  assert.equal((t5.data as any).validation.valid, true);
  assert.equal((t5.data as any).validation.collisions.length, 0);

  // 3. Export .hwExport and confirm image-backed BitSw/BitLamp + SymbolVariableUsing + WordSw->$ShowWindowId nav
  const exp = await invokeHaiwellTool('haiwell_project_export_hwexport', { projectId: 'prj_tpl_v212' }, store);
  assert.equal(exp.ok, true);
  const xml = (exp.data as { xml: string }).xml;
  assert.ok(xml.includes('<SymbolType>image</SymbolType>'));
  assert.ok(xml.includes('<SymbolVariableUsing>'));
  assert.ok(xml.includes('md5file=&quot;'));
  assert.ok(xml.includes('sym-type=&quot;WordSw&quot;'));
  assert.ok(xml.includes('WrtVar=&quot;$ShowWindowId&quot;'));
  assert.ok(xml.includes('<string>$ShowWindowId</string>'));
  assert.ok(xml.includes('<PropName>WrtVar-id</PropName>'));

  // 4. Verify haiwell_desktop_deploy_hwexport dryRun returns WordSw->$ShowWindowId + watcher/deploy scripts
  const dep = await invokeHaiwellTool(
    'haiwell_desktop_deploy_hwexport',
    {
      projectId: 'prj_tpl_v212',
      hwdevPath: 'C:\\Temp\\Project1.hwdev',
      outputDir: 'C:\\Temp\\exports',
      dryRun: true,
    },
    store
  );
  assert.equal(dep.ok, true);
  const depData = dep.data as {
    deployed: boolean;
    mode: string;
    deployScript: string;
    watcherScript: string;
  };
  assert.equal(depData.deployed, false);
  assert.equal(depData.mode, 'DRY_RUN');
  assert.ok(depData.deployScript.includes('"1148"'));
  assert.ok(depData.watcherScript.includes('watcher.heartbeat.json'));

  // 5. Verify MAIN_NAVIGATION_HUB (custom PNG logo), STATION_ALARMS_SIMPLE, and EDGE_LOGGER_CONSOLE
  const t6 = await invokeHaiwellTool(
    'haiwell_hmi_template_instantiate',
    {
      projectId: 'prj_tpl_v212',
      template: 'MAIN_NAVIGATION_HUB',
      screenId: 'scr_t6',
      name: 'Main_display',
      title: 'FESTO MPS 3-STATION HMI',
      brandingLogos: [{ base64: btn0.base64, x: 20, y: 16, width: 180, height: 52 }],
      commTagName: 'START',
      commLabel: 'ALARM',
      commands: [{ label: 'START ALL', tagName: 'START', role: 'PRIMARY_ACTION' }],
      commIndicators: [{ label: 'PLC 1', tagName: 'START' }],
      ioIndicators: [{ label: 'CLOUD OK', tagName: 'START' }],
      stationCounter: { label: 'ALARMS', tagName: 'CNT', unit: '' },
      hubNavCards: [{ label: 'ST1', targetScreenName: 'StationMonitor', targetWindowId: 2 }],
      heroKpis: [{ label: 'FINISHED', tagName: 'CNT', unit: 'pcs' }],
      navTabs: [{ label: 'HOME', targetScreenName: 'Main_display', targetWindowId: 1, active: true }],
    },
    store
  );
  assert.equal(t6.ok, true);
  assert.equal((t6.data as any).validation.valid, true);
  assert.equal((t6.data as any).validation.collisions.length, 0);

  const t7 = await invokeHaiwellTool(
    'haiwell_hmi_template_instantiate',
    {
      projectId: 'prj_tpl_v212',
      template: 'STATION_ALARMS_SIMPLE',
      screenId: 'scr_t7',
      name: 'ALARMS',
      title: 'SYSTEM ALARMS',
      commTagName: 'START',
      inputs: [{ label: 'PLC 1 OFFLINE', tagName: 'START' }],
      stationCounter: { label: 'ACTIVE', tagName: 'CNT', unit: '' },
      outputs: [{ label: 'ACK ALL', tagName: 'STOP', role: 'WARNING_ACTION' }],
      leftReadouts: [{ label: 'LATEST', tagName: 'CNT' }],
    },
    store
  );
  assert.equal(t7.ok, true);
  assert.equal((t7.data as any).validation.valid, true);

  const t8 = await invokeHaiwellTool(
    'haiwell_hmi_template_instantiate',
    {
      projectId: 'prj_tpl_v212',
      template: 'EDGE_LOGGER_CONSOLE',
      screenId: 'scr_t8',
      name: 'DATA_LOGGING',
      title: 'CLOUD EDGE LOGGER',
      runIdTagName: 'CNT',
      outputs: [{ label: 'FLUSH', tagName: 'START', role: 'PRIMARY_ACTION' }],
      commIndicators: [{ label: 'CLOUD OK', tagName: 'START' }],
      heroKpis: [{ label: 'PENDING', tagName: 'CNT', unit: 'rows' }],
      leftReadouts: [{ label: 'STATUS', tagName: 'CNT' }],
      sequenceCounters: [{ label: 'ST1 CYCLE', tagName: 'CNT', unit: 'x10ms' }],
    },
    store
  );
  assert.equal(t8.ok, true);
  assert.equal((t8.data as any).validation.valid, true);
});
