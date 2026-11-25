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
