/**
 * Live Windows Desktop Automation Bridge for Haiwell Cloud Scada Develop (Scada.Develop.exe).
 * Provides:
 * - Installation & Language (.lng XML / INI & config.ini) inspector with Windows Registry lookup
 * - Safe process launcher / window attacher matching "Haiwell Cloud Scada" (skips splash screen)
 * - Two-step New .hwdev project wizard automator ("New project" -> "Project properties") using
 *   UIA MenuItem/Start-page traversal, adjacent-Label ComboBox binding, resolution/network-port
 *   configuration, and try/finally clipboard restoration.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HaiwellUiLabels {
  language: string;
  projectMenu: string;
  newProjectMenuItem: string;
  startPageNewProjectLink: string;
  newProjectModalTitle: string;
  saveDocumentLabel: string;
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
  startPageNewProjectLink: 'Create a new project...',
  newProjectModalTitle: 'New project',
  saveDocumentLabel: 'Save document:',
  newProjectDialogTitle: 'Project properties',
  projectNameLabel: 'Project name',
  runtimePlatformLabel: 'Runtime platform',
  deviceModelLabel: 'Device model',
  resolutionLabel: 'Resolution',
  networkProjectPortLabel: 'Port',
  okButton: 'OK',
  cancelButton: 'Cancel',
};

const HAIWELL_CONFIG_LANG_MAP: Record<string, string> = {
  '0': 'en',
  '1': 'zh-cn',
  '2': 'zh-tw',
  '3': 'portuguese',
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function normalizeHaiwellMnemonic(value: string): string {
  return value.replace(/\(#([A-Za-z0-9])\)/g, '($1)').trim();
}

function extractXmlStringTag(tagBody: string): { name: string; text: string } | null {
  const nameMatch = /\bname\s*=\s*"([^"]*)"/i.exec(tagBody);
  const textMatch = /\btext\s*=\s*"([^"]*)"/i.exec(tagBody);
  if (!nameMatch || !textMatch) return null;
  const name = decodeXmlEntities(nameMatch[1]).trim().toLowerCase();
  const text = normalizeHaiwellMnemonic(decodeXmlEntities(textMatch[1]));
  if (!name || !text) return null;
  return { name, text };
}

/**
 * Parses a HaiwellScada3 Language/*.lng file (XML <String name="..." text="..." />
 * or legacy INI key=value) and extracts localized UI labels for menus, dialogs,
 * and New Project controls.
 */
export function parseHaiwellLngContent(content: string, language = 'en'): HaiwellUiLabels {
  if (/<String\b/i.test(content)) {
    const groupMap = new Map<string, string>();
    const flatMap = new Map<string, string>();

    const groupRegex = /<Group\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/Group>/gi;
    let groupMatch: RegExpExecArray | null;
    while ((groupMatch = groupRegex.exec(content)) !== null) {
      const groupName = decodeXmlEntities(groupMatch[1]).trim().toLowerCase();
      const inner = groupMatch[2];
      const stringTagRegex = /<String\b([^>]*?)\/?>/gi;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringTagRegex.exec(inner)) !== null) {
        const parsed = extractXmlStringTag(strMatch[1]);
        if (!parsed) continue;
        const qualifiedKey = `${groupName}/${parsed.name}`;
        if (!groupMap.has(qualifiedKey)) groupMap.set(qualifiedKey, parsed.text);
        if (!flatMap.has(parsed.name)) flatMap.set(parsed.name, parsed.text);
      }
    }

    // Also capture any top-level <String ... /> outside <Group>
    const topStringRegex = /<String\b([^>]*?)\/?>/gi;
    let topMatch: RegExpExecArray | null;
    while ((topMatch = topStringRegex.exec(content)) !== null) {
      const parsed = extractXmlStringTag(topMatch[1]);
      if (parsed && !flatMap.has(parsed.name)) {
        flatMap.set(parsed.name, parsed.text);
      }
    }

    const pickXml = (qualifiedKeys: string[], flatKeys: string[], fallback: string): string => {
      for (const qk of qualifiedKeys) {
        const val = groupMap.get(qk.toLowerCase());
        if (val) return val;
      }
      for (const fk of flatKeys) {
        const val = flatMap.get(fk.toLowerCase());
        if (val) return val;
      }
      return fallback;
    };

    return {
      language,
      projectMenu: pickXml(['mainformclassics/mm_project'], ['mm_project'], DEFAULT_EN_LABELS.projectMenu),
      newProjectMenuItem: pickXml(
        ['mainformclassics/mm_project_newprj'],
        ['mm_project_newprj'],
        DEFAULT_EN_LABELS.newProjectMenuItem
      ),
      startPageNewProjectLink: pickXml(
        ['develop.develop.frmstart/lklblnewproject'],
        ['lklblnewproject'],
        DEFAULT_EN_LABELS.startPageNewProjectLink
      ),
      newProjectModalTitle: pickXml(
        ['develop.develop.frmnewproject/windowtext', 'frmnewproject/newproject'],
        ['newproject'],
        DEFAULT_EN_LABELS.newProjectModalTitle
      ),
      saveDocumentLabel: pickXml(
        ['develop.develop.frmnewproject/lblsavefile'],
        ['lblsavefile'],
        DEFAULT_EN_LABELS.saveDocumentLabel
      ),
      newProjectDialogTitle: pickXml(
        ['frmnewproject/window_text', 'develop_develop_frmprofile/project_property', 'frmnewproject/projectattr'],
        ['window_text', 'project_property'],
        DEFAULT_EN_LABELS.newProjectDialogTitle
      ),
      projectNameLabel: pickXml(
        ['develop.develop.frmnewproject/lblprojectname', 'frmnewproject/projectname'],
        ['lblprojectname', 'projectname'],
        DEFAULT_EN_LABELS.projectNameLabel
      ),
      runtimePlatformLabel: pickXml(
        ['frmnewproject/runtimeplatform'],
        ['runtimeplatform'],
        DEFAULT_EN_LABELS.runtimePlatformLabel
      ),
      deviceModelLabel: pickXml(
        ['frmaddserver/lbldevicemodel'],
        ['lbldevicemodel'],
        DEFAULT_EN_LABELS.deviceModelLabel
      ),
      resolutionLabel: pickXml(
        ['hwcontrolmediaplayer/labresolution'],
        ['labresolution', 'lblresolution'],
        DEFAULT_EN_LABELS.resolutionLabel
      ),
      networkProjectPortLabel: pickXml(
        ['frmaddserver/port', 'frmopcuaconfig/port'],
        ['port'],
        DEFAULT_EN_LABELS.networkProjectPortLabel
      ),
      okButton: pickXml(
        ['develop.develop.frmnewproject/btnok', 'frmnewproject/ok'],
        ['btnok'],
        DEFAULT_EN_LABELS.okButton
      ),
      cancelButton: pickXml(
        ['frmnewproject/cancel', 'develop.develop.frmnewproject/btncancel'],
        ['btncancel'],
        DEFAULT_EN_LABELS.cancelButton
      ),
    };
  }

  // Legacy INI/key=value fallback
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
    startPageNewProjectLink: pick(
      ['lklblnewproject', 'create_new_project'],
      DEFAULT_EN_LABELS.startPageNewProjectLink
    ),
    newProjectModalTitle: pick(
      ['new_project_modal', 'new_project_dialog'],
      DEFAULT_EN_LABELS.newProjectModalTitle
    ),
    saveDocumentLabel: pick(
      ['lblsavefile', 'save_document', 'save_file'],
      DEFAULT_EN_LABELS.saveDocumentLabel
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
        const raw = m[1].trim().toLowerCase();
        lang = HAIWELL_CONFIG_LANG_MAP[raw] ?? raw;
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

function queryHaiwellInstallDirFromRegistry(): string | null {
  if (process.platform !== 'win32') return null;
  const regKeys = [
    'HKLM\\SOFTWARE\\Classes\\Haiwell.HaiwellScada3\\shell\\open\\command',
    'HKCU\\SOFTWARE\\Classes\\Haiwell.HaiwellScada3\\shell\\open\\command',
  ];
  for (const key of regKeys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true,
      });
      const regMatch = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(output);
      if (!regMatch) continue;
      const rawValue = regMatch[1].trim();
      const quotedExe = /^"([^"]+\.exe)"/i.exec(rawValue);
      const unquotedExe = /^([^\s"]+\.exe)/i.exec(rawValue);
      const exePath = quotedExe?.[1] ?? unquotedExe?.[1];
      if (exePath) {
        return path.dirname(exePath);
      }
    } catch {
      // Registry key unavailable; continue probing fallback paths
    }
  }
  return null;
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
  const explicitDir = installDirInput?.trim();
  let resolvedDir: string;

  if (explicitDir) {
    resolvedDir = explicitDir;
  } else {
    const rawCandidates = [
      process.env.HAIWELL_INSTALL_DIR,
      process.env.HAIWELL_SCADA_DIR,
      queryHaiwellInstallDirFromRegistry(),
      'C:\\Program Files (x86)\\Haiwell\\HaiwellScada3',
      'C:\\Program Files\\Haiwell\\HaiwellScada3',
      'D:\\Haiwell\\HaiwellScada3',
      'C:\\Program Files (x86)\\HaiwellScada3',
      'C:\\Program Files\\HaiwellScada3',
      'D:\\HaiwellScada3',
    ].filter((d): d is string => Boolean(d && d.trim()));

    const deduped = [...new Set(rawCandidates.map((d) => d.trim()))];
    const withExe = deduped.find((dir) => fs.existsSync(path.join(dir, 'Scada.Develop.exe')));
    const existingDir = deduped.find((dir) => fs.existsSync(dir));
    resolvedDir = withExe ?? existingDir ?? 'C:\\Program Files (x86)\\Haiwell\\HaiwellScada3';
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

function escapePsRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMatchText(label: string): string {
  return label
    .replace(/\([^)]*\)/g, '')
    .replace(/\.+$/g, '')
    .replace(/[:：]+$/g, '')
    .trim();
}

export function buildLaunchPowerShellScript(options: {
  exePath: string;
  projectFilePath?: string;
  timeoutSec: number;
}): string {
  const exeEsc = escapePsSingleQuoted(options.exePath);
  const argClause = options.projectFilePath
    ? `-ArgumentList @('"${escapePsSingleQuoted(options.projectFilePath)}"')`
    : '';
  const timeoutSec = Math.max(5, Math.min(options.timeoutSec, 120));

  return [
    `$ErrorActionPreference = 'Stop'`,
    `$existing = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Haiwell Cloud Scada' } | Select-Object -First 1`,
    `if (-not $existing) {`,
    `  $otherProc = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `  if ($otherProc) {`,
    `    $canReadPath = $false`,
    `    try { $canReadPath = [bool]$otherProc.Path } catch { $canReadPath = $false }`,
    `    if (-not $canReadPath) {`,
    `      throw "DESKTOP_WINDOW_INACCESSIBLE: Scada.Develop (PID $($otherProc.Id)) is already running with higher Windows elevation (UIPI). Restart the MCP server / terminal as Administrator."`,
    `    }`,
    `    if ($otherProc.MainWindowHandle -eq 0) {`,
    `      throw "DESKTOP_WINDOW_INACCESSIBLE: Scada.Develop (PID $($otherProc.Id)) is already running, but its UI window handle is 0 (inaccessible from this desktop session). Run the MCP server on the interactive WinSta0\\Default desktop."`,
    `    }`,
    `  }`,
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

  if (!info.exeExists) {
    throw new Error(`DESKTOP_EXE_NOT_FOUND: Scada.Develop.exe was not found at "${info.exePath}".`);
  }

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
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
    const detail = e.stderr?.trim() || e.message || 'Unknown error launching Scada.Develop.exe';
    if (e.code === 'EACCES' || e.code === 'EPERM' || /not supported|access is denied/i.test(detail)) {
      throw new Error(
        `OS_PERMISSION_DENIED: Cannot launch "${info.exePath}" (${e.code ?? 'SANDBOX_BLOCK'}). Run the MCP server with matching Windows desktop elevation.`
      );
    }
    throw new Error(`DESKTOP_LAUNCH_FAILED: ${detail}`);
  }
}

export interface NewDesktopProjectOptions {
  projectName: string;
  saveDirectory?: string;
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
  const saveDir = options.saveDirectory ? escapePsSingleQuoted(options.saveDirectory) : '';
  const runtimePlatform = escapePsSingleQuoted(options.runtimePlatform ?? 'Cloud HMI');
  const deviceModel = escapePsSingleQuoted(options.deviceModel ?? 'Haiwell HMI B7H');
  const resolution = escapePsSingleQuoted((options.resolution ?? '1024x600').replace(/\*/g, 'x'));
  const port = Number.isInteger(options.networkProjectPort) ? String(options.networkProjectPort) : '8888';

  const projMenuNorm = escapePsSingleQuoted(normalizeMatchText(labels.projectMenu).toLowerCase());
  const newItemNorm = escapePsSingleQuoted(normalizeMatchText(labels.newProjectMenuItem).toLowerCase());
  const startLinkNorm = escapePsSingleQuoted(normalizeMatchText(labels.startPageNewProjectLink).toLowerCase());
  const step1TitleRegex = escapePsSingleQuoted(
    `(?i)(${escapePsRegex(normalizeMatchText(labels.newProjectModalTitle))}|New project)`
  );
  const step2TitleRegex = escapePsSingleQuoted(
    `(?i)(${escapePsRegex(normalizeMatchText(labels.newProjectDialogTitle))}|Project properties|FrmNewProject)`
  );
  const eitherDialogRegex = escapePsSingleQuoted(
    `(?i)(${escapePsRegex(normalizeMatchText(labels.newProjectModalTitle))}|New project|${escapePsRegex(normalizeMatchText(labels.newProjectDialogTitle))}|Project properties|FrmNewProject)`
  );
  const nameLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.projectNameLabel));
  const saveLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.saveDocumentLabel));
  const platformLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.runtimePlatformLabel));
  const modelLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.deviceModelLabel));
  const resLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.resolutionLabel));
  const portLblNorm = escapePsSingleQuoted(normalizeMatchText(labels.networkProjectPortLabel));
  const okBtnRegex = escapePsSingleQuoted(
    `(?i)^(${escapePsRegex(normalizeMatchText(labels.okButton))}|OK|Confirm)$`
  );

  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    ``,
    `function Get-AdjacentControl($dialog, [string]$labelText, $controlType) {`,
    `  $allText = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))`,
    `  $normTarget = ($labelText -replace '[:：\\s]+$', '').Trim().ToLower()`,
    `  $escapedTarget = [regex]::Escape($normTarget)`,
    `  $exactMatch = $null; $wordMatch = $null; $subMatch = $null`,
    `  foreach ($t in $allText) {`,
    `    if (-not $t.Current.Name -or $t.Current.IsOffscreen) { continue }`,
    `    $tr = $t.Current.BoundingRectangle`,
    `    if ($tr.Width -le 0 -or $tr.Height -le 0) { continue }`,
    `    $normName = ($t.Current.Name -replace '[:：\\s]+$', '').Trim().ToLower()`,
    `    if ($normName -eq $normTarget) { $exactMatch = $t; break }`,
    `    if (-not $wordMatch -and ($normName -match ("(?i)(?:^|\\b)" + $escapedTarget + "(?:\\b|$)"))) { $wordMatch = $t }`,
    `    if (-not $subMatch -and $normName.Contains($normTarget)) { $subMatch = $t }`,
    `  }`,
    `  $labelEl = if ($exactMatch) { $exactMatch } elseif ($wordMatch) { $wordMatch } else { $subMatch }`,
    `  if (-not $labelEl) { return $null }`,
    `  $lr = $labelEl.Current.BoundingRectangle`,
    `  $lMidY = $lr.Top + ($lr.Height / 2.0)`,
    `  $candidates = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)))`,
    `  $best = $null; $bestScore = [double]::MaxValue`,
    `  foreach ($c in $candidates) {`,
    `    if ($c.Current.IsOffscreen) { continue }`,
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
    `  if (-not $el -or [string]::IsNullOrEmpty($val)) { return $false }`,
    `  $vp = $null`,
    `  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {`,
    `    if ($vp.Current.IsReadOnly) { return $false }`,
    `    $vp.SetValue($val)`,
    `    return $true`,
    `  }`,
    `  $hadText = $false`,
    `  $wasEmpty = $false`,
    `  $prevClip = $null`,
    `  try {`,
    `    if ([System.Windows.Forms.Clipboard]::ContainsText()) {`,
    `      $hadText = $true`,
    `      $prevClip = [System.Windows.Forms.Clipboard]::GetText()`,
    `    } else {`,
    `      $dataObj = [System.Windows.Forms.Clipboard]::GetDataObject()`,
    `      $wasEmpty = ($null -eq $dataObj) -or ($dataObj.GetFormats().Length -eq 0)`,
    `    }`,
    `    $el.SetFocus()`,
    `    [System.Windows.Forms.Clipboard]::SetText($val)`,
    `    [System.Windows.Forms.SendKeys]::SendWait('^a^v')`,
    `    Start-Sleep -Milliseconds 120`,
    `    return $true`,
    `  } finally {`,
    `    if ($hadText -and $null -ne $prevClip) { [System.Windows.Forms.Clipboard]::SetText($prevClip) } elseif ($wasEmpty) { [System.Windows.Forms.Clipboard]::Clear() }`,
    `  }`,
    `}`,
    ``,
    `function Select-ComboByText($combo, [string]$targetText) {`,
    `  if (-not $combo) { return $false }`,
    `  $variants = @($targetText)`,
    `  if ($targetText -match '\\d+[xX*]\\d+') {`,
    `    $variants = @($targetText, ($targetText -replace '[xX]', '*'), ($targetText -replace '\\*', 'x')) | Select-Object -Unique`,
    `  }`,
    `  $ec = $null`,
    `  if ($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {`,
    `    $ec.Expand()`,
    `    Start-Sleep -Milliseconds 120`,
    `  }`,
    `  $listCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)`,
    `  $items = $combo.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)`,
    `  foreach ($variant in $variants) {`,
    `    foreach ($it in $items) {`,
    `      if ($it.Current.Name -and $it.Current.Name.ToLower().Contains($variant.ToLower())) {`,
    `        $sel = $null`,
    `        if ($it.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {`,
    `          $sel.Select()`,
    `          return $true`,
    `        }`,
    `      }`,
    `    }`,
    `  }`,
    `  $comboPid = $combo.Current.ProcessId`,
    `  $rootChildren = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)`,
    `  foreach ($variant in $variants) {`,
    `    foreach ($rc in $rootChildren) {`,
    `      if ($rc.Current.ProcessId -ne $comboPid) { continue }`,
    `      $popItems = $rc.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)`,
    `      foreach ($it in $popItems) {`,
    `        if ($it.Current.Name -and $it.Current.Name.ToLower().Contains($variant.ToLower())) {`,
    `          $sel = $null`,
    `          if ($it.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {`,
    `            $sel.Select()`,
    `            return $true`,
    `          }`,
    `        }`,
    `      }`,
    `    }`,
    `  }`,
    `  return (Set-EditSafe $combo $targetText)`,
    `}`,
    ``,
    `function Invoke-DialogOkButton($dialog, [string]$btnPattern) {`,
    `  $btns = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))`,
    `  foreach ($b in $btns) {`,
    `    if ($b.Current.Name -and $b.Current.Name -match $btnPattern) {`,
    `      $inv = $null`,
    `      if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke(); return $true }`,
    `    }`,
    `  }`,
    `  return $false`,
    `}`,
    ``,
    `function Find-HaiwellDialog($parentWin, [int]$pidFilter, [IntPtr]$mainHandle, [string]$titleRegex, [int]$timeoutMs = 5000) {`,
    `  $winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)`,
    `  $deadline = (Get-Date).AddMilliseconds($timeoutMs)`,
    `  $mainHwndLong = $mainHandle.ToInt64()`,
    `  while ((Get-Date) -lt $deadline) {`,
    `    foreach ($w in $parentWin.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {`,
    `      if ($w.Current.Name -and $w.Current.Name -match $titleRegex) { return $w }`,
    `    }`,
    `    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {`,
    `      if ($w.Current.ProcessId -eq $pidFilter -and [Int64]$w.Current.NativeWindowHandle -ne $mainHwndLong -and $w.Current.Name -and $w.Current.Name -match $titleRegex) { return $w }`,
    `    }`,
    `    Start-Sleep -Milliseconds 150`,
    `  }`,
    `  return $null`,
    `}`,
    ``,
    `$proc = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Haiwell Cloud Scada' } | Select-Object -First 1`,
    `if (-not $proc) {`,
    `  $anyProc = Get-Process -Name 'Scada.Develop' -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `  if ($anyProc) {`,
    `    $canReadPath = $false`,
    `    try { $canReadPath = [bool]$anyProc.Path } catch { $canReadPath = $false }`,
    `    if (-not $canReadPath) {`,
    `      throw "DESKTOP_WINDOW_INACCESSIBLE: Scada.Develop (PID $($anyProc.Id)) is running with higher Windows elevation (UIPI). Restart the MCP server / terminal as Administrator."`,
    `    }`,
    `    throw "DESKTOP_WINDOW_INACCESSIBLE: Scada.Develop (PID $($anyProc.Id)) is running, but its main window handle is 0 (inaccessible from this desktop session). Ensure the MCP server runs on the interactive WinSta0\\Default desktop."`,
    `  }`,
    `  throw 'Haiwell Cloud Scada main window is not running. Call haiwell_desktop_launch first.'`,
    `}`,
    `$mainWin = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)`,
    ``,
    `# 1. Open Project -> New project via UIA MenuItem first (locale-safe), Start Page link second, Alt+P,W fallback`,
    `$openedNew = $false`,
    `$menuItems = $mainWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))`,
    `foreach ($mi in $menuItems) {`,
    `  if ($mi.Current.Name -and $mi.Current.Name.ToLower().Contains('${projMenuNorm}')) {`,
    `    $ec = $null`,
    `    if ($mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {`,
    `      $ec.Expand()`,
    `      Start-Sleep -Milliseconds 150`,
    `      $subItems = $mainWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))`,
    `      foreach ($sub in $subItems) {`,
    `        if ($sub.Current.Name -and $sub.Current.Name.ToLower().Contains('${newItemNorm}')) {`,
    `          $inv = $null`,
    `          if ($sub.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke(); $openedNew = $true; break }`,
    `        }`,
    `      }`,
    `    }`,
    `    if ($openedNew) { break }`,
    `  }`,
    `}`,
    `if (-not $openedNew) {`,
    `  $links = $mainWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)))`,
    `  foreach ($lk in $links) {`,
    `    if ($lk.Current.Name -and $lk.Current.Name.ToLower().Contains('${startLinkNorm}')) {`,
    `      $inv = $null`,
    `      if ($lk.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke(); $openedNew = $true; break }`,
    `    }`,
    `  }`,
    `}`,
    `if (-not $openedNew) {`,
    `  $mainWin.SetFocus()`,
    `  [System.Windows.Forms.SendKeys]::SendWait('%pw')`,
    `}`,
    ``,
    `# 2. Handle two-step modal sequence: Step A "New project" (FrmNewProject name/path) -> Step B "Project properties" (hardware/resolution)`,
    `$dlg = Find-HaiwellDialog $mainWin $proc.Id $proc.MainWindowHandle '${eitherDialogRegex}' 5000`,
    `if (-not $dlg) { throw 'New Project dialog did not appear.' }`,
    `$nameSetInStep1 = $false`,
    `$isStep1 = ($dlg.Current.Name -match '${step1TitleRegex}') -or ($null -ne (Get-AdjacentControl $dlg '${saveLblNorm}' ([System.Windows.Automation.ControlType]::Edit)))`,
    `if ($isStep1) {`,
    `  $step1NameEdit = Get-AdjacentControl $dlg '${nameLblNorm}' ([System.Windows.Automation.ControlType]::Edit)`,
    `  if (Set-EditSafe $step1NameEdit '${projectName}') { $nameSetInStep1 = $true }`,
    `  $saveEdit = Get-AdjacentControl $dlg '${saveLblNorm}' ([System.Windows.Automation.ControlType]::Edit)`,
    `  if ($saveEdit -and '${saveDir}') { Set-EditSafe $saveEdit '${saveDir}' | Out-Null }`,
    `  if (-not (Invoke-DialogOkButton $dlg '${okBtnRegex}')) { throw "Failed to invoke OK button on New Project step 1 dialog '$($dlg.Current.Name)'." }`,
    `  Start-Sleep -Milliseconds 350`,
    `  $dlg = Find-HaiwellDialog $mainWin $proc.Id $proc.MainWindowHandle '${step2TitleRegex}' 5000`,
    `}`,
    `if (-not $dlg) { throw 'New Project properties dialog did not appear.' }`,
    ``,
    `# 3. Populate Project properties controls strictly by adjacent Label bounding-box lookup`,
    `if (-not $nameSetInStep1) {`,
    `  $nameEdit = Get-AdjacentControl $dlg '${nameLblNorm}' ([System.Windows.Automation.ControlType]::Edit)`,
    `  Set-EditSafe $nameEdit '${projectName}' | Out-Null`,
    `}`,
    `$platformCombo = Get-AdjacentControl $dlg '${platformLblNorm}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `$modelCombo = Get-AdjacentControl $dlg '${modelLblNorm}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `if ($modelCombo) {`,
    `  Select-ComboByText $platformCombo '${runtimePlatform}' | Out-Null`,
    `  Select-ComboByText $modelCombo '${deviceModel}' | Out-Null`,
    `} else {`,
    `  if (-not (Select-ComboByText $platformCombo '${deviceModel}')) {`,
    `    Select-ComboByText $platformCombo '${runtimePlatform}' | Out-Null`,
    `  }`,
    `}`,
    `$resCombo = Get-AdjacentControl $dlg '${resLblNorm}' ([System.Windows.Automation.ControlType]::ComboBox)`,
    `Select-ComboByText $resCombo '${resolution}' | Out-Null`,
    `$portEdit = Get-AdjacentControl $dlg '${portLblNorm}' ([System.Windows.Automation.ControlType]::Edit)`,
    `Set-EditSafe $portEdit '${port}' | Out-Null`,
    ``,
    `# 4. Confirm Project properties dialog via OK button`,
    `if (-not (Invoke-DialogOkButton $dlg '${okBtnRegex}')) { throw "Failed to invoke OK button on Project Properties dialog '$($dlg.Current.Name)'." }`,
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

  if (!info.exeExists) {
    throw new Error(`DESKTOP_EXE_NOT_FOUND: Scada.Develop.exe was not found at "${info.exePath}".`);
  }

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { timeout: 30_000 }
    );
    return {
      executed: true,
      dryRun: false,
      result: JSON.parse(stdout.trim() || '{}'),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.trim() || e.message || 'Unknown UIA failure';
    if (e.code === 'EACCES' || e.code === 'EPERM' || /not supported|access is denied/i.test(detail)) {
      throw new Error(
        `OS_PERMISSION_DENIED: Cannot execute PowerShell UIA automation (${e.code ?? 'SANDBOX_BLOCK'}).`
      );
    }
    throw new Error(`DESKTOP_NEW_PROJECT_FAILED: ${detail}`);
  }
}

export interface HwExportImportScriptOptions {
  hwdevPath: string;
  hwExportPath: string;
  deleteWindowPrefixes?: string[];
  haiwellExePath?: string;
}

/**
 * Generates a self-contained Python pywinauto UIA script that deletes old target windows
 * (without touching 1:Main_display), imports a .hwExport file into Project display,
 * and saves the .hwdev project. Requires Administrator elevation because Scada.Develop.exe
 * runs elevated (Windows UIPI).
 */
export function buildHwExportImportScript(options: HwExportImportScriptOptions): string {
  const exePath =
    options.haiwellExePath ?? 'C:\\Program Files (x86)\\Haiwell\\HaiwellScada3\\Scada.Develop.exe';
  const prefixes = JSON.stringify(options.deleteWindowPrefixes ?? []);
  return `import ctypes, json, shutil, subprocess, sys, time
from pathlib import Path
from pywinauto import Desktop, keyboard

HAIWELL_EXE = ${JSON.stringify(exePath)}
HWDEV_PATH = Path(${JSON.stringify(options.hwdevPath)})
HWEXPORT_PATH = Path(${JSON.stringify(options.hwExportPath)})
DELETE_PREFIXES = ${prefixes}

if not ctypes.windll.shell32.IsUserAnAdmin():
    print("Run from an Administrator PowerShell (Scada.Develop.exe requires elevation).", file=sys.stderr)
    sys.exit(2)

shutil.copy2(HWDEV_PATH, HWDEV_PATH.with_suffix(".hwdev.bak"))

def find_win():
    for w in Desktop(backend="uia").windows(title_re=r"(?i)^Haiwell Cloud Scada\\\\[.*"):
        if w.is_visible() and w.rectangle().width() > 600:
            return w
    return None

main_win = find_win()
if main_win is None:
    subprocess.Popen([HAIWELL_EXE, str(HWDEV_PATH)])
    for _ in range(50):
        main_win = find_win()
        if main_win is not None:
            break
        time.sleep(0.8)
if main_win is None:
    raise RuntimeError("Timed out waiting for Haiwell Cloud Scada")

main_win.set_focus()
time.sleep(1.5)

def find_item(prefix, exact=False):
    for it in main_win.descendants(control_type="TreeItem"):
        t = it.window_text()
        if (t == prefix) if exact else (t == prefix or t.startswith(prefix)):
            return it
    return None

def click_menu(names):
    time.sleep(0.35)
    for w in Desktop(backend="uia").windows():
        if w.process_id() == main_win.process_id():
            for mi in w.descendants(control_type="MenuItem"):
                if any(mi.window_text().strip().lower().startswith(n.lower()) for n in names):
                    mi.click_input()
                    return True
    return False

for p in DELETE_PREFIXES:
    it = find_item(p)
    if it:
        it.click_input(button="right")
        if not click_menu(("Delete",)):
            it.click_input()
            keyboard.send_keys("{DELETE}")
        time.sleep(0.4)
        keyboard.send_keys("{ENTER}")
        time.sleep(0.4)

pdisp = find_item("Project display", exact=True)
pdisp.click_input(button="right")
if not click_menu(("Import",)):
    raise RuntimeError("Import menu item not found")
time.sleep(0.8)
file_dlg = next((w for w in Desktop(backend="uia").windows() if w.process_id() == main_win.process_id() and w.handle != main_win.handle and w.is_visible()), None)
if file_dlg is None:
    raise RuntimeError("File Open dialog not found")
edits = file_dlg.descendants(control_type="Edit")
target_edit = next((e for e in edits if (e.element_info.automation_id or "").strip() == "1148"), None)
if target_edit is None:
    target_edit = next((e for e in edits if (e.element_info.name or "").strip().lower() in ("file name:", "file name")), None)
if target_edit is None:
    raise RuntimeError("File name Edit box (auto_id='1148') not found")
target_edit.click_input()
keyboard.send_keys("^a{BACKSPACE}")
target_edit.set_edit_text(str(HWEXPORT_PATH))
ok_btn = next((b for b in file_dlg.descendants(control_type="Button") if (b.element_info.automation_id or "").strip() == "1"), None)
if ok_btn is not None:
    ok_btn.click_input()
else:
    keyboard.send_keys("{ENTER}")
time.sleep(2.0)
keyboard.send_keys("^s")
`;
}

export interface AutoSyncWatcherOptions {
  inboxDir: string;
  defaultHwdevPath: string;
  haiwellExePath?: string;
}

/**
 * Generates a self-contained elevated Python pywinauto UIA watch-folder daemon
 * that monitors inboxDir for *.deploy.json jobs, imports .hwExport into Haiwell
 * Cloud Scada automatically (strictly targeting File name auto_id="1148"),
 * saves the .hwdev, and writes last_result.json.
 */
export function buildAutoSyncWatcherScript(options: AutoSyncWatcherOptions): string {
  const exePath =
    options.haiwellExePath ?? 'C:\\Program Files (x86)\\Haiwell\\HaiwellScada3\\Scada.Develop.exe';
  return `import ctypes, json, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
from pywinauto import Desktop, keyboard

HAIWELL_EXE = ${JSON.stringify(exePath)}
DEFAULT_HWDEV = Path(${JSON.stringify(options.defaultHwdevPath)})
INBOX_DIR = Path(${JSON.stringify(options.inboxDir)})
DONE_DIR = INBOX_DIR / "done"
HEARTBEAT_FILE = INBOX_DIR / "watcher.heartbeat.json"
RESULT_FILE = INBOX_DIR / "last_result.json"

if not ctypes.windll.shell32.IsUserAnAdmin():
    print("Run from an Administrator PowerShell (Scada.Develop.exe requires elevation).", file=sys.stderr)
    sys.exit(2)

INBOX_DIR.mkdir(parents=True, exist_ok=True)
DONE_DIR.mkdir(parents=True, exist_ok=True)

def find_win():
    for w in Desktop(backend="uia").windows(title_re=r"(?i)^Haiwell Cloud Scada\\\\[.*"):
        if w.is_visible() and w.rectangle().width() > 600:
            return w
    return None

while True:
    HEARTBEAT_FILE.write_text(json.dumps({"pid": ctypes.windll.kernel32.GetCurrentProcessId(), "updatedAt": time.time(), "inboxDir": str(INBOX_DIR)}), encoding="utf-8")
    for jf in sorted(INBOX_DIR.glob("*.deploy.json")):
        try:
            job = json.loads(jf.read_text(encoding="utf-8"))
            hwdev = Path(job.get("hwdevPath") or DEFAULT_HWDEV)
            hwexp = Path(job["hwExportPath"])
            if hwdev.exists():
                shutil.copy2(hwdev, hwdev.with_suffix(".hwdev.bak"))
            main_win = find_win()
            if main_win is None:
                subprocess.Popen([HAIWELL_EXE, str(hwdev)])
                for _ in range(50):
                    main_win = find_win()
                    if main_win is not None:
                        break
                    time.sleep(0.8)
            if main_win is None:
                raise RuntimeError("Timed out waiting for Haiwell Cloud Scada")
            main_win.set_focus()
            pdisp = next((it for it in main_win.descendants(control_type="TreeItem") if it.window_text() == "Project display"), None)
            if pdisp is None:
                raise RuntimeError("Project display not found")
            pdisp.click_input(button="right")
            time.sleep(0.35)
            keyboard.send_keys("{DOWN}{ENTER}")
            time.sleep(0.8)
            file_dlg = next((w for w in Desktop(backend="uia").windows() if w.process_id() == main_win.process_id() and w.handle != main_win.handle and w.is_visible()), None)
            if file_dlg is None:
                raise RuntimeError("File Open dialog not found")
            edits = file_dlg.descendants(control_type="Edit")
            target_edit = next((e for e in edits if (e.element_info.automation_id or "").strip() == "1148"), None)
            if target_edit is None:
                raise RuntimeError("File name Edit box (auto_id='1148') not found")
            target_edit.click_input()
            keyboard.send_keys("^a{BACKSPACE}")
            target_edit.set_edit_text(str(hwexp))
            ok_btn = next((b for b in file_dlg.descendants(control_type="Button") if (b.element_info.automation_id or "").strip() == "1"), None)
            if ok_btn is not None:
                ok_btn.click_input()
            else:
                keyboard.send_keys("{ENTER}")
            time.sleep(1.5)
            keyboard.send_keys("^s")
            RESULT_FILE.write_text(json.dumps({"jobId": job.get("jobId", jf.stem), "ok": True, "importedWindows": [], "timestamp": datetime.now(timezone.utc).isoformat(), "error": None}), encoding="utf-8")
        except Exception as exc:
            RESULT_FILE.write_text(json.dumps({"jobId": jf.stem, "ok": False, "importedWindows": [], "timestamp": datetime.now(timezone.utc).isoformat(), "error": str(exc)}), encoding="utf-8")
        shutil.move(str(jf), str(DONE_DIR / jf.name))
    time.sleep(1.0)
`;
}

export interface HeadlessTaskUpsert {
  name: string;
  script: string;
  memo?: string;
}

export interface HeadlessHwExportDeployOptions {
  hwdevPath: string;
  hwExportPath: string;
  installDir?: string;
  deleteWindowPrefixes?: string[];
  enableAlwaysCollectFullNames?: string[];
  upsertTasks?: HeadlessTaskUpsert[];
  replaceExistingVariableGroups?: boolean;
  startupWindowId?: number;
  createBackup?: boolean;
  timeoutMs?: number;
}

export interface HeadlessDeployedWindowInfo {
  id: number;
  windowId: number;
  name: string;
  docBytes?: number;
}

export interface HeadlessHwExportDeployResult {
  ok: boolean;
  projectName: string;
  hwdevPath: string;
  hwExportPath: string;
  installDir: string;
  backupPath: string | null;
  deletedWindows: string[];
  importedWindows: HeadlessDeployedWindowInfo[];
  allUserWindows: HeadlessDeployedWindowInfo[];
  importedVariableGroups: string[];
  importedTasks: string[];
  upsertedTasks: string[];
  alwaysCollectUpdated: string[];
  startupWindowId: number | null;
  importedEventsCount: number;
  activeGuiWarning: string | null;
  error?: string | null;
}

export function getSysWow64PowerShellPath(): string {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const wow64Ps = path.join(sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (process.platform === 'win32' && fs.existsSync(wow64Ps)) {
    return wow64Ps;
  }
  return 'powershell.exe';
}

export function canRunHeadlessDotNetDeploy(installDir?: string): {
  available: boolean;
  installDir: string;
  powershell32Path: string;
  reason?: string;
} {
  const info = inspectHaiwellDesktopInstallation(installDir);
  const powershell32Path = getSysWow64PowerShellPath();
  if (process.platform !== 'win32') {
    return {
      available: false,
      installDir: info.installDir,
      powershell32Path,
      reason: 'NON_WINDOWS_HOST',
    };
  }
  const requiredFiles = ['Scada.Common.dll', 'Scada.Project.dll', 'Scada.Develop.exe'];
  const missing = requiredFiles.filter((f) => !fs.existsSync(path.join(info.installDir, f)));
  if (missing.length > 0) {
    return {
      available: false,
      installDir: info.installDir,
      powershell32Path,
      reason: `MISSING_HAIWELL_ASSEMBLIES: ${missing.join(', ')} in "${info.installDir}"`,
    };
  }
  return {
    available: true,
    installDir: info.installDir,
    powershell32Path,
  };
}

/**
 * Generates a self-contained 32-bit PowerShell + .NET script that imports a native
 * .hwExport XML file directly into an encrypted Haiwell .hwdev SQLite project using
 * Haiwell's own official installed assemblies (Scada.Common.dll, Scada.Project.dll,
 * Scada.Develop.exe) — with ZERO GUI, ZERO UIA clicking, ZERO mouse/keyboard input,
 * ZERO UAC/Admin elevation, and ZERO Python dependency.
 */
export function buildHeadlessHwExportDeployScript(options: HeadlessHwExportDeployOptions): string {
  const info = inspectHaiwellDesktopInstallation(options.installDir);
  const payload = {
    installDir: info.installDir,
    hwdevPath: options.hwdevPath,
    hwExportPath: options.hwExportPath,
    deleteWindowPrefixes: (options.deleteWindowPrefixes ?? []).filter((p) => p.trim().length > 0),
    enableAlwaysCollectFullNames: (options.enableAlwaysCollectFullNames ?? []).filter((p) => p.trim().length > 0),
    upsertTasks: (options.upsertTasks ?? []).map((t) => ({
      name: t.name,
      script: t.script,
      memo: t.memo ?? '',
    })),
    replaceExistingVariableGroups: options.replaceExistingVariableGroups !== false,
    startupWindowId: options.startupWindowId ?? 0,
    createBackup: options.createBackup !== false,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

  return [
    `$ErrorActionPreference = 'Stop'`,
    `$cfgJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadB64}'))`,
    `$cfg = $cfgJson | ConvertFrom-Json`,
    `$deletePrefixes = [string[]]@()`,
    `if ($null -ne $cfg.deleteWindowPrefixes) { $deletePrefixes = [string[]]@($cfg.deleteWindowPrefixes) }`,
    `$alwaysCollectPatterns = [string[]]@()`,
    `if ($null -ne $cfg.enableAlwaysCollectFullNames) { $alwaysCollectPatterns = [string[]]@($cfg.enableAlwaysCollectFullNames) }`,
    `$upsertTaskNames = [string[]]@()`,
    `$upsertTaskScripts = [string[]]@()`,
    `$upsertTaskMemos = [string[]]@()`,
    `if ($null -ne $cfg.upsertTasks) {`,
    `  foreach ($ut in @($cfg.upsertTasks)) {`,
    `    $upsertTaskNames += [string]$ut.name`,
    `    $upsertTaskScripts += [string]$ut.script`,
    `    $upsertTaskMemos += [string]$ut.memo`,
    `  }`,
    `}`,
    ``,
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Collections;`,
    `using System.Collections.Generic;`,
    `using System.Data;`,
    `using System.Diagnostics;`,
    `using System.IO;`,
    `using System.Reflection;`,
    `using System.Windows.Forms;`,
    `using System.Xml;`,
    ``,
    `public sealed class HwHeadlessWindowItem {`,
    `    public int id { get; set; }`,
    `    public int windowId { get; set; }`,
    `    public string name { get; set; }`,
    `    public int docBytes { get; set; }`,
    `}`,
    ``,
    `public sealed class HwHeadlessDeployOutcome {`,
    `    public bool ok { get; set; }`,
    `    public string projectName { get; set; }`,
    `    public string hwdevPath { get; set; }`,
    `    public string hwExportPath { get; set; }`,
    `    public string installDir { get; set; }`,
    `    public string backupPath { get; set; }`,
    `    public List<string> deletedWindows { get; set; }`,
    `    public List<HwHeadlessWindowItem> importedWindows { get; set; }`,
    `    public List<HwHeadlessWindowItem> allUserWindows { get; set; }`,
    `    public List<string> importedVariableGroups { get; set; }`,
    `    public List<string> importedTasks { get; set; }`,
    `    public List<string> upsertedTasks { get; set; }`,
    `    public List<string> alwaysCollectUpdated { get; set; }`,
    `    public int startupWindowId { get; set; }`,
    `    public int importedEventsCount { get; set; }`,
    `    public string activeGuiWarning { get; set; }`,
    `    public string error { get; set; }`,
    `}`,
    ``,
    `public static class HwHeadlessDeployer {`,
    `    private static void ClearSqlitePools(string installDir) {`,
    `        try {`,
    `            var sqlDll = Path.Combine(installDir, "System.Data.SQLite.dll");`,
    `            if (File.Exists(sqlDll)) {`,
    `                var sqlAsm = Assembly.LoadFrom(sqlDll);`,
    `                var connType = sqlAsm.GetType("System.Data.SQLite.SQLiteConnection");`,
    `                if (connType != null) {`,
    `                    var clearMeth = connType.GetMethod("ClearAllPools", BindingFlags.Public | BindingFlags.Static);`,
    `                    if (clearMeth != null) clearMeth.Invoke(null, null);`,
    `                }`,
    `            }`,
    `        } catch {}`,
    `    }`,
    ``,
    `    private static string DetectActiveGuiConflict(string openingFile, string hwdevPath, string projectName, out bool isExactOpeningEntry) {`,
    `        isExactOpeningEntry = false;`,
    `        try {`,
    `            if (string.IsNullOrEmpty(openingFile) || !File.Exists(openingFile)) return null;`,
    `            var doc = new XmlDocument();`,
    `            doc.Load(openingFile);`,
    `            string fullTarget = Path.GetFullPath(hwdevPath);`,
    `            var nodes = doc.SelectNodes("//Project");`,
    `            if (nodes == null) return null;`,
    `            foreach (XmlNode node in nodes) {`,
    `                if (node.Attributes == null) continue;`,
    `                string pPath = node.Attributes["path"] != null ? node.Attributes["path"].Value : "";`,
    `                string pName = node.Attributes["name"] != null ? node.Attributes["name"].Value : "";`,
    `                string pidStr = node.Attributes["processId"] != null ? node.Attributes["processId"].Value : "";`,
    `                int pid = 0;`,
    `                if (!int.TryParse(pidStr, out pid) || pid <= 0) continue;`,
    `                bool alive = false;`,
    `                try {`,
    `                    var proc = Process.GetProcessById(pid);`,
    `                    alive = !proc.HasExited && proc.ProcessName.IndexOf("Scada", StringComparison.OrdinalIgnoreCase) >= 0;`,
    `                } catch { alive = false; }`,
    `                if (!alive) continue;`,
    `                bool pathMatch = false;`,
    `                try { pathMatch = !string.IsNullOrEmpty(pPath) && string.Equals(Path.GetFullPath(pPath), fullTarget, StringComparison.OrdinalIgnoreCase); } catch {}`,
    `                bool nameMatch = !string.IsNullOrEmpty(projectName) && string.Equals(pName, projectName, StringComparison.OrdinalIgnoreCase);`,
    `                if (pathMatch) isExactOpeningEntry = true;`,
    `                if (pathMatch || nameMatch) {`,
    `                    return "Haiwell Cloud Scada GUI (PID " + pid + ") currently has project '" + pName + "' open in memory (" + pPath + "). Close and reopen '" + hwdevPath + "' in Haiwell Cloud Scada (do NOT press Ctrl+S in the stale GUI window, or it will overwrite this deployment).";`,
    `                }`,
    `            }`,
    `        } catch {}`,
    `        return null;`,
    `    }`,
    ``,
    `    private static bool MatchesAlwaysCollect(string fullName, string[] patterns) {`,
    `        if (string.IsNullOrEmpty(fullName) || patterns == null) return false;`,
    `        foreach (var raw in patterns) {`,
    `            string p = (raw ?? "").Trim();`,
    `            if (p.Length == 0) continue;`,
    `            if (p == "*") return true;`,
    `            if (p.EndsWith("*")) {`,
    `                string pre = p.Substring(0, p.Length - 1);`,
    `                if (fullName.StartsWith(pre, StringComparison.OrdinalIgnoreCase)) return true;`,
    `            } else if (string.Equals(fullName, p, StringComparison.OrdinalIgnoreCase)) {`,
    `                return true;`,
    `            }`,
    `        }`,
    `        return false;`,
    `    }`,
    ``,
    `    public static HwHeadlessDeployOutcome Run(string installDir, string hwdevPath, string hwExportPath, string[] deletePrefixes, string[] alwaysCollectPatterns, string[] upsertTaskNames, string[] upsertTaskScripts, string[] upsertTaskMemos, bool replaceExistingVariableGroups, int startupWindowNumber, bool createBackup) {`,
    `        var outcome = new HwHeadlessDeployOutcome {`,
    `            ok = false,`,
    `            projectName = "",`,
    `            hwdevPath = hwdevPath,`,
    `            hwExportPath = hwExportPath,`,
    `            installDir = installDir,`,
    `            backupPath = null,`,
    `            deletedWindows = new List<string>(),`,
    `            importedWindows = new List<HwHeadlessWindowItem>(),`,
    `            allUserWindows = new List<HwHeadlessWindowItem>(),`,
    `            importedVariableGroups = new List<string>(),`,
    `            importedTasks = new List<string>(),`,
    `            upsertedTasks = new List<string>(),`,
    `            alwaysCollectUpdated = new List<string>(),`,
    `            startupWindowId = 0,`,
    `            importedEventsCount = 0,`,
    `            activeGuiWarning = null,`,
    `            error = null,`,
    `        };`,
    ``,
    `        if (!Directory.Exists(installDir)) {`,
    `            outcome.error = "HAIWELL_INSTALL_DIR_NOT_FOUND: " + installDir;`,
    `            return outcome;`,
    `        }`,
    `        if (!File.Exists(hwdevPath)) {`,
    `            outcome.error = "HWDEV_NOT_FOUND: Target .hwdev project does not exist at " + hwdevPath;`,
    `            return outcome;`,
    `        }`,
    `        if (!File.Exists(hwExportPath)) {`,
    `            outcome.error = "HWEXPORT_NOT_FOUND: Compiled .hwExport file not found at " + hwExportPath;`,
    `            return outcome;`,
    `        }`,
    ``,
    `        string backupPath = hwdevPath + ".bak";`,
    `        bool backupCreated = false;`,
    `        bool mutationStarted = false;`,
    `        bool isExactOpeningEntry = false;`,
    `        object loaded = null;`,
    `        Type prjType = null;`,
    `        Form hiddenForm = null;`,
    ``,
    `        try {`,
    `            if (createBackup) {`,
    `                File.Copy(hwdevPath, backupPath, true);`,
    `                backupCreated = true;`,
    `                outcome.backupPath = backupPath;`,
    `            }`,
    ``,
    `            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);`,
    `            AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {`,
    `                string name = e.Name.Split(',')[0].Trim();`,
    `                if (!seen.Add(name)) return null;`,
    `                foreach (var ext in new[] { ".dll", ".exe" }) {`,
    `                    string p = Path.Combine(installDir, name + ext);`,
    `                    if (File.Exists(p)) return Assembly.LoadFrom(p);`,
    `                }`,
    `                return null;`,
    `            };`,
    ``,
    `            Environment.CurrentDirectory = installDir;`,
    `            var startupField = typeof(Application).GetField("startupPath", BindingFlags.Static | BindingFlags.NonPublic);`,
    `            var execField = typeof(Application).GetField("executablePath", BindingFlags.Static | BindingFlags.NonPublic);`,
    `            if (startupField != null) startupField.SetValue(null, installDir);`,
    `            if (execField != null) execField.SetValue(null, Path.Combine(installDir, "Scada.Develop.exe"));`,
    ``,
    `            var asmCommon = Assembly.LoadFrom(Path.Combine(installDir, "Scada.Common.dll"));`,
    `            var asmPrj = Assembly.LoadFrom(Path.Combine(installDir, "Scada.Project.dll"));`,
    `            var asmDev = Assembly.LoadFrom(Path.Combine(installDir, "Scada.Develop.exe"));`,
    ``,
    `            var hwCommon = asmCommon.GetType("Scada.Common.HwCommon");`,
    `            hwCommon.GetMethod("Init", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);`,
    `            var chField = hwCommon.GetField("ChangedName", BindingFlags.Public | BindingFlags.Static);`,
    `            if (chField != null && chField.GetValue(null) == null) {`,
    `                chField.SetValue(null, Activator.CreateInstance(chField.FieldType));`,
    `            }`,
    ``,
    `            var devCommon = asmDev.GetType("Scada.Develop.DevCommon");`,
    `            var mfType = devCommon.GetField("MainForm", BindingFlags.Public | BindingFlags.Static).FieldType;`,
    `            var mf = Activator.CreateInstance(mfType);`,
    `            hiddenForm = mf as Form;`,
    `            var ppField = mfType.GetField("panelProject", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);`,
    `            if (ppField != null) ppField.SetValue(mf, Activator.CreateInstance(ppField.FieldType));`,
    `            var poField = mfType.GetField("panelOutput", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);`,
    `            if (poField != null && poField.FieldType.GetConstructor(Type.EmptyTypes) != null) {`,
    `                poField.SetValue(mf, Activator.CreateInstance(poField.FieldType));`,
    `            }`,
    `            devCommon.GetField("MainForm", BindingFlags.Public | BindingFlags.Static).SetValue(null, mf);`,
    ``,
    `            prjType = asmPrj.GetType("Scada.Project.Project");`,
    `            var prj = Activator.CreateInstance(prjType);`,
    `            loaded = prjType.GetMethod("Load").Invoke(prj, new object[] { hwdevPath, false, hiddenForm, false, null });`,
    `            if (loaded == null) {`,
    `                throw new InvalidOperationException("HWDEV_LOAD_FAILED: Scada.Project.Project.Load returned null (file may be password-protected or corrupted).");`,
    `            }`,
    `            devCommon.GetField("Project", BindingFlags.Public | BindingFlags.Static).SetValue(null, loaded);`,
    `            outcome.projectName = Convert.ToString(prjType.GetProperty("Name").GetValue(loaded, null) ?? "");`,
    ``,
    `            var hwPathObj = hwCommon.GetField("Path", BindingFlags.Public | BindingFlags.Static).GetValue(null);`,
    `            string openingFile = hwPathObj != null ? Convert.ToString(hwPathObj.GetType().GetProperty("OpeningFile").GetValue(hwPathObj, null) ?? "") : "";`,
    `            outcome.activeGuiWarning = DetectActiveGuiConflict(openingFile, hwdevPath, outcome.projectName, out isExactOpeningEntry);`,
    ``,
    `            var exportModelType = asmDev.GetType("Scada.Develop.Export.HwExportModel");`,
    `            var model = exportModelType.GetMethod("GetModel", new[] { typeof(string) }).Invoke(null, new object[] { hwExportPath });`,
    `            if (model == null) {`,
    `                throw new InvalidOperationException("HWEXPORT_PARSE_FAILED: HwExportModel.GetModel returned null.");`,
    `            }`,
    ``,
    `            var winType = asmPrj.GetType("Scada.Project.Data.Model.window");`,
    `            var loadWins = prjType.GetMethod("LoadModelItems", Type.EmptyTypes).MakeGenericMethod(winType);`,
    `            var delWin = prjType.GetMethod("DeleteModel").MakeGenericMethod(winType);`,
    `            var getWinDoc = prjType.GetMethod("GetWindowDocument");`,
    `            var sqlType = asmPrj.GetType("Scada.Project.Data.ProjectSQLite");`,
    `            var queryTable = sqlType.GetMethod("QueryTable", new[] { typeof(string) });`,
    `            var execSql = sqlType.GetMethod("ExecuteSql", new[] { typeof(string) });`,
    `            var updateTable = sqlType.GetMethod("UpdateTable");`,
    `            var insertTable = sqlType.GetMethod("InsertTable");`,
    `            var getMaxId = sqlType.GetMethod("GetMaxID", new[] { typeof(string), typeof(string) });`,
    `            Func<string, DataTable> Q = (sql) => (DataTable)queryTable.Invoke(null, new object[] { sql });`,
    `            Func<string, int> E = (sql) => Convert.ToInt32(execSql.Invoke(null, new object[] { sql }));`,
    ``,
    `            var preVgNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);`,
    `            foreach (DataRow r in Q("SELECT Name FROM variableGroup").Rows) preVgNames.Add(Convert.ToString(r["Name"] ?? ""));`,
    `            var preTaskNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);`,
    `            foreach (DataRow r in Q("SELECT Name FROM task").Rows) preTaskNames.Add(Convert.ToString(r["Name"] ?? ""));`,
    `            int preEventCount = Convert.ToInt32(Q("SELECT count(*) FROM eventItem").Rows[0][0]);`,
    ``,
    `            mutationStarted = true;`,
    ``,
    `            if (deletePrefixes != null && deletePrefixes.Length > 0) {`,
    `                var existingWins = (IList)loadWins.Invoke(loaded, null);`,
    `                foreach (var w in existingWins) {`,
    `                    int hwSys = Convert.ToInt32(winType.GetProperty("HwSys").GetValue(w, null));`,
    `                    if (hwSys != 0) continue;`,
    `                    int id = Convert.ToInt32(winType.GetProperty("ID").GetValue(w, null));`,
    `                    int wid = Convert.ToInt32(winType.GetProperty("WindowID").GetValue(w, null));`,
    `                    string wName = Convert.ToString(winType.GetProperty("Name").GetValue(w, null) ?? "");`,
    `                    string label = wid + ":" + wName;`,
    `                    bool shouldDelete = false;`,
    `                    foreach (var rawP in deletePrefixes) {`,
    `                        string p = (rawP ?? "").Trim();`,
    `                        if (p.Length == 0) continue;`,
    `                        if (wid == 1) {`,
    `                            if (p.StartsWith("1:", StringComparison.OrdinalIgnoreCase) || string.Equals(p, wName, StringComparison.OrdinalIgnoreCase)) {`,
    `                                shouldDelete = true; break;`,
    `                            }`,
    `                            continue;`,
    `                        }`,
    `                        if (label.StartsWith(p, StringComparison.OrdinalIgnoreCase) || wName.StartsWith(p, StringComparison.OrdinalIgnoreCase)) {`,
    `                            shouldDelete = true; break;`,
    `                        }`,
    `                    }`,
    `                    if (shouldDelete) {`,
    `                        bool delOk = (bool)delWin.Invoke(loaded, new object[] { id, true });`,
    `                        if (delOk) outcome.deletedWindows.Add(label);`,
    `                    }`,
    `                }`,
    `            }`,
    ``,
    `            var preWinIds = new HashSet<int>();`,
    `            foreach (var w in (IList)loadWins.Invoke(loaded, null)) {`,
    `                if (Convert.ToInt32(winType.GetProperty("HwSys").GetValue(w, null)) == 0) {`,
    `                    preWinIds.Add(Convert.ToInt32(winType.GetProperty("ID").GetValue(w, null)));`,
    `                }`,
    `            }`,
    ``,
    `            var vgProp = exportModelType.GetProperty("VariableGroups").GetValue(model, null);`,
    `            if (vgProp != null && Convert.ToBoolean(vgProp.GetType().GetProperty("HasValue").GetValue(vgProp, null))) {`,
    `                if (replaceExistingVariableGroups) {`,
    `                    try {`,
    `                        var expXml = new XmlDocument();`,
    `                        expXml.Load(hwExportPath);`,
    `                        var vgNodes = expXml.SelectNodes("//VariableGroups//ListVariableGroup//VariableGroup/Name | //VariableGroups//VariableGroup/Name");`,
    `                        if (vgNodes != null) {`,
    `                            foreach (XmlNode vn in vgNodes) {`,
    `                                string gName = (vn.InnerText ?? "").Trim();`,
    `                                if (gName.Length == 0) continue;`,
    `                                string gEsc = gName.Replace("'", "''");`,
    `                                var gRows = Q("SELECT ID FROM variableGroup WHERE lower(Name) = lower('" + gEsc + "')").Rows;`,
    `                                foreach (DataRow gr in gRows) {`,
    `                                    int gid = Convert.ToInt32(gr["ID"]);`,
    `                                    E("DELETE FROM variable WHERE GroupId = " + gid);`,
    `                                    E("DELETE FROM variableGroup WHERE ID = " + gid);`,
    `                                    preVgNames.Remove(gName);`,
    `                                }`,
    `                            }`,
    `                        }`,
    `                    } catch {}`,
    `                }`,
    `                asmDev.GetType("Scada.Develop.Export.HwExportVariableGroup").GetMethod("AddModel").Invoke(null, new object[] { vgProp });`,
    `            }`,
    ``,
    `            var winProp = exportModelType.GetProperty("Windows").GetValue(model, null);`,
    `            if (winProp != null && Convert.ToBoolean(winProp.GetType().GetProperty("HasValue").GetValue(winProp, null))) {`,
    `                var winOk = Convert.ToBoolean(asmDev.GetType("Scada.Develop.Export.ImportExportWindow").GetMethod("AddModel").Invoke(null, new object[] { winProp }));`,
    `                if (!winOk) {`,
    `                    throw new InvalidOperationException("HWEXPORT_WINDOW_IMPORT_FAILED: ImportExportWindow.AddModel returned false.");`,
    `                }`,
    `            }`,
    ``,
    `            var taskProp = exportModelType.GetProperty("Tasks").GetValue(model, null);`,
    `            var evtProp = exportModelType.GetProperty("Events").GetValue(model, null);`,
    `            bool hasTasks = taskProp != null && Convert.ToBoolean(taskProp.GetType().GetProperty("HasValue").GetValue(taskProp, null));`,
    `            bool hasEvents = evtProp != null && Convert.ToBoolean(evtProp.GetType().GetProperty("HasValue").GetValue(evtProp, null));`,
    `            if (hasTasks) {`,
    `                object[] tArgs = new object[] { taskProp, evtProp, false, "" };`,
    `                asmDev.GetType("Scada.Develop.Export.HwExportTask").GetMethod("AddModel").Invoke(null, tArgs);`,
    `            }`,
    `            if (hasEvents) {`,
    `                int midEventCount = Convert.ToInt32(Q("SELECT count(*) FROM eventItem").Rows[0][0]);`,
    `                if (midEventCount == preEventCount) {`,
    `                    object[] eArgs = new object[] { evtProp, "" };`,
    `                    asmDev.GetType("Scada.Develop.Export.HwExportEvent").GetMethod("AddModel").Invoke(null, eArgs);`,
    `                }`,
    `            }`,
    ``,
    `            if (alwaysCollectPatterns != null && alwaysCollectPatterns.Length > 0) {`,
    `                foreach (DataRow vr in Q("SELECT ID, FullName, CollectionAlwaysEnabled FROM variable WHERE Name NOT LIKE '$%'").Rows) {`,
    `                    string fn = Convert.ToString(vr["FullName"] ?? "");`,
    `                    int alw = vr["CollectionAlwaysEnabled"] == DBNull.Value ? 0 : Convert.ToInt32(vr["CollectionAlwaysEnabled"]);`,
    `                    if (alw == 1) continue;`,
    `                    if (MatchesAlwaysCollect(fn, alwaysCollectPatterns)) {`,
    `                        int vid = Convert.ToInt32(vr["ID"]);`,
    `                        E("UPDATE variable SET CollectionAlwaysEnabled = 1 WHERE ID = " + vid);`,
    `                        outcome.alwaysCollectUpdated.Add(fn);`,
    `                    }`,
    `                }`,
    `            }`,
    ``,
    `            if (upsertTaskNames != null && upsertTaskNames.Length > 0) {`,
    `                for (int ti = 0; ti < upsertTaskNames.Length; ti++) {`,
    `                    string tName = (upsertTaskNames[ti] ?? "").Trim();`,
    `                    if (tName.Length == 0) continue;`,
    `                    string tScript = upsertTaskScripts != null && ti < upsertTaskScripts.Length ? (upsertTaskScripts[ti] ?? "") : "";`,
    `                    string tMemo = upsertTaskMemos != null && ti < upsertTaskMemos.Length ? (upsertTaskMemos[ti] ?? "") : "";`,
    `                    string tEsc = tName.Replace("'", "''");`,
    `                    var existingT = Q("SELECT ID, ContentId FROM task WHERE lower(Name) = lower('" + tEsc + "')").Rows;`,
    `                    if (existingT.Count > 0) {`,
    `                        int tid = Convert.ToInt32(existingT[0]["ID"]);`,
    `                        int cid = existingT[0]["ContentId"] == DBNull.Value ? tid : Convert.ToInt32(existingT[0]["ContentId"]);`,
    `                        var docHt = new Hashtable();`,
    `                        docHt["Script"] = tScript;`,
    `                        docHt["CompileScript"] = tScript;`,
    `                        updateTable.Invoke(null, new object[] { "taskDocument", docHt, "ID=" + cid, null });`,
    `                        if (tMemo.Length > 0) {`,
    `                            var tHt = new Hashtable();`,
    `                            tHt["Memo"] = tMemo;`,
    `                            updateTable.Invoke(null, new object[] { "task", tHt, "ID=" + tid, null });`,
    `                        }`,
    `                        outcome.upsertedTasks.Add(tName + " (updated ID=" + tid + ")");`,
    `                    } else {`,
    `                        int newDocId = Convert.ToInt32(getMaxId.Invoke(null, new object[] { "ID", "taskDocument" })) + 1;`,
    `                        int newTaskId = Convert.ToInt32(getMaxId.Invoke(null, new object[] { "ID", "task" })) + 1;`,
    `                        var docHt = new Hashtable();`,
    `                        docHt["ID"] = newDocId;`,
    `                        docHt["HwSys"] = 0;`,
    `                        docHt["Config"] = "";`,
    `                        docHt["Script"] = tScript;`,
    `                        docHt["CompileScript"] = tScript;`,
    `                        docHt["VariableId"] = "";`,
    `                        insertTable.Invoke(null, new object[] { "taskDocument", docHt, null });`,
    `                        var tHt = new Hashtable();`,
    `                        tHt["ID"] = newTaskId;`,
    `                        tHt["HwSys"] = 0;`,
    `                        tHt["Name"] = tName;`,
    `                        tHt["Type"] = 0;`,
    `                        tHt["Memo"] = tMemo;`,
    `                        tHt["IsAutoCreate"] = 0;`,
    `                        tHt["OrderId"] = newTaskId;`,
    `                        tHt["ContentId"] = newDocId;`,
    `                        tHt["ClassifyId"] = 0;`,
    `                        insertTable.Invoke(null, new object[] { "task", tHt, null });`,
    `                        outcome.upsertedTasks.Add(tName + " (inserted ID=" + newTaskId + ")");`,
    `                    }`,
    `                }`,
    `            }`,
    ``,
    `            foreach (var w in (IList)loadWins.Invoke(loaded, null)) {`,
    `                if (Convert.ToInt32(winType.GetProperty("HwSys").GetValue(w, null)) != 0) continue;`,
    `                int id = Convert.ToInt32(winType.GetProperty("ID").GetValue(w, null));`,
    `                int wid = Convert.ToInt32(winType.GetProperty("WindowID").GetValue(w, null));`,
    `                string wName = Convert.ToString(winType.GetProperty("Name").GetValue(w, null) ?? "");`,
    `                outcome.allUserWindows.Add(new HwHeadlessWindowItem { id = id, windowId = wid, name = wName, docBytes = 0 });`,
    `                if (!preWinIds.Contains(id)) {`,
    `                    string docXml = Convert.ToString(getWinDoc.Invoke(loaded, new object[] { id, true }) ?? "");`,
    `                    outcome.importedWindows.Add(new HwHeadlessWindowItem { id = id, windowId = wid, name = wName, docBytes = docXml.Length });`,
    `                }`,
    `            }`,
    ``,
    `            foreach (DataRow r in Q("SELECT Name FROM variableGroup").Rows) {`,
    `                string n = Convert.ToString(r["Name"] ?? "");`,
    `                if (!preVgNames.Contains(n)) outcome.importedVariableGroups.Add(n);`,
    `            }`,
    `            foreach (DataRow r in Q("SELECT Name FROM task").Rows) {`,
    `                string n = Convert.ToString(r["Name"] ?? "");`,
    `                if (!preTaskNames.Contains(n)) outcome.importedTasks.Add(n);`,
    `            }`,
    `            int postEventCount = Convert.ToInt32(Q("SELECT count(*) FROM eventItem").Rows[0][0]);`,
    `            outcome.importedEventsCount = Math.Max(0, postEventCount - preEventCount);`,
    ``,
    `            // Ensure project.StartWindowId points to a valid user window (auto-heal when Window 1 is replaced)`,
    `            try {`,
    `                int curStartId = 0;`,
    `                var prjRows = Q("SELECT StartWindowId FROM project").Rows;`,
    `                if (prjRows.Count > 0 && prjRows[0]["StartWindowId"] != DBNull.Value) {`,
    `                    curStartId = Convert.ToInt32(prjRows[0]["StartWindowId"]);`,
    `                }`,
    `                bool curValid = false;`,
    `                HwHeadlessWindowItem preferredWin = null;`,
    `                HwHeadlessWindowItem lowestWin = null;`,
    `                int targetWinNum = startupWindowNumber > 0 ? startupWindowNumber : 1;`,
    `                foreach (var w in outcome.allUserWindows) {`,
    `                    if (w.id == curStartId) curValid = true;`,
    `                    if (w.windowId == targetWinNum) preferredWin = w;`,
    `                    if (lowestWin == null || w.windowId < lowestWin.windowId) lowestWin = w;`,
    `                }`,
    `                if (startupWindowNumber > 0 || !curValid) {`,
    `                    var chosen = preferredWin ?? lowestWin;`,
    `                    if (chosen != null) {`,
    `                        E("UPDATE project SET StartWindowId = " + chosen.id);`,
    `                        curStartId = chosen.id;`,
    `                    }`,
    `                }`,
    `                outcome.startupWindowId = curStartId;`,
    `            } catch {}`,
    ``,
    `            outcome.ok = true;`,
    `        } catch (Exception ex) {`,
    `            Exception root = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;`,
    `            outcome.ok = false;`,
    `            outcome.error = root.GetType().Name + ": " + root.Message;`,
    `            ClearSqlitePools(installDir);`,
    `            if (mutationStarted && backupCreated && File.Exists(backupPath)) {`,
    `                try {`,
    `                    GC.Collect();`,
    `                    GC.WaitForPendingFinalizers();`,
    `                    File.Copy(backupPath, hwdevPath, true);`,
    `                } catch {}`,
    `            }`,
    `        } finally {`,
    `            if (loaded != null && prjType != null && !isExactOpeningEntry) {`,
    `                try { prjType.GetMethod("RemoveFromOpeningProject").Invoke(loaded, new object[] { hwdevPath }); } catch {}`,
    `            }`,
    `            ClearSqlitePools(installDir);`,
    `            if (hiddenForm != null) {`,
    `                try { hiddenForm.Dispose(); } catch {}`,
    `            }`,
    `        }`,
    `        return outcome;`,
    `    }`,
    `}`,
    `'@ -ReferencedAssemblies System.Windows.Forms, System.Data, System.Xml`,
    ``,
    `$res = [HwHeadlessDeployer]::Run($cfg.installDir, $cfg.hwdevPath, $cfg.hwExportPath, $deletePrefixes, $alwaysCollectPatterns, $upsertTaskNames, $upsertTaskScripts, $upsertTaskMemos, [bool]$cfg.replaceExistingVariableGroups, [int]$cfg.startupWindowId, [bool]$cfg.createBackup)`,
    `Write-Output ("__HW_HEADLESS_RESULT__:" + ($res | ConvertTo-Json -Depth 6 -Compress))`,
    `if (-not $res.ok) { exit 1 }`,
  ].join('\n');
}

export async function deployHwExportHeadless(
  options: HeadlessHwExportDeployOptions
): Promise<HeadlessHwExportDeployResult> {
  const check = canRunHeadlessDotNetDeploy(options.installDir);
  if (!check.available) {
    return {
      ok: false,
      projectName: '',
      hwdevPath: options.hwdevPath,
      hwExportPath: options.hwExportPath,
      installDir: check.installDir,
      backupPath: null,
      deletedWindows: [],
      importedWindows: [],
      allUserWindows: [],
      importedVariableGroups: [],
      importedTasks: [],
      upsertedTasks: [],
      alwaysCollectUpdated: [],
      startupWindowId: null,
      importedEventsCount: 0,
      activeGuiWarning: null,
      error: check.reason ?? 'HEADLESS_DOTNET_UNAVAILABLE',
    };
  }

  const psScript = buildHeadlessHwExportDeployScript({
    ...options,
    installDir: check.installDir,
  });
  const tmpPs1Path = path.join(
    os.tmpdir(),
    `haiwell_headless_deploy_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`
  );

  const parseMarker = (text: string): HeadlessHwExportDeployResult | null => {
    const marker = '__HW_HEADLESS_RESULT__:';
    const idx = text.lastIndexOf(marker);
    if (idx < 0) return null;
    const line = text.slice(idx + marker.length).split(/\r?\n/)[0]?.trim();
    if (!line) return null;
    try {
      const parsed = JSON.parse(line) as Partial<HeadlessHwExportDeployResult>;
      return {
        ok: Boolean(parsed.ok),
        projectName: String(parsed.projectName ?? ''),
        hwdevPath: String(parsed.hwdevPath ?? options.hwdevPath),
        hwExportPath: String(parsed.hwExportPath ?? options.hwExportPath),
        installDir: String(parsed.installDir ?? check.installDir),
        backupPath: parsed.backupPath ? String(parsed.backupPath) : null,
        deletedWindows: Array.isArray(parsed.deletedWindows) ? parsed.deletedWindows.map(String) : [],
        importedWindows: Array.isArray(parsed.importedWindows)
          ? parsed.importedWindows.map((w) => ({
              id: Number(w.id),
              windowId: Number(w.windowId),
              name: String(w.name ?? ''),
              docBytes: Number(w.docBytes ?? 0),
            }))
          : [],
        allUserWindows: Array.isArray(parsed.allUserWindows)
          ? parsed.allUserWindows.map((w) => ({
              id: Number(w.id),
              windowId: Number(w.windowId),
              name: String(w.name ?? ''),
            }))
          : [],
        importedVariableGroups: Array.isArray(parsed.importedVariableGroups)
          ? parsed.importedVariableGroups.map(String)
          : [],
        importedTasks: Array.isArray(parsed.importedTasks) ? parsed.importedTasks.map(String) : [],
        upsertedTasks: Array.isArray(parsed.upsertedTasks) ? parsed.upsertedTasks.map(String) : [],
        alwaysCollectUpdated: Array.isArray(parsed.alwaysCollectUpdated) ? parsed.alwaysCollectUpdated.map(String) : [],
        startupWindowId: typeof parsed.startupWindowId === 'number' && parsed.startupWindowId > 0 ? parsed.startupWindowId : null,
        importedEventsCount: Number(parsed.importedEventsCount ?? 0),
        activeGuiWarning: parsed.activeGuiWarning ? String(parsed.activeGuiWarning) : null,
        error: parsed.error ? String(parsed.error) : null,
      };
    } catch {
      return null;
    }
  };

  try {
    fs.writeFileSync(tmpPs1Path, psScript, 'utf8');
    const { stdout } = await execFileAsync(
      check.powershell32Path,
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Path],
      { timeout: options.timeoutMs ?? 45_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = parseMarker(stdout);
    if (parsed) return parsed;
    return {
      ok: false,
      projectName: '',
      hwdevPath: options.hwdevPath,
      hwExportPath: options.hwExportPath,
      installDir: check.installDir,
      backupPath: null,
      deletedWindows: [],
      importedWindows: [],
      allUserWindows: [],
      importedVariableGroups: [],
      importedTasks: [],
      upsertedTasks: [],
      alwaysCollectUpdated: [],
      startupWindowId: null,
      importedEventsCount: 0,
      activeGuiWarning: null,
      error: `HEADLESS_OUTPUT_PARSE_ERROR: ${stdout.trim().slice(0, 400)}`,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const parsed = parseMarker(e.stdout ?? '');
    if (parsed) return parsed;
    const detail = (e.stderr || e.stdout || e.message || 'Unknown headless deployment failure').trim();
    return {
      ok: false,
      projectName: '',
      hwdevPath: options.hwdevPath,
      hwExportPath: options.hwExportPath,
      installDir: check.installDir,
      backupPath: null,
      deletedWindows: [],
      importedWindows: [],
      allUserWindows: [],
      importedVariableGroups: [],
      importedTasks: [],
      upsertedTasks: [],
      alwaysCollectUpdated: [],
      startupWindowId: null,
      importedEventsCount: 0,
      activeGuiWarning: null,
      error: detail,
    };
  } finally {
    try {
      fs.rmSync(tmpPs1Path, { force: true });
    } catch {
      // ignore temp script cleanup failure
    }
  }
}

export interface DeployHwExportOptions {
  xml: string;
  fileName: string;
  hwdevPath: string;
  outputDir: string;
  inboxDir?: string;
  installDir?: string;
  deleteWindowPrefixes?: string[];
  enableAlwaysCollectFullNames?: string[];
  upsertTasks?: HeadlessTaskUpsert[];
  replaceExistingVariableGroups?: boolean;
  startupWindowId?: number;
  deployMode?: 'auto' | 'headless' | 'watcher_or_bat';
  createBackup?: boolean;
  dryRun?: boolean;
  waitTimeoutMs?: number;
}

export async function deployHwExportToDesktop(options: DeployHwExportOptions) {
  const hwExportPath = path.join(options.outputDir, options.fileName);
  const inboxDir = options.inboxDir ?? path.join(options.outputDir, 'inbox');
  const deployMode = options.deployMode ?? 'auto';
  const headlessCheck = canRunHeadlessDotNetDeploy(options.installDir);
  const headlessScript = buildHeadlessHwExportDeployScript({
    hwdevPath: options.hwdevPath,
    hwExportPath,
    installDir: options.installDir,
    deleteWindowPrefixes: options.deleteWindowPrefixes,
    enableAlwaysCollectFullNames: options.enableAlwaysCollectFullNames,
    upsertTasks: options.upsertTasks,
    replaceExistingVariableGroups: options.replaceExistingVariableGroups,
    startupWindowId: options.startupWindowId,
    createBackup: options.createBackup,
  });
  const deployScript = buildHwExportImportScript({
    hwdevPath: options.hwdevPath,
    hwExportPath,
    deleteWindowPrefixes: options.deleteWindowPrefixes,
    haiwellExePath: path.join(headlessCheck.installDir, 'Scada.Develop.exe'),
  });
  const watcherScript = buildAutoSyncWatcherScript({
    inboxDir,
    defaultHwdevPath: options.hwdevPath,
    haiwellExePath: path.join(headlessCheck.installDir, 'Scada.Develop.exe'),
  });

  if (options.dryRun || process.platform !== 'win32') {
    return {
      deployed: false,
      mode: 'DRY_RUN' as const,
      preferredLiveMode: headlessCheck.available ? ('HEADLESS_DOTNET_DIRECT' as const) : ('WATCHER_OR_BAT' as const),
      headlessAvailable: headlessCheck.available,
      hwExportPath,
      hwExportBytes: Buffer.byteLength(options.xml, 'utf8'),
      headlessScript,
      deployScript,
      watcherScript,
    };
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(hwExportPath, options.xml, 'utf8');

  // Primary zero-touch path: direct headless .hwExport -> .hwdev import via Haiwell's
  // official 32-bit .NET APIs (zero GUI, zero UIA, zero mouse/keyboard, zero UAC, zero Python).
  if (deployMode !== 'watcher_or_bat') {
    if (headlessCheck.available) {
      const headlessResult = await deployHwExportHeadless({
        hwdevPath: options.hwdevPath,
        hwExportPath,
        installDir: headlessCheck.installDir,
        deleteWindowPrefixes: options.deleteWindowPrefixes,
        enableAlwaysCollectFullNames: options.enableAlwaysCollectFullNames,
        upsertTasks: options.upsertTasks,
        replaceExistingVariableGroups: options.replaceExistingVariableGroups,
        startupWindowId: options.startupWindowId,
        createBackup: options.createBackup,
        timeoutMs: Math.max(options.waitTimeoutMs ?? 45_000, 30_000),
      });
      if (headlessResult.ok) {
        return {
          deployed: true,
          mode: 'HEADLESS_DOTNET_DIRECT' as const,
          hwdevPath: options.hwdevPath,
          hwExportPath,
          hwExportBytes: Buffer.byteLength(options.xml, 'utf8'),
          backupPath: headlessResult.backupPath,
          projectName: headlessResult.projectName,
          installDir: headlessResult.installDir,
          deletedWindows: headlessResult.deletedWindows,
          importedWindows: headlessResult.importedWindows,
          allUserWindows: headlessResult.allUserWindows,
          importedVariableGroups: headlessResult.importedVariableGroups,
          importedTasks: headlessResult.importedTasks,
          upsertedTasks: headlessResult.upsertedTasks,
          alwaysCollectUpdated: headlessResult.alwaysCollectUpdated,
          startupWindowId: headlessResult.startupWindowId,
          importedEventsCount: headlessResult.importedEventsCount,
          activeGuiWarning: headlessResult.activeGuiWarning,
        };
      }
      return {
        deployed: false,
        mode: 'HEADLESS_FAILED' as const,
        hwdevPath: options.hwdevPath,
        hwExportPath,
        hwExportBytes: Buffer.byteLength(options.xml, 'utf8'),
        backupPath: headlessResult.backupPath,
        activeGuiWarning: headlessResult.activeGuiWarning,
        error: headlessResult.error ?? 'Unknown headless .hwdev import failure',
      };
    }

    if (deployMode === 'headless') {
      return {
        deployed: false,
        mode: 'HEADLESS_FAILED' as const,
        hwdevPath: options.hwdevPath,
        hwExportPath,
        hwExportBytes: Buffer.byteLength(options.xml, 'utf8'),
        error: headlessCheck.reason ?? 'Haiwell Cloud Scada 32-bit assemblies not found locally.',
      };
    }
  }

  // Fallback legacy path (only when deployMode === 'watcher_or_bat' or HaiwellScada3 is not installed locally)
  fs.mkdirSync(inboxDir, { recursive: true });
  const heartbeatPath = path.join(inboxDir, 'watcher.heartbeat.json');
  const resultPath = path.join(inboxDir, 'last_result.json');
  let watcherFresh = false;
  if (fs.existsSync(heartbeatPath)) {
    try {
      const hb = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as { updatedAt?: number };
      const nowSec = Date.now() / 1000;
      if (typeof hb.updatedAt === 'number' && Math.abs(nowSec - hb.updatedAt) < 15) {
        watcherFresh = true;
      }
    } catch {
      watcherFresh = false;
    }
  }

  if (watcherFresh) {
    const jobId = `job_${Date.now()}`;
    const jobPath = path.join(inboxDir, `${jobId}.deploy.json`);
    fs.writeFileSync(
      jobPath,
      JSON.stringify(
        {
          jobId,
          hwdevPath: options.hwdevPath,
          hwExportPath,
          deleteWindowPrefixes: options.deleteWindowPrefixes ?? [],
          saveAfterImport: true,
        },
        null,
        2
      ),
      'utf8'
    );
    const deadline = Date.now() + (options.waitTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if (fs.existsSync(resultPath)) {
        try {
          const res = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
            jobId?: string;
            ok?: boolean;
            importedWindows?: string[];
            error?: string | null;
          };
          if (res.jobId === jobId) {
            return {
              deployed: Boolean(res.ok),
              mode: 'AUTO_SYNC_WATCHER' as const,
              hwExportPath,
              result: res,
            };
          }
        } catch {
          // wait for complete JSON write
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return {
      deployed: false,
      mode: 'AUTO_SYNC_TIMEOUT' as const,
      hwExportPath,
      jobPath,
    };
  }

  const pyPath = path.join(options.outputDir, 'deploy_to_haiwell.py');
  const batPath = path.join(options.outputDir, 'Deploy_To_Haiwell.bat');
  fs.writeFileSync(pyPath, deployScript, 'utf8');
  fs.writeFileSync(
    batPath,
    `@echo off\nnet session >nul 2>&1\nif %errorlevel% neq 0 (\n  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"\n  exit /b\n)\npython "${pyPath}"\npause\n`,
    'utf8'
  );
  return {
    deployed: false,
    mode: 'QUEUED_WAITING_FOR_AUTOSYNC' as const,
    hwExportPath,
    oneClickLauncherBat: batPath,
    deployScript,
    watcherScript,
  };
}
