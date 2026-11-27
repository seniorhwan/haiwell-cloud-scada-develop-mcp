import crypto from 'node:crypto';
import { HAIWELL_NATIVE_SYMBOLS, type NativeSymbolBBox } from './haiwellNativeSymbols';
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
import {
  generateLedLampPng,
  generatePushbuttonPng,
  generateSolidPngBase64,
} from './hwPngIcons';
import type { HaiwellProject, HmiScreen, HmiVisualRole, HmiWidget, TagDefinition } from './types';

export interface HwExportCompileOptions {
  screenIds?: string[];
  startWindowId?: number;
  language?: 'en_0' | 'zh_0';
  variableFullNameOverrides?: Record<string, string>;
  exportVariableGroups?: { groupName: string; tags: TagDefinition[] }[];
  exportTasks?: { name: string; script: string; memo?: string }[];
}

export interface HwExportCompileResult {
  xml: string;
  fileName: string;
  screensExported: number;
  widgetsExported: number;
  variablesBound: number;
  warnings: string[];
}

function xmlEsc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mapHaiwellVarType(dt: TagDefinition['dataType']): string {
  switch (dt) {
    case 'BOOL':
      return 'BOOL';
    case 'INT16':
      return 'INT16';
    case 'UINT16':
      return 'UINT16';
    case 'INT32':
      return 'INT32';
    case 'UINT32':
      return 'UINT32';
    case 'FLOAT32':
    case 'FLOAT64':
      return 'FLOAT';
    case 'STRING':
      return 'STRING';
    case 'BCD16':
    case 'BCD32':
      return 'UINT16';
  }
}

function resolveTagFullName(
  tag: TagDefinition,
  project: HaiwellProject,
  overrides?: Record<string, string>
): string {
  if (overrides && overrides[tag.name]) {
    return overrides[tag.name];
  }
  if (tag.scope === 'INTERNAL' && tag.description) {
    const importedMatch = /imported from ([^)\s]+)/i.exec(tag.description);
    if (importedMatch) {
      return importedMatch[1];
    }
  }
  if (tag.scope === 'PLC' && tag.deviceId) {
    const dev = project.devices.find((d) => d.id === tag.deviceId);
    if (dev) {
      const prefix = `${dev.name}_`;
      if (tag.name.startsWith(prefix)) {
        const stripped = tag.name.slice(prefix.length);
        const sameDeviceRawExists = Object.values(project.tags).some(
          (other) => other.name === stripped && other.deviceId === tag.deviceId
        );
        if (!sameDeviceRawExists && stripped.length > 0) {
          return `${dev.name}.${stripped}`;
        }
      }
      return `${dev.name}.${tag.name}`;
    }
  }
  return tag.name;
}

function computeNativeMatrix(
  bbox: NativeSymbolBBox,
  targetX: number,
  targetY: number,
  targetW: number,
  targetH: number,
  preserveAspect: boolean
): string {
  const bw = Math.max(1, bbox.width);
  const bh = Math.max(1, bbox.height);
  let sx = targetW / bw;
  let sy = targetH / bh;
  let offX = 0;
  let offY = 0;
  if (preserveAspect) {
    const s = Math.min(sx, sy);
    sx = s;
    sy = s;
    offX = (targetW - bw * s) / 2;
    offY = (targetH - bh * s) / 2;
  }
  const tx = targetX + offX - bbox.minX * sx;
  const ty = targetY + offY - bbox.minY * sy;
  return `matrix(${sx.toFixed(6)},0,0,${sy.toFixed(6)},${tx.toFixed(3)},${ty.toFixed(3)})`;
}

function scopeGradientIds(svgFragment: string, hwkey: string): string {
  return svgFragment
    .replace(/id="(HWID[^"]+)"/g, `id="${hwkey}_$1"`)
    .replace(/url\(#(HWID[^)]+)\)/g, `url(#${hwkey}_$1)`);
}

function getPushbuttonPalette(role?: HmiVisualRole): {
  state0: string;
  state1: string;
  text: string;
} {
  switch (role) {
    case 'PRIMARY_ACTION':
      return { state0: '#16A34A', state1: '#22C55E', text: '#0F172A' };
    case 'DANGER_ACTION':
      return { state0: '#B91C1C', state1: '#EF4444', text: '#0F172A' };
    case 'WARNING_ACTION':
      return { state0: '#D97706', state1: '#F59E0B', text: '#0F172A' };
    default:
      return { state0: '#1D4ED8', state1: '#3B82F6', text: '#0F172A' };
  }
}

function buildTwoStateTextConfig(lang: string, color: string, fontSize: number, bold: boolean) {
  const single = {
    t: '',
    f: 'Arial',
    s: fontSize,
    sh: Number((fontSize * 1.33).toFixed(2)),
    fs: bold ? 'Bold' : 'Regular',
    u: 0,
    st: 0,
    fe: 'Arial',
  };
  const langObj = {
    c: color,
    t: '',
    f: 'Arial',
    s: String(fontSize),
    sh: String(Number((fontSize * 1.33).toFixed(2))),
    fs: bold ? 'Bold' : 'Regular',
    u: '0',
    st: '0',
    fe: 'Arial',
  };
  return {
    stateConfig: JSON.stringify({
      '0': { c: color, ism: 1, single, [lang]: single },
      '1': { c: color, ism: 1, single, [lang]: single },
    }),
    contentConfig: JSON.stringify({
      '0': langObj,
      '1': langObj,
    }),
  };
}

interface SymbolLibEntry {
  symbolId: string;
  symbolType: 'svg' | 'image';
  md5: string;
  color: string;
  symbolXml?: string;
}

interface SymbolGroupEntry {
  groupId: string;
  symbolType: 'svg' | 'image';
  stateIds: Record<string, string>;
  colors: Record<string, string>;
}

interface SymRecord {
  id: number;
  name: string;
  symbolName: string;
  hwkey: string;
  groupId: string;
  defaultGroupId: string;
  winId: number;
  md5Config: string;
  textConfig: string;
  stateCount: number;
  textContent: string;
  textLocalId: string;
  textColor: string;
  fontSize: number;
  fontWeight: 'bold' | 'normal';
  varBindings: { propName: string; varId: number }[];
}

/**
 * Compiles validated HMI screens + bound PLC/Internal variables from a HaiwellProject
 * into an official Haiwell Cloud Scada 3.50.x `<HwExportModel>` `.hwExport` XML file.
 * - Uses native `<SymbolType>image</SymbolType>` + 96x96 3D shaded PNGs for `BitSw` & `BitLamp`
 *   so Haiwell 3.50.x renders crisp 3D pushbuttons & glowing pilot LEDs with zero dashed boxes.
 * - Uses crisp ISA-101 flat card frames (`Shape` + 28px title header strip) with zero bevel overlap.
 * - Uses native `Scada.Develop.Symbol.dll` templates for `HWIstrument3`, `HWCursor3`, `ConveyorBelt1`,
 *   `HWAlarmTableControlNew`, `RealTimeCurves`, `HWHistoricalDataTableNew`, `HWClock4`, `Motor1`, `HWReactor25`, `HWGear1`.
 */
export function compileProjectToHwExport(
  project: HaiwellProject,
  options: HwExportCompileOptions = {}
): HwExportCompileResult {
  const warnings: string[] = [];
  const startWindowId = options.startWindowId ?? 5;
  const lang = options.language ?? 'en_0';
  const targetScreens: HmiScreen[] =
    options.screenIds && options.screenIds.length > 0
      ? project.screens.filter((s) => options.screenIds!.includes(s.id))
      : project.screens;

  if (targetScreens.length === 0) {
    throw new Error(`No matching screens found in project "${project.id}" to export as .hwExport.`);
  }

  const varIdByFullName = new Map<string, number>();
  const varTypeById = new Map<number, string>();
  let nextVarId = 500;

  const bindTag = (
    tagName?: string
  ): { varId: number; fullName: string; tag: TagDefinition } | undefined => {
    if (!tagName) return undefined;
    const tag = project.tags[tagName];
    if (!tag) {
      warnings.push(`Widget references unknown tag "${tagName}" — skipped variable binding.`);
      return undefined;
    }
    const fullName = resolveTagFullName(tag, project, options.variableFullNameOverrides);
    let varId = varIdByFullName.get(fullName);
    if (varId === undefined) {
      varId = nextVarId++;
      varIdByFullName.set(fullName, varId);
      varTypeById.set(varId, mapHaiwellVarType(tag.dataType));
    }
    return { varId, fullName, tag };
  };

  const bindSystemVar = (fullName: string, dataType = 'SHORT'): number => {
    let varId = varIdByFullName.get(fullName);
    if (varId === undefined) {
      varId = nextVarId++;
      varIdByFullName.set(fullName, varId);
      varTypeById.set(varId, dataType);
    }
    return varId;
  };

  const symbolLibs = new Map<string, SymbolLibEntry>();
  const symbolGroups = new Map<string, SymbolGroupEntry>();
  const pictures = new Map<string, { id: number; md5: string; base64: string }>();
  let nextPicId = 1;

  const registerPng = (png: { base64: string; md5: string }): string => {
    if (!pictures.has(png.md5)) {
      pictures.set(png.md5, { id: nextPicId++, md5: png.md5, base64: png.base64 });
    }
    return png.md5;
  };

  const ensurePic = (color: string): string => registerPng(generateSolidPngBase64(color));

  const ensureImageGroup = (
    groupId: string,
    states: { stateKey: string; color: string; png: { base64: string; md5: string } }[]
  ): SymbolGroupEntry => {
    const existing = symbolGroups.get(groupId);
    if (existing) return existing;
    const stateIds: Record<string, string> = {};
    const colors: Record<string, string> = {};
    for (const st of states) {
      const md5 = registerPng(st.png);
      const symId = `${groupId}_st${st.stateKey}_${md5.slice(0, 8)}`;
      if (!symbolLibs.has(symId)) {
        symbolLibs.set(symId, {
          symbolId: symId,
          symbolType: 'image',
          md5,
          color: st.color,
        });
      }
      stateIds[st.stateKey] = symId;
      colors[st.stateKey] = st.color;
    }
    const grp: SymbolGroupEntry = { groupId, symbolType: 'image', stateIds, colors };
    symbolGroups.set(groupId, grp);
    return grp;
  };

  const ensureSvgGroup = (
    groupId: string,
    entries: { stateKey: string; symbolId: string; color: string; symbolXml: string }[]
  ): SymbolGroupEntry => {
    const existing = symbolGroups.get(groupId);
    if (existing) return existing;
    const stateIds: Record<string, string> = {};
    const colors: Record<string, string> = {};
    for (const e of entries) {
      const md5 = ensurePic(e.color);
      if (!symbolLibs.has(e.symbolId)) {
        symbolLibs.set(e.symbolId, {
          symbolId: e.symbolId,
          symbolType: 'svg',
          md5,
          color: e.color,
          symbolXml: e.symbolXml,
        });
      }
      stateIds[e.stateKey] = e.symbolId;
      colors[e.stateKey] = e.color;
    }
    const grp: SymbolGroupEntry = { groupId, symbolType: 'svg', stateIds, colors };
    symbolGroups.set(groupId, grp);
    return grp;
  };

  const textGroup = ensureSvgGroup('shap001', [
    {
      stateKey: '0',
      symbolId: 'shap001_0',
      color: '#FFFFFF',
      symbolXml: `<symbol symbolId="shap001_0" hwsymbolId="HWNumIntervalImage" set="{'HWBackColor1':'#DDDDDD'}"><g><rect x="0" y="0" width="100" height="100" fill="#FFFFFF" stroke="none" /></g></symbol>`,
    },
  ]);

  const symRecords: SymRecord[] = [];
  const winAndDocXmlParts: string[] = [];
  let nextWinDbId = 100;
  let nextSymDbId = 1000;
  let totalWidgets = 0;

  const screenNameToWinDbId = new Map<string, number>();
  const screenNameToWindowId = new Map<string, number>();
  targetScreens.forEach((s, idx) => {
    screenNameToWinDbId.set(s.name, nextWinDbId + idx);
    screenNameToWindowId.set(s.name, startWindowId + idx);
  });

  targetScreens.forEach((screen, scrIdx) => {
    const winDbId = nextWinDbId++;
    const windowId = startWindowId + scrIdx;
    const docDbId = winDbId;
    const usedVarIds = new Set<number>();
    const svgElements: string[] = [];

    const registerTextOnlyRecord = (
      symType: string,
      symId: string,
      hwkey: string,
      groupId: string,
      md5Config: Record<string, string>,
      text: string,
      color: string,
      fontSize: number,
      bold: boolean,
      localId = 'at',
      varBindings: { propName: string; varId: number }[] = [],
      defaultGroupId = groupId,
      explicitSeq?: number
    ) => {
      const seq = explicitSeq ?? nextSymDbId++;
      const single = {
        t: text,
        f: 'Arial',
        s: fontSize,
        sh: Number((fontSize * 1.33).toFixed(2)),
        fs: bold ? 'Bold' : 'Regular',
        u: 0,
        st: 0,
        fe: 'Arial',
      };
      symRecords.push({
        id: seq,
        name: symType,
        symbolName: symId,
        hwkey,
        groupId,
        defaultGroupId,
        winId: winDbId,
        md5Config: JSON.stringify(md5Config),
        textConfig: JSON.stringify({ '0': { c: color, ism: 1, single, [lang]: single } }),
        stateCount: Object.keys(md5Config).length,
        textContent: JSON.stringify({
          '0': {
            c: color,
            t: text,
            f: 'Arial',
            s: String(fontSize),
            sh: String(Number((fontSize * 1.33).toFixed(2))),
            fs: bold ? 'Bold' : 'Regular',
            u: '0',
            st: '0',
            fe: 'Arial',
          },
        }),
        textLocalId: localId,
        textColor: color,
        fontSize,
        fontWeight: bold ? 'bold' : 'normal',
        varBindings,
      });
    };

    const addTxtBlock = (
      x: number,
      y: number,
      w: number,
      h: number,
      text: string,
      opts: {
        color?: string;
        fontSize?: number;
        bold?: boolean;
        align?: 'left' | 'center' | 'right';
        bg?: string;
        bgOpacity?: number;
      } = {}
    ) => {
      const seq = nextSymDbId++;
      const symId = `TxtBlock_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const txtColor = opts.color ?? '#0F172A';
      const fontSize = opts.fontSize ?? 13;
      const bold = Boolean(opts.bold);
      const fontWeight = bold ? 'bold' : 'normal';
      const align = opts.align ?? 'left';
      const bg = opts.bg ?? '#FFFFFF';
      const bgOp = opts.bgOpacity ?? 0;
      const svgFill = bgOp === 0 ? 'none' : bg;

      registerTextOnlyRecord(
        'TxtBlock',
        symId,
        hwkey,
        textGroup.groupId,
        { '0': ensurePic(bg) },
        text,
        txtColor,
        fontSize,
        bold,
        'at',
        [],
        textGroup.groupId,
        seq
      );

      svgElements.push(
        `<g transform="matrix(1,0,0,1,${x},${y})" hw-PowerTime="10" sym-type="TxtBlock" v="0.6" id="${symId}" hwkey="${hwkey}" TxtAlign="${align}" TxtColor="${txtColor}" IsResize="false" HWBackColor="${bg}" HWBackOpacity="${bgOp === 0 ? 0 : 100}" Blinking="false" SwCtrl="false" IsOFFCtrl="false" BlinkingTime="1000" IsTextToPicture="false" Txt="${xmlEsc(text)}" IsTextBlock="true" SwCtrlVar=""><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Text" title-en="Text" name="TxtBlock" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w}" height="${h}" fill="${svgFill}" stroke="none" text-color="${txtColor}" fill-opacity="${bgOp}" text-anchor="${align}" vertical-align="milldle" font-family="Arial" fonten="Arial" font-size="${fontSize}" sh="${(fontSize * 1.33).toFixed(2)}" wrap="nowrap" font-weight="${fontWeight}" font-style="normal" text-decoration="normal">${xmlEsc(text)}</textBlock></g></g></g></g>`
      );
    };

    const addFlatRectShape = (
      x: number,
      y: number,
      w: number,
      h: number,
      fillHex: string,
      strokeHex: string,
      rx = 3
    ) => {
      const seq = nextSymDbId++;
      const symId = `Shape_${seq}`;
      const hwkey = `${symId}_${seq}`;
      registerTextOnlyRecord(
        'Shape',
        symId,
        hwkey,
        textGroup.groupId,
        { '0': ensurePic(fillHex) },
        '',
        '#0F172A',
        12,
        false,
        'st',
        [],
        textGroup.groupId,
        seq
      );
      svgElements.push(
        `<g transform="matrix(${(w / 100).toFixed(6)},0,0,${(h / 100).toFixed(6)},${x},${y})" hw-PowerTime="10" sym-type="Shape" v="0.2" id="${symId}" hwkey="${hwkey}" StCt="1" RemoteOperation="true"><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" title="Graphics" name="Shape" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="${rx}" ry="${rx}" width="100" height="100" stroke="${strokeHex}" stroke-width="1.5" fill="${fillHex}" /></g></g></g></g></g>`
      );
    };

    const screenTheme = resolveScreenTheme(screen);
    const screenBg = normalizeHexColor(screen.backgroundColor) ?? screenTheme.canvasBg;

    const placeDllSymbol = (
      dllKey: string,
      symType: string,
      x: number,
      y: number,
      w: number,
      h: number,
      opts: {
        preserveAspect?: boolean;
        extraAttrs?: string;
        varBindings?: { propName: string; varId: number }[];
        transformVisual?: (vis: string) => string;
      } = {}
    ) => {
      const def = HAIWELL_NATIVE_SYMBOLS.dllSymbols[dllKey];
      const seq = nextSymDbId++;
      const symId = `${symType}_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const tf = computeNativeMatrix(
        def.bbox,
        x,
        y,
        w,
        h,
        opts.preserveAspect ?? def.preserveAspect
      );
      let vis = scopeGradientIds(def.visualXml, hwkey)
        .replace(/>仪表</g, '>%<')
        .replace(/>游标</g, '>Qty<')
        .replace(/>000</g, '>0<');
      if (lang === 'en_0') {
        vis = vis
          .replace(/font-family="宋体"/g, 'font-family="Arial"')
          .replace(/fonten="SimSun"/g, 'fonten="Arial"');
        if (dllKey === 'HWCursor3') {
          vis = vis
            .replace('localid="HWCursor3BoxColor" x="60" y="310" width="70" height="20" stroke="none" fill="#0080FF"', 'localid="HWCursor3BoxColor" x="60" y="310" width="70" height="20" stroke="none" fill="#1E293B"')
            .replace('localid="HWCursor3Value" x="60" y="310" width="70" height="20" fill="none" stroke="none" text-color="black"', 'localid="HWCursor3Value" x="60" y="310" width="70" height="20" fill="none" stroke="none" text-color="#FFFFFF"');
        }
      }
      if (opts.transformVisual) vis = opts.transformVisual(vis);
      const ctrlAttr = def.control ? ` control="${def.control}"` : '';
      const ctpAttr = def.changeToPicture ? ' ChangeToPicture="true"' : '';
      const defGIdAttr = def.defGId ? ` defGId="${def.defGId}"` : '';
      const grpId = def.defGId || textGroup.groupId;

      registerTextOnlyRecord(
        symType,
        symId,
        hwkey,
        grpId,
        { '0': ensurePic('#E2E8F0') },
        '',
        '#0F172A',
        12,
        false,
        'st',
        opts.varBindings ?? [],
        grpId,
        seq
      );

      svgElements.push(
        `<g transform="${tf}" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${opts.extraAttrs ?? ''}><hwsymbol id="${hwkey}" newsym="true"${ctpAttr}${ctrlAttr}${defGIdAttr} IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="${symType}" title-en="${symType}" name="${symType}" />${vis}</g>`
      );
    };

    // Render pipes underneath widgets
    for (const pipe of screen.pipes ?? []) {
      const boundFlow = bindTag(pipe.flowTagName);
      if (boundFlow) usedVarIds.add(boundFlow.varId);
      const pts = pipe.waypoints;
      if (pts.length >= 2) {
        const p0 = pts[0];
        const p1 = pts[pts.length - 1];
        const minX = Math.min(p0.x, p1.x);
        const minY = Math.min(p0.y, p1.y);
        const spanW = Math.max(24, Math.abs(p1.x - p0.x));
        if (pipe.fluid === 'SIGNAL') {
          const ptsStr = pts.map((p) => `${p.x},${p.y}`).join(' ');
          svgElements.push(
            `<polyline fill="none" stroke="#2563EB" stroke-width="3" stroke-dasharray="6,4" marker-end="url(#arrow2)" points="${ptsStr}" />`
          );
        } else {
          svgElements.push(
            `<g><rect x="${minX}" y="${minY - 5}" width="${spanW}" height="10" rx="2" fill="#94A3B8" stroke="#334155" stroke-width="1.5" /><line x1="${minX}" y1="${minY - 2}" x2="${minX + spanW}" y2="${minY - 2}" stroke="#E2E8F0" stroke-width="2" /></g>`
          );
          placeDllSymbol('HWArrow1', 'HWArrow1', minX + Math.round(spanW / 2) - 14, minY - 11, 28, 22, {
            preserveAspect: true,
            extraAttrs: 'StCt="1" HWBackColor="#16A34A"',
          });
        }
        if (pipe.label) {
          const midX = Math.round((p0.x + p1.x) / 2) - 60;
          const midY = Math.round((p0.y + p1.y) / 2) - 24;
          const pipeTxtColor = pickReadableTextColor(
            screenBg,
            pipe.fluid === 'SIGNAL' ? '#1D4ED8' : screenTheme.textSecondary,
            3.0
          );
          addTxtBlock(Math.max(0, midX), Math.max(0, midY), 120, 18, pipe.label, {
            color: pipeTxtColor,
            fontSize: fitFontSizeToWidth(pipe.label, 116, 10, 8, true),
            bold: true,
            align: 'center',
            bg: screenBg,
          });
        }
      }
    }

    // Paint GROUP_PANEL background containers first (outermost first) so child widgets always render in front
    const orderedWidgets = [
      ...screen.widgets
        .filter((w) => w.type === 'GROUP_PANEL')
        .sort((a, b) => b.width * b.height - a.width * a.height),
      ...screen.widgets.filter((w) => w.type !== 'GROUP_PANEL'),
    ];

    for (const w of orderedWidgets) {
      totalWidgets++;
      const bound = bindTag(w.tagName);
      if (bound) usedVarIds.add(bound.varId);
      const surface = resolveWidgetSurfaceContext(screen, w);

      // 1. GROUP_PANEL -> Flat industrial card with surface-matched header text
      if (w.type === 'GROUP_PANEL') {
        const panelCols = getGroupPanelColors(w, screenTheme);
        if (panelCols.isDarkBar) {
          addFlatRectShape(w.x, w.y, w.width, w.height, panelCols.bodyBg, panelCols.border, 2);
          if (w.label) {
            const availW = computeBannerTitleAvailableWidth(screen, w);
            const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 14;
            const fittedSize = fitFontSizeToWidth(w.label, availW, prefSize, 9, true);
            addTxtBlock(w.x + 14, w.y + Math.max(6, Math.round((w.height - 22) / 2)), availW, 22, w.label, {
              color: panelCols.headerText,
              fontSize: fittedSize,
              bold: true,
              align: 'left',
              bg: panelCols.bodyBg,
            });
          }
        } else if (w.props?.theme === 'light_banner') {
          addFlatRectShape(w.x, w.y, w.width, w.height, panelCols.bodyBg, panelCols.border, 2);
          if (w.label) {
            const availW = computeBannerTitleAvailableWidth(screen, w);
            const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 14;
            const fittedSize = fitFontSizeToWidth(w.label, availW, prefSize, 9, true);
            addTxtBlock(w.x + 14, w.y + Math.max(6, Math.round((w.height - 22) / 2)), availW, 22, w.label, {
              color: panelCols.headerText,
              fontSize: fittedSize,
              bold: true,
              align: 'left',
              bg: panelCols.bodyBg,
            });
          }
        } else {
          addFlatRectShape(w.x, w.y, w.width, w.height, panelCols.bodyBg, panelCols.border, 2);
          const hdrH = getGroupPanelHeaderHeight(w);
          addFlatRectShape(w.x, w.y, w.width, hdrH, panelCols.headerBg, panelCols.border, 2);
          if (w.label) {
            const availW = Math.max(60, w.width - 20);
            const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 11;
            const fittedSize = fitFontSizeToWidth(w.label, availW, prefSize, 8, true);
            addTxtBlock(w.x + 10, w.y + Math.round((hdrH - 18) / 2), availW, 18, w.label, {
              color: panelCols.headerText,
              fontSize: fittedSize,
              bold: true,
              align: 'left',
              bg: panelCols.headerBg,
            });
          }
        }
        continue;
      }

      // 2. LABEL (or HWClock4 live digital clock or custom PNG logo)
      if (w.type === 'LABEL') {
        if (typeof w.props?.customImageBase64 === 'string' && w.props.customImageBase64.length > 0) {
          const cleanedB64 = w.props.customImageBase64
            .replace(/^data:image\/png;base64,/i, '')
            .replace(/\s+/g, '');
          const decodedBuf = Buffer.from(cleanedB64, 'base64');
          const hasPngMagic =
            decodedBuf.length >= 8 &&
            decodedBuf[0] === 0x89 &&
            decodedBuf[1] === 0x50 &&
            decodedBuf[2] === 0x4e &&
            decodedBuf[3] === 0x47 &&
            decodedBuf[4] === 0x0d &&
            decodedBuf[5] === 0x0a &&
            decodedBuf[6] === 0x1a &&
            decodedBuf[7] === 0x0a;
          if (!hasPngMagic) {
            warnings.push(
              `Skipped invalid customImageBase64 on LABEL "${w.id}" in screen "${screen.name}": payload is not a valid PNG image.`
            );
            continue;
          }
          const canonicalB64 = decodedBuf.toString('base64');
          const md5 = crypto.createHash('md5').update(decodedBuf).digest('hex').toLowerCase();
          const grp = ensureImageGroup(`logo_${md5.slice(0, 12)}`, [
            { stateKey: '0', color: '#FFFFFF', png: { base64: canonicalB64, md5 } },
          ]);
          const seq = nextSymDbId++;
          const symId = `Shape_${seq}`;
          const hwkey = `${symId}_${seq}`;
          const scale = w.height / 100;
          const imgBoxW = (w.width / Math.max(0.01, scale)).toFixed(2);
          const scStr = scale.toFixed(6);
          registerTextOnlyRecord(
            'Shape',
            symId,
            hwkey,
            grp.groupId,
            { '0': symbolLibs.get(grp.stateIds['0'])!.md5 },
            '',
            '#0F172A',
            11,
            false,
            'at',
            [],
            grp.groupId,
            seq
          );
          svgElements.push(
            `<g transform="matrix(${scStr},0,0,${scStr},${w.x},${w.y})" hw-PowerTime="10" sym-type="Shape" v="0.2" id="${symId}" hwkey="${hwkey}" StCt="1" RemoteOperation="true"><hwsymbol id="${hwkey}" newsym="true" defGId="${grp.groupId}" title="Graphics" name="Shape" /><g><g sign="state"><g sign="svg"><image localid="si" x="0" y="0" width="${imgBoxW}" height="100" preserveAspectRatio="xMidYMid meet" md5file="${md5}" /></g><g sign="text" /></g></g></g>`
          );
        } else if (w.props?.nativeSymbol === 'HWClock4') {
          const seq = nextSymDbId++;
          const symId = `Clock4_${seq}`;
          const hwkey = `HWClock4_${seq}_${seq}`;
          const clkBg = surface.isDarkSurface ? surface.surfaceBg : screenTheme.clockBg;
          const clkFg = screenTheme.clockText;
          registerTextOnlyRecord(
            'HWClock4',
            symId,
            hwkey,
            textGroup.groupId,
            { '0': ensurePic(clkBg) },
            '00:00:00',
            clkFg,
            13,
            true,
            'at',
            [],
            textGroup.groupId,
            seq
          );
          svgElements.push(
            `<g transform="matrix(1,0,0,1,${w.x},${w.y})" hw-PowerTime="10" sym-type="HWClock4" v="0.3" id="${symId}" hwkey="${hwkey}" Font="" TxtColor="${clkFg}" HWBackColor="${clkBg}" HWBackOpacity="100" IsTextBlock="true" DateEnable="true" DataType="7" DataSign="/" WeekEnable="false" TimeEnable="true"><hwsymbol ChangeToPicture="true" id="${hwkey}" newSym="true" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Clock" name="HWClock4" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w.width}" height="${w.height}" fill="none" stroke="none" text-color="${clkFg}" text-anchor="right" font-family="Arial" fonten="Arial" font-size="13" sh="17.3" font-weight="bold" wrap="nowrap">00:00:00</textBlock></g></g></g></g>`
          );
        } else {
          const explicitBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined);
          const lblBg = explicitBg ?? surface.surfaceBg;
          const prefColor = typeof w.props?.color === 'string' ? w.props.color : surface.defaultTextColor;
          const safeColor = pickReadableTextColor(lblBg, prefColor, 3.0);
          const bold = w.props?.bold !== false;
          const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
          const fittedSize = fitFontSizeToWidth(w.label, Math.max(24, w.width - 4), prefSize, 8, bold);
          addTxtBlock(w.x, w.y, w.width, w.height, w.label, {
            color: safeColor,
            fontSize: fittedSize,
            bold,
            align: (w.props?.align as 'left' | 'center' | 'right') ?? 'left',
            bg: lblBg,
            bgOpacity: explicitBg ? 1 : 0,
          });
        }
        continue;
      }

      // 3. BIT_BUTTON -> Native Haiwell <SymbolType>image</SymbolType> BitSw with bounds-safe caption
      if (w.type === 'BIT_BUTTON') {
        const pal = getPushbuttonPalette(w.visualRole);
        const png0 = generatePushbuttonPng(pal.state0, false, 96);
        const png1 = generatePushbuttonPng(pal.state1, true, 96);
        const grp = ensureImageGroup(`img_sw006_${pal.state0.replace('#', '')}`, [
          { stateKey: '0', color: pal.state0, png: png0 },
          { stateKey: '1', color: pal.state1, png: png1 },
        ]);

        const seq = nextSymDbId++;
        const symId = `BitSw_${seq}`;
        const hwkey = `${symId}_${seq}`;
        const geom = computeBitButtonGeometry(w);
        const sx = (geom.iconSize / 100).toFixed(6);
        const sy = (geom.iconSize / 100).toFixed(6);
        const wrtAttrs = bound
          ? `WrtVar="${xmlEsc(bound.fullName)}" WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"`
          : `WrtVar=""`;
        const lblColor = pickReadableTextColor(
          surface.surfaceBg,
          typeof w.props?.labelColor === 'string'
            ? w.props.labelColor
            : typeof w.props?.color === 'string'
              ? w.props.color
              : surface.defaultTextColor,
          3.0
        );
        const txtCfg = buildTwoStateTextConfig(lang, lblColor, 10, true);

        symRecords.push({
          id: seq,
          name: 'BitSw',
          symbolName: symId,
          hwkey,
          groupId: grp.groupId,
          defaultGroupId: 'sw006',
          winId: winDbId,
          md5Config: JSON.stringify({ '0': png0.md5, '1': png1.md5 }),
          textConfig: txtCfg.stateConfig,
          stateCount: 2,
          textContent: txtCfg.contentConfig,
          textLocalId: 'st',
          textColor: lblColor,
          fontSize: 10,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'WrtVar-id', varId: bound.varId }] : [],
        });

        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${geom.iconX.toFixed(2)},${geom.iconY.toFixed(2)})" hw-PowerTime="10" sym-type="BitSw" v="0.1" id="${symId}" hwkey="${hwkey}" RvrsSt="false" DifVar="false" ActnLock="false" LockMode="var" LockExpress-Express="" LockExpress-Enable="false" LockLogic="off" LockStyle="show" StCt="2" ActnType="sw" ActnEff="false" WhthCnfrmBox="false" CnfrmType="all" UseMiniTime="false" MiniTime="3.0" UseDisplayTime="true" DisplayLocal="up_down" IsNoticeEnable="false" NoticeOrderType="before" NoticeType="bit" ActionType="sw" NumVarValue="1" ${wrtAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="sw006" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit switch" title-en="Bit switch" name="BitSw" /><g><g sign="state"><g sign="svg"><image localid="si" x="0" y="0" width="100" height="100" md5file="${png0.md5}" newsym="true" /></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" font-weight="normal" font-style="normal" text-decoration="normal" cst="0" /></g></g></g></g>`
        );
        const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
        addTxtBlock(geom.labelX, geom.labelY, geom.labelW, geom.labelH, w.label, {
          color: lblColor,
          fontSize: fitFontSizeToWidth(w.label, geom.labelW, prefSize, 8, true),
          bold: true,
          align: geom.labelAlign,
          bg: surface.surfaceBg,
        });
        continue;
      }

      // 4. BIT_LAMP -> Native Haiwell <SymbolType>image</SymbolType> BitLamp with surface-matched label & bounds safety
      if (w.type === 'BIT_LAMP') {
        const offHex = w.visualRole === 'DANGER_ACTION' ? '#DC2626' : '#64748B';
        const onHex = '#22C55E';
        const png0 = generateLedLampPng(offHex, false, 96);
        const png1 = generateLedLampPng(onHex, true, 96);
        const grp = ensureImageGroup(`img_lamp013_${offHex.replace('#', '')}`, [
          { stateKey: '0', color: offHex, png: png0 },
          { stateKey: '1', color: onHex, png: png1 },
        ]);

        const seq = nextSymDbId++;
        const symId = `BitLamp_${seq}`;
        const hwkey = `${symId}_${seq}`;
        const geom = computeBitLampGeometry(w);
        const sx = (geom.ledSize / 100).toFixed(6);
        const sy = (geom.ledSize / 100).toFixed(6);
        const rdAttrs = bound
          ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `RdVar=""`;
        const lblColor = pickReadableTextColor(
          surface.surfaceBg,
          typeof w.props?.labelColor === 'string'
            ? w.props.labelColor
            : typeof w.props?.color === 'string'
              ? w.props.color
              : surface.defaultTextColor,
          3.0
        );
        const txtCfg = buildTwoStateTextConfig(lang, lblColor, 10, true);

        symRecords.push({
          id: seq,
          name: 'BitLamp',
          symbolName: symId,
          hwkey,
          groupId: grp.groupId,
          defaultGroupId: 'lamp013',
          winId: winDbId,
          md5Config: JSON.stringify({ '0': png0.md5, '1': png1.md5 }),
          textConfig: txtCfg.stateConfig,
          stateCount: 2,
          textContent: txtCfg.contentConfig,
          textLocalId: 'st',
          textColor: lblColor,
          fontSize: 10,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
        });

        const rvrsSt = w.props?.invertDisplay ? 'true' : 'false';
        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${geom.ledX.toFixed(2)},${geom.ledY.toFixed(2)})" hw-PowerTime="10" sym-type="BitLamp" v="0.4" id="${symId}" hwkey="${hwkey}" RvrsSt="${rvrsSt}" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" EnblExps="" ${rdAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="lamp013" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit lamp" title-en="Bit lamp" name="BitLamp" /><g><g sign="state"><g sign="svg"><image localid="si" x="0" y="0" width="100" height="100" md5file="${png0.md5}" newsym="true" /></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" font-weight="normal" font-style="normal" text-decoration="normal" cst="0" /></g></g></g></g>`
        );

        const prefSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : geom.horizontal ? 11 : 10;
        addTxtBlock(geom.labelX, geom.labelY, geom.labelW, geom.labelH, w.label, {
          color: lblColor,
          fontSize: fitFontSizeToWidth(w.label, geom.labelW, prefSize, 8, true),
          bold: true,
          align: geom.labelAlign,
          bg: surface.surfaceBg,
        });
        continue;
      }

      // 5. GAUGE -> Real Haiwell HWIstrument3 circular dial gauge
      if (w.type === 'GAUGE') {
        const headerH = 18;
        const gaugeTitle = `${w.label}${w.unit ? ` (${w.unit})` : ''}`;
        addTxtBlock(w.x, w.y, w.width, headerH, gaugeTitle, {
          color: surface.defaultTextColor,
          fontSize: fitFontSizeToWidth(gaugeTitle, Math.max(30, w.width - 4), 11, 8, true),
          bold: true,
          align: 'center',
          bg: surface.surfaceBg,
        });
        const extra = bound
          ? `HWNumVar="${xmlEsc(bound.fullName)}" HWNumVar-id="${bound.varId}" HWMaxValue="${w.max ?? 100}" HWMinValue="${w.min ?? 0}" HWPoints="${w.precision ?? 1}" HwLimit="num"`
          : `HWMaxValue="${w.max ?? 100}" HWMinValue="${w.min ?? 0}" HWPoints="${w.precision ?? 1}" HwLimit="num"`;
        placeDllSymbol('HWIstrument3', 'HWIstrument3', w.x, w.y + headerH, w.width, Math.max(60, w.height - headerH), {
          preserveAspect: true,
          extraAttrs: extra,
          varBindings: bound ? [{ propName: 'HWNumVar-id', varId: bound.varId }] : [],
        });
        continue;
      }

      // 6. BAR_GRAPH -> Real Haiwell HWCursor3 vertical level bar
      if (w.type === 'BAR_GRAPH') {
        const headerH = 18;
        const barTitle = `${w.label}${w.unit ? ` (${w.unit})` : ''}`;
        addTxtBlock(w.x, w.y, w.width, headerH, barTitle, {
          color: surface.defaultTextColor,
          fontSize: fitFontSizeToWidth(barTitle, Math.max(30, w.width - 4), 11, 8, true),
          bold: true,
          align: 'center',
          bg: surface.surfaceBg,
        });
        const extra = bound
          ? `HWNumVar="${xmlEsc(bound.fullName)}" HWNumVar-id="${bound.varId}" HWMaxValue="${w.max ?? 100}" HWMinValue="${w.min ?? 0}" HWPoints="0" HwLimit="num"`
          : `HWMaxValue="${w.max ?? 100}" HWMinValue="${w.min ?? 0}" HWPoints="0" HwLimit="num"`;
        placeDllSymbol('HWCursor3', 'HWCursor3', w.x, w.y + headerH, w.width, Math.max(60, w.height - headerH), {
          preserveAspect: true,
          extraAttrs: extra,
          varBindings: bound ? [{ propName: 'HWNumVar-id', varId: bound.varId }] : [],
        });
        continue;
      }

      // 7. ALARM_BANNER -> Real Haiwell HWAlarmTableControlNew
      if (w.type === 'ALARM_BANNER') {
        placeDllSymbol('HWAlarmTableControlNew', 'HWAlarmTableControlNew', w.x, w.y, w.width, w.height, {
          preserveAspect: false,
          extraAttrs: `HwAlarmTableStyle="multiple" HWAlarmTypeMultiple="realtime,history,noConfirmAlarm,confirmAlarm" HwAlarmIsWrap="true"`,
        });
        continue;
      }

      // 8. TREND_CHART -> Real Haiwell RealTimeCurves
      if (w.type === 'TREND_CHART') {
        placeDllSymbol('RealTimeCurves', 'RealTimeCurves', w.x, w.y, w.width, w.height, {
          preserveAspect: false,
          extraAttrs: bound ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-id="${bound.varId}"` : '',
          varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
          transformVisual: (vis) => {
            const idx = vis.lastIndexOf('</g>');
            const overlay = '<rect x="36" y="24" width="364" height="330" fill="#F8FAFC" stroke="#94A3B8" stroke-width="1.5" /><line x1="36" y1="106" x2="400" y2="106" stroke="#CBD5E1" stroke-dasharray="4,4" /><line x1="36" y1="189" x2="400" y2="189" stroke="#CBD5E1" stroke-dasharray="4,4" /><line x1="36" y1="272" x2="400" y2="272" stroke="#CBD5E1" stroke-dasharray="4,4" /><polyline fill="none" stroke="#2563EB" stroke-width="3" points="42,240 105,195 168,210 230,145 292,165 350,120 395,135" /><polyline fill="none" stroke="#16A34A" stroke-width="2.5" points="42,290 105,275 168,280 230,250 292,260 350,235 395,245" />';
            return idx >= 0 ? vis.slice(0, idx) + overlay + vis.slice(idx) : vis;
          },
        });
        continue;
      }

      // 9. DATA_TABLE -> Real Haiwell HWHistoricalDataTableNew
      if (w.type === 'DATA_TABLE') {
        placeDllSymbol('HWHistoricalDataTableNew', 'HWHistoricalDataTableNew', w.x, w.y, w.width, w.height, {
          preserveAspect: false,
          extraAttrs: `QuerySpan="5" IsEnableToolbar="true"`,
        });
        continue;
      }

      // 10. CONVEYOR -> Real Haiwell ConveyorBelt1
      if (w.type === 'CONVEYOR') {
        placeDllSymbol('ConveyorBelt1', 'ConveyorBelt1', w.x, w.y, w.width, w.height, {
          preserveAspect: false,
          extraAttrs: bound
            ? `Enbl="true" EnblExps="${xmlEsc(bound.fullName)}" EnblExps-id="${bound.varId}" Dir="clockwise"`
            : `Enbl="false" Dir="clockwise"`,
          varBindings: bound ? [{ propName: 'EnblExps-id', varId: bound.varId }] : [],
        });
        continue;
      }

      // 11. STATION / ACTUATOR / PUMP / VALVE / TANK -> Crisp Station Card + Native Machinery Symbol
      if (w.type === 'STATION' || w.type === 'ACTUATOR' || w.type === 'PUMP' || w.type === 'VALVE' || w.type === 'TANK') {
        const iconKey =
          typeof w.props?.nativeSymbol === 'string' && HAIWELL_NATIVE_SYMBOLS.dllSymbols[w.props.nativeSymbol]
            ? w.props.nativeSymbol
            : w.type === 'STATION'
              ? 'HWReactor25'
              : w.type === 'ACTUATOR' || w.type === 'PUMP'
                ? 'Motor1'
                : 'HWReactor25';

        if (w.type === 'STATION') {
          addFlatRectShape(w.x, w.y, w.width, w.height, screenTheme.cardBg, screenTheme.cardBorder, 2);
          addFlatRectShape(w.x, w.y, w.width, 28, '#334155', '#1E293B', 2);
          const hdrAvailW = Math.max(24, w.width - 16);
          const hdrColor = pickReadableTextColor('#334155', typeof w.props?.color === 'string' ? w.props.color : '#F8FAFC', 3.0);
          addTxtBlock(w.x + 8, w.y + 5, hdrAvailW, 18, w.label, {
            color: hdrColor,
            fontSize: fitFontSizeToWidth(w.label, hdrAvailW, 11, 8, true),
            bold: true,
            align: 'center',
            bg: '#334155',
          });
          const iconZoneH = typeof w.props?.iconZoneHeight === 'number'
            ? w.props.iconZoneHeight
            : Math.max(56, w.height - 44);
          placeDllSymbol(iconKey, iconKey, w.x + 14, w.y + 34, Math.max(48, w.width - 28), iconZoneH, {
            preserveAspect: true,
            extraAttrs: bound ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-id="${bound.varId}"` : '',
            varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
          });
        } else {
          placeDllSymbol(iconKey, iconKey, w.x, w.y, w.width, w.height, {
            preserveAspect: true,
            extraAttrs: bound ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-id="${bound.varId}"` : '',
            varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
          });
        }
        continue;
      }

      // 12. NAV_BAR -> Native WordSw writing $ShowWindowId (survives .hwExport import with exact WindowID target)
      if (w.type === 'NAV_BAR') {
        const firstScreenName = targetScreens[0]?.name ?? 'Main_display';
        const navTarget =
          (typeof w.props?.targetScreenName === 'string' && w.props.targetScreenName) ||
          (w.targetScreenId && targetScreens.find((s) => s.id === w.targetScreenId)?.name) ||
          firstScreenName;
        const activeNav = Boolean(w.props?.active);
        const bgHex = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined)
          ?? (activeNav ? screenTheme.navActiveBg : screenTheme.navBg);
        const navTxtColor = pickReadableTextColor(
          bgHex,
          typeof w.props?.color === 'string' ? w.props.color : screenTheme.navText,
          3.0
        );
        const seq = nextSymDbId++;
        const btnAsset = HAIWELL_NATIVE_SYMBOLS.librarySymbols['btn214_0'];
        const grp = ensureSvgGroup(`btn214_${bgHex.replace('#', '')}`, [
          {
            stateKey: '0',
            symbolId: `btn214_${bgHex.replace('#', '')}_0`,
            color: bgHex,
            symbolXml: btnAsset.symbolXml.replace(/#77C34F/gi, bgHex),
          },
        ]);
        const sx = (w.width / 100).toFixed(6);
        const sy = (w.height / 100).toFixed(6);
        const isHomeNav = navTarget.toLowerCase() === 'main_display' || w.props?.navAction === 'home';
        const targetWindowId =
          typeof w.props?.targetWindowId === 'number'
            ? w.props.targetWindowId
            : isHomeNav
              ? 1
              : screenNameToWindowId.get(navTarget);

        if (targetWindowId !== undefined) {
          const symId = `WordSw_${seq}`;
          const hwkey = `${symId}_${seq}`;
          const showWinVarId = bindSystemVar('$ShowWindowId', 'SHORT');
          usedVarIds.add(showWinVarId);
          registerTextOnlyRecord(
            'WordSw',
            symId,
            hwkey,
            grp.groupId,
            { '0': symbolLibs.get(grp.stateIds['0'])!.md5 },
            '',
            navTxtColor,
            12,
            true,
            'st',
            [{ propName: 'WrtVar-id', varId: showWinVarId }],
            'btn201',
            seq
          );
          svgElements.push(
            `<g transform="matrix(${sx},0,0,${sy},${w.x},${w.y})" hw-PowerTime="10" sym-type="WordSw" v="0.1" id="${symId}" hwkey="${hwkey}" WhthCnfrmBox="false" ActnEff="false" CnfrmTxt="Make sure to perform the current operation" ActnFun="asgn" Opds="${targetWindowId}" LmtIsVar="false" LmtRet="false" LmtNum="80" RetNum="0" ActnLock="false" LockMode="var" LockLogic="off" LockStyle="show" StCt="1" WrtVar="$ShowWindowId" WrtVar-UseAddr="false" WrtVar-id="${showWinVarId}" LmtVar="" LockVar="" NoticeBitVar="" NoticeNumVar="" RemoteOperation="true"><hwsymbol id="${hwkey}" newsym="true" defGId="btn201" title="Word switch" name="WordSw" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="6" ry="6" width="100" height="100" stroke="#0F172A" stroke-width="2" fill="${bgHex}" /></g></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="${navTxtColor}" text-anchor="center" font-family="Arial" fonten="Arial" font-size="12" sh="16" cst="0" /></g></g></g></g>`
          );
        } else {
          const symId = `WinOpBtn_${seq}`;
          const hwkey = `${symId}_${seq}`;
          const targetWinDbId = screenNameToWinDbId.get(navTarget);
          const navFun = isHomeNav ? 'show_fst_pic' : 'show_spef_pic';
          const navPicAttr = isHomeNav
            ? 'Pic=""'
            : `Pic="${xmlEsc(navTarget)}"${targetWinDbId !== undefined ? ` Pic-id="${targetWinDbId}"` : ''}`;
          registerTextOnlyRecord(
            'WinOpBtn',
            symId,
            hwkey,
            grp.groupId,
            { '0': symbolLibs.get(grp.stateIds['0'])!.md5 },
            '',
            navTxtColor,
            12,
            true,
            'st',
            [],
            'btn214',
            seq
          );
          svgElements.push(
            `<g transform="matrix(${sx},0,0,${sy},${w.x},${w.y})" hw-PowerTime="10" sym-type="WinOpBtn" v="0.1" id="${symId}" hwkey="${hwkey}" Fun="${navFun}" ${navPicAttr} SubPic="" IsPrintHidden="false" ActnEff="false" WhthCnfrmBox="false" ActnLock="false" StCt="1"><hwsymbol id="${hwkey}" newsym="true" defGId="btn214" title="Picture operation button" name="WinOpBtn" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="6" ry="6" width="100" height="100" stroke="#0F172A" stroke-width="2" fill="${bgHex}" /></g></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="${navTxtColor}" text-anchor="center" font-family="Arial" fonten="Arial" font-size="12" sh="16" cst="0" /></g></g></g></g>`
          );
        }
        const navLabelW = Math.max(24, w.width - 12);
        const prefNavSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12;
        addTxtBlock(w.x + 6, w.y + Math.max(4, Math.round(w.height / 2) - 11), navLabelW, 22, w.label, {
          color: navTxtColor,
          fontSize: fitFontSizeToWidth(w.label, navLabelW, prefNavSize, 8, true),
          bold: true,
          align: 'center',
          bg: bgHex,
        });
        continue;
      }

      // 13. MULTI_STATE_INDICATOR -> Live RdVar-bound status pill (NumShowIput / TxtShowIput)
      if (w.type === 'MULTI_STATE_INDICATOR') {
        const cardCols = getRoleCardColors(w.visualRole, screenTheme);
        const pillBg = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? '#1E293B';
        const pillFg = pickReadableTextColor(pillBg, typeof w.props?.color === 'string' ? w.props.color : '#F8FAFC', 3.0);
        const lblColor = pickReadableTextColor(surface.surfaceBg, typeof w.props?.labelColor === 'string' ? w.props.labelColor : surface.secondaryTextColor, 3.0);
        const labelH = Math.min(18, Math.max(14, Math.floor(w.height * 0.35)));
        const pillY = w.y + labelH;
        const pillH = Math.max(20, w.height - labelH);
        const prefLabelSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
        addTxtBlock(w.x + 2, w.y, Math.max(30, w.width - 4), labelH, w.label, {
          color: lblColor,
          fontSize: fitFontSizeToWidth(w.label, Math.max(30, w.width - 4), prefLabelSize, 8, true),
          bold: true,
          align: 'left',
          bg: surface.surfaceBg,
        });

        const isString = bound?.tag.dataType === 'STRING';
        const seq = nextSymDbId++;
        const symType = isString ? 'TxtShowIput' : 'NumShowIput';
        const symId = `${symType}_${seq}`;
        const hwkey = `${symId}_${seq}`;
        const stateText = bound ? String(bound.tag.currentValue) : '0';
        const heightCapped = Math.max(8, Math.min(12, Math.floor((pillH - 4) * 0.68)));
        const pillFontSize = fitFontSizeToWidth(stateText, Math.max(24, w.width - 8), heightCapped, 8, true);
        const btn226 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['btn226_0'];
        const grp = ensureSvgGroup(`btn226_${pillBg.replace('#', '')}`, [
          {
            stateKey: '0',
            symbolId: `btn226_${pillBg.replace('#', '')}_0`,
            color: pillBg,
            symbolXml: btn226.symbolXml.replace(/#C7E1F0/gi, pillBg),
          },
        ]);
        const bindings = bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [];
        registerTextOnlyRecord(
          symType,
          symId,
          hwkey,
          grp.groupId,
          { '0': symbolLibs.get(grp.stateIds['0'])!.md5 },
          stateText,
          pillFg,
          pillFontSize,
          true,
          'at',
          bindings,
          'btn226',
          seq
        );
        const numExtras = `PGEnbl="false" Gain="1" Ofst="0" ActnLock="false" LockMode="var" LockLogic="off" LockStyle="show" ThldEnbl="false" ThldIsVar="false" ThldMaxNum="80" ThldMinNum="20" UpLmtColor="red" LowLmtColor="yellow" WrngTxtEnbl="false" UpLmtTxt="" LowLmtTxt="" IsNoticeEnable="false" NoticeOrderType="before" NoticeType="bit" ActionType="sw" NumVarValue="1" MaxVar="" MinVar="" LockVar="" ThldMaxVar="" ThldMinVar="" NoticeBitVar="" NoticeNumVar=""`;
        const attrs = bound
          ? isString
            ? `IsIput="false" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="${pillFg}" HWBackColor="${pillBg}" StCt="1" RdVar="${xmlEsc(bound.fullName)}" WrtVar="" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
            : `SignDisp="true" IsPwdDisp="false" KilobitDisp="false" IsIput="false" ShowLeftTag="false" ShowRightTag="false" DifVar="false" LeftTag="" RightTag="" NumHex="10" IntNum="6" DcmPls="0" HwLimit="num" IputMaxVal="65535" MaxValConvert="65535" IputMinVal="0" MinValConvert="0" Font="" TxtAlign="center" TxtColor="${pillFg}" HWBackColor="${pillBg}" StCt="1" ${numExtras} RdVar="${xmlEsc(bound.fullName)}" WrtVar="" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `SignDisp="true" IsIput="false" DcmPls="0" HwLimit="num" IputMaxVal="65535" MaxValConvert="65535" IputMinVal="0" MinValConvert="0" TxtAlign="center" TxtColor="${pillFg}" HWBackColor="${pillBg}" StCt="1" ${numExtras} RdVar=""`;
        svgElements.push(
          `<g transform="matrix(1,0,0,1,${w.x},${pillY})" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${attrs}><hwsymbol id="${hwkey}" newsym="true" defGId="btn226" title="State indicator" name="${symType}" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="4" ry="4" width="${w.width}" height="${pillH}" stroke="${cardCols.border}" stroke-width="1.5" fill="${pillBg}" /></g></g><g sign="text"><textBlock localid="at" x="0" y="0" width="${w.width}" height="${pillH}" fill="none" stroke="none" text-color="${pillFg}" text-anchor="center" vertical-align="milldle" font-family="Arial" fonten="Arial" font-size="${pillFontSize}" sh="${(pillFontSize * 1.33).toFixed(2)}" font-weight="bold" cst="0">${xmlEsc(stateText)}</textBlock></g></g></g></g>`
        );
        continue;
      }

      // 14. RECIPE_SELECTOR -> Framed recipe control panel
      if (w.type === 'RECIPE_SELECTOR') {
        const hdrH = Math.min(24, Math.max(18, Math.floor(w.height * 0.35)));
        addFlatRectShape(w.x, w.y, w.width, w.height, screenTheme.cardBg, screenTheme.cardBorder, 4);
        addFlatRectShape(w.x, w.y, w.width, hdrH, screenTheme.panelHeaderBg, screenTheme.cardBorder, 4);
        addTxtBlock(w.x + 8, w.y + Math.max(2, Math.round((hdrH - 16) / 2)), Math.max(30, w.width - 16), 16, w.label, {
          color: screenTheme.panelHeaderText,
          fontSize: fitFontSizeToWidth(w.label, Math.max(30, w.width - 16), 11, 8, true),
          bold: true,
          align: 'left',
          bg: screenTheme.panelHeaderBg,
        });
        const recVal = bound ? String(bound.tag.currentValue) : 'Select Recipe';
        addTxtBlock(w.x + 8, w.y + hdrH + Math.max(4, Math.round((w.height - hdrH - 18) / 2)), Math.max(30, w.width - 16), 18, recVal, {
          color: pickReadableTextColor(screenTheme.cardBg, screenTheme.textPrimary),
          fontSize: fitFontSizeToWidth(recVal, Math.max(30, w.width - 16), 12, 8, true),
          bold: false,
          align: 'left',
          bg: screenTheme.cardBg,
        });
        continue;
      }

      // 15. CAMERA_VIEW -> Dark viewport frame with live camera caption
      if (w.type === 'CAMERA_VIEW') {
        addFlatRectShape(w.x, w.y, w.width, w.height, '#0F172A', '#334155', 4);
        addTxtBlock(w.x + 10, w.y + 8, Math.max(40, w.width - 20), 18, w.label, {
          color: '#F8FAFC',
          fontSize: fitFontSizeToWidth(w.label, Math.max(40, w.width - 20), 11, 8, true),
          bold: true,
          align: 'left',
          bg: '#0F172A',
        });
        const camHint = 'LIVE VIDEO STREAM';
        addTxtBlock(w.x + 10, w.y + Math.round(w.height / 2) - 9, Math.max(40, w.width - 20), 18, camHint, {
          color: '#94A3B8',
          fontSize: fitFontSizeToWidth(camHint, Math.max(40, w.width - 20), 11, 8, true),
          bold: false,
          align: 'center',
          bg: '#0F172A',
        });
        continue;
      }

      // 16. FACEPLATE_INSTANCE -> Bordered composite faceplate frame
      if (w.type === 'FACEPLATE_INSTANCE') {
        const hdrH = Math.min(24, Math.max(18, Math.floor(w.height * 0.25)));
        addFlatRectShape(w.x, w.y, w.width, w.height, screenTheme.cardBg, screenTheme.accentPrimary, 4);
        addFlatRectShape(w.x, w.y, w.width, hdrH, screenTheme.darkHeaderBg, screenTheme.darkHeaderBorder, 4);
        addTxtBlock(w.x + 8, w.y + Math.max(2, Math.round((hdrH - 16) / 2)), Math.max(30, w.width - 16), 16, w.label, {
          color: screenTheme.darkHeaderText,
          fontSize: fitFontSizeToWidth(w.label, Math.max(30, w.width - 16), 11, 8, true),
          bold: true,
          align: 'left',
          bg: screenTheme.darkHeaderBg,
        });
        continue;
      }

      // 17. PIPELINE widget -> Solid pipe segment instead of numeric input box
      if (w.type === 'PIPELINE') {
        addFlatRectShape(w.x, w.y, w.width, w.height, '#94A3B8', '#334155', 2);
        if (w.label && w.width >= 40 && w.height >= 16) {
          addTxtBlock(w.x + 4, w.y + Math.max(0, Math.round((w.height - 14) / 2)), Math.max(24, w.width - 8), 14, w.label, {
            color: '#0F172A',
            fontSize: fitFontSizeToWidth(w.label, Math.max(24, w.width - 8), 9, 8, true),
            bold: true,
            align: 'center',
            bg: '#94A3B8',
          });
        }
        continue;
      }

      // 18. NUMERIC_DISPLAY / NUMERIC_INPUT -> Unstretched 1:1 NumShowIput / TxtShowIput with complete WrtVar-id
      const isString = bound?.tag.dataType === 'STRING';
      const isInput = w.type === 'NUMERIC_INPUT';
      const decimals = w.precision ?? (bound?.tag.dataType === 'FLOAT32' ? 1 : 0);
      const unitStr = w.unit ?? bound?.tag.unit ?? '';
      const labelH = 18;
      const boxY = w.y + labelH;
      const boxH = Math.max(24, w.height - labelH);
      const labelColor = pickReadableTextColor(
        surface.surfaceBg,
        typeof w.props?.labelColor === 'string' ? w.props.labelColor : surface.secondaryTextColor,
        3.0
      );
      const prefLabelSize = typeof w.props?.fontSize === 'number' ? w.props.fontSize : 10;
      addTxtBlock(w.x + 2, w.y, Math.max(36, w.width - 4), labelH, w.label, {
        color: labelColor,
        fontSize: fitFontSizeToWidth(w.label, Math.max(36, w.width - 4), prefLabelSize, 8, true),
        bold: true,
        align: 'left',
        bg: surface.surfaceBg,
      });

      const seq = nextSymDbId++;
      const symType = isString ? 'TxtShowIput' : 'NumShowIput';
      const symId = `${symType}_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const cardCols = getRoleCardColors(w.visualRole, screenTheme);
      const cardFill = normalizeHexColor(typeof w.props?.backgroundColor === 'string' ? w.props.backgroundColor : undefined) ?? cardCols.fill;
      const cardBorder = cardCols.border;
      const valueColor = pickReadableTextColor(
        cardFill,
        typeof w.props?.color === 'string' ? w.props.color : cardCols.valueColor,
        3.0
      );
      const prefValSize = w.visualRole === 'KPI_HERO' ? 14 : 12;
      const heightCappedValSize = Math.max(8, Math.min(prefValSize, Math.floor((boxH - 4) * 0.68)));
      const sampleValStr = isString ? '---' : `0000${unitStr ? ` ${unitStr}` : ''}`;
      const valFontSize = fitFontSizeToWidth(sampleValStr, Math.max(24, w.width - 10), heightCappedValSize, 8, true);
      const btn226 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['btn226_0'];
      const grp = ensureSvgGroup(`btn226_${cardFill.replace('#', '')}`, [
        {
          stateKey: '0',
          symbolId: `btn226_${cardFill.replace('#', '')}_0`,
          color: cardFill,
          symbolXml: btn226.symbolXml.replace(/#C7E1F0/gi, cardFill),
        },
      ]);
      const bindings = bound
        ? isInput
          ? [
              { propName: 'RdVar-id', varId: bound.varId },
              { propName: 'WrtVar-id', varId: bound.varId },
            ]
          : [{ propName: 'RdVar-id', varId: bound.varId }]
        : [];
      registerTextOnlyRecord(
        symType,
        symId,
        hwkey,
        grp.groupId,
        { '0': symbolLibs.get(grp.stateIds['0'])!.md5 },
        isString ? '---' : `0${unitStr ? ` ${unitStr}` : ''}`,
        valueColor,
        valFontSize,
        true,
        'at',
        bindings,
        'btn226',
        seq
      );
      const numMin = w.min ?? (bound?.tag.dataType === 'UINT16' || bound?.tag.dataType === 'UINT32' ? 0 : -32768);
      const rawNumMax = w.max ?? (bound?.tag.dataType === 'UINT16' || bound?.tag.dataType === 'UINT32' ? 65535 : 32767);
      const numMax = rawNumMax > numMin ? rawNumMax : numMin + 100;
      const numCommonExtras = `PGEnbl="false" Gain="1" Ofst="0" ActnLock="false" LockMode="var" LockLogic="off" LockStyle="show" ThldEnbl="false" ThldIsVar="false" ThldMaxNum="80" ThldMinNum="20" UpLmtColor="red" LowLmtColor="yellow" WrngTxtEnbl="false" UpLmtTxt="" LowLmtTxt="" IsNoticeEnable="false" NoticeOrderType="before" NoticeType="bit" ActionType="sw" NumVarValue="1" MaxVar="" MinVar="" LockVar="" ThldMaxVar="" ThldMinVar="" NoticeBitVar="" NoticeNumVar=""`;
      const attrs = bound
        ? isString
          ? `IsIput="${isInput}" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="${valueColor}" HWBackColor="${cardFill}" StCt="1" RdVar="${xmlEsc(bound.fullName)}" WrtVar="${isInput ? xmlEsc(bound.fullName) : ''}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"${isInput ? ` WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"` : ''}`
          : `SignDisp="true" IsPwdDisp="false" KilobitDisp="false" IsIput="${isInput}" ShowLeftTag="false" ShowRightTag="${Boolean(unitStr)}" DifVar="false" LeftTag="" RightTag="${xmlEsc(unitStr)}" NumHex="10" IntNum="6" DcmPls="${decimals}" HwLimit="num" IputMaxVal="${numMax}" MaxValConvert="${numMax}" IputMinVal="${numMin}" MinValConvert="${numMin}" Font="" TxtAlign="center" TxtColor="${valueColor}" HWBackColor="${cardFill}" StCt="1" ${numCommonExtras} RdVar="${xmlEsc(bound.fullName)}" WrtVar="${isInput ? xmlEsc(bound.fullName) : ''}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"${isInput ? ` WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"` : ''}`
        : `SignDisp="true" IsIput="false" DcmPls="${decimals}" HwLimit="num" IputMaxVal="${numMax}" MaxValConvert="${numMax}" IputMinVal="${numMin}" MinValConvert="${numMin}" TxtAlign="center" TxtColor="${valueColor}" HWBackColor="${cardFill}" StCt="1" ${numCommonExtras} RdVar=""`;
      // Use identity 1:1 matrix with explicit pixel width/height so font glyphs are never non-uniformly stretched
      svgElements.push(
        `<g transform="matrix(1,0,0,1,${w.x},${boxY})" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${attrs}><hwsymbol id="${hwkey}" newsym="true" defGId="btn226" title="Numeric input/display" name="${symType}" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="4" ry="4" width="${w.width}" height="${boxH}" stroke="${cardBorder}" stroke-width="1.5" fill="${cardFill}" /></g></g><g sign="text"><textBlock localid="at" x="0" y="0" width="${w.width}" height="${boxH}" fill="none" stroke="none" text-color="${valueColor}" text-anchor="center" vertical-align="milldle" font-family="Arial" fonten="Arial" font-size="${valFontSize}" sh="${(valFontSize * 1.33).toFixed(2)}" font-weight="bold" cst="0">${isString ? '---' : `0${unitStr ? ` ${xmlEsc(unitStr)}` : ''}`}</textBlock></g></g></g></g>`
      );
    }

    const rawSvg = `<svg width="${screen.width}" height="${screen.height}" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:PerfectSVG="http://www.perfectsvg.com/PerfectSVG" xml:space="preserve" lngtag="${lang}" isupdate="false" xmlns="http://www.w3.org/2000/svg"><defs><marker viewBox="0 0 3 3" refX="4.5" refY="0" overflow="visible" id="arrow2" fillShadow="true" fill="#000000" orient="auto" markerUnits="strokeWidth"><path stroke-width="0.22" d="M 2 1 L 0 0 L 2 -1 L 2 1 " transform="scale(4.5) " /></marker></defs>${svgElements.join('')}</svg>`;

    winAndDocXmlParts.push(`      <SerializableDictionary>
        <key>
          <string>${xmlEsc(screen.name)}</string>
        </key>
        <value>
          <WindowAndDocumentModel>
            <Window>
              <ID>${winDbId}</ID>
              <Name>${xmlEsc(screen.name)}</Name>
              <Memo />
              <ClassifyId>0</ClassifyId>
              <HwSys>0</HwSys>
              <WindowID>${windowId}</WindowID>
              <OrderId>${scrIdx}</OrderId>
              <IsSubWindow>${screen.isPopup ? 1 : 0}</IsSubWindow>
              <Width>${screen.width}</Width>
              <Height>${screen.height}</Height>
              <CanvasColor>${xmlEsc(screenBg)}</CanvasColor>
              <CanvasBackground />
              <DockType />
              <PutDock>0</PutDock>
              <UserGroupId>0</UserGroupId>
              <UseProtectPassword>0</UseProtectPassword>
              <Disable>0</Disable>
              <AlwaysCache>1</AlwaysCache>
              <DocumentId>${docDbId}</DocumentId>
              <OnlyService>0</OnlyService>
              <UsingVariables>${Array.from(usedVarIds).join(',')}</UsingVariables>
              <DisplayOpacity>100</DisplayOpacity>
              <FillOpacity>0</FillOpacity>
              <DisplayBlur>0</DisplayBlur>
              <NavWinIndex xsi:nil="true" />
              <NavRowCount>1</NavRowCount>
              <NavColumnCount>1</NavColumnCount>
              <NavHorizontalSpacing>1</NavHorizontalSpacing>
              <NavVerticalSpacing>1</NavVerticalSpacing>
              <NavEnablePage>0</NavEnablePage>
              <ScreenRadius>0</ScreenRadius>
              <NavIconRadius>30</NavIconRadius>
              <EnableAddToNavWin>0</EnableAddToNavWin>
              <TopPublicWindowId>0</TopPublicWindowId>
              <EnablePublicWindow>0</EnablePublicWindow>
            </Window>
            <WindowDocument>
              <ID>${docDbId}</ID>
              <ClassifyId>0</ClassifyId>
              <HwSys>0</HwSys>
              <Document>${xmlEsc(rawSvg)}</Document>
              <ThumbImage />
              <CanvasBackground />
            </WindowDocument>
          </WindowAndDocumentModel>
        </value>
      </SerializableDictionary>`);
  });

  const dicFontUseXml = symRecords
    .map(
      (s, idx) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(s.hwkey)}</string>
        </key>
        <value>
          <ArrayOfProjectFontUse>
            <projectFontUse>
              <ID>${3000 + idx}</ID>
              <ClassifyId>0</ClassifyId>
              <FontName>Arial</FontName>
              <Language>${lang}</Language>
              <UseID>${s.winId}</UseID>
              <UseType>2</UseType>
              <SymbolHwkey>${xmlEsc(s.hwkey)}</SymbolHwkey>
              <SymbolPropName>StCt_0</SymbolPropName>
              <SymbolTextLocalId>${s.textLocalId}</SymbolTextLocalId>
            </projectFontUse>
          </ArrayOfProjectFontUse>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymXml = symRecords
    .map((s) => {
      const varUsingXml =
        s.varBindings.length > 0
          ? `\n            <SymbolVariableUsing>${xmlEsc(
              JSON.stringify(
                s.varBindings.map((vb) => ({
                  PropName: vb.propName,
                  VariableID: vb.varId,
                  IsCollection: false,
                  VariableList: null,
                }))
              )
            )}</SymbolVariableUsing>`
          : '';
      return `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(s.hwkey)}</string>
        </key>
        <value>
          <ProjectSymbol>
            <ID>${s.id}</ID>
            <Name>${xmlEsc(s.name)}</Name>
            <ClassifyId>0</ClassifyId>
            <SymbolName>${xmlEsc(s.symbolName)}</SymbolName>
            <Hwkey>${xmlEsc(s.hwkey)}</Hwkey>
            <SymbolGroupId>${xmlEsc(s.groupId)}</SymbolGroupId>
            <WinId>${s.winId}</WinId>
            <SymbolGroupDisplayConfig />
            <SymbolStateMd5Config>${xmlEsc(s.md5Config)}</SymbolStateMd5Config>
            <SymbolStateTextConfig>${xmlEsc(s.textConfig)}</SymbolStateTextConfig>
            <IsSingle>0</IsSingle>
            <DefaultGroupId>${xmlEsc(s.defaultGroupId)}</DefaultGroupId>
            <StateCount>${s.stateCount}</StateCount>${varUsingXml}
            <IsPublicWindow>0</IsPublicWindow>
          </ProjectSymbol>
        </value>
      </SerializableDictionary>`;
    })
    .join('\n');

  const dicSymGrpLibXml = Array.from(symbolGroups.values())
    .map(
      (g, idx) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(g.groupId)}</string>
        </key>
        <value>
          <ProjectSymbolGroupLibrary>
            <ID>${idx + 1}</ID>
            <ClassifyId>0</ClassifyId>
            <SymbolGroupId>${xmlEsc(g.groupId)}</SymbolGroupId>
            <GroupConfig>${xmlEsc(JSON.stringify(g.stateIds))}</GroupConfig>
            <DefaultDisplaySetting>${
              g.symbolType === 'image'
                ? '{}'
                : xmlEsc(
                    JSON.stringify(
                      Object.fromEntries(Object.entries(g.colors).map(([k, v]) => [k, { HWBackColor: v }]))
                    )
                  )
            }</DefaultDisplaySetting>
            <StateCount>${Object.keys(g.stateIds).length}</StateCount>
            <SymbolType>${g.symbolType}</SymbolType>
          </ProjectSymbolGroupLibrary>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymLibXml = Array.from(symbolLibs.values())
    .map(
      (lib, idx) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(lib.symbolId)}</string>
        </key>
        <value>
          <ProjectSymbolLibrary>
            <ID>${idx + 1}</ID>
            <ClassifyId>0</ClassifyId>
            <SymbolId>${xmlEsc(lib.symbolId)}</SymbolId>
            <SymbolType>${lib.symbolType}</SymbolType>
            <PicMd5>${lib.md5}</PicMd5>${lib.symbolType === 'svg' && lib.symbolXml ? `\n            <SymbolXml>${xmlEsc(lib.symbolXml)}</SymbolXml>` : ''}
          </ProjectSymbolLibrary>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymTxtXml = symRecords
    .map(
      (s, idx) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(s.hwkey)}</string>
        </key>
        <value>
          <ArrayOfProjectSymbolText>
            <ProjectSymbolText>
              <ID>${2000 + idx}</ID>
              <ClassifyId>0</ClassifyId>
              <Hwkey>${xmlEsc(s.hwkey)}</Hwkey>
              <Language>${lang}</Language>
              <ContentConfig>${xmlEsc(s.textContent)}</ContentConfig>
              <WinId>${s.winId}</WinId>
              <TextLocalId>${s.textLocalId}</TextLocalId>
              <IsPublicWindow>0</IsPublicWindow>
            </ProjectSymbolText>
          </ArrayOfProjectSymbolText>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymPicXml = Array.from(pictures.values())
    .map(
      (p) => `      <SerializableDictionary>
        <key>
          <string>${p.md5}</string>
        </key>
        <value>
          <windowDocumentPicture>
            <ID>${p.id}</ID>
            <ClassifyId>0</ClassifyId>
            <HwSys>0</HwSys>
            <PicMd5>${p.md5}</PicMd5>
            <PicPath />
            <PicFileName />
            <SourcePicture>${p.base64}</SourcePicture>
          </windowDocumentPicture>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicVarNameIdXml = Array.from(varIdByFullName.entries())
    .map(
      ([fullName, id]) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(fullName)}</string>
        </key>
        <value>
          <int>${id}</int>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicVarIdTypeXml = Array.from(varTypeById.entries())
    .map(
      ([id, dt]) => `      <SerializableDictionary>
        <key>
          <int>${id}</int>
        </key>
        <value>
          <string>${xmlEsc(dt)}</string>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymVarInfoXml = symRecords
    .filter((s) => s.varBindings.length > 0)
    .map(
      (s) => `      <SerializableDictionary>
        <key>
          <string>${xmlEsc(s.hwkey)}</string>
        </key>
        <value>
          <ArrayOfSymbolVariableInfo>
${s.varBindings
  .map(
    (vb) => `            <SymbolVariableInfo>
              <PropName>${xmlEsc(vb.propName)}</PropName>
              <VariableID>${vb.varId}</VariableID>
              <IsCollection>false</IsCollection>
            </SymbolVariableInfo>`
  )
  .join('\n')}
          </ArrayOfSymbolVariableInfo>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const dicSymWinIdXml = targetScreens
    .map(
      (_s, idx) => `      <SerializableDictionary>
        <key>
          <int>${100 + idx}</int>
        </key>
        <value>
          <int>${startWindowId + idx}</int>
        </value>
      </SerializableDictionary>`
    )
    .join('\n');

  const tasksXml =
    options.exportTasks && options.exportTasks.length > 0
      ? `  <Tasks>
    <ListTask>
${options.exportTasks
  .map(
    (t, idx) => `      <HwExportTaskModel>
        <Task>
          <ID>${idx + 1}</ID>
          <HwSys>0</HwSys>
          <Name>${xmlEsc(t.name)}</Name>
          <Type>SCRIPT</Type>
          <Memo>${xmlEsc(t.memo ?? '')}</Memo>
          <IsAutoCreate>0</IsAutoCreate>
          <OrderId>${idx + 1}</OrderId>
          <ContentId>${idx + 1}</ContentId>
          <ClassifyId>0</ClassifyId>
        </Task>
        <TaskDocument>
          <ID>${idx + 1}</ID>
          <HwSys>0</HwSys>
          <Config />
          <Script>${xmlEsc(t.script)}</Script>
          <CompileScript>${xmlEsc(t.script)}</CompileScript>
          <VariableId />
          <ClassifyId>0</ClassifyId>
        </TaskDocument>
      </HwExportTaskModel>`
  )
  .join('\n')}
    </ListTask>
  </Tasks>`
      : `  <Tasks>
    <ListTask />
  </Tasks>`;

  const varGroupsXml =
    options.exportVariableGroups && options.exportVariableGroups.length > 0
      ? `  <VariableGroups>
    <ListVariableGroup>
${options.exportVariableGroups
  .map(
    (vg, gIdx) => `      <HwExportVariableGroupModel>
        <VariableGroup>
          <ID>${gIdx + 10}</ID>
          <HwSys>0</HwSys>
          <Name>${xmlEsc(vg.groupName)}</Name>
          <Memo />
          <ClassifyId>0</ClassifyId>
        </VariableGroup>
        <ListVariable>
${vg.tags
  .map((t, tIdx) => {
    const dt = mapHaiwellVarType(t.dataType);
    const fullName = `${vg.groupName}.${t.name}`;
    const rawInit = (t as unknown as { initialValue?: unknown }).initialValue;
    let initVal: string;
    if (dt === 'BOOL') {
      if (rawInit === true || rawInit === 1 || String(rawInit).toLowerCase() === 'true' || String(rawInit) === '1') {
        initVal = '1';
      } else {
        initVal = '0';
      }
    } else if (dt === 'STRING') {
      initVal = rawInit !== undefined && rawInit !== null ? String(rawInit) : '';
    } else {
      const n = Number(rawInit);
      initVal = rawInit !== undefined && rawInit !== null && !Number.isNaN(n) ? String(n) : '0';
    }
    return `          <variable>
            <ID>${700 + gIdx * 100 + tIdx}</ID>
            <ClassifyId>0</ClassifyId>
            <HwSys>0</HwSys>
            <DevId>0</DevId>
            <Name>${xmlEsc(t.name)}</Name>
            <FullName>${xmlEsc(fullName)}</FullName>
            <DataType>${xmlEsc(dt)}</DataType>
            <StringCode>UTF8</StringCode>
            <StringLength>${dt === 'STRING' ? 128 : 0}</StringLength>
            <AddressReadWrite>${t.access === 'RO' ? 'r' : 'rw'}</AddressReadWrite>
            <GroupId>${gIdx + 10}</GroupId>
            <Memo>${xmlEsc(t.description ?? '')}</Memo>
            <InitValue>${xmlEsc(initVal)}</InitValue>
            <SaveValue>0</SaveValue>
            <Disable>0</Disable>
            <IsInvalid>0</IsInvalid>
          </variable>`;
  })
  .join('\n')}
        </ListVariable>
      </HwExportVariableGroupModel>`
  )
  .join('\n')}
    </ListVariableGroup>
  </VariableGroups>`
      : `  <VariableGroups>
    <ListVariableGroup />
  </VariableGroups>`;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<HwExportModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Windows>
    <Versions>3</Versions>
    <DicWinAndDoc>
${winAndDocXmlParts.join('\n')}
    </DicWinAndDoc>
    <DicFontUse>
${dicFontUseXml}
    </DicFontUse>
    <DicSym>
${dicSymXml}
    </DicSym>
    <DicSymPictures />
    <DicSymGrpLib>
${dicSymGrpLibXml}
    </DicSymGrpLib>
    <DicSymLib>
${dicSymLibXml}
    </DicSymLib>
    <DicSymTxt>
${dicSymTxtXml}
    </DicSymTxt>
    <DicSymPic>
${dicSymPicXml}
    </DicSymPic>
    <DicVarFunllNameAndID>
${dicVarNameIdXml}
    </DicVarFunllNameAndID>
    <DicVarIDAndDataType>
${dicVarIdTypeXml}
    </DicVarIDAndDataType>
    <DicSymVarInfo>
${dicSymVarInfoXml}
    </DicSymVarInfo>
    <DicSymbolWinIdAndWindowId>
${dicSymWinIdXml}
    </DicSymbolWinIdAndWindowId>
  </Windows>
${tasksXml}
  <Events>
    <ListEventModel />
  </Events>
  <Boms>
    <ListBom />
  </Boms>
  <Reports>
    <ListReport />
  </Reports>
${varGroupsXml}
  <UserGroups>
    <ListUserGroup />
    <ListUser />
    <DicAvatarPic />
  </UserGroups>
  <Users>
    <ListUser />
    <ListUserGroup />
    <DicAvatarPic />
  </Users>
  <EncryptCorpCode />
</HwExportModel>
`;

  const safeFileBase = (project.name || project.id).replace(/[^a-zA-Z0-9_-]+/g, '_');
  return {
    xml,
    fileName: `${safeFileBase}.hwExport`,
    screensExported: targetScreens.length,
    widgetsExported: totalWidgets,
    variablesBound: varIdByFullName.size,
    warnings,
  };
}
