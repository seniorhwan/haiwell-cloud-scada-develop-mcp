/**
 * Live Windows Desktop Automation Bridge for Haiwell Cloud Scada Develop (Scada.Develop.exe).
 * Provides:
 * - Installation & Language (.lng / config.ini) inspector
 * - Safe process launcher / window attacher matching "Haiwell Cloud Scada" (skips splash screen)
 * - New .hwdev project wizard automator using UIA MenuItem traversal, adjacent-Label ComboBox
 *   binding, resolution/network-port configuration, and try/finally clipboard restoration.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HaiwellUiLabels {
  language: string;
  projectMenu: string;
  newProjectMenuItem: string;
  newProjectDialogTitle: string;
  projectNameLabel: string;
  runtimePlatformLabel: string;
  deviceModelLabel: string;
  resolutionLabel: string;
  networkProjectPortLabel: string;
  okButton: string;
  cancelButton: string;
}

const DEFAULT_EN_LABELS: HaiwellUiLabels = {
  language: 'en',
  projectMenu: 'Project',
  newProjectMenuItem: 'New project',
  newProjectDialogTitle: 'Project properties',
  projectNameLabel: 'Project name',
  runtimePlatformLabel: 'Runtime platform',
  deviceModelLabel: 'Device model',
  resolutionLabel: 'Resolution',
  networkProjectPortLabel: 'Port',
  okButton: 'OK',
  cancelButton: 'Cancel',
};

/**
 * Parses a HaiwellScada3 Language/*.lng INI/key=value file and extracts
 * localized UI labels for menus, dialogs, and New Project controls.
 */
export function parseHaiwellLngContent(content: string, language = 'en'): HaiwellUiLabels {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || (line.startsWith('[') && line.endsWith(']'))) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (key && val) map.set(key, val);
  }

  const pick = (candidates: string[], fallback: string): string => {
    for (const c of candidates) {
      const exact = map.get(c.toLowerCase());
      if (exact) return exact;
    }
    for (const [k, v] of map.entries()) {
      for (const c of candidates) {
        if (k.includes(c.toLowerCase())) return v;
      }
    }
    return fallback;
  };

  return {
    language,
    projectMenu: pick(['menu_project', 'project_menu', 'tsmiproject', 'project'], DEFAULT_EN_LABELS.projectMenu),
    newProjectMenuItem: pick(
      ['menu_new_project', 'new_project', 'tsminewproject', 'create a new project'],
      DEFAULT_EN_LABELS.newProjectMenuItem
    ),
    newProjectDialogTitle: pick(
      ['frmnewproject', 'project_properties', 'new_project_title'],
      DEFAULT_EN_LABELS.newProjectDialogTitle
    ),
    projectNameLabel: pick(['lblprojectname', 'project_name', 'projectname'], DEFAULT_EN_LABELS.projectNameLabel),
    runtimePlatformLabel: pick(
      ['lblruntimeplatform', 'runtime_platform', 'runplatform'],
      DEFAULT_EN_LABELS.runtimePlatformLabel
    ),
    deviceModelLabel: pick(['lbldevicemodel', 'device_model', 'hmi_model'], DEFAULT_EN_LABELS.deviceModelLabel),
    resolutionLabel: pick(['lblresolution', 'resolution', 'screen_resolution'], DEFAULT_EN_LABELS.resolutionLabel),
    networkProjectPortLabel: pick(
      ['lblnetworkport', 'network_port', 'webport', 'port'],
      DEFAULT_EN_LABELS.networkProjectPortLabel
    ),
    okButton: pick(['btnok', 'ok', 'confirm'], DEFAULT_EN_LABELS.okButton),
    cancelButton: pick(['btncancel', 'cancel'], DEFAULT_EN_LABELS.cancelButton),
  };
}

export function detectHaiwellLanguageFromConfig(installDir: string): {
  language: string;
  lngFilePath: string | null;
  labels: HaiwellUiLabels;
} {
  let lang = 'en';
  const configPath = path.join(installDir, 'config.ini');
  if (fs.existsSync(configPath)) {
    try {
      const ini = fs.readFileSync(configPath, 'utf8');
      const m = /^\s*lang\s*=\s*([^\r\n;#]+)/im.exec(ini);
      if (m && m[1].trim()) {
        lang = m[1].trim().toLowerCase();
      }
    } catch {
      // Fall back to default 'en'
    }
  }

  const langDir = path.join(installDir, 'Language');
  const candidates = [
    path.join(langDir, `${lang}.lng`),
    path.join(langDir, `${lang.replace('_', '-')}.lng`),
    path.join(langDir, 'en.lng'),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      try {
        const content = fs.readFileSync(cand, 'utf8');
        return {
          language: lang,
          lngFilePath: cand,
          labels: parseHaiwellLngContent(content, lang),
        };
      } catch {
        // try next candidate
      }
    }
  }

  return {
    language: lang,
    lngFilePath: null,
    labels: { ...DEFAULT_EN_LABELS, language: lang },
  };
}

export interface DesktopInspectResult {
  platform: NodeJS.Platform;
  isWindows: boolean;
  installDir: string;
  exePath: string;
  exeExists: boolean;
  detectedLanguage: string;
  lngFilePath: string | null;
  uiLabels: HaiwellUiLabels;
  availableLanguageFiles: string[];
  notes: string[];
}

export function inspectHaiwellDesktopInstallation(installDirInput?: string): DesktopInspectResult {
  const defaultDirs = [
    installDirInput,
    process.env.HAIWELL_INSTALL_DIR,
    'C:\\Program Files (x86)\\HaiwellScada3',
    'C:\\Program Files\\HaiwellScada3',
    'D:\\HaiwellScada3',
  ].filter((d): d is string => Boolean(d && d.trim()));

  let resolvedDir = defaultDirs[0] ?? 'C:\\Program Files (x86)\\HaiwellScada3';
  for (const dir of defaultDirs) {
    if (fs.existsSync(path.join(dir, 'Scada.Develop.exe')) || fs.existsSync(dir)) {
      resolvedDir = dir;
      break;
    }
  }

  const exePath = path.join(resolvedDir, 'Scada.Develop.exe');
  const exeExists = fs.existsSync(exePath);
  const langInfo = detectHaiwellLanguageFromConfig(resolvedDir);
  const langDir = path.join(resolvedDir, 'Language');
  let availableLanguageFiles: string[] = [];
  if (fs.existsSync(langDir)) {
    try {
      availableLanguageFiles = fs
        .readdirSync(langDir)
        .filter((f) => f.toLowerCase().endsWith('.lng'))
        .sort();
    } catch {
      availableLanguageFiles = [];
    }
  }

  const notes: string[] = [];
  if (process.platform !== 'win32') {
    notes.push(
      'Server is running on a non-Windows host. Live Windows UIA execution requires running this MCP server on Windows (or running the generated scripts locally on Windows).'
    );
  }
  if (!exeExists) {
    notes.push(
      `Scada.Develop.exe was not found at "${exePath}". Pass installDir explicitly or set HAIWELL_INSTALL_DIR.`
    );
  }

  return {
    platform: process.platform,
    isWindows: process.platform === 'win32',
    installDir: resolvedDir,
    exePath,
    exeExists,
    detectedLanguage: langInfo.language,
    lngFilePath: langInfo.lngFilePath,
    uiLabels: langInfo.labels,
    availableLanguageFiles,
    notes,
  };
}

function escapePsSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildLaunchPowerShellScript(options: {
  exePath: string;
  projectFilePath?: string;
  timeoutSec: number;
}): string {
  const exeEsc = escapePsSingleQuoted(options.exePath);
  const argClause = options.projectFilePath
    ? `-ArgumentList @('${escapePsSingleQuoted(options.projectFilePath)}')`
    : '';
  const timeoutSec = Math.max(5, Math.min(options.timeoutSec, 120));

  return [
    `$ErrorActionPreference = 'Stop'`,
    `$existing = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Haiwell Cloud Scada' } | Select-Object -First 1`,
    `if (-not $existing) {`,
    `  Start-Process -FilePath '${exeEsc}' ${argClause}`.trimEnd(),
    `}`,
    `$deadline = (Get-Date).AddSeconds(${timeoutSec})`,
    `$mainProc = $null`,
    `while ((Get-Date) -lt $deadline) {`,
    `  $mainProc = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Haiwell Cloud Scada' } | Select-Object -First 1`,
    `  if ($mainProc) { break }`,
    `  Start-Sleep -Milliseconds 300`,
    `}`,
    `if (-not $mainProc) {`,
    `  throw "Timed out after ${timeoutSec}s waiting for Haiwell Cloud Scada main window (splash screen skipped)."`,
    `}`,
    `[PSCustomObject]@{ ok = $true; pid = $mainProc.Id; title = $mainProc.MainWindowTitle } | ConvertTo-Json -Compress`,
  ].join('\n');
}

export async function launchHaiwellDesktop(options: {
  installDir?: string;
  projectFilePath?: string;
  timeoutSec?: number;
  dryRun?: boolean;
}) {
  const info = inspectHaiwellDesktopInstallation(options.installDir);
  const timeoutSec = Math.max(5, Math.min(options.timeoutSec ?? 25, 120));
  const psScript = buildLaunchPowerShellScript({
    exePath: info.exePath,
    projectFilePath: options.projectFilePath,
    timeoutSec,
  });

  if (options.dryRun || process.platform !== 'win32') {
    return {
      executed: false,
      dryRun: Boolean(options.dryRun),
      reason:
        process.platform !== 'win32'
          ? 'NON_WINDOWS_HOST_SCRIPT_GENERATED'
          : 'DRY_RUN_ONLY',
      exePath: info.exePath,
      powershellScript: psScript,
    };
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript],
      { timeout: (timeoutSec + 10) * 1000 }
    );
    const parsed = JSON.parse(stdout.trim() || '{}');
    return {
      executed: true,
      dryRun: false,
      exePath: info.exePath,
      window: parsed,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'EACCES') {
      throw new Error(
        `OS_PERMISSION_DENIED: Cannot launch "${info.exePath}" (EACCES). Run the MCP server with matching Windows desktop elevation.`
      );
    }
    throw new Error(
      `DESKTOP_LAUNCH_FAILED: ${e.stderr?.trim() || e.message || 'Unknown error launching Scada.Develop.exe'}`
    );
  }
}

export interface NewDesktopProjectOptions {
  projectName: string;
  runtimePlatform?: string;
  deviceModel?: string;
  resolution?: string;
  networkProjectPort?: number;
  installDir?: string;
  dryRun?: boolean;
  labels?: HaiwellUiLabels;
}

export function buildNewProjectPowerShellScript(options: NewDesktopProjectOptions): string {
  const labels = options.labels ?? DEFAULT_EN_LABELS;
  const projectName = escapePsSingleQuoted(options.projectName);
  const runtimePlatform = escapePsSingleQuoted(options.runtimePlatform ?? 'Cloud HMI');
  const deviceModel = escapePsSingleQuoted(options.deviceModel ?? 'Haiwell HMI B7H');
  const resolution = escapePsSingleQuoted(options.resolution ?? '1024*600');
  const port = Number.isInteger(options.networkProjectPort) ? String(options.networkProjectPort) : '8888';

  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    ``,
    `function Get-AdjacentControl($dialog, [string]$labelText, $controlType) {`,
    `  $allText = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))`,
    `  $labelEl = $null`,
    `  foreach ($t in $allText) {`,
    `    if ($t.Current.Name -and $t.Current.Name.ToLower().Contains($labelText.ToLower())) { $labelEl = $t; break }`,
    `  }`,
    `  if (-not $labelEl) { return $null }`,
    `  $lr = $labelEl.Current.BoundingRectangle`,
    `  $lMidY = $lr.Top + ($lr.Height / 2.0)`,
    `  $candidates = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)))`,
    `  $best = $null; $bestScore = [double]::MaxValue`,
    `  foreach ($c in $candidates) {`,
    `    $cr = $c.Current.BoundingRectangle`,
    `    if ($cr.Width -le 0 -or $cr.Height -le 0) { continue }`,
    `    $cMidY = $cr.Top + ($cr.Height / 2.0)`,
    `    $dy = [Math]::Abs($cMidY - $lMidY)`,
    `    $dx = $cr.Left - $lr.Right`,
    `    if ($dy -le 26 -and $dx -ge -10) {`,
    `      $score = ($dy * 10.0) + [Math]::Max(0.0, $dx)`,
    `      if ($score -lt $bestScore) { $bestScore = $score; $best = $c }`,
    `    }`,
    `  }`,
    `  return $best`,
    `}`,
    ``,
    `function Set-EditSafe($el, [string]$val) {`,
    `  if (-not $el) { return $false }`,
    `  $vp = $null`,
    `  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {`,
    `    $vp.SetValue($val)`,
    `    return $true`,
    `  }`,
    `  $prevClip = $null`,
    `  try {`,
    `    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $prevClip = [System.Windows.Forms.Clipboard]::GetText() }`,
    `    $el.SetFocus()`,
    `    [System.Windows.Forms.Clipboard]::SetText($val)`,
    `    [System.Windows.Forms.SendKeys]::SendWait('^a^v')`,
    `    return $true`,
    `  } finally {`,
    `    if ($null -ne $prevClip) { [System.Windows.Forms.Clipboard]::SetText($prevClip) } else { [System.Windows.Forms.Clipboard]::Clear() }`,
    `  }`,
    `}`,
    ``,
    `function Select-ComboByText($combo, [string]$targetText) {`,
    `  if (-not $combo) { return $false }`,
    `  $ec = $null`,
    `  if ($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {`,
    `    $ec.Expand()`,
    `    Start-Sleep -Milliseconds 120`,
    `  }`,
    `  $items = $combo.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))`,
    `  foreach ($it in $items) {`,
    `    if ($it.Current.Name -and $it.Current.Name.ToLower().Contains($targetText.ToLower())) {`,
    `      $sel = $null`,
    `      if ($it.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {`,
    `        $sel.Select()`,
    `        return $true`,
    `      }`,
    `    }`,
    `  }`,
    `  return (Set-EditSafe $combo $targetText)`,
    `}`,
    ``,
    `$proc = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Haiwell Cloud Scada' } | Select-Object -First 1`,
    `if (-not $proc) { throw 'Haiwell Cloud Scada main window is not running. Call haiwell_desktop_launch first.' }`,
    `$mainWin = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)`,
    ``,
    `# 1. Open Project -> New project via UIA MenuItem first (locale-safe), fallback to Alt keystroke`,
    `$openedNew = $false`,
    `$menuItems = $mainWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))`,
    `foreach ($mi in $menuItems) {`,
    `  if ($mi.Current.Name -and $mi.Current.Name.ToLower().Contains('${escapePsSingleQuoted(labels.projectMenu.toLowerCase())}')) {`,
    `    $ec = $null`,
    `    if ($mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {`,
    `      $ec.Expand()`,
    `      Start-Sleep -Milliseconds 150`,
    `      $subItems = $mainWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))`,
    `      foreach ($sub in $subItems) {`,
    `        if ($sub.Current.Name -and $sub.Current.Name.ToLower().Contains('${escapePsSingleQuoted(labels.newProjectMenuItem.toLowerCase())}')) {`,
    `          $inv = $null`,
    `          if ($sub.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke(); $openedNew = $true; break }`,
    `        }`,
    `      }`,
    `    }`,
    `    if ($openedNew) { break }`,
    `  }`,
    `}`,
    `if (-not $openedNew) {`,
    `  $mainWin.SetFocus()`,
    `  [System.Windows.Forms.SendKeys]::SendWait('%pn')`,
    `}`,
    `Start-Sleep -Milliseconds 400`,
    ``,
    `# 2. Locate FrmNewProject / Project properties dialog`,
    `$dlg = $null`,
    `$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `foreach ($w in $mainWin.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {`,
    `  if ($w.Current.Name -match '(?i)(${escapePsSingleQuoted(labels.newProjectDialogTitle)}|New project|FrmNewProject)') { $dlg = $w; break }`,
    `}`,
    `if (-not $dlg) { throw 'New Project properties dialog did not appear.' }`,
    ``,
    `# 3. Populate controls strictly by adjacent Label bounding-box lookup`,
    `$nameEdit = Get-AdjacentControl $dlg '${escapePsSingleQuoted(labels.projectNameLabel)}' ([System.Windows.Automation.ControlType]::Edit)`,
    `Set-EditSafe $nameEdit '${projectName}' | Out-Null`,
    `$platformCombo = Get-AdjacentControl $dlg '${escapePsSingleQuoted(labels.runtimePlatformLabel)}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `Select-ComboByText $platformCombo '${runtimePlatform}' | Out-Null`,
    `$modelCombo = Get-AdjacentControl $dlg '${escapePsSingleQuoted(labels.deviceModelLabel)}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `Select-ComboByText $modelCombo '${deviceModel}' | Out-Null`,
    `$resCombo = Get-AdjacentControl $dlg '${escapePsSingleQuoted(labels.resolutionLabel)}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `Select-ComboByText $resCombo '${resolution}' | Out-Null`,
    `$portEdit = Get-AdjacentControl $dlg '${escapePsSingleQuoted(labels.networkProjectPortLabel)}' ([System.Windows.Automation.ControlType]::Edit)`,
    `Set-EditSafe $portEdit '${port}' | Out-Null`,
    ``,
    `# 4. Confirm dialog via OK button`,
    `$btns = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))`,
    `foreach ($b in $btns) {`,
    `  if ($b.Current.Name -match '(?i)^(${escapePsSingleQuoted(labels.okButton)}|OK|Confirm)$') {`,
    `    $inv = $null`,
    `    if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke(); break }`,
    `  }`,
    `}`,
    `[PSCustomObject]@{ ok = $true; projectName = '${projectName}'; runtimePlatform = '${runtimePlatform}'; deviceModel = '${deviceModel}'; resolution = '${resolution}'; networkProjectPort = ${port} } | ConvertTo-Json -Compress`,
  ].join('\n');
}

export async function createNewHaiwellProjectOnDesktop(options: NewDesktopProjectOptions) {
  const info = inspectHaiwellDesktopInstallation(options.installDir);
  const psScript = buildNewProjectPowerShellScript({
    ...options,
    labels: options.labels ?? info.uiLabels,
  });

  if (options.dryRun || process.platform !== 'win32') {
    return {
      executed: false,
      dryRun: Boolean(options.dryRun),
      reason:
        process.platform !== 'win32'
          ? 'NON_WINDOWS_HOST_SCRIPT_GENERATED'
          : 'DRY_RUN_ONLY',
      detectedLanguage: info.detectedLanguage,
      uiLabels: info.uiLabels,
      powershellScript: psScript,
    };
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript],
      { timeout: 30_000 }
    );
    return {
      executed: true,
      dryRun: false,
      result: JSON.parse(stdout.trim() || '{}'),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'EACCES') {
      throw new Error(
        `OS_PERMISSION_DENIED: Cannot execute PowerShell UIA automation (EACCES).`
      );
    }
    throw new Error(
      `DESKTOP_NEW_PROJECT_FAILED: ${e.stderr?.trim() || e.message || 'Unknown UIA failure'}`
    );
  }
}
