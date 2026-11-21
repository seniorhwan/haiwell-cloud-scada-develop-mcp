/**
 * Hardened ISA-101 HMI Auto-Layout Engine, Touch-Target Validator,
 * Faceplate Template Expander, Navigation Graph Verifier, & SVG Generator.
 * Never silently drops overflowing widgets!
 */

import type {
  HaiwellTargetHardware,
  HmiFaceplateTemplate,
  HmiScreen,
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
  isa101Notices: string[];
}

const INTERACTIVE_WIDGET_TYPES = new Set<HmiWidgetType>([
  'BIT_BUTTON',
  'NUMERIC_INPUT',
  'PUMP',
  'VALVE',
  'RECIPE_SELECTOR',
  'NAV_BAR',
]);

export function detectWidgetCollisions(widgets: HmiWidget[]): LayoutCollision[] {
  const collisions: LayoutCollision[] = [];
  for (let i = 0; i < widgets.length; i++) {
    const a = widgets[i];
    for (let j = i + 1; j < widgets.length; j++) {
      const b = widgets[j];
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
  const isa101Notices: string[] = [];

  const isTouchPanel = Boolean(options.targetHardware?.startsWith('CLOUD_HMI_'));
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(knownTags, name);
  const seenWidgetIds = new Set<string>();
  const widgetIdSet = new Set<string>(screen.widgets.map((w) => w.id));

  for (const w of screen.widgets) {
    if (seenWidgetIds.has(w.id)) {
      isa101Notices.push(`Duplicate widget ID "${w.id}" detected on screen "${screen.id}".`);
    }
    seenWidgetIds.add(w.id);

    if (w.width <= 0 || w.height <= 0 || w.x < 0 || w.y < 0 || w.x + w.width > screen.width || w.y + w.height > screen.height) {
      outOfBounds.push(w.id);
    }
    if (w.min !== undefined && w.max !== undefined && w.min > w.max) {
      isa101Notices.push(`Widget "${w.id}" has inverted range (min=${w.min} > max=${w.max}).`);
    }
    if (w.tagName && !hasOwnTag(w.tagName)) {
      unresolvedTags.push(`${w.id}->${w.tagName}`);
    }
    if (w.writeEnabled && w.tagName && hasOwnTag(w.tagName) && knownTags[w.tagName]?.access === 'RO') {
      isa101Notices.push(`Widget "${w.id}" enables write on read-only tag "${w.tagName}".`);
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
    }
    if (!widgetIdSet.has(pipe.toWidgetId)) {
      brokenNavTargets.push(`${pipe.id}.to->${pipe.toWidgetId}`);
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
      touchTargetViolations.length === 0,
    collisions,
    outOfBounds,
    unresolvedTags,
    brokenNavTargets,
    touchTargetViolations,
    isa101Notices,
  };
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
  items: {
    id?: string;
    type: HmiWidgetType;
    label: string;
    tagName?: string;
    writeEnabled?: boolean;
    targetScreenId?: string;
    unit?: string;
    min?: number;
    max?: number;
    colSpan?: number;
    rowSpan?: number;
  }[];
}

export interface AutoLayoutResult {
  screen: HmiScreen;
  overflowWidgets: string[];
}

export function generateAutoLayoutScreen(spec: AutoLayoutSpec): HmiScreen {
  return generateAutoLayoutScreenDetailed(spec).screen;
}

/**
 * Dynamically computes row heights so all widgets fit within viewport without silent drops.
 * If even compact minimum rows (52px) cannot fit all items, explicitly reports overflowWidgets.
 */
export function generateAutoLayoutScreenDetailed(spec: AutoLayoutSpec): AutoLayoutResult {
  const pad = 20;
  const gap = 14;
  const usableWidth = spec.width - pad * 2;
  let cols = Math.max(1, Math.min(spec.columns ?? 4, 8));
  while (cols > 1 && Math.floor((usableWidth - gap * (cols - 1)) / cols) < 48) {
    cols--;
  }
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

  // First pass: calculate total grid rows needed using 2D occupancy grid (prevents span overlap!)
  const occupied = new Set<string>();
  const placements: { item: AutoLayoutSpec['items'][number]; idx: number; col: number; row: number; cSpan: number; rSpan: number }[] = [];
  let maxRowUsed = 0;

  spec.items.forEach((item, idx) => {
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
  });

  const colWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
  const availableHeight = spec.height - topOffset - bottomReserve - pad;
  const computedRowHeight =
    maxRowUsed > 0
      ? Math.min(115, Math.floor((availableHeight - gap * (maxRowUsed - 1)) / maxRowUsed))
      : 110;
  const baseRowHeight = Math.max(52, computedRowHeight);

  for (const p of placements) {
    const x = pad + p.col * (colWidth + gap);
    const y = topOffset + p.row * (baseRowHeight + gap);
    const width = p.cSpan * colWidth + (p.cSpan - 1) * gap;
    const height = p.rSpan * baseRowHeight + (p.rSpan - 1) * gap;
    const id = p.item.id ?? `w_${p.idx + 1}_${p.item.type.toLowerCase()}`;

    if (y + height <= spec.height - bottomReserve - pad + 2) {
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
        unit: p.item.unit,
        min: p.item.min,
        max: p.item.max,
        precision: 2,
      });
    } else {
      overflowWidgets.push(id);
    }
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
};

export function renderScreenToSvg(
  screen: HmiScreen,
  tags: Record<string, TagDefinition>
): string {
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(tags, name);
  const pipeElements = (screen.pipes ?? []).map((p) => {
    const pts = p.waypoints.map((pt) => `${pt.x},${pt.y}`).join(' ');
    const stroke = PIPE_FLUID_COLOR[p.fluid] ?? '#334155';
    const mid = p.waypoints[Math.floor(p.waypoints.length / 2)] ?? p.waypoints[0];
    const flowTag = p.flowTagName && hasOwnTag(p.flowTagName) ? tags[p.flowTagName] : undefined;
    const labelText = p.label ?? (flowTag ? `${p.flowTagName}: ${flowTag.currentValue}${flowTag.unit ? ' ' + flowTag.unit : ''}` : '');
    const boxW = Math.max(84, labelText.length * 6 + 12);
    return [
      `  <g id="${escapeXml(p.id)}" data-type="PIPELINE" data-from="${escapeXml(p.fromWidgetId)}" data-to="${escapeXml(p.toWidgetId)}" data-fluid="${escapeXml(p.fluid)}">`,
      `    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linejoin="round" marker-end="url(#pid-arrow)" />`,
      ...(labelText && mid
        ? [
            `    <rect x="${mid.x - Math.round(boxW / 2)}" y="${mid.y - 16}" width="${boxW}" height="16" rx="2" fill="#FFFFFF" fill-opacity="0.92" stroke="#CBD5E1" stroke-width="0.75" />`,
            `    <text x="${mid.x}" y="${mid.y - 5}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9" fill="#0F172A">${escapeXml(labelText)}</text>`,
          ]
        : []),
      `  </g>`,
    ].join('\n');
  });

  const elements = screen.widgets.map((w) => {
    const tag = w.tagName && hasOwnTag(w.tagName) ? tags[w.tagName] : undefined;
    const valueText = tag !== undefined ? String(tag.currentValue) : '--';
    const fill =
      w.type === 'ALARM_BANNER'
        ? '#F8FAFC'
        : w.type === 'BIT_BUTTON'
          ? '#E2E8F0'
          : '#FFFFFF';

    return [
      `  <g id="${escapeXml(w.id)}" data-type="${w.type}" data-tag="${escapeXml(w.tagName ?? '')}">`,
      `    <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="2" fill="${fill}" stroke="#94A3B8" stroke-width="1" />`,
      `    <text x="${w.x + 10}" y="${w.y + 20}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" fill="#0F172A">${escapeXml(w.label)}</text>`,
      `    <text x="${w.x + 10}" y="${w.y + Math.min(w.height - 12, 48)}" font-family="IBM Plex Mono, monospace" font-size="14" fill="#334155">${escapeXml(valueText)}${w.unit ? ' ' + escapeXml(w.unit) : ''}</text>`,
      `    <text x="${w.x + w.width - 10}" y="${w.y + 18}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="10" fill="#64748B">${escapeXml(w.type)}</text>`,
      `  </g>`,
    ].join('\n');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${screen.width} ${screen.height}" width="${screen.width}" height="${screen.height}">`,
    `  <defs>`,
    `    <marker id="pid-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `      <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155" />`,
    `    </marker>`,
    `  </defs>`,
    `  <title>${escapeXml(screen.name)}</title>`,
    `  <rect width="100%" height="100%" fill="${escapeXml(screen.backgroundColor)}" />`,
    ...pipeElements,
    ...elements,
    `</svg>`,
  ].join('\n');
}
