import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HaiwellProjectStore } from './projectStore';
import { invokeHaiwellTool } from './toolRegistry';
import { compileFullOpenProjectBridge } from './hmiSpatialEngine';
import { SERVER_VERSION } from './version';

test('v2.10.0: haiwell_project_export_hwexport generates valid <HwExportModel> XML with PNG MD5 integrity and SVG documents', async () => {
  assert.equal(SERVER_VERSION, '2.10.0');
  const store = new HaiwellProjectStore();
  await invokeHaiwellTool(
    'haiwell_project_create',
    {
      id: 'prj_hwexp_test',
      name: 'Festo_Test_Export',
      targetHardware: 'CLOUD_HMI_B7H',
      width: 1024,
      height: 600,
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_device_add',
    {
      projectId: 'prj_hwexp_test',
      id: 'modbus_1',
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
      projectId: 'prj_hwexp_test',
      tags: [
        { name: 'START', scope: 'PLC', deviceId: 'modbus_1', address: '0X40', dataType: 'BOOL', access: 'RW', initialValue: false },
        { name: 'COUNTER', scope: 'PLC', deviceId: 'modbus_1', address: '4X100', dataType: 'UINT16', access: 'RW', initialValue: 12 },
        {
          name: 'Modbus_1_Comm_OK',
          scope: 'INTERNAL',
          dataType: 'BOOL',
          access: 'RO',
          initialValue: true,
          description: 'Modbus_1 communication status (imported from Modbus_1._commStatus)',
        },
      ],
    },
    store
  );
  await invokeHaiwellTool(
    'haiwell_hmi_screen_generate',
    {
      projectId: 'prj_hwexp_test',
      screenId: 'scr_hwexp_1',
      name: 'MPS_Line_Overview',
      width: 1024,
      height: 600,
      columns: 2,
      sections: [
        {
          id: 'sec_ctrl',
          title: 'Controls',
          columns: 3,
          items: [
            { type: 'BIT_BUTTON', label: 'START ALL', tagName: 'START', writeEnabled: true, visualRole: 'PRIMARY_ACTION' },
            { type: 'BIT_LAMP', label: 'ST1 Comm', tagName: 'Modbus_1_Comm_OK' },
            { type: 'NUMERIC_DISPLAY', label: 'Finished Parts', tagName: 'COUNTER', unit: 'pcs' },
          ],
        },
      ],
    },
    store
  );

  const res = await invokeHaiwellTool(
    'haiwell_project_export_hwexport',
    { projectId: 'prj_hwexp_test', startWindowId: 5, language: 'en_0' },
    store
  );
  assert.equal(res.ok, true);
  const data = res.data as {
    format: string;
    screensExported: number;
    widgetsExported: number;
    variablesBound: number;
    xml: string;
  };
  assert.equal(data.format, 'HAIWELL_NATIVE_HWEXPORT_XML');
  assert.equal(data.screensExported, 1);
  assert.equal(data.variablesBound, 3);
  assert.ok(data.xml.includes('<HwExportModel '));
  assert.ok(data.xml.includes('<Versions>3</Versions>'));
  assert.ok(data.xml.includes('<string>Modbus_1.START</string>'));
  assert.ok(data.xml.includes('<string>Modbus_1.COUNTER</string>'));
  assert.ok(data.xml.includes('<string>Modbus_1._commStatus</string>'));

  // Verify PNG MD5s & inner SVG XML parsing using Python ElementTree
  const tmpXml = path.join(os.tmpdir(), `hwexp_test_${Date.now()}.hwExport`);
  fs.writeFileSync(tmpXml, data.xml, 'utf8');
  try {
    const pyCheck = `
import base64, hashlib, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
assert root.tag == "HwExportModel"
pics = {}
for sd in root.findall("Windows/DicSymPic/SerializableDictionary"):
    md5 = sd.find("key/string").text
    b64 = sd.find("value/windowDocumentPicture/SourcePicture").text
    raw = base64.b64decode(b64)
    assert raw[:8] == b"\\x89PNG\\r\\n\\x1a\\n"
    assert hashlib.md5(raw).hexdigest() == md5
    pics[md5] = True
for sd in root.findall("Windows/DicSymLib/SerializableDictionary"):
    md5 = sd.find("value/ProjectSymbolLibrary/PicMd5").text
    assert md5 in pics, f"Missing PicMd5 {md5}"
docs = root.findall(".//WindowDocument/Document")
assert len(docs) == 1
svg_root = ET.fromstring(docs[0].text.encode("utf-8"))
assert svg_root.tag.endswith("svg")
print("OK_PY_VERIFY", len(pics), len(list(svg_root)))
`;
    const out = execFileSync('python', ['-c', pyCheck, tmpXml], { encoding: 'utf8' });
    assert.ok(out.includes('OK_PY_VERIFY'));
  } finally {
    fs.rmSync(tmpXml, { force: true });
  }

  // Also verify haiwell_project_export includes project.hwExport when requested
  const bundleRes = await invokeHaiwellTool(
    'haiwell_project_export',
    { projectId: 'prj_hwexp_test', includeArtifacts: ['hwexport_xml'] },
    store
  );
  assert.equal(bundleRes.ok, true);
  const artifacts = (bundleRes.data as { artifacts: Record<string, unknown> }).artifacts;
  assert.ok(String(artifacts['project.hwExport']).includes('<HwExportModel '));

  // Verify UIA bridge vertical label fallback & Picture name
  const prj = store.getProject('prj_hwexp_test');
  const bridge = compileFullOpenProjectBridge(prj, { sections: ['displays'] });
  assert.ok(bridge.pywinautoScript.includes('"Picture name"'));
  assert.ok(bridge.pywinautoScript.includes('cr.top - lr.bottom'));
  // Verify cryptographic md5 import sanity
  assert.equal(typeof crypto.createHash('md5').digest('hex'), 'string');
});
