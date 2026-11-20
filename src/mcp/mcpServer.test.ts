import test from 'node:test';
import assert from 'node:assert/strict';
import { HaiwellProjectStore } from './projectStore';
import { HAIWELL_TOOLS, invokeHaiwellTool } from './toolRegistry';
import { HAIWELL_CAPABILITY_MATRIX, readHaiwellResource } from './resourcesAndPrompts';

test('tool registry covers all 15 Haiwell Cloud SCADA Develop domains with valid Zod schemas', () => {
  const domains = new Set(HAIWELL_TOOLS.map((t) => t.domain));
  assert.equal(domains.size, 15);
  assert.equal(HAIWELL_CAPABILITY_MATRIX.length, 15);
  assert.ok(HAIWELL_TOOLS.length >= 40);
});

test('enforces safety guards on read-only hardware tags, engineering bounds, and SIL interlocks', async () => {
  const store = new HaiwellProjectStore();

  // Attempt write to RO physical input X0
  const roRes = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    { projectId: 'prj_chiller_plant_01', operation: 'WRITE', tagName: 'EStop_OK', value: false },
    store
  );
  assert.equal(roRes.ok, true);
  assert.equal((roRes.data as { blockedBy?: string }).blockedBy, 'READ_ONLY_GUARD');

  // Attempt out-of-range setpoint write (> 15.0 °C)
  const rangeRes = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    { projectId: 'prj_chiller_plant_01', operation: 'WRITE', tagName: 'Chiller_Setpoint_C', value: 40.0 },
    store
  );
  assert.equal((rangeRes.data as { blockedBy?: string }).blockedBy, 'SAFE_RANGE_MAX');

  // Attempt SIL2 interlocked pump write without confirmSafetyOverride
  const interlockRes = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    { projectId: 'prj_chiller_plant_01', operation: 'WRITE', tagName: 'Pump1_Run_Cmd', value: false },
    store
  );
  assert.equal((interlockRes.data as { blockedBy?: string }).blockedBy, 'INTERLOCK_CONFIRMATION_REQUIRED');

  // Confirmed dry-run passes guards without mutating live value
  const dryRes = await invokeHaiwellTool(
    'haiwell_tag_read_write',
    {
      projectId: 'prj_chiller_plant_01',
      operation: 'WRITE',
      tagName: 'Pump1_Run_Cmd',
      value: false,
      confirmSafetyOverride: true,
      dryRun: true,
      reason: 'Maintenance test',
    },
    store
  );
  assert.equal((dryRes.data as { wouldPassGuards?: boolean }).wouldPassGuards, true);
  assert.equal(store.getProject('prj_chiller_plant_01').tags.Pump1_Run_Cmd.currentValue, true);
});

test('end-to-end engineering workflow: HMI auto-layout, MQTT Sparkplug B, OPC UA NodeSet2 XML, and safety audit', async () => {
  const store = new HaiwellProjectStore();

  // Generate ISA-101 HMI screen and verify zero collisions
  const hmiRes = await invokeHaiwellTool(
    'haiwell_hmi_screen_generate',
    {
      projectId: 'prj_chiller_plant_01',
      screenId: 'scr_unit_test',
      name: 'Unit Test HMI',
      columns: 3,
      items: [
        { type: 'NUMERIC_DISPLAY', label: 'Supply', tagName: 'Supply_Temp_C', unit: '°C' },
        { type: 'NUMERIC_DISPLAY', label: 'Return', tagName: 'Return_Temp_C', unit: '°C' },
        { type: 'PUMP', label: 'Pump 1', tagName: 'Pump1_Run_Cmd', writeEnabled: true },
      ],
      returnSvg: true,
    },
    store
  );
  assert.equal(hmiRes.ok, true);
  const hmiData = hmiRes.data as { validation: { valid: boolean }; svg: string };
  assert.equal(hmiData.validation.valid, true);
  assert.match(hmiData.svg, /<svg /);

  // Publish MQTT Sparkplug B frame and read loopback
  const pubRes = await invokeHaiwellTool(
    'haiwell_mqtt_exchange',
    { projectId: 'prj_chiller_plant_01', action: 'PUBLISH_BINDING', bindingId: 'mqtt_bind_telemetry' },
    store
  );
  assert.equal(pubRes.ok, true);
  const readRes = await invokeHaiwellTool(
    'haiwell_mqtt_exchange',
    { projectId: 'prj_chiller_plant_01', action: 'READ_LOOPBACK', topicFilter: 'spBv1.0/#' },
    store
  );
  assert.equal((readRes.data as { count: number }).count, 1);

  // Export OPC UA NodeSet2 XML via MCP Resource
  const uaXml = readHaiwellResource('haiwell://project/prj_chiller_plant_01/opcua-nodeset2', store);
  assert.equal(uaXml.mimeType, 'application/xml');
  assert.match(uaXml.text, /<UANodeSet/);
  assert.match(uaXml.text, /Supply_Temp_C/);

  // Seeded reference project passes pre-deployment safety audit cleanly
  const auditRes = await invokeHaiwellTool(
    'haiwell_project_audit_safety',
    { projectId: 'prj_chiller_plant_01' },
    store
  );
  assert.equal((auditRes.data as { deploymentReady: boolean }).deploymentReady, true);
});

test('strict Zod schema validation rejects invalid payloads deterministically', async () => {
  const store = new HaiwellProjectStore();
  const res = await invokeHaiwellTool(
    'haiwell_opcua_configure',
    {
      role: 'SERVER',
      endpointUrl: 'http://not-opc-tcp',
      namespaceUri: 'urn:test',
    },
    store
  );
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'SCHEMA_VALIDATION_ERROR');
});
