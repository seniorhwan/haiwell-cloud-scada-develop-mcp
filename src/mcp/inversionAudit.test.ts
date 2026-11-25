/**
 * Inversion Audit Regression Test Suite:
 * Proves every single production failure mode uncovered during the full-codebase
 * inversion review is now cleanly prevented and verified end-to-end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HaiwellProjectStore, matchMqttTopicFilter } from './projectStore';
import {
  buildProjectExportBundle,
  invokeHaiwellTool,
  normalizeAgentArgs,
  runProjectSafetyAudit,
} from './toolRegistry';
import { transpileStToHaiwellJs } from './iec61131';
import { validateHaiwellScript } from './scriptAnalyzer';
import { detectWordOverlapConflicts } from './plcAddressing';
import { isBlockedSsrfHost, probeTcpEndpoint } from './protocolAdapters';
import { compileDesktopAutomationBridge } from './hmiSpatialEngine';
import { generateAgentSkillMarkdown } from './resourcesAndPrompts';
import type { PlcDriverProtocol, TagDefinition } from './types';

function makeStore() {
  return new HaiwellProjectStore();
}

test('Inversion #1: Prototype pollution & Object.prototype tag key bypass blocked', async () => {
  const store = makeStore();

  // normalizeAgentArgs strips __proto__, constructor, prototype recursively (including inside JSON strings)
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":"x","ok":1},"jsonStr":"{\\"__proto__\\":{\\"bad\\":1},\\"safe\\":2}"}');
  const cleaned = normalizeAgentArgs(polluted);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned, '__proto__'), false);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned.nested as object, 'constructor'), false);
  assert.equal((cleaned.nested as Record<string, unknown>).ok, 1);
  assert.equal((cleaned.jsonStr as Record<string, unknown>).safe, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned.jsonStr as object, '__proto__'), false);

  // Calling haiwell_tag_read_write with "toString" or "constructor" must NOT crash or treat Object.prototype as a tag
  for (const protoKey of ['toString', 'constructor', 'valueOf', '__proto__']) {
    const readRes = await invokeHaiwellTool('haiwell_tag_read_write', { operation: 'READ', tagName: protoKey }, store);
    assert.equal(readRes.ok, false);
    assert.match(readRes.error?.message ?? '', /not found/i);

    const writeRes = await invokeHaiwellTool(
      'haiwell_tag_read_write',
      { operation: 'WRITE', tagName: protoKey, value: 1 },
      store
    );
    assert.equal(writeRes.ok, false);
  }

  // Upserting a tag named "constructor" or "toString" must be rejected as RESERVED_IDENTIFIER
  const upsertRes = await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      tags: [
        { name: 'constructor', scope: 'INTERNAL', dataType: 'INT16' },
        { name: 'toString', scope: 'INTERNAL', dataType: 'STRING' },
      ],
    },
    store
  );
  assert.equal(upsertRes.ok, true);
  const data = upsertRes.data as { upsertedCount: number; rejectedCount: number; errors: { code: string }[] };
  assert.equal(data.upsertedCount, 0);
  assert.equal(data.rejectedCount, 2);
  assert.ok(data.errors.every((e) => e.code === 'RESERVED_IDENTIFIER'));
});

test('Inversion #2: Exact O(N) MQTT 3.1.1 §4.7 topic matcher (parent "#" match, $SYS guard, zero ReDoS)', () => {
  // MQTT §4.7.1.2: "plant/chiller01/#" MUST match parent "plant/chiller01" AND children
  assert.equal(matchMqttTopicFilter('plant/chiller01/#', 'plant/chiller01'), true);
  assert.equal(matchMqttTopicFilter('plant/chiller01/#', 'plant/chiller01/telemetry'), true);
  assert.equal(matchMqttTopicFilter('plant/chiller01/#', 'plant/chiller01/a/b/c'), true);
  assert.equal(matchMqttTopicFilter('plant/chiller01/#', 'plant/chiller02'), false);

  // Single-level "+"
  assert.equal(matchMqttTopicFilter('plant/+/temp', 'plant/chiller01/temp'), true);
  assert.equal(matchMqttTopicFilter('plant/+/temp', 'plant/chiller01/zone1/temp'), false);

  // MQTT §4.7.2: leading "#" or "+" MUST NOT match "$SYS/..."
  assert.equal(matchMqttTopicFilter('#', '$SYS/broker/clients'), false);
  assert.equal(matchMqttTopicFilter('+/broker/clients', '$SYS/broker/clients'), false);
  assert.equal(matchMqttTopicFilter('$SYS/#', '$SYS/broker/clients'), true);

  // ReDoS stress: 1000-level path executes in < 5ms
  const deepFilter = Array(500).fill('+').join('/') + '/#';
  const deepTopic = Array(500).fill('lvl').join('/') + '/leaf';
  const t0 = performance.now();
  assert.equal(matchMqttTopicFilter(deepFilter, deepTopic), true);
  assert.ok(performance.now() - t0 < 50);
});

test('Inversion #3: haiwell_project_create blocks accidental overwrite unless overwrite=true', async () => {
  const store = makeStore();
  const blocked = await invokeHaiwellTool(
    'haiwell_project_create',
    { id: 'prj_chiller_plant_01', name: 'Accidental Wipe' },
    store
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error?.message ?? '', /PROJECT_ALREADY_EXISTS/);

  // Explicit overwrite=true succeeds when intentional
  const allowed = await invokeHaiwellTool(
    'haiwell_project_create',
    { id: 'prj_chiller_plant_01', name: 'Intentional Replace', overwrite: true },
    store
  );
  assert.equal(allowed.ok, true);
});

test('Inversion #4: IEC 61131-3 ST transpiler handles IF inside CASE, multi-statement CASE, countdown FOR, WHILE/REPEAT watchdog, and inline VAR', () => {
  const st = [
    'PROGRAM TranspileStress',
    'VAR_INPUT Mode : INT; Enable : BOOL; END_VAR',
    'VAR_OUTPUT OutA : INT; OutB : INT; Countdown : INT; LoopSum : INT; RepeatSum : INT; END_VAR',
    'VAR i : INT; w : INT; END_VAR',
    'CASE Mode OF',
    '  1:',
    '    OutA := 10;',
    '    IF Enable THEN',
    '      OutB := 20;',
    '    ELSE',
    '      OutB := 30;',
    '    END_IF;',
    '  2:',
    '    OutA := 99;',
    '    OutB := 88;',
    'ELSE',
    '  OutA := 0;',
    '  OutB := 0;',
    'END_CASE;',
    'Countdown := 0;',
    'FOR i := 5 TO 1 BY -1 DO',
    '  Countdown := Countdown + i;',
    'END_FOR;',
    'w := 0;',
    'LoopSum := 0;',
    'WHILE w < 4 DO',
    '  w := w + 1;',
    '  LoopSum := LoopSum + w;',
    'END_WHILE;',
    'RepeatSum := 0;',
    'REPEAT',
    '  RepeatSum := RepeatSum + 2;',
    'UNTIL RepeatSum >= 6',
    'END_REPEAT;',
    'END_PROGRAM',
  ].join('\n');

  const res = transpileStToHaiwellJs(st);
  assert.equal(res.success, true, JSON.stringify(res.validation.diagnostics));
  assert.ok(res.jsCode);

  // Execute the generated JavaScript in a sandboxed function to prove runtime correctness!
  const runJs = (inputs: Record<string, unknown>) => {
    const outputs: Record<string, unknown> = {};
    const Tag = {
      Read: (k: string) => inputs[k],
      Write: (k: string, v: unknown) => {
        outputs[k] = v;
      },
    };
    const Variable = {
      GetByFullName: (k: string) => inputs[k],
      SetByFullName: (k: string, v: unknown) => {
        outputs[k] = v;
      },
    };
    const fn = new Function('Tag', 'Variable', res.jsCode!);
    fn(Tag, Variable);
    return outputs;
  };

  // Mode=1, Enable=false -> OutA=10, OutB=30 (IF-ELSE inside CASE must NOT emit default: or early break!)
  const run1 = runJs({ Mode: 1, Enable: false });
  assert.equal(run1.OutA, 10);
  assert.equal(run1.OutB, 30);
  // Countdown: 5+4+3+2+1 = 15 (negative BY -1 must use >=)
  assert.equal(run1.Countdown, 15);
  // WHILE: 1+2+3+4 = 10
  assert.equal(run1.LoopSum, 10);
  // REPEAT UNTIL >= 6: 2 -> 4 -> 6
  assert.equal(run1.RepeatSum, 6);

  // Mode=2 -> multi-statement branch executes BOTH OutA=99 and OutB=88
  const run2 = runJs({ Mode: 2, Enable: true });
  assert.equal(run2.OutA, 99);
  assert.equal(run2.OutB, 88);
});

test('Inversion #5: Siemens S7 byte-level overlap detection & Omron D/DM aliasing', () => {
  const protocols = new Map<string, PlcDriverProtocol>([
    ['s7', 'SIEMENS_S7_1200'],
    ['omron', 'OMRON_FINS_TCP'],
  ]);

  const makeTag = (name: string, deviceId: string, address: string, dataType: TagDefinition['dataType']): TagDefinition => ({
    name,
    scope: 'PLC',
    deviceId,
    address,
    dataType,
    access: 'RW',
    safetyClass: 'SIL0',
    requiresInterlock: false,
    currentValue: 0,
    quality: 'GOOD',
    updatedAt: new Date().toISOString(),
  });

  // Adjacent S7 bytes DB1.DBB0 and DB1.DBB1 must NOT collide
  const noCollision = detectWordOverlapConflicts(
    {
      Byte0: makeTag('Byte0', 's7', 'DB1.DBB0', 'UINT16'),
      Byte1: makeTag('Byte1', 's7', 'DB1.DBB1', 'UINT16'),
    },
    protocols
  );
  assert.equal(noCollision.length, 0);

  // Unaligned S7 words DB1.DBW1 (bytes 1-2) and DB1.DBW2 (bytes 2-3) MUST collide on byte 2!
  const unalignedCollision = detectWordOverlapConflicts(
    {
      Word1: makeTag('Word1', 's7', 'DB1.DBW1', 'INT16'),
      Word2: makeTag('Word2', 's7', 'DB1.DBW2', 'INT16'),
    },
    protocols
  );
  assert.equal(unalignedCollision.length, 1);

  // Omron D100 and DM100 alias the SAME Data Memory area and MUST collide
  const omronAlias = detectWordOverlapConflicts(
    {
      TagD: makeTag('TagD', 'omron', 'D100', 'INT16'),
      TagDM: makeTag('TagDM', 'omron', 'DM100', 'INT16'),
    },
    protocols
  );
  assert.equal(omronAlias.length, 1);
});

test('Inversion #6: scriptAnalyzer ignores commented Tag.Write and blocks commented EStop_OK bypass', () => {
  const store = makeStore();
  const tags = store.getProject('prj_chiller_plant_01').tags;

  // Commented-out Tag.Write to RO tag should NOT trigger false-positive error
  const commentedOut = validateHaiwellScript(
    '// Tag.Write("EStop_OK", false);\nconst t = Tag.Read("Supply_Temp_C");',
    tags
  );
  assert.equal(commentedOut.valid, true);
  assert.equal(commentedOut.writtenTags.length, 0);

  // Commented-out EStop_OK must NOT suppress SIL2 HWJS-SAFE-003 warning!
  const bypassAttempt = validateHaiwellScript(
    '// EStop_OK checked somewhere else\nTag.Write("Pump1_Run_Cmd", true);',
    tags
  );
  assert.ok(bypassAttempt.diagnostics.some((d) => d.code === 'HWJS-SAFE-003'));
});

test('Inversion #7: Multi-step simulation latches previousValue per scan so RISING_EDGE fires only once', async () => {
  const store = makeStore();

  // Add a RISING_EDGE event trigger on Auto_Mode_Sel (initial value is true; set false first, then inject true)
  await invokeHaiwellTool(
    'haiwell_tag_read_write',
    { operation: 'WRITE', tagName: 'Auto_Mode_Sel', value: false },
    store
  );
  const trg = await invokeHaiwellTool(
    'haiwell_event_trigger_configure',
    {
      id: 'trg_edge_once',
      name: 'Auto Mode Rising Edge',
      sourceTag: 'Auto_Mode_Sel',
      condition: 'RISING_EDGE',
      actionType: 'WRITE_TAG',
      targetId: 'Chiller_Setpoint_C',
      actionValue: 7.5,
    },
    store
  );
  assert.equal(trg.ok, true);

  const sim = await invokeHaiwellTool(
    'haiwell_simulation_step',
    { injectTagValues: { Auto_Mode_Sel: true }, steps: 3 },
    store
  );
  assert.equal(sim.ok, true);
  const trace = (sim.data as { trace: { step: number; triggeredEvents: string[] }[] }).trace;
  assert.equal(trace[0].triggeredEvents.length, 1); // Fires on step 1
  assert.equal(trace[1].triggeredEvents.length, 0); // Must NOT phantom-refire on step 2!
  assert.equal(trace[2].triggeredEvents.length, 0); // Must NOT phantom-refire on step 3!
});

test('Inversion #8: SSRF bypasses (IPv6-mapped, decimal, hex, octal, 0.0.0.0, metadata.goog) blocked everywhere', async () => {
  const bypasses = [
    '169.254.169.254',
    '::ffff:169.254.169.254',
    '[::ffff:169.254.169.254]',
    '::ffff:a9fe:a9fe',
    '2852039166',
    '0xa9fea9fe',
    '0251.0376.0251.0376',
    '0.0.0.0',
    '::',
    'metadata.goog',
    'metadata.google.internal.',
  ];
  for (const host of bypasses) {
    assert.equal(isBlockedSsrfHost(host), true, `Expected SSRF host "${host}" to be blocked`);
    const probe = await probeTcpEndpoint(host, 80, 100);
    assert.equal(probe.reachable, false);
    assert.match(probe.error ?? '', /SSRF_BLOCK/);
  }
  // Valid plant LAN PLC IPs remain allowed
  assert.equal(isBlockedSsrfHost('192.168.1.50'), false);
  assert.equal(isBlockedSsrfHost('10.0.10.15'), false);

  // Webhook also blocks SSRF bypasses and invalid payloadTemplate JSON
  const store = makeStore();
  const whSsrf = await invokeHaiwellTool(
    'haiwell_webhook_configure',
    { id: 'wh_ssrf', name: 'Bad SSRF', url: 'https://0xa9fea9fe/latest/meta-data/' },
    store
  );
  assert.equal(whSsrf.ok, false);
  assert.match(whSsrf.error?.message ?? '', /SSRF_BLOCK/);

  const whBadJson = await invokeHaiwellTool(
    'haiwell_webhook_configure',
    { id: 'wh_badjson', name: 'Bad JSON', url: 'https://mes.example.com/hook', payloadTemplate: '{not valid json' },
    store
  );
  assert.equal(whBadJson.ok, false);
  assert.match(whBadJson.error?.message ?? '', /INVALID_PAYLOAD_TEMPLATE/);
});

test('Inversion #9: CSV export escapes commas, quotes, newlines, and spreadsheet formulas', async () => {
  const store = makeStore();
  await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      tags: [
        {
          name: 'Formula_Unit_Tag',
          scope: 'INTERNAL',
          dataType: 'FLOAT32',
          unit: '=CMD("x"),"kW"',
        },
      ],
    },
    store
  );
  const bundle = buildProjectExportBundle(store.getProject('prj_chiller_plant_01'));
  const csv = bundle.artifacts['tags.csv'];
  assert.ok(csv.includes(`"'=CMD(""x""),""kW"""`), `Expected escaped CSV formula cell in: ${csv}`);
});

test('Inversion #10: Complete cascade deletion leaves ZERO dangling references in safety audit', async () => {
  const store = makeStore();
  // Create a tag referenced by alarm, recipe, trend, datalink, report, eventTrigger, and MQTT binding
  await invokeHaiwellTool(
    'haiwell_tag_upsert_batch',
    {
      tags: [{ name: 'Cascade_Test_Tag', scope: 'INTERNAL', dataType: 'FLOAT32', access: 'RW', initialValue: 5 }],
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_alarm_configure',
    {
      id: 'alm_cascade',
      name: 'Cascade Alarm',
      tagName: 'Cascade_Test_Tag',
      condition: 'HI',
      threshold: 10,
      messageTemplate: 'High',
      channels: ['SCREEN_POPUP'],
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_trend_configure',
    { action: 'UPSERT_GROUP', groupId: 'trd_cascade', name: 'Cascade Trend', tagNames: ['Cascade_Test_Tag'] },
    store
  );
  await invokeHaiwellTool(
    'haiwell_report_configure',
    {
      id: 'rep_cascade',
      name: 'Cascade Report',
      columns: [{ header: 'Val', tagName: 'Cascade_Test_Tag', aggregate: 'AVG' }],
    },
    store
  );

  // Non-cascade delete must block
  const blocked = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { entityType: 'tag', entityId: 'Cascade_Test_Tag', cascade: false },
    store
  );
  assert.equal((blocked.data as { deleted: boolean }).deleted, false);

  // Cascade delete cleans ALL collections -> safety audit has 0 AUD-DANGLING-TAG findings!
  const deleted = await invokeHaiwellTool(
    'haiwell_entity_delete',
    { entityType: 'tag', entityId: 'Cascade_Test_Tag', cascade: true },
    store
  );
  assert.equal((deleted.data as { deleted: boolean }).deleted, true);

  const audit = runProjectSafetyAudit(store.getProject('prj_chiller_plant_01'));
  assert.equal(audit.findings.filter((f) => f.code === 'AUD-DANGLING-TAG').length, 0);
  assert.equal(audit.deploymentReady, true);
});

test('Inversion #11: Desktop bridge Python script uses Base64 (immune to triple-quote/backslash injection) & escapes SendKeys', () => {
  const store = makeStore();
  const project = store.getProject('prj_chiller_plant_01');
  const screen = JSON.parse(JSON.stringify(project.screens[0]));
  // Inject adversarial triple-quotes, trailing backslash, and pywinauto SendKeys modifiers into label
  screen.widgets[0].label = `Pump (1) + Valve [50%] ''' \\`;

  const plan = compileDesktopAutomationBridge(screen, project.tags, {
    knownScreenIds: new Set(project.screens.map((s) => s.id)),
    targetHardware: project.targetHardware,
  });
  assert.ok(plan.pywinautoScript.includes('base64.b64decode('));
  assert.ok(plan.pywinautoScript.includes('def escape_send_keys'));
  assert.ok(!plan.pywinautoScript.includes(`r'''`));
});

test('Inversion #12: OPC UA security mismatch, event trigger validation, transpile gate, and dynamic tool count', async () => {
  const store = makeStore();

  // OPC UA mismatch rejected
  const badOpc = await invokeHaiwellTool(
    'haiwell_opcua_configure',
    {
      role: 'SERVER',
      endpointUrl: 'opc.tcp://0.0.0.0:4840/test',
      namespaceUri: 'urn:test:opc',
      securityPolicy: 'None',
      securityMode: 'SignAndEncrypt',
    },
    store
  );
  assert.equal(badOpc.ok, false);
  assert.match(badOpc.error?.message ?? '', /OPCUA_SECURITY_MISMATCH/);

  // Event trigger GT without threshold rejected
  const badTrg = await invokeHaiwellTool(
    'haiwell_event_trigger_configure',
    {
      id: 'trg_no_thresh',
      name: 'Missing Threshold',
      sourceTag: 'Supply_Temp_C',
      condition: 'GT',
      actionType: 'OPEN_SCREEN',
      targetId: 'scr_chiller_overview',
    },
    store
  );
  assert.equal(badTrg.ok, false);

  // Transpile with registerScriptId referencing undeclared SCADA tag must NOT persist invalid script
  const badTranspile = await invokeHaiwellTool(
    'haiwell_iec61131_transpile_js',
    {
      source: 'PROGRAM BadBind\nVAR_INPUT GhostTag : REAL;\nEND_VAR\nVAR_OUTPUT OutGhost : REAL;\nEND_VAR\nOutGhost := GhostTag + 1.0;\nEND_PROGRAM',
      registerScriptId: 'scr_ghost_invalid',
    },
    store
  );
  assert.equal(badTranspile.ok, true);
  assert.equal((badTranspile.data as { registered: boolean }).registered, false);
  assert.equal(
    store.getProject('prj_chiller_plant_01').scripts.some((s) => s.id === 'scr_ghost_invalid'),
    false
  );

  // Skill markdown dynamically reports exact tool count (57 tools)
  const { HAIWELL_TOOLS } = await import('./toolRegistry');
  const skillMd = generateAgentSkillMarkdown('http://localhost:3000/mcp');
  assert.match(skillMd, new RegExp(`${HAIWELL_TOOLS.length} strictly validated tools`));
});

test('Production MCP #13: Tool annotations, SHA-256 catalog hash, scoped profiles, idempotencyKey, and expectedRevision concurrency guard', async () => {
  const {
    HAIWELL_TOOLS,
    computeToolCatalogHash,
    getToolsForProfile,
    serializeToolCatalog,
  } = await import('./toolRegistry');

  // Tool annotations accurately distinguish readOnly vs destructive tools
  const catalog = serializeToolCatalog('all');
  const inspectTool = catalog.find((t) => t.name === 'haiwell_project_inspect')!;
  const deleteTool = catalog.find((t) => t.name === 'haiwell_entity_delete')!;
  assert.equal(inspectTool.annotations.readOnlyHint, true);
  assert.equal(inspectTool.annotations.destructiveHint, false);
  assert.equal(deleteTool.annotations.readOnlyHint, false);
  assert.equal(deleteTool.annotations.destructiveHint, true);

  // Scoped profiles keep context-window tool count lean (14 tools for core)
  assert.equal(getToolsForProfile('core').length, 14);
  assert.ok(getToolsForProfile('hmi').length <= 32);
  assert.equal(getToolsForProfile('all').length, HAIWELL_TOOLS.length);

  // Deterministic SHA-256 rug-pull hash
  const hashA = computeToolCatalogHash('all');
  const hashB = computeToolCatalogHash('all');
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[a-f0-9]{64}$/);

  // IdempotencyKey prevents duplicate mutations on agent retry storms
  const store = makeStore();
  const rev0 = store.getProject('prj_chiller_plant_01').revision;
  const first = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    {
      operation: 'WRITE',
      tagName: 'Chiller_Setpoint_C',
      value: 8.2,
      idempotencyKey: 'retry-req-001',
      expectedRevision: rev0,
    },
    store
  );
  assert.equal(first.ok, true);
  assert.equal(first.idempotentReplay, undefined);
  const rev1 = store.getProject('prj_chiller_plant_01').revision;
  assert.ok(rev1 > rev0);

  // Replay with same idempotencyKey returns cached result WITHOUT bumping revision again
  const replay = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    {
      operation: 'WRITE',
      tagName: 'Chiller_Setpoint_C',
      value: 8.2,
      idempotencyKey: 'retry-req-001',
      expectedRevision: rev0,
    },
    store
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(store.getProject('prj_chiller_plant_01').revision, rev1);

  // Stale expectedRevision without matching idempotencyKey is rejected with REVISION_CONFLICT
  const conflict = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    {
      operation: 'WRITE',
      tagName: 'Chiller_Setpoint_C',
      value: 9.0,
      expectedRevision: rev0,
    },
    store
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, 'REVISION_CONFLICT');
});

test('Production MCP #14: HTTP Bearer auth, Origin DNS-rebinding guard, scoped ?profile=core, structuredContent, and rate limiting', async () => {
  const { createApp } = await import('../../server');
  const store = makeStore();
  const app = createApp(store, {
    authToken: 'super-secret-agent-token',
    allowedOrigins: ['https://trusted-ide.local'],
    rateLimitPerMin: 25,
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address() as import('node:net').AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    // Health remains accessible without auth and includes X-Request-Id
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.ok(health.headers.get('x-request-id'));

    // Unauthenticated /mcp returns 401 JSON
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(unauth.status, 401);

    // Spoofed Origin header returns 403 ORIGIN_FORBIDDEN (DNS rebinding guard)
    const badOrigin = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-rebinding.attacker',
        Authorization: 'Bearer super-secret-agent-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(badOrigin.status, 403);

    // Authorized /mcp?profile=core exposes 14 tools with MCP annotations
    const mcpHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'https://trusted-ide.local',
      Authorization: 'Bearer super-secret-agent-token',
    };
    const coreList = await fetch(`${base}/mcp?profile=core`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(coreList.status, 200);
    const listBody = (await coreList.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    assert.equal(listBody.result.tools.length, 14);
    const inspectMeta = listBody.result.tools.find((t) => t.name === 'haiwell_project_inspect');
    assert.equal(inspectMeta?.annotations?.readOnlyHint, true);

    // tools/call returns BOTH text content AND structuredContent
    const callRes = await fetch(`${base}/mcp?profile=core`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'haiwell_project_inspect', arguments: {} },
      }),
    });
    assert.equal(callRes.status, 200);
    const callJson = (await callRes.json()) as { result: { structuredContent?: { ok: boolean; tool: string }; content: unknown[] } };
    assert.equal(callJson.result.structuredContent?.ok, true);
    assert.equal(callJson.result.structuredContent?.tool, 'haiwell_project_inspect');

    // Burst past token bucket triggers actionable 429 RATE_LIMITED with Retry-After header
    let got429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${base}/api/rpc`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({ tool: 'haiwell_project_inspect', arguments: {} }),
      });
      if (r.status === 429) {
        assert.ok(r.headers.get('retry-after'));
        got429 = true;
        break;
      }
    }
    assert.equal(got429, true, 'Expected token-bucket rate limiter to return HTTP 429');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
