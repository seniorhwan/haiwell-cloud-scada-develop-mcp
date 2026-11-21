/**
 * MCP Resources, Dynamic ResourceTemplates, Agent Skill Prompts, Capability Index,
 * and Ready-to-Use IDE/Agent Config Generators for VS Code, Google Antigravity,
 * Claude Code, and OpenAI Codex CLI.
 */

import path from 'node:path';
import { HAIWELL_REGISTER_MAP } from './haiwellRegisters';
import { renderScreenToSvg } from './hmiGenerator';
import { generateOpcUaNodeSet2Xml } from './protocolAdapters';
import { buildProjectExportBundle, HAIWELL_TOOLS, runProjectSafetyAudit } from './toolRegistry';
import type { HaiwellProjectStore } from './projectStore';

export interface CapabilityDomainSummary {
  id: string;
  title: string;
  haiwellModules: string[];
  tools: string[];
  standards: string[];
}

export const HAIWELL_CAPABILITY_MATRIX: CapabilityDomainSummary[] = [
  {
    id: 'project',
    title: 'Project Lifecycle, Snapshots, Safe Delete & Audit',
    haiwellModules: ['New Project Wizard (PC/C7/C10/B7/B10/A8/CBOX/IPC)', 'Project Tree', 'Atomic Snapshots & Rollback', 'Referential-Integrity Delete', 'Pre-Deploy Audit', 'Full Bundle Export'],
    tools: ['haiwell_project_create', 'haiwell_project_inspect', 'haiwell_project_snapshot_rollback', 'haiwell_entity_delete', 'haiwell_project_audit_safety', 'haiwell_project_export'],
    standards: ['ISA-95', 'IEC 62443'],
  },
  {
    id: 'devices',
    title: 'Multi-Vendor PLC Drivers, Address Map & Cloud Tunnel',
    haiwellModules: ['Haiwell PLC TCP/RTU', 'Modbus TCP/RTU', 'Siemens S7-1200/1500', 'Mitsubishi MC 3E', 'Omron FINS', 'Allen-Bradley EIP', 'BACnet/IP', 'Cloud Transparent Tunnel (CBOX)'],
    tools: ['haiwell_device_add', 'haiwell_device_validate_address', 'haiwell_cloud_transparent_tunnel'],
    standards: ['Modbus RTU/TCP', 'Haiwell', 'S7', 'MC3E', 'FINS', 'BACnet'],
  },
  {
    id: 'tags',
    title: 'Tag Database, Multi-Word Overlap Guard & Atomic Batch I/O',
    haiwellModules: ['Unlimited Tag Database', 'Linear Scaling & Clamping', 'Multi-Word Overlap Detection', 'Strict Binary Type/Range Guards', 'SIL0-SIL3 Interlocks', 'Atomic Batch Read/Write'],
    tools: ['haiwell_tag_upsert_batch', 'haiwell_tag_query', 'haiwell_tag_read_write', 'haiwell_tag_batch_io'],
    standards: ['IEC 61508 (SIL)', 'IEEE 754', 'OPC Quality'],
  },
  {
    id: 'iec61131',
    title: 'IEC 61131-3 Logic Validation & JS Transpilation',
    haiwellModules: ['Multi-Line/Single-Line ST Analyzer', 'ARRAY & CASE/ELSE Checks', 'Unguarded Division & Watchdog Loop Detection', 'LD Double-Coil Checker', 'FBD Cycle/Algebraic-Loop Checker', 'ST-to-Haiwell-JS Transpiler'],
    tools: ['haiwell_iec61131_validate', 'haiwell_iec61131_pou_save', 'haiwell_iec61131_transpile_js'],
    standards: ['IEC 61131-3:2013 (3rd Ed.)'],
  },
  {
    id: 'hmi',
    title: 'Zero-Error Spatial HMI, Font Manager, Shape Library & Calibrated UIA Bridge',
    haiwellModules: [
      'Component Toolbox & Port-Geometry Catalog',
      'Semantic P&ID Process Graph & Orthogonal Pipeline Compiler',
      '2D Collision-Free Auto-Layout (Zero Silent Drops)',
      'Deterministic 8px-Grid & Collision Auto-Repair Solver',
      'Closed-Loop Spatial Proof & 2D ASCII Occupancy Map',
      'Reusable Parameterized Faceplates',
      'Font Manager (Embedded Panel Fonts & CJK Packaging)',
      'Shape Library (Custom Vector/SVG Equipment Graphics)',
      'Calibrated Haiwell Cloud Scada 3.50.x (.hwdev) WinForms UIA Bridge',
    ],
    tools: [
      'haiwell_hmi_toolbox_catalog',
      'haiwell_hmi_screen_generate',
      'haiwell_hmi_pid_compile',
      'haiwell_hmi_widget_upsert',
      'haiwell_hmi_layout_solve',
      'haiwell_hmi_faceplate_manage',
      'haiwell_hmi_spatial_verify',
      'haiwell_hmi_screen_render_svg',
      'haiwell_font_manager',
      'haiwell_shape_library_manage',
      'haiwell_desktop_uia_calibrate',
      'haiwell_hmi_desktop_bridge_export',
      'haiwell_open_project_bridge_export',
      'haiwell_desktop_inspect',
      'haiwell_desktop_launch',
      'haiwell_desktop_new_project',
    ],
    standards: ['ANSI/ISA-101.01', 'ISA-5.1 P&ID'],
  },
  {
    id: 'scripts',
    title: 'Haiwell JavaScript Tasks & Declarative Event Triggers',
    haiwellModules: ['Lexer-Hardened JS Sandbox Analyzer', 'Startup/Shutdown/Cyclic/Tag-Change Tasks', 'Declarative Rising/Falling/Threshold Event Triggers'],
    tools: ['haiwell_script_validate', 'haiwell_script_upsert', 'haiwell_event_trigger_configure'],
    standards: ['ECMAScript Sandbox'],
  },
  {
    id: 'alarms',
    title: 'ISA-18.2 Alarm State Machine & Multi-Channel Push',
    haiwellModules: ['HIHI/HI/LO/LOLO/ROC/DEV/Digital Alarms', 'Deduplicating Deadband Hysteresis & Shelving', 'Screen, Voice TTS, Mobile Push, WeChat, SMS, Email'],
    tools: ['haiwell_alarm_configure', 'haiwell_alarm_manage'],
    standards: ['ANSI/ISA-18.2'],
  },
  {
    id: 'mqtt',
    title: 'MQTT 3.1.1/5.0, Sparkplug B & Haiwell Cloud IoT',
    haiwellModules: ['Built-in MQTT Broker & Proxy', 'Strict Level-by-Level +/# Spec Validation', 'Sparkplug B & JSON Bindings', 'SSRF-Safe TCP Probe & Loopback'],
    tools: ['haiwell_mqtt_configure', 'haiwell_mqtt_topic_bind', 'haiwell_mqtt_exchange'],
    standards: ['MQTT 3.1.1 / 5.0', 'Eclipse Sparkplug B'],
  },
  {
    id: 'opcua',
    title: 'OPC UA Server/Client & UANodeSet2 XML',
    haiwellModules: ['OPC UA Security Policies', 'AddressSpace Node Mapping', 'OPC Part 6 UANodeSet2 XML', 'Interlock & Type-Guarded Browse/Read/Write'],
    tools: ['haiwell_opcua_configure', 'haiwell_opcua_nodeset_map', 'haiwell_opcua_browse_read_write'],
    standards: ['OPC UA Part 6 (IEC 62541)'],
  },
  {
    id: 'recipes',
    title: 'Recipes & Atomic Interlock-Guarded Batch Transfer',
    haiwellModules: ['Recipe Groups & Formulas', 'Pre-Flight E-Stop/Interlock/Range Verification', 'Atomic Download with Rollback Snapshot', 'Live PLC Upload'],
    tools: ['haiwell_recipe_define', 'haiwell_recipe_transfer'],
    standards: ['ISA-88 Batch'],
  },
  {
    id: 'trends',
    title: 'Real-Time & Historical Record Historian',
    haiwellModules: ['History Record Sampling Groups', 'Deadband Compression', 'Local/Cloud/SQL Retention', 'Structured Sample Capture/Query'],
    tools: ['haiwell_trend_configure'],
    standards: ['Historian RBE'],
  },
  {
    id: 'datalink',
    title: 'Data Group, Data-Link SQL, Data Reporting Server & Cloud Monitor',
    haiwellModules: [
      'Data Group Batch Variable Collection',
      'MySQL / SQL Server / PostgreSQL / SQLite Data-Link',
      'Data Reporting Server (HTTP/MQTT/SQL/TCP + Offline SQLite Buffer)',
      'Cloud Platform Data Monitor (Haiwell Cloud / HaiwellLink)',
      'HTTPS ERP/MES/WeCom/DingTalk Webhooks',
    ],
    tools: [
      'haiwell_datagroup_configure',
      'haiwell_datalink_configure',
      'haiwell_data_reporting_server_configure',
      'haiwell_cloud_monitor_configure',
      'haiwell_webhook_configure',
    ],
    standards: ['OWASP Parameterized SQL', 'TLS HTTPS', 'SSRF Hardening'],
  },
  {
    id: 'operations',
    title: 'Schedules, Reports, Peripherals, IP Cameras, Audio & Language Center',
    haiwellModules: [
      'Validated CRON Shift Scheduler',
      'CSV/XLSX/JSON/HTML Compliance Reports',
      'Peripheral Hardware (Printers, Barcode/QR Scanners, USB/SD, 4G Modem)',
      'RTSP/ONVIF/EZVIZ Cameras',
      'Audio Manager (WAV/MP3 & Voice TTS Alarm Playback)',
      'Project Language Center (Multi-Language i18n)',
    ],
    tools: [
      'haiwell_schedule_configure',
      'haiwell_report_configure',
      'haiwell_peripheral_configure',
      'haiwell_camera_bind',
      'haiwell_audio_configure',
      'haiwell_i18n_manage',
    ],
    standards: ['POSIX CRON', 'ONVIF / RTSP', 'BCP 47'],
  },
  {
    id: 'security',
    title: 'User Security, Operation Record, RFID & Haiwell A/B Key Policy',
    haiwellModules: [
      'User Security RBAC (Official Haiwell Permission Levels 1-20, Operation Password, Local/Remote Login Locks, 128/256-bit SSL, A/B Key)',
      'Operation Record (Audit Trail Policy, Filtered Query & CSV Export)',
      'RFID Card Reader & Operator Badge Auto-Login (-R / -RW HMI models, firmware >= 3.37)',
    ],
    tools: ['haiwell_security_policy', 'haiwell_operation_record_configure', 'haiwell_rfid_configure'],
    standards: ['IEC 62443-3-3'],
  },
  {
    id: 'simulation',
    title: 'Headless PLC/SCADA Scan-Cycle Verification Simulator',
    haiwellModules: ['Raw ADC Scaling Injection', 'E-Stop Fail-Safe De-Energization', 'Event Trigger & ISA-18.2 Alarm Step Trace'],
    tools: ['haiwell_simulation_step'],
    standards: ['SIL Pre-Commissioning FAT'],
  },
];

export const HAIWELL_RESOURCES = [
  {
    uri: 'haiwell://capabilities/manifest',
    name: 'Haiwell Cloud SCADA Develop Capability Matrix',
    mimeType: 'application/json',
    description: 'Complete machine-readable index of all 15 Haiwell Cloud SCADA Develop domains and mapped MCP tools.',
  },
  {
    uri: 'haiwell://reference/plc-registers',
    name: 'Haiwell PLC Register & Modbus Address Table',
    mimeType: 'application/json',
    description: 'Exact 0-based/1-based Modbus offsets, hex ranges, function codes, and RO/RW flags for X, Y, M, T, C, S, AI, AQ, V, TV, CV, SV.',
  },
  {
    uri: 'haiwell://reference/iec61131-rules',
    name: 'IEC 61131-3 Safety & Static Analysis Ruleset',
    mimeType: 'application/json',
    description: 'Catalog of all IEC 61131-3 ST/LD/FBD validation codes enforced before PLC/SCADA deployment.',
  },
  {
    uri: 'haiwell://workspace/projects',
    name: 'Workspace Project Index',
    mimeType: 'application/json',
    description: 'Live list of all projects currently in the Haiwell MCP workspace with revision numbers.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/tree',
    name: 'Reference Project Tree',
    mimeType: 'application/json',
    description: 'Complete structured project AST for the seeded reference Haiwell Chiller Plant project.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/opcua-nodeset2',
    name: 'Reference Project OPC UA NodeSet2 XML',
    mimeType: 'application/xml',
    description: 'OPC Foundation Part 6 UANodeSet2 XML generated from the reference project tag database.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/safety-audit',
    name: 'Reference Project Safety Audit Report',
    mimeType: 'application/json',
    description: 'Live pre-deployment safety, interlock, IEC 61131-3, HMI, MQTT, and OPC UA audit findings.',
  },
  {
    uri: 'haiwell://skills/agent-skill-md',
    name: 'Agent SKILL.md Playbook',
    mimeType: 'text/markdown',
    description: 'Drop-in SKILL.md instruction file for Antigravity, Claude Code, Codex, and VS Code agents.',
  },
] as const;

export const HAIWELL_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'haiwell://project/{projectId}/{section}',
    name: 'Dynamic Haiwell Project Artifact',
    mimeType: 'application/json',
    description: 'Read live project artifacts for ANY projectId: section in {tree, opcua-nodeset2, safety-audit, export-bundle, tags-csv}.',
  },
  {
    uriTemplate: 'haiwell://project/{projectId}/screen/{screenId}/svg',
    name: 'Dynamic HMI Screen SVG Blueprint',
    mimeType: 'image/svg+xml',
    description: 'Render deterministic SVG vector blueprint for any screenId inside any projectId.',
  },
] as const;

export function readHaiwellResource(uri: string, store: HaiwellProjectStore): { mimeType: string; text: string } {
  if (uri === 'haiwell://capabilities/manifest') {
    return { mimeType: 'application/json', text: JSON.stringify(HAIWELL_CAPABILITY_MATRIX, null, 2) };
  }
  if (uri === 'haiwell://reference/plc-registers') {
    return { mimeType: 'application/json', text: JSON.stringify(HAIWELL_REGISTER_MAP, null, 2) };
  }
  if (uri === 'haiwell://workspace/projects') {
    return { mimeType: 'application/json', text: JSON.stringify(store.listProjects(), null, 2) };
  }
  if (uri === 'haiwell://reference/iec61131-rules') {
    return {
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          standard: 'IEC 61131-3:2013 (3rd Ed.)',
          rules: [
            { code: 'IEC-SAFE-001', severity: 'ERROR', description: 'Rejects unbounded WHILE/REPEAT loops or loops that never mutate condition vars.' },
            { code: 'IEC-SAFE-002', severity: 'ERROR', description: 'Rejects literal division by zero.' },
            { code: 'IEC-SAFE-003', severity: 'WARNING', description: 'Flags exact = / <> equality comparisons on REAL/LREAL floating-point values.' },
            { code: 'IEC-SAFE-004', severity: 'ERROR', description: 'Blocks writes to physical read-only inputs (%IX / %IW / X / AI).' },
            { code: 'IEC-SAFE-005', severity: 'ERROR', description: 'Blocks mutation of VAR_INPUT parameters inside POU body.' },
            { code: 'IEC-SAFE-006', severity: 'ERROR', description: 'Blocks mutation of CONSTANT declarations.' },
            { code: 'IEC-SAFE-007', severity: 'WARNING', description: 'Flags unguarded division by variable without non-zero check.' },
            { code: 'IEC-SAFE-008', severity: 'WARNING', description: 'Flags CASE state machines missing an ELSE default fault handler.' },
            { code: 'IEC-TYPE-002', severity: 'ERROR', description: 'Blocks implicit narrowing conversions without explicit *_TO_* cast.' },
            { code: 'IEC-LD-003', severity: 'ERROR', description: 'Detects Ladder Diagram double-coil hazards across rungs.' },
            { code: 'IEC-FBD-005', severity: 'ERROR', description: 'Detects combinational feedback cycles (algebraic loops) in FBD networks.' },
          ],
        },
        null,
        2
      ),
    };
  }
  if (uri === 'haiwell://skills/agent-skill-md') {
    return { mimeType: 'text/markdown', text: generateAgentSkillMarkdown('http://localhost:3000/mcp') };
  }

  const screenSvgMatch = /^haiwell:\/\/project\/([a-z0-9_-]+)\/screen\/([a-z0-9_-]+)\/svg$/i.exec(uri);
  if (screenSvgMatch) {
    const [, projectId, screenId] = screenSvgMatch;
    const project = store.getProject(projectId);
    const screen = project.screens.find((s) => s.id === screenId);
    if (!screen) throw new Error(`Screen "${screenId}" not found in project "${projectId}".`);
    return { mimeType: 'image/svg+xml', text: renderScreenToSvg(screen, project.tags) };
  }

  const projectMatch = /^haiwell:\/\/project\/([a-z0-9_-]+)\/([a-z0-9-]+)$/i.exec(uri);
  if (projectMatch) {
    const [, projectId, section] = projectMatch;
    const project = store.getProject(projectId);
    if (section === 'summary') {
      return {
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            id: project.id,
            name: project.name,
            version: project.version,
            revision: project.revision,
            targetHardware: project.targetHardware,
            resolution: project.resolution,
            counts: {
              devices: project.devices.length,
              tags: Object.keys(project.tags).length,
              pous: project.pous.length,
              screens: project.screens.length,
              faceplates: project.faceplates.length,
              scripts: project.scripts.length,
              alarms: project.alarms.length,
              mqttBindings: project.mqtt.bindings.length,
              opcuaNodes: project.opcua.nodes.length,
            },
          },
          null,
          2
        ),
      };
    }
    if (section === 'tree') return { mimeType: 'application/json', text: JSON.stringify(project, null, 2) };
    if (section === 'opcua-nodeset2') return { mimeType: 'application/xml', text: generateOpcUaNodeSet2Xml(project) };
    if (section === 'safety-audit') return { mimeType: 'application/json', text: JSON.stringify(runProjectSafetyAudit(project), null, 2) };
    if (section === 'export-bundle') return { mimeType: 'application/json', text: JSON.stringify(buildProjectExportBundle(project), null, 2) };
    if (section === 'tags-csv') return { mimeType: 'text/csv', text: buildProjectExportBundle(project).artifacts['tags.csv'] };
  }

  throw new Error(`Unknown MCP resource URI: "${uri}".`);
}

export const HAIWELL_PROMPTS = [
  {
    name: 'scaffold_haiwell_scada_project',
    description: 'End-to-end industrial automation workflow: create project, snapshot baseline, add PLC driver, map validated registers, write IEC 61131-3 ST logic, generate ISA-101 HMI, wire MQTT & OPC UA, run FAT simulation, and pass safety audit.',
    arguments: [
      { name: 'plantName', description: 'Target industrial process name (e.g., RO Water Treatment)', required: true },
      { name: 'targetHardware', description: 'PC_SCADA | CLOUD_HMI_C10 | CLOUD_BOX_CBOX', required: false },
    ],
  },
  {
    name: 'validate_and_harden_plc_logic',
    description: 'Audit IEC 61131-3 ST/LD/FBD logic for watchdog loops, unguarded division, float equality, %I/VAR_INPUT writes, and FBD cycles, then transpile to Haiwell JS.',
    arguments: [{ name: 'pouName', description: 'Name of the POU to validate', required: true }],
  },
  {
    name: 'generate_isa101_hmi_screen',
    description: 'Auto-layout a collision-free ISA-101 HMI screen with touch-target verification, optional faceplate expansion, and SVG blueprint verification.',
    arguments: [
      { name: 'projectId', description: 'Haiwell project ID', required: true },
      { name: 'screenTitle', description: 'Operator screen title', required: true },
    ],
  },
  {
    name: 'configure_iiot_mqtt_opcua_bridge',
    description: 'Bind plant tags into TLS Sparkplug B MQTT telemetry and OPC UA Part 6 UANodeSet2 XML with SignAndEncrypt.',
    arguments: [{ name: 'projectId', description: 'Haiwell project ID', required: true }],
  },
  {
    name: 'safe_tag_control_procedure',
    description: 'Two-phase industrial control workflow: snapshot -> read E-Stop/interlocks -> dryRun write -> verify via haiwell_simulation_step -> commit audited write.',
    arguments: [
      { name: 'tagName', description: 'Target writable tag name', required: true },
      { name: 'proposedValue', description: 'Proposed numeric or boolean value', required: true },
    ],
  },
  {
    name: 'pre_commissioning_safety_audit',
    description: 'Run FAT simulation + full safety audit across multi-word register overlaps, SIL2/SIL3 interlocks, IEC 61131-3 POUs, HMI bounds/touch targets, JS scripts, A/B Key, MQTT TLS, and OPC UA encryption.',
    arguments: [{ name: 'projectId', description: 'Haiwell project ID', required: true }],
  },
] as const;

export function buildPromptMessages(name: string, args: Record<string, string | undefined>) {
  const pid = args.projectId ?? 'prj_chiller_plant_01';
  switch (name) {
    case 'scaffold_haiwell_scada_project':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Build a production-grade Haiwell Cloud SCADA project for "${args.plantName ?? 'Industrial Plant'}" on ${args.targetHardware ?? 'PC_SCADA'}. Execute strictly in order:
1. haiwell_project_create -> haiwell_project_snapshot_rollback (CREATE baseline)
2. haiwell_device_add + haiwell_device_validate_address for all registers
3. haiwell_tag_upsert_batch with explicit scaling, safeMin/safeMax, and SIL safetyClass (zero multi-word overlap)
4. haiwell_iec61131_validate -> haiwell_iec61131_pou_save (zero errors required)
5. haiwell_hmi_pid_compile (for P&ID topologies) or haiwell_hmi_screen_generate (ISA_101_HIGH_PERFORMANCE), then haiwell_hmi_spatial_verify (confirm 0px collisions/port gaps) and optionally haiwell_hmi_desktop_bridge_export
6. haiwell_alarm_configure (ISA-18.2 priorities + multi-channel push)
7. haiwell_mqtt_configure + haiwell_mqtt_topic_bind (Sparkplug B + TLS)
8. haiwell_opcua_configure + haiwell_opcua_nodeset_map (Basic256Sha256 + SignAndEncrypt)
9. haiwell_simulation_step (test E-Stop trip & high-temp alarm)
10. haiwell_project_audit_safety -> confirm deploymentReady=true before haiwell_project_export.`,
          },
        },
      ];
    case 'validate_and_harden_plc_logic':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Validate POU "${args.pouName ?? 'Main'}" using haiwell_iec61131_validate. Fix every ERROR and WARNING, persist with haiwell_iec61131_pou_save, and transpile via haiwell_iec61131_transpile_js.`,
          },
        },
      ];
    case 'generate_isa101_hmi_screen':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Query tags in "${pid}" via haiwell_tag_query, inspect components via haiwell_hmi_toolbox_catalog, then compile a zero-collision HMI screen "${args.screenTitle ?? 'Process Overview'}" via haiwell_hmi_pid_compile (for process P&ID flows) or haiwell_hmi_screen_generate. Verify with haiwell_hmi_spatial_verify (0 collisions, 0 out-of-bounds, 0 touchTargetViolations, maxPipePortGapPx<=1), repair if needed via haiwell_hmi_layout_solve, render SVG via haiwell_hmi_screen_render_svg, and export native/UIA build artifacts via haiwell_hmi_desktop_bridge_export.`,
          },
        },
      ];
    case 'configure_iiot_mqtt_opcua_bridge':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `For "${pid}", configure TLS Sparkplug B telemetry with haiwell_mqtt_configure + haiwell_mqtt_topic_bind, publish a loopback frame via haiwell_mqtt_exchange, map all tags into OPC UA via haiwell_opcua_nodeset_map (exportNodeSetXml=true), and verify via haiwell_project_audit_safety.`,
          },
        },
      ];
    case 'safe_tag_control_procedure':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Execute a safe control write to "${args.tagName ?? 'Chiller_Setpoint_C'}" = ${args.proposedValue ?? '8.0'} on "${pid}":
1. Read EStop_OK and target tag via haiwell_tag_batch_io (READ).
2. Execute haiwell_tag_read_write with dryRun=true first to validate binary range, safeMin/safeMax, and interlocks.
3. Only commit with dryRun=false if wouldPassGuards=true with an explicit audit reason.`,
          },
        },
      ];
    default:
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Run haiwell_simulation_step (inject EStop_OK=false) to verify fail-safe de-energization, then run haiwell_project_audit_safety on "${pid}" and confirm deploymentReady=true.`,
          },
        },
      ];
  }
}

export function generateAgentSkillMarkdown(mcpEndpointUrl: string): string {
  return `---
name: haiwell-cloud-scada-develop
description: Zero-UI, production-grade headless MCP server for Haiwell Cloud SCADA Develop. Covers 15 industrial automation domains across ${HAIWELL_TOOLS.length} strictly validated tools for VS Code, Google Antigravity, Claude Code, and Codex.
mcp_endpoint: ${mcpEndpointUrl}
transports: [streamable-http, stdio]
---

# Haiwell Cloud SCADA Develop — Headless MCP Agent Skill

## Mandatory Safety & Reliability Protocol
1. **Snapshot before bulk edits**: call \`haiwell_project_snapshot_rollback\` (\`CREATE\`) before mutating tags, logic, or screens; roll back immediately if audit fails.
2. **Validate multi-vendor PLC addresses**: call \`haiwell_device_validate_address\` with the device protocol (Haiwell, Modbus, Siemens S7, Mitsubishi MC, Omron FINS, Allen-Bradley EIP, BACnet) before creating tags. Never overlap 32-bit/64-bit multi-word register spans.
3. **Dry-run control writes**: invoke \`haiwell_tag_read_write\` or \`haiwell_tag_batch_io\` with \`dryRun: true\` before committing live writes.
4. **Gate PLC logic on IEC 61131-3 validation**: resolve all \`ERROR\` diagnostics from \`haiwell_iec61131_validate\` before \`haiwell_iec61131_pou_save\`.
5. **Compile HMI spatially (never blind drag-and-drop)**: use \`haiwell_hmi_pid_compile\` / \`haiwell_hmi_screen_generate\`, verify with \`haiwell_hmi_spatial_verify\`, auto-repair with \`haiwell_hmi_layout_solve\`, calibrate live WinForms selectors once via \`haiwell_desktop_uia_calibrate\`, and export calibrated UIA plans with \`haiwell_hmi_desktop_bridge_export\` (plus native \`haiwell_variables_import.csv\` via \`haiwell_project_export\`).
6. **Run FAT simulation + safety audit**: run \`haiwell_simulation_step\` (E-Stop trip test) and \`haiwell_project_audit_safety\` (\`deploymentReady: true\`) before \`haiwell_project_export\`.

## Complete Tool Index (${HAIWELL_TOOLS.length} Tools across 15 Domains)
${HAIWELL_CAPABILITY_MATRIX.map(
  (d) => `- **${d.title}**: ${d.tools.map((t) => `\`${t}\``).join(', ')}`
).join('\n')}`;
}

export function generateClientConfigs(baseUrl: string) {
  const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
  const repoDir = process.cwd();
  const stdioEntryPath = path.resolve(repoDir, 'src/mcp/stdio.ts');
  return {
    vscode: {
      client: 'VS Code (GitHub Copilot / MCP)',
      filename: '.vscode/mcp.json',
      transport: 'Streamable HTTP or local stdio',
      config: JSON.stringify(
        {
          servers: {
            'haiwell-cloud-scada': { type: 'http', url: mcpUrl },
            'haiwell-cloud-scada-local': {
              type: 'stdio',
              command: 'npx',
              args: ['tsx', stdioEntryPath],
              cwd: repoDir,
            },
          },
        },
        null,
        2
      ),
    },
    antigravity: {
      client: 'Google Antigravity',
      filename: '~/.gemini/antigravity/mcp_config.json',
      transport: 'Streamable HTTP + SKILL.md',
      config: JSON.stringify(
        {
          mcpServers: {
            'haiwell-cloud-scada': { serverUrl: mcpUrl, transport: 'streamable-http' },
            'haiwell-cloud-scada-stdio': {
              command: 'npx',
              args: ['tsx', stdioEntryPath],
              cwd: repoDir,
            },
          },
        },
        null,
        2
      ),
    },
    'claude-code': {
      client: 'Claude Code',
      filename: '.mcp.json',
      cliCommand: `claude mcp add --transport http haiwell-cloud-scada ${mcpUrl}`,
      transport: 'Streamable HTTP or stdio',
      config: JSON.stringify(
        {
          mcpServers: {
            'haiwell-cloud-scada': { type: 'http', url: mcpUrl },
            'haiwell-cloud-scada-local': {
              type: 'stdio',
              command: 'npx',
              args: ['tsx', stdioEntryPath],
              cwd: repoDir,
            },
          },
        },
        null,
        2
      ),
    },
    codex: {
      client: 'OpenAI Codex CLI',
      filename: '~/.codex/config.toml',
      transport: 'Streamable HTTP or stdio',
      config: `[mcp_servers.haiwell_cloud_scada]\nurl = "${mcpUrl}"\n\n[mcp_servers.haiwell_cloud_scada_local]\ncommand = "npx"\nargs = ["tsx", ${JSON.stringify(stdioEntryPath)}]\ncwd = ${JSON.stringify(repoDir)}\n`,
    },
  };
}

export function generateLlmsTxt(baseUrl: string): string {
  const clean = baseUrl.replace(/\/$/, '');
  return `# Haiwell Cloud SCADA Develop MCP Server (100% Headless — Zero UI)

> Production-grade, machine-readable Model Context Protocol (MCP 2025-03-26) server exposing all 15 functional domains of Haiwell Cloud SCADA Develop with strict IEC 61131-3 validation, multi-vendor PLC register/overlap checks, ISA-101 HMI auto-layout, MQTT Sparkplug B, OPC UA NodeSet2 XML, and headless FAT simulation.

## Endpoints
- Server Discovery JSON: GET ${clean}/
- MCP Streamable HTTP (JSON-RPC 2.0): POST ${clean}/mcp
- Local MCP stdio: npx tsx src/mcp/stdio.ts
- Direct Batch Tool RPC: POST ${clean}/api/rpc
- Machine-Readable Manifest: GET ${clean}/api/manifest
- OpenAPI 3.1 Specification: GET ${clean}/openapi.json
- Agent SKILL.md: GET ${clean}/api/skills/skill.md
- IDE Client Configs: GET ${clean}/api/skills/{vscode|antigravity|claude-code|codex}
- Health Probe: GET ${clean}/api/health

## Capabilities (${HAIWELL_TOOLS.length} Tools)
${HAIWELL_TOOLS.map((t) => `- ${t.name} [${t.domain} | ${t.safetyTier}]: ${t.description}`).join('\n')}

## Static MCP Resources (${HAIWELL_RESOURCES.length})
${HAIWELL_RESOURCES.map((r) => `- ${r.uri}: ${r.description}`).join('\n')}

## Dynamic Resource Templates (${HAIWELL_RESOURCE_TEMPLATES.length})
${HAIWELL_RESOURCE_TEMPLATES.map((t) => `- ${t.uriTemplate}: ${t.description}`).join('\n')}
`;
}
