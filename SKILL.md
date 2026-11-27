---
name: haiwell-cloud-scada-develop
version: 2.12.0
description: Headless Model Context Protocol (MCP 2025-03-26) server (v2.12.0) for Haiwell Cloud SCADA Develop. Exposes 66 strictly validated tools across 15 domains for AI agents in VS Code, Google Antigravity, Claude Code, and Codex.
transports:
  - streamable-http: POST http://localhost:3000/mcp
  - stdio: npx tsx src/mcp/stdio.ts
---

# Haiwell Cloud SCADA Develop — Headless MCP Agent Skill (v2.12.0)

## Endpoints (Headless — Zero UI)
- `GET /` — Machine-readable JSON server discovery
- `POST /mcp` — MCP 2025-03-26 Streamable HTTP (JSON-RPC 2.0)
- `npx tsx src/mcp/stdio.ts` — Local stdio MCP subprocess transport
- `POST /api/rpc` — Direct single or sequential batch tool invocation (supports `?profile=core|hmi|iiot|plc|all`)
- `GET /llms.txt` | `GET /openapi.json` | `GET /api/manifest` | `GET /api/skills/{vscode|antigravity|claude-code|codex}`

## Mandatory Safety & Reliability Protocol
1. **Checkpoint before bulk edits**: call `haiwell_project_snapshot_rollback` (`CREATE`) before multi-step mutations; use `ROLLBACK` if audit fails.
2. **Validate multi-vendor PLC addresses**: call `haiwell_device_validate_address` with the target device's protocol and `addressOffset` (Haiwell, Modbus, Siemens S7, Mitsubishi MC, Omron FINS, Allen-Bradley EIP, BACnet) before creating tags. Never overlap 32-bit/64-bit register word spans.
3. **Dry-run physical control writes & recipes**: call `haiwell_tag_read_write` or `haiwell_tag_batch_io` with `dryRun: true` first, and use `action: "DOWNLOAD_RECIPE"` in `haiwell_recipe_transfer` (`dryRun: true` first). Physical PLC outputs and interlocked `SIL2`/`SIL3` outputs require `confirmSafetyOverride: true` and an audit `reason`.
4. **Gate PLC logic & Haiwell JS on validation**: resolve all `ERROR` diagnostics from `haiwell_iec61131_validate` before `haiwell_iec61131_pou_save`. Author Strict-ES5 Haiwell scripts using native `Variable.GetByFullName` / `Variable.SetByFullName` and validate via `haiwell_script_validate`.
5. **Design & verify HMI readability & human factors spatially**: read MCP resource `haiwell://knowledge/hmi-engineering-playbook` to match `industryDomain` (`PROCESS_CONTINUOUS`, `DISCRETE_MANUFACTURING`, or `HYBRID_BATCH_CPG`) and ambient lighting theme (`ISA_101_LIGHT`, `CONTROL_ROOM_DARK`, `HIGH_CONTRAST_TOUCH`). Inspect `haiwell_hmi_toolbox_catalog`, build zero-collision screens via `haiwell_hmi_template_instantiate`, `haiwell_hmi_pid_compile`, or `haiwell_hmi_screen_generate`, run `haiwell_hmi_design_audit` (`autoFix: true`, passing `industryDomain`) to repair invisible text/contrast/overflow/header overlaps and verify evidence-backed human factors (redundant text coding for ~8% male red-green CVD, alarm color restraint, Endsley SA L2/L3 analog context without forcing trends onto discrete counters, >= 12px destructive-control separation), verify 0 collisions/port gaps via `haiwell_hmi_spatial_verify`, inspect faithful previews via `haiwell_hmi_screen_render_svg`, and deploy via `haiwell_desktop_deploy_hwexport` or `haiwell_project_export_hwexport`.
6. **Run FAT simulation + safety audit**: run `haiwell_simulation_step` (verify E-Stop fail-safe de-energization and alarm delays) and `haiwell_project_audit_safety` (`deploymentReady: true`, including HMI visual readability checks) before exporting or deploying.

## Factory HMI Human Factors (Facts vs. Standards vs. Context)
- **Empirical Facts (always enforce)**: Never rely on color alone (~8% male red-green CVD); reserve saturated red/amber for alarms/faults to preserve visual pop-out; pair continuous analog tags with units, operating limits, and trend/gauge context (NOVA Chemicals / ASM simulator studies: 48% vs. 10% pre-alarm upset detection); keep WCAG contrast >= 4.5:1 and touch targets >= 44x44px; cap visual clutter.
- **Consensus Standards (adapt to span of control)**: 3-4 rationalized ISA-18.2 alarm priority tiers; >= 12px separation around destructive `DANGER_ACTION` controls; <= 3 clicks in multi-unit process plants (ISA-101) vs. 1-2 clicks to fault recovery in discrete cells (PackML / Andon).
- **Avoid Dogma**: Do not force refinery-style 100% monochrome grayscale or artificial analog trends onto high-speed discrete assembly/packaging screens showing part counters, recipe codes, and multi-state machine status (`Auto` / `Manual` / `Starved` / `Blocked` / `Fault`). Match light vs. dark canvas to ambient lighting.

## Physical HMI Runtime & `.hwExport` Compiler Invariants
1. **Surface-Aware `TxtBlock` Rendering**: Embedded Linux Haiwell HMI runtimes ignore `fill-opacity="0"` on `<textBlock>` and paint an opaque background using `fill` / `HWBackColor`. `hwExportCompiler.ts` resolves each widget's true enclosing surface color (`GROUP_PANEL` header/body, `STATION` header `#334155`, dark banners, or screen canvas) so text always inherits readable foreground contrast and never paints opaque white patches over dark surfaces.
2. **Distortion-Free Numeric/Text Cards & English Fonts**: `NumShowIput` and `TxtShowIput` emit identity `matrix(1,0,0,1,x,y)` transforms with explicit pixel width/height (preventing non-uniform font stretching/squashing) and bind `WrtVar-id` on editable inputs. English DLL symbols normalize `SimSun`/`宋体` to `Arial` and enforce high-contrast `HWCursor3` readouts.
3. **Inverted Bit Display (`invertDisplay: true` → `RvrsSt="true"`)**: `BIT_LAMP` widgets and template indicator arrays support `invertDisplay: true`, compiling to Haiwell's native `RvrsSt="true"` attribute for active-low digital inputs.
4. **Zero-Error / Zero-Warning `.hwExport` Compilation**:
   - `BOOL` internal variable `<InitValue>` is normalized strictly to `"0"` or `"1"` (never `"true"`/`"false"`).
   - `NumShowIput` emits `MaxValConvert > MinValConvert` plus native threshold attributes (`ThldEnbl="false"`, `ThldMaxNum="80"`, `ThldMinNum="20"`) to satisfy Haiwell's upper/lower limit validator.
   - Editable `STRING` inputs (`TxtShowIput`) emit `IsIput="true"` with `WrtVar`/`WrtVar-id`.
5. **Headless `.hwdev` Deployer (`haiwell_desktop_deploy_hwexport`)**:
   - `enableAlwaysCollectFullNames`: sets `CollectionAlwaysEnabled = 1` on matching variables (exact `FullName`, `Device.*` prefix wildcards, or `*`) so background JS tasks always poll live values regardless of the active screen.
   - `upsertTasks`: updates existing JS tasks in-place (`taskDocument.Script` + `CompileScript`) while preserving `task.ID` and attached `eventItem` triggers, or inserts new tasks without duplicate-name dialogs.
   - `replaceExistingVariableGroups` (default `true`) & `startupWindowId`: replaces existing variable groups idempotently and automatically heals `project.StartWindowId` whenever the startup window is replaced.
