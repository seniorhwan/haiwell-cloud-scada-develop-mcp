import type { HmiPipeRoute, HmiScreen, HmiVisualRole, HmiWidget } from './types';

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

export interface InstantiateTemplateInput {
  template: HmiTemplateKind;
  screenId: string;
  name: string;
  title: string;
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

function makeNavBar(key: string, tabs: TemplateNavTab[] = []): HmiWidget[] {
  const list = tabs.slice(0, 6);
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

function scaleScreen(screen: HmiScreen, targetW: number, targetH: number): HmiScreen {
  if (targetW === 1024 && targetH === 600) return screen;
  const sx = targetW / 1024;
  const sy = targetH / 600;
  return {
    ...screen,
    width: targetW,
    height: targetH,
    widgets: screen.widgets.map((w) => ({
      ...w,
      x: Math.round(w.x * sx),
      y: Math.round(w.y * sy),
      width: Math.max(24, Math.round(w.width * sx)),
      height: Math.max(20, Math.round(w.height * sy)),
    })),
    pipes: screen.pipes?.map((p) => ({
      ...p,
      waypoints: p.waypoints.map((pt) => ({
        x: Math.round(pt.x * sx),
        y: Math.round(pt.y * sy),
      })),
    })),
  };
}

/**
 * Instantiates a hard-coded, zero-overlap ISA-101 HMI screen template.
 * AI agents supply only semantic bindings (titles, tags, stations, nav tabs);
 * all coordinates, margins, and card paddings are guaranteed pixel-aligned.
 */
export function instantiateHmiTemplate(input: InstantiateTemplateInput): HmiScreen {
  const targetW = input.width ?? 1024;
  const targetH = input.height ?? 600;
  const key = input.screenId.replace(/[^a-zA-Z0-9_]/g, '_');
  const now = new Date().toISOString();
  const headerTag = input.eStopTag ?? input.commTagName;
  const headerLabel = input.eStopTag ? 'E-STOP OK' : (input.commLabel ?? 'PLC ONLINE');
  const headerRole = input.eStopTag ? 'DANGER_ACTION' : 'STATUS_READONLY';
  const widgets: HmiWidget[] =
    input.template === 'MAIN_NAVIGATION_HUB'
      ? []
      : [...makeHeader(key, input.title, headerTag, headerLabel, headerRole)];
  const pipes: HmiPipeRoute[] = [];

  if (input.template === 'INDUSTRIAL_LINE_OVERVIEW') {
    // 3 equal-height cards: Left (x=14..324), Center (x=338..682), Right (x=696..1010)
    widgets.push({ id: `${key}_p_left`, type: 'GROUP_PANEL', label: 'LINE COMMANDS & PLC COMM', x: 14, y: 62, width: 310, height: 466 });
    const cmds = (input.commands ?? []).slice(0, 3);
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

    const comms = (input.commIndicators ?? []).slice(0, 4);
    comms.forEach((cm, i) => {
      widgets.push({
        id: `${key}_comm_${i}`,
        type: 'BIT_LAMP',
        label: cm.label,
        tagName: cm.tagName,
        x: 28,
        y: 204 + i * 40,
        width: 282,
        height: 34,
      });
    });

    const leftReads = (input.leftReadouts ?? []).slice(0, 2);
    leftReads.forEach((lr, i) => {
      widgets.push({
        id: `${key}_lr_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: lr.label,
        tagName: lr.tagName,
        unit: lr.unit,
        precision: lr.precision,
        x: 28,
        y: 374 + i * 72,
        width: 282,
        height: 62,
      });
    });

    widgets.push({ id: `${key}_p_mid`, type: 'GROUP_PANEL', label: 'PRODUCTION KPIS & YIELD', x: 338, y: 62, width: 344, height: 466 });
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

    const heros = (input.heroKpis ?? []).slice(0, 2);
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

    const cycs = (input.stationCycles ?? []).slice(0, 3);
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

    widgets.push({ id: `${key}_p_right`, type: 'GROUP_PANEL', label: 'ACTIVE ALARMS & STATION I/O', x: 696, y: 62, width: 314, height: 466 });
    const ios = (input.ioIndicators ?? []).slice(0, 3);
    ios.forEach((io, i) => {
      widgets.push({
        id: `${key}_io_${i}`,
        type: 'BIT_LAMP',
        label: io.label,
        tagName: io.tagName,
        x: 710,
        y: 100 + i * 40,
        width: 286,
        height: 34,
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
    const stations = (input.stations ?? []).slice(0, 4);
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
      const stIos = (st.ioIndicators ?? []).slice(0, 2);
      stIos.forEach((io, j) => {
        const halfW = st.kpi ? Math.floor((stW - 28) / 2) : Math.floor((stW - 28) / Math.max(1, stIos.length));
        widgets.push({
          id: `${key}_st_${idx}_io_${j}`,
          type: 'BIT_LAMP',
          label: io.label,
          tagName: io.tagName,
          x: sx + 10 + j * (halfW + 8),
          y: 306,
          width: halfW,
          height: 58,
        });
      });
      if (st.kpi) {
        const halfW = Math.floor((stW - 28) / 2);
        widgets.push({
          id: `${key}_st_${idx}_kpi`,
          type: 'NUMERIC_DISPLAY',
          label: st.kpi.label,
          tagName: st.kpi.tagName,
          unit: st.kpi.unit,
          precision: st.kpi.precision,
          x: sx + 10 + halfW + 8,
          y: 304,
          width: halfW,
          height: 60,
        });
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

    // Bottom Interlock & Cycle Bar
    widgets.push({ id: `${key}_bot_panel`, type: 'GROUP_PANEL', label: 'LINE INTERLOCK & QUICK CONTROL', x: 16, y: 390, width: 992, height: 138 });
    (input.quickCommands ?? []).slice(0, 3).forEach((qc, i) => {
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
    const reads = (input.bottomReadouts ?? []).slice(0, 4);
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
    widgets.push({ id: `${key}_p_alm`, type: 'GROUP_PANEL', label: 'PROCESS & SAFETY ALARMS', x: 14, y: 62, width: 490, height: 256 });
    widgets.push({ id: `${key}_alm`, type: 'ALARM_BANNER', label: 'Alarm Table', x: 24, y: 98, width: 470, height: 208 });

    widgets.push({ id: `${key}_p_trd`, type: 'GROUP_PANEL', label: 'REAL-TIME CYCLE TIME TREND', x: 518, y: 62, width: 492, height: 256 });
    widgets.push({ id: `${key}_trd`, type: 'TREND_CHART', label: 'Cycle Time Trend', tagName: input.trendTagName, x: 528, y: 98, width: 472, height: 208 });

    widgets.push({ id: `${key}_p_hist`, type: 'GROUP_PANEL', label: 'HISTORICAL DATA & BATCH LOG', x: 14, y: 328, width: 644, height: 200 });
    widgets.push({ id: `${key}_hist`, type: 'DATA_TABLE', label: 'History Table', x: 24, y: 364, width: 624, height: 152 });

    widgets.push({ id: `${key}_p_seq`, type: 'GROUP_PANEL', label: 'CLOUD LOGGER COUNTERS', x: 672, y: 328, width: 338, height: 200 });
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
    const seqs = (input.sequenceCounters ?? []).slice(0, 3);
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
    widgets.push({ id: `${key}_p_in`, type: 'GROUP_PANEL', label: 'FIELD SENSOR INPUTS (READ ONLY)', x: 14, y: 62, width: 490, height: 466 });
    (input.inputs ?? []).slice(0, 8).forEach((inp, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      widgets.push({
        id: `${key}_in_${i}`,
        type: 'BIT_LAMP',
        label: inp.label,
        tagName: inp.tagName,
        x: 28 + col * 236,
        y: 108 + row * 102,
        width: 224,
        height: 44,
      });
    });

    widgets.push({ id: `${key}_p_out`, type: 'GROUP_PANEL', label: 'ACTUATOR OUTPUTS / MANUAL TEST', x: 518, y: 62, width: 492, height: 466 });
    (input.outputs ?? []).slice(0, 8).forEach((outp, i) => {
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
    widgets.push({ id: `${key}_p_ctrl`, type: 'GROUP_PANEL', label: 'STATION CONTROL', x: 14, y: 62, width: 176, height: 466 });
    (input.outputs ?? []).slice(0, 3).forEach((cmd, i) => {
      widgets.push({
        id: `${key}_cmd_${i}`,
        type: 'BIT_BUTTON',
        label: cmd.label,
        tagName: cmd.tagName,
        writeEnabled: true,
        visualRole: cmd.role ?? 'DEFAULT',
        x: 50,
        y: 102 + i * 106,
        width: 104,
        height: 96,
      });
    });
    if (input.stationCounter) {
      widgets.push({
        id: `${key}_cnt`,
        type: 'NUMERIC_DISPLAY',
        label: input.stationCounter.label,
        tagName: input.stationCounter.tagName,
        unit: input.stationCounter.unit ?? 'pcs',
        x: 26,
        y: 428,
        width: 152,
        height: 82,
      });
    }

    widgets.push({ id: `${key}_p_in`, type: 'GROUP_PANEL', label: 'DIGITAL INPUTS (SENSORS X0-X7)', x: 202, y: 62, width: 398, height: 466 });
    (input.inputs ?? []).slice(0, 8).forEach((inp, i) => {
      widgets.push({
        id: `${key}_in_${i}`,
        type: 'BIT_LAMP',
        label: inp.label,
        tagName: inp.tagName,
        visualRole: inp.role ?? 'STATUS_READONLY',
        x: 216,
        y: 102 + i * 51,
        width: 370,
        height: 40,
      });
    });

    widgets.push({ id: `${key}_p_out`, type: 'GROUP_PANEL', label: 'DIGITAL OUTPUTS (COILS Y0-Y7)', x: 612, y: 62, width: 398, height: 466 });
    (input.outputIndicators ?? []).slice(0, 8).forEach((outp, i) => {
      widgets.push({
        id: `${key}_out_ind_${i}`,
        type: 'BIT_LAMP',
        label: outp.label,
        tagName: outp.tagName,
        visualRole: outp.role ?? 'STATUS_READONLY',
        x: 626,
        y: 102 + i * 51,
        width: 370,
        height: 40,
      });
    });
  } else if (input.template === 'MAIN_NAVIGATION_HUB') {
    // White branding header with university logos + alarm pill + dark clock pill
    widgets.push({
      id: `${key}_brand_bg`,
      type: 'GROUP_PANEL',
      label: '',
      x: 10,
      y: 8,
      width: 854,
      height: 68,
      props: { theme: 'light_banner' },
    });
    (input.brandingLogos ?? []).slice(0, 3).forEach((logo, idx) => {
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
    widgets.push({
      id: `${key}_hub_title`,
      type: 'LABEL',
      label: input.title,
      x: 442,
      y: 17,
      width: 292,
      height: 24,
      props: { color: '#0F172A', fontSize: 13, bold: true, align: 'left' },
    });
    widgets.push({
      id: `${key}_hub_sub`,
      type: 'LABEL',
      label: input.subtitle ?? 'PETRA CHRISTIAN UNIVERSITY • FESTO MPS LAB',
      x: 442,
      y: 43,
      width: 292,
      height: 18,
      props: { color: '#475569', fontSize: 10, bold: false, align: 'left' },
    });
    if (input.commTagName) {
      widgets.push({
        id: `${key}_hub_alm`,
        type: 'BIT_LAMP',
        label: input.commLabel ?? 'ALARM',
        tagName: input.commTagName,
        visualRole: 'DANGER_ACTION',
        x: 742,
        y: 25,
        width: 116,
        height: 34,
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

    // Left Card: Line Control & PLC Status
    widgets.push({ id: `${key}_p_left`, type: 'GROUP_PANEL', label: 'LINE CONTROL & PLC STATUS', x: 14, y: 84, width: 264, height: panelH });
    (input.commands ?? []).slice(0, 3).forEach((cmd, i) => {
      widgets.push({
        id: `${key}_cmd_${i}`,
        type: 'BIT_BUTTON',
        label: cmd.label,
        tagName: cmd.tagName,
        writeEnabled: true,
        visualRole: cmd.role ?? 'DEFAULT',
        x: 24 + i * 84,
        y: hasBottomNav ? 122 : 128,
        width: 78,
        height: 86,
      });
    });
    (input.commIndicators ?? []).slice(0, 3).forEach((ci, i) => {
      widgets.push({
        id: `${key}_comm_${i}`,
        type: 'BIT_LAMP',
        label: ci.label,
        tagName: ci.tagName,
        visualRole: ci.role ?? 'PRIMARY_ACTION',
        x: 26,
        y: (hasBottomNav ? 228 : 242) + i * (hasBottomNav ? 50 : 56),
        width: 240,
        height: 38,
      });
    });
    if (input.ioIndicators?.[0]) {
      widgets.push({
        id: `${key}_cloud_ok`,
        type: 'BIT_LAMP',
        label: input.ioIndicators[0].label,
        tagName: input.ioIndicators[0].tagName,
        visualRole: input.ioIndicators[0].role ?? 'PRIMARY_ACTION',
        x: 26,
        y: hasBottomNav ? 386 : 412,
        width: 240,
        height: 38,
      });
    }
    if (input.stationCounter) {
      widgets.push({
        id: `${key}_alm_cnt`,
        type: 'NUMERIC_DISPLAY',
        label: input.stationCounter.label,
        tagName: input.stationCounter.tagName,
        unit: input.stationCounter.unit ?? '',
        x: 26,
        y: hasBottomNav ? 436 : 470,
        width: 240,
        height: hasBottomNav ? 76 : 92,
      });
    }

    // Center Card: 5 Large Touch Navigation Cards
    widgets.push({ id: `${key}_p_center`, type: 'GROUP_PANEL', label: 'SYSTEM NAVIGATION', x: 290, y: 84, width: 444, height: panelH });
    (input.hubNavCards ?? []).slice(0, 5).forEach((card, i) => {
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
        x: isFifth ? 306 : 306 + col * 214,
        y: isFifth ? startY + 2 * rowStep : startY + row * rowStep,
        width: isFifth ? 412 : 198,
        height: cardH,
        props: {
          targetScreenName: card.targetScreenName,
          ...(card.targetWindowId !== undefined ? { targetWindowId: card.targetWindowId } : {}),
          active: Boolean(card.active),
        },
      });
    });

    // Right Card: Live Production Summary
    widgets.push({ id: `${key}_p_right`, type: 'GROUP_PANEL', label: 'LIVE PRODUCTION COUNTERS', x: 746, y: 84, width: 264, height: panelH });
    (input.heroKpis ?? []).slice(0, 4).forEach((kpi, i) => {
      widgets.push({
        id: `${key}_kpi_${i}`,
        type: 'NUMERIC_DISPLAY',
        label: kpi.label,
        tagName: kpi.tagName,
        unit: kpi.unit ?? 'pcs',
        precision: kpi.precision,
        visualRole: kpi.role ?? 'KPI_HERO',
        x: 762,
        y: (hasBottomNav ? 122 : 128) + i * (hasBottomNav ? 96 : 110),
        width: 232,
        height: hasBottomNav ? 82 : 94,
      });
    });
  } else if (input.template === 'STATION_ALARMS_SIMPLE') {
    const faults = (input.inputs ?? []).slice(0, 12);
    const twoCol = faults.length > 6;
    const leftW = twoCol ? 560 : 486;
    const rightX = 14 + leftW + 12;
    const rightW = 1010 - rightX;

    widgets.push({
      id: `${key}_p_faults`,
      type: 'GROUP_PANEL',
      label: twoCol ? 'SYSTEM & STATION ALARMS (ST1 / ST2 / ST3)' : 'ACTIVE FAULTS',
      x: 14,
      y: 62,
      width: leftW,
      height: 466,
    });
    faults.forEach((flt, i) => {
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
        });
      }
    });

    const readouts = (input.leftReadouts ?? []).slice(0, 4);
    const compactMode = readouts.length <= 2;
    widgets.push({ id: `${key}_p_hist`, type: 'GROUP_PANEL', label: 'ALARM CONTROL', x: rightX, y: 62, width: rightW, height: 466 });
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
    const qKpis = (input.heroKpis ?? []).slice(0, 3);
    const lReads = (input.leftReadouts ?? []).slice(0, 2);
    const simpleLeft = qKpis.length <= 2 && lReads.length <= 1;

    widgets.push({ id: `${key}_p_log`, type: 'GROUP_PANEL', label: 'CLOUD LOGGER', x: 14, y: 62, width: 486, height: 466 });
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
      widgets.push({
        id: `${key}_cloud_lamp`,
        type: 'BIT_LAMP',
        label: input.commIndicators[0].label,
        tagName: input.commIndicators[0].tagName,
        visualRole: input.commIndicators[0].role ?? 'PRIMARY_ACTION',
        x: 30,
        y: simpleLeft ? 216 : 184,
        width: simpleLeft ? 452 : 310,
        height: 40,
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

    const seqs = (input.sequenceCounters ?? []).slice(0, 9);
    const simpleRight = seqs.length <= 4;
    widgets.push({ id: `${key}_p_tel`, type: 'GROUP_PANEL', label: simpleRight ? 'STATION CYCLE TELEMETRY' : 'LIVE STATION CYCLE TELEMETRY', x: 512, y: 62, width: 498, height: 466 });
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

  widgets.push(...makeNavBar(key, input.navTabs));

  const baseScreen: HmiScreen = {
    id: input.screenId,
    name: input.name,
    width: 1024,
    height: 600,
    layoutStandard: 'ISA_101_HIGH_PERFORMANCE',
    backgroundColor: '#F1F5F9',
    autoScaleMobile: true,
    autoScaleWeb: true,
    widgets,
    ...(pipes.length > 0 ? { pipes } : {}),
    createdAt: now,
  };

  return scaleScreen(baseScreen, targetW, targetH);
}
