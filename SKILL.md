---
name: haiwell-cloud-scada-develop
description: Zero-UI, production-grade headless Model Context Protocol (MCP 2025-03-26) server for Haiwell Cloud SCADA Develop. Exposes 47 strictly validated tools across 15 domains for AI agents in VS Code, Google Antigravity, Claude Code, and Codex.
transports:
  - streamable-http: POST http://localhost:3000/mcp
  - stdio: npx tsx src/mcp/stdio.ts
---

# Haiwell Cloud SCADA Develop — Headless MCP Agent Skill

## Endpoints (100% Headless — Zero UI)
- `GET /` — Machine-readable JSON server discovery
- `POST /mcp` — MCP 2025-03-26 Streamable HTTP (JSON-RPC 2.0)
- `npx tsx src/mcp/stdio.ts` — Local stdio MCP subprocess transport
- `POST /api/rpc` — Direct single or sequential batch tool invocation
- `GET /llms.txt` | `GET /openapi.json` | `GET /api/manifest` | `GET /api/skills/{vscode|antigravity|claude-code|codex}`

## Mandatory Safety & Reliability Protocol
1. **Checkpoint before bulk edits**: call `haiwell_project_snapshot_rollback` (`CREATE`) before multi-step mutations; use `ROLLBACK` if audit fails.
2. **Validate multi-vendor PLC addresses**: call `haiwell_device_validate_address` with the target device's protocol (Haiwell, Modbus, Siemens S7, Mitsubishi MC, Omron FINS, Allen-Bradley EIP, BACnet) before creating tags. Never overlap 32-bit/64-bit register word spans.
3. **Dry-run physical control writes**: call `haiwell_tag_read_write` or `haiwell_tag_batch_io` with `dryRun: true` first. Interlocked `SIL2`/`SIL3` outputs require `confirmSafetyOverride: true` and an audit `reason`.
4. **Gate PLC logic on IEC 61131-3 validation**: resolve all `ERROR` diagnostics from `haiwell_iec61131_validate` before `haiwell_iec61131_pou_save`.
5. **Never drag-and-drop raw HMI pixels**: inspect `haiwell_hmi_toolbox_catalog`, compile process layouts via `haiwell_hmi_pid_compile` or `haiwell_hmi_screen_generate`, auto-repair edits via `haiwell_hmi_layout_solve`, verify `valid: true` + ASCII map via `haiwell_hmi_spatial_verify`, and export native manifest + closed-loop Windows UIA Property-Grid script via `haiwell_hmi_desktop_bridge_export`.
6. **Run FAT simulation + safety audit**: run `haiwell_simulation_step` (verify E-Stop fail-safe de-energization) and `haiwell_project_audit_safety` (`deploymentReady: true`) before `haiwell_project_export`.
