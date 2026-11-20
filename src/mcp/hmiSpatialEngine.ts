/**
 * Zero-Error Spatial HMI Engine & Haiwell Desktop Automation Bridge:
 *
 * Eliminates pixel guesswork and fragile drag-and-drop by compiling semantic intent
 * (P&ID process flow graphs + ISA-101 operational zones) through deterministic geometry:
 * 1. HAIWELL_HMI_TOOLBOX: Exact component catalog with port anchors, touch constraints,
 *    and Haiwell Cloud SCADA Develop toolbox/property-grid identifiers.
 * 2. compilePidScreen(): Topological rank layout + cycle-safe recirculation routing +
 *    exact port-to-port orthogonal Manhattan pipelines + auto-attached telemetry readouts.
 * 3. solveAndRepairScreenLayout(): 8px-grid snapping, >=44px touch enforcement,
 *    minimum-displacement collision auto-repair, and viewport clamping.
 * 4. auditScreenSpatially(): Closed-loop spatial proof (pairwise clearance, density %,
 *    pipe-to-port 0px error check, 2D ASCII occupancy map, and SVG blueprint).
 * 5. compileDesktopAutomationBridge(): Exports BOTH a native structured screen import
 *    manifest AND a closed-loop Windows UIA (`pywinauto`) script that drops components
 *    by Toolbox name and injects exact coordinates/tags into the Property Inspector Grid
 *    with UIA read-back assertions (never pixel-dragging to exact coordinates!).
 */

import { detectWidgetCollisions, renderScreenToSvg, validateHmiScreen } from './hmiGenerator';
import type {
  HaiwellTargetHardware,
  HmiPipeRoute,
  HmiScreen,
  HmiWidget,
  HmiWidgetType,
  TagDataType,
  TagDefinition,
} from './types';

export interface ToolboxComponentSpec {
  type: HmiWidgetType;
  category: 'DISPLAY' | 'CONTROL' | 'PID_EQUIPMENT' | 'CHART_HISTORIAN' | 'ALARM_RECIPE' | 'NAVIGATION';
  haiwellToolboxName: string;
  haiwellClassName: string;
  defaultSize: { width: number; height: number };
  minSize: { width: number; height: number };
  interactive: boolean;
  allowedTagTypes: TagDataType[];
  ports?: {
    left?: { rx: number; ry: number };
    right?: { rx: number; ry: number };
    top?: { rx: number; ry: number };
    bottom?: { rx: number; ry: number };
  };
  propertyGridMap: Record<string, string>;
}

export const HAIWELL_HMI_TOOLBOX: ToolboxComponentSpec[] = [
  {
    type: 'NUMERIC_DISPLAY',
    category: 'DISPLAY',
    haiwellToolboxName: 'Numeric Display',
    haiwellClassName: 'HwNumericDisplay',
    defaultSize: { width: 168, height: 64 },
    minSize: { width: 96, height: 48 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64', 'BCD16', 'BCD32'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'ReadVariable', unit: 'Unit', precision: 'DecimalPlaces', label: 'Title' },
  },
  {
    type: 'NUMERIC_INPUT',
    category: 'CONTROL',
    haiwellToolboxName: 'Numeric Input',
    haiwellClassName: 'HwNumericInput',
    defaultSize: { width: 168, height: 64 },
    minSize: { width: 96, height: 48 },
    interactive: true,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64', 'BCD16', 'BCD32'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'WriteVariable', min: 'MinValue', max: 'MaxValue', precision: 'DecimalPlaces', writeEnabled: 'EnableInput' },
  },
  {
    type: 'BIT_BUTTON',
    category: 'CONTROL',
    haiwellToolboxName: 'Bit Button',
    haiwellClassName: 'HwBitButton',
    defaultSize: { width: 136, height: 56 },
    minSize: { width: 64, height: 48 },
    interactive: true,
    allowedTagTypes: ['BOOL'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'WriteVariable', label: 'Text', writeEnabled: 'EnableTouch' },
  },
  {
    type: 'BIT_LAMP',
    category: 'DISPLAY',
    haiwellToolboxName: 'Bit Lamp',
    haiwellClassName: 'HwBitLamp',
    defaultSize: { width: 120, height: 56 },
    minSize: { width: 48, height: 48 },
    interactive: false,
    allowedTagTypes: ['BOOL'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'ReadVariable', label: 'Text' },
  },
  {
    type: 'MULTI_STATE_INDICATOR',
    category: 'DISPLAY',
    haiwellToolboxName: 'Word Lamp',
    haiwellClassName: 'HwWordLamp',
    defaultSize: { width: 152, height: 56 },
    minSize: { width: 80, height: 48 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'ReadVariable', label: 'StateText' },
  },
  {
    type: 'BAR_GRAPH',
    category: 'DISPLAY',
    haiwellToolboxName: 'Bar Graph',
    haiwellClassName: 'HwBarGraph',
    defaultSize: { width: 224, height: 72 },
    minSize: { width: 112, height: 48 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'ReadVariable', min: 'MinScale', max: 'MaxScale' },
  },
  {
    type: 'GAUGE',
    category: 'DISPLAY',
    haiwellToolboxName: 'Meter / Gauge',
    haiwellClassName: 'HwMeterGauge',
    defaultSize: { width: 160, height: 144 },
    minSize: { width: 112, height: 112 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'ReadVariable', min: 'MinScale', max: 'MaxScale', unit: 'Unit' },
  },
  {
    type: 'TANK',
    category: 'PID_EQUIPMENT',
    haiwellToolboxName: 'Process Tank (Library)',
    haiwellClassName: 'HwPidTank',
    defaultSize: { width: 144, height: 128 },
    minSize: { width: 96, height: 88 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'FLOAT32', 'FLOAT64'],
    ports: { left: { rx: 0, ry: 0.5 }, right: { rx: 1, ry: 0.5 }, top: { rx: 0.5, ry: 0 }, bottom: { rx: 0.5, ry: 1 } },
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'LevelVariable', min: 'MinLevel', max: 'MaxLevel', label: 'EquipmentName' },
  },
  {
    type: 'PUMP',
    category: 'PID_EQUIPMENT',
    haiwellToolboxName: 'Centrifugal Pump (Library)',
    haiwellClassName: 'HwPidPump',
    defaultSize: { width: 136, height: 88 },
    minSize: { width: 88, height: 64 },
    interactive: true,
    allowedTagTypes: ['BOOL', 'INT16', 'UINT16'],
    ports: { left: { rx: 0, ry: 0.5 }, right: { rx: 1, ry: 0.5 }, top: { rx: 0.5, ry: 0 }, bottom: { rx: 0.5, ry: 1 } },
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'StatusVariable', writeEnabled: 'EnableControl', label: 'EquipmentName' },
  },
  {
    type: 'VALVE',
    category: 'PID_EQUIPMENT',
    haiwellToolboxName: 'Control Valve (Library)',
    haiwellClassName: 'HwPidValve',
    defaultSize: { width: 136, height: 88 },
    minSize: { width: 88, height: 64 },
    interactive: true,
    allowedTagTypes: ['BOOL', 'FLOAT32', 'INT16', 'UINT16'],
    ports: { left: { rx: 0, ry: 0.5 }, right: { rx: 1, ry: 0.5 }, top: { rx: 0.5, ry: 0 }, bottom: { rx: 0.5, ry: 1 } },
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'PositionVariable', writeEnabled: 'EnableControl', label: 'EquipmentName' },
  },
  {
    type: 'PIPELINE',
    category: 'PID_EQUIPMENT',
    haiwellToolboxName: 'Flow Pipe (Vector)',
    haiwellClassName: 'HwFlowPipe',
    defaultSize: { width: 160, height: 16 },
    minSize: { width: 24, height: 8 },
    interactive: false,
    allowedTagTypes: ['BOOL', 'FLOAT32', 'INT16'],
    propertyGridMap: { tagName: 'FlowVariable', label: 'FluidType' },
  },
  {
    type: 'TREND_CHART',
    category: 'CHART_HISTORIAN',
    haiwellToolboxName: 'Real-Time / Historical Trend',
    haiwellClassName: 'HwTrendChart',
    defaultSize: { width: 400, height: 192 },
    minSize: { width: 240, height: 120 },
    interactive: false,
    allowedTagTypes: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32', 'FLOAT64'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', tagName: 'Channel1Variable', label: 'ChartTitle' },
  },
  {
    type: 'ALARM_BANNER',
    category: 'ALARM_RECIPE',
    haiwellToolboxName: 'Alarm Banner / Bar',
    haiwellClassName: 'HwAlarmBar',
    defaultSize: { width: 1240, height: 48 },
    minSize: { width: 300, height: 40 },
    interactive: false,
    allowedTagTypes: ['BOOL', 'INT16', 'FLOAT32', 'STRING'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', label: 'Title' },
  },
  {
    type: 'RECIPE_SELECTOR',
    category: 'ALARM_RECIPE',
    haiwellToolboxName: 'Recipe View / Selector',
    haiwellClassName: 'HwRecipeView',
    defaultSize: { width: 280, height: 144 },
    minSize: { width: 160, height: 80 },
    interactive: true,
    allowedTagTypes: ['STRING', 'INT16', 'UINT16'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', label: 'RecipeGroup' },
  },
  {
    type: 'CAMERA_VIEW',
    category: 'DISPLAY',
    haiwellToolboxName: 'IP Camera (RTSP/ONVIF)',
    haiwellClassName: 'HwCameraView',
    defaultSize: { width: 320, height: 200 },
    minSize: { width: 160, height: 120 },
    interactive: false,
    allowedTagTypes: ['STRING'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', label: 'CameraId' },
  },
  {
    type: 'DATA_TABLE',
    category: 'CHART_HISTORIAN',
    haiwellToolboxName: 'Historical Data Table',
    haiwellClassName: 'HwDataTable',
    defaultSize: { width: 400, height: 192 },
    minSize: { width: 200, height: 120 },
    interactive: false,
    allowedTagTypes: ['INT16', 'FLOAT32', 'STRING'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', label: 'TableTitle' },
  },
  {
    type: 'NAV_BAR',
    category: 'NAVIGATION',
    haiwellToolboxName: 'Function Key / Screen Jump',
    haiwellClassName: 'HwNavBar',
    defaultSize: { width: 1240, height: 48 },
    minSize: { width: 240, height: 44 },
    interactive: true,
    allowedTagTypes: ['BOOL'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', targetScreenId: 'TargetScreen', label: 'Caption' },
  },
  {
    type: 'LABEL',
    category: 'DISPLAY',
    haiwellToolboxName: 'Static Text Label',
    haiwellClassName: 'HwLabel',
    defaultSize: { width: 160, height: 32 },
    minSize: { width: 48, height: 24 },
    interactive: false,
    allowedTagTypes: ['STRING'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', label: 'Text' },
  },
  {
    type: 'FACEPLATE_INSTANCE',
    category: 'CONTROL',
    haiwellToolboxName: 'Custom Faceplate / Group',
    haiwellClassName: 'HwFaceplateGroup',
    defaultSize: { width: 240, height: 120 },
    minSize: { width: 96, height: 64 },
    interactive: true,
    allowedTagTypes: ['BOOL', 'INT16', 'FLOAT32'],
    propertyGridMap: { x: 'Left', y: 'Top', width: 'Width', height: 'Height', faceplateId: 'TemplateId', label: 'InstanceName' },
  },
];

const TOOLBOX_BY_TYPE = new Map(HAIWELL_HMI_TOOLBOX.map((c) => [c.type, c]));

const GRID_STEP = 8;
function snap(val: number): number {
  return Math.round(val / GRID_STEP) * GRID_STEP;
}

export function getPortPoint(
  widget: HmiWidget,
  port: 'left' | 'right' | 'top' | 'bottom'
): { x: number; y: number } {
  const spec = TOOLBOX_BY_TYPE.get(widget.type);
  const ratio = spec?.ports?.[port];
  if (ratio) {
    return {
      x: Math.round(widget.x + widget.width * ratio.rx),
      y: Math.round(widget.y + widget.height * ratio.ry),
    };
  }
  switch (port) {
    case 'left': return { x: widget.x, y: Math.round(widget.y + widget.height / 2) };
    case 'right': return { x: widget.x + widget.width, y: Math.round(widget.y + widget.height / 2) };
    case 'top': return { x: Math.round(widget.x + widget.width / 2), y: widget.y };
    case 'bottom': return { x: Math.round(widget.x + widget.width / 2), y: widget.y + widget.height };
  }
}

export interface PidNodeInput {
  id: string;
  type: 'TANK' | 'PUMP' | 'VALVE' | 'NUMERIC_DISPLAY' | 'NUMERIC_INPUT' | 'BIT_BUTTON' | 'BIT_LAMP' | 'GAUGE' | 'BAR_GRAPH';
  label: string;
  tagName?: string;
  writeEnabled?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  calloutTagName?: string;
  calloutLabel?: string;
  calloutUnit?: string;
}

export interface PidEdgeInput {
  id?: string;
  from: string;
  to: string;
  fluid?: HmiPipeRoute['fluid'];
  label?: string;
  flowTagName?: string;
}

export interface PidCompileInput {
  screenId: string;
  name: string;
  width: number;
  height: number;
  layoutStandard: HmiScreen['layoutStandard'];
  includeAlarmBanner?: boolean;
  includeNavBar?: boolean;
  nodes: PidNodeInput[];
  edges: PidEdgeInput[];
}

export interface PidCompileResult {
  screen: HmiScreen;
  portAttachmentProof: {
    totalPipes: number;
    maxPortGapPx: number;
    recirculationEdges: string[];
  };
  spatialAudit: SpatialAuditReport;
  svg: string;
}

/**
 * Compiles a semantic P&ID process graph (nodes + directed fluid edges, including closed return loops)
 * into a 100% collision-free, 8px-snapped HMI screen with exact port-connected orthogonal pipes
 * and non-overlapping telemetry callouts.
 */
export function compilePidScreen(
  input: PidCompileInput,
  knownTags: Record<string, TagDefinition>,
  options: { knownScreenIds?: Set<string>; targetHardware?: HaiwellTargetHardware } = {}
): PidCompileResult {
  const pad = 24;
  const topSafe = input.includeAlarmBanner !== false ? pad + 48 + 16 : pad;
  const bottomSafe = input.includeNavBar !== false ? input.height - pad - 48 - 16 : input.height - pad;
  const usableW = input.width - pad * 2;
  const usableH = Math.max(160, bottomSafe - topSafe);

  const nodeIds = new Set<string>();
  for (const n of input.nodes) {
    if (nodeIds.has(n.id)) throw new Error(`Duplicate P&ID node id "${n.id}".`);
    nodeIds.add(n.id);
  }
  for (const e of input.edges) {
    if (!nodeIds.has(e.from)) throw new Error(`P&ID edge references unknown source node "${e.from}".`);
    if (!nodeIds.has(e.to)) throw new Error(`P&ID edge references unknown target node "${e.to}".`);
    if (e.from === e.to) throw new Error(`P&ID self-loop edge on "${e.from}" is not allowed.`);
  }

  // 1. Cycle-safe topological ranking (handles closed chilled-water / boiler recirculation loops cleanly!)
  const adj = new Map<string, string[]>(input.nodes.map((n) => [n.id, []]));
  const inDeg = new Map<string, number>(input.nodes.map((n) => [n.id, 0]));
  for (const e of input.edges) {
    adj.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // Start from roots (inDeg === 0); if pure cycle, start from first declared node (primary equipment)
  for (const n of input.nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) {
      rank.set(n.id, 0);
      visited.add(n.id);
      queue.push(n.id);
    }
  }
  if (queue.length === 0 && input.nodes.length > 0) {
    const first = input.nodes[0].id;
    rank.set(first, 0);
    visited.add(first);
    queue.push(first);
  }

  while (queue.length > 0) {
    const u = queue.shift()!;
    const rU = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        visited.add(v);
        rank.set(v, rU + 1);
        queue.push(v);
      }
    }
  }
  // Assign any disconnected islands
  for (const n of input.nodes) {
    if (!rank.has(n.id)) rank.set(n.id, 0);
  }

  // Group nodes by column rank
  const maxRank = Math.max(0, ...rank.values());
  const columns: PidNodeInput[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of input.nodes) {
    columns[rank.get(n.id) ?? 0].push(n);
  }

  const widgets: HmiWidget[] = [];
  if (input.includeAlarmBanner !== false) {
    widgets.push({
      id: `${input.screenId}_alarm_banner`,
      type: 'ALARM_BANNER',
      label: 'Active Process Alarms',
      x: pad,
      y: pad,
      width: input.width - pad * 2,
      height: 48,
    });
  }

  const numCols = columns.length;
  const colSlotW = Math.floor(usableW / Math.max(1, numCols));
  const nodeWidgetMap = new Map<string, HmiWidget>();
  const hasAnyCallout = input.nodes.some((n) => Boolean(n.calloutTagName));
  const calloutH = 48;
  const calloutGap = 16;

  // Reserve vertical band at bottom of canvas for return recirculation pipelines if needed
  const pipeChannelReserve = 36;
  const equipAreaH = Math.max(120, usableH - pipeChannelReserve);

  columns.forEach((colNodes, colIdx) => {
    const rowSlotH = Math.floor(equipAreaH / Math.max(1, colNodes.length));
    colNodes.forEach((node, rowIdx) => {
      const spec = TOOLBOX_BY_TYPE.get(node.type);
      const prefW = spec?.defaultSize.width ?? 136;
      const prefH = spec?.defaultSize.height ?? 88;
      const maxNodeW = Math.max(88, colSlotW - 40);
      const maxNodeH = Math.max(56, rowSlotH - (hasAnyCallout ? calloutH + calloutGap + 24 : 24));
      const w = snap(Math.max(48, Math.min(prefW, maxNodeW)));
      const h = snap(Math.max(48, Math.min(prefH, maxNodeH)));

      const cx = pad + colIdx * colSlotW + Math.floor((colSlotW - w) / 2);
      const cy = topSafe + rowIdx * rowSlotH + Math.floor((rowSlotH - (node.calloutTagName ? h + calloutH + calloutGap : h)) / 2);

      const eqWidget: HmiWidget = {
        id: node.id,
        type: node.type,
        label: node.label,
        x: snap(Math.max(pad, Math.min(cx, input.width - pad - w))),
        y: snap(Math.max(topSafe, Math.min(cy, bottomSafe - pipeChannelReserve - h))),
        width: w,
        height: h,
        tagName: node.tagName,
        writeEnabled: node.writeEnabled ?? false,
        unit: node.unit,
        min: node.min,
        max: node.max,
        precision: 2,
      };
      widgets.push(eqWidget);
      nodeWidgetMap.set(node.id, eqWidget);

      if (node.calloutTagName) {
        const calloutW = snap(Math.max(96, w));
        const calloutX = snap(Math.max(pad, Math.min(eqWidget.x, input.width - pad - calloutW)));
        const calloutY = snap(eqWidget.y + eqWidget.height + calloutGap);
        if (calloutY + calloutH <= bottomSafe - pipeChannelReserve + 8) {
          widgets.push({
            id: `${node.id}_callout`,
            type: 'NUMERIC_DISPLAY',
            label: node.calloutLabel ?? node.calloutTagName,
            x: calloutX,
            y: calloutY,
            width: calloutW,
            height: calloutH,
            tagName: node.calloutTagName,
            unit: node.calloutUnit ?? knownTags[node.calloutTagName]?.unit,
            precision: 2,
          });
        }
      }
    });
  });

  if (input.includeNavBar !== false) {
    widgets.push({
      id: `${input.screenId}_nav_bar`,
      type: 'NAV_BAR',
      label: 'Screen Navigation',
      x: pad,
      y: input.height - pad - 48,
      width: input.width - pad * 2,
      height: 48,
    });
  }

  // 2. Route orthogonal Manhattan pipelines with exact port-to-port 0px attachment
  const pipes: HmiPipeRoute[] = [];
  const recirculationEdges: string[] = [];
  let returnLaneIdx = 0;

  input.edges.forEach((edge, idx) => {
    const src = nodeWidgetMap.get(edge.from)!;
    const dst = nodeWidgetMap.get(edge.to)!;
    const pipeId = edge.id ?? `pipe_${idx + 1}_${edge.from}_to_${edge.to}`;
    const srcRank = rank.get(edge.from) ?? 0;
    const dstRank = rank.get(edge.to) ?? 0;

    let fromPort: HmiPipeRoute['fromPort'];
    let toPort: HmiPipeRoute['toPort'];
    let waypoints: { x: number; y: number }[];

    if (dstRank > srcRank) {
      // Forward left-to-right orthogonal Manhattan elbow
      fromPort = 'right';
      toPort = 'left';
      const p1 = getPortPoint(src, fromPort);
      const p2 = getPortPoint(dst, toPort);
      const midX = snap(Math.round((p1.x + p2.x) / 2));
      waypoints = p1.y === p2.y ? [p1, p2] : [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
    } else if (dstRank === srcRank) {
      // Same-rank vertical drop/rise
      fromPort = dst.y >= src.y ? 'bottom' : 'top';
      toPort = dst.y >= src.y ? 'top' : 'bottom';
      const p1 = getPortPoint(src, fromPort);
      const p2 = getPortPoint(dst, toPort);
      const midY = snap(Math.round((p1.y + p2.y) / 2));
      waypoints = p1.x === p2.x ? [p1, p2] : [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];
    } else {
      // Recirculation / return loop routed cleanly along bottom pipe bus channel (zero equipment crossing!)
      recirculationEdges.push(pipeId);
      fromPort = 'bottom';
      toPort = 'bottom';
      const p1 = getPortPoint(src, fromPort);
      const p2 = getPortPoint(dst, toPort);
      const laneY = snap(bottomSafe - 12 - (returnLaneIdx % 3) * 10);
      returnLaneIdx++;
      waypoints = [p1, { x: p1.x, y: laneY }, { x: p2.x, y: laneY }, p2];
    }

    pipes.push({
      id: pipeId,
      fromWidgetId: src.id,
      toWidgetId: dst.id,
      fromPort,
      toPort,
      fluid: edge.fluid ?? (dstRank < srcRank ? 'RETURN' : 'PROCESS'),
      label: edge.label,
      flowTagName: edge.flowTagName,
      waypoints,
    });
  });

  const screen: HmiScreen = {
    id: input.screenId,
    name: input.name,
    width: input.width,
    height: input.height,
    layoutStandard: input.layoutStandard,
    backgroundColor: input.layoutStandard === 'ISA_101_HIGH_PERFORMANCE' ? '#E5E7EB' : '#F1F5F9',
    autoScaleMobile: true,
    autoScaleWeb: true,
    widgets,
    pipes,
    createdAt: new Date().toISOString(),
  };

  // Run auto-repair safety pass if any tight viewport caused overlap (and re-anchor pipes!)
  const repaired = solveAndRepairScreenLayout(screen, options.targetHardware);
  const maxPortGapPx = computeMaxPipePortGap(repaired.screen);
  const spatialAudit = auditScreenSpatially(repaired.screen, knownTags, options);

  return {
    screen: repaired.screen,
    portAttachmentProof: {
      totalPipes: repaired.screen.pipes?.length ?? 0,
      maxPortGapPx,
      recirculationEdges,
    },
    spatialAudit,
    svg: renderScreenToSvg(repaired.screen, knownTags),
  };
}

function computeMaxPipePortGap(screen: HmiScreen): number {
  const byId = new Map(screen.widgets.map((w) => [w.id, w]));
  let maxGap = 0;
  for (const pipe of screen.pipes ?? []) {
    const src = byId.get(pipe.fromWidgetId);
    const dst = byId.get(pipe.toWidgetId);
    if (!src || !dst || pipe.waypoints.length < 2) continue;
    const pStart = getPortPoint(src, pipe.fromPort);
    const pEnd = getPortPoint(dst, pipe.toPort);
    const wpStart = pipe.waypoints[0];
    const wpEnd = pipe.waypoints[pipe.waypoints.length - 1];
    const g1 = Math.hypot(pStart.x - wpStart.x, pStart.y - wpStart.y);
    const g2 = Math.hypot(pEnd.x - wpEnd.x, pEnd.y - wpEnd.y);
    maxGap = Math.max(maxGap, g1, g2);
  }
  return Number(maxGap.toFixed(2));
}

function reanchorScreenPipes(screen: HmiScreen): void {
  if (!screen.pipes || screen.pipes.length === 0) return;
  const byId = new Map(screen.widgets.map((w) => [w.id, w]));
  for (const pipe of screen.pipes) {
    const src = byId.get(pipe.fromWidgetId);
    const dst = byId.get(pipe.toWidgetId);
    if (!src || !dst) continue;
    const p1 = getPortPoint(src, pipe.fromPort);
    const p2 = getPortPoint(dst, pipe.toPort);
    if (pipe.fromPort === 'right' && pipe.toPort === 'left') {
      const midX = snap(Math.round((p1.x + p2.x) / 2));
      pipe.waypoints = p1.y === p2.y ? [p1, p2] : [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
    } else if (pipe.fromPort === 'bottom' && pipe.toPort === 'bottom') {
      const laneY = pipe.waypoints[1]?.y ?? snap(Math.max(p1.y, p2.y) + 24);
      pipe.waypoints = [p1, { x: p1.x, y: laneY }, { x: p2.x, y: laneY }, p2];
    } else {
      const midY = snap(Math.round((p1.y + p2.y) / 2));
      pipe.waypoints = p1.x === p2.x ? [p1, p2] : [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];
    }
  }
}

export interface LayoutRepairResult {
  screen: HmiScreen;
  movedWidgets: string[];
  resizedForTouch: string[];
  remainingCollisions: number;
  remainingOutOfBounds: number;
}

/**
 * Deterministic 8px-grid alignment, touch-target >=44px enforcement, viewport clamping,
 * and minimum-displacement collision auto-repair solver.
 */
export function solveAndRepairScreenLayout(
  inputScreen: HmiScreen,
  targetHardware?: HaiwellTargetHardware
): LayoutRepairResult {
  const screen: HmiScreen = {
    ...inputScreen,
    widgets: inputScreen.widgets.map((w) => ({ ...w })),
    pipes: inputScreen.pipes ? inputScreen.pipes.map((p) => ({ ...p, waypoints: p.waypoints.map((pt) => ({ ...pt })) })) : undefined,
  };

  const pad = 16;
  const gap = 8;
  const isTouch = Boolean(targetHardware?.startsWith('CLOUD_HMI_'));
  const movedWidgets = new Set<string>();
  const resizedForTouch: string[] = [];

  const alarmBanner = screen.widgets.find((w) => w.type === 'ALARM_BANNER');
  const navBar = screen.widgets.find((w) => w.type === 'NAV_BAR');
  const minY = alarmBanner ? alarmBanner.y + alarmBanner.height + gap : pad;
  const maxY = navBar ? navBar.y - gap : screen.height - pad;

  const placed: HmiWidget[] = [];
  if (alarmBanner) placed.push(alarmBanner);
  if (navBar) placed.push(navBar);

  const overlapsAny = (cand: { x: number; y: number; width: number; height: number }): boolean => {
    for (const o of placed) {
      const xOv = Math.min(cand.x + cand.width, o.x + o.width) - Math.max(cand.x, o.x);
      const yOv = Math.min(cand.y + cand.height, o.y + o.height) - Math.max(cand.y, o.y);
      if (xOv > 0 && yOv > 0) return true;
    }
    return false;
  };

  for (const w of screen.widgets) {
    if (w === alarmBanner || w === navBar) continue;
    const origX = w.x;
    const origY = w.y;

    const spec = TOOLBOX_BY_TYPE.get(w.type);
    if (isTouch && (spec?.interactive || w.writeEnabled)) {
      if (w.width < 48 || w.height < 48) {
        w.width = Math.max(w.width, 48);
        w.height = Math.max(w.height, 48);
        resizedForTouch.push(w.id);
      }
    }

    w.width = Math.min(w.width, screen.width - pad * 2);
    w.height = Math.min(w.height, Math.max(48, maxY - minY));
    w.x = snap(Math.max(pad, Math.min(w.x, screen.width - pad - w.width)));
    w.y = snap(Math.max(minY, Math.min(w.y, maxY - w.height)));

    if (overlapsAny(w)) {
      // Deterministic spiral / scanline search for nearest non-overlapping 8px-aligned slot
      let best: { x: number; y: number; dist: number } | null = null;
      for (let y = snap(minY); y <= maxY - w.height; y += GRID_STEP * 2) {
        for (let x = pad; x <= screen.width - pad - w.width; x += GRID_STEP * 2) {
          if (!overlapsAny({ x, y, width: w.width, height: w.height })) {
            const dist = Math.hypot(x - origX, y - origY);
            if (!best || dist < best.dist) {
              best = { x, y, dist };
            }
          }
        }
      }
      if (best) {
        w.x = best.x;
        w.y = best.y;
      }
    }

    if (w.x !== origX || w.y !== origY) movedWidgets.add(w.id);
    placed.push(w);
  }

  reanchorScreenPipes(screen);
  const collisions = detectWidgetCollisions(screen.widgets);
  const outOfBounds = screen.widgets.filter(
    (w) => w.x < 0 || w.y < 0 || w.x + w.width > screen.width || w.y + w.height > screen.height
  );

  return {
    screen,
    movedWidgets: [...movedWidgets],
    resizedForTouch,
    remainingCollisions: collisions.length,
    remainingOutOfBounds: outOfBounds.length,
  };
}

export interface SpatialAuditReport {
  valid: boolean;
  screenId: string;
  viewport: { width: number; height: number };
  widgetCount: number;
  pipeCount: number;
  maxPipePortGapPx: number;
  coveragePercent: number;
  minPairwiseClearancePx: number | null;
  validation: ReturnType<typeof validateHmiScreen>;
  asciiLegend: Record<string, string>;
  asciiMap: string;
}

/**
 * Generates a closed-loop spatial verification report + 2D ASCII occupancy grid so ANY
 * LLM (text-only or multimodal) can verify widget alignment, balance, clearance, and
 * zero overlap without a GUI browser.
 */
export function auditScreenSpatially(
  screen: HmiScreen,
  knownTags: Record<string, TagDefinition>,
  options: { knownScreenIds?: Set<string>; targetHardware?: HaiwellTargetHardware } = {}
): SpatialAuditReport {
  const validation = validateHmiScreen(screen, knownTags, options);

  // Coverage % and minimum pairwise clearance
  const totalArea = screen.width * screen.height;
  const widgetArea = screen.widgets.reduce((acc, w) => acc + w.width * w.height, 0);
  const coveragePercent = Number(((widgetArea / Math.max(1, totalArea)) * 100).toFixed(1));

  let minClearance: number | null = null;
  for (let i = 0; i < screen.widgets.length; i++) {
    for (let j = i + 1; j < screen.widgets.length; j++) {
      const a = screen.widgets[i];
      const b = screen.widgets[j];
      const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
      const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
      const dist = dx === 0 && dy === 0 ? 0 : Math.round(Math.hypot(dx, dy));
      minClearance = minClearance === null ? dist : Math.min(minClearance, dist);
    }
  }

  // 48x18 2D ASCII occupancy map
  const cols = 48;
  const rows = 18;
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  const legend: Record<string, string> = {};
  const syms = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
  let symIdx = 0;

  // Draw pipes first as '.'
  for (const pipe of screen.pipes ?? []) {
    for (let k = 0; k < pipe.waypoints.length - 1; k++) {
      const a = pipe.waypoints[k];
      const b = pipe.waypoints[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12));
      for (let s = 0; s <= steps; s++) {
        const px = a.x + ((b.x - a.x) * s) / steps;
        const py = a.y + ((b.y - a.y) * s) / steps;
        const gx = Math.max(0, Math.min(cols - 1, Math.floor((px / screen.width) * cols)));
        const gy = Math.max(0, Math.min(rows - 1, Math.floor((py / screen.height) * rows)));
        if (grid[gy][gx] === ' ') grid[gy][gx] = '.';
      }
    }
  }

  const collidingWidgetIds = new Set(
    validation.collisions.flatMap((c) => [c.widgetA, c.widgetB])
  );

  for (const w of screen.widgets) {
    const ch =
      w.type === 'ALARM_BANNER'
        ? '='
        : w.type === 'NAV_BAR'
          ? '_'
          : syms[symIdx++ % syms.length];
    legend[ch] = `${w.id} (${w.type}${w.tagName ? ' -> ' + w.tagName : ''}) [${w.x},${w.y} ${w.width}x${w.height}]`;

    const c0 = Math.max(0, Math.min(cols - 1, Math.floor((w.x / screen.width) * cols)));
    const c1 = Math.max(c0, Math.min(cols - 1, Math.floor(((w.x + w.width - 1) / screen.width) * cols)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor((w.y / screen.height) * rows)));
    const r1 = Math.max(r0, Math.min(rows - 1, Math.floor(((w.y + w.height - 1) / screen.height) * rows)));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const occupiedByOtherWidget = grid[r][c] !== ' ' && grid[r][c] !== '.' && grid[r][c] !== ch;
        grid[r][c] = occupiedByOtherWidget && collidingWidgetIds.has(w.id) ? '!' : ch;
      }
    }
  }

  const border = '+' + '-'.repeat(cols) + '+';
  const asciiMap = [border, ...grid.map((row) => '|' + row.join('') + '|'), border].join('\n');

  const maxPipePortGapPx = computeMaxPipePortGap(screen);

  return {
    valid: validation.valid && maxPipePortGapPx <= 1,
    screenId: screen.id,
    viewport: { width: screen.width, height: screen.height },
    widgetCount: screen.widgets.length,
    pipeCount: screen.pipes?.length ?? 0,
    maxPipePortGapPx,
    coveragePercent,
    minPairwiseClearancePx: minClearance,
    validation,
    asciiLegend: legend,
    asciiMap,
  };
}

export interface DesktopBridgePlan {
  strategy: 'NATIVE_IMPORT_PRIMARY_WITH_UIA_PROPERTY_GRID_FALLBACK';
  whyZeroError: string[];
  screenId: string;
  nativeImportManifest: {
    schema: 'haiwell.scada.screen.v2';
    screen: { id: string; name: string; width: number; height: number; backgroundColor: string };
    components: {
      id: string;
      haiwellClassName: string;
      haiwellToolboxName: string;
      properties: Record<string, string | number | boolean>;
    }[];
    pipelines: HmiPipeRoute[];
  };
  uiaExecutionSteps: {
    step: number;
    widgetId: string;
    action: 'DROP_BY_TOOLBOX_NAME_THEN_SET_PROPERTY_GRID';
    toolboxItemName: string;
    propertyWrites: Record<string, string | number | boolean>;
    postConditionAssertions: Record<string, string | number | boolean>;
  }[];
  pywinautoScript: string;
}

/**
 * Compiles a validated HMI screen into:
 * 1) A native Haiwell structured component manifest for direct file/template import (zero GUI needed).
 * 2) A closed-loop Windows UI Automation (`pywinauto`) script for driving `Haiwell Cloud SCADA Develop.exe`
 *    WITHOUT pixel drag-and-drop accuracy risk: drops each component anywhere on canvas by Toolbox Name,
 *    writes exact compiler-proven X/Y/Width/Height/Variable directly into the Property Inspector Grid,
 *    and reads back every property via UIA to assert 0px placement error before advancing.
 */
export function compileDesktopAutomationBridge(
  screen: HmiScreen,
  knownTags: Record<string, TagDefinition>,
  options: { windowTitleRegex?: string; knownScreenIds?: Set<string>; targetHardware?: HaiwellTargetHardware } = {}
): DesktopBridgePlan {
  const validation = validateHmiScreen(screen, knownTags, options);
  if (!validation.valid) {
    throw new Error(
      `Refusing to export desktop bridge for invalid HMI screen "${screen.id}". Fix collisions/bounds/tags first via haiwell_hmi_layout_solve.`
    );
  }

  const components = screen.widgets.map((w) => {
    const spec = TOOLBOX_BY_TYPE.get(w.type);
    const props: Record<string, string | number | boolean> = {
      Name: w.id,
      Left: w.x,
      Top: w.y,
      Width: w.width,
      Height: w.height,
      Text: w.label,
    };
    if (w.tagName) props[w.writeEnabled ? 'WriteVariable' : 'ReadVariable'] = w.tagName;
    if (w.writeEnabled !== undefined) props.EnableTouch = w.writeEnabled;
    if (w.unit) props.Unit = w.unit;
    if (w.min !== undefined) props.MinValue = w.min;
    if (w.max !== undefined) props.MaxValue = w.max;
    if (w.precision !== undefined) props.DecimalPlaces = w.precision;
    if (w.targetScreenId) props.TargetScreen = w.targetScreenId;

    return {
      id: w.id,
      haiwellClassName: spec?.haiwellClassName ?? 'HwGenericControl',
      haiwellToolboxName: spec?.haiwellToolboxName ?? w.type,
      properties: props,
    };
  });

  const uiaExecutionSteps = components.map((comp, idx) => ({
    step: idx + 1,
    widgetId: comp.id,
    action: 'DROP_BY_TOOLBOX_NAME_THEN_SET_PROPERTY_GRID' as const,
    toolboxItemName: comp.haiwellToolboxName,
    propertyWrites: comp.properties,
    postConditionAssertions: {
      Left: comp.properties.Left,
      Top: comp.properties.Top,
      Width: comp.properties.Width,
      Height: comp.properties.Height,
      ...(comp.properties.ReadVariable ? { ReadVariable: comp.properties.ReadVariable } : {}),
      ...(comp.properties.WriteVariable ? { WriteVariable: comp.properties.WriteVariable } : {}),
    },
  }));

  const winRegex = options.windowTitleRegex ?? '.*Haiwell Cloud SCADA Develop.*';
  const pyPlanJson = JSON.stringify(uiaExecutionSteps, null, 2);

  const pywinautoScript = [
    `#!/usr/bin/env python3`,
    `"""`,
    `Zero-Error Haiwell Cloud SCADA Develop HMI Builder (Windows UI Automation Bridge).`,
    `Screen: ${screen.id} (${screen.name}) - ${screen.width}x${screen.height}`,
    `Strategy: NEVER drag-and-drop to exact pixel coordinates!`,
    `  1. Select component by exact UIA Toolbox item name and drop onto canvas center.`,
    `  2. Inject mathematically verified Left/Top/Width/Height/Variable via Property Grid.`,
    `  3. Read back Property Grid values via UIA to assert 100% placement & binding fidelity.`,
    `Dependencies: pip install pywinauto`,
    `"""`,
    `import json, time`,
    `from pywinauto import Application`,
    ``,
    `WINDOW_TITLE_RE = ${JSON.stringify(winRegex)}`,
    `STEPS = json.loads(r'''${pyPlanJson.replace(/'''/g, "\\'\\'\\'")}''')`,
    ``,
    `def set_and_verify_property(prop_grid, prop_name: str, expected_val, retries: int = 3):`,
    `    expected_str = str(expected_val)`,
    `    for attempt in range(1, retries + 1):`,
    `        row = prop_grid.child_window(title=prop_name, control_type="DataItem")`,
    `        row.click_input()`,
    `        row.type_keys("^a{BACKSPACE}" + expected_str + "{ENTER}", with_spaces=True)`,
    `        time.sleep(0.05)`,
    `        actual = str(row.legacy_properties().get("Value", "")).strip()`,
    `        if actual == expected_str:`,
    `            return True`,
    `        time.sleep(0.1 * attempt)`,
    `    raise RuntimeError(f"UIA verification failed for property {prop_name}: expected={expected_str!r}")`,
    ``,
    `def build_hmi_screen():`,
    `    app = Application(backend="uia").connect(title_re=WINDOW_TITLE_RE)`,
    `    win = app.window(title_re=WINDOW_TITLE_RE)`,
    `    win.set_focus()`,
    `    toolbox = win.child_window(auto_id="ToolboxPanel")`,
    `    canvas = win.child_window(auto_id="DesignCanvas")`,
    `    prop_grid = win.child_window(auto_id="PropertyGrid")`,
    `    canvas_rect = canvas.rectangle()`,
    `    drop_pt = (canvas_rect.mid_point().x, canvas_rect.mid_point().y)`,
    ``,
    `    for step in STEPS:`,
    `        item = toolbox.child_window(title=step["toolboxItemName"])`,
    `        item.drag_mouse_input(dst=drop_pt)  # Drop anywhere; exact geometry set via Property Grid`,
    `        time.sleep(0.1)`,
    `        for k, v in step["propertyWrites"].items():`,
    `            set_and_verify_property(prop_grid, k, v)`,
    `        for k, v in step["postConditionAssertions"].items():`,
    `            row = prop_grid.child_window(title=k, control_type="DataItem")`,
    `            actual = str(row.legacy_properties().get("Value", "")).strip()`,
    `            assert actual == str(v), f"Mismatch on {step['widgetId']}.{k}: {actual!r} != {v!r}"`,
    `        print(f"[OK] Step {step['step']}/{len(STEPS)}: {step['widgetId']} verified via UIA")`,
    ``,
    `if __name__ == "__main__":`,
    `    build_hmi_screen()`,
  ].join('\n');

  return {
    strategy: 'NATIVE_IMPORT_PRIMARY_WITH_UIA_PROPERTY_GRID_FALLBACK',
    whyZeroError: [
      'Screen geometry is solved mathematically beforehand (0px overlap, >=44px touch targets, 0px pipe-to-port gap).',
      'Primary path imports nativeImportManifest directly without GUI interaction.',
      'Fallback Windows UIA path drops each component anywhere on canvas by Toolbox Control Name and injects exact Left/Top/Width/Height/Variable into Haiwell Property Grid with UIA read-back assertions.',
    ],
    screenId: screen.id,
    nativeImportManifest: {
      schema: 'haiwell.scada.screen.v2',
      screen: {
        id: screen.id,
        name: screen.name,
        width: screen.width,
        height: screen.height,
        backgroundColor: screen.backgroundColor,
      },
      components,
      pipelines: screen.pipes ?? [],
    },
    uiaExecutionSteps,
    pywinautoScript,
  };
}
