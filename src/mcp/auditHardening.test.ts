import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server';
import { HaiwellProjectStore } from './projectStore';
import { invokeHaiwellTool, buildProjectExportBundle, runProjectSafetyAudit } from './toolRegistry';
import { validateStructuredText, transpileStToHaiwellJs } from './iec61131';
import { validateHaiwellScript } from './scriptAnalyzer';
import { runSimulationSteps } from './simulationEngine';
import { compileDesktopAutomationBridge, compileFullOpenProjectBridge, compilePidScreen } from './hmiSpatialEngine';
import { parseHaiwellLngContent } from './desktopAutomation';
import { generateClientConfigs } from './resourcesAndPrompts';
import { SERVER_VERSION } from './version';

async function executeHaiwellTool(name: string, args: unknown, store: HaiwellProjectStore): Promise<unknown> {
  const res = await invokeHaiwellTool(name, args, store);
  assert.equal(res.ok, true, `Tool ${name} failed: ${JSON.stringify(res.error)}`);
  return res.data;
}

// =========================================================================
// 1. DESKTOP UIA BRIDGE (hmiSpatialEngine.ts)
// =========================================================================
test('Audit #1: Desktop bridge generates full live UIA sections, adjacent-label helper, pipe drawing, catalog overrides, and clipboard restore', () => {
  const store = new HaiwellProjectStore();
  const project = store.getProject('prj_chiller_plant_01');

  // Compile a P&ID screen with a pipe so draw_pipes is populated
  const pid = compilePidScreen(
    {
      screenId: 'scr_audit_pid',
      name: 'Audit PID',
      width: 1280,
      height: 800,
      layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
      nodes: [
        { id: 'n_pump', type: 'PUMP', label: 'Pump 1', tagName: 'Pump1_Run_Cmd' },
        { id: 'n_valve', type: 'VALVE', label: 'Bypass Valve', tagName: 'Valve_Position_Pct' },
        { id: 'n_tank', type: 'TANK', label: 'Buffer Tank', tagName: 'Supply_Temp_C' },
      ],
      edges: [
        { id: 'e1', from: 'n_pump', to: 'n_valve', flowTagName: 'Pump1_Run_Cmd', fluid: 'CHILLED_WATER' },
        { id: 'e2', from: 'n_valve', to: 'n_tank', fluid: 'PROCESS' },
      ],
    },
    project.tags
  );
  project.screens.push(pid.screen);
  store.saveProject(project);

  const screenBridge = compileDesktopAutomationBridge(pid.screen, project.tags, {
    catalogOverrides: { PUMP: 'Motor 3' },
  });
  assert.ok(screenBridge.pipeSteps.length >= 2, 'Should emit pipeSteps for P&ID pipes');
  assert.ok(screenBridge.pywinautoScript.includes('resolve_input_near_label'), 'Should use adjacent-Label WinForms input resolver');
  assert.ok(screenBridge.pywinautoScript.includes('def draw_pipes('), 'Should include draw_pipes function');
  assert.ok(
    screenBridge.uiaExecutionSteps.some((w) => w.toolboxItemName === 'Motor 3'),
    'catalogOverrides should override PUMP toolboxItemName'
  );

  const fullBridge = compileFullOpenProjectBridge(project, {
    sections: ['devices', 'variables', 'tasks', 'events', 'displays'],
    catalogOverrides: { PUMP: 'Motor 3' },
  });
  const py = fullBridge.pywinautoScript;
  assert.ok(py.includes('def run_devices('));
  assert.ok(py.includes('def run_variables('));
  assert.ok(py.includes('def run_tasks('));
  assert.ok(py.includes('def run_events('));
  assert.ok(py.includes('def run_displays('));
  assert.ok(py.includes('resolve_input_near_label'));
  assert.ok(py.includes('draw_pipes'));
  assert.ok(py.includes('prev_clip') && py.includes('finally:'), 'Full open-project script should preserve and restore clipboard in try/finally');
  assert.ok(py.includes('pyperclip.copy(task["code"])'), 'Tasks section should paste script via clipboard');
  assert.ok(py.includes('Event selection'), 'Events section should drive Event selection dialog');
  // Ensure run_displays has real non-dry-run logic (not a dry-run-only stub)
  assert.ok(py.includes('Graphics library') && py.includes('draw_pipes'), 'Displays section should drive Graphics library and draw widgets + pipes');
});

// =========================================================================
// 2. IEC 61131-3 ST VALIDATOR & TRANSPILER (iec61131.ts)
// =========================================================================
test('Audit #2: IEC 61131-3 ST supports quote-aware splitting, comma VARs, initializers, TON FB, XOR, CASE ranges, TIME#, default HAIWELL_NATIVE_350, and Acorn ES5 check', () => {
  const st = `
PROGRAM AuditST
VAR_INPUT
  Start_Cmd : BOOL;
  Mode_Sel : INT;
END_VAR
VAR
  A, B : INT := 5;
  Msg : STRING := 'a; b THEN c';
  StartDelay : TON;
  Flag : BOOL;
END_VAR
VAR_OUTPUT
  Out_Val : INT;
  Delayed_Out : BOOL;
END_VAR
Flag := Start_Cmd XOR FALSE;
StartDelay(IN := Flag, PT := T#2s);
Delayed_Out := StartDelay.Q;
CASE Mode_Sel OF
  1..3:
    Out_Val := A + B;
  4, 5:
    Out_Val := 20;
  ELSE
    Out_Val := 0;
END_CASE;
END_PROGRAM
`;
  const val = validateStructuredText(st);
  assert.equal(val.valid, true, `Expected valid ST, got: ${JSON.stringify(val.diagnostics)}`);
  assert.ok(val.variables.some((v) => v.name === 'A' && v.initialValue === '5'));
  assert.ok(val.variables.some((v) => v.name === 'B' && v.initialValue === '5'));
  assert.ok(val.variables.some((v) => v.name === 'Msg'));

  const transpiled = transpileStToHaiwellJs(st);
  assert.equal(transpiled.success, true, `Transpile failed: ${JSON.stringify(transpiled.validation.diagnostics)}`);
  assert.ok(transpiled.jsCode, 'Should produce JS output');
  assert.ok(transpiled.jsCode.includes('Variable.GetByFullName'), 'Default apiStyle should be HAIWELL_NATIVE_350');
  assert.ok(transpiled.jsCode.includes('Variable.SetByFullName'), 'Default apiStyle should emit Variable.SetByFullName');
  assert.ok(transpiled.jsCode.includes('__FB_TON'), 'Should emit Standard FB TON runtime helper');
  assert.ok(transpiled.jsCode.includes('2000'), 'Should convert T#2s to 2000 ms');
  assert.ok(transpiled.jsCode.includes('Boolean(') && transpiled.jsCode.includes('!=='), 'Should translate XOR cleanly');
  assert.ok(transpiled.jsCode.includes('>= 1 &&') && transpiled.jsCode.includes('<= 3'), 'Should translate CASE 1..3 range');
});

// =========================================================================
// 3. REAL HAIWELL 3.50.1.19 CSV, PRO-SERIES HMI, AUD-HMI-LAYOUT HIGH & PIPE CASCADE
// =========================================================================
test('Audit #3: Real 3.50.1.19 CSV columns, PRO-series HMI RTSP compatibility, AUD-HMI-LAYOUT HIGH on broken binding, and pipe cascade cleanup', async () => {
  const store = new HaiwellProjectStore();
  const project = store.getProject('prj_chiller_plant_01');

  // 3a. CSV export headers match Haiwell 3.50.1.19 Variable Grid
  const bundle = buildProjectExportBundle(project);
  const csv = bundle.artifacts['haiwell_variables_import.csv'];
  const firstLine = csv.split('\n')[0];
  assert.equal(
    firstLine,
    'Variable name,Register type,Address format,Register address,Address length,Data type,The mode of reading and writing,Collect frequency,Always collect,Description'
  );
  assert.ok(csv.includes('Read only') || csv.includes('Read and write'));

  // 3b. PRO-series HMI creation + RTSP allowed vs B7H blocked
  const proRes = (await executeHaiwellTool(
    'haiwell_project_create',
    {
      id: 'prj_pro_rtsp_01',
      name: 'PRO HMI RTSP Plant',
      targetHardware: 'CLOUD_HMI_A10_PRO',
      width: 1280,
      height: 800,
    },
    store
  )) as { projectId: string; targetHardware: string };
  assert.equal(proRes.projectId, 'prj_pro_rtsp_01');
  assert.equal(proRes.targetHardware, 'CLOUD_HMI_A10_PRO');

  await executeHaiwellTool(
    'haiwell_camera_bind',
    {
      projectId: 'prj_pro_rtsp_01',
      id: 'cam_pro_1',
      name: 'Yard Cam',
      protocol: 'RTSP',
      streamUri: 'rtsp://10.0.0.50:554/stream1',
    },
    store
  );
  const proAudit = runProjectSafetyAudit(store.getProject('prj_pro_rtsp_01'));
  assert.equal(
    proAudit.findings.some((f) => f.code === 'AUD-HW-COMPAT-RTSP'),
    false,
    'A10 PRO should allow RTSP cameras without AUD-HW-COMPAT-RTSP'
  );

  // 3c. AUD-HMI-LAYOUT becomes HIGH when unresolvedTags exist, blocking deploymentReady
  const brokenScreenPrj = store.getProject('prj_chiller_plant_01');
  brokenScreenPrj.screens[0].widgets.push({
    id: 'w_broken_tag_test',
    type: 'NUMERIC_DISPLAY',
    label: 'Ghost',
    x: 20,
    y: 500,
    width: 140,
    height: 60,
    tagName: 'NonExistent_Tag_XYZ',
    writeEnabled: false,
  });
  const auditBroken = runProjectSafetyAudit(brokenScreenPrj);
  const hmiFinding = auditBroken.findings.find((f) => f.code === 'AUD-HMI-LAYOUT');
  assert.ok(hmiFinding, 'Should report AUD-HMI-LAYOUT');
  assert.equal(hmiFinding?.severity, 'HIGH', 'Unresolved widget tag must escalate AUD-HMI-LAYOUT to HIGH');
  assert.equal(auditBroken.deploymentReady, false);

  // 3d. Cascade tag deletion prunes pipe.flowTagName
  const pipeStore = new HaiwellProjectStore();
  const pipePrj = pipeStore.getProject('prj_chiller_plant_01');
  await executeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: pipePrj.id,
      tags: [{ name: 'Flow_Pipe_Test', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: false }],
    },
    pipeStore
  );
  const p = pipeStore.getProject(pipePrj.id);
  p.screens[0].pipes = [
    {
      id: 'pipe_test_1',
      fromWidgetId: 'w_pump_1',
      toWidgetId: 'w_valve_1',
      fromPort: 'right',
      toPort: 'left',
      waypoints: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
      fluid: 'PROCESS',
      flowTagName: 'Flow_Pipe_Test',
    },
  ];
  pipeStore.saveProject(p);

  const blockedDel = (await executeHaiwellTool(
    'haiwell_entity_delete',
    { projectId: pipePrj.id, entityType: 'tag', entityId: 'Flow_Pipe_Test', cascade: false },
    pipeStore
  )) as { deleted: boolean; dependents?: string[] };
  assert.equal(blockedDel.deleted, false);
  assert.ok(blockedDel.dependents?.some((d) => d.includes('pipe:pipe_test_1')));

  const cascadeDel = (await executeHaiwellTool(
    'haiwell_entity_delete',
    { projectId: pipePrj.id, entityType: 'tag', entityId: 'Flow_Pipe_Test', cascade: true },
    pipeStore
  )) as { deleted: boolean };
  assert.equal(cascadeDel.deleted, true);
  assert.equal(pipeStore.getProject(pipePrj.id).screens[0].pipes?.[0].flowTagName, undefined);
});

// =========================================================================
// 4. HEADLESS PLC/SCADA SIMULATOR (simulationEngine.ts)
// =========================================================================
test('Audit #4: Headless simulator executes ST POUs & Haiwell JS scripts in VM sandbox with persistent TON timers and configurable E-Stop override', async () => {
  const store = new HaiwellProjectStore();
  const project = store.getProject('prj_chiller_plant_01');

  // Seeded ComputePlantDeltaT script should compute Plant_DeltaT_C = Return_Temp_C - Supply_Temp_C
  const sim1 = runSimulationSteps(JSON.parse(JSON.stringify(project)), {
    injectTagValues: { Supply_Temp_C: 6.5, Return_Temp_C: 14.0, EStop_OK: true },
    steps: 1,
    scanIntervalMs: 1000,
    enforceEStopSafeState: true,
  });
  assert.equal(sim1.finalTags['Plant_DeltaT_C'], 7.5, 'ComputePlantDeltaT JS script should execute and update Plant_DeltaT_C');
  assert.ok(sim1.trace[0].executedScripts.includes('ComputePlantDeltaT'));

  // Add a stateful TON ST POU and verify multi-step timer persistence
  await executeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      projectId: project.id,
      tags: [
        { name: 'Timer_Enable', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: false },
        { name: 'Timer_Done', scope: 'INTERNAL', dataType: 'BOOL', access: 'RW', initialValue: false },
        { name: 'Custom_Safety_OK', scope: 'INTERNAL', dataType: 'BOOL', access: 'RO', safetyClass: 'SIL3', initialValue: true },
      ],
    },
    store
  );
  await executeHaiwellTool(
    'haiwell_iec61131_pou_save',
    {
      projectId: project.id,
      id: 'pou_delay_timer',
      name: 'DelayTimerPOU',
      pouType: 'PROGRAM',
      language: 'ST',
      source: `PROGRAM DelayTimerPOU
VAR_INPUT
  Timer_Enable : BOOL;
END_VAR
VAR
  T1 : TON;
END_VAR
VAR_OUTPUT
  Timer_Done : BOOL;
END_VAR
T1(IN := Timer_Enable, PT := T#2s);
Timer_Done := T1.Q;
END_PROGRAM`,
      boundTags: ['Timer_Enable', 'Timer_Done'],
    },
    store
  );

  const simTimer = runSimulationSteps(JSON.parse(JSON.stringify(store.getProject(project.id))), {
    injectTagValues: { Timer_Enable: true, EStop_OK: true },
    steps: 3,
    scanIntervalMs: 1000,
    enforceEStopSafeState: true,
  });
  assert.equal(simTimer.trace[0].tagsSnapshot['Timer_Done'], false, 'Step 1 (1000ms < 2000ms): TON Q must still be false');
  assert.equal(simTimer.trace[1].tagsSnapshot['Timer_Done'], true, 'Step 2 (2000ms >= 2000ms): TON Q must become true');
  assert.equal(simTimer.finalTags['Timer_Done'], true);

  // Configurable eStopTagName post-logic safe-state enforcement
  const simCustomEstop = runSimulationSteps(JSON.parse(JSON.stringify(store.getProject(project.id))), {
    injectTagValues: { Custom_Safety_OK: false, Pump1_Run_Cmd: true, Valve_Position_Pct: 80 },
    eStopTagName: 'Custom_Safety_OK',
    steps: 1,
    enforceEStopSafeState: true,
  });
  assert.equal(simCustomEstop.finalTags['Pump1_Run_Cmd'], false, 'Custom E-Stop must force SIL2 Pump1_Run_Cmd=false');
  assert.equal(simCustomEstop.finalTags['Valve_Position_Pct'], 0, 'Custom E-Stop must force SIL2 Valve_Position_Pct=0');
});

// =========================================================================
// 5. HONEST SIMULATED PROTOCOL STATUS (toolRegistry.ts)
// =========================================================================
test('Audit #5: MQTT & OPC UA tools explicitly annotate simulatedLoopback / transport / simulatedAddressSpace', async () => {
  const store = new HaiwellProjectStore();

  const mqttPub = (await executeHaiwellTool(
    'haiwell_mqtt_exchange',
    { projectId: 'prj_chiller_plant_01', action: 'PUBLISH_BINDING', bindingId: 'mqtt_bind_telemetry' },
    store
  )) as Record<string, unknown>;
  assert.equal(mqttPub.simulatedLoopback, true);
  assert.equal(mqttPub.transport, 'IN_MEMORY_LOOPBACK');

  const mqttRead = (await executeHaiwellTool(
    'haiwell_mqtt_exchange',
    { projectId: 'prj_chiller_plant_01', action: 'READ_LOOPBACK' },
    store
  )) as Record<string, unknown>;
  assert.equal(mqttRead.simulatedLoopback, true);

  const opcBrowse = (await executeHaiwellTool(
    'haiwell_opcua_browse_read_write',
    { projectId: 'prj_chiller_plant_01', action: 'BROWSE' },
    store
  )) as Record<string, unknown>;
  assert.equal(opcBrowse.simulatedAddressSpace, true);
});

// =========================================================================
// 6. PROJECT STORE SNAPSHOT PERSISTENCE (projectStore.ts)
// =========================================================================
test('Audit #6: HaiwellProjectStore persists snapshots across restarts in workspace.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haiwell-store-test-'));
  try {
    const store1 = new HaiwellProjectStore(tmpDir);
    const snap = store1.createSnapshot('prj_chiller_plant_01', 'Pre-FAT Baseline');
    assert.ok(snap.snapshotId);

    // Reload from disk in a fresh store instance
    const store2 = new HaiwellProjectStore(tmpDir);
    const snaps = store2.listSnapshots('prj_chiller_plant_01');
    assert.equal(snaps.length, 1, 'Snapshot must survive restart via workspace.json');
    assert.equal(snaps[0].snapshotId, snap.snapshotId);
    assert.equal(snaps[0].label, 'Pre-FAT Baseline');

    // Verify seeded ComputePlantDeltaT uses Variable.GetByFullName / SetByFullName
    const prj = store2.getProject('prj_chiller_plant_01');
    const deltaScript = prj.scripts.find((s) => s.name === 'ComputePlantDeltaT');
    assert.ok(deltaScript?.code.includes('Variable.GetByFullName'));
    assert.ok(deltaScript?.code.includes('Variable.SetByFullName'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 7. AST-BASED HAIWELL JS STATIC ANALYZER (scriptAnalyzer.ts)
// =========================================================================
test('Audit #7: Acorn AST script analyzer catches syntax/ES6 errors, respects lexical scope, tracks $Tag & BatchSet, and blocks fake string-literal EStop interlocks', () => {
  const store = new HaiwellProjectStore();
  const tags = store.getProject('prj_chiller_plant_01').tags;

  // Real JS syntax error
  const badSyntax = validateHaiwellScript('var x = ;', tags);
  assert.equal(badSyntax.valid, false);
  assert.ok(badSyntax.diagnostics.some((d) => d.code === 'HWJS-SYN-001'));

  // ES6 syntax error (for..of / destructuring) & ES6 runtime API (.includes / Object.assign) under strictEs5
  const es6Code = validateHaiwellScript(
    'var arr = [1, 2]; var hasOne = arr.includes(1); var copy = Object.assign({}, { a: 1 });',
    tags,
    { strictEs5: true }
  );
  assert.equal(es6Code.valid, false);
  assert.ok(es6Code.diagnostics.some((d) => d.code === 'HWJS-ES5-002'));

  // Lexical scope: local `var process = 1;` is safe, unbound `process.exit(1)` is blocked
  const localShadow = validateHaiwellScript('var process = 1; var x = process + 2;', tags);
  assert.equal(localShadow.valid, true, `Local var process should not trigger HWJS-SEC-001: ${JSON.stringify(localShadow.diagnostics)}`);

  const unboundProcess = validateHaiwellScript('process.exit(1);', tags);
  assert.equal(unboundProcess.valid, false);
  assert.ok(unboundProcess.diagnostics.some((d) => d.code === 'HWJS-SEC-001'));

  const protoEscape = validateHaiwellScript('var a = {}; a.__proto__.polluted = 1;', tags);
  assert.equal(protoEscape.valid, false);
  assert.ok(protoEscape.diagnostics.some((d) => d.code === 'HWJS-SEC-001'));

  // Single-level $InternalTag & Variable.BatchSetByFullNames tracking
  const dollarAndBatch = validateHaiwellScript(
    'var t = $Supply_Temp_C; Variable.BatchSetByFullNames({ Plant_DeltaT_C: t });',
    tags
  );
  assert.equal(dollarAndBatch.valid, true, JSON.stringify(dollarAndBatch.diagnostics));
  assert.ok(dollarAndBatch.referencedTags.includes('Supply_Temp_C'));
  assert.ok(dollarAndBatch.referencedTags.includes('Plant_DeltaT_C'));

  // Fake EStop_OK inside a string literal must NOT suppress HWJS-SAFE-003
  const fakeInterlock = validateHaiwellScript(
    'var msg = "EStop_OK"; Variable.SetByFullName("Pump1_Run_Cmd", true);',
    tags
  );
  assert.ok(
    fakeInterlock.diagnostics.some((d) => d.code === 'HWJS-SAFE-003'),
    'String literal "EStop_OK" must not satisfy SIL2/SIL3 interlock check'
  );
});

// =========================================================================
// 8. SERVER SECURITY, POOLING, VERSION UNIFICATION & ABSOLUTE STDIO CONFIGS
// =========================================================================
test('Audit #8: Host injection blocked, /api/manifest redacts projects when auth enabled, SERVER_VERSION unified, pooled POST /mcp succeeds repeatedly, stdio config uses absolute paths', async () => {
  const app = createApp(new HaiwellProjectStore(), { authToken: 'secret-audit-token-123' });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Host / X-Forwarded-Host spoofing ignored when TRUST_PROXY is not 'true'
    const rootRes = await fetch(`${base}/`, {
      headers: { 'X-Forwarded-Host': 'evil.attacker.com', 'X-Forwarded-Proto': 'https' },
    });
    const rootJson = (await rootRes.json()) as Record<string, unknown>;
    assert.equal(rootJson.version, SERVER_VERSION);
    const endpoints = rootJson.endpoints as Record<string, string>;
    assert.ok(!endpoints.mcp.includes('evil.attacker.com'), 'Spoofed X-Forwarded-Host must be ignored by default');

    // Unauthenticated /api/manifest redacts projects when authToken is configured
    const unauthManifest = (await (await fetch(`${base}/api/manifest`)).json()) as Record<string, unknown>;
    assert.equal(unauthManifest.schemaVersion, SERVER_VERSION);
    assert.equal(unauthManifest.projectsRedacted, true);
    assert.equal(unauthManifest.projects, undefined);

    // Authenticated /api/manifest includes projects
    const authManifest = (await (
      await fetch(`${base}/api/manifest`, {
        headers: { Authorization: 'Bearer secret-audit-token-123' },
      })
    ).json()) as Record<string, unknown>;
    assert.equal(authManifest.projectsRedacted, undefined);
    assert.ok(Array.isArray(authManifest.projects));

    // Repeated POST /mcp requests exercise pooled McpServer reuse cleanly
    for (let i = 1; i <= 3; i++) {
      const mcpRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-audit-token-123',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: i,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.equal(mcpRes.status, 200, `POST /mcp iteration ${i} should succeed (got ${mcpRes.status})`);
      const body = (await mcpRes.json()) as { result?: { tools?: unknown[] } };
      assert.ok((body.result?.tools?.length ?? 0) >= 60, 'Should list all 61 MCP tools');
    }

    // Client configs emit absolute stdio.ts path and cwd
    const configs = generateClientConfigs(base);
    const claudeCfg = JSON.parse(configs['claude-code'].config) as {
      mcpServers: { 'haiwell-cloud-scada-local': { args: string[]; cwd: string } };
    };
    assert.ok(path.isAbsolute(claudeCfg.mcpServers['haiwell-cloud-scada-local'].args[1]));
    assert.ok(path.isAbsolute(claudeCfg.mcpServers['haiwell-cloud-scada-local'].cwd));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// =========================================================================
// 9. LIVE WINDOWS DESKTOP AUTOMATION TOOLS (desktopAutomation.ts)
// =========================================================================
test('Audit #9: Desktop automation parses .lng files and generates splash-safe launch & UIA New Project scripts', async () => {
  const lng = `
[Main]
menu_project=项目(P)
menu_new_project=新建项目
frmnewproject=项目属性
lblprojectname=项目名称
lblruntimeplatform=运行平台
lbldevicemodel=设备型号
lblresolution=分辨率
lblnetworkport=端口
btnok=确定
`;
  const labels = parseHaiwellLngContent(lng, 'zh-cn');
  assert.equal(labels.projectMenu, '项目(P)');
  assert.equal(labels.newProjectMenuItem, '新建项目');
  assert.equal(labels.okButton, '确定');

  const store = new HaiwellProjectStore();
  const inspectRes = (await executeHaiwellTool('haiwell_desktop_inspect', {}, store)) as Record<string, unknown>;
  assert.ok(typeof inspectRes.installDir === 'string');
  assert.ok(typeof inspectRes.exePath === 'string');

  const launchRes = (await executeHaiwellTool(
    'haiwell_desktop_launch',
    { timeoutSec: 20, dryRun: true },
    store
  )) as { executed: boolean; powershellScript: string };
  assert.equal(launchRes.executed, false);
  assert.ok(launchRes.powershellScript.includes("MainWindowTitle -match 'Haiwell Cloud Scada'"));

  const newPrjRes = (await executeHaiwellTool(
    'haiwell_desktop_new_project',
    {
      projectName: 'Factory_Line_01',
      runtimePlatform: 'Cloud HMI',
      deviceModel: 'Haiwell HMI B7H',
      resolution: '1024*600',
      networkProjectPort: 8888,
      dryRun: true,
    },
    store
  )) as { executed: boolean; powershellScript: string };
  assert.equal(newPrjRes.executed, false);
  assert.ok(newPrjRes.powershellScript.includes('Get-AdjacentControl'));
  assert.ok(newPrjRes.powershellScript.includes('ControlType]::MenuItem'));
  assert.ok(newPrjRes.powershellScript.includes('finally {'));
});
