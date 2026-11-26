---
name: haiwell-cloud-scada-develop
version: 2.9.0
description: Zero-UI, production-grade headless Model Context Protocol (MCP 2025-03-26) server (v2.9.0) for Haiwell Cloud SCADA Develop. Exposes 65 strictly validated tools across 15 domains for AI agents in VS Code, Google Antigravity, Claude Code, and Codex.
transports:
  - streamable-http: POST http://localhost:3000/mcp
  - stdio: npx tsx src/mcp/stdio.ts
---

# Haiwell Cloud SCADA Develop — Headless MCP Agent Skill (v2.8.0)

## Endpoints (100% Headless — Zero UI)
- `GET /` — Machine-readable JSON server discovery
- `POST /mcp` — MCP 2025-03-26 Streamable HTTP (JSON-RPC 2.0)
- `npx tsx src/mcp/stdio.ts` — Local stdio MCP subprocess transport
- `POST /api/rpc` — Direct single or sequential batch tool invocation (supports `?profile=core|hmi|iiot|plc|full`)
- `GET /llms.txt` | `GET /openapi.json` | `GET /api/manifest` | `GET /api/skills/{vscode|antigravity|claude-code|codex}`

## Mandatory Safety & Reliability Protocol
1. **Checkpoint before bulk edits**: call `haiwell_project_snapshot_rollback` (`CREATE`) before multi-step mutations; use `ROLLBACK` if audit fails.
2. **Validate multi-vendor PLC addresses**: call `haiwell_device_validate_address` with the target device's protocol and `addressOffset` (Haiwell, Modbus, Siemens S7, Mitsubishi MC, Omron FINS, Allen-Bradley EIP, BACnet) before creating tags. Never overlap 32-bit/64-bit register word spans.
3. **Dry-run physical control writes & recipes**: call `haiwell_tag_read_write` or `haiwell_tag_batch_io` with `dryRun: true` first, and use `action: "DOWNLOAD_RECIPE"` in `haiwell_recipe_transfer` (`dryRun: true` first). Physical PLC outputs and interlocked `SIL2`/`SIL3` outputs require `confirmSafetyOverride: true` and an audit `reason`.
4. **Gate PLC logic & Haiwell JS on validation**: resolve all `ERROR` diagnostics from `haiwell_iec61131_validate` before `haiwell_iec61131_pou_save`. Author Strict-ES5 Haiwell scripts using native `Variable.GetByFullName` / `Variable.SetByFullName` and validate via `haiwell_script_validate`.
5. **Never drag-and-drop raw HMI pixels**: inspect `haiwell_hmi_toolbox_catalog`, instantiate zero-collision screens via `haiwell_hmi_template_instantiate` / `haiwell_hmi_pid_compile` / `haiwell_hmi_screen_generate`, auto-repair edits via `haiwell_hmi_layout_solve`, verify `valid: true` (0 collisions, 0 port gaps, 0 pipe-widget crossings) + ASCII map via `haiwell_hmi_spatial_verify`, and deploy directly into `.hwdev` with **zero GUI / zero UAC / zero Python** via `haiwell_desktop_deploy_hwexport` (uses Haiwell 3.50.x official 32-bit `.NET` headless APIs with automatic `.hwdev.bak` backup & rollback). For CSV/legacy workflows, `haiwell_project_export`, `haiwell_project_export_hwexport`, `haiwell_desktop_uia_calibrate`, and `haiwell_open_project_bridge_export` remain available.
6. **Run FAT simulation + safety audit**: run `haiwell_simulation_step` (verify E-Stop fail-safe de-energization and alarm delays) and `haiwell_project_audit_safety` (`deploymentReady: true`) before `haiwell_project_export`.

## Physical Haiwell B7H HMI & `.hwExport` Hardware Invariants (Field-Verified)
1. **Linux B7H `TxtBlock` White-Bar Trap**: The physical Haiwell B7H Linux runtime ignores `fill-opacity="0"` on `<textBlock>` and renders an opaque rectangle using `fill` / `HWBackColor`. Always emit `fill="none"` for transparent labels and match `HWBackColor` to the underlying dark button or header color so white text never renders as a solid white bar on hardware.
2. **Inverted (Active-Low) PLC Inputs (`invertDisplay: true` → `RvrsSt="true"`)**: When PNP field sensors are wired to NPN-sinking PLCs (such as FX3U clones), digital inputs `X0..X7` read `0` when physically triggered and `1` when idle. Set `invertDisplay: true` on `BIT_LAMP` input bindings (emits native `RvrsSt="true"` so green = physically active) and evaluate `raw === 0` in background JS alarm rules, while keeping `Y` outputs and active-high PLCs (e.g., Delta DVP) normal (`1` = active).
3. **`Always collect` for Background JS Scripts**: Haiwell skips polling PLC tags with `CollectionAlwaysEnabled = 0` when no screen showing them is open. Pass `enableAlwaysCollectFullNames` (exact names or `Device.*` wildcards) to `haiwell_desktop_deploy_hwexport` so background alarm/logger scripts always read live I/O and `_commStatus` from any page.
4. **Zero-Error / Zero-Warning `.hwExport` Compilation**:
   - `BOOL` internal variable `<InitValue>` must be `"0"` or `"1"` (never `"true"`/`"false"`).
   - `NumShowIput` must include `MaxValConvert` > `MinValConvert` AND `ThldMaxNum="80" ThldMinNum="20"` (even when `ThldEnbl="false"`), otherwise Haiwell emits `【Upper limit】not less than or equal to【Lower limit】`.
   - Editable `STRING` inputs (`TxtShowIput`) require `IsIput="true"` and `WrtVar`/`WrtVar-id`.
   - Deleting and re-importing Window 1 (`Main_display`) changes its DB `ID`; `deployHwExportHeadless` auto-heals `project.StartWindowId` (and supports `startupWindowId`, `replaceExistingVariableGroups`, and in-place `upsertTasks` that preserve `APP_START` / `VAR_CHANGE` event triggers).
