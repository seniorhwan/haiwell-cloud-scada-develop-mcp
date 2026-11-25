# Haiwell Cloud SCADA Develop MCP — Full Audit & Failure Documentation

- **Repository:** `https://github.com/seniorhwan/haiwell-cloud-scada-develop-mcp`
- **Audited Commits:**
  - Pass 1 (Baseline v2.6.0): `4827a779749951fafcd1f65b0d4f310ef49018b8`
  - Pass 2 (Hardened v2.7.0): `c8527bf6708d78a1be4bf2b80edef349833a023e`
  - Pass 3 (Local Remediation): Applied locally on top of `f45191c`
  - Pass 4 (Forensic Audit Remediation `v2.8.0`): Comprehensive remediation across all 12 CRITICAL, 19 HIGH, 36 MEDIUM, and 20 LOW findings
- **Target Workstation Environment Verified Against:**
  - Windows 10/11 (`win32`), Node.js `v24.13.0`, npm `11.6.2`
  - Installed Software: `Haiwell Cloud Scada[3.50.1.19]` at `C:\Program Files (x86)\Haiwell\HaiwellScada3\Scada.Develop.exe`

---

## 1. Executive Scorecard (`4827a77` -> `c8527bf` -> `v2.8.0`)

| # | Audit Category | Pass 1 (`4827a77`) | Pass 2 (`c8527bf`) | Pass 4 (`v2.8.0`) | Summary of Current State |
| :- | :--- | :--- | :--- | :--- | :--- |
| **R1** | **Module Resolution & Packaging (`version.ts`, `package.json`, `tsconfig.json`)** | N/A | **BROKEN** | **Fixed (`v2.8.0`)** | `SERVER_VERSION = '2.8.0'`, `tsx` in production `dependencies`, unused UI libs removed, `"strict": true` enabled. |
| **1** | **Desktop Bridges & Calibrator (`hmiSpatialEngine.ts`, `desktopAutomation.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | Inner-ID calibrator precedence (`vectorControl1`/`fg`/`treeView1`/`SymbolPanel`), `Cloud platform data monitoring`, exact 3.50.1.19 `en.lng` labels (`Modbus Master(TCP/UDP)`, `CDAB`, `'0'`/`'1'`, `Analog input`/`Analog output`, `High speed`/`Low speed`, `Task -> Script task`, `Execution interval`, `Specify the variable`), per-segment `Pipe 1` re-selection, `F2` C1FlexGrid editing, `IsReadOnly` & clipboard settle guards. |
| **2** | **IEC 61131-3 ST/LD/FBD Validator & ES5 Transpiler (`iec61131.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | 2D arrays, `EXIT;` outside-loop check, `WHILE (TRUE)`/`NOT FALSE` detection, `FOR` immutability, unguarded `MOD`, balanced `LOG`/`LN` & `**` precedence, context-aware `NOT`/`XOR`, Strict-ES5 FB pre-init & `!== undefined` defaults (no `NaN` or `KP=0` override). |
| **3** | **HTTP Security & Sandbox Isolation (`server.ts`, `scriptAnalyzer.ts`, `simulationEngine.ts`)** | Failed | **Vulnerable** | **Fixed (`v2.8.0`)** | Normalized path matching on auth/rate-limit/error middleware (blocks `/mcp/`, `/MCP`, `/api/rpc/` bypasses), `?profile=` enforcement on `/api/rpc`, batch token rate limiting, VM-realm membrane isolation + AST `+=`/`Array.join`/`fromCharCode`/`this`-alias/computed-property blocking. |
| **4** | **Headless PLC/SCADA Simulation & Alarms (`simulationEngine.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | `RUN_ONCE` latch enforcement, standalone `delayOnMs`/`delayOffMs` enforcement (opt-out `enforceDelays: false`), `DEV` deadband fix, shelved alarm clearing, integer/float32 coercion, `RUN_SCRIPT` by id/name, Step 6/8 change propagation. |
| **5** | **Safety Audit, HMI Spatial Routing & SVG Security (`hmiGenerator.ts`, `hmiSpatialEngine.ts`, `toolRegistry.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | Obstacle-aware P&ID routing + `pipeWidgetCrossings` audit, DFS longest-path DAG ranking, strict XML/SVG allowlist sanitizer, blocking validation on duplicate widget IDs / RO write widgets / invalid ranges / disconnected pipes, fail-closed `ESTOP_TAG_MISSING`, physical-output interlock check, scoped idempotency keys. |
| **6** | **Multi-Vendor PLC Addressing & CSV Export (`plcAddressing.ts`, `haiwellRegisters.ts`, `toolRegistry.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | `deviceOffsets` (`BASE_0`/`BASE_1`) overlap checks, unified S7 `DBW`/`DBB` byte-width, Delta DVP octal/bounds, Schneider `%MW`/`%QW` separation, OPC UA/MQTT/AB EIP fixes, `IR`/`HR`/`.bit` CSV accuracy & split PLC vs internal CSV export. |
| **7** | **Store Integrity, OPC UA Write Guard & SSRF (`projectStore.ts`, `protocolAdapters.ts`, `toolRegistry.ts`)** | Failed | **Partial** | **Fixed (`v2.8.0`)** | Deep partial-project normalization & persistence failure rollback, OPC UA `CurrentReadWrite` write guard + audit trail, `LITERAL_STRING_ARG_KEYS` preserving JSON strings (`lwtPayload`/`value`/`actionValue`/`svgMarkup`), obfuscated IPv6 loopback SSRF blocking. |

---

## 2. Active Failure Points in `c8527bf` (All 6 Remediated Locally)

### Failure #1 (Blocker): Missing `src/mcp/version.ts` Crashes Server Startup, Typecheck, and Test Suites

* **Affected Files:**
  * `server.ts` (line 25: `import { SERVER_VERSION } from './src/mcp/version';`)
  * `src/mcp/createMcpServer.ts` (line 9: `import { SERVER_VERSION } from './version';`)
  * `src/mcp/auditHardening.test.ts` (line 16: `import { SERVER_VERSION } from './version';`)
* **Live Reproduction Output:**
  ```text
  > tsc --noEmit
  server.ts(25,32): error TS2307: Cannot find module './src/mcp/version' or its corresponding type declarations.
  src/mcp/auditHardening.test.ts(16,32): error TS2307: Cannot find module './version' or its corresponding type declarations.
  src/mcp/createMcpServer.ts(9,32): error TS2307: Cannot find module './version' or its corresponding type declarations.

  > npx tsx server.ts
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\src\mcp\version' imported from ...\src\mcp\createMcpServer.ts
  ```
* **Root Cause:** `src/mcp/version.ts` was created during refactoring to unify version strings (`2.7.0`) but was omitted from git commit `c8527bf`.
* **Proposed Fix:**
  Create and commit `src/mcp/version.ts`:
  ```ts
  export const SERVER_VERSION = '2.7.0';
  ```

---

### Failure #2 (Critical): `desktopAutomation.ts` Fails to Locate Real Haiwell Installation and Misparses `Language/*.lng` & `config.ini`

* **Affected File:** `src/mcp/desktopAutomation.ts` (lines 31–220)
* **Live Reproduction Output on Windows Workstation (`haiwell_desktop_inspect`):**
  ```json
  {
    "platform": "win32",
    "isWindows": true,
    "installDir": "C:\\Program Files (x86)\\HaiwellScada3",
    "exePath": "C:\\Program Files (x86)\\HaiwellScada3\\Scada.Develop.exe",
    "exeExists": false,
    "detectedLanguage": "en",
    "lngFilePath": null,
    "availableLanguageFiles": [],
    "notes": [
      "Scada.Develop.exe was not found at \"C:\\Program Files (x86)\\HaiwellScada3\\Scada.Develop.exe\". Pass installDir explicitly or set HAIWELL_INSTALL_DIR."
    ]
  }
  ```
* **Root Causes (4 distinct bugs verified against real `HaiwellScada3` files):**
  1. **Wrong Default Installation Path & No Registry Lookup:**
     Haiwell Cloud SCADA installs by default under the vendor subfolder `C:\Program Files (x86)\Haiwell\HaiwellScada3\Scada.Develop.exe` (and registers `"C:\Program Files (x86)\Haiwell\HaiwellScada3\Scada.Develop.exe" "%1"` in `HKLM\SOFTWARE\Classes\Haiwell.HaiwellScada3\shell\open\command`), whereas `desktopAutomation.ts` defaults to `C:\Program Files (x86)\HaiwellScada3`.
  2. **`parseHaiwellLngContent` Parses `key=value` INI Instead of XML:**
     Real `C:\Program Files (x86)\Haiwell\HaiwellScada3\Language\en.lng` (and `zh-cn.lng`, `zh-tw.lng`, `portuguese.lng`) is an XML file structured as:
     ```xml
     <Group name="Develop.Develop.FrmNewProject">
       <String name="btnCancel" text="Delete" />
       <String name="btnOK" text="OK" />
       <String name="btnSelFile" text="Choose" />
       <String name="lblProjectName" text="Project name:" />
       <String name="lblSaveFile" text="Save document:" />
       <String name="WindowText" text="New project" />
     </Group>
     ```
     `parseHaiwellLngContent` splits on `=` as if the file were INI (`key=value`), failing to extract any XML `<String name="..." text="..." />` attributes.
  3. **`detectHaiwellLanguageFromConfig` Treats Numeric `lang=0` in `config.ini` as Filename `0.lng`:**
     Real `C:\Program Files (x86)\Haiwell\HaiwellScada3\config.ini` contains:
     ```ini
     [setting]
     lang=0
     ```
     `detectHaiwellLanguageFromConfig` reads `lang = "0"` and checks `Language\0.lng` (which does not exist; `0` = `en.lng`, `1` = `zh-cn.lng`, `2` = `zh-tw.lng`, `3` = `portuguese.lng`).
  4. **Two-Step New Project Modal Sequence in Haiwell 3.50.x:**
     In `Scada.Develop.exe` 3.50.1.19, clicking `Create a new project...` (on `Start page`) or `Project(P) -> New project(#W)` first opens `Develop.Develop.FrmNewProject` (window title `"New project"`, fields `"Project name:"` and `"Save document:"`). Clicking `OK` on that dialog then opens `FrmNewProject` (`"Project properties"`, tab `"Basic information"`, `"Runtime platform"`, `"Device model"`, `"Resolution:"`). `DEFAULT_EN_LABELS.newProjectDialogTitle` only looks for `"Project properties"`.
* **Proposed Fix:**
  1. Resolve `installDir` by checking, in order: explicit `installDir`, `process.env.HAIWELL_INSTALL_DIR` / `HAIWELL_SCADA_DIR`, Windows Registry `HKLM\SOFTWARE\Classes\Haiwell.HaiwellScada3\shell\open\command`, `C:\Program Files (x86)\Haiwell\HaiwellScada3`, `C:\Program Files\Haiwell\HaiwellScada3`, and `C:\Program Files (x86)\HaiwellScada3`.
  2. Map numeric `config.ini` `lang` codes (`'0': 'en'`, `'1': 'zh-cn'`, `'2': 'zh-tw'`, `'3': 'portuguese'`).
  3. Update `parseHaiwellLngContent` to parse both XML `<String\s+name="([^"]+)"\s+text="([^"]*)"\s*\/?>` tags and `key=value` lines.
  4. In `haiwell_desktop_new_project`, handle both the initial `"New project"` (`FrmNewProject` name/path) dialog and the subsequent `"Project properties"` hardware/resolution dialog.

---

### Failure #3 (High): `npm install` Fails Out-of-the-Box with `ERESOLVE`

* **Affected File:** `package.json` (lines 28 and 36)
* **Live Reproduction Output:**
  ```text
  npm error code ERESOLVE
  npm error While resolving: vite@8.3.8
  npm error Found: esbuild@0.25.12
  npm error Could not resolve dependency:
  npm error peerOptional esbuild@"^0.27.0 || ^0.28.0" from vite@8.3.8
  ```
* **Root Cause:** `package.json` pins `"esbuild": "^0.25.0"` in `devDependencies` while `"vite": "^8.3.0"` resolves to `8.3.8`, which requires `esbuild@"^0.27.0 || ^0.28.0"`.
* **Proposed Fix:**
  Upgrade `"esbuild": "^0.28.0"` in `package.json` (or remove unused frontend dependencies `vite`, `react`, `react-dom`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `motion`, `lucide-react`, `@google/genai` since the server is 100% headless).

---

### Failure #4 (High): `haiwell_project_audit_safety` Reports `deploymentReady: true` on Broken HMI Screens, Missing `startupScreenId`, `A8` COM Devices, and `IPC_SCADA` Audio

* **Affected File:** `src/mcp/toolRegistry.ts` (`runProjectSafetyAudit`, lines 450–745)
* **Live Reproduction Output:**
  ```json
  {
    "brokenHmiAudit": {
      "deploymentReady": true,
      "hmiFinding": {
        "code": "AUD-HMI-LAYOUT",
        "severity": "MEDIUM",
        "domain": "hmi",
        "target": "scr_1",
        "message": "Screen \"Broken\" issues: collisions=0, outOfBounds=0, unresolvedTags=0, brokenNav=0, touchTargets=2."
      }
    },
    "startupScreenFindings": 0,
    "a8ComOk": true,
    "a8AuditCount": 0,
    "ipcAudioOk": true,
    "ipcAuditCount": 0
  }
  ```
* **Root Causes:**
  1. `AUD-HMI-LAYOUT` is hardcoded to `severity: 'MEDIUM'` (line 460), and `deploymentReady` only checks `critical === 0 && high === 0` (line 741). Consequently, an HMI screen with widget collisions, out-of-bounds widgets, unresolved tags, broken navigation targets, or `< 44x44px` touch targets on a touch panel still reports `deploymentReady: true` and passes `haiwell_open_project_bridge_export`.
  2. `project.startupScreenId` is not checked against `project.screens` when `project.screens.length > 0` (or when `startupScreenId` is explicitly set to a nonexistent screen ID).
  3. Official Haiwell 3.50.x hardware restrictions from `Language\en.lng` are missing:
     * Line 3440 (`A8SWITCHPLATFORMTIPS2`): *"A8 does not support com devices and printers"* — `CLOUD_HMI_A8` currently allows `transport: 'RTU'` serial devices and printer peripherals with 0 findings.
     * Line 1201 (`ERROR_AUDIO_PLAY_IPC`): *"IPC does not support audio playing."* — `IPC_SCADA` currently allows `haiwell_audio_configure` with 0 findings.
  4. Dangling `targetId` references in `project.schedules` and `project.eventTriggers` (when `actionType` is `RUN_SCRIPT`, `SEND_WEBHOOK`, or `LOAD_RECIPE`) are not audited in `runProjectSafetyAudit`.
* **Proposed Fix:**
  * Change `AUD-HMI-LAYOUT` severity to `'HIGH'` (or `'CRITICAL'` when `collisions.length > 0 || unresolvedTags.length > 0`).
  * Add `AUD-STARTUP-SCREEN` (`HIGH`) when `project.startupScreenId` is set and not found in `project.screens`.
  * Add `AUD-HW-COMPAT-A8` (`HIGH`) when `project.targetHardware === 'CLOUD_HMI_A8'` and any device uses `transport === 'RTU'` or any peripheral has `kind === 'PRINTER'`.
  * Add `AUD-HW-COMPAT-IPC-AUDIO` (`HIGH`) when `project.targetHardware === 'IPC_SCADA'` and `(project.audioClips ?? []).some(a => a.enabled)`.
  * Audit `schedules` and `eventTriggers` target IDs against `project.scripts`, `project.webhooks`, and `project.recipes`.

---

### Failure #5 (High): SSRF Guard in `probeTcpEndpoint` Misses Expanded IPv6-Mapped IPv4 and DNS Rebinding

* **Affected File:** `src/mcp/protocolAdapters.ts` (lines 103–194)
* **Live Reproduction Output (`haiwell_mqtt_exchange` with `PROBE_BROKER`):**
  ```json
  {
    "ssrfIpv6FullBlocked": false,
    "ssrfIpv6FullResult": {
      "host": "0:0:0:0:0:ffff:169.254.169.254",
      "port": 80,
      "reachable": false,
      "latencyMs": 1213.22,
      "error": "TCP connect timed out after 1200ms"
    }
  }
  ```
* **Root Cause:**
  * `BLOCKED_PROBE_HOSTS` only checks compressed `^::ffff:169\.254\./i` and `^::ffff:a9fe:/i`, so uncompressed or partially expanded IPv6-mapped IPv4 addresses (`0:0:0:0:0:ffff:169.254.169.254`, `0000:0000:0000:0000:0000:ffff:a9fe:a9fe`, `::ffff:0a9fe:a9fe`) bypass the regex and open a real TCP socket.
  * `probeTcpEndpoint` passes `host` directly to `socket.connect(port, host)` without resolving DNS first (`dns.lookup`), allowing any external domain (e.g. `169.254.169.254.nip.io`) that resolves to `169.254.169.254` or `127.0.0.1` to bypass string-only checks.
* **Proposed Fix:**
  * Expand/normalize IPv6 literals (strip leading zeros per hextet, collapse `0:0:0:0:0:ffff:` prefix, and extract the embedded 32-bit IPv4 address from both dotted-quad and 2-hextet forms) and feed the extracted IPv4 into `isBlockedSsrfHost`.
  * In `probeTcpEndpoint`, resolve non-IP hostnames via `await dns.promises.lookup(host, { all: true })`, verify **every** resolved IP passes `isBlockedSsrfHost`, and connect directly to the validated IP literal.

---

### Failure #6 (Medium): Multi-Vendor PLC Addressing Misses Mixed-Notation Coil Collisions, Bit-in-Word Overlaps, 16-Bit Span Overflow, and `%MX` Bit Formatting

* **Affected Files:**
  * `src/mcp/plcAddressing.ts` (lines 133–244, 281–326, 540–594)
  * `src/mcp/haiwellRegisters.ts` (lines 221–260)
* **Live Reproduction Output:**
  ```json
  {
    "upsertOk": true,
    "overlapFindings": [],
    "badAddrFindings": [],
    "v100_12_iecDirectAddress": "%MX12.12"
  }
  ```
  *(Reproduced by upserting `00001`, `0X0`, `COIL:0`, and `4X65535` (`FLOAT32`) on `dev_mb`, plus `DB1.DBX0.0` and `DB1.DBW0` on `dev_s7`, and validating `V100.12` on `HAIWELL_PLC_TCP`.)*
* **Root Causes:**
  1. **Mixed-Notation Bit Collisions:** For Modbus coils and discrete inputs (`00001` vs `0X0` vs `COIL:0`, or `10001` vs `1X0` vs `DI:0`), `wordAddressKey` is `undefined` and `exactKey` uses `parsed.normalized` (`"00001"`, `"0X0"`, `"COIL:0"`), so three tags bound to the exact same physical coil 0 are not flagged as colliding.
  2. **Bit-Inside-Word / Bit-Inside-Byte Overlaps:** Bit tags (`DB1.DBX0.0`, `I0.0`, `V100.3`, `4X100.3`) set `wordAddressKey: undefined`, so they are never checked against `wordOccupancy` slots occupied by word/dword tags (`DB1.DBW0`, `IW0`, `V99` `FLOAT32`, `4X99` `FLOAT32`).
  3. **Multi-Word Upper-Bound Overflow:** `validatePlcAddress` validates only the start register index (`0..65535` for Modbus, `0..14847` for Haiwell `V`), ignoring `wordSpan`. A `FLOAT32` (2 words) at `4X65535` or `V14847` overflows past the end of the register file (`65536` / `14848`).
  4. **Invalid IEC `%MX` Bit Index (`> 7`):** In `src/mcp/haiwellRegisters.ts:259`:
     ```ts
     else if (effectiveKind === 'BIT') iecDirectAddress = `%MX${Math.floor(index / 8)}.${bitOffset ?? index % 8}`;
     ```
     When `address` is a word bit-slice like `V100.12`, `bitOffset` is `12`, producing `%MX12.12` (invalid IEC 61131-3 byte-bit representation, where bit offset must be `0..7`).
* **Proposed Fix:**
  1. Populate a canonical `bitAddressKey` and parent `wordAddressKey` on every parsed address:
     * Modbus coils -> `exactKey = "${deviceId}:MODBUS_COIL:${offset}"`; Modbus DI -> `exactKey = "${deviceId}:MODBUS_DI:${offset}"`.
     * Word/Byte bit slices (`4X100.3`, `V100.3`, `DB1.DBX0.0`, `I0.0`) -> record their enclosing word/byte slot in `detectWordOverlapConflicts` so bit-vs-word collisions are caught while still allowing distinct bits within the same word (e.g. `V100.0` and `V100.1`).
  2. In `haiwell_tag_upsert_batch` and `runProjectSafetyAudit`, check `parsed.wordAddressKey.startIndex + span - 1 <= maxAddressIndex` (e.g. `65535` for Modbus, `HAIWELL_REGISTER_MAP[area].maxIndex` for Haiwell PLC).
  3. In `src/mcp/haiwellRegisters.ts:259`, when `bitOffset !== undefined` on a 16-bit word register, compute `%MX${index * 2 + Math.floor(bitOffset / 8)}.${bitOffset % 8}` (so `V100.12` -> `%MX201.4`).

---

## 3. Reference: Failures Resolved in `c8527bf`

For completeness, the following issues from the Pass 1 (`4827a77`) audit were verified as **resolved** in `c8527bf`:

1. **`haiwell_open_project_bridge_export` & `haiwell_hmi_desktop_bridge_export` Python Stubs:**
   `run_variables`, `run_tasks`, `run_events`, and `run_displays` now have complete non-dry-run execution branches, resolve WinForms inputs by matching label bounding rectangles to adjacent `Edit`/`ComboBox` controls, and return `pipeSteps` + `unverifiedToolboxItems`.
2. **IEC 61131-3 ST-to-JS Transpiler Syntax Bugs:**
   Function block calls (`StartDelay(IN := TRUE, PT := T#3s);`), `XOR`, `CASE` ranges (`1..5:`), `VAR` initializers (`:= TRUE`), multi-variable declarations (`A, B : INT;`), and semicolons/keywords inside string literals now validate and transpile to valid ES5 JS defaulting to `Variable.GetByFullName` / `Variable.SetByFullName`.
3. **Headless Simulation Engine (`simulationEngine.ts`):**
   `haiwell_simulation_step` now executes saved ST POUs and JS scripts per scan cycle inside a bounded `node:vm` context and updates dependent tags (`Plant_DeltaT_C`, `Valve_Position_Pct`).
4. **JavaScript Static Analyzer (`scriptAnalyzer.ts`):**
   Uses `acorn` for real syntax validation and AST inspection, blocks ES6+ runtime traps (`Object.assign`, `.includes`, `for..of`), permits local variable names like `var process = 1`, validates single-level `$InternalTag` writes, and checks AST conditionals for `EStop_OK`.
5. **Server Hardening & Client Onboarding (`server.ts`, `resourcesAndPrompts.ts`, `projectStore.ts`):**
   Added `import 'dotenv/config'`, `McpServer` pooling per profile, `TRUST_PROXY` guard on `X-Forwarded-Host`/`X-Forwarded-Proto`, project redaction on unauthenticated `GET /api/manifest`, snapshot persistence in `workspace.json`, exact Haiwell 3.50.x CSV export column headers, `cwd` + absolute path in generated `stdio` IDE configs, and removal of `public/assets/aistudio/` personal screenshots/PDF.
