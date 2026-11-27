/**
 * Hardened ISA-101 HMI Auto-Layout Engine, Touch-Target Validator,
 * Faceplate Template Expander, Navigation Graph Verifier, & SVG Generator.
 * Never silently drops overflowing widgets!
 */

import {
  computeBannerTitleAvailableWidth,
  computeBitButtonGeometry,
  computeBitLampGeometry,
  fitFontSizeToWidth,
  getGroupPanelColors,
  getGroupPanelHeaderHeight,
  getRoleCardColors,
  normalizeHexColor,
  pickReadableTextColor,
  resolveScreenTheme,
  resolveWidgetSurfaceContext,
} from './hmiDesignSystem';
import type {
  HaiwellTargetHardware,
  HmiFaceplateTemplate,
  HmiScreen,
  HmiThemeId,
  HmiVisualRole,
  HmiWidget,
  HmiWidgetType,
  TagDefinition,
} from './types';

export interface LayoutCollision {
  widgetA: string;
  widgetB: string;
  overlapPx: { width: number; height: number };
}

export interface HmiLayoutValidation {
  valid: boolean;
  collisions: LayoutCollision[];
  outOfBounds: string[];
  unresolvedTags: string[];
  brokenNavTargets: string[];
  touchTargetViolations: string[];
  duplicateWidgetIds: string[];
  readOnlyWriteWidgets: string[];
  invalidRanges: string[];
  disconnectedPipes: string[];
  isa101Notices: string[];
}

const INTERACTIVE_WIDGET_TYPES = new Set<HmiWidgetType>([
  'BIT_BUTTON',
  'NUMERIC_INPUT',
  'PUMP',
  'VALVE',
  'STATION',
  'ACTUATOR',
  'RECIPE_SELECTOR',
  'NAV_BAR',
]);

function isContainedInside(child: HmiWidget, container: HmiWidget): boolean {
  return (
    child.x >= container.x &&
    child.y >= container.y &&
    child.x + child.width <= container.x + container.width &&
    child.y + child.height <= container.y + container.height
  );
}

export function detectWidgetCollisions(widgets: HmiWidget[]): LayoutCollision[] {
  const collisions: LayoutCollision[] = [];
  for (let i = 0; i < widgets.length; i++) {
    const a = widgets[i];
    for (let j = i + 1; j < widgets.length; j++) {
      const b = widgets[j];
      // A GROUP_PANEL is a background container; children cleanly inside it do not collide with it.
      if (a.type === 'GROUP_PANEL' && b.type !== 'GROUP_PANEL' && isContainedInside(b, a)) {
        continue;
      }
      if (b.type === 'GROUP_PANEL' && a.type !== 'GROUP_PANEL' && isContainedInside(a, b)) {
        continue;
      }
      const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (xOverlap > 0 && yOverlap > 0) {
        collisions.push({
          widgetA: a.id,
          widgetB: b.id,
          overlapPx: { width: Math.round(xOverlap), height: Math.round(yOverlap) },
        });
      }
    }
  }
  return collisions;
}

export function validateHmiScreen(
  screen: HmiScreen,
  knownTags: Record<string, TagDefinition>,
  options: { knownScreenIds?: Set<string>; targetHardware?: HaiwellTargetHardware } = {}
): HmiLayoutValidation {
  const collisions = detectWidgetCollisions(screen.widgets);
  const outOfBounds: string[] = [];
  const unresolvedTags: string[] = [];
  const brokenNavTargets: string[] = [];
  const touchTargetViolations: string[] = [];
  const duplicateWidgetIds: string[] = [];
  const readOnlyWriteWidgets: string[] = [];
  const invalidRanges: string[] = [];
  const disconnectedPipes: string[] = [];
  const isa101Notices: string[] = [];

  const isTouchPanel = Boolean(options.targetHardware?.startsWith('CLOUD_HMI_'));
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(knownTags, name);
  const seenWidgetIds = new Set<string>();
  const widgetIdSet = new Set<string>(screen.widgets.map((w) => w.id));

  for (const w of screen.widgets) {
    if (seenWidgetIds.has(w.id)) {
      duplicateWidgetIds.push(w.id);
    }
    seenWidgetIds.add(w.id);

    if (w.width <= 0 || w.height <= 0 || w.x < 0 || w.y < 0 || w.x + w.width > screen.width || w.y + w.height > screen.height) {
      outOfBounds.push(w.id);
    }
    if (w.min !== undefined && w.max !== undefined && w.min > w.max) {
      invalidRanges.push(`${w.id} (min=${w.min} > max=${w.max})`);
    }
    if (w.tagName && !hasOwnTag(w.tagName)) {
      unresolvedTags.push(`${w.id}->${w.tagName}`);
    }
    if (w.writeEnabled && w.tagName && hasOwnTag(w.tagName) && knownTags[w.tagName]?.access === 'RO') {
      readOnlyWriteWidgets.push(`${w.id}->${w.tagName}`);
    }
    if (w.targetScreenId && options.knownScreenIds && !options.knownScreenIds.has(w.targetScreenId)) {
      brokenNavTargets.push(`${w.id}->${w.targetScreenId}`);
    }
    if (isTouchPanel && (INTERACTIVE_WIDGET_TYPES.has(w.type) || w.writeEnabled) && (w.width < 44 || w.height < 44)) {
      touchTargetViolations.push(`${w.id} (${w.width}x${w.height}px < 44x44px minimum touch target)`);
    }
  }

  for (const pipe of screen.pipes ?? []) {
    if (pipe.flowTagName && !hasOwnTag(pipe.flowTagName)) {
      unresolvedTags.push(`${pipe.id}->${pipe.flowTagName}`);
    }
    if (!widgetIdSet.has(pipe.fromWidgetId)) {
      brokenNavTargets.push(`${pipe.id}.from->${pipe.fromWidgetId}`);
      disconnectedPipes.push(`${pipe.id}.from->${pipe.fromWidgetId}`);
    }
    if (!widgetIdSet.has(pipe.toWidgetId)) {
      brokenNavTargets.push(`${pipe.id}.to->${pipe.toWidgetId}`);
      disconnectedPipes.push(`${pipe.id}.to->${pipe.toWidgetId}`);
    }
    if (!Array.isArray(pipe.waypoints) || pipe.waypoints.length < 2) {
      disconnectedPipes.push(`${pipe.id} (fewer than 2 waypoints)`);
    }
  }

  if (screen.layoutStandard === 'ISA_101_HIGH_PERFORMANCE' && !screen.isPopup) {
    const hasAlarmBanner = screen.widgets.some((w) => w.type === 'ALARM_BANNER');
    if (!hasAlarmBanner) {
      isa101Notices.push('ISA-101 recommends a dedicated top ALARM_BANNER on Level-2/3 operator displays.');
    }
  }

  return {
    valid:
      collisions.length === 0 &&
      outOfBounds.length === 0 &&
      unresolvedTags.length === 0 &&
      brokenNavTargets.length === 0 &&
      touchTargetViolations.length === 0 &&
      duplicateWidgetIds.length === 0 &&
      readOnlyWriteWidgets.length === 0 &&
      invalidRanges.length === 0 &&
      disconnectedPipes.length === 0,
    collisions,
    outOfBounds,
    unresolvedTags,
    brokenNavTargets,
    touchTargetViolations,
    duplicateWidgetIds,
    readOnlyWriteWidgets,
    invalidRanges,
    disconnectedPipes,
    isa101Notices,
  };
}

export interface AutoLayoutItemSpec {
  id?: string;
  type: HmiWidgetType;
  label: string;
  tagName?: string;
  writeEnabled?: boolean;
  targetScreenId?: string;
  visualRole?: HmiVisualRole;
  unit?: string;
  min?: number;
  max?: number;
  colSpan?: number;
  rowSpan?: number;
  props?: Record<string, string | number | boolean>;
}

export interface AutoLayoutSectionSpec {
  id?: string;
  title: string;
  columns?: number;
  colSpan?: number;
  items: AutoLayoutItemSpec[];
}

export interface AutoLayoutSpec {
  screenId: string;
  name: string;
  width: number;
  height: number;
  layoutStandard: HmiScreen['layoutStandard'];
  themeId?: HmiThemeId;
  includeAlarmBanner?: boolean;
  includeNavBar?: boolean;
  columns?: number;
  items?: AutoLayoutItemSpec[];
  sections?: AutoLayoutSectionSpec[];
}

export interface AutoLayoutResult {
  screen: HmiScreen;
  overflowWidgets: string[];
}

export function generateAutoLayoutScreen(spec: AutoLayoutSpec): HmiScreen {
  return generateAutoLayoutScreenDetailed(spec).screen;
}

function packItemsInGrid(
  items: AutoLayoutItemSpec[],
  colsInput: number,
  originX: number,
  originY: number,
  usableWidth: number,
  availableHeight: number,
  gap: number,
  parentGroupId?: string,
  idPrefix = 'w'
): { widgets: HmiWidget[]; overflowWidgets: string[] } {
  const widgets: HmiWidget[] = [];
  const overflowWidgets: string[] = [];
  let cols = Math.max(1, Math.min(colsInput, 8));
  while (cols > 1 && Math.floor((usableWidth - gap * (cols - 1)) / cols) < 48) {
    cols--;
  }

  const occupied = new Set<string>();
  const placements: { item: AutoLayoutItemSpec; idx: number; col: number; row: number; cSpan: number; rSpan: number }[] = [];
  let maxRowUsed = 0;

  items.forEach((item, idx) => {
    const cSpan = Math.max(1, Math.min(item.colSpan ?? 1, cols));
    const rSpan = Math.max(1, Math.min(item.rowSpan ?? 1, 3));
    let placed = false;
    for (let r = 0; !placed && r < 200; r++) {
      for (let c = 0; c <= cols - cSpan; c++) {
        let fits = true;
        for (let dr = 0; dr < rSpan && fits; dr++) {
          for (let dc = 0; dc < cSpan && fits; dc++) {
            if (occupied.has(`${r + dr},${c + dc}`)) fits = false;
          }
        }
        if (fits) {
          for (let dr = 0; dr < rSpan; dr++) {
            for (let dc = 0; dc < cSpan; dc++) occupied.add(`${r + dr},${c + dc}`);
          }
          placements.push({ item, idx, col: c, row: r, cSpan, rSpan });
          maxRowUsed = Math.max(maxRowUsed, r + rSpan);
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      overflowWidgets.push(item.id ?? `${idPrefix}_${idx + 1}_${item.type.toLowerCase()}`);
    }
  });

  const colWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
  const computedRowHeight =
    maxRowUsed > 0
      ? Math.min(115, Math.floor((availableHeight - gap * (maxRowUsed - 1)) / maxRowUsed))
      : 110;
  const baseRowHeight = Math.max(48, computedRowHeight);

  for (const p of placements) {
    const x = originX + p.col * (colWidth + gap);
    const y = originY + p.row * (baseRowHeight + gap);
    const width = p.cSpan * colWidth + (p.cSpan - 1) * gap;
    const height = p.rSpan * baseRowHeight + (p.rSpan - 1) * gap;
    const id = p.item.id ?? `${idPrefix}_${p.idx + 1}_${p.item.type.toLowerCase()}`;

    if (y + height <= originY + availableHeight + 2) {
      widgets.push({
        id,
        type: p.item.type,
        label: p.item.label,
        x,
        y,
        width,
        height,
        tagName: p.item.tagName,
        writeEnabled: p.item.writeEnabled ?? false,
        targetScreenId: p.item.targetScreenId,
        ...(parentGroupId ? { parentGroupId } : {}),
        ...(p.item.visualRole ? { visualRole: p.item.visualRole } : {}),
        unit: p.item.unit,
        min: p.item.min,
        max: p.item.max,
        precision: 2,
        ...(p.item.props ? { props: { ...p.item.props } } : {}),
      });
    } else {
      overflowWidgets.push(id);
    }
  }

  return { widgets, overflowWidgets };
}

/**
 * Dynamically computes row heights so all widgets fit within viewport without silent drops.
 * Supports both flat `items` grids and titled `sections` (rendered inside `GROUP_PANEL` containers).
 */
export function generateAutoLayoutScreenDetailed(spec: AutoLayoutSpec): AutoLayoutResult {
  const pad = 20;
  const gap = 14;
  const usableWidth = spec.width - pad * 2;
  const widgets: HmiWidget[] = [];
  const overflowWidgets: string[] = [];

  let topOffset = pad;
  const bottomReserve = spec.includeNavBar ? 44 + pad + gap : 0;

  if (spec.includeAlarmBanner !== false) {
    widgets.push({
      id: `${spec.screenId}_alarm_banner`,
      type: 'ALARM_BANNER',
      label: 'Active Process Alarms',
      x: pad,
      y: topOffset,
      width: spec.width - pad * 2,
      height: 44,
    });
    topOffset += 44 + gap;
  }

  const availableHeight = spec.height - topOffset - bottomReserve - pad;

  if (spec.sections && spec.sections.length > 0) {
    const outerCols = Math.max(1, Math.min(spec.columns ?? 2, 4));
    const secOccupied = new Set<string>();
    const secPlacements: {
      sec: AutoLayoutSectionSpec;
      idx: number;
      col: number;
      row: number;
      cSpan: number;
      estRows: number;
    }[] = [];
    let maxOuterRow = 0;

    spec.sections.forEach((sec, idx) => {
      const cSpan = Math.max(1, Math.min(sec.colSpan ?? 1, outerCols));
      const innerCols = Math.max(1, Math.min(sec.columns ?? 2, 6));
      const estRows = Math.max(1, Math.ceil(sec.items.length / innerCols));
      let placed = false;
      for (let r = 0; !placed && r < 50; r++) {
        for (let c = 0; c <= outerCols - cSpan; c++) {
          let fits = true;
          for (let dc = 0; dc < cSpan && fits; dc++) {
            if (secOccupied.has(`${r},${c + dc}`)) fits = false;
          }
          if (fits) {
            for (let dc = 0; dc < cSpan; dc++) secOccupied.add(`${r},${c + dc}`);
            secPlacements.push({ sec, idx, col: c, row: r, cSpan, estRows });
            maxOuterRow = Math.max(maxOuterRow, r + 1);
            placed = true;
            break;
          }
        }
      }
    });

    // Weight each outer row's height proportionally by its tallest section's estRows
    const rowWeights = new Array<number>(maxOuterRow).fill(1);
    for (const sp of secPlacements) {
      rowWeights[sp.row] = Math.max(rowWeights[sp.row], sp.estRows);
    }
    const totalWeight = rowWeights.reduce((a, b) => a + b, 0) || 1;
    const totalInnerGap = gap * Math.max(0, maxOuterRow - 1);
    const totalRowHeightPool = Math.max(80, availableHeight - totalInnerGap);
    const rowHeights = rowWeights.map((w) => Math.floor((w / totalWeight) * totalRowHeightPool));
    const rowYOffsets: number[] = [];
    let curY = topOffset;
    for (let r = 0; r < maxOuterRow; r++) {
      rowYOffsets.push(curY);
      curY += rowHeights[r] + gap;
    }

    const outerColW = Math.floor((usableWidth - gap * (outerCols - 1)) / outerCols);
    const headerH = 28;
    const innerPad = 10;
    const innerGap = 8;

    for (const sp of secPlacements) {
      const panelId = sp.sec.id ?? `${spec.screenId}_sec_${sp.idx + 1}`;
      const px = pad + sp.col * (outerColW + gap);
      const py = rowYOffsets[sp.row];
      const pw = sp.cSpan * outerColW + (sp.cSpan - 1) * gap;
      const ph = rowHeights[sp.row];

      widgets.push({
        id: panelId,
        type: 'GROUP_PANEL',
        label: sp.sec.title,
        x: px,
        y: py,
        width: pw,
        height: ph,
      });

      const packed = packItemsInGrid(
        sp.sec.items,
        sp.sec.columns ?? 2,
        px + innerPad,
        py + headerH + innerPad,
        Math.max(60, pw - innerPad * 2),
        Math.max(48, ph - headerH - innerPad * 2),
        innerGap,
        panelId,
        `${panelId}_w`
      );
      widgets.push(...packed.widgets);
      overflowWidgets.push(...packed.overflowWidgets);
    }
  } else {
    const packed = packItemsInGrid(
      spec.items ?? [],
      spec.columns ?? 4,
      pad,
      topOffset,
      usableWidth,
      availableHeight,
      gap
    );
    widgets.push(...packed.widgets);
    overflowWidgets.push(...packed.overflowWidgets);
  }

  if (spec.includeNavBar) {
    widgets.push({
      id: `${spec.screenId}_nav_bar`,
      type: 'NAV_BAR',
      label: 'Screen Navigation',
      x: pad,
      y: spec.height - 44 - pad,
      width: spec.width - pad * 2,
      height: 44,
    });
  }

  const theme = spec.themeId ? resolveScreenTheme({ themeId: spec.themeId, backgroundColor: '#F1F5F9' }) : null;
  const defaultBg = theme
    ? theme.canvasBg
    : spec.layoutStandard === 'ISA_101_HIGH_PERFORMANCE'
      ? '#E5E7EB'
      : '#F1F5F9';

  return {
    screen: {
      id: spec.screenId,
      name: spec.name,
      width: spec.width,
      height: spec.height,
      layoutStandard: spec.layoutStandard,
      ...(spec.themeId ? { themeId: spec.themeId } : {}),
      backgroundColor: defaultBg,
      autoScaleMobile: true,
      autoScaleWeb: true,
      widgets,
      createdAt: new Date().toISOString(),
    },
    overflowWidgets,
  };
}

export function instantiateFaceplate(
  template: HmiFaceplateTemplate,
  instanceId: string,
  originX: number,
  originY: number,
  tagPrefix: string,
  overrides: Record<string, string> = {}
): HmiWidget[] {
  return template.widgets.map((w, idx) => {
    const resolvedTag = w.tagName
      ? w.tagName.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => overrides[key] ?? `${tagPrefix}_${key}`)
      : undefined;
    return {
      ...w,
      id: `${instanceId}_${idx + 1}`,
      x: originX + w.x,
      y: originY + w.y,
      tagName: resolvedTag,
      faceplateId: template.id,
    };
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PIPE_FLUID_COLOR: Record<string, string> = {
  CHILLED_WATER: '#0284C7',
  HOT_WATER: '#DC2626',
  STEAM: '#D97706',
  AIR: '#0D9488',
  CHEMICAL: '#7C3AED',
  PROCESS: '#334155',
  RETURN: '#475569',
  TRANSFER: '#0F766E',
  SIGNAL: '#6366F1',
};

function getRoleAccentColor(role?: HmiVisualRole): string {
  switch (role) {
    case 'PRIMARY_ACTION':
      return '#16A34A';
    case 'DANGER_ACTION':
      return '#DC2626';
    case 'WARNING_ACTION':
      return '#D97706';
    case 'KPI_HERO':
      return '#0284C7';
    default:
      return '#2563EB';
  }
}

export interface RenderSvgOptions {
  showDebugOverlay?: boolean;
}

export function renderScreenToSvg(
  screen: HmiScreen,
  tags: Record<string, TagDefinition>,
  options: RenderSvgOptions = {}
): string {
  const showDebug = Boolean(options.showDebugOverlay);
  const theme = resolveScreenTheme(screen);
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(tags, name);
  const pipeElements = (screen.pipes ?? []).map((p) => {
    const pts = p.waypoints.map((pt) => `${pt.x},${pt.y}`).join(' ');
    const stroke = Object.prototype.hasOwnProperty.call(PIPE_FLUID_COLOR, p.fluid)
      ? PIPE_FLUID_COLOR[p.fluid]
      : '#334155';
    const dashAttr = p.fluid === 'SIGNAL' ? ' stroke-dasharray="6,4"' : '';
    let mid = p.waypoints[0];
    let bestLen = -1;
    for (let i = 0; i < p.waypoints.length - 1; i++) {
      const a = p.waypoints[i];
      const b = p.waypoints[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen > bestLen) {
        bestLen = segLen;
        mid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
      }
    }
    const flowTag = p.flowTagName && hasOwnTag(p.flowTagName) ? tags[p.flowTagName] : undefined;
    const labelText = p.label ?? (flowTag ? `${p.flowTagName}: ${flowTag.currentValue}${flowTag.unit ? ' ' + flowTag.unit : ''}` : '');
    const boxW = Math.max(84, labelText.length * 6 + 12);
    return [
      `  <g id="${escapeXml(p.id)}" data-type="PIPELINE" data-from="${escapeXml(p.fromWidgetId)}" data-to="${escapeXml(p.toWidgetId)}" data-fluid="${escapeXml(p.fluid)}">`,
      `    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linejoin="round"${dashAttr} marker-end="url(#pid-arrow)" />`,
      ...(labelText && mid
        ? [
            `    <rect x="${mid.x - Math.round(boxW / 2)}" y="${mid.y - 16}" width="${boxW}" height="16" rx="2" fill="${theme.cardBg}" fill-opacity="0.94" stroke="${theme.panelBorder}" stroke-width="0.75" />`,
            `    <text x="${mid.x}" y="${mid.y - 5}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9" fill="${theme.textPrimary}">${escapeXml(labelText)}</text>`,
          ]
        : []),
      `  </g>`,
    ].join('\n');
  });

  // Render GROUP_PANEL containers behind all other widgets
  const sortedWidgets = [
    ...screen.widgets.filter((w) => w.type === 'GROUP_PANEL'),
    ...screen.widgets.filter((w) => w.type !== 'GROUP_PANEL'),
  ];

  const clipDefs = sortedWidgets.map((w, idx) => {
    const safeClipId = `clip_${idx}_${w.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    return `    <clipPath id="${safeClipId}"><rect x="${w.x + 2}" y="${w.y + 2}" width="${Math.max(8, w.width - 4)}" height="${Math.max(8, w.height - 4)}" /></clipPath>`;
  });

  const elements = sortedWidgets.map((w, idx) => {
    const safeClipId = `clip_${idx}_${w.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const surface = resolveWidgetSurfaceContext(screen, w);
    const tag = w.tagName && hasOwnTag(w.tagName) ? tags[w.tagName] : undefined;
    const rawVal = tag !== undefined ? tag.currentValue : undefined;
    const valueText = rawVal !== undefined ? String(rawVal) : '--';
    const rawTruthy = rawVal === true || rawVal === 1 || rawVal === '1' || rawVal === 'true';
    const isTruthy = w.props?.invertDisplay ? !rawTruthy : rawTruthy;
    const roleAccent = getRoleAccentColor(w.visualRole);
    const badgeY = w.height >= 44 ? w.y + w.height - 5 : w.y + 14;
    const valueY = w.height >= 44 ? Math.min(w.y + w.height - 10, w.y + 42) : w.y + Math.min(w.height - 8, 34);

    const inner: string[] = [];

    if (w.type === 'GROUP_PANEL') {
      const pCols = getGroupPanelColors(w, theme);
      if (pCols.isDarkBar) {
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${pCols.bodyBg}" stroke="${pCols.border}" stroke-width="1.25" />`);
        if (w.label) {
          const availW = computeBannerTitleAvailableWidth(screen, w);
          const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 14;
          const fitted = fitFontSizeToWidth(w.label, availW, prefSize, 9, true);
          inner.push(`    <text x="${w.x + 14}" y="${w.y + Math.round(w.height / 2) + Math.round(fitted * 0.35)}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${pCols.headerText}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
        }
      } else if (w.props?.theme === 'light_banner') {
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${pCols.bodyBg}" stroke="${pCols.border}" stroke-width="1.25" />`);
        if (w.label) {
          const availW = computeBannerTitleAvailableWidth(screen, w);
          const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 14;
          const fitted = fitFontSizeToWidth(w.label, availW, prefSize, 9, true);
          inner.push(`    <text x="${w.x + 14}" y="${w.y + Math.round(w.height / 2) + Math.round(fitted * 0.35)}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${pCols.headerText}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
        }
      } else {
        const hdrH = getGroupPanelHeaderHeight(w);
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${pCols.bodyBg}" stroke="${pCols.border}" stroke-width="1.25" />`);
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${hdrH}" rx="4" fill="${pCols.headerBg}" />`);
        inner.push(`    <rect x="${w.x}" y="${w.y + hdrH - 6}" width="${w.width}" height="6" fill="${pCols.headerBg}" />`);
        if (w.label) {
          const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
          const fitted = fitFontSizeToWidth(w.label, Math.max(40, w.width - 20), prefSize, 8, true);
          inner.push(`    <text x="${w.x + 10}" y="${w.y + Math.round(hdrH / 2) + Math.round(fitted * 0.35)}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${pCols.headerText}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
        }
      }
    } else if (w.type === 'LABEL') {
      if (typeof w.props?.customImageBase64 === 'string' && w.props.customImageBase64.length > 0) {
        const cleanB64 = w.props.customImageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/i, '').replace(/\s+/g, '');
        inner.push(`    <image x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${cleanB64}" />`);
      } else if (w.props?.nativeSymbol === 'HWClock4') {
        const clkBg = surface.isDarkSurface ? surface.surfaceBg : theme.clockBg;
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="${clkBg}" />`);
        inner.push(`    <text x="${w.x + w.width - 4}" y="${w.y + Math.round(w.height / 2) + 5}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="700" fill="${theme.clockText}" clip-path="url(#${safeClipId})">12:00:00</text>`);
      } else {
        const explicitBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined);
        const bg = explicitBg ?? surface.surfaceBg;
        const fg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? surface.defaultTextColor;
        const align = w.props?.align === 'center' ? 'middle' : w.props?.align === 'right' ? 'end' : 'start';
        const tx = align === 'middle' ? w.x + Math.round(w.width / 2) : align === 'end' ? w.x + w.width - 2 : w.x + 2;
        const bold = w.props?.bold !== false;
        const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
        const fitted = fitFontSizeToWidth(w.label, Math.max(20, w.width - 4), prefSize, 8, bold);
        if (explicitBg) {
          inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="2" fill="${bg}" />`);
        }
        inner.push(`    <text x="${tx}" y="${w.y + Math.round(w.height / 2) + Math.round(fitted * 0.35)}" text-anchor="${align}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="${bold ? 700 : 400}" fill="${fg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      }
    } else if (w.type === 'ALARM_BANNER') {
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#1E293B" stroke="#0F172A" stroke-width="1" />`);
      inner.push(`    <rect x="${w.x + 10}" y="${w.y + 11}" width="64" height="22" rx="11" fill="#16A34A" />`);
      inner.push(`    <text x="${w.x + 42}" y="${w.y + 26}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="10" font-weight="700" fill="#FFFFFF">ALM OK</text>`);
      inner.push(`    <text x="${w.x + 86}" y="${w.y + 26}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
    } else if (w.type === 'NAV_BAR') {
      const activeNav = Boolean(w.props?.active);
      const navBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined)
        ?? (activeNav ? theme.navActiveBg : theme.navBg);
      const navFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? theme.navText;
      const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
      const fitted = fitFontSizeToWidth(w.label, Math.max(24, w.width - 12), prefSize, 8, true);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${navBg}" stroke="#0F172A" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + Math.round(w.width / 2)}" y="${w.y + Math.round(w.height / 2) + Math.round(fitted * 0.35)}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${navFg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
    } else if (w.type === 'BIT_BUTTON') {
      const geom = computeBitButtonGeometry(w);
      const lblFg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      ) ?? surface.defaultTextColor;
      const r = Math.max(8, Math.floor(geom.iconSize / 2) - 2);
      const cx = Math.round(geom.iconX + geom.iconSize / 2);
      const cy = Math.round(geom.iconY + geom.iconSize / 2);
      const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
      const fitted = fitFontSizeToWidth(w.label, geom.labelW, prefSize, 8, true);
      const align = geom.labelAlign === 'center' ? 'middle' : 'start';
      const tx = geom.labelAlign === 'center' ? geom.labelX + Math.round(geom.labelW / 2) : geom.labelX;
      inner.push(`    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${roleAccent}" stroke="#475569" stroke-width="2" />`);
      inner.push(`    <circle cx="${cx}" cy="${cy}" r="${Math.max(4, Math.round(r * 0.65))}" fill="${roleAccent}" fill-opacity="0.85" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1.5" />`);
      inner.push(`    <text x="${tx}" y="${geom.labelY + Math.round(geom.labelH / 2) + Math.round(fitted * 0.35)}" text-anchor="${align}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${lblFg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
    } else if (w.type === 'BIT_LAMP') {
      const geom = computeBitLampGeometry(w);
      const ledColor =
        w.visualRole === 'DANGER_ACTION'
          ? isTruthy
            ? '#16A34A'
            : '#DC2626'
          : isTruthy
            ? '#16A34A'
            : '#64748B';
      const lblFg = normalizeHexColor(
        typeof w.props?.labelColor === 'string'
          ? w.props.labelColor
          : typeof w.props?.color === 'string'
            ? w.props.color
            : undefined
      ) ?? surface.defaultTextColor;
      const r = Math.max(6, Math.floor(geom.ledSize / 2) - 2);
      const cx = Math.round(geom.ledX + geom.ledSize / 2);
      const cy = Math.round(geom.ledY + geom.ledSize / 2);
      const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : geom.horizontal ? 11 : 10;
      const fitted = fitFontSizeToWidth(w.label, geom.labelW, prefSize, 8, true);
      const align = geom.labelAlign === 'center' ? 'middle' : 'start';
      const tx = geom.labelAlign === 'center' ? geom.labelX + Math.round(geom.labelW / 2) : geom.labelX;
      inner.push(`    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${ledColor}" stroke="#475569" stroke-width="1.5" />`);
      inner.push(`    <text x="${tx}" y="${geom.labelY + Math.round(geom.labelH / 2) + Math.round(fitted * 0.35)}" text-anchor="${align}" font-family="IBM Plex Sans, sans-serif" font-size="${fitted}" font-weight="700" fill="${lblFg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
    } else if (w.type === 'MULTI_STATE_INDICATOR') {
      const labelFg = normalizeHexColor(typeof w.props?.labelColor === 'string' ? w.props.labelColor : undefined) ?? surface.secondaryTextColor;
      const pillBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? '#1E293B';
      const pillFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? pickReadableTextColor(pillBg);
      const labelH = 18;
      const pillH = Math.max(20, w.height - labelH);
      const fittedLbl = fitFontSizeToWidth(w.label, Math.max(24, w.width - 8), 10, 8, true);
      inner.push(`    <text x="${w.x + 2}" y="${w.y + 13}" font-family="IBM Plex Sans, sans-serif" font-size="${fittedLbl}" font-weight="700" fill="${labelFg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${w.x}" y="${w.y + labelH}" width="${w.width}" height="${pillH}" rx="4" fill="${pillBg}" stroke="${theme.cardBorder}" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + Math.round(w.width / 2)}" y="${w.y + labelH + Math.round(pillH / 2) + 4}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="700" fill="${pillFg}" clip-path="url(#${safeClipId})">${escapeXml(valueText)}</text>`);
    } else if (w.type === 'GAUGE') {
      const minV = w.min ?? 0;
      const maxV = w.max ?? 100;
      const numV = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? minV) || minV;
      const ratio = maxV > minV ? Math.max(0, Math.min(1, (numV - minV) / (maxV - minV))) : 0;
      const arcR = Math.min(28, Math.max(14, Math.floor((Math.min(w.width, w.height) - 44) / 2)));
      const cx = w.x + Math.round(w.width / 2);
      const cy = w.y + Math.round(w.height * 0.62);
      const endX = cx - arcR * Math.cos(Math.PI * ratio);
      const endY = cy - arcR * Math.sin(Math.PI * ratio);
      const fittedLbl = fitFontSizeToWidth(w.label, Math.max(24, w.width - 16), 11, 8, true);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1" />`);
      inner.push(`    <text x="${cx}" y="${w.y + 17}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="${fittedLbl}" font-weight="700" fill="${theme.textPrimary}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <path d="M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${cx + arcR} ${cy}" fill="none" stroke="${theme.panelBorder}" stroke-width="6" stroke-linecap="round" />`);
      if (ratio > 0.01) {
        inner.push(`    <path d="M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${endX.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="${theme.accentPrimary}" stroke-width="6" stroke-linecap="round" />`);
      }
      inner.push(`    <text x="${cx}" y="${Math.min(w.y + w.height - 8, cy + 20)}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="14" font-weight="700" fill="${theme.accentPrimary}" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
    } else if (w.type === 'BAR_GRAPH') {
      const minV = w.min ?? 0;
      const maxV = w.max ?? 100;
      const numV = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? minV) || minV;
      const ratio = maxV > minV ? Math.max(0, Math.min(1, (numV - minV) / (maxV - minV))) : 0;
      const fittedLbl = fitFontSizeToWidth(w.label, Math.max(24, w.width - 16), 11, 8, true);
      const barW = Math.max(24, w.width - 20);
      const fillW = Math.round(barW * ratio);
      const barY = Math.min(w.y + w.height - 18, w.y + 42);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 16}" font-family="IBM Plex Sans, sans-serif" font-size="${fittedLbl}" font-weight="700" fill="${theme.textPrimary}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 33}" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="700" fill="${theme.accentPrimary}" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      inner.push(`    <rect x="${w.x + 10}" y="${barY}" width="${barW}" height="10" rx="3" fill="${theme.panelBorder}" />`);
      if (fillW > 0) {
        inner.push(`    <rect x="${w.x + 10}" y="${barY}" width="${fillW}" height="10" rx="3" fill="${theme.accentPrimary}" />`);
      }
    } else if (w.type === 'TREND_CHART') {
      const gx = w.x + 14;
      const gy = w.y + 28;
      const gw = Math.max(40, w.width - 28);
      const gh = Math.max(24, w.height - 40);
      const pts = [0, 0.2, 0.4, 0.6, 0.8, 1]
        .map((t, i) => {
          const px = gx + Math.round(t * gw);
          const py = gy + Math.round((0.55 - 0.25 * Math.sin(i * 1.3)) * gh);
          return `${px},${py}`;
        })
        .join(' ');
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="11.5" font-weight="700" fill="${theme.textPrimary}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="${theme.canvasBg}" stroke="${theme.panelBorder}" stroke-width="0.75" />`);
      inner.push(`    <line x1="${gx}" y1="${gy + Math.round(gh / 2)}" x2="${gx + gw}" y2="${gy + Math.round(gh / 2)}" stroke="${theme.panelBorder}" stroke-dasharray="3,3" />`);
      inner.push(`    <polyline points="${pts}" fill="none" stroke="${theme.accentPrimary}" stroke-width="2" />`);
    } else if (w.type === 'DATA_TABLE') {
      const tx = w.x + 10;
      const ty = w.y + 26;
      const tw = Math.max(40, w.width - 20);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="11.5" font-weight="700" fill="${theme.textPrimary}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${tx}" y="${ty}" width="${tw}" height="18" fill="${theme.panelHeaderBg}" />`);
      inner.push(`    <rect x="${tx}" y="${ty + 18}" width="${tw}" height="18" fill="${theme.canvasBg}" stroke="${theme.panelBorder}" stroke-width="0.5" />`);
      inner.push(`    <text x="${tx + 6}" y="${ty + 31}" font-family="IBM Plex Mono, monospace" font-size="11" fill="${theme.textSecondary}" clip-path="url(#${safeClipId})">${escapeXml(w.tagName ?? 'ROW')}: ${escapeXml(valueText)}</text>`);
    } else if (w.type === 'CAMERA_VIEW') {
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="#0F172A" stroke="#334155" stroke-width="1.25" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="11.5" font-weight="700" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + Math.round(w.width / 2)}" y="${w.y + Math.round(w.height / 2) + 4}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="#94A3B8" clip-path="url(#${safeClipId})">LIVE STREAM</text>`);
    } else if (w.type === 'STATION' || w.type === 'CONVEYOR' || w.type === 'ACTUATOR' || w.type === 'PUMP' || w.type === 'VALVE' || w.type === 'TANK') {
      const gx = w.x + w.width - 34;
      const gy = w.y + Math.round(w.height / 2);
      const statusCol = isTruthy ? '#16A34A' : '#475569';
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1.25" />`);
      if (w.type === 'STATION') {
        inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="26" rx="4" fill="#334155" />`);
        inner.push(`    <text x="${w.x + Math.round(w.width / 2)}" y="${w.y + 17}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="${fitFontSizeToWidth(w.label, Math.max(30, w.width - 16), 11, 8, true)}" font-weight="700" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      } else {
        inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="${fitFontSizeToWidth(w.label, Math.max(30, w.width - 48), 11.5, 8, true)}" font-weight="700" fill="${theme.textPrimary}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
        inner.push(`    <text x="${w.x + 10}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="12" fill="${theme.textSecondary}" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      }
      if (w.type === 'PUMP') {
        inner.push(`    <circle cx="${gx}" cy="${gy}" r="13" fill="${theme.canvasBg}" stroke="${statusCol}" stroke-width="2" />`);
        inner.push(`    <polygon points="${gx - 5},${gy - 6} ${gx - 5},${gy + 6} ${gx + 7},${gy}" fill="${statusCol}" />`);
      } else if (w.type === 'VALVE') {
        inner.push(`    <polygon points="${gx - 12},${gy - 8} ${gx},${gy} ${gx - 12},${gy + 8}" fill="${statusCol}" />`);
        inner.push(`    <polygon points="${gx + 12},${gy - 8} ${gx},${gy} ${gx + 12},${gy + 8}" fill="${statusCol}" />`);
      } else if (w.type === 'TANK') {
        inner.push(`    <rect x="${gx - 10}" y="${gy - 14}" width="20" height="28" rx="3" fill="${theme.panelBorder}" stroke="#475569" stroke-width="1.5" />`);
        inner.push(`    <rect x="${gx - 8}" y="${gy}" width="16" height="12" fill="${theme.accentPrimary}" />`);
      } else if (w.type === 'CONVEYOR') {
        inner.push(`    <rect x="${gx - 16}" y="${gy - 5}" width="32" height="10" rx="5" fill="${theme.panelBorder}" stroke="${statusCol}" stroke-width="1.5" />`);
        inner.push(`    <circle cx="${gx - 10}" cy="${gy}" r="2.5" fill="${statusCol}" />`);
        inner.push(`    <circle cx="${gx + 10}" cy="${gy}" r="2.5" fill="${statusCol}" />`);
      } else {
        inner.push(`    <rect x="${gx - 12}" y="${gy - 12}" width="24" height="24" rx="3" fill="${theme.canvasBg}" stroke="${statusCol}" stroke-width="1.75" />`);
        inner.push(`    <circle cx="${gx}" cy="${gy}" r="5" fill="${isTruthy ? '#16A34A' : '#94A3B8'}" />`);
      }
    } else {
      const cardCols = getRoleCardColors(w.visualRole, theme);
      const cardFill = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? cardCols.fill;
      const cardStroke = cardCols.border;
      const lblFg = normalizeHexColor(typeof w.props?.labelColor === 'string' ? w.props.labelColor : undefined) ?? surface.secondaryTextColor;
      const valFg = normalizeHexColor(typeof w.props?.color === 'string' ? w.props.color : undefined) ?? cardCols.valueColor;
      const labelH = 18;
      const boxH = Math.max(20, w.height - labelH);
      const fittedLbl = fitFontSizeToWidth(w.label, Math.max(24, w.width - 8), typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10, 8, true);
      const valSize = w.visualRole === 'KPI_HERO' ? 16 : 13;
      inner.push(`    <text x="${w.x + 2}" y="${w.y + 13}" font-family="IBM Plex Sans, sans-serif" font-size="${fittedLbl}" font-weight="700" fill="${lblFg}" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${w.x}" y="${w.y + labelH}" width="${w.width}" height="${boxH}" rx="4" fill="${cardFill}" stroke="${cardStroke}" stroke-width="1.25" />`);
      inner.push(`    <text x="${w.x + Math.round(w.width / 2)}" y="${w.y + labelH + Math.round(boxH / 2) + Math.round(valSize * 0.35)}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="${valSize}" font-weight="700" fill="${valFg}" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
    }

    if (showDebug && w.type !== 'GROUP_PANEL') {
      inner.push(`    <text x="${w.x + w.width - 4}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8" fill="#64748B" opacity="0.85">${escapeXml(String(w.type))}</text>`);
    }

    return [
      `  <g id="${escapeXml(w.id)}" data-type="${escapeXml(String(w.type))}" data-tag="${escapeXml(w.tagName ?? '')}">`,
      ...inner,
      `  </g>`,
    ].join('\n');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${screen.width} ${screen.height}" width="${screen.width}" height="${screen.height}">`,
    `  <defs>`,
    `    <marker id="pid-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `      <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155" />`,
    `    </marker>`,
    ...clipDefs,
    `  </defs>`,
    `  <title>${escapeXml(screen.name)}</title>`,
    `  <rect width="100%" height="100%" fill="${escapeXml(screen.backgroundColor)}" />`,
    ...pipeElements,
    ...elements,
    `</svg>`,
  ].join('\n');
}
