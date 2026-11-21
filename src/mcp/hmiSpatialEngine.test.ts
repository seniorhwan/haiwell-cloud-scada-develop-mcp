import test from 'node:test';
import assert from 'node:assert/strict';
import { HaiwellProjectStore } from './projectStore';
import {
  auditScreenSpatially,
  compileDesktopAutomationBridge,
  compilePidScreen,
  HAIWELL_HMI_TOOLBOX,
  solveAndRepairScreenLayout,
} from './hmiSpatialEngine';
import { invokeHaiwellTool } from './toolRegistry';

test('toolbox catalog exposes all Haiwell HMI component types with documented modal fields and P&ID ports', () => {
  assert.ok(HAIWELL_HMI_TOOLBOX.length >= 18);
  for (const type of ['TANK', 'PUMP', 'VALVE'] as const) {
    const item = HAIWELL_HMI_TOOLBOX.find((c) => c.type === type);
    assert.ok(item, `Missing toolbox spec for ${type}`);
    assert.ok(item.ports?.left && item.ports?.right && item.ports?.top && item.ports?.bottom);
    assert.equal(item.configUiMethod, 'DOUBLE_CLICK_OR_RIGHT_CLICK_PROPERTY_MODAL');
    assert.ok(item.documentedModalFields && Object.keys(item.documentedModalFields).length > 0);
  }
});

test('P&ID compiler handles closed recirculation loops with 0 collisions, 0px port gaps, and attached callouts', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  const res = compilePidScreen(
    {
      screenId: 'scr_chiller_pid_loop',
      name: 'Closed-Loop Chiller P&ID',
      width: 1280,
      height: 800,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      includeAlarmBanner: true,
      includeNavBar: true,
      nodes: [
        { id: 'tank_buf', type: 'TANK', label: 'Buffer Tank', calloutTagName: 'Return_Temp_C', calloutLabel: 'Return °C' },
        { id: 'pump_1', type: 'PUMP', label: 'Chiller Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { id: 'valve_1', type: 'VALVE', label: 'Modulating Valve', tagName: 'Valve_Position_Pct', writeEnabled: true, calloutTagName: 'Supply_Temp_C', calloutLabel: 'Supply °C' },
      ],
      edges: [
        { id: 'p_suction', from: 'tank_buf', to: 'pump_1', fluid: 'CHILLED_WATER', label: 'Suction' },
        { id: 'p_supply', from: 'pump_1', to: 'valve_1', fluid: 'CHILLED_WATER', label: 'Supply' },
        { id: 'p_return', from: 'valve_1', to: 'tank_buf', fluid: 'RETURN', label: 'Return Loop' },
      ],
    },
    prj.tags,
    { targetHardware: 'CLOUD_HMI_C10' }
  );

  assert.equal(res.spatialAudit.valid, true, `Expected valid P&ID layout, got ${JSON.stringify(res.spatialAudit.validation)}`);
  assert.equal(res.spatialAudit.validation.collisions.length, 0);
  assert.equal(res.spatialAudit.validation.outOfBounds.length, 0);
  assert.equal(res.spatialAudit.validation.touchTargetViolations.length, 0);
  assert.equal(res.portAttachmentProof.totalPipes, 3);
  assert.equal(res.portAttachmentProof.maxPortGapPx, 0, 'Every pipe endpoint must attach with 0px gap to its equipment port');
  assert.deepEqual(res.portAttachmentProof.recirculationEdges, ['p_return']);
  assert.match(res.svg, /<polyline /);
  assert.match(res.svg, /marker-end="url\(#pid-arrow\)"/);
  assert.match(res.spatialAudit.asciiMap, /\+[-]+\+/);
});

test('layout auto-repair solver eliminates stacked collisions, out-of-bounds coordinates, and tiny touch buttons', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // Deliberately corrupt layout: 6 widgets stacked at (50, 50) + tiny 24x24 touch button + off-screen widget
  const brokenScreen = {
    id: 'scr_broken',
    name: 'Deliberately Broken HMI',
    width: 800,
    height: 480,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE' as const,
    backgroundColor: '#E5E7EB',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: new Date().toISOString(),
    widgets: [
      { id: 'banner', type: 'ALARM_BANNER' as const, label: 'Alarms', x: 16, y: 16, width: 768, height: 44 },
      { id: 'w1', type: 'NUMERIC_DISPLAY' as const, label: 'Supply', x: 50, y: 50, width: 140, height: 60, tagName: 'Supply_Temp_C' },
      { id: 'w2', type: 'NUMERIC_DISPLAY' as const, label: 'Return', x: 50, y: 50, width: 140, height: 60, tagName: 'Return_Temp_C' },
      { id: 'w3', type: 'BIT_BUTTON' as const, label: 'Tiny Pump', x: 50, y: 50, width: 24, height: 24, tagName: 'Pump1_Run_Cmd', writeEnabled: true },
      { id: 'w4', type: 'NUMERIC_INPUT' as const, label: 'Offscreen SP', x: 950, y: 700, width: 140, height: 56, tagName: 'Chiller_Setpoint_C', writeEnabled: true },
      { id: 'nav', type: 'NAV_BAR' as const, label: 'Nav', x: 16, y: 420, width: 768, height: 44 },
    ],
  };

  const repaired = solveAndRepairScreenLayout(brokenScreen, 'CLOUD_HMI_C7');
  assert.equal(repaired.remainingCollisions, 0);
  assert.equal(repaired.remainingOutOfBounds, 0);
  assert.ok(repaired.resizedForTouch.includes('w3'));
  assert.ok(repaired.movedWidgets.length >= 3);

  const audit = auditScreenSpatially(repaired.screen, prj.tags, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(audit.valid, true);
  assert.equal(audit.validation.touchTargetViolations.length, 0);
});

test('desktop bridge exports native screen manifest + closed-loop pywinauto property-grid script and refuses invalid screens', async () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  // Compile P&ID via MCP tool, verify spatially, and export desktop bridge
  const pidRes = await invokeHaiwellTool(
    'haiwell_hmi_pid_compile',
    {
      projectId: prj.id,
      screenId: 'scr_pid_bridge',
      name: 'Chiller Bridge Test',
      nodes: [
        { id: 'eq_tank', type: 'TANK', label: 'Cold Tank' },
        { id: 'eq_pump', type: 'PUMP', label: 'Main Pump', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
      ],
      edges: [{ from: 'eq_tank', to: 'eq_pump', fluid: 'CHILLED_WATER' }],
    },
    store
  );
  assert.equal(pidRes.ok, true);

  const verifyRes = await invokeHaiwellTool(
    'haiwell_hmi_spatial_verify',
    { projectId: prj.id, screenId: 'scr_pid_bridge' },
    store
  );
  assert.equal(verifyRes.ok, true);
  assert.equal((verifyRes.data as { valid: boolean }).valid, true);

  const bridgeRes = await invokeHaiwellTool(
    'haiwell_hmi_desktop_bridge_export',
    { projectId: prj.id, screenId: 'scr_pid_bridge' },
    store
  );
  assert.equal(bridgeRes.ok, true);
  const bridge = bridgeRes.data as ReturnType<typeof compileDesktopAutomationBridge>;
  assert.equal(bridge.nativeImportManifest.schema, 'haiwell.scada.screen.v2');
  assert.equal(bridge.nativeImportManifest.hwdevDirectBinaryWriteSupported, false);
  assert.equal(bridge.nativeImportManifest.hwdevFileFormat, 'ENCRYPTED_PROPRIETARY_BINARY');
  assert.ok(bridge.uiaExecutionSteps.length >= 4);
  assert.match(bridge.pywinautoScript, /set_and_verify_property/);
  assert.match(bridge.pywinautoScript, /postConditionAssertions/);
  assert.match(bridge.pywinautoScript, /map_canvas_point/);
  const b64Match = /STEPS = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(bridge.pywinautoScript);
  assert.ok(b64Match, 'Expected Base64-encoded STEPS payload in pywinautoScript');
  const decodedStepsJson = Buffer.from(b64Match[1], 'base64').toString('utf8');
  assert.match(decodedStepsJson, /Pump1_Run_Cmd/);
  assert.doesNotThrow(() => JSON.parse(decodedStepsJson));

  // Refuses to export bridge if screen has unfixed collisions
  const broken = prj.screens.find((s) => s.id === 'scr_pid_bridge')!;
  broken.widgets[1].x = broken.widgets[2].x;
  broken.widgets[1].y = broken.widgets[2].y;
  assert.throws(() => compileDesktopAutomationBridge(broken, prj.tags), /Refusing to export desktop bridge/);
});

test('P&ID compiler places closed recirculation loop across horizontal columns even with standalone control widgets', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');

  const res = compilePidScreen(
    {
      screenId: 'scr_mixed_loop_controls',
      name: 'Mixed Loop + Controls',
      width: 1024,
      height: 600,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      includeAlarmBanner: true,
      includeNavBar: true,
      nodes: [
        { id: 'tank_1', type: 'TANK', label: 'Storage Tank' },
        { id: 'pump_1', type: 'PUMP', label: 'Feed Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { id: 'valve_1', type: 'VALVE', label: 'Outlet Valve', tagName: 'Valve_Position_Pct', writeEnabled: true },
        { id: 'sp_1', type: 'NUMERIC_INPUT', label: 'Setpoint', tagName: 'Chiller_Setpoint_C', writeEnabled: true },
        { id: 'btn_1', type: 'BIT_BUTTON', label: 'Auto Mode', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
        { id: 'lamp_1', type: 'BIT_LAMP', label: 'Running', tagName: 'Pump1_Run_Cmd' },
      ],
      edges: [
        { from: 'tank_1', to: 'pump_1', fluid: 'PROCESS' },
        { from: 'pump_1', to: 'valve_1', fluid: 'PROCESS' },
        { from: 'valve_1', to: 'tank_1', fluid: 'RETURN' },
      ],
    },
    prj.tags,
    { targetHardware: 'CLOUD_HMI_B7H' }
  );

  assert.equal(res.spatialAudit.valid, true);
  assert.equal(res.spatialAudit.validation.collisions.length, 0);
  const wTank = res.screen.widgets.find((w) => w.id === 'tank_1')!;
  const wPump = res.screen.widgets.find((w) => w.id === 'pump_1')!;
  const wValve = res.screen.widgets.find((w) => w.id === 'valve_1')!;
  assert.ok(wTank.x < wPump.x && wPump.x < wValve.x, 'Closed loop must span 3 left-to-right columns');
});

test('P&ID compiler rejects dangling edges and 3.50.1.19 catalog has Valve1/Pipe 1/Decimal digits', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  assert.throws(
    () =>
      compilePidScreen(
        {
          screenId: 'scr_bad_edge',
          name: 'BadEdge',
          width: 1024,
          height: 600,
          layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
          nodes: [{ id: 'tank_1', type: 'TANK', label: 'Tank 1' }],
          edges: [{ from: 'tank_1', to: 'missing_pump' }],
        },
        prj.tags
      ),
    /missing_pump/
  );
  const valveSpec = HAIWELL_HMI_TOOLBOX.find((c) => c.type === 'VALVE')!;
  assert.equal(valveSpec.haiwellToolboxName, 'Valve1');
  assert.equal(valveSpec.toolboxNameVerified, true);
  const numSpec = HAIWELL_HMI_TOOLBOX.find((c) => c.type === 'NUMERIC_DISPLAY')!;
  assert.equal(numSpec.documentedModalFields.precision, 'Decimal digits');
});
