import { getGroupPanelHeaderHeight, resolveScreenTheme } from './hmiDesignSystem';
import type { HmiPipeRoute, HmiScreen, HmiThemeId, HmiVisualRole, HmiWidget } from './types';

export type HmiTemplateKind =
  | 'INDUSTRIAL_LINE_OVERVIEW'
  | 'MULTI_STATION_PROCESS_FLOW'
  | 'ALARMS_TRENDS_DIAGNOSTICS'
  | 'STATION_IO_DETAIL'
  | 'STATION_IO_MONITOR'
  | 'MAIN_NAVIGATION_HUB'
  | 'STATION_ALARMS_SIMPLE'
  | 'EDGE_LOGGER_CONSOLE';

export interface TemplateNavTab {
  label: string;
  targetScreenName: string;
  targetWindowId?: number;
  active?: boolean;
}

export interface TemplateCommandItem {
  label: string;
  tagName: string;
  role?: HmiVisualRole;
}

export interface TemplateIndicatorItem {
  label: string;
  tagName: string;
  role?: HmiVisualRole;
  invertDisplay?: boolean;
}

export interface TemplateReadoutItem {
  label: string;
  tagName: string;
  unit?: string;
  precision?: number;
  role?: HmiVisualRole;
}

export interface TemplateStationItem {
  title: string;
  icon: 'HWReactor25' | 'HWCursor3' | 'Motor1';
  secondaryIcon?: 'HWGear1';
  tagName?: string;
  ioIndicators?: TemplateIndicatorItem[];
  kpi?: TemplateReadoutItem;
}

export interface TemplateTransferItem {
  label: string;
  fluid: 'TRANSFER' | 'SIGNAL';
  conveyorTagName?: string;
}

export interface TemplatePanelTitles {
  left?: string;
  middle?: string;
  right?: string;
  inputs?: string;
  outputs?: string;
  faults?: string;
  alarms?: string;
  history?: string;
}

export interface InstantiateTemplateInput {
  template: HmiTemplateKind;
  screenId: string;
  name: string;
  title: string;
  themeId?: HmiThemeId;
  panelTitles?: TemplatePanelTitles;
  width?: number;
  height?: number;
  eStopTag?: string;
  navTabs?: TemplateNavTab[];
  // INDUSTRIAL_LINE_OVERVIEW
  commands?: TemplateCommandItem[];
  commIndicators?: TemplateIndicatorItem[];
  leftReadouts?: TemplateReadoutItem[];
  gauge?: { label: string; tagName: string; min?: number; max?: number; unit?: string; precision?: number };
  bar?: { label: string; tagName: string; min?: number; max?: number; unit?: string };
  heroKpis?: TemplateReadoutItem[];
  stationCycles?: TemplateReadoutItem[];
  ioIndicators?: TemplateIndicatorItem[];
  includeAlarmTable?: boolean;
  // MULTI_STATION_PROCESS_FLOW
  stations?: TemplateStationItem[];
  transfers?: TemplateTransferItem[];
  quickCommands?: TemplateCommandItem[];
  bottomReadouts?: TemplateReadoutItem[];
  // ALARMS_TRENDS_DIAGNOSTICS
  trendTagName?: string;
  runIdTagName?: string;
  sequenceCounters?: TemplateReadoutItem[];
  // STATION_IO_DETAIL & STATION_IO_MONITOR
  inputs?: TemplateIndicatorItem[];
  outputs?: TemplateCommandItem[];
  outputIndicators?: TemplateIndicatorItem[];
  commTagName?: string;
  commLabel?: string;
  stationCounter?: TemplateReadoutItem;
  // MAIN_NAVIGATION_HUB
  subtitle?: string;
  brandingLogos?: { base64: string; x: number; y: number; width: number; height: number }[];
  hubNavCards?: TemplateNavTab[];
}

export interface InstantiateTemplateResult {
  screen: HmiScreen;
  warnings: string[];
}

function takeWithWarning<T>(
  items: T[] | undefined,
  max: number,
  fieldName: string,
  warnings: string[]
): T[] {
  const list = items ?? [];
  if (list.length > max) {
    warnings.push(
      `Template truncated "${fieldName}" from ${list.length} items to max ${max} slots (${list.length - max} omitted).`
    );
  }
  return list.slice(0, max);
}

function makeHeader(
  key: string,
  title: string,
  statusTag?: string,
  statusLabel = 'E-STOP OK',
  statusRole: 'DANGER_ACTION' | 'PRIMARY_ACTION' | 'STATUS_READONLY' = 'DANGER_ACTION'
): HmiWidget[] {
  const out: HmiWidget[] = [
    {
      id: `${key}_hdr_bg`,
      type: 'GROUP_PANEL',
      label: title,
      x: 10,
      y: 8,
      width: 1004,
      height: 44,
      props: { theme: 'dark' },
    },
  ];
  if (statusTag) {
    out.push({
      id: `${key}_hdr_estop`,
      type: 'BIT_LAMP',
      label: statusLabel,
      tagName: statusTag,
      visualRole: statusRole,
      x: 706,
      y: 13,
      width: 142,
      height: 34,
      props: { labelColor: '#F8FAFC' },
    });
  }
  out.push({
    id: `${key}_hdr_clk`,
    type: 'LABEL',
    label: 'CLOCK',
    x: 860,
    y: 18,
    width: 144,
    height: 24,
    props: { nativeSymbol: 'HWClock4' },
  });
  return out;
}

function makeNavBar(key: string, tabs: TemplateNavTab[] | undefined, warnings: string[]): HmiWidget[] {
  const list = takeWithWarning(tabs, 6, 'navTabs', warnings);
  if (list.length === 0) return [];
  const totalW = 996;
  const gap = 8;
  const btnW = Math.floor((totalW - gap * (list.length - 1)) / list.length);
  return list.map((t, idx) => ({
    id: `${key}_nav_${idx}`,
    type: 'NAV_BAR',
    label: t.label,
    x: 14 + idx * (btnW + gap),
    y: 540,
    width: btnW,
    height: 46,
    props: {
      targetScreenName: t.targetScreenName,
      ...(t.targetWindowId !== undefined ? { targetWindowId: t.targetWindowId } : {}),
      active: Boolean(t.active),
    },
  }));
}

const SCALE_INTERACTIVE_TYPES = new Set(['NAV_BAR', 'BIT_BUTTON', 'NUMERIC_INPUT']);

function scaleScreen(screen: HmiScreen, targetW: number, targetH: number): HmiScreen {
  if (targetW === 1024 && targetH === 600) return screen;
  const sx = targetW / 1024;
  const hasBottomNav = screen.widgets.some((w) => w.type === 'NAV_BAR' && w.y >= 520);
  const rawNavH = Math.round(46 * (targetH / 600));
  const preserveTouchNav = hasBottomNav && rawNavH < 44 && targetH >= 320;
  const navH = preserveTouchNav ? 44 : Math.max(24, rawNavH);
  const navY = preserveTouchNav ? targetH - navH - 6 : Math.round(540 * (targetH / 600));
  const bodySy = preserveTouchNav ? (navY - 8) / 532 : targetH / 600;
  const fontScale = Math.min(sx, bodySy);
  const enforceTouchTargets = targetW >= 480 && targetH >= 320;

  // Map each non-panel widget to its original enclosing GROUP_PANEL so scaling preserves header clearance and panel bounds
  const origPanels = screen.widgets.filter((w) => w.type === 'GROUP_PANEL');
  const origPanelById = new Map<string, HmiWidget>(origPanels.map((p) => [p.id, p]));
  const origParentById = new Map<string, string>();
  for (const w of screen.widgets) {
    if (w.type === 'GROUP_PANEL') continue;
    const cx = w.x + w.width / 2;
    const cy = w.y + w.height / 2;
    let bestId: string | null = null;
    let bestArea = Infinity;
    for (const p of origPanels) {
      if (cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height) {
        const area = p.width * p.height;
        if (area < bestArea) {
          bestArea = area;
          bestId = p.id;
        }
      }
    }
    if (bestId) origParentById.set(w.id, bestId);
  }

  const scaleProps = (w: HmiWidget): HmiWidget['props'] => {
    if (!w.props) return undefined;
    const nextProps = { ...w.props };
    if (typeof nextProps.fontSize === 'number') {
      nextProps.fontSize = Math.max(8, Number((nextProps.fontSize * fontScale).toFixed(1)));
    }
    return nextProps;
  };

  // Pre-compute scaled GROUP_PANEL bounds and header heights first so child widgets map cleanly into scaled panel bodies
  const scaledPanelById = new Map<string, HmiWidget>();
  for (const p of origPanels) {
    const width = Math.min(targetW, Math.max(24, Math.round(p.width * sx)));
    const height = Math.min(targetH, Math.max(20, Math.round(p.height * bodySy)));
    const x = Math.max(0, Math.min(Math.round(p.x * sx), targetW - width));
    const y = Math.max(0, Math.min(Math.round(p.y * bodySy), targetH - height));
    scaledPanelById.set(p.id, { ...p, x, y, width, height });
  }

  // First pass: scale all widgets (mapping titled GROUP_PANEL children proportionally inside the scaled body below the header)
  const scaledWidgets = screen.widgets.map((w) => {
    const nextProps = scaleProps(w);
    if (w.type === 'GROUP_PANEL') {
      const sp = scaledPanelById.get(w.id)!;
      return {
        ...w,
        ...(nextProps ? { props: nextProps } : {}),
        x: sp.x,
        y: sp.y,
        width: sp.width,
        height: sp.height,
      };
    }

    if (preserveTouchNav && w.type === 'NAV_BAR' && w.y >= 520) {
      const width = Math.min(targetW, Math.max(44, Math.round(w.width * sx)));
      const x = Math.max(0, Math.min(Math.round(w.x * sx), targetW - width));
      const y = Math.max(0, Math.min(navY, targetH - navH));
      return {
        ...w,
        ...(nextProps ? { props: nextProps } : {}),
        x,
        y,
        width,
        height: navH,
      };
    }

    let width = Math.min(targetW, Math.max(24, Math.round(w.width * sx)));
    let height = Math.min(targetH, Math.max(20, Math.round(w.height * bodySy)));
    let x = Math.max(0, Math.min(Math.round(w.x * sx), targetW - width));
    let y = Math.max(0, Math.min(Math.round(w.y * bodySy), targetH - height));

    const parentId = origParentById.get(w.id);
    if (parentId) {
      const origP = origPanelById.get(parentId)!;
      const scaledP = scaledPanelById.get(parentId)!;
      const origHdr = getGroupPanelHeaderHeight(origP);
      const scaledHdr = getGroupPanelHeaderHeight(scaledP);
      if (origHdr > 0 && scaledHdr > 0 && w.y >= origP.y + origHdr) {
        const origBodyTop = origP.y + origHdr;
        const origBodyH = Math.max(24, origP.height - origHdr);
        const scaledBodyTop = scaledP.y + scaledHdr;
        const scaledBodyH = Math.max(24, scaledP.height - scaledHdr);
        const localSy = scaledBodyH / origBodyH;
        height = Math.min(scaledBodyH, Math.max(20, Math.round(w.height * localSy)));
        y = Math.max(
          scaledBodyTop,
          Math.min(scaledBodyTop + Math.round((w.y - origBodyTop) * localSy), scaledP.y + scaledP.height - height)
        );
      }
    }

    return {
      ...w,
      ...(nextProps ? { props: nextProps } : {}),
      x,
      y,
      width,
      height,
    };
  });

  // Second pass: protect interactive touch targets >= 44px clamped cleanly within enclosing panel body or screen
  if (enforceTouchTargets) {
    for (const w of scaledWidgets) {
      if (w.type === 'GROUP_PANEL') continue;
      if (!SCALE_INTERACTIVE_TYPES.has(w.type) && !w.writeEnabled) continue;
      const pId = origParentById.get(w.id);
      const bounds = pId ? scaledPanelById.get(pId) : undefined;
      const hdrH = bounds ? getGroupPanelHeaderHeight(bounds) : 0;
      const minX = bounds ? bounds.x + 2 : 0;
      const maxX = bounds ? bounds.x + bounds.width - 2 : targetW;
      const minY = bounds ? bounds.y + (hdrH > 0 ? hdrH + 2 : 2) : 0;
      const maxY = bounds ? bounds.y + bounds.height - 2 : targetH;
      const maxW = Math.max(24, maxX - minX);
      const maxH = Math.max(20, maxY - minY);

      if (w.width < 44 && maxW >= 44) {
        w.width = 44;
      }
      if (w.height < 44 && maxH >= 44) {
        w.height = 44;
      }
      w.x = Math.max(minX, Math.min(w.x, Math.max(minX, maxX - w.width)));
      w.y = Math.max(minY, Math.min(w.y, Math.max(minY, maxY - w.height)));
    }
  }

  return {
    ...screen,
    width: targetW,
    height: targetH,
    widgets: scaledWidgets,
    pipes: screen.pipes?.map((p) => ({
      ...p,
      waypoints: p.waypoints.map((pt) => ({
        x: Math.round(pt.x * sx),
        y: Math.round(pt.y * bodySy),
      })),
    })),
  };
}

function makeIndicatorProps(item: TemplateIndicatorItem): Record<string, string | number | boolean> | undefined {
  return item.invertDisplay ? { invertDisplay: true } : undefined;
}

/**
 * Instantiates a pixel-aligned HMI screen template and returns truncation warnings
 * when supplied arrays exceed the template's visual slot limits.
 */
export function instantiateHmiTemplateDetailed(input: InstantiateTemplateInput): InstantiateTemplateResult {
  const warnings: string[] = [];
  const targetW = input.width ?? 1024;
  const targetH = input.height ?? 600;
  const key = input.screenId.replace(/[^a-zA-Z0-9_]/g, '_');
  const now = new Date().toISOString();
  const theme = resolveScreenTheme({ themeId: input.themeId, backgroundColor: '#F1F5F9' });
  const headerTag = input.eStopTag ?? input.commTagName;
  const headerLabel = input.eStopTag ? 'E-STOP OK' : (input.commLabel ?? 'PLC ONLINE');
  const headerRole = input.eStopTag ? 'DANGER_ACTION' : 'STATUS_READONLY';
  const widgets: HmiWidget[] =
    input.template === 'MAIN_NAVIGATION_HUB'
      ? []
      : [...makeHeader(key, input.title, headerTag, headerLabel, headerRole)];
  const pipes: HmiPipeRoute[] = [];

  if (input.template === 'INDUSTRIAL_LINE_OVERVIEW') {
    widgets.push({
      id: `${key}_p_left`,
      type: 'GROUP_PANEL',
      label: input.panelTitles?.left ?? 'LINE COMMANDS & PLC COMM',
      x: 14,
      y: 62,
      width: 310,
      height: 466,
    });
    const cmds = takeWithWarning(input.commands, 3, 'commands', warnings);
    cmds.forEach((c, i) => {
      widgets.push({
        id: `${key}_cmd_${i}`,
        type: 'BIT_BUTTON',
        label: c.label,
        tagName: c.tagName,
        writeEnabled: true,
        visualRole: c.role ?? 'DEFAULT',
        x: 28 + i * 96,
        y: 100,
        width: 88,
        height: 90,
      });
    });

    const comms = takeWithWarning(input.commIndicators, 4, 'commIndicators', warnings);
    comms.forEach((cm, i) => {
      const indProps = makeIndicatorProps(cm);
      widgets.push({
        id: `${key}_comm_${i}`,
        type: 'BIT_LAMP',
        label: cm.label,
        tagName: cm.tagName,
        ...(cm.role ? { visualRole: cm.role } : {}),
        x: 28,
        y: 204 + i * 40,
        width: 282,
        height: 34,
        ...(indProps ? { props: indProps } : {}),
      });
    });

    const leftReads = takeWithWarning(input.leftReadouts, 2, 'leftReadouts', warnings);
    leftReads.forEach((lr, i) => {
      widgets.push({
        id: `${key}_lr_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: lr.label,
        tagName: lr.tagName,
        unit: lr.unit,
        precision: lr.precision,
        ...(lr.role ? { visualRole: lr.role } : {}),
        x: 28,
        y: 374 + i * 72,
        width: 282,
        height: 62,
      });
    });

    widgets.push({
      id: `${key}_p_mid`,
      type: 'GROUP_PANEL',
      label: input.panelTitles?.middle ?? 'PRODUCTION KPIS & YIELD',
      x: 338,
      y: 62,
      width: 344,
      height: 466,
    });
    if (input.gauge) {
      widgets.push({
        id: `${key}_gauge`,
        type: 'GAUGE',
        label: input.gauge.label,
        tagName: input.gauge.tagName,
        min: input.gauge.min ?? 0,
        max: input.gauge.max ?? 100,
        unit: input.gauge.unit ?? '%',
        precision: input.gauge.precision ?? 1,
        x: 352,
        y: 100,
        width: 192,
        height: 214,
      });
    }
    if (input.bar) {
      widgets.push({
        id: `${key}_bar`,
        type: 'BAR_GRAPH',
        label: input.bar.label,
        tagName: input.bar.tagName,
        min: input.bar.min ?? 0,
        max: input.bar.max ?? 100,
        unit: input.bar.unit ?? 'pcs',
        x: 554,
        y: 100,
        width: 114,
        height: 214,
      });
    }

    const heros = takeWithWarning(input.heroKpis, 2, 'heroKpis', warnings);
    heros.forEach((hk, i) => {
      widgets.push({
        id: `${key}_hero_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: hk.label,
        tagName: hk.tagName,
        unit: hk.unit,
        precision: hk.precision,
        visualRole: hk.role ?? 'KPI_HERO',
        x: 352 + i * 162,
        y: 332,
        width: 154,
        height: 76,
      });
    });

    const cycs = takeWithWarning(input.stationCycles, 3, 'stationCycles', warnings);
    cycs.forEach((sc, i) => {
      widgets.push({
        id: `${key}_cyc_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: sc.label,
        tagName: sc.tagName,
        unit: sc.unit ?? 's',
        precision: sc.precision ?? 1,
        x: 352 + i * 108,
        y: 424,
        width: 100,
        height: 72,
      });
    });

    widgets.push({
      id: `${key}_p_right`,
      type: 'GROUP_PANEL',
      label: input.panelTitles?.right ?? 'ACTIVE ALARMS & STATION I/O',
      x: 696,
      y: 62,
      width: 314,
      height: 466,
    });
    const ios = takeWithWarning(input.ioIndicators, 3, 'ioIndicators', warnings);
    ios.forEach((io, i) => {
      const indProps = makeIndicatorProps(io);
      widgets.push({
        id: `${key}_io_${i}`,
        type: 'BIT_LAMP',
        label: io.label,
        tagName: io.tagName,
        ...(io.role ? { visualRole: io.role } : {}),
        x: 710,
        y: 100 + i * 40,
        width: 286,
        height: 34,
        ...(indProps ? { props: indProps } : {}),
      });
    });
    if (input.includeAlarmTable !== false) {
      widgets.push({
        id: `${key}_alm_tbl`,
        type: 'ALARM_BANNER',
        label: 'Active Process Alarms',
        x: 710,
        y: 230,
        width: 286,
        height: 282,
      });
    }
  } else if (input.template === 'MULTI_STATION_PROCESS_FLOW') {
    const stations = takeWithWarning(input.stations, 4, 'stations', warnings);
    const n = Math.max(2, stations.length);
    const gap = n <= 3 ? 136 : 76;
    const marginX = 16;
    const totalW = 1024 - marginX * 2;
    const stW = Math.floor((totalW - gap * (n - 1)) / n);
    const stH = 314;

    stations.forEach((st, idx) => {
      const sx = marginX + idx * (stW + gap);
      widgets.push({
        id: `${key}_st_card_${idx}`,
        type: 'GROUP_PANEL',
        label: st.title,
        x: sx,
        y: 64,
        width: stW,
        height: stH,
      });
      const iconW = st.secondaryIcon ? Math.max(60, stW - 92) : Math.max(80, stW - 28);
      widgets.push({
        id: `${key}_st_${idx}`,
        type: 'ACTUATOR',
        label: st.title,
        tagName: st.tagName,
        x: sx + 14,
        y: 98,
        width: iconW,
        height: 192,
        props: { nativeSymbol: st.icon },
      });
      if (st.secondaryIcon) {
        widgets.push({
          id: `${key}_st_${idx}_sec`,
          type: 'ACTUATOR',
          label: 'Aux',
          x: sx + stW - 72,
          y: 112,
          width: 56,
          height: 56,
          props: { nativeSymbol: st.secondaryIcon },
        });
      }

      // Partition bottom slot evenly across all ioIndicators + optional kpi so 2 indicators + kpi never collide
      const stIos = takeWithWarning(st.ioIndicators, 2, `stations[${idx}].ioIndicators`, warnings);
      const totalSlots = stIos.length + (st.kpi ? 1 : 0);
      if (totalSlots > 0) {
        const innerPad = 10;
        const slotGap = 6;
        const slotW = Math.floor((stW - innerPad * 2 - slotGap * (totalSlots - 1)) / totalSlots);
        stIos.forEach((io, j) => {
          const indProps = makeIndicatorProps(io);
          widgets.push({
            id: `${key}_st_${idx}_io_${j}`,
            type: 'BIT_LAMP',
            label: io.label,
            tagName: io.tagName,
            ...(io.role ? { visualRole: io.role } : {}),
            x: sx + innerPad + j * (slotW + slotGap),
            y: 306,
            width: slotW,
            height: 58,
            ...(indProps ? { props: indProps } : {}),
          });
        });
        if (st.kpi) {
          const kpiSlotIdx = stIos.length;
          widgets.push({
            id: `${key}_st_${idx}_kpi`,
            type: 'NUMERIC_DISPLAY',
            label: st.kpi.label,
            tagName: st.kpi.tagName,
            unit: st.kpi.unit,
            precision: st.kpi.precision,
            ...(st.kpi.role ? { visualRole: st.kpi.role } : {}),
            x: sx + innerPad + kpiSlotIdx * (slotW + slotGap),
            y: 304,
            width: slotW,
            height: 60,
          });
        }
      }

      if (idx < n - 1) {
        const tr = input.transfers?.[idx];
        const leftEdge = sx + stW;
        const rightEdge = leftEdge + gap;
        if (tr) {
          pipes.push({
            id: `${key}_pipe_${idx}`,
            fromWidgetId: `${key}_st_card_${idx}`,
            toWidgetId: `${key}_st_card_${idx + 1}`,
            fromPort: 'right',
            toPort: 'left',
            fluid: tr.fluid,
            label: tr.label,
            waypoints: [{ x: leftEdge, y: 158 }, { x: rightEdge, y: 158 }],
          });
        }
        widgets.push({
          id: `${key}_conv_${idx}`,
          type: 'CONVEYOR',
          label: tr?.label ?? `Transfer ${idx + 1}`,
          tagName: tr?.conveyorTagName,
          x: leftEdge + 8,
          y: 194,
          width: gap - 16,
          height: 44,
        });
      }
    });

    widgets.push({
      id: `${key}_bot_panel`,
      type: 'GROUP_PANEL',
      label: input.panelTitles?.left ?? 'LINE INTERLOCK & QUICK CONTROL',
      x: 16,
      y: 390,
      width: 992,
      height: 138,
    });
    takeWithWarning(input.quickCommands, 3, 'quickCommands', warnings).forEach((qc, i) => {
      widgets.push({
        id: `${key}_qc_${i}`,
        type: 'BIT_BUTTON',
        label: qc.label,
        tagName: qc.tagName,
        writeEnabled: true,
        visualRole: qc.role ?? 'DEFAULT',
        x: 32 + i * 96,
        y: 426,
        width: 86,
        height: 88,
      });
    });
    const reads = takeWithWarning(input.bottomReadouts, 4, 'bottomReadouts', warnings);
    const readAreaX = 336;
    const readW = reads.length > 0 ? Math.floor((656 - 12 * (reads.length - 1)) / reads.length) : 150;
    reads.forEach((rd, i) => {
      widgets.push({
        id: `${key}_br_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: rd.label,
        tagName: rd.tagName,
        unit: rd.unit,
        precision: rd.precision,
        visualRole: rd.role,
        x: readAreaX + i * (readW + 12),
        y: 436,
        width: readW,
        height: 70,
      });
    });
  } else if (input.template === 'ALARMS_TRENDS_DIAGNOSTICS') {
    widgets.push({ id: `${key}_p_alm`, type: 'GROUP_PANEL', label: input.panelTitles?.left ?? 'PROCESS & SAFETY ALARMS', x: 14, y: 62, width: 490, height: 256 });
    widgets.push({ id: `${key}_alm`, type: 'ALARM_BANNER', label: 'Alarm Table', x: 24, y: 98, width: 470, height: 208 });

    widgets.push({ id: `${key}_p_trd`, type: 'GROUP_PANEL', label: input.panelTitles?.middle ?? 'REAL-TIME CYCLE TIME TREND', x: 518, y: 62, width: 492, height: 256 });
    widgets.push({ id: `${key}_trd`, type: 'TREND_CHART', label: 'Cycle Time Trend', tagName: input.trendTagName, x: 528, y: 98, width: 472, height: 208 });

    widgets.push({ id: `${key}_p_hist`, type: 'GROUP_PANEL', label: input.panelTitles?.history ?? 'HISTORICAL DATA & BATCH LOG', x: 14, y: 328, width: 644, height: 200 });
    widgets.push({ id: `${key}_hist`, type: 'DATA_TABLE', label: 'History Table', x: 24, y: 364, width: 624, height: 152 });

    widgets.push({ id: `${key}_p_seq`, type: 'GROUP_PANEL', label: input.panelTitles?.right ?? 'DATA LOGGER COUNTERS', x: 672, y: 328, width: 338, height: 200 });
    if (input.runIdTagName) {
      widgets.push({
        id: `${key}_run_id`,
        type: 'NUMERIC_DISPLAY',
        label: 'Active Run ID',
        tagName: input.runIdTagName,
        x: 686,
        y: 366,
        width: 310,
        height: 64,
      });
    }
    const seqs = takeWithWarning(input.sequenceCounters, 3, 'sequenceCounters', warnings);
    seqs.forEach((sq, i) => {
      widgets.push({
        id: `${key}_seq_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: sq.label,
        tagName: sq.tagName,
        x: 686 + i * 106,
        y: 444,
        width: 98,
        height: 68,
      });
    });
  } else if (input.template === 'STATION_IO_DETAIL') {
    widgets.push({ id: `${key}_p_in`, type: 'GROUP_PANEL', label: input.panelTitles?.inputs ?? 'FIELD SENSOR INPUTS (READ ONLY)', x: 14, y: 62, width: 490, height: 466 });
    takeWithWarning(input.inputs, 8, 'inputs', warnings).forEach((inp, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const indProps = makeIndicatorProps(inp);
      widgets.push({
        id: `${key}_in_${i}`,
        type: 'BIT_LAMP',
        label: inp.label,
        tagName: inp.tagName,
        ...(inp.role ? { visualRole: inp.role } : {}),
        x: 28 + col * 236,
        y: 108 + row * 102,
        width: 224,
        height: 44,
        ...(indProps ? { props: indProps } : {}),
      });
    });

    widgets.push({ id: `${key}_p_out`, type: 'GROUP_PANEL', label: input.panelTitles?.outputs ?? 'ACTUATOR OUTPUTS / MANUAL TEST', x: 518, y: 62, width: 492, height: 466 });
    takeWithWarning(input.outputs, 8, 'outputs', warnings).forEach((outp, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      widgets.push({
        id: `${key}_out_${i}`,
        type: 'BIT_BUTTON',
        label: outp.label,
        tagName: outp.tagName,
        writeEnabled: true,
        visualRole: outp.role ?? 'DEFAULT',
        x: 536 + col * 116,
        y: 108 + row * 190,
        width: 106,
        height: 110,
      });
    });
  } else if (input.template === 'STATION_IO_MONITOR') {
    widgets.push({ id: `${key}_p_ctrl`, type: 'GROUP_PANEL', label: input.panelTitles?.left ?? 'STATION CONTROL', x: 12, y: 62, width: 196, height: 466 });
    takeWithWarning(input.outputs, 3, 'outputs', warnings).forEach((cmd, i) => {
      widgets.push({
        id: `${key}_cmd_${i}`,
        type: 'BIT_BUTTON',
        label: cmd.label,
        tagName: cmd.tagName,
        writeEnabled: true,
        visualRole: cmd.role ?? 'DEFAULT',
        x: 46,
        y: 96 + i * 114,
        width: 128,
        height: 108,
      });
    });
    if (input.stationCounter) {
      widgets.push({
        id: `${key}_cnt`,
        type: 'NUMERIC_DISPLAY',
        label: input.stationCounter.label,
        tagName: input.stationCounter.tagName,
        unit: input.stationCounter.unit ?? 'pcs',
        x: 24,
        y: 444,
        width: 172,
        height: 74,
      });
    }

    widgets.push({ id: `${key}_p_in`, type: 'GROUP_PANEL', label: input.panelTitles?.inputs ?? 'DIGITAL INPUTS', x: 218, y: 62, width: 390, height: 466 });
    takeWithWarning(input.inputs, 8, 'inputs', warnings).forEach((inp, i) => {
      const indProps = makeIndicatorProps(inp);
      widgets.push({
        id: `${key}_in_${i}`,
        type: 'BIT_LAMP',
        label: inp.label,
        tagName: inp.tagName,
        visualRole: inp.role ?? 'STATUS_READONLY',
        x: 230,
        y: 100 + i * 52,
        width: 366,
        height: 42,
        ...(indProps ? { props: indProps } : {}),
      });
    });

    widgets.push({ id: `${key}_p_out`, type: 'GROUP_PANEL', label: input.panelTitles?.outputs ?? 'DIGITAL OUTPUTS', x: 618, y: 62, width: 394, height: 466 });
    takeWithWarning(input.outputIndicators, 8, 'outputIndicators', warnings).forEach((outp, i) => {
      const indProps = makeIndicatorProps(outp);
      widgets.push({
        id: `${key}_out_ind_${i}`,
        type: 'BIT_LAMP',
        label: outp.label,
        tagName: outp.tagName,
        visualRole: outp.role ?? 'STATUS_READONLY',
        x: 630,
        y: 100 + i * 52,
        width: 370,
        height: 42,
        ...(indProps ? { props: indProps } : {}),
      });
    });
  } else if (input.template === 'MAIN_NAVIGATION_HUB') {
    // Top branding banner with optional logos, title/subtitle, alarm indicator, and clock card
    widgets.push({
      id: `${key}_brand_bg`,
      type: 'GROUP_PANEL',
      label: '',
      x: 10,
      y: 8,
      width: 854,
      height: 68,
      props: { theme: 'light_banner', backgroundColor: theme.panelBg },
    });
    const logos = takeWithWarning(input.brandingLogos, 3, 'brandingLogos', warnings);
    logos.forEach((logo, idx) => {
      widgets.push({
        id: `${key}_logo_${idx}`,
        type: 'LABEL',
        label: `LOGO_${idx}`,
        x: logo.x,
        y: logo.y,
        width: logo.width,
        height: logo.height,
        props: { customImageBase64: logo.base64 },
      });
    });
    const rightMostLogoEdge = logos.reduce((maxRight, l) => Math.max(maxRight, l.x + l.width), 0);
    const titleX = logos.length > 0 ? Math.min(438, Math.max(24, Math.round(rightMostLogoEdge + 16))) : 24;
    const titleRightLimit = input.commTagName ? 730 : 850;
    const titleW = Math.max(160, titleRightLimit - titleX);
    const subtitleText = (input.subtitle ?? '').trim();

    widgets.push({
      id: `${key}_hub_title`,
      type: 'LABEL',
      label: input.title,
      x: titleX,
      y: subtitleText ? 17 : 28,
      width: titleW,
      height: 24,
      props: { color: theme.textPrimary, fontSize: 13, bold: true, align: 'left' },
    });
    if (subtitleText) {
      widgets.push({
        id: `${key}_hub_sub`,
        type: 'LABEL',
        label: subtitleText,
        x: titleX,
        y: 43,
        width: titleW,
        height: 18,
        props: { color: theme.textSecondary, fontSize: 10, bold: false, align: 'left' },
      });
    }
    if (input.commTagName) {
      widgets.push({
        id: `${key}_hub_alm`,
        type: 'BIT_LAMP',
        label: input.commLabel ?? 'ALARM',
        tagName: input.commTagName,
        visualRole: 'DANGER_ACTION',
        x: 742,
        y: 22,
        width: 118,
        height: 40,
      });
    }
    widgets.push({
      id: `${key}_hub_clk_bg`,
      type: 'GROUP_PANEL',
      label: '',
      x: 870,
      y: 8,
      width: 144,
      height: 68,
      props: { theme: 'dark' },
    });
    widgets.push({
      id: `${key}_hub_clk`,
      type: 'LABEL',
      label: 'CLOCK',
      x: 878,
      y: 30,
      width: 128,
      height: 24,
      props: { nativeSymbol: 'HWClock4' },
    });

    const hasBottomNav = Boolean(input.navTabs && input.navTabs.length > 0);
    const panelH = hasBottomNav ? 444 : 500;

    widgets.push({ id: `${key}_p_left`, type: 'GROUP_PANEL', label: input.panelTitles?.left ?? 'LINE CONTROL & PLC STATUS', x: 12, y: 84, width: 298, height: panelH });
    takeWithWarning(input.commands, 3, 'commands', warnings).forEach((cmd, i) => {
      widgets.push({
        id: `${key}_cmd_${i}`,
        type: 'BIT_BUTTON',
        label: cmd.label,
        tagName: cmd.tagName,
        writeEnabled: true,
        visualRole: cmd.role ?? 'DEFAULT',
        x: 20 + i * 95,
        y: hasBottomNav ? 118 : 122,
        width: 90,
        height: hasBottomNav ? 98 : 108,
      });
    });
    takeWithWarning(input.commIndicators, 3, 'commIndicators', warnings).forEach((ci, i) => {
      const indProps = makeIndicatorProps(ci);
      widgets.push({
        id: `${key}_comm_${i}`,
        type: 'BIT_LAMP',
        label: ci.label,
        tagName: ci.tagName,
        visualRole: ci.role ?? 'PRIMARY_ACTION',
        x: 24,
        y: (hasBottomNav ? 226 : 244) + i * (hasBottomNav ? 48 : 54),
        width: 274,
        height: 42,
        ...(indProps ? { props: indProps } : {}),
      });
    });
    if (input.ioIndicators?.[0]) {
      const io0 = input.ioIndicators[0];
      const indProps = makeIndicatorProps(io0);
      widgets.push({
        id: `${key}_cloud_ok`,
        type: 'BIT_LAMP',
        label: io0.label,
        tagName: io0.tagName,
        visualRole: io0.role ?? 'PRIMARY_ACTION',
        x: 24,
        y: hasBottomNav ? 376 : 408,
        width: 274,
        height: 42,
        ...(indProps ? { props: indProps } : {}),
      });
    }
    if (input.stationCounter) {
      widgets.push({
        id: `${key}_alm_cnt`,
        type: 'NUMERIC_DISPLAY',
        label: input.stationCounter.label,
        tagName: input.stationCounter.tagName,
        unit: input.stationCounter.unit ?? '',
        x: 24,
        y: hasBottomNav ? 428 : 464,
        width: 274,
        height: hasBottomNav ? 86 : 100,
      });
    }

    widgets.push({ id: `${key}_p_center`, type: 'GROUP_PANEL', label: input.panelTitles?.middle ?? 'SYSTEM NAVIGATION', x: 320, y: 84, width: 416, height: panelH });
    takeWithWarning(input.hubNavCards, 5, 'hubNavCards', warnings).forEach((card, i) => {
      const isFifth = i === 4;
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cardH = hasBottomNav ? 110 : 126;
      const rowStep = hasBottomNav ? 126 : 146;
      const startY = hasBottomNav ? 124 : 132;
      widgets.push({
        id: `${key}_hub_nav_${i}`,
        type: 'NAV_BAR',
        label: card.label,
        x: isFifth ? 334 : 334 + col * 200,
        y: isFifth ? startY + 2 * rowStep : startY + row * rowStep,
        width: isFifth ? 388 : 188,
        height: cardH,
        props: {
          targetScreenName: card.targetScreenName,
          ...(card.targetWindowId !== undefined ? { targetWindowId: card.targetWindowId } : {}),
          active: Boolean(card.active),
        },
      });
    });

    widgets.push({ id: `${key}_p_right`, type: 'GROUP_PANEL', label: input.panelTitles?.right ?? 'LIVE PRODUCTION COUNTERS', x: 746, y: 84, width: 266, height: panelH });
    takeWithWarning(input.heroKpis, 4, 'heroKpis', warnings).forEach((kpi, i) => {
      widgets.push({
        id: `${key}_kpi_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: kpi.label,
        tagName: kpi.tagName,
        unit: kpi.unit ?? 'pcs',
        precision: kpi.precision,
        visualRole: kpi.role ?? 'KPI_HERO',
        x: 760,
        y: (hasBottomNav ? 122 : 128) + i * (hasBottomNav ? 96 : 110),
        width: 238,
        height: hasBottomNav ? 82 : 94,
      });
    });
  } else if (input.template === 'STATION_ALARMS_SIMPLE') {
    const faults = takeWithWarning(input.inputs, 12, 'inputs', warnings);
    const twoCol = faults.length > 6;
    const leftW = twoCol ? 560 : 486;
    const rightX = 14 + leftW + 12;
    const rightW = 1010 - rightX;

    widgets.push({
      id: `${key}_p_faults`,
      type: 'GROUP_PANEL',
      label: input.panelTitles?.faults ?? input.panelTitles?.alarms ?? (twoCol ? 'SYSTEM & STATION ALARMS' : 'ACTIVE FAULTS'),
      x: 14,
      y: 62,
      width: leftW,
      height: 466,
    });
    faults.forEach((flt, i) => {
      const indProps = makeIndicatorProps(flt);
      if (twoCol) {
        const col = Math.floor(i / 6);
        const row = i % 6;
        widgets.push({
          id: `${key}_flt_${i}`,
          type: 'BIT_LAMP',
          label: flt.label,
          tagName: flt.tagName,
          visualRole: flt.role ?? 'DANGER_ACTION',
          x: 26 + col * 274,
          y: 108 + row * 66,
          width: 262,
          height: 44,
          ...(indProps ? { props: indProps } : {}),
        });
      } else {
        widgets.push({
          id: `${key}_flt_${i}`,
          type: 'BIT_LAMP',
          label: flt.label,
          tagName: flt.tagName,
          visualRole: flt.role ?? 'DANGER_ACTION',
          x: 30,
          y: 108 + i * 66,
          width: 454,
          height: 46,
          ...(indProps ? { props: indProps } : {}),
        });
      }
    });

    const readouts = takeWithWarning(input.leftReadouts, 4, 'leftReadouts', warnings);
    const compactMode = readouts.length <= 2;
    widgets.push({ id: `${key}_p_hist`, type: 'GROUP_PANEL', label: input.panelTitles?.right ?? 'ALARM CONTROL', x: rightX, y: 62, width: rightW, height: 466 });
    if (input.stationCounter) {
      widgets.push({
        id: `${key}_alm_total`,
        type: 'NUMERIC_DISPLAY',
        label: input.stationCounter.label,
        tagName: input.stationCounter.tagName,
        unit: input.stationCounter.unit ?? '',
        x: rightX + 18,
        y: compactMode ? 114 : 102,
        width: twoCol ? 210 : 226,
        height: compactMode ? 110 : 96,
      });
    }
    if (input.outputs?.[0]) {
      widgets.push({
        id: `${key}_ack_btn`,
        type: 'BIT_BUTTON',
        label: input.outputs[0].label,
        tagName: input.outputs[0].tagName,
        writeEnabled: true,
        visualRole: input.outputs[0].role ?? 'WARNING_ACTION',
        x: rightX + (twoCol ? 248 : 278),
        y: compactMode ? 114 : 102,
        width: twoCol ? 148 : 136,
        height: compactMode ? 110 : 96,
      });
    }
    if (compactMode) {
      readouts.forEach((rd, i) => {
        widgets.push({
          id: i === 0 ? `${key}_last_msg` : `${key}_hist_${i - 1}`,
          type: 'NUMERIC_DISPLAY',
          label: rd.label,
          tagName: rd.tagName,
          x: rightX + 18,
          y: 256 + i * 126,
          width: rightW - 36,
          height: 98,
        });
      });
    } else {
      if (readouts[0]) {
        widgets.push({
          id: `${key}_last_msg`,
          type: 'NUMERIC_DISPLAY',
          label: readouts[0].label,
          tagName: readouts[0].tagName,
          x: rightX + 16,
          y: 212,
          width: rightW - 32,
          height: 64,
        });
      }
      readouts.slice(1, 4).forEach((hr, i) => {
        widgets.push({
          id: `${key}_hist_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: hr.label,
          tagName: hr.tagName,
          x: rightX + 16,
          y: 288 + i * 76,
          width: rightW - 32,
          height: 64,
        });
      });
    }
  } else if (input.template === 'EDGE_LOGGER_CONSOLE') {
    const qKpis = takeWithWarning(input.heroKpis, 3, 'heroKpis', warnings);
    const lReads = takeWithWarning(input.leftReadouts, 2, 'leftReadouts', warnings);
    const simpleLeft = qKpis.length <= 2 && lReads.length <= 1;

    widgets.push({ id: `${key}_p_log`, type: 'GROUP_PANEL', label: input.panelTitles?.left ?? 'DATA LOGGER', x: 14, y: 62, width: 486, height: 466 });
    if (input.runIdTagName) {
      widgets.push({
        id: `${key}_run_id`,
        type: 'NUMERIC_INPUT',
        label: simpleLeft ? 'RUN ID' : 'ACTIVE RUN ID (EDITABLE)',
        tagName: input.runIdTagName,
        writeEnabled: true,
        x: 30,
        y: simpleLeft ? 112 : 102,
        width: 310,
        height: simpleLeft ? 80 : 68,
      });
    }
    if (input.outputs?.[0]) {
      widgets.push({
        id: `${key}_flush_btn`,
        type: 'BIT_BUTTON',
        label: input.outputs[0].label,
        tagName: input.outputs[0].tagName,
        writeEnabled: true,
        visualRole: input.outputs[0].role ?? 'PRIMARY_ACTION',
        x: 358,
        y: simpleLeft ? 108 : 100,
        width: 124,
        height: 92,
      });
    }
    if (input.commIndicators?.[0]) {
      const ci0 = input.commIndicators[0];
      const indProps = makeIndicatorProps(ci0);
      widgets.push({
        id: `${key}_cloud_lamp`,
        type: 'BIT_LAMP',
        label: ci0.label,
        tagName: ci0.tagName,
        visualRole: ci0.role ?? 'PRIMARY_ACTION',
        x: 30,
        y: simpleLeft ? 216 : 184,
        width: simpleLeft ? 452 : 310,
        height: 40,
        ...(indProps ? { props: indProps } : {}),
      });
    }
    if (simpleLeft) {
      const qW = qKpis.length === 2 ? 218 : 452;
      qKpis.forEach((q, i) => {
        widgets.push({
          id: `${key}_q_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: q.label,
          tagName: q.tagName,
          unit: q.unit ?? 'rows',
          visualRole: q.role ?? 'KPI_HERO',
          x: 30 + i * (qW + 16),
          y: 280,
          width: qW,
          height: 94,
        });
      });
      if (lReads[0]) {
        widgets.push({
          id: `${key}_log_msg_0`,
          type: 'NUMERIC_DISPLAY',
          label: lReads[0].label,
          tagName: lReads[0].tagName,
          x: 30,
          y: 400,
          width: 452,
          height: 96,
        });
      }
    } else {
      qKpis.forEach((q, i) => {
        widgets.push({
          id: `${key}_q_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: q.label,
          tagName: q.tagName,
          unit: q.unit ?? 'rows',
          visualRole: q.role ?? 'KPI_HERO',
          x: 30 + i * 154,
          y: 236,
          width: 146,
          height: 76,
        });
      });
      lReads.forEach((lr, i) => {
        widgets.push({
          id: `${key}_log_msg_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: lr.label,
          tagName: lr.tagName,
          x: 30,
          y: 326 + i * 86,
          width: 454,
          height: 72,
        });
      });
    }

    const seqs = takeWithWarning(input.sequenceCounters, 9, 'sequenceCounters', warnings);
    const simpleRight = seqs.length <= 4;
    widgets.push({ id: `${key}_p_tel`, type: 'GROUP_PANEL', label: input.panelTitles?.right ?? 'CYCLE TELEMETRY', x: 512, y: 62, width: 498, height: 466 });
    if (simpleRight) {
      seqs.forEach((sc, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        widgets.push({
          id: `${key}_tel_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: sc.label,
          tagName: sc.tagName,
          unit: sc.unit ?? '',
          precision: sc.precision,
          x: 530 + col * 240,
          y: 118 + row * 198,
          width: 222,
          height: 170,
        });
      });
    } else {
      seqs.forEach((sc, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        widgets.push({
          id: `${key}_tel_${i}`,
          type: 'NUMERIC_DISPLAY',
          label: sc.label,
          tagName: sc.tagName,
          unit: sc.unit ?? '',
          precision: sc.precision,
          x: 528 + col * 158,
          y: 108 + row * 136,
          width: 150,
          height: 110,
        });
      });
    }
  }

  widgets.push(...makeNavBar(key, input.navTabs, warnings));

  const baseScreen: HmiScreen = {
    id: input.screenId,
    name: input.name,
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    ...(input.themeId ? { themeId: input.themeId } : {}),
    backgroundColor: theme.canvasBg,
    autoScaleMobile: true,
    autoScaleWeb: true,
    widgets,
    ...(pipes.length > 0 ? { pipes } : {}),
    createdAt: now,
  };

  return {
    screen: scaleScreen(baseScreen, targetW, targetH),
    warnings,
  };
}

/**
 * Instantiates a pixel-aligned HMI screen template using only semantic bindings.
 */
export function instantiateHmiTemplate(input: InstantiateTemplateInput): HmiScreen {
  return instantiateHmiTemplateDetailed(input).screen;
}
