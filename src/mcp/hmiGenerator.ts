/**
 * Hardened ISA-101 HMI Auto-Layout Engine, Touch-Target Validator,
 * Faceplate Template Expander, Navigation Graph Verifier, & SVG Generator.
 * Never silently drops overflowing widgets!
 */

import type {
  HaiwellTargetHardware,
  HmiFaceplateTemplate,
  HmiScreen,
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
    const headerH = 26;
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

  return {
    screen: {
      id: spec.screenId,
      name: spec.name,
      width: spec.width,
      height: spec.height,
      layoutStandard: spec.layoutStandard,
      backgroundColor: spec.layoutStandard === 'ISA_101_HIGH_PERFORMANCE' ? '#E5E7EB' : '#F1F5F9',
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

export function renderScreenToSvg(
  screen: HmiScreen,
  tags: Record<string, TagDefinition>
): string {
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(tags, name);
  const pipeElements = (screen.pipes ?? []).map((p) => {
    const pts = p.waypoints.map((pt) => `${pt.x},${pt.y}`).join(' ');
    const stroke = Object.prototype.hasOwnProperty.call(PIPE_FLUID_COLOR, p.fluid)
      ? PIPE_FLUID_COLOR[p.fluid]
      : '#334155';
    const dashAttr = p.fluid === 'SIGNAL' ? ' stroke-dasharray="6,4"' : '';
    // Place pipe label at midpoint of the longest straight segment rather than an elbow corner
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
            `    <rect x="${mid.x - Math.round(boxW / 2)}" y="${mid.y - 16}" width="${boxW}" height="16" rx="2" fill="#FFFFFF" fill-opacity="0.92" stroke="#CBD5E1" stroke-width="0.75" />`,
            `    <text x="${mid.x}" y="${mid.y - 5}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9" fill="#0F172A">${escapeXml(labelText)}</text>`,
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
    const tag = w.tagName && hasOwnTag(w.tagName) ? tags[w.tagName] : undefined;
    const rawVal = tag !== undefined ? tag.currentValue : undefined;
    const valueText = rawVal !== undefined ? String(rawVal) : '--';
    const isTruthy = rawVal === true || rawVal === 1 || rawVal === '1' || rawVal === 'true';
    const roleAccent = getRoleAccentColor(w.visualRole);
    const badgeY = w.height >= 44 ? w.y + w.height - 6 : w.y + 16;
    const valueY = w.height >= 44 ? Math.min(w.y + w.height - 16, w.y + 40) : w.y + Math.min(w.height - 10, 36);

    const inner: string[] = [];

    if (w.type === 'GROUP_PANEL') {
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.25" />`);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="24" rx="4" fill="#334155" />`);
      inner.push(`    <rect x="${w.x}" y="${w.y + 16}" width="${w.width}" height="8" fill="#334155" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 16}" font-family="IBM Plex Sans, sans-serif" font-size="11" font-weight="700" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
    } else if (w.type === 'ALARM_BANNER') {
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#1E293B" stroke="#0F172A" stroke-width="1" />`);
      inner.push(`    <rect x="${w.x + 10}" y="${w.y + 11}" width="64" height="22" rx="11" fill="#16A34A" />`);
      inner.push(`    <text x="${w.x + 42}" y="${w.y + 26}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="10" font-weight="700" fill="#FFFFFF">ALM OK</text>`);
      inner.push(`    <text x="${w.x + 86}" y="${w.y + 26}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + w.width - 10}" y="${w.y + 26}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#94A3B8">ALARM_BANNER</text>`);
    } else if (w.type === 'NAV_BAR') {
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#334155" stroke="#1E293B" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 14}" y="${w.y + 26}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#F8FAFC" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + w.width - 10}" y="${w.y + 26}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#CBD5E1">NAV_BAR</text>`);
    } else if (w.type === 'BIT_BUTTON') {
      const btnBg =
        w.visualRole === 'DANGER_ACTION'
          ? '#FEF2F2'
          : w.visualRole === 'PRIMARY_ACTION'
            ? '#F0FDF4'
            : w.visualRole === 'WARNING_ACTION'
              ? '#FFFBEB'
              : '#E2E8F0';
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="4" fill="${btnBg}" stroke="#64748B" stroke-width="1.25" />`);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="6" height="${w.height}" rx="2" fill="${roleAccent}" />`);
      inner.push(`    <text x="${w.x + 14}" y="${w.y + 20}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="700" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 14}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="12" fill="#475569">${isTruthy ? 'ACTIVE' : 'CMD'}</text>`);
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">BIT_BUTTON</text>`);
    } else if (w.type === 'BIT_LAMP' || w.type === 'MULTI_STATE_INDICATOR') {
      const ledColor =
        w.visualRole === 'DANGER_ACTION'
          ? isTruthy
            ? '#16A34A'
            : '#DC2626'
          : isTruthy
            ? '#16A34A'
            : '#94A3B8';
      const stateStr = w.type === 'BIT_LAMP' ? (isTruthy ? 'ON' : 'OFF') : valueText;
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1" />`);
      inner.push(`    <circle cx="${w.x + 18}" cy="${w.y + Math.round(w.height / 2)}" r="8" fill="${ledColor}" stroke="#475569" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 34}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="11.5" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 34}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="13" font-weight="600" fill="#334155" clip-path="url(#${safeClipId})">${escapeXml(stateStr)}</text>`);
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">${escapeXml(w.type)}</text>`);
    } else if (w.type === 'GAUGE') {
      const minV = w.min ?? 0;
      const maxV = w.max ?? 100;
      const numV = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? minV) || minV;
      const ratio = maxV > minV ? Math.max(0, Math.min(1, (numV - minV) / (maxV - minV))) : 0;
      const arcR = Math.min(24, Math.max(14, Math.floor((w.height - 26) / 2)));
      const cx = w.x + w.width - arcR - 18;
      const cy = w.y + Math.round(w.height / 2) + 8;
      const endX = cx - arcR * Math.cos(Math.PI * ratio);
      const endY = cy - arcR * Math.sin(Math.PI * ratio);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 10}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="16" font-weight="700" fill="#0284C7">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      inner.push(`    <path d="M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${cx + arcR} ${cy}" fill="none" stroke="#E2E8F0" stroke-width="6" stroke-linecap="round" />`);
      if (ratio > 0.01) {
        inner.push(`    <path d="M ${cx - arcR} ${cy} A ${arcR} ${arcR} 0 0 1 ${endX.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="#0284C7" stroke-width="6" stroke-linecap="round" />`);
      }
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">GAUGE</text>`);
    } else if (w.type === 'BAR_GRAPH') {
      const minV = w.min ?? 0;
      const maxV = w.max ?? 100;
      const numV = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? minV) || minV;
      const ratio = maxV > minV ? Math.max(0, Math.min(1, (numV - minV) / (maxV - minV))) : 0;
      const barW = Math.max(40, w.width - 20);
      const fillW = Math.round(barW * ratio);
      const barY = Math.min(w.y + w.height - 20, w.y + 38);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + w.width - 10}" y="${w.y + 18}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="700" fill="#0284C7">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      inner.push(`    <rect x="${w.x + 10}" y="${barY}" width="${barW}" height="10" rx="3" fill="#E2E8F0" />`);
      if (fillW > 0) {
        inner.push(`    <rect x="${w.x + 10}" y="${barY}" width="${fillW}" height="10" rx="3" fill="#0284C7" />`);
      }
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">BAR_GRAPH</text>`);
    } else if (w.type === 'TREND_CHART') {
      const gx = w.x + 14;
      const gy = w.y + 28;
      const gw = Math.max(40, w.width - 28);
      const gh = Math.max(30, w.height - 46);
      const pts = [0, 0.2, 0.4, 0.6, 0.8, 1]
        .map((t, i) => {
          const px = gx + Math.round(t * gw);
          const py = gy + Math.round((0.55 - 0.25 * Math.sin(i * 1.3)) * gh);
          return `${px},${py}`;
        })
        .join(' ');
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="0.75" />`);
      inner.push(`    <line x1="${gx}" y1="${gy + Math.round(gh / 2)}" x2="${gx + gw}" y2="${gy + Math.round(gh / 2)}" stroke="#E2E8F0" stroke-dasharray="3,3" />`);
      inner.push(`    <polyline points="${pts}" fill="none" stroke="#0284C7" stroke-width="2" />`);
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">TREND_CHART</text>`);
    } else if (w.type === 'DATA_TABLE') {
      const tx = w.x + 10;
      const ty = w.y + 26;
      const tw = Math.max(40, w.width - 20);
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <rect x="${tx}" y="${ty}" width="${tw}" height="18" fill="#E2E8F0" />`);
      inner.push(`    <rect x="${tx}" y="${ty + 18}" width="${tw}" height="18" fill="#F8FAFC" stroke="#E2E8F0" stroke-width="0.5" />`);
      inner.push(`    <text x="${tx + 6}" y="${ty + 31}" font-family="IBM Plex Mono, monospace" font-size="11" fill="#334155">${escapeXml(w.tagName ?? 'ROW')}: ${escapeXml(valueText)}</text>`);
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">DATA_TABLE</text>`);
    } else if (w.type === 'STATION' || w.type === 'CONVEYOR' || w.type === 'ACTUATOR' || w.type === 'PUMP' || w.type === 'VALVE' || w.type === 'TANK') {
      const gx = w.x + w.width - 34;
      const gy = w.y + Math.round(w.height / 2);
      const statusCol = isTruthy ? '#16A34A' : '#475569';
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="#FFFFFF" stroke="#64748B" stroke-width="1.25" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="700" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 10}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="13" fill="#334155" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      if (w.type === 'PUMP') {
        inner.push(`    <circle cx="${gx}" cy="${gy}" r="13" fill="#F1F5F9" stroke="${statusCol}" stroke-width="2" />`);
        inner.push(`    <polygon points="${gx - 5},${gy - 6} ${gx - 5},${gy + 6} ${gx + 7},${gy}" fill="${statusCol}" />`);
      } else if (w.type === 'VALVE') {
        inner.push(`    <polygon points="${gx - 12},${gy - 8} ${gx},${gy} ${gx - 12},${gy + 8}" fill="${statusCol}" />`);
        inner.push(`    <polygon points="${gx + 12},${gy - 8} ${gx},${gy} ${gx + 12},${gy + 8}" fill="${statusCol}" />`);
      } else if (w.type === 'TANK') {
        inner.push(`    <rect x="${gx - 10}" y="${gy - 14}" width="20" height="28" rx="3" fill="#E2E8F0" stroke="#475569" stroke-width="1.5" />`);
        inner.push(`    <rect x="${gx - 8}" y="${gy}" width="16" height="12" fill="#0284C7" />`);
      } else if (w.type === 'CONVEYOR') {
        inner.push(`    <rect x="${gx - 16}" y="${gy - 5}" width="32" height="10" rx="5" fill="#E2E8F0" stroke="${statusCol}" stroke-width="1.5" />`);
        inner.push(`    <circle cx="${gx - 10}" cy="${gy}" r="2.5" fill="${statusCol}" />`);
        inner.push(`    <circle cx="${gx + 10}" cy="${gy}" r="2.5" fill="${statusCol}" />`);
      } else {
        inner.push(`    <rect x="${gx - 12}" y="${gy - 12}" width="24" height="24" rx="3" fill="#F1F5F9" stroke="${statusCol}" stroke-width="1.75" />`);
        inner.push(`    <circle cx="${gx}" cy="${gy}" r="5" fill="${isTruthy ? '#16A34A' : '#94A3B8'}" />`);
      }
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">${escapeXml(w.type)}</text>`);
    } else {
      const cardFill = w.visualRole === 'KPI_HERO' ? '#F0F9FF' : '#FFFFFF';
      const cardStroke = w.visualRole === 'KPI_HERO' ? '#0284C7' : '#94A3B8';
      const valSize = w.visualRole === 'KPI_HERO' ? 18 : 14;
      inner.push(`    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="3" fill="${cardFill}" stroke="${cardStroke}" stroke-width="1" />`);
      inner.push(`    <text x="${w.x + 10}" y="${w.y + 18}" font-family="IBM Plex Sans, sans-serif" font-size="11.5" font-weight="600" fill="#0F172A" clip-path="url(#${safeClipId})">${escapeXml(w.label)}</text>`);
      inner.push(`    <text x="${w.x + 10}" y="${valueY}" font-family="IBM Plex Mono, monospace" font-size="${valSize}" font-weight="600" fill="#334155" clip-path="url(#${safeClipId})">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`);
      inner.push(`    <text x="${w.x + w.width - 8}" y="${badgeY}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="8.5" fill="#64748B">${escapeXml(String(w.type))}</text>`);
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
