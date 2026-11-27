import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HaiwellProjectStore } from './projectStore';
import {
  auditHmiScreenDesign,
  autoFixHmiScreenDesign,
  computeBitButtonGeometry,
  computeBitLampGeometry,
  contrastRatio,
  pickReadableTextColor,
  resolveWidgetSurfaceContext,
} from './hmiDesignSystem';
import { compileProjectToHwExport } from './hwExportCompiler';
import { instantiateHmiTemplateDetailed } from './hmiTemplates';
import { detectWidgetCollisions, renderScreenToSvg, validateHmiScreen } from './hmiGenerator';
import { solveAndRepairScreenLayout } from './hmiSpatialEngine';
import { generateSolidPngBase64 } from './hwPngIcons';
import { getToolsForProfile, HAIWELL_TOOLS, invokeHaiwellTool, runProjectSafetyAudit } from './toolRegistry';
import {
  generateAgentSkillMarkdown,
  HAIWELL_PROMPTS,
  HAIWELL_RESOURCES,
  readHaiwellResource,
} from './resourcesAndPrompts';
import { SERVER_VERSION } from './version';
import type { HmiScreen } from './types';

function unescapeXml(xml: string): string {
  return xml
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('hmiDesignSystem: WCAG contrast math, surface inheritance & readable foreground selection', () => {
  assert.ok(contrastRatio('#FFFFFF', '#0F172A') > 15);
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  assert.equal(pickReadableTextColor('#1E293B', '#0F172A'), '#F8FAFC');
  assert.equal(pickReadableTextColor('#F8FAFC', '#FFFFFF'), '#0F172A');

  const screen: HmiScreen = {
    id: 'scr_surface_test',
    name: 'Surface Test',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#E2E8F0',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      {
        id: 'dark_hdr',
        type: 'GROUP_PANEL',
        label: 'TOP BANNER',
        x: 0,
        y: 0,
        width: 1024,
        height: 52,
        props: { theme: 'dark' },
      },
      {
        id: 'hdr_lamp',
        type: 'BIT_LAMP',
        label: 'E-STOP',
        x: 840,
        y: 12,
        width: 160,
        height: 28,
      },
      {
        id: 'light_panel',
        type: 'GROUP_PANEL',
        label: 'CONTROLS',
        x: 16,
        y: 64,
        width: 400,
        height: 240,
      },
      {
        id: 'body_label',
        type: 'LABEL',
        label: 'Pump Ready',
        x: 32,
        y: 110,
        width: 160,
        height: 24,
      },
    ],
  };

  const darkCtx = resolveWidgetSurfaceContext(screen, screen.widgets[1]);
  assert.equal(darkCtx.isDarkSurface, true);
  assert.equal(darkCtx.surfaceBg, '#1E293B');
  assert.equal(darkCtx.defaultTextColor, '#F8FAFC');

  const lightCtx = resolveWidgetSurfaceContext(screen, screen.widgets[3]);
  assert.equal(lightCtx.isDarkSurface, false);
  assert.equal(lightCtx.surfaceBg, '#FFFFFF');
  assert.equal(lightCtx.defaultTextColor, '#0F172A');
});

test('hwExportCompiler: zero invisible text on STATION/dark surfaces, identity NumShowIput matrix, WrtVar-id, English Arial fonts & dedicated widget branches', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  prj.screens.push({
    id: 'scr_hwexp_vis',
    name: 'Visual_Export_Check',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#E2E8F0',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      {
        id: 'hdr_bar',
        type: 'GROUP_PANEL',
        label: 'MAIN PROCESS CONTROL OVERVIEW HEADER',
        x: 0,
        y: 0,
        width: 1024,
        height: 52,
        props: { theme: 'dark' },
      },
      {
        id: 'hdr_lamp',
        type: 'BIT_LAMP',
        label: 'SYSTEM OK',
        x: 820,
        y: 12,
        width: 180,
        height: 28,
        tagName: 'EStop_OK',
      },
      {
        id: 'st_1',
        type: 'STATION',
        label: 'STATION 1 FILL',
        x: 24,
        y: 72,
        width: 240,
        height: 180,
        tagName: 'Pump1_Run_Cmd',
      },
      {
        id: 'btn_compact',
        type: 'BIT_BUTTON',
        label: 'START',
        x: 280,
        y: 72,
        width: 120,
        height: 48,
        tagName: 'Pump1_Run_Cmd',
        writeEnabled: true,
        visualRole: 'PRIMARY_ACTION',
      },
      {
        id: 'num_setpoint',
        type: 'NUMERIC_INPUT',
        label: 'Setpoint',
        x: 420,
        y: 72,
        width: 220,
        height: 76,
        tagName: 'Chiller_Setpoint_C',
        writeEnabled: true,
        unit: '°C',
      },
      {
        id: 'ms_mode',
        type: 'MULTI_STATE_INDICATOR',
        label: 'Operating Mode',
        x: 660,
        y: 72,
        width: 180,
        height: 76,
        tagName: 'Chiller_Setpoint_C',
      },
      {
        id: 'rec_sel',
        type: 'RECIPE_SELECTOR',
        label: 'Batch Recipe',
        x: 280,
        y: 164,
        width: 220,
        height: 60,
      },
      {
        id: 'cam_1',
        type: 'CAMERA_VIEW',
        label: 'Bay 1 Camera',
        x: 520,
        y: 164,
        width: 200,
        height: 120,
      },
      {
        id: 'fp_1',
        type: 'FACEPLATE_INSTANCE',
        label: 'Pump Faceplate',
        x: 740,
        y: 164,
        width: 200,
        height: 120,
      },
      {
        id: 'pipe_1',
        type: 'PIPELINE',
        label: 'Supply Line',
        x: 24,
        y: 300,
        width: 260,
        height: 20,
      },
      {
        id: 'cur_sym',
        type: 'ACTUATOR',
        label: 'Index Drive',
        x: 320,
        y: 300,
        width: 120,
        height: 90,
        props: { nativeSymbol: 'HWCursor3' },
      },
    ],
  });

  const compiled = compileProjectToHwExport(prj, { screenIds: ['scr_hwexp_vis'], language: 'en_0' });
  const docMatch = /<WindowDocument>[\s\S]*?<Document>([\s\S]*?)<\/Document>/.exec(compiled.xml);
  assert.ok(docMatch, 'Expected compiled WindowDocument');
  const svg = unescapeXml(docMatch[1]);

  // 1. STATION header TxtBlock must match dark header surface #334155 (never white-on-white #FFFFFF)
  assert.ok(
    svg.includes('HWBackColor="#334155"') && svg.includes('STATION 1 FILL'),
    'STATION header TxtBlock must inherit #334155 HWBackColor'
  );

  // 2. Dark banner child BIT_LAMP must inherit #1E293B surface HWBackColor
  assert.ok(
    svg.includes('HWBackColor="#1E293B"') && svg.includes('SYSTEM OK'),
    'Dark banner BIT_LAMP caption must inherit #1E293B HWBackColor'
  );

  // 3. Compact BIT_BUTTON geometry must stay strictly inside widget height (48px)
  const btnGeom = computeBitButtonGeometry(prj.screens[prj.screens.length - 1].widgets[3]);
  assert.ok(btnGeom.iconY + btnGeom.iconSize <= 72 + 48, 'BIT_BUTTON icon must fit within widget height');
  assert.ok(btnGeom.labelY + btnGeom.labelH <= 72 + 48, 'BIT_BUTTON caption must fit within widget height');

  const lampGeom = computeBitLampGeometry(prj.screens[prj.screens.length - 1].widgets[1]);
  assert.ok(lampGeom.labelY + lampGeom.labelH <= 12 + 28, 'BIT_LAMP caption must fit within widget height');

  // 4. NumShowIput must use identity matrix (1,0,0,1,...) and include WrtVar-id for editable input
  assert.ok(
    svg.includes('sym-type="NumShowIput"') && svg.includes('transform="matrix(1,0,0,1,420,'),
    'NumShowIput must emit identity matrix(1,0,0,1,x,y) without non-uniform font stretching'
  );
  assert.ok(
    svg.includes('IsIput="true"') && svg.includes('WrtVar-UseAddr="false"') && svg.includes('WrtVar-id="'),
    'Editable NumShowIput must emit WrtVar-UseAddr="false" and WrtVar-id'
  );

  // 5. English DLL symbols must normalize Chinese SimSun/宋体 -> Arial & high-contrast HWCursor3
  assert.ok(!svg.includes('宋体') && !svg.includes('SimSun'), 'English export must not contain Chinese SimSun/宋体 font families');

  // 6. Dedicated branches for MULTI_STATE_INDICATOR, RECIPE_SELECTOR, CAMERA_VIEW, FACEPLATE_INSTANCE, PIPELINE
  assert.ok(svg.includes('Operating Mode'));
  assert.ok(svg.includes('Batch Recipe'));
  assert.ok(svg.includes('LIVE VIDEO STREAM'));
  assert.ok(svg.includes('Pump Faceplate'));
  assert.ok(svg.includes('Supply Line'));
});

test('haiwell_hmi_design_audit & haiwell_project_audit_safety: detect and auto-fix invisible text, overflow, and panel header overlap', async () => {
  const store = new HaiwellProjectStore();

  // Seeded reference project must still pass safety audit cleanly
  const baselineAudit = runProjectSafetyAudit(store.getProject('prj_chiller_plant_01'));
  assert.equal(baselineAudit.deploymentReady, true, 'Reference project must remain deploymentReady=true');

  // Introduce a deliberately broken screen with white-on-white text, panel-header overlap, and extreme overflow
  const prj = store.getProject('prj_chiller_plant_01');
  prj.screens.push({
    id: 'scr_bad_design',
    name: 'Broken Design Screen',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#F8FAFC',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      {
        id: 'p_ctrl',
        type: 'GROUP_PANEL',
        label: 'CONTROL PANEL',
        x: 20,
        y: 20,
        width: 400,
        height: 200,
      },
      {
        id: 'w_overlap_and_invisible',
        type: 'LABEL',
        label: 'Invisible White Text Overlapping Header',
        x: 32,
        y: 26, // overlaps 26px header (20..46)
        width: 200,
        height: 24,
        props: { color: '#FFFFFF', fontSize: 16 },
      },
    ],
  });
  store.saveProject(prj);

  // Safety audit must flag AUD-HMI-READABILITY and block deploymentReady
  const blockedAudit = runProjectSafetyAudit(store.getProject('prj_chiller_plant_01'));
  assert.equal(blockedAudit.deploymentReady, false);
  assert.ok(
    blockedAudit.findings.some((f) => f.code === 'AUD-HMI-READABILITY' && f.target === 'scr_bad_design'),
    'Safety audit must report AUD-HMI-READABILITY on invisible/overlapping text'
  );

  // Run haiwell_hmi_design_audit (read-only first)
  const inspectRes = await invokeHaiwellTool(
    'haiwell_hmi_design_audit',
    { projectId: 'prj_chiller_plant_01', screenId: 'scr_bad_design', autoFix: false },
    store
  );
  assert.equal(inspectRes.ok, true);
  const inspectData = inspectRes.data as {
    valid: boolean;
    totalBlockingIssues: number;
    screens: { issues: { code: string }[] }[];
  };
  assert.equal(inspectData.valid, false);
  const codes = new Set(inspectData.screens[0].issues.map((i) => i.code));
  assert.ok(codes.has('HMI-VIS-INVISIBLE-TEXT'), 'Must flag HMI-VIS-INVISIBLE-TEXT');
  assert.ok(codes.has('HMI-VIS-PANEL-HEADER-OVERLAP'), 'Must flag HMI-VIS-PANEL-HEADER-OVERLAP');

  // Auto-fix via haiwell_hmi_design_audit(autoFix=true)
  const fixRes = await invokeHaiwellTool(
    'haiwell_hmi_design_audit',
    { projectId: 'prj_chiller_plant_01', screenId: 'scr_bad_design', autoFix: true },
    store
  );
  assert.equal(fixRes.ok, true);
  const fixData = fixRes.data as { valid: boolean; totalBlockingIssues: number; autoFixApplied: boolean };
  assert.equal(fixData.autoFixApplied, true);
  assert.equal(fixData.valid, true, 'autoFix=true must converge screen to valid=true');
  assert.equal(fixData.totalBlockingIssues, 0);

  // Safety audit must now pass again
  const postFixSafety = runProjectSafetyAudit(store.getProject('prj_chiller_plant_01'));
  assert.equal(postFixSafety.deploymentReady, true, 'Safety audit must become deploymentReady=true after autoFix');
});

test('hmiTemplates & SVG preview: zero hardcoded university strings, zero collision with 2 indicators + KPI, 800x480 touch nav, truncation warnings & clean SVG', () => {
  // 1. MAIN_NAVIGATION_HUB must NOT include hardcoded university text and must shift header left when no logos are given
  const hub = instantiateHmiTemplateDetailed({
    template: 'MAIN_NAVIGATION_HUB',
    screenId: 'scr_hub_clean',
    name: 'Main_Hub',
    title: 'FACTORY CONTROL HUB',
    hubNavCards: [
      { label: 'OVERVIEW', targetScreenName: 'Line_Overview', targetWindowId: 1001 },
      { label: 'ALARMS', targetScreenName: 'Alarms', targetWindowId: 1002 },
    ],
  });
  assert.ok(!JSON.stringify(hub.screen).includes('PETRA'), 'Must not contain hardcoded university text');
  const hubTitle = hub.screen.widgets.find((w) => w.id.endsWith('_hub_title'));
  assert.ok(hubTitle && hubTitle.x === 24, 'MAIN_NAVIGATION_HUB title should start at x=24 when brandingLogos is empty');

  // 2. MULTI_STATION_PROCESS_FLOW with 2 ioIndicators + KPI must have 0 collisions
  const flow = instantiateHmiTemplateDetailed({
    template: 'MULTI_STATION_PROCESS_FLOW',
    screenId: 'scr_flow_2io_kpi',
    name: 'Process_Flow',
    title: 'PROCESS FLOW',
    stations: [
      {
        title: 'ST1 LOAD',
        icon: 'HWReactor25',
        ioIndicators: [
          { label: 'RUN', tagName: 'ST1_Run' },
          { label: 'FAULT', tagName: 'ST1_Fault', role: 'DANGER_ACTION', invertDisplay: true },
        ],
        kpi: { label: 'CYCLES', tagName: 'ST1_Cycles', unit: 'pcs' },
      },
      {
        title: 'ST2 PRESS',
        icon: 'HWCursor3',
        ioIndicators: [
          { label: 'CLAMP', tagName: 'ST2_Clamp' },
          { label: 'READY', tagName: 'ST2_Ready' },
        ],
        kpi: { label: 'FORCE', tagName: 'ST2_Force', unit: 'kN' },
      },
    ],
  });
  const flowVal = validateHmiScreen(flow.screen, {});
  assert.equal(flowVal.collisions.length, 0, '2 ioIndicators + KPI must produce 0 collisions');
  assert.equal(flowVal.outOfBounds.length, 0, '2 ioIndicators + KPI must produce 0 OOB');
  const faultLamp = flow.screen.widgets.find((w) => w.tagName === 'ST1_Fault');
  assert.equal(faultLamp?.props?.invertDisplay, true, 'Station ioIndicator invertDisplay must be preserved');

  // 3. 800x480 scaling must keep NAV_BAR height >= 44px with 0 collisions and 0 touch violations
  const scaled = instantiateHmiTemplateDetailed({
    template: 'INDUSTRIAL_LINE_OVERVIEW',
    screenId: 'scr_800x480',
    name: 'Compact_Overview',
    title: 'COMPACT PANEL',
    width: 800,
    height: 480,
    navTabs: [
      { label: 'OVERVIEW', targetScreenName: 'Compact_Overview', active: true },
      { label: 'ALARMS', targetScreenName: 'Alarms' },
    ],
  });
  const navBtns = scaled.screen.widgets.filter((w) => w.type === 'NAV_BAR');
  assert.ok(navBtns.length === 2);
  for (const nb of navBtns) {
    assert.ok(nb.height >= 44, `Scaled 800x480 NAV_BAR height must be >= 44px (got ${nb.height})`);
  }
  const scaledVal = validateHmiScreen(scaled.screen, {}, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(scaledVal.collisions.length, 0);
  assert.equal(scaledVal.outOfBounds.length, 0);
  assert.equal(scaledVal.touchTargetViolations.length, 0);

  // 4. Truncation warnings when exceeding slot limits
  const truncated = instantiateHmiTemplateDetailed({
    template: 'INDUSTRIAL_LINE_OVERVIEW',
    screenId: 'scr_trunc',
    name: 'Truncated',
    title: 'OVERFLOW TEST',
    commands: Array.from({ length: 8 }, (_, i) => ({ label: `CMD ${i}`, tagName: `Cmd_${i}` })),
  });
  assert.ok(truncated.warnings.length > 0, 'Exceeding template slot capacity must emit explicit warnings');

  // 5. SVG preview: clean by default (no debug type badge clutter), opt-in via showDebugOverlay=true
  const cleanSvg = renderScreenToSvg(scaled.screen, {});
  assert.ok(!cleanSvg.includes('>NAV_BAR<'), 'Default SVG must not render debug widget type badges');
  const debugSvg = renderScreenToSvg(scaled.screen, {}, { showDebugOverlay: true });
  assert.ok(debugSvg.includes('>NAV_BAR<'), 'showDebugOverlay=true must render type badges');

  // 6. Visual audit passes cleanly on freshly instantiated templates
  const visCheck = auditHmiScreenDesign(scaled.screen, {}, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(visCheck.valid, true);
  // autoFix on a clean screen should be a no-op
  const noopFix = autoFixHmiScreenDesign(scaled.screen, {}, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(noopFix.appliedFixes.length, 0);
});

test('QoL: core profile coverage, actionable remediationHint on errors, and version sync across SKILL.md & resources', async () => {
  const store = new HaiwellProjectStore();

  // 1. Core profile includes key HMI & hwExport tools
  const coreNames = new Set(getToolsForProfile('core').map((t) => t.name));
  for (const required of [
    'haiwell_hmi_template_instantiate',
    'haiwell_hmi_screen_generate',
    'haiwell_hmi_design_audit',
    'haiwell_hmi_screen_render_svg',
    'haiwell_project_export_hwexport',
    'haiwell_project_import_hwrun',
  ]) {
    assert.ok(coreNames.has(required), `core profile must include ${required}`);
  }

  // 2. TOOL_NOT_FOUND returns actionable closest-match remediationHint
  const notFound = await invokeHaiwellTool('haiwell_hmi_audit_design', {}, store);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error?.code, 'TOOL_NOT_FOUND');
  assert.ok(
    notFound.error?.remediationHint?.includes('haiwell_hmi_design_audit'),
    `Expected closest-tool suggestion in remediationHint, got: ${notFound.error?.remediationHint}`
  );

  // 3. SCHEMA_VALIDATION_ERROR returns failing field paths in remediationHint
  const badSchema = await invokeHaiwellTool(
    'haiwell_hmi_screen_generate',
    { projectId: 'prj_chiller_plant_01', screenId: 'INVALID SCREEN ID!', name: 'X' },
    store
  );
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.error?.code, 'SCHEMA_VALIDATION_ERROR');
  assert.ok(
    badSchema.error?.remediationHint?.includes('screenId'),
    `Expected failing field path in remediationHint, got: ${badSchema.error?.remediationHint}`
  );

  // 4. Version sync & new HMI prompt present
  const skillMd = generateAgentSkillMarkdown('http://localhost:3000/mcp');
  assert.ok(skillMd.includes(`version: ${SERVER_VERSION}`));
  assert.ok(skillMd.includes(`${HAIWELL_TOOLS.length}`));
  assert.ok(HAIWELL_PROMPTS.some((p) => p.name === 'design_and_audit_hmi_screens'));

  const repoSkillMd = fs.readFileSync(path.resolve(process.cwd(), 'SKILL.md'), 'utf8');
  assert.ok(repoSkillMd.includes(`version: ${SERVER_VERSION}`));
  assert.ok(repoSkillMd.includes(`${HAIWELL_TOOLS.length} strictly validated tools`));
});

test('Pass 2 regression: panelTitles MCP schema pass-through and neutral public template copy', async () => {
  const store = new HaiwellProjectStore();
  const diagRes = await invokeHaiwellTool(
    'haiwell_hmi_template_instantiate',
    {
      projectId: 'prj_chiller_plant_01',
      template: 'ALARMS_TRENDS_DIAGNOSTICS',
      screenId: 'scr_custom_titles',
      name: 'Diagnostics_Custom',
      title: 'DIAGNOSTICS',
      panelTitles: {
        left: 'CUSTOM ALARMS',
        middle: 'CUSTOM TREND',
        right: 'CUSTOM COUNTERS',
        history: 'CUSTOM HISTORY LOG',
      },
    },
    store
  );
  assert.equal(diagRes.ok, true);
  const prj = store.getProject('prj_chiller_plant_01');
  const diagScreen = prj.screens.find((s) => s.id === 'scr_custom_titles')!;
  const panelLabels = diagScreen.widgets.filter((w) => w.type === 'GROUP_PANEL').map((w) => w.label);
  assert.ok(panelLabels.includes('CUSTOM ALARMS'));
  assert.ok(panelLabels.includes('CUSTOM TREND'));
  assert.ok(panelLabels.includes('CUSTOM COUNTERS'));
  assert.ok(panelLabels.includes('CUSTOM HISTORY LOG'));

  // STATION_ALARMS_SIMPLE accepts both `alarms` and `faults` aliases via MCP tool
  const almRes = await invokeHaiwellTool(
    'haiwell_hmi_template_instantiate',
    {
      projectId: 'prj_chiller_plant_01',
      template: 'STATION_ALARMS_SIMPLE',
      screenId: 'scr_alm_alias',
      name: 'Alarms_Alias',
      title: 'PLANT ALARMS',
      panelTitles: { alarms: 'PLANT SAFETY ALARMS', right: 'ACK PANEL' },
    },
    store
  );
  assert.equal(almRes.ok, true);
  const almScreen = store.getProject('prj_chiller_plant_01').screens.find((s) => s.id === 'scr_alm_alias')!;
  assert.ok(almScreen.widgets.some((w) => w.type === 'GROUP_PANEL' && w.label === 'PLANT SAFETY ALARMS'));
  assert.ok(almScreen.widgets.some((w) => w.type === 'GROUP_PANEL' && w.label === 'ACK PANEL'));

  // Public cleanup: neutral template defaults and deleted FAILURE_DOCUMENTATION.md
  const logger = instantiateHmiTemplateDetailed({
    template: 'EDGE_LOGGER_CONSOLE',
    screenId: 'scr_logger_neutral',
    name: 'Data_Logger',
    title: 'DATA LOGGER',
  });
  const loggerJson = JSON.stringify(logger.screen);
  assert.ok(loggerJson.includes('DATA LOGGER'));
  assert.ok(loggerJson.includes('CYCLE TELEMETRY'));
  assert.ok(!loggerJson.includes('CLOUD LOGGER'));
  assert.equal(fs.existsSync(path.resolve(process.cwd(), 'FAILURE_DOCUMENTATION.md')), false);
  const readme = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
  assert.ok(!readme.includes('FAILURE_DOCUMENTATION.md'));
});

test('Pass 2 regression: hwExport Z-order sorting, live MULTI_STATE_INDICATOR RdVar, PNG magic guard, HWClock4, 1:1 DB IDs, light_banner label & CanvasColor', () => {
  const store = new HaiwellProjectStore();
  const prj = store.getProject('prj_chiller_plant_01');
  const validPng = generateSolidPngBase64('#16A34A', 16, 16);

  prj.screens.push({
    id: 'scr_hw_fixes',
    name: 'Compiler_Fixes_Check',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    themeId: 'CONTROL_ROOM_DARK',
    backgroundColor: '',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      // Deliberately place child BEFORE enclosing GROUP_PANEL to test Z-order sort
      {
        id: 'child_lbl_first',
        type: 'LABEL',
        label: 'CHILD_MUST_RENDER_ON_TOP',
        x: 40,
        y: 120,
        width: 240,
        height: 24,
      },
      {
        id: 'enclosing_panel_last',
        type: 'GROUP_PANEL',
        label: 'ENCLOSING_PANEL_FIRST',
        x: 20,
        y: 80,
        width: 400,
        height: 200,
      },
      {
        id: 'light_banner_titled',
        type: 'GROUP_PANEL',
        label: 'BANNER_TITLE_VISIBLE',
        x: 20,
        y: 10,
        width: 600,
        height: 48,
        props: { theme: 'light_banner' },
      },
      {
        id: 'live_msi',
        type: 'MULTI_STATE_INDICATOR',
        label: 'Chiller State',
        tagName: 'Chiller_Setpoint_C',
        x: 440,
        y: 80,
        width: 180,
        height: 76,
      },
      {
        id: 'bad_logo',
        type: 'LABEL',
        label: 'Bad Logo',
        x: 640,
        y: 12,
        width: 48,
        height: 48,
        props: { customImageBase64: Buffer.from('not-a-png-file').toString('base64') },
      },
      {
        id: 'good_logo_datauri',
        type: 'LABEL',
        label: 'Good Logo',
        x: 700,
        y: 12,
        width: 48,
        height: 48,
        props: { customImageBase64: `data:image/png;base64,${validPng.base64}` },
      },
      {
        id: 'clk_widget',
        type: 'LABEL',
        label: 'CLOCK',
        x: 840,
        y: 12,
        width: 160,
        height: 28,
        props: { nativeSymbol: 'HWClock4' },
      },
      {
        id: 'narrow_station',
        type: 'STATION',
        label: 'S1',
        x: 440,
        y: 180,
        width: 64,
        height: 110,
      },
    ],
  });

  const compiled = compileProjectToHwExport(prj, { screenIds: ['scr_hw_fixes'], language: 'en_0' });
  const docMatch = /<WindowDocument>[\s\S]*?<Document>([\s\S]*?)<\/Document>/.exec(compiled.xml);
  assert.ok(docMatch, 'Expected compiled WindowDocument');
  const svg = unescapeXml(docMatch[1]);

  // 1. GROUP_PANEL must appear in SVG BEFORE its child widget even though array order was reversed
  const panelIdx = svg.indexOf('ENCLOSING_PANEL_FIRST');
  const childIdx = svg.indexOf('CHILD_MUST_RENDER_ON_TOP');
  assert.ok(panelIdx > 0 && childIdx > panelIdx, 'GROUP_PANEL must emit before child widgets in .hwExport');

  // 2. light_banner must render non-empty label in both .hwExport and SVG preview
  assert.ok(svg.includes('BANNER_TITLE_VISIBLE'), 'light_banner label must be emitted in .hwExport');
  const previewSvg = renderScreenToSvg(prj.screens[prj.screens.length - 1], prj.tags);
  assert.ok(previewSvg.includes('BANNER_TITLE_VISIBLE'), 'light_banner label must be rendered in SVG preview');
  assert.ok(!previewSvg.includes('data:image/png;base64,data:image/png;base64,'), 'SVG preview must not double-prefix data URIs');

  // 3. MULTI_STATE_INDICATOR must compile to live RdVar/RdVar-id-bound NumShowIput
  assert.ok(
    svg.includes('title="State indicator"') && svg.includes('sym-type="NumShowIput"') && svg.includes('RdVar-id="'),
    'MULTI_STATE_INDICATOR must bind live RdVar/RdVar-id on NumShowIput'
  );

  // 4. Invalid PNG must emit warning and valid data-URI PNG must succeed
  assert.ok(
    compiled.warnings.some((w) => w.includes('bad_logo') && w.includes('not a valid PNG')),
    'Invalid customImageBase64 must produce an explicit compiler warning'
  );
  assert.ok(svg.includes(`md5file="${validPng.md5}"`), 'Valid data-URI PNG must be stripped and embedded');

  // 5. HWClock4 must not have hardcoded 2026 date and must use fill="none"
  assert.ok(!svg.includes('2026/11/25 21:45'), 'HWClock4 must not embed a hardcoded date placeholder');
  assert.ok(svg.includes('sym-type="HWClock4"') && svg.includes('>00:00:00</textBlock>'));

  // 6. CanvasColor must use resolved dark theme canvasBg (#0F172A) when backgroundColor is empty
  assert.ok(compiled.xml.includes('<CanvasColor>#0F172A</CanvasColor>'));

  // 7. DicSym <ID> must match hwkey sequence suffix 1:1 (no double-increment drift)
  const symMatches = [
    ...compiled.xml.matchAll(
      /<ProjectSymbol>\s*<ID>(\d+)<\/ID>\s*<Name>[^<]+<\/Name>\s*<ClassifyId>0<\/ClassifyId>\s*<SymbolName>[^<]+_(\d+)<\/SymbolName>/g
    ),
  ];
  assert.ok(symMatches.length > 5, 'Expected multiple DicSym records');
  for (const m of symMatches) {
    assert.equal(m[1], m[2], `DicSym <ID> (${m[1]}) must match SymbolName sequence (${m[2]}) 1:1`);
  }
});

test('Pass 2 regression: collision-safe autoFix, unfixable 8px overflow flag without truncation, and full widget type audit coverage', () => {
  const screen: HmiScreen = {
    id: 'scr_autofix_collisions',
    name: 'AutoFix Collision Safety',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#F1F5F9',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      {
        id: 'grp_1',
        type: 'GROUP_PANEL',
        label: 'PUMP CONTROLS',
        x: 20,
        y: 20,
        width: 360,
        height: 240,
      },
      // Overlaps header (20..48); nudging it to y=52 would collide with sibling at y=54 without collision repair!
      {
        id: 'w_top',
        type: 'LABEL',
        label: 'Header Overlap Widget',
        x: 32,
        y: 26,
        width: 180,
        height: 28,
      },
      {
        id: 'w_below',
        type: 'LABEL',
        label: 'Sibling Below',
        x: 32,
        y: 56,
        width: 180,
        height: 28,
      },
      // Unfixable text overflow even at 8px minimum font floor
      {
        id: 'w_unfixable',
        type: 'LABEL',
        label: 'EXTRAORDINARILY LONG INDUSTRIAL PARAMETER DESCRIPTION LABEL',
        x: 420,
        y: 40,
        width: 72,
        height: 24,
        props: { fontSize: 12 },
      },
      // Low-contrast GAUGE and STATION header
      {
        id: 'g_low',
        type: 'GAUGE',
        label: 'Pressure',
        unit: 'bar',
        x: 420,
        y: 100,
        width: 160,
        height: 160,
        props: { labelColor: '#CBD5E1' },
      },
      {
        id: 'st_low',
        type: 'STATION',
        label: 'FILLING',
        x: 600,
        y: 100,
        width: 140,
        height: 140,
        props: { color: '#334155' },
      },
      // Compact BIT_LAMP with vertical sub-element overflow
      {
        id: 'lamp_tiny',
        type: 'BIT_LAMP',
        label: 'RUN',
        x: 420,
        y: 300,
        width: 36,
        height: 28,
      },
    ],
  };

  const before = auditHmiScreenDesign(screen);
  const beforeCodes = new Set(before.issues.map((i) => i.code));
  assert.ok(beforeCodes.has('HMI-VIS-PANEL-HEADER-OVERLAP'));
  assert.ok(beforeCodes.has('HMI-VIS-UNFIXABLE-OVERFLOW'));
  assert.ok(beforeCodes.has('HMI-VIS-SUBELEMENT-OVERFLOW'));
  assert.ok(before.issues.some((i) => i.widgetId === 'g_low' && i.code === 'HMI-VIS-INVISIBLE-TEXT'));
  assert.ok(before.issues.some((i) => i.widgetId === 'st_low' && i.code === 'HMI-VIS-INVISIBLE-TEXT'));

  const fixed = autoFixHmiScreenDesign(screen);
  // 1. Collision-free after header nudge & sub-element resize
  assert.equal(detectWidgetCollisions(fixed.screen.widgets).length, 0, 'autoFix must never leave spatial collisions');
  const wTop = fixed.screen.widgets.find((w) => w.id === 'w_top')!;
  const wBelow = fixed.screen.widgets.find((w) => w.id === 'w_below')!;
  assert.ok(wTop.y >= 48 && wBelow.y >= wTop.y + wTop.height, 'w_below must shift below nudged w_top inside panel');

  // 2. Unfixable text keeps original label intact (no truncation) and remains flagged as HMI-VIS-UNFIXABLE-OVERFLOW
  const wUnfix = fixed.screen.widgets.find((w) => w.id === 'w_unfixable')!;
  assert.equal(wUnfix.label, 'EXTRAORDINARILY LONG INDUSTRIAL PARAMETER DESCRIPTION LABEL');
  assert.equal(wUnfix.props?.fontSize, 8);
  assert.ok(
    fixed.auditAfter.issues.some((i) => i.widgetId === 'w_unfixable' && i.code === 'HMI-VIS-UNFIXABLE-OVERFLOW'),
    'Unfixable overflow at 8px floor must remain explicitly flagged'
  );

  // 3. GAUGE, STATION, and compact BIT_LAMP defects must be resolved
  assert.ok(!fixed.auditAfter.issues.some((i) => i.widgetId === 'g_low'));
  assert.ok(!fixed.auditAfter.issues.some((i) => i.widgetId === 'st_low'));
  assert.ok(!fixed.auditAfter.issues.some((i) => i.widgetId === 'lamp_tiny' && i.code === 'HMI-VIS-SUBELEMENT-OVERFLOW'));
});

test('Pass 2 regression: container-aware solveAndRepairScreenLayout, dark-theme MAIN_NAVIGATION_HUB & 800x480 interactive scaling', () => {
  // 1. Dark-theme MAIN_NAVIGATION_HUB must use dark banner + light text and pass visual audit
  const darkHub = instantiateHmiTemplateDetailed({
    template: 'MAIN_NAVIGATION_HUB',
    screenId: 'scr_dark_hub',
    name: 'Dark_Hub',
    title: 'CONTROL ROOM HUB',
    subtitle: '24/7 Industrial Operations',
    themeId: 'CONTROL_ROOM_DARK',
    width: 800,
    height: 480,
    commands: [
      { label: 'START', tagName: 'Line_Start', role: 'PRIMARY_ACTION' },
      { label: 'STOP', tagName: 'Line_Stop', role: 'DANGER_ACTION' },
    ],
    hubNavCards: [
      { label: 'OVERVIEW', targetScreenName: 'Overview', targetWindowId: 1001, active: true },
      { label: 'ALARMS', targetScreenName: 'Alarms', targetWindowId: 1002 },
    ],
    navTabs: [
      { label: 'HOME', targetScreenName: 'Dark_Hub', active: true },
      { label: 'LINE', targetScreenName: 'Overview' },
      { label: 'ALARMS', targetScreenName: 'Alarms' },
      { label: 'LOG', targetScreenName: 'Logger' },
    ],
  });
  const brandPanel = darkHub.screen.widgets.find((w) => w.id.endsWith('_brand_bg'))!;
  const hubTitle = darkHub.screen.widgets.find((w) => w.id.endsWith('_hub_title'))!;
  assert.equal(brandPanel.props?.backgroundColor, '#1E293B', 'Dark hub banner must use dark panelBg');
  assert.equal(hubTitle.props?.color, '#F8FAFC', 'Dark hub title must use light textPrimary');
  assert.ok((hubTitle.props?.fontSize as number) < 13, '800x480 scaling must proportionally scale explicit fontSize');

  const darkHubAudit = auditHmiScreenDesign(darkHub.screen, {}, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(darkHubAudit.valid, true, `Dark hub on 800x480 must pass visual audit: ${JSON.stringify(darkHubAudit.issues)}`);
  const darkHubVal = validateHmiScreen(darkHub.screen, {}, { targetHardware: 'CLOUD_HMI_C7' });
  assert.equal(darkHubVal.collisions.length, 0);
  assert.equal(darkHubVal.outOfBounds.length, 0);
  assert.equal(darkHubVal.touchTargetViolations.length, 0);

  // 2. Container-aware solveAndRepairScreenLayout must NOT eject GROUP_PANEL children or multi-tab NAV_BARs
  const solved = solveAndRepairScreenLayout(darkHub.screen, 'CLOUD_HMI_C7');
  assert.equal(solved.remainingCollisions, 0);
  assert.equal(solved.remainingOutOfBounds, 0);

  const solvedLeftPanel = solved.screen.widgets.find((w) => w.id.endsWith('_p_left'))!;
  const solvedCmd0 = solved.screen.widgets.find((w) => w.id.endsWith('_cmd_0'))!;
  assert.ok(
    solvedCmd0.x >= solvedLeftPanel.x &&
      solvedCmd0.x + solvedCmd0.width <= solvedLeftPanel.x + solvedLeftPanel.width &&
      solvedCmd0.y >= solvedLeftPanel.y &&
      solvedCmd0.y + solvedCmd0.height <= solvedLeftPanel.y + solvedLeftPanel.height,
    'solveAndRepairScreenLayout must keep child widgets inside their enclosing GROUP_PANEL'
  );

  const solvedCenterPanel = solved.screen.widgets.find((w) => w.id.endsWith('_p_center'))!;
  const hubNavCards = solved.screen.widgets.filter((w) => w.id.startsWith('scr_dark_hub_hub_nav_'));
  assert.equal(hubNavCards.length, 2);
  for (const card of hubNavCards) {
    assert.ok(
      card.x >= solvedCenterPanel.x &&
        card.x + card.width <= solvedCenterPanel.x + solvedCenterPanel.width &&
        card.y >= solvedCenterPanel.y &&
        card.y + card.height <= solvedCenterPanel.y + solvedCenterPanel.height,
      `Hub nav card "${card.id}" must stay inside center GROUP_PANEL`
    );
  }

  const bottomNavTabs = solved.screen.widgets.filter((w) => w.id.startsWith('scr_dark_hub_nav_'));
  assert.equal(bottomNavTabs.length, 4);
  for (const tab of bottomNavTabs) {
    assert.ok(tab.y >= 400, `Multi-tab bottom NAV_BAR "${tab.id}" must stay anchored at bottom (got y=${tab.y})`);
  }
});

test('S&P 500 Factory HMI Playbook resource & domain-aware evidence-tagged human-factors audits', async () => {
  const store = new HaiwellProjectStore();

  // 1. Playbook resource is registered and separates Facts vs. Standards vs. Opinions with named authorities
  assert.ok(
    HAIWELL_RESOURCES.some((r) => r.uri === 'haiwell://knowledge/hmi-engineering-playbook'),
    'HMI engineering playbook resource must be registered'
  );
  const playbook = readHaiwellResource('haiwell://knowledge/hmi-engineering-playbook', store);
  assert.equal(playbook.mimeType, 'text/markdown');
  for (const required of [
    'EMPIRICAL_FACT',
    'INDUSTRY_STANDARD',
    'PRACTITIONER_OPINION',
    'ExxonMobil',
    'Procter & Gamble',
    'Ford',
    'Dr. Mica R. Endsley',
    'Dr. Peter Bullemer',
    'Jamie Errington',
    'Bill Hollifield',
    'Ian Nimmo',
    'Dr. Kim J. Vicente',
    '48%',
    '10%',
    'PackML',
  ]) {
    assert.ok(playbook.text.includes(required), `Playbook must include "${required}"`);
  }

  // 2. Continuous process screen with CVD color-only label, alarm color dilution, bare analog readouts,
  //    danger-button proximity, and density overload triggers all 5 HMI-HF-* warnings with accurate evidenceBasis
  const flawedProcessScreen: HmiScreen = {
    id: 'scr_hf_process_bad',
    name: 'Reactor Process Screen',
    width: 800,
    height: 480,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#F1F5F9',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      { id: 'lamp_red', type: 'BIT_LAMP', label: 'RED', x: 16, y: 16, width: 120, height: 48, visualRole: 'DANGER_ACTION' },
      { id: 'btn_start', type: 'BIT_BUTTON', label: 'START', x: 16, y: 80, width: 120, height: 56, writeEnabled: true, visualRole: 'PRIMARY_ACTION' },
      { id: 'btn_abort', type: 'BIT_BUTTON', label: 'ABORT', x: 140, y: 80, width: 120, height: 56, writeEnabled: true, visualRole: 'DANGER_ACTION' }, // only 4px gap!
      { id: 'num_t1', type: 'NUMERIC_DISPLAY', label: 'Reactor Temp', x: 16, y: 150, width: 180, height: 70, props: { backgroundColor: '#EF4444', color: '#FFFFFF' } },
      { id: 'num_t2', type: 'NUMERIC_DISPLAY', label: 'Jacket Temp', x: 204, y: 150, width: 180, height: 70, props: { backgroundColor: '#F59E0B', color: '#0F172A' } },
      { id: 'num_p1', type: 'NUMERIC_DISPLAY', label: 'Vessel Pressure', x: 392, y: 150, width: 180, height: 70 },
      { id: 'num_f1', type: 'NUMERIC_DISPLAY', label: 'Feed Flow', x: 580, y: 150, width: 180, height: 70 },
      // Large dense tables/cards pushing non-panel coverage > 65%
      { id: 'big_tbl_1', type: 'DATA_TABLE', label: 'Batch Log', x: 16, y: 230, width: 760, height: 236 },
    ],
  };

  const procAudit = auditHmiScreenDesign(flawedProcessScreen, {}, { industryDomain: 'PROCESS_CONTINUOUS' });
  const procCodes = new Set(procAudit.issues.map((i) => i.code));
  assert.ok(procCodes.has('HMI-HF-COLOR-ONLY-CODING'), 'Must flag color-only label "RED"');
  assert.ok(procCodes.has('HMI-HF-ALARM-COLOR-DILUTION'), 'Must flag saturated red/amber backgrounds on non-alarm telemetry');
  assert.ok(procCodes.has('HMI-HF-MISSING-PROCESS-CONTEXT'), 'Must flag bare analog readouts without units/bounds/trends on PROCESS_CONTINUOUS');
  assert.ok(procCodes.has('HMI-HF-DANGER-PROXIMITY'), 'Must flag DANGER_ACTION button within < 12px of PRIMARY_ACTION');
  assert.ok(procCodes.has('HMI-HF-DENSITY-OVERLOAD'), 'Must flag > 65% non-panel canvas density');

  const proximityIssue = procAudit.issues.find((i) => i.code === 'HMI-HF-DANGER-PROXIMITY')!;
  assert.equal(proximityIssue.evidenceBasis, 'INDUSTRY_STANDARD');
  const cvdIssue = procAudit.issues.find((i) => i.code === 'HMI-HF-COLOR-ONLY-CODING')!;
  assert.equal(cvdIssue.evidenceBasis, 'EMPIRICAL_FACT');
  assert.ok(procAudit.evidenceSummary.empiricalFact >= 4);
  assert.ok(procAudit.evidenceSummary.industryStandard >= 1);

  // 3. Non-dogmatic check: DISCRETE_MANUFACTURING counter screen must NOT trigger HMI-HF-MISSING-PROCESS-CONTEXT
  const discreteCounterScreen: HmiScreen = {
    id: 'scr_discrete_cell',
    name: 'Body Shop Cell 4',
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    industryDomain: 'DISCRETE_MANUFACTURING',
    backgroundColor: '#E2E8F0',
    autoScaleMobile: true,
    autoScaleWeb: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    widgets: [
      { id: 'st_load', type: 'STATION', label: 'ST1 LOAD', x: 24, y: 64, width: 180, height: 140 },
      { id: 'cnt_good', type: 'NUMERIC_DISPLAY', label: 'Good Parts', x: 24, y: 240, width: 160, height: 68, unit: 'pcs' },
      { id: 'cnt_rej', type: 'NUMERIC_DISPLAY', label: 'Reject Parts', x: 204, y: 240, width: 160, height: 68, unit: 'pcs' },
      { id: 'cnt_cyc', type: 'NUMERIC_DISPLAY', label: 'Cycle Count', x: 384, y: 240, width: 160, height: 68, unit: 'cycles' },
      { id: 'cnt_rec', type: 'NUMERIC_DISPLAY', label: 'Recipe ID', x: 564, y: 240, width: 160, height: 68 },
    ],
  };

  const discreteAudit = auditHmiScreenDesign(discreteCounterScreen);
  assert.equal(discreteAudit.industryDomain, 'DISCRETE_MANUFACTURING');
  assert.ok(
    !discreteAudit.issues.some((i) => i.code === 'HMI-HF-MISSING-PROCESS-CONTEXT'),
    'DISCRETE_MANUFACTURING counter screen must not be dogmatically flagged for missing analog trends'
  );

  // 4. haiwell_hmi_design_audit MCP tool returns evidenceSummary & playbookResource and keeps prj_chiller_plant_01 deploymentReady
  const toolRes = await invokeHaiwellTool(
    'haiwell_hmi_design_audit',
    {
      projectId: 'prj_chiller_plant_01',
      screenId: 'scr_chiller_overview',
      industryDomain: 'PROCESS_CONTINUOUS',
      screenLevel: 'L1_OVERVIEW',
      autoFix: false,
    },
    store
  );
  assert.equal(toolRes.ok, true);
  const data = toolRes.data as {
    valid: boolean;
    playbookResource: string;
    evidenceSummary: { empiricalFact: number; industryStandard: number; practitionerOpinion: number };
    screens: { industryDomain: string; screenLevel?: string }[];
  };
  assert.equal(data.valid, true);
  assert.equal(data.playbookResource, 'haiwell://knowledge/hmi-engineering-playbook');
  assert.equal(data.screens[0].industryDomain, 'PROCESS_CONTINUOUS');
  assert.equal(data.screens[0].screenLevel, 'L1_OVERVIEW');
  assert.equal(typeof data.evidenceSummary.empiricalFact, 'number');

  const safety = runProjectSafetyAudit(store.getProject('prj_chiller_plant_01'));
  assert.equal(safety.deploymentReady, true);
});

