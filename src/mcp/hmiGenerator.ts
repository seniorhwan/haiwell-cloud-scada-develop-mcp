/**
 * Automated HMI Screen Layout Generator & Collision Validator for Haiwell Cloud SCADA Develop.
 * Enforces ISA-101 High-Performance HMI conventions, bounds checking, overlap detection,
 * unified PC/Web/Mobile scaling metadata, and deterministic headless SVG output.
 */

import type { HmiScreen, HmiWidget, HmiWidgetType, TagDefinition } from './types';

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
  isa101Notices: string[];
}

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
  knownTags: Record<string, TagDefinition>
): HmiLayoutValidation {
  const collisions = detectWidgetCollisions(screen.widgets);
  const outOfBounds: string[] = [];
  const unresolvedTags: string[] = [];
  const isa101Notices: string[] = [];

  for (const w of screen.widgets) {
    if (w.x < 0 || w.y < 0 || w.x + w.width > screen.width || w.y + w.height > screen.height) {
      outOfBounds.push(w.id);
    }
    if (w.tagName && !knownTags[w.tagName]) {
      unresolvedTags.push(`${w.id}->${w.tagName}`);
    }
    if (w.writeEnabled && w.tagName && knownTags[w.tagName]?.access === 'RO') {
      isa101Notices.push(`Widget "${w.id}" enables write on read-only tag "${w.tagName}".`);
    }
  }

  if (screen.layoutStandard === 'ISA_101_HIGH_PERFORMANCE') {
    const hasAlarmBanner = screen.widgets.some((w) => w.type === 'ALARM_BANNER');
    if (!hasAlarmBanner) {
      isa101Notices.push('ISA-101 recommends a dedicated top ALARM_BANNER on Level-2/3 operator displays.');
    }
  }

  return {
    valid: collisions.length === 0 && outOfBounds.length === 0 && unresolvedTags.length === 0,
    collisions,
    outOfBounds,
    unresolvedTags,
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
    unit?: string;
    min?: number;
    max?: number;
    colSpan?: number;
    rowSpan?: number;
  }[];
}

export function generateAutoLayoutScreen(spec: AutoLayoutSpec): HmiScreen {
  const pad = 20;
  const gap = 16;
  const cols = Math.max(1, Math.min(spec.columns ?? 4, 8));
  const widgets: HmiWidget[] = [];

  let topOffset = pad;
  const bottomReserve = spec.includeNavBar ? 64 : 0;

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

  const usableWidth = spec.width - pad * 2;
  const colWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
  const baseRowHeight = 110;

  let curCol = 0;
  let curRow = 0;

  spec.items.forEach((item, idx) => {
    const cSpan = Math.max(1, Math.min(item.colSpan ?? 1, cols));
    const rSpan = Math.max(1, Math.min(item.rowSpan ?? 1, 3));

    if (curCol + cSpan > cols) {
      curCol = 0;
      curRow++;
    }

    const x = pad + curCol * (colWidth + gap);
    const y = topOffset + curRow * (baseRowHeight + gap);
    const width = cSpan * colWidth + (cSpan - 1) * gap;
    const height = rSpan * baseRowHeight + (rSpan - 1) * gap;

    if (y + height <= spec.height - bottomReserve - pad) {
      widgets.push({
        id: item.id ?? `w_${idx + 1}_${item.type.toLowerCase()}`,
        type: item.type,
        label: item.label,
        x,
        y,
        width,
        height,
        tagName: item.tagName,
        writeEnabled: item.writeEnabled ?? false,
        unit: item.unit,
        min: item.min,
        max: item.max,
        precision: 2,
      });
    }

    curCol += cSpan;
    if (curCol >= cols) {
      curCol = 0;
      curRow += rSpan;
    }
  });

  if (spec.includeNavBar) {
    widgets.push({
      id: `${spec.screenId}_nav_bar`,
      type: 'NAV_BAR',
      label: 'Screen Navigation',
      x: pad,
      y: spec.height - 52 - pad / 2,
      width: spec.width - pad * 2,
      height: 44,
    });
  }

  return {
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
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates deterministic, standards-compliant SVG blueprint for a Haiwell HMI screen.
 * Suitable for headless visual diffing, archival, or import as custom Haiwell vector mimic.
 */
export function renderScreenToSvg(
  screen: HmiScreen,
  tags: Record<string, TagDefinition>
): string {
  const elements = screen.widgets.map((w) => {
    const tag = w.tagName ? tags[w.tagName] : undefined;
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
    `  <title>${escapeXml(screen.name)}</title>`,
    `  <rect width="100%" height="100%" fill="${escapeXml(screen.backgroundColor)}" />`,
    ...elements,
    `</svg>`,
  ].join('\n');
}
