/**
 * Shared HMI Visual Design System, WCAG Contrast Math, Surface Inheritance Resolver,
 * Text-Fit Estimator, Readability Auditor, and Deterministic Auto-Fixer.
 *
 * Used by hwExportCompiler.ts, hmiGenerator.ts, hmiTemplates.ts, and toolRegistry.ts
 * so SVG previews, visual audits, and Haiwell 3.50.x .hwExport binaries stay in lockstep.
 */

import type {
  HaiwellTargetHardware,
  HmiScreen,
  HmiThemeId,
  HmiVisualRole,
  HmiWidget,
  HmiWidgetType,
  TagDefinition,
} from './types';

export interface HmiThemeTokens {
  id: HmiThemeId;
  name: string;
  canvasBg: string;
  panelBg: string;
  panelBorder: string;
  panelHeaderBg: string;
  panelHeaderText: string;
  darkHeaderBg: string;
  darkHeaderBorder: string;
  darkHeaderText: string;
  cardBg: string;
  cardBorder: string;
  heroCardBg: string;
  heroCardBorder: string;
  dangerCardBg: string;
  dangerCardBorder: string;
  textPrimary: string;
  textSecondary: string;
  accentPrimary: string;
  accentSuccess: string;
  accentWarning: string;
  accentDanger: string;
  navBg: string;
  navActiveBg: string;
  navText: string;
  clockBg: string;
  clockText: string;
}

export const HMI_THEMES: Record<HmiThemeId, HmiThemeTokens> = {
  ISA_101_LIGHT: {
    id: 'ISA_101_LIGHT',
    name: 'ISA-101 Light Industrial',
    canvasBg: '#F1F5F9',
    panelBg: '#FFFFFF',
    panelBorder: '#CBD5E1',
    panelHeaderBg: '#E2E8F0',
    panelHeaderText: '#0F172A',
    darkHeaderBg: '#1E293B',
    darkHeaderBorder: '#0F172A',
    darkHeaderText: '#F8FAFC',
    cardBg: '#FFFFFF',
    cardBorder: '#94A3B8',
    heroCardBg: '#EFF6FF',
    heroCardBorder: '#2563EB',
    dangerCardBg: '#FEF2F2',
    dangerCardBorder: '#DC2626',
    textPrimary: '#0F172A',
    textSecondary: '#334155',
    accentPrimary: '#0284C7',
    accentSuccess: '#16A34A',
    accentWarning: '#D97706',
    accentDanger: '#DC2626',
    navBg: '#334155',
    navActiveBg: '#0369A1',
    navText: '#FFFFFF',
    clockBg: '#1E293B',
    clockText: '#38BDF8',
  },
  CONTROL_ROOM_DARK: {
    id: 'CONTROL_ROOM_DARK',
    name: 'Control Room Dark',
    canvasBg: '#0F172A',
    panelBg: '#1E293B',
    panelBorder: '#334155',
    panelHeaderBg: '#334155',
    panelHeaderText: '#F8FAFC',
    darkHeaderBg: '#020617',
    darkHeaderBorder: '#1E293B',
    darkHeaderText: '#F8FAFC',
    cardBg: '#1E293B',
    cardBorder: '#475569',
    heroCardBg: '#0C4A6E',
    heroCardBorder: '#38BDF8',
    dangerCardBg: '#450A0A',
    dangerCardBorder: '#F87171',
    textPrimary: '#F8FAFC',
    textSecondary: '#CBD5E1',
    accentPrimary: '#38BDF8',
    accentSuccess: '#22C55E',
    accentWarning: '#F59E0B',
    accentDanger: '#EF4444',
    navBg: '#1E293B',
    navActiveBg: '#0369A1',
    navText: '#F8FAFC',
    clockBg: '#020617',
    clockText: '#38BDF8',
  },
  HIGH_CONTRAST_TOUCH: {
    id: 'HIGH_CONTRAST_TOUCH',
    name: 'High-Contrast Plant Floor Touch',
    canvasBg: '#E2E8F0',
    panelBg: '#FFFFFF',
    panelBorder: '#475569',
    panelHeaderBg: '#0F172A',
    panelHeaderText: '#FFFFFF',
    darkHeaderBg: '#0F172A',
    darkHeaderBorder: '#020617',
    darkHeaderText: '#FFFFFF',
    cardBg: '#FFFFFF',
    cardBorder: '#334155',
    heroCardBg: '#DBEAFE',
    heroCardBorder: '#1D4ED8',
    dangerCardBg: '#FEE2E2',
    dangerCardBorder: '#B91C1C',
    textPrimary: '#020617',
    textSecondary: '#1E293B',
    accentPrimary: '#1D4ED8',
    accentSuccess: '#15803D',
    accentWarning: '#B45309',
    accentDanger: '#B91C1C',
    navBg: '#0F172A',
    navActiveBg: '#1D4ED8',
    navText: '#FFFFFF',
    clockBg: '#0F172A',
    clockText: '#7DD3FC',
  },
};

export function resolveScreenTheme(screen: Pick<HmiScreen, 'themeId' | 'backgroundColor'>): HmiThemeTokens {
  if (screen.themeId && Object.prototype.hasOwnProperty.call(HMI_THEMES, screen.themeId)) {
    return HMI_THEMES[screen.themeId];
  }
  const bg = parseHexColor(screen.backgroundColor);
  if (bg && relativeLuminance(bg) < 0.18) {
    return HMI_THEMES.CONTROL_ROOM_DARK;
  }
  return HMI_THEMES.ISA_101_LIGHT;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const NAMED_COLORS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  red: '#DC2626',
  green: '#16A34A',
  blue: '#2563EB',
  yellow: '#EAB308',
  gray: '#64748B',
  grey: '#64748B',
  silver: '#CBD5E1',
  navy: '#0F172A',
};

export function normalizeHexColor(input?: string | null): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, trimmed)) {
    return NAMED_COLORS[trimmed];
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (m3) {
    const [r, g, b] = m3[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const m6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (m6) {
    return `#${m6[1].toUpperCase()}`;
  }
  return null;
}

export function parseHexColor(input?: string | null): RgbColor | null {
  const hex = normalizeHexColor(input);
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

function srgbChannelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: RgbColor): number {
  return (
    0.2126 * srgbChannelToLinear(rgb.r) +
    0.7152 * srgbChannelToLinear(rgb.g) +
    0.0722 * srgbChannelToLinear(rgb.b)
  );
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const fg = parseHexColor(fgHex);
  const bg = parseHexColor(bgHex);
  if (!fg || !bg) return 1;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function isDarkColor(hex: string): boolean {
  const rgb = parseHexColor(hex);
  return rgb ? relativeLuminance(rgb) < 0.25 : false;
}

export function pickReadableTextColor(
  bgHex: string,
  preferredFg?: string,
  minRatio = 4.5
): string {
  const normBg = normalizeHexColor(bgHex) ?? '#FFFFFF';
  const normPref = normalizeHexColor(preferredFg);
  if (normPref && contrastRatio(normPref, normBg) >= minRatio) {
    return normPref;
  }
  const darkCandidate = '#0F172A';
  const lightCandidate = '#F8FAFC';
  return contrastRatio(lightCandidate, normBg) >= contrastRatio(darkCandidate, normBg)
    ? lightCandidate
    : darkCandidate;
}

export function getGroupPanelHeaderHeight(panel: HmiWidget): number {
  const themeProp = panel.props?.theme;
  if (themeProp === 'dark' || themeProp === 'light_banner') {
    return 0;
  }
  return Math.min(28, Math.max(22, Math.round(panel.height * 0.12)));
}

export function getGroupPanelColors(
  panel: HmiWidget,
  theme: HmiThemeTokens
): { bodyBg: string; border: string; headerBg: string; headerText: string; isDarkBar: boolean } {
  const propTheme = typeof panel.props?.theme === 'string' ? panel.props.theme : undefined;
  const customBg = normalizeHexColor(typeof panel.props?.backgroundColor === 'string' ? panel.props.backgroundColor : undefined);

  if (propTheme === 'dark') {
    const bg = customBg ?? theme.darkHeaderBg;
    return {
      bodyBg: bg,
      border: theme.darkHeaderBorder,
      headerBg: bg,
      headerText: pickReadableTextColor(bg, typeof panel.props?.color === 'string' ? panel.props.color : theme.darkHeaderText),
      isDarkBar: true,
    };
  }
  if (propTheme === 'light_banner') {
    const bg = customBg ?? '#FFFFFF';
    return {
      bodyBg: bg,
      border: theme.panelBorder,
      headerBg: bg,
      headerText: pickReadableTextColor(bg, typeof panel.props?.color === 'string' ? panel.props.color : '#0F172A'),
      isDarkBar: false,
    };
  }
  const bodyBg = customBg ?? theme.panelBg;
  const headerBg = theme.panelHeaderBg;
  return {
    bodyBg,
    border: theme.panelBorder,
    headerBg,
    headerText: pickReadableTextColor(headerBg, typeof panel.props?.color === 'string' ? panel.props.color : theme.panelHeaderText),
    isDarkBar: false,
  };
}

export interface WidgetSurfaceContext {
  enclosingPanel: HmiWidget | null;
  surfaceBg: string;
  isDarkSurface: boolean;
  defaultTextColor: string;
  secondaryTextColor: string;
}

/**
 * Resolves the actual painted background color directly underneath a widget
 * (smallest enclosing GROUP_PANEL or screen canvas background).
 * Critical for Haiwell Embedded Linux HMI runtimes where TxtBlock HWBackColor
 * is painted opaquely regardless of fill-opacity="0".
 */
export function resolveWidgetSurfaceContext(
  screen: HmiScreen,
  widget: HmiWidget
): WidgetSurfaceContext {
  const theme = resolveScreenTheme(screen);
  const cx = widget.x + widget.width / 2;
  const cy = widget.y + widget.height / 2;

  let enclosingPanel: HmiWidget | null = null;
  let smallestArea = Infinity;

  for (const candidate of screen.widgets) {
    if (candidate.id === widget.id || candidate.type !== 'GROUP_PANEL') continue;
    const containsCenter =
      cx >= candidate.x &&
      cx <= candidate.x + candidate.width &&
      cy >= candidate.y &&
      cy <= candidate.y + candidate.height;
    if (containsCenter) {
      const area = candidate.width * candidate.height;
      if (area < smallestArea) {
        smallestArea = area;
        enclosingPanel = candidate;
      }
    }
  }

  let surfaceBg = normalizeHexColor(screen.backgroundColor) ?? theme.canvasBg;
  if (enclosingPanel) {
    const panelColors = getGroupPanelColors(enclosingPanel, theme);
    const hdrH = getGroupPanelHeaderHeight(enclosingPanel);
    if (hdrH > 0 && cy < enclosingPanel.y + hdrH) {
      surfaceBg = panelColors.headerBg;
    } else {
      surfaceBg = panelColors.bodyBg;
    }
  }

  const dark = isDarkColor(surfaceBg);
  return {
    enclosingPanel,
    surfaceBg,
    isDarkSurface: dark,
    defaultTextColor: dark ? '#F8FAFC' : '#0F172A',
    secondaryTextColor: dark ? '#CBD5E1' : '#334155',
  };
}

/**
 * Computes safe horizontal text width for a dark banner/header GROUP_PANEL
 * so its title text never runs underneath right-aligned sibling widgets
 * (such as E-STOP lamps or HWClock4 widgets placed inside the same banner).
 */
export function computeBannerTitleAvailableWidth(screen: HmiScreen, bannerPanel: HmiWidget): number {
  const startX = bannerPanel.x + 14;
  let rightLimit = bannerPanel.x + bannerPanel.width - 14;
  for (const other of screen.widgets) {
    if (other.id === bannerPanel.id || other.type === 'GROUP_PANEL') continue;
    const verticalOverlap =
      other.y < bannerPanel.y + bannerPanel.height && other.y + other.height > bannerPanel.y;
    const insideHorizontal =
      other.x >= bannerPanel.x && other.x < bannerPanel.x + bannerPanel.width;
    if (verticalOverlap && insideHorizontal && other.x > startX + 40) {
      rightLimit = Math.min(rightLimit, other.x - 12);
    }
  }
  return Math.max(60, rightLimit - startX);
}

/**
 * Estimates horizontal pixel width of proportional Arial / IBM Plex Sans text.
 * Intentionally slightly conservative (+5% margin) to prevent Haiwell nowrap clipping.
 */
export function estimateTextWidthPx(text: string, fontSize: number, bold = false): number {
  if (!text) return 0;
  let units = 0;
  for (const ch of text) {
    if (ch === ' ' || ch === 'i' || ch === 'l' || ch === 'I' || ch === '.' || ch === ',' || ch === ':' || ch === '!' || ch === '|') {
      units += 0.36;
    } else if (ch === 'W' || ch === 'M' || ch === '@' || ch === '%' || ch === '—') {
      units += 0.88;
    } else if (ch >= 'A' && ch <= 'Z') {
      units += 0.70;
    } else if (ch >= '0' && ch <= '9') {
      units += 0.58;
    } else if (ch.charCodeAt(0) > 0x2e80) {
      // CJK full-width glyph
      units += 1.02;
    } else {
      units += 0.54;
    }
  }
  const weightFactor = bold ? 1.07 : 1.0;
  return Math.ceil(units * fontSize * weightFactor);
}

export function fitFontSizeToWidth(
  text: string,
  maxWidthPx: number,
  preferredSize: number,
  minSize = 8,
  bold = false
): number {
  if (!text || maxWidthPx <= 0) return Math.max(minSize, preferredSize);
  let size = preferredSize;
  while (size > minSize && estimateTextWidthPx(text, size, bold) > maxWidthPx) {
    size = Number((size - 0.5).toFixed(1));
  }
  return Math.max(minSize, size);
}

/**
 * Computes safe internal icon & caption geometry for BIT_BUTTON so its caption
 * never overflows below w.y + w.height regardless of button aspect ratio or scaling.
 */
export function computeBitButtonGeometry(w: HmiWidget): {
  mode: 'vertical' | 'horizontal';
  iconSize: number;
  iconX: number;
  iconY: number;
  labelX: number;
  labelY: number;
  labelW: number;
  labelH: number;
  labelAlign: 'left' | 'center';
} {
  if (w.height < 64 && w.width >= w.height * 1.8) {
    const iconSize = Math.max(20, Math.min(38, w.height - 8));
    const iconX = w.x + 6;
    const iconY = w.y + Math.round((w.height - iconSize) / 2);
    const labelH = Math.min(18, Math.max(14, w.height - 8));
    return {
      mode: 'horizontal',
      iconSize,
      iconX,
      iconY,
      labelX: iconX + iconSize + 6,
      labelY: w.y + Math.round((w.height - labelH) / 2),
      labelW: Math.max(24, w.width - iconSize - 18),
      labelH,
      labelAlign: 'left',
    };
  }
  const labelH = Math.min(18, Math.max(13, Math.floor(w.height * 0.28)));
  const gap = 2;
  const maxIconH = Math.max(20, w.height - labelH - gap);
  const iconSize = Math.max(20, Math.min(w.width - 4, maxIconH));
  const totalH = iconSize + gap + labelH;
  const topPad = Math.max(0, Math.floor((w.height - totalH) / 2));
  return {
    mode: 'vertical',
    iconSize,
    iconX: w.x + (w.width - iconSize) / 2,
    iconY: w.y + topPad,
    labelX: w.x + 2,
    labelY: w.y + topPad + iconSize + gap,
    labelW: Math.max(20, w.width - 4),
    labelH,
    labelAlign: 'center',
  };
}

/**
 * Computes safe internal LED & caption geometry for BIT_LAMP so neither the LED
 * nor the caption ever overflows w.y + w.height.
 */
export function computeBitLampGeometry(w: HmiWidget): {
  horizontal: boolean;
  ledSize: number;
  ledX: number;
  ledY: number;
  labelX: number;
  labelY: number;
  labelW: number;
  labelH: number;
  labelAlign: 'left' | 'center';
} {
  const horizontal = w.width >= w.height * 2.0 || (w.height < 48 && w.width >= w.height * 1.4);
  if (horizontal) {
    const ledSize = Math.max(16, Math.min(36, w.height - 4));
    const labelH = Math.min(18, Math.max(14, w.height - 4));
    return {
      horizontal: true,
      ledSize,
      ledX: w.x + 4,
      ledY: w.y + Math.round((w.height - ledSize) / 2),
      labelX: w.x + ledSize + 10,
      labelY: w.y + Math.round((w.height - labelH) / 2),
      labelW: Math.max(24, w.width - ledSize - 14),
      labelH,
      labelAlign: 'left',
    };
  }
  const labelH = Math.min(18, Math.max(13, Math.floor(w.height * 0.32)));
  const gap = 2;
  const maxLedH = Math.max(18, w.height - labelH - gap);
  const ledSize = Math.max(18, Math.min(44, w.width - 4, maxLedH));
  const totalH = ledSize + gap + labelH;
  const topPad = Math.max(0, Math.floor((w.height - totalH) / 2));
  return {
    horizontal: false,
    ledSize,
    ledX: w.x + (w.width - ledSize) / 2,
    ledY: w.y + topPad,
    labelX: w.x + 2,
    labelY: w.y + topPad + ledSize + gap,
    labelW: Math.max(20, w.width - 4),
    labelH,
    labelAlign: 'center',
  };
}

export function getRoleCardColors(
  role: HmiVisualRole | undefined,
  theme: HmiThemeTokens
): { fill: string; border: string; valueColor: string } {
  if (role === 'KPI_HERO') {
    return {
      fill: theme.heroCardBg,
      border: theme.heroCardBorder,
      valueColor: pickReadableTextColor(theme.heroCardBg, theme.textPrimary),
    };
  }
  if (role === 'DANGER_ACTION') {
    return {
      fill: theme.dangerCardBg,
      border: theme.dangerCardBorder,
      valueColor: pickReadableTextColor(theme.dangerCardBg, theme.textPrimary),
    };
  }
  return {
    fill: theme.cardBg,
    border: theme.cardBorder,
    valueColor: pickReadableTextColor(theme.cardBg, theme.textPrimary),
  };
}

export type VisualAuditIssueCode =
  | 'HMI-VIS-INVISIBLE-TEXT'
  | 'HMI-VIS-LOW-CONTRAST'
  | 'HMI-VIS-TEXT-OVERFLOW'
  | 'HMI-VIS-UNFIXABLE-OVERFLOW'
  | 'HMI-VIS-PANEL-HEADER-OVERLAP'
  | 'HMI-VIS-SUBELEMENT-OVERFLOW'
  | 'HMI-VIS-TOUCH-TARGET';

export interface VisualAuditIssue {
  code: VisualAuditIssueCode;
  severity: 'ERROR' | 'WARNING';
  widgetId: string;
  widgetType: HmiWidgetType;
  message: string;
  measured?: Record<string, string | number>;
  remediation: string;
}

export interface HmiVisualAuditResult {
  screenId: string;
  screenName: string;
  valid: boolean;
  blockingCount: number;
  warningCount: number;
  themeId: HmiThemeId;
  issues: VisualAuditIssue[];
}

const INTERACTIVE_TYPES = new Set<HmiWidgetType>([
  'BIT_BUTTON',
  'NUMERIC_INPUT',
  'PUMP',
  'VALVE',
  'STATION',
  'ACTUATOR',
  'RECIPE_SELECTOR',
  'NAV_BAR',
]);

function pushContrastIssue(
  issues: VisualAuditIssue[],
  w: HmiWidget,
  fg: string,
  bg: string,
  subject: string,
  propHint: string
): void {
  const ratio = contrastRatio(fg, bg);
  const suggested = pickReadableTextColor(bg);
  if (ratio < 3.0) {
    issues.push({
      code: 'HMI-VIS-INVISIBLE-TEXT',
      severity: 'ERROR',
      widgetId: w.id,
      widgetType: w.type,
      message: `${w.type} "${w.id}" ${subject} color ${fg} on ${bg} has contrast ${ratio}:1 (< 3.0:1, unreadable).`,
      measured: { fg, bg, contrastRatio: ratio },
      remediation: `Set ${propHint} to ${suggested} or run haiwell_hmi_design_audit with autoFix=true.`,
    });
  } else if (ratio < 4.5) {
    issues.push({
      code: 'HMI-VIS-LOW-CONTRAST',
      severity: 'WARNING',
      widgetId: w.id,
      widgetType: w.type,
      message: `${w.type} "${w.id}" ${subject} contrast ${ratio}:1 (${fg} on ${bg}) is below WCAG AA 4.5:1.`,
      measured: { fg, bg, contrastRatio: ratio },
      remediation: `Set ${propHint} to ${suggested} for WCAG AA readability.`,
    });
  }
}

function pushTextFitIssue(
  issues: VisualAuditIssue[],
  w: HmiWidget,
  text: string,
  fontSize: number,
  availW: number,
  bold: boolean,
  warnFactor: number,
  errFactor: number,
  slotLabel: string
): void {
  if (!text) return;
  const estW = estimateTextWidthPx(text, fontSize, bold);
  if (estW <= availW * warnFactor) return;

  const minFloorW = estimateTextWidthPx(text, 8, bold);
  if (minFloorW > availW * warnFactor) {
    issues.push({
      code: 'HMI-VIS-UNFIXABLE-OVERFLOW',
      severity: minFloorW > availW * errFactor ? 'ERROR' : 'WARNING',
      widgetId: w.id,
      widgetType: w.type,
      message: `${w.type} "${w.id}" text "${text}" still overflows ${slotLabel} (${availW}px) even at the 8px minimum font floor (~${minFloorW}px).`,
      measured: { estimatedPx: estW, minFloorPx: minFloorW, availablePx: availW, fontSize },
      remediation: `Widen "${w.id}" to >= ${Math.ceil(minFloorW + 12)}px or shorten the label text (auto-fix preserves full text without truncation).`,
    });
    return;
  }

  issues.push({
    code: 'HMI-VIS-TEXT-OVERFLOW',
    severity: estW > availW * errFactor ? 'ERROR' : 'WARNING',
    widgetId: w.id,
    widgetType: w.type,
    message: `${w.type} "${w.id}" text "${text}" (~${estW}px at ${fontSize}px) exceeds ${slotLabel} (${availW}px).`,
    measured: { estimatedPx: estW, availablePx: availW, fontSize },
    remediation: `Shorten the text, widen "${w.id}", or set props.fontSize <= ${fitFontSizeToWidth(text, availW, fontSize, 8, bold)}.`,
  });
}

function findEnclosingPanel(screen: HmiScreen, w: HmiWidget): HmiWidget | null {
  if (w.type === 'GROUP_PANEL') return null;
  if (w.parentGroupId) {
    const direct = screen.widgets.find((p) => p.type === 'GROUP_PANEL' && p.id === w.parentGroupId);
    if (direct) return direct;
  }
  const cx = w.x + w.width / 2;
  const cy = w.y + w.height / 2;
  let best: HmiWidget | null = null;
  let bestArea = Infinity;
  for (const p of screen.widgets) {
    if (p.id === w.id || p.type !== 'GROUP_PANEL') continue;
    if (cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height) {
      const area = p.width * p.height;
      if (area < bestArea) {
        bestArea = area;
        best = p;
      }
    }
  }
  return best;
}

function isRectContained(
  child: { x: number; y: number; width: number; height: number },
  container: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    child.x + child.width <= container.x + container.width &&
    child.y + child.height <= container.y + container.height
  );
}

function widgetsCollide(a: HmiWidget, b: HmiWidget): boolean {
  if (a.type === 'GROUP_PANEL' && b.type !== 'GROUP_PANEL' && isRectContained(b, a)) return false;
  if (b.type === 'GROUP_PANEL' && a.type !== 'GROUP_PANEL' && isRectContained(a, b)) return false;
  const xOv = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const yOv = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return xOv > 0 && yOv > 0;
}

function repairAutoFixCollisions(screen: HmiScreen, appliedFixes: string[]): void {
  const panels = screen.widgets.filter((w) => w.type === 'GROUP_PANEL');
  const nonPanels = screen.widgets.filter((w) => w.type !== 'GROUP_PANEL');

  // Check if any collision exists before touching untouched coordinates
  let hasCollision = false;
  for (let i = 0; i < screen.widgets.length && !hasCollision; i++) {
    for (let j = i + 1; j < screen.widgets.length; j++) {
      if (widgetsCollide(screen.widgets[i], screen.widgets[j])) {
        hasCollision = true;
        break;
      }
    }
  }
  if (!hasCollision) return;

  // Sort non-panel widgets top-to-bottom, left-to-right so top nudges cascade cleanly downward
  const ordered = [...nonPanels].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: HmiWidget[] = [];

  const overlapsPlaced = (
    cand: { x: number; y: number; width: number; height: number },
    parent: HmiWidget | null
  ): boolean => {
    for (const o of placed) {
      const xOv = Math.min(cand.x + cand.width, o.x + o.width) - Math.max(cand.x, o.x);
      const yOv = Math.min(cand.y + cand.height, o.y + o.height) - Math.max(cand.y, o.y);
      if (xOv > 0 && yOv > 0) return true;
    }
    if (!parent) {
      for (const p of panels) {
        const xOv = Math.min(cand.x + cand.width, p.x + p.width) - Math.max(cand.x, p.x);
        const yOv = Math.min(cand.y + cand.height, p.y + p.height) - Math.max(cand.y, p.y);
        if (xOv > 0 && yOv > 0) return true;
      }
    }
    return false;
  };

  for (const w of ordered) {
    const parent = findEnclosingPanel(screen, w);
    const hdrH = parent ? getGroupPanelHeaderHeight(parent) : 0;
    const minX = parent ? parent.x + 4 : 4;
    const maxX = parent ? parent.x + parent.width - 4 : screen.width - 4;
    const minY = parent ? parent.y + (hdrH > 0 ? hdrH + 4 : 2) : 4;
    const maxY = parent ? parent.y + parent.height - 4 : screen.height - 4;

    const origX = w.x;
    const origY = w.y;

    w.x = Math.max(minX, Math.min(w.x, Math.max(minX, maxX - w.width)));
    w.y = Math.max(minY, Math.min(w.y, Math.max(minY, maxY - w.height)));

    if (overlapsPlaced(w, parent)) {
      let bestX = w.x;
      let bestY = w.y;
      let bestDist = Infinity;

      // Prefer shifting straight down first to preserve column alignment
      for (let y = w.y + 2; y <= maxY - w.height; y += 2) {
        if (!overlapsPlaced({ x: w.x, y, width: w.width, height: w.height }, parent)) {
          bestX = w.x;
          bestY = y;
          bestDist = Math.abs(y - origY);
          break;
        }
      }

      if (bestDist === Infinity) {
        for (const step of [8, 4, 2]) {
          for (let y = minY; y <= maxY - w.height; y += step) {
            for (let x = minX; x <= maxX - w.width; x += step) {
              if (!overlapsPlaced({ x, y, width: w.width, height: w.height }, parent)) {
                const dist = Math.hypot(x - origX, y - origY);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestX = x;
                  bestY = y;
                }
              }
            }
          }
          if (bestDist < Infinity) break;
        }
      }

      if (bestDist < Infinity) {
        w.x = bestX;
        w.y = bestY;
      }
    }

    if (w.x !== origX || w.y !== origY) {
      appliedFixes.push(
        `Resolved post-fix collision for "${w.id}" (${origX},${origY}) -> (${w.x},${w.y}).`
      );
    }
    placed.push(w);
  }
}

/**
 * Concrete pass/fail visual readability & ergonomics audit for an HMI screen.
 * Checks WCAG contrast against the true enclosing surface (catching dark-on-dark
 * and white-on-white invisible text), text overflow against available pixel width,
 * unfixable overflow at the 8px minimum font floor, child overlap onto GROUP_PANEL
 * headers, compact sub-element bounds, and touch targets across all HMI widget types.
 */
export function auditHmiScreenDesign(
  screen: HmiScreen,
  _tags: Record<string, TagDefinition> = {},
  options: { targetHardware?: HaiwellTargetHardware } = {}
): HmiVisualAuditResult {
  const theme = resolveScreenTheme(screen);
  const issues: VisualAuditIssue[] = [];
  const isTouchPanel = Boolean(options.targetHardware?.startsWith('CLOUD_HMI_'));

  const panels = screen.widgets.filter((w) => w.type === 'GROUP_PANEL');

  for (const w of screen.widgets) {
    // 1. Check child overlap with titled GROUP_PANEL header strip
    if (w.type !== 'GROUP_PANEL') {
      for (const panel of panels) {
        const hdrH = getGroupPanelHeaderHeight(panel);
        if (hdrH <= 0 || !panel.label) continue;
        const horizontallyInside = w.x >= panel.x && w.x + w.width <= panel.x + panel.width;
        const verticallyInsidePanel = w.y >= panel.y && w.y + w.height <= panel.y + panel.height;
        if (horizontallyInside && verticallyInsidePanel && w.y < panel.y + hdrH) {
          issues.push({
            code: 'HMI-VIS-PANEL-HEADER-OVERLAP',
            severity: 'ERROR',
            widgetId: w.id,
            widgetType: w.type,
            message: `Widget "${w.id}" (y=${w.y}) overlaps the top ${hdrH}px title bar of GROUP_PANEL "${panel.id}" (header ends at y=${panel.y + hdrH}).`,
            measured: { widgetY: w.y, panelHeaderBottom: panel.y + hdrH, overlapPx: panel.y + hdrH - w.y },
            remediation: `Move widget "${w.id}" down to y >= ${panel.y + hdrH + 4} or run haiwell_hmi_design_audit with autoFix=true.`,
          });
        }
      }
    }

    // 2. Touch target size check
    if ((INTERACTIVE_TYPES.has(w.type) || w.writeEnabled) && (w.width < 44 || w.height < 44)) {
      issues.push({
        code: 'HMI-VIS-TOUCH-TARGET',
        severity: isTouchPanel ? 'ERROR' : 'WARNING',
        widgetId: w.id,
        widgetType: w.type,
        message: `Interactive widget "${w.id}" is ${w.width}x${w.height}px (< 44x44px minimum touch target).`,
        measured: { width: w.width, height: w.height, minPx: 44 },
        remediation: `Increase "${w.id}" dimensions to at least 44x44px.`,
      });
    }

    // 3. Contrast & text-width checks per widget type
    const surface = resolveWidgetSurfaceContext(screen, w);

    if (w.type === 'GROUP_PANEL') {
      if (!w.label) continue;
      const pCols = getGroupPanelColors(w, theme);
      const explicitFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined);
      const fg = explicitFg ?? pCols.headerText;
      pushContrastIssue(issues, w, fg, pCols.headerBg, 'title', 'props.color');

      const fontSize = typeof w.props?.fontSize === 'number'
        ? w.props.fontSize
        : pCols.isDarkBar || w.props?.theme === 'light_banner' ? 14 : 11;
      const availW = pCols.isDarkBar || w.props?.theme === 'light_banner'
        ? computeBannerTitleAvailableWidth(screen, w)
        : Math.max(60, w.width - 20);
      pushTextFitIssue(issues, w, w.label, fontSize, availW, true, 1.15, 1.45, 'header width');
      continue;
    }

    if (w.type === 'LABEL') {
      if (w.props?.customImageBase64 || w.props?.nativeSymbol === 'HWClock4') continue;
      const bg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? surface.surfaceBg;
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? surface.defaultTextColor;
      pushContrastIssue(issues, w, fg, bg, 'text', 'props.color');

      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
      const bold = w.props?.bold !== false;
      pushTextFitIssue(issues, w, w.label, fontSize, Math.max(16, w.width), bold, 1.15, 1.45, 'widget width');
      continue;
    }

    if (w.type === 'BIT_LAMP') {
      const explicitFg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      );
      const fg = explicitFg ?? surface.defaultTextColor;
      pushContrastIssue(issues, w, fg, surface.surfaceBg, 'label', 'props.labelColor');

      const geom = computeBitLampGeometry(w);
      if (geom.labelY + geom.labelH > w.y + w.height + 1) {
        issues.push({
          code: 'HMI-VIS-SUBELEMENT-OVERFLOW',
          severity: 'ERROR',
          widgetId: w.id,
          widgetType: w.type,
          message: `BIT_LAMP "${w.id}" caption overflows bottom edge of widget.`,
          measured: { bottomY: geom.labelY + geom.labelH, widgetBottom: w.y + w.height },
          remediation: `Increase height of "${w.id}" to >= 40px or widen for horizontal layout.`,
        });
      }
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : geom.horizontal ? 11 : 10;
      pushTextFitIssue(issues, w, w.label, fontSize, geom.labelW, true, 1.2, 1.55, 'label slot width');
      continue;
    }

    if (w.type === 'BIT_BUTTON') {
      const explicitFg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      );
      const fg = explicitFg ?? surface.defaultTextColor;
      pushContrastIssue(issues, w, fg, surface.surfaceBg, 'caption', 'props.labelColor');

      const geom = computeBitButtonGeometry(w);
      if (geom.labelY + geom.labelH > w.y + w.height + 1) {
        issues.push({
          code: 'HMI-VIS-SUBELEMENT-OVERFLOW',
          severity: 'ERROR',
          widgetId: w.id,
          widgetType: w.type,
          message: `BIT_BUTTON "${w.id}" caption overflows bottom edge of widget.`,
          measured: { bottomY: geom.labelY + geom.labelH, widgetBottom: w.y + w.height },
          remediation: `Increase height of "${w.id}" to >= 56px.`,
        });
      }
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
      pushTextFitIssue(issues, w, w.label, fontSize, geom.labelW, true, 1.25, 1.6, 'button width');
      continue;
    }

    if (w.type === 'NAV_BAR') {
      const activeNav = Boolean(w.props?.active);
      const navBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined)
        ?? (activeNav ? theme.navActiveBg : theme.navBg);
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? theme.navText;
      pushContrastIssue(issues, w, fg, navBg, 'text', 'props.color');

      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
      const availW = Math.max(24, w.width - 12);
      pushTextFitIssue(issues, w, w.label, fontSize, availW, true, 1.2, 1.55, 'tab width');
      continue;
    }

    if (w.type === 'NUMERIC_DISPLAY' || w.type === 'NUMERIC_INPUT' || w.type === 'MULTI_STATE_INDICATOR') {
      const explicitLabelFg = normalizeHexColor(typeof w.props?.labelColor === 'string' ? w.props.labelColor : undefined);
      const labelFg = explicitLabelFg ?? surface.secondaryTextColor;
      pushContrastIssue(issues, w, labelFg, surface.surfaceBg, 'label', 'props.labelColor');

      const cardCols = getRoleCardColors(w.visualRole, theme);
      const defaultBoxBg = w.type === 'MULTI_STATE_INDICATOR' ? '#1E293B' : cardCols.fill;
      const defaultValFg = w.type === 'MULTI_STATE_INDICATOR' ? '#F8FAFC' : cardCols.valueColor;
      const boxBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? defaultBoxBg;
      const valFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? defaultValFg;
      pushContrastIssue(issues, w, valFg, boxBg, 'value', 'props.color');

      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
      const availW = Math.max(30, w.width - 8);
      pushTextFitIssue(issues, w, w.label, fontSize, availW, true, 1.25, 1.65, 'card width');
      continue;
    }

    if (w.type === 'GAUGE' || w.type === 'BAR_GRAPH') {
      const title = `${w.label}${w.unit ? ` (${w.unit})` : ''}`;
      const fg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      ) ?? surface.defaultTextColor;
      pushContrastIssue(issues, w, fg, surface.surfaceBg, 'title', 'props.labelColor');
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
      pushTextFitIssue(issues, w, title, fontSize, Math.max(30, w.width - 4), true, 1.2, 1.55, 'widget width');
      continue;
    }

    if (w.type === 'STATION') {
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? '#F8FAFC';
      pushContrastIssue(issues, w, fg, '#334155', 'header', 'props.color');
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
      pushTextFitIssue(issues, w, w.label, fontSize, Math.max(24, w.width - 16), true, 1.2, 1.55, 'station header width');
      continue;
    }

    if (w.type === 'RECIPE_SELECTOR') {
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? theme.panelHeaderText;
      pushContrastIssue(issues, w, fg, theme.panelHeaderBg, 'header', 'props.color');
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
      pushTextFitIssue(issues, w, w.label, fontSize, Math.max(30, w.width - 16), true, 1.2, 1.55, 'recipe header width');
      continue;
    }

    if (w.type === 'CAMERA_VIEW') {
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? '#F8FAFC';
      pushContrastIssue(issues, w, fg, '#0F172A', 'caption', 'props.color');
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
      pushTextFitIssue(issues, w, w.label, fontSize, Math.max(40, w.width - 20), true, 1.2, 1.55, 'camera caption width');
      continue;
    }

    if (w.type === 'FACEPLATE_INSTANCE') {
      const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? theme.darkHeaderText;
      pushContrastIssue(issues, w, fg, theme.darkHeaderBg, 'header', 'props.color');
      const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
      pushTextFitIssue(issues, w, w.label, fontSize, Math.max(30, w.width - 16), true, 1.2, 1.55, 'faceplate header width');
      continue;
    }

    if (w.type === 'ALARM_BANNER' || w.type === 'TREND_CHART' || w.type === 'DATA_TABLE') {
      if (w.width < 120 || w.height < 36) {
        issues.push({
          code: 'HMI-VIS-SUBELEMENT-OVERFLOW',
          severity: 'WARNING',
          widgetId: w.id,
          widgetType: w.type,
          message: `${w.type} "${w.id}" is ${w.width}x${w.height}px, too compact for readable headers/axes.`,
          measured: { width: w.width, height: w.height },
          remediation: `Resize "${w.id}" to at least 160x44px (or >= 240x140px for trend/table readability).`,
        });
      }
      if (w.type === 'ALARM_BANNER' && w.label) {
        const fontSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
        pushTextFitIssue(issues, w, w.label, fontSize, Math.max(40, w.width - 96), true, 1.25, 1.6, 'alarm banner width');
      }
      continue;
    }

    if (
      w.type === 'PUMP' ||
      w.type === 'VALVE' ||
      w.type === 'TANK' ||
      w.type === 'CONVEYOR' ||
      w.type === 'ACTUATOR'
    ) {
      const explicitFg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      );
      if (explicitFg) {
        pushContrastIssue(issues, w, explicitFg, surface.surfaceBg, 'label', 'props.labelColor');
      }
      continue;
    }

    if (w.type === 'PIPELINE' && w.label && w.width >= 40 && w.height >= 16) {
      const explicitFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? '#0F172A';
      pushContrastIssue(issues, w, explicitFg, '#94A3B8', 'label', 'props.color');
    }
  }

  const blockingCount = issues.filter((i) => i.severity === 'ERROR').length;
  const warningCount = issues.filter((i) => i.severity === 'WARNING').length;

  return {
    screenId: screen.id,
    screenName: screen.name,
    valid: blockingCount === 0,
    blockingCount,
    warningCount,
    themeId: theme.id,
    issues,
  };
}

export interface HmiVisualAutoFixResult {
  screen: HmiScreen;
  appliedFixes: string[];
  auditBefore: HmiVisualAuditResult;
  auditAfter: HmiVisualAuditResult;
}

/**
 * Deterministically repairs visual readability defects on an HMI screen:
 * - Fixes unreadable foreground/label colors against true enclosing surfaces (WCAG >= 4.5:1)
 * - Scales down oversized fontSize props to fit available pixel widths (down to 8px floor without truncating text)
 * - Nudges widgets overlapping a titled GROUP_PANEL header below the header bar
 * - Repairs compact BIT_LAMP/BIT_BUTTON sub-element overflow and touch targets
 * - Re-runs container-aware collision repair whenever any nudge/resize occurs so fixes never introduce overlaps
 */
export function autoFixHmiScreenDesign(
  screen: HmiScreen,
  tags: Record<string, TagDefinition> = {},
  options: { targetHardware?: HaiwellTargetHardware } = {}
): HmiVisualAutoFixResult {
  const auditBefore = auditHmiScreenDesign(screen, tags, options);
  const theme = resolveScreenTheme(screen);
  const appliedFixes: string[] = [];

  const cloned: HmiScreen = {
    ...screen,
    widgets: screen.widgets.map((w) => ({
      ...w,
      ...(w.props ? { props: { ...w.props } } : {}),
    })),
  };

  const panels = cloned.widgets.filter((w) => w.type === 'GROUP_PANEL');
  const isTouchPanel = Boolean(options.targetHardware?.startsWith('CLOUD_HMI_'));
  let geometryChanged = false;

  for (const w of cloned.widgets) {
    const parent = findEnclosingPanel(cloned, w);
    const parentMaxX = parent ? parent.x + parent.width - 4 : cloned.width;
    const parentMaxY = parent ? parent.y + parent.height - 4 : cloned.height;

    // 1. Nudge widgets overlapping a titled GROUP_PANEL header bar
    if (w.type !== 'GROUP_PANEL') {
      for (const panel of panels) {
        const hdrH = getGroupPanelHeaderHeight(panel);
        if (hdrH <= 0 || !panel.label) continue;
        const horizontallyInside = w.x >= panel.x && w.x + w.width <= panel.x + panel.width;
        const verticallyInside = w.y >= panel.y && w.y + w.height <= panel.y + panel.height;
        if (horizontallyInside && verticallyInside && w.y < panel.y + hdrH) {
          const targetY = panel.y + hdrH + 4;
          const maxBottom = panel.y + panel.height - 4;
          if (targetY + w.height <= maxBottom) {
            w.y = targetY;
            geometryChanged = true;
            appliedFixes.push(`Moved "${w.id}" down to y=${targetY} below GROUP_PANEL "${panel.id}" header.`);
          } else if (maxBottom - targetY >= 24) {
            w.y = targetY;
            w.height = Math.max(24, maxBottom - targetY);
            geometryChanged = true;
            appliedFixes.push(`Moved and trimmed "${w.id}" inside GROUP_PANEL "${panel.id}" body (y=${w.y}, h=${w.height}).`);
          }
        }
      }
    }

    // 2. Repair sub-element caption overflow on compact BIT_LAMP / BIT_BUTTON
    if (w.type === 'BIT_LAMP') {
      const geom = computeBitLampGeometry(w);
      if (geom.labelY + geom.labelH > w.y + w.height + 1) {
        const neededH = Math.max(40, geom.labelY + geom.labelH - w.y);
        if (w.y + neededH <= parentMaxY) {
          w.height = neededH;
          geometryChanged = true;
          appliedFixes.push(`Expanded BIT_LAMP "${w.id}" height to ${w.height}px to prevent caption overflow.`);
        } else {
          const neededW = Math.ceil(w.height * 1.45);
          if (w.x + neededW <= parentMaxX) {
            w.width = Math.max(w.width, neededW);
            geometryChanged = true;
            appliedFixes.push(`Widened BIT_LAMP "${w.id}" to ${w.width}px for horizontal layout to prevent caption overflow.`);
          }
        }
      }
    } else if (w.type === 'BIT_BUTTON') {
      const geom = computeBitButtonGeometry(w);
      if (geom.labelY + geom.labelH > w.y + w.height + 1) {
        const neededH = Math.max(56, geom.labelY + geom.labelH - w.y);
        if (w.y + neededH <= parentMaxY) {
          w.height = neededH;
          geometryChanged = true;
          appliedFixes.push(`Expanded BIT_BUTTON "${w.id}" height to ${w.height}px to prevent caption overflow.`);
        } else {
          const neededW = Math.ceil(w.height * 1.85);
          if (w.x + neededW <= parentMaxX) {
            w.width = Math.max(w.width, neededW);
            geometryChanged = true;
            appliedFixes.push(`Widened BIT_BUTTON "${w.id}" to ${w.width}px for horizontal layout to prevent caption overflow.`);
          }
        }
      }
    }

    // 3. Repair touch targets on touch panels (respecting enclosing panel bounds)
    if (isTouchPanel && (INTERACTIVE_TYPES.has(w.type) || w.writeEnabled)) {
      if (w.width < 44 && w.x + 44 <= parentMaxX) {
        w.width = 44;
        geometryChanged = true;
        appliedFixes.push(`Expanded "${w.id}" width to 44px for touch compliance.`);
      }
      if (w.height < 44 && w.y + 44 <= parentMaxY) {
        w.height = 44;
        geometryChanged = true;
        appliedFixes.push(`Expanded "${w.id}" height to 44px for touch compliance.`);
      }
    }
  }

  // 4. Re-run container-aware collision repair if any nudge or resize occurred
  if (geometryChanged) {
    repairAutoFixCollisions(cloned, appliedFixes);
  }

  // 5. Repair contrast (< 4.5:1 WCAG AA) and oversized fonts (never truncating labels)
  for (const w of cloned.widgets) {
    const surface = resolveWidgetSurfaceContext(cloned, w);
    const props = w.props ? { ...w.props } : {};
    let propsChanged = false;

    const fitFontProp = (
      text: string,
      availW: number,
      defaultSize: number,
      warnFactor: number,
      bold = true
    ) => {
      if (!text) return;
      const curSize = typeof props.fontSize === 'number' ? props.fontSize : defaultSize;
      if (estimateTextWidthPx(text, curSize, bold) > availW * warnFactor) {
        const fitted = fitFontSizeToWidth(text, availW, curSize, 8, bold);
        if (fitted < curSize) {
          props.fontSize = fitted;
          propsChanged = true;
          appliedFixes.push(`Scaled ${w.type} "${w.id}" fontSize ${curSize} -> ${fitted}px to fit ${availW}px.`);
        }
      }
    };

    if (w.type === 'GROUP_PANEL' && w.label) {
      const pCols = getGroupPanelColors(w, theme);
      const explicitFg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined);
      const fg = explicitFg ?? pCols.headerText;
      if (contrastRatio(fg, pCols.headerBg) < 4.5) {
        const fixed = pickReadableTextColor(pCols.headerBg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed GROUP_PANEL "${w.id}" title color ${fg} -> ${fixed} on ${pCols.headerBg}.`);
      }
      const isBanner = pCols.isDarkBar || w.props?.theme === 'light_banner';
      const availW = isBanner ? computeBannerTitleAvailableWidth(cloned, w) : Math.max(60, w.width - 20);
      fitFontProp(w.label, availW, isBanner ? 14 : 11, 1.1, true);
    } else if (w.type === 'LABEL' && !props.customImageBase64 && props.nativeSymbol !== 'HWClock4') {
      const bg = normalizeHexColor(typeof props.backgroundColor === 'string' ? props.backgroundColor : undefined) ?? surface.surfaceBg;
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? surface.defaultTextColor;
      if (contrastRatio(fg, bg) < 4.5) {
        const fixed = pickReadableTextColor(bg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed LABEL "${w.id}" color ${fg} -> ${fixed} on ${bg}.`);
      }
      const bold = props.bold !== false;
      fitFontProp(w.label, Math.max(16, w.width), 12, 1.1, bold);
    } else if (w.type === 'BIT_LAMP' || w.type === 'BIT_BUTTON') {
      const explicitFg = normalizeHexColor(
        typeof props.labelColor === 'string'
          ? props.labelColor
          : typeof props.color === 'string'
            ? props.color
            : undefined
      );
      const fg = explicitFg ?? surface.defaultTextColor;
      if (contrastRatio(fg, surface.surfaceBg) < 4.5) {
        const fixed = pickReadableTextColor(surface.surfaceBg);
        props.labelColor = fixed;
        if (typeof props.color === 'string') props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed ${w.type} "${w.id}" labelColor ${fg} -> ${fixed} on ${surface.surfaceBg}.`);
      }
      const lampGeom = w.type === 'BIT_LAMP' ? computeBitLampGeometry(w) : null;
      const availW = lampGeom ? lampGeom.labelW : computeBitButtonGeometry(w).labelW;
      const defaultSize = lampGeom && lampGeom.horizontal ? 11 : 10;
      fitFontProp(w.label, availW, defaultSize, 1.15, true);
    } else if (w.type === 'NAV_BAR') {
      const activeNav = Boolean(props.active);
      const navBg = normalizeHexColor(typeof props.backgroundColor === 'string' ? props.backgroundColor : undefined)
        ?? (activeNav ? theme.navActiveBg : theme.navBg);
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? theme.navText;
      if (contrastRatio(fg, navBg) < 4.5) {
        const fixed = pickReadableTextColor(navBg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed NAV_BAR "${w.id}" text color ${fg} -> ${fixed} on ${navBg}.`);
      }
      fitFontProp(w.label, Math.max(24, w.width - 12), 12, 1.15, true);
    } else if (w.type === 'NUMERIC_DISPLAY' || w.type === 'NUMERIC_INPUT' || w.type === 'MULTI_STATE_INDICATOR') {
      const explicitLabelFg = normalizeHexColor(typeof props.labelColor === 'string' ? props.labelColor : undefined);
      const labelFg = explicitLabelFg ?? surface.secondaryTextColor;
      if (contrastRatio(labelFg, surface.surfaceBg) < 4.5) {
        const fixed = pickReadableTextColor(surface.surfaceBg);
        props.labelColor = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed ${w.type} "${w.id}" labelColor ${labelFg} -> ${fixed} on ${surface.surfaceBg}.`);
      }
      const cardCols = getRoleCardColors(w.visualRole, theme);
      const defaultBoxBg = w.type === 'MULTI_STATE_INDICATOR' ? '#1E293B' : cardCols.fill;
      const defaultValFg = w.type === 'MULTI_STATE_INDICATOR' ? '#F8FAFC' : cardCols.valueColor;
      const boxBg = normalizeHexColor(typeof props.backgroundColor === 'string' ? props.backgroundColor : undefined) ?? defaultBoxBg;
      const valFg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? defaultValFg;
      if (contrastRatio(valFg, boxBg) < 4.5) {
        const fixed = pickReadableTextColor(boxBg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed ${w.type} "${w.id}" value color ${valFg} -> ${fixed} on ${boxBg}.`);
      }
      fitFontProp(w.label, Math.max(30, w.width - 8), 10, 1.2, true);
    } else if (w.type === 'GAUGE' || w.type === 'BAR_GRAPH') {
      const fg = normalizeHexColor(
        typeof props.labelColor === 'string'
          ? props.labelColor
          : typeof props.color === 'string'
            ? props.color
            : undefined
      ) ?? surface.defaultTextColor;
      if (contrastRatio(fg, surface.surfaceBg) < 4.5) {
        const fixed = pickReadableTextColor(surface.surfaceBg);
        props.labelColor = fixed;
        if (typeof props.color === 'string') props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed ${w.type} "${w.id}" title color ${fg} -> ${fixed} on ${surface.surfaceBg}.`);
      }
      const title = `${w.label}${w.unit ? ` (${w.unit})` : ''}`;
      fitFontProp(title, Math.max(30, w.width - 4), 11, 1.15, true);
    } else if (w.type === 'STATION') {
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? '#F8FAFC';
      if (contrastRatio(fg, '#334155') < 4.5) {
        const fixed = pickReadableTextColor('#334155');
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed STATION "${w.id}" header color ${fg} -> ${fixed} on #334155.`);
      }
      fitFontProp(w.label, Math.max(24, w.width - 16), 11, 1.15, true);
    } else if (w.type === 'RECIPE_SELECTOR') {
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? theme.panelHeaderText;
      if (contrastRatio(fg, theme.panelHeaderBg) < 4.5) {
        const fixed = pickReadableTextColor(theme.panelHeaderBg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed RECIPE_SELECTOR "${w.id}" header color ${fg} -> ${fixed} on ${theme.panelHeaderBg}.`);
      }
      fitFontProp(w.label, Math.max(30, w.width - 16), 11, 1.15, true);
    } else if (w.type === 'CAMERA_VIEW') {
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? '#F8FAFC';
      if (contrastRatio(fg, '#0F172A') < 4.5) {
        const fixed = pickReadableTextColor('#0F172A');
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed CAMERA_VIEW "${w.id}" caption color ${fg} -> ${fixed} on #0F172A.`);
      }
      fitFontProp(w.label, Math.max(40, w.width - 20), 11, 1.15, true);
    } else if (w.type === 'FACEPLATE_INSTANCE') {
      const fg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? theme.darkHeaderText;
      if (contrastRatio(fg, theme.darkHeaderBg) < 4.5) {
        const fixed = pickReadableTextColor(theme.darkHeaderBg);
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed FACEPLATE_INSTANCE "${w.id}" header color ${fg} -> ${fixed} on ${theme.darkHeaderBg}.`);
      }
      fitFontProp(w.label, Math.max(30, w.width - 16), 11, 1.15, true);
    } else if (
      w.type === 'PUMP' ||
      w.type === 'VALVE' ||
      w.type === 'TANK' ||
      w.type === 'CONVEYOR' ||
      w.type === 'ACTUATOR'
    ) {
      const explicitFg = normalizeHexColor(
        typeof props.labelColor === 'string'
          ? props.labelColor
          : typeof props.color === 'string'
            ? props.color
            : undefined
      );
      if (explicitFg && contrastRatio(explicitFg, surface.surfaceBg) < 4.5) {
        const fixed = pickReadableTextColor(surface.surfaceBg);
        props.labelColor = fixed;
        if (typeof props.color === 'string') props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed ${w.type} "${w.id}" labelColor ${explicitFg} -> ${fixed} on ${surface.surfaceBg}.`);
      }
    } else if (w.type === 'PIPELINE' && w.label && w.width >= 40 && w.height >= 16) {
      const explicitFg = normalizeHexColor(typeof props.color === 'string' ? props.color : undefined) ?? '#0F172A';
      if (contrastRatio(explicitFg, '#94A3B8') < 4.5) {
        const fixed = pickReadableTextColor('#94A3B8');
        props.color = fixed;
        propsChanged = true;
        appliedFixes.push(`Fixed PIPELINE "${w.id}" label color ${explicitFg} -> ${fixed} on #94A3B8.`);
      }
    }

    if (propsChanged) {
      w.props = props;
    }
  }

  const auditAfter = auditHmiScreenDesign(cloned, tags, options);
  return {
    screen: cloned,
    appliedFixes,
    auditBefore,
    auditAfter,
  };
}
