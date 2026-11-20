/**
 * MCP Resources, Reusable Agent Skill Prompts, Complete Capability Index,
 * and Ready-to-Use IDE/Agent Config Generators for:
 * - VS Code (.vscode/mcp.json)
 * - Google Antigravity (mcp_config.json + SKILL.md)
 * - Claude Code (.mcp.json + CLI command)
 * - OpenAI Codex (~/.codex/config.toml)
 */

import { HAIWELL_REGISTER_MAP } from './haiwellRegisters';
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
    title: 'Project Lifecycle, Tree & Safety Audit',
    haiwellModules: ['New Project Wizard (PC/C7/C10/B7/B10/A8/CBOX/IPC)', 'Project Tree Browser', 'Pre-Deploy Integrity Audit', 'Full Bundle Export'],
    tools: ['haiwell_project_create', 'haiwell_project_inspect', 'haiwell_project_audit_safety', 'haiwell_project_export'],
    standards: ['ISA-95', 'IEC 62443'],
  },
  {
    id: 'devices',
    title: 'PLC Drivers, Register Map & Cloud Transparent Tunnel',
    haiwellModules: ['Haiwell PLC TCP/RTU', 'Modbus TCP/RTU', 'Siemens S7 / Mitsubishi / Omron / AB / BACnet', 'Cloud Transparent Transmission (CBOX)'],
    tools: ['haiwell_device_add', 'haiwell_device_validate_address', 'haiwell_cloud_transparent_tunnel'],
    standards: ['Modbus RTU/TCP', 'Haiwell Protocol'],
  },
  {
    id: 'tags',
    title: 'Variable / Tag Database & Guarded Telemetry I/O',
    haiwellModules: ['Unlimited Tag Database', 'Linear Scaling & Deadband', 'SIL0-SIL3 Write Interlocks', 'E-Stop Write Guard'],
    tools: ['haiwell_tag_upsert_batch', 'haiwell_tag_query', 'haiwell_tag_read_write'],
    standards: ['IEC 61508 (SIL)', 'OPC Quality Codes'],
  },
  {
    id: 'iec61131',
    title: 'IEC 61131-3 PLC Logic Validation & JS Transpilation',
    haiwellModules: ['Structured Text (ST) Analyzer', 'Ladder Diagram (LD) Double-Coil Checker', 'FBD Network Verifier', 'ST-to-Haiwell-JS Transpiler'],
    tools: ['haiwell_iec61131_validate', 'haiwell_iec61131_pou_save', 'haiwell_iec61131_transpile_js'],
    standards: ['IEC 61131-3:2013 (3rd Ed.)'],
  },
  {
    id: 'hmi',
    title: 'Automated HMI Screen & ISA-101 Layout Generation',
    haiwellModules: ['Unified PC/Web/Mobile Screen Designer', 'Collision-Free Grid Auto-Layout', 'P&ID & Control Widgets', 'Deterministic SVG Export'],
    tools: ['haiwell_hmi_screen_generate', 'haiwell_hmi_widget_upsert', 'haiwell_hmi_screen_render_svg'],
    standards: ['ANSI/ISA-101.01'],
  },
  {
    id: 'scripts',
    title: 'Haiwell JavaScript Command Engine',
    haiwellModules: ['Startup/Shutdown/Cyclic/Tag-Change JS Scripts', 'Tag.Read/Tag.Write Cross-Reference', 'Watchdog Loop Protection'],
    tools: ['haiwell_script_validate', 'haiwell_script_upsert'],
    standards: ['ECMAScript Sandbox'],
  },
  {
    id: 'alarms',
    title: 'Alarms & Multi-Channel Cloud Push Notifications',
    haiwellModules: ['HIHI/HI/LO/LOLO/ROC/DEV/Digital Alarms', 'Screen Pop-up, Voice TTS, Mobile App, WeChat, SMS, Email', 'Alarm Ack Audit Trail'],
    tools: ['haiwell_alarm_configure', 'haiwell_alarm_manage'],
    standards: ['ANSI/ISA-18.2'],
  },
  {
    id: 'mqtt',
    title: 'MQTT Broker, Sparkplug B & Haiwell Cloud IoT',
    haiwellModules: ['Built-in MQTT Server & Proxy', 'Haiwell Cloud Data Center', 'Sparkplug B / JSON Topic Bindings', 'Broker Probe & Loopback'],
    tools: ['haiwell_mqtt_configure', 'haiwell_mqtt_topic_bind', 'haiwell_mqtt_exchange'],
    standards: ['MQTT 3.1.1 / 5.0', 'Eclipse Sparkplug B'],
  },
  {
    id: 'opcua',
    title: 'OPC UA Server/Client & NodeSet2 XML',
    haiwellModules: ['OPC UA Endpoint & Security Policies', 'AddressSpace Node Mapping', 'UANodeSet2 XML Export', 'Browse/Read/Write'],
    tools: ['haiwell_opcua_configure', 'haiwell_opcua_nodeset_map', 'haiwell_opcua_browse_read_write'],
    standards: ['OPC UA Part 6 (IEC 62541)'],
  },
  {
    id: 'recipes',
    title: 'Recipes & Atomic Batch Formulation Transfer',
    haiwellModules: ['Recipe Parameter Groups', 'Pre-Flight Bounds Validation', 'Atomic Download with Rollback Snapshot', 'Live PLC Upload'],
    tools: ['haiwell_recipe_define', 'haiwell_recipe_transfer'],
    standards: ['ISA-88 Batch'],
  },
  {
    id: 'trends',
    title: 'Real-Time & Historical Trend Historian',
    haiwellModules: ['Sampling Groups', 'Deadband Compression', 'Local/Cloud/SQL Retention', 'Structured Time-Series Capture'],
    tools: ['haiwell_trend_configure'],
    standards: ['Historian RBE'],
  },
  {
    id: 'datalink',
    title: 'Haiwell Data-Link Enterprise Database Connectors',
    haiwellModules: ['MySQL / SQL Server / PostgreSQL / SQLite', 'ERP/MES Table Mapping', 'Parameterized SQL Generation'],
    tools: ['haiwell_datalink_configure'],
    standards: ['OWASP Parameterized SQL'],
  },
  {
    id: 'operations',
    title: 'Schedules, Reports, IP Cameras & Multi-Language',
    haiwellModules: ['CRON Shift Scheduler', 'CSV/XLSX/JSON/HTML Compliance Reports', 'RTSP/ONVIF/EZVIZ Camera Feeds', 'Multi-Language i18n'],
    tools: ['haiwell_schedule_configure', 'haiwell_report_configure', 'haiwell_camera_bind', 'haiwell_i18n_manage'],
    standards: ['ONVIF / RTSP', 'BCP 47'],
  },
  {
    id: 'security',
    title: 'RBAC User Groups, SSL & Haiwell A/B Key Policy',
    haiwellModules: ['Privilege Levels 0-15', '128/256-bit SSL Enforcement', 'Haiwell A/B Key Cloud Auth', 'Immutable Control Audit Log'],
    tools: ['haiwell_security_policy'],
    standards: ['IEC 62443-3-3'],
  },
];

export const HAIWELL_RESOURCES = [
  {
    uri: 'haiwell://capabilities/manifest',
    name: 'Haiwell Cloud SCADA Develop Capability Matrix',
    mimeType: 'application/json',
    description: 'Complete machine-readable index of all 14 Haiwell Cloud SCADA Develop domains and mapped MCP tools.',
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
    uri: 'haiwell://project/prj_chiller_plant_01/tree',
    name: 'Active Reference Project Tree',
    mimeType: 'application/json',
    description: 'Complete structured project AST for the seeded reference Haiwell Chiller Plant project.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/opcua-nodeset2',
    name: 'Active Project OPC UA NodeSet2 XML',
    mimeType: 'application/xml',
    description: 'OPC Foundation Part 6 UANodeSet2 XML generated from the active project tag database.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/safety-audit',
    name: 'Active Project Safety Audit Report',
    mimeType: 'application/json',
    description: 'Live pre-deployment safety, interlock, IEC 61131-3, HMI, MQTT, and OPC UA audit findings.',
  },
  {
    uri: 'haiwell://project/prj_chiller_plant_01/export-bundle',
    name: 'Active Project Complete Export Bundle',
    mimeType: 'application/json',
    description: 'All exportable artifacts (hwsp JSON, tags CSV, SVG screens, ST POUs, JS scripts, OPC UA XML, MQTT bindings).',
  },
  {
    uri: 'haiwell://skills/agent-skill-md',
    name: 'Agent SKILL.md Playbook',
    mimeType: 'text/markdown',
    description: 'Drop-in SKILL.md instruction file for Antigravity, Claude Code, Codex, and VS Code agents.',
  },
] as const;

export function readHaiwellResource(uri: string, store: HaiwellProjectStore): { mimeType: string; text: string } {
  if (uri === 'haiwell://capabilities/manifest') {
    return { mimeType: 'application/json', text: JSON.stringify(HAIWELL_CAPABILITY_MATRIX, null, 2) };
  }
  if (uri === 'haiwell://reference/plc-registers') {
    return { mimeType: 'application/json', text: JSON.stringify(HAIWELL_REGISTER_MAP, null, 2) };
  }
  if (uri === 'haiwell://reference/iec61131-rules') {
    return {
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          standard: 'IEC 61131-3:2013 (3rd Ed.)',
          rules: [
            { code: 'IEC-SAFE-001', severity: 'ERROR', description: 'Rejects unbounded WHILE TRUE loops that trigger PLC watchdog faults.' },
            { code: 'IEC-SAFE-002', severity: 'ERROR', description: 'Rejects literal division by zero.' },
            { code: 'IEC-SAFE-003', severity: 'WARNING', description: 'Flags exact = / <> equality comparisons on REAL/LREAL floating-point values.' },
            { code: 'IEC-SAFE-004', severity: 'ERROR', description: 'Blocks writes to physical read-only inputs (%IX / %IW / X / AI).' },
            { code: 'IEC-SAFE-005', severity: 'ERROR', description: 'Blocks mutation of VAR_INPUT parameters inside POU body.' },
            { code: 'IEC-SAFE-006', severity: 'ERROR', description: 'Blocks mutation of CONSTANT declarations.' },
            { code: 'IEC-TYPE-002', severity: 'ERROR', description: 'Blocks implicit narrowing conversions (e.g., REAL->INT, DINT->INT) without explicit *_TO_* cast.' },
            { code: 'IEC-LD-003', severity: 'ERROR', description: 'Detects Ladder Diagram double-coil hazards across rungs.' },
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

  const projectMatch = /^haiwell:\/\/project\/([a-z0-9_-]+)\/([a-z0-9-]+)$/i.exec(uri);
  if (projectMatch) {
    const [, projectId, section] = projectMatch;
    const project = store.getProject(projectId);
    if (section === 'tree') {
      return { mimeType: 'application/json', text: JSON.stringify(project, null, 2) };
    }
    if (section === 'opcua-nodeset2') {
      return { mimeType: 'application/xml', text: generateOpcUaNodeSet2Xml(project) };
    }
    if (section === 'safety-audit') {
      return { mimeType: 'application/json', text: JSON.stringify(runProjectSafetyAudit(project), null, 2) };
    }
    if (section === 'export-bundle') {
      return { mimeType: 'application/json', text: JSON.stringify(buildProjectExportBundle(project), null, 2) };
    }
  }

  throw new Error(`Unknown MCP resource URI: "${uri}".`);
}

export const HAIWELL_PROMPTS = [
  {
    name: 'scaffold_haiwell_scada_project',
    description: 'End-to-end industrial automation workflow: create project, add PLC driver, map validated Haiwell registers, write IEC 61131-3 ST logic, generate ISA-101 HMI, wire MQTT & OPC UA, and run safety audit.',
    arguments: [
      { name: 'plantName', description: 'Target industrial process name (e.g., RO Water Treatment)', required: true },
      { name: 'targetHardware', description: 'PC_SCADA | CLOUD_HMI_C10 | CLOUD_BOX_CBOX', required: false },
    ],
  },
  {
    name: 'validate_and_harden_plc_logic',
    description: 'Audit IEC 61131-3 Structured Text / Ladder logic for watchdog hazards, float precision bugs, read-only input writes, and transpile to safe Haiwell JavaScript.',
    arguments: [{ name: 'pouName', description: 'Name of the POU to validate', required: true }],
  },
  {
    name: 'generate_isa101_hmi_screen',
    description: 'Automatically lay out a collision-free ISA-101 High-Performance HMI screen from existing project tags and render an SVG verification blueprint.',
    arguments: [
      { name: 'projectId', description: 'Haiwell project ID', required: true },
      { name: 'screenTitle', description: 'Operator screen title', required: true },
    ],
  },
  {
    name: 'configure_iiot_mqtt_opcua_bridge',
    description: 'Bind plant tags into Eclipse Sparkplug B MQTT telemetry and OPC UA Part 6 UANodeSet2 XML with TLS + SignAndEncrypt.',
    arguments: [{ name: 'projectId', description: 'Haiwell project ID', required: true }],
  },
  {
    name: 'safe_tag_control_procedure',
    description: 'Two-phase industrial control workflow: inspect E-Stop/interlocks -> run dryRun write -> verify alarm response -> commit audited write.',
    arguments: [
      { name: 'tagName', description: 'Target writable tag name', required: true },
      { name: 'proposedValue', description: 'Proposed numeric or boolean value', required: true },
    ],
  },
  {
    name: 'pre_commissioning_safety_audit',
    description: 'Run full pre-commissioning check across register collisions, SIL2/SIL3 interlocks, IEC 61131-3 POUs, HMI bounds, JS scripts, A/B Key, MQTT TLS, and OPC UA encryption.',
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
1. haiwell_project_create
2. haiwell_device_add + haiwell_device_validate_address for all Haiwell X/Y/M/AI/AQ/V registers
3. haiwell_tag_upsert_batch with explicit safeMin/safeMax and SIL safetyClass
4. haiwell_iec61131_validate -> haiwell_iec61131_pou_save (zero errors required)
5. haiwell_hmi_screen_generate (ISA_101_HIGH_PERFORMANCE, zero collisions)
6. haiwell_alarm_configure (ISA-18.2 priorities + multi-channel push)
7. haiwell_mqtt_configure + haiwell_mqtt_topic_bind (Sparkplug B + TLS)
8. haiwell_opcua_configure + haiwell_opcua_nodeset_map (Basic256Sha256 + SignAndEncrypt)
9. haiwell_project_audit_safety -> resolve all CRITICAL/HIGH findings before export.`,
          },
        },
      ];
    case 'validate_and_harden_plc_logic':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Validate POU "${args.pouName ?? 'Main'}" using haiwell_iec61131_validate. Fix every ERROR and WARNING (watchdog loops, float equality, narrowing conversions, %I/VAR_INPUT writes), then persist with haiwell_iec61131_pou_save and transpile with haiwell_iec61131_transpile_js.`,
          },
        },
      ];
    case 'generate_isa101_hmi_screen':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Query tags in project "${pid}" via haiwell_tag_query, generate an ISA-101 High-Performance HMI screen titled "${args.screenTitle ?? 'Process Overview'}" via haiwell_hmi_screen_generate, verify 0 collisions and 0 unresolved tags, and output the blueprint via haiwell_hmi_screen_render_svg.`,
          },
        },
      ];
    case 'configure_iiot_mqtt_opcua_bridge':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `For project "${pid}", inspect tags with haiwell_tag_query, configure TLS Sparkplug B telemetry with haiwell_mqtt_configure + haiwell_mqtt_topic_bind, publish a test frame via haiwell_mqtt_exchange, map all tags into OPC UA via haiwell_opcua_nodeset_map (exportNodeSetXml=true), and verify security with haiwell_project_audit_safety.`,
          },
        },
      ];
    case 'safe_tag_control_procedure':
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Execute a safe control write to "${args.tagName ?? 'Chiller_Setpoint_C'}" = ${args.proposedValue ?? '8.0'} on project "${pid}":
1. Read EStop_OK and "${args.tagName ?? 'Chiller_Setpoint_C'}" via haiwell_tag_read_write (READ).
2. Execute haiwell_tag_read_write with dryRun=true first to validate engineering bounds and interlocks.
3. Only commit with dryRun=false if wouldPassGuards=true and provide an explicit audit reason.`,
          },
        },
      ];
    default:
      return [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Run haiwell_project_audit_safety on project "${pid}", summarize all findings by severity, propose exact tool calls to remediate every CRITICAL and HIGH finding, and confirm deploymentReady=true.`,
          },
        },
      ];
  }
}

export function generateAgentSkillMarkdown(mcpEndpointUrl: string): string {
  return `---
name: haiwell-cloud-scada-develop
description: Production-grade headless MCP skill for Haiwell Cloud SCADA Develop. Enables AI agents to engineer PLC drivers, validate IEC 61131-3 ST/LD/FBD logic, auto-generate ISA-101 HMI layouts, manage tags/alarms/recipes/trends/Data-Link/schedules/reports/cameras/i18n/RBAC, and integrate MQTT Sparkplug B and OPC UA NodeSet2 XML.
mcp_endpoint: ${mcpEndpointUrl}
transports: [streamable-http, stdio]
---

# Haiwell Cloud SCADA Develop — Agent Skill Playbook

## Safety Invariants (Mandatory)
1. **Never write to read-only hardware registers** (\`X0..X1023\`, \`AI0..AI255\`, \`%IX\`, \`%IW\`). Validate every PLC address with \`haiwell_device_validate_address\` before creating tags.
2. **Always dry-run control writes first**: invoke \`haiwell_tag_read_write\` with \`dryRun: true\` before committing physical output or setpoint mutations.
3. **Never deploy unvalidated PLC logic**: run \`haiwell_iec61131_validate\` and resolve all \`ERROR\` diagnostics (watchdog loops, division by zero, float equality, implicit narrowing, double-coil hazards) before \`haiwell_iec61131_pou_save\`.
4. **Always enforce IIoT transport security**: MQTT remote writes require \`tlsEnabled: true\`; OPC UA requires \`Basic256Sha256\` + \`SignAndEncrypt\`; Cloud Transparent Transmission requires Haiwell \`abKeyRequired: true\`.
5. **Run \`haiwell_project_audit_safety\`** before exporting any project bundle via \`haiwell_project_export\`.

## Complete Tool Index (${HAIWELL_TOOLS.length} Tools across 14 Domains)
${HAIWELL_CAPABILITY_MATRIX.map(
  (d) => `- **${d.title}**: ${d.tools.map((t) => `\`${t}\``).join(', ')}`
).join('\n')}
`;
}

export function generateClientConfigs(baseUrl: string) {
  const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
  return {
    vscode: {
      client: 'VS Code (GitHub Copilot / MCP)',
      filename: '.vscode/mcp.json',
      transport: 'Streamable HTTP or local stdio',
      config: JSON.stringify(
        {
          servers: {
            'haiwell-cloud-scada': {
              type: 'http',
              url: mcpUrl,
            },
            'haiwell-cloud-scada-local': {
              type: 'stdio',
              command: 'npx',
              args: ['tsx', 'src/mcp/stdio.ts'],
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
            'haiwell-cloud-scada': {
              serverUrl: mcpUrl,
              transport: 'streamable-http',
            },
            'haiwell-cloud-scada-stdio': {
              command: 'npx',
              args: ['tsx', 'src/mcp/stdio.ts'],
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
            'haiwell-cloud-scada': {
              type: 'http',
              url: mcpUrl,
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
      config: `[mcp_servers.haiwell_cloud_scada]\nurl = "${mcpUrl}"\n\n[mcp_servers.haiwell_cloud_scada_local]\ncommand = "npx"\nargs = ["tsx", "src/mcp/stdio.ts"]\n`,
    },
  };
}

export function generateLlmsTxt(baseUrl: string): string {
  const clean = baseUrl.replace(/\/$/, '');
  return `# Haiwell Cloud SCADA Develop MCP Server

> Headless, machine-readable Model Context Protocol (MCP) server exposing all 14 functional domains of Haiwell Cloud SCADA Develop with strict IEC 61131-3 validation, ISA-101 HMI auto-layout, and MQTT/OPC UA protocol adapters.

## Endpoints
- MCP Streamable HTTP (JSON-RPC 2.0): POST ${clean}/mcp
- Direct Low-Latency Tool RPC: POST ${clean}/api/rpc
- Machine-Readable Manifest: GET ${clean}/api/manifest
- OpenAPI 3.1 Specification: GET ${clean}/openapi.json
- Agent SKILL.md: GET ${clean}/api/skills/skill.md
- IDE Client Configs: GET ${clean}/api/skills/{vscode|antigravity|claude-code|codex}
- Health Probe: GET ${clean}/api/health

## Capabilities (${HAIWELL_TOOLS.length} Tools)
${HAIWELL_TOOLS.map((t) => `- ${t.name} [${t.domain} | ${t.safetyTier}]: ${t.description}`).join('\n')}

## MCP Resources (${HAIWELL_RESOURCES.length})
${HAIWELL_RESOURCES.map((r) => `- ${r.uri}: ${r.description}`).join('\n')}
`;
}
