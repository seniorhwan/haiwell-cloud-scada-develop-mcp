import { HAIWELL_NATIVE_SYMBOLS, type NativeSymbolBBox } from './haiwellNativeSymbols';
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
  targetScreens.forEach((s, idx) => {
    screenNameToWinDbId.set(s.name, nextWinDbId + idx);
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
      defaultGroupId = groupId
    ) => {
      const seq = nextSymDbId++;
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

      registerTextOnlyRecord(
        'TxtBlock',
        symId,
        hwkey,
        textGroup.groupId,
        { '0': ensurePic('#FFFFFF') },
        text,
        txtColor,
        fontSize,
        bold,
        'at'
      );

      svgElements.push(
        `<g transform="matrix(1,0,0,1,${x},${y})" hw-PowerTime="10" sym-type="TxtBlock" v="0.6" id="${symId}" hwkey="${hwkey}" TxtAlign="${align}" TxtColor="${txtColor}" IsResize="false" HWBackColor="${bg}" HWBackOpacity="${bgOp === 0 ? 0 : 100}" Blinking="false" SwCtrl="false" IsOFFCtrl="false" BlinkingTime="1000" IsTextToPicture="false" Txt="${xmlEsc(text)}" IsTextBlock="true" SwCtrlVar=""><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Text" title-en="Text" name="TxtBlock" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w}" height="${h}" fill="${bg}" stroke="none" text-color="${txtColor}" fill-opacity="${bgOp}" text-anchor="${align}" vertical-align="milldle" font-family="Arial" fonten="Arial" font-size="${fontSize}" sh="${(fontSize * 1.33).toFixed(2)}" wrap="nowrap" font-weight="${fontWeight}" font-style="normal" text-decoration="normal">${xmlEsc(text)}</textBlock></g></g></g></g>`
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
      registerTextOnlyRecord('Shape', symId, hwkey, textGroup.groupId, { '0': ensurePic(fillHex) }, '', '#0F172A', 12, false, 'st');
      svgElements.push(
        `<g transform="matrix(${(w / 100).toFixed(6)},0,0,${(h / 100).toFixed(6)},${x},${y})" hw-PowerTime="10" sym-type="Shape" v="0.2" id="${symId}" hwkey="${hwkey}" StCt="1" RemoteOperation="true"><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" title="Graphics" name="Shape" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="${rx}" ry="${rx}" width="100" height="100" stroke="${strokeHex}" stroke-width="1.5" fill="${fillHex}" /></g></g></g></g></g>`
      );
    };

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
        opts.varBindings ?? []
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
          addTxtBlock(Math.max(0, midX), Math.max(0, midY), 120, 18, pipe.label, {
            color: pipe.fluid === 'SIGNAL' ? '#1D4ED8' : '#334155',
            fontSize: 10,
            bold: true,
            align: 'center',
          });
        }
      }
    }

    for (const w of screen.widgets) {
      totalWidgets++;
      const bound = bindTag(w.tagName);
      if (bound) usedVarIds.add(bound.varId);

      // 1. GROUP_PANEL -> Razor-sharp ISA-101 flat card with dedicated 28px header strip
      if (w.type === 'GROUP_PANEL') {
        const isDark = w.props?.theme === 'dark';
        if (isDark) {
          addFlatRectShape(w.x, w.y, w.width, w.height, '#1E293B', '#0F172A', 2);
          if (w.label) {
            addTxtBlock(w.x + 14, w.y + Math.max(6, Math.round((w.height - 22) / 2)), Math.max(80, w.width - 28), 22, w.label, {
              color: '#F8FAFC',
              fontSize: 14,
              bold: true,
              align: 'left',
            });
          }
        } else {
          addFlatRectShape(w.x, w.y, w.width, w.height, '#FFFFFF', '#CBD5E1', 2);
          const hdrH = Math.min(28, Math.max(22, Math.round(w.height * 0.12)));
          addFlatRectShape(w.x, w.y, w.width, hdrH, '#E2E8F0', '#CBD5E1', 2);
          if (w.label) {
            addTxtBlock(w.x + 10, w.y + Math.round((hdrH - 18) / 2), Math.max(80, w.width - 20), 18, w.label, {
              color: '#0F172A',
              fontSize: 11,
              bold: true,
              align: 'left',
            });
          }
        }
        continue;
      }

      // 2. LABEL (or HWClock4 live digital clock)
      if (w.type === 'LABEL') {
        if (w.props?.nativeSymbol === 'HWClock4') {
          const seq = nextSymDbId++;
          const symId = `Clock4_${seq}`;
          const hwkey = `HWClock4_${seq}_${seq}`;
          registerTextOnlyRecord('HWClock4', symId, hwkey, textGroup.groupId, { '0': ensurePic('#1E293B') }, '00:00:00', '#38BDF8', 13, true, 'at');
          svgElements.push(
            `<g transform="matrix(1,0,0,1,${w.x},${w.y})" hw-PowerTime="10" sym-type="HWClock4" v="0.3" id="${symId}" hwkey="${hwkey}" Font="" TxtColor="#38BDF8" HWBackColor="#1E293B" HWBackOpacity="100" IsTextBlock="true" DateEnable="true" DataType="7" DataSign="/" WeekEnable="false" TimeEnable="true"><hwsymbol ChangeToPicture="true" id="${hwkey}" newSym="true" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Clock" name="HWClock4" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w.width}" height="${w.height}" fill="#1E293B" fill-opacity="0" stroke="none" text-color="#38BDF8" text-anchor="right" font-family="Arial" fonten="Arial" font-size="13" sh="17.3" font-weight="bold" wrap="nowrap">2026/11/25 21:45</textBlock></g></g></g></g>`
          );
        } else {
          addTxtBlock(w.x, w.y, w.width, w.height, w.label, {
            color: typeof w.props?.color === 'string' ? w.props.color : '#0F172A',
            fontSize: typeof w.props?.fontSize === 'number' ? w.props.fontSize : 12,
            bold: w.props?.bold !== false,
            align: (w.props?.align as 'left' | 'center' | 'right') ?? 'left',
          });
        }
        continue;
      }

      // 3. BIT_BUTTON -> Native Haiwell <SymbolType>image</SymbolType> BitSw with 96x96 3D pushbutton PNG
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
        const size = Math.min(w.width, Math.max(40, w.height - 20));
        const bx = w.x + (w.width - size) / 2;
        const by = w.y;
        const sx = (size / 100).toFixed(6);
        const sy = (size / 100).toFixed(6);
        const wrtAttrs = bound
          ? `WrtVar="${xmlEsc(bound.fullName)}" WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"`
          : `WrtVar=""`;
        const txtCfg = buildTwoStateTextConfig(lang, pal.text, 10, true);

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
          textColor: pal.text,
          fontSize: 10,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'WrtVar-id', varId: bound.varId }] : [],
        });

        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${bx.toFixed(2)},${by.toFixed(2)})" hw-PowerTime="10" sym-type="BitSw" v="0.1" id="${symId}" hwkey="${hwkey}" RvrsSt="false" DifVar="false" ActnLock="false" LockMode="var" LockExpress-Express="" LockExpress-Enable="false" LockLogic="off" LockStyle="show" StCt="2" ActnType="sw" ActnEff="false" WhthCnfrmBox="false" CnfrmType="all" UseMiniTime="false" MiniTime="3.0" UseDisplayTime="true" DisplayLocal="up_down" IsNoticeEnable="false" NoticeOrderType="before" NoticeType="bit" ActionType="sw" NumVarValue="1" ${wrtAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="sw006" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit switch" title-en="Bit switch" name="BitSw" /><g><g sign="state"><g sign="svg"><image localid="si" x="0" y="0" width="100" height="100" md5file="${png0.md5}" newsym="true" /></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" font-weight="normal" font-style="normal" text-decoration="normal" cst="0" /></g></g></g></g>`
        );
        addTxtBlock(w.x, w.y + size + 2, w.width, 18, w.label, {
          color: '#0F172A',
          fontSize: 10,
          bold: true,
          align: 'center',
        });
        continue;
      }

      // 4. BIT_LAMP -> Native Haiwell <SymbolType>image</SymbolType> BitLamp with 96x96 3D pilot LED PNG
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
        const horizontal = w.width >= w.height * 2.0;
        const ledSize = horizontal ? Math.min(28, w.height - 4) : Math.min(34, w.width, Math.max(24, w.height - 20));
        const lx = horizontal ? w.x + 2 : w.x + (w.width - ledSize) / 2;
        const ly = horizontal ? w.y + (w.height - ledSize) / 2 : w.y;
        const sx = (ledSize / 100).toFixed(6);
        const sy = (ledSize / 100).toFixed(6);
        const rdAttrs = bound
          ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `RdVar=""`;
        const txtCfg = buildTwoStateTextConfig(lang, '#0F172A', 10, true);

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
          textColor: '#0F172A',
          fontSize: 10,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
        });

        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${lx.toFixed(2)},${ly.toFixed(2)})" hw-PowerTime="10" sym-type="BitLamp" v="0.4" id="${symId}" hwkey="${hwkey}" RvrsSt="false" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" EnblExps="" ${rdAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="lamp013" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit lamp" title-en="Bit lamp" name="BitLamp" /><g><g sign="state"><g sign="svg"><image localid="si" x="0" y="0" width="100" height="100" md5file="${png0.md5}" newsym="true" /></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" font-weight="normal" font-style="normal" text-decoration="normal" cst="0" /></g></g></g></g>`
        );

        if (horizontal) {
          addTxtBlock(w.x + ledSize + 8, w.y + Math.round((w.height - 18) / 2), Math.max(40, w.width - ledSize - 10), 18, w.label, {
            color: w.props?.labelColor ? String(w.props.labelColor) : '#0F172A',
            fontSize: 11,
            bold: true,
            align: 'left',
          });
        } else {
          addTxtBlock(w.x, w.y + ledSize + 2, w.width, 18, w.label, {
            color: w.props?.labelColor ? String(w.props.labelColor) : '#0F172A',
            fontSize: 10,
            bold: true,
            align: 'center',
          });
        }
        continue;
      }

      // 5. GAUGE -> Real Haiwell HWIstrument3 circular dial gauge
      if (w.type === 'GAUGE') {
        const headerH = 18;
        addTxtBlock(w.x, w.y, w.width, headerH, `${w.label}${w.unit ? ` (${w.unit})` : ''}`, {
          color: '#1E293B',
          fontSize: 11,
          bold: true,
          align: 'center',
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
        addTxtBlock(w.x, w.y, w.width, headerH, `${w.label}${w.unit ? ` (${w.unit})` : ''}`, {
          color: '#1E293B',
          fontSize: 11,
          bold: true,
          align: 'center',
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

      // 11. STATION / ACTUATOR / PUMP / VALVE / TANK -> Crisp ISA-101 Station Card + Native Machinery Symbol
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
          addFlatRectShape(w.x, w.y, w.width, w.height, '#FFFFFF', '#94A3B8', 2);
          addFlatRectShape(w.x, w.y, w.width, 28, '#334155', '#1E293B', 2);
          addTxtBlock(w.x + 8, w.y + 5, Math.max(60, w.width - 16), 18, w.label, {
            color: '#F8FAFC',
            fontSize: 11,
            bold: true,
            align: 'center',
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

      // 12. NAV_BAR -> Real Haiwell WinOpBtn (btn214)
      if (w.type === 'NAV_BAR') {
        const firstScreenName = targetScreens[0]?.name ?? 'Main_display';
        const navTarget =
          (typeof w.props?.targetScreenName === 'string' && w.props.targetScreenName) ||
          (w.targetScreenId && targetScreens.find((s) => s.id === w.targetScreenId)?.name) ||
          firstScreenName;
        const activeNav = Boolean(w.props?.active);
        const bgHex = activeNav ? '#0284C7' : '#334155';
        const seq = nextSymDbId++;
        const symId = `WinOpBtn_${seq}`;
        const hwkey = `${symId}_${seq}`;
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
        const targetWinDbId = screenNameToWinDbId.get(navTarget);
        const navFun = isHomeNav ? 'show_fst_pic' : 'show_spef_pic';
        const navPicAttr = isHomeNav ? 'Pic=""' : `Pic="${xmlEsc(navTarget)}"${targetWinDbId !== undefined ? ` Pic-id="${targetWinDbId}"` : ''}`;
        registerTextOnlyRecord('WinOpBtn', symId, hwkey, grp.groupId, { '0': symbolLibs.get(grp.stateIds['0'])!.md5 }, '', '#FFFFFF', 12, true, 'st', [], 'btn214');
        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${w.x},${w.y})" hw-PowerTime="10" sym-type="WinOpBtn" v="0.1" id="${symId}" hwkey="${hwkey}" Fun="${navFun}" ${navPicAttr} SubPic="" IsPrintHidden="false" ActnEff="false" WhthCnfrmBox="false" ActnLock="false" StCt="1"><hwsymbol id="${hwkey}" newsym="true" defGId="btn214" title="Picture operation button" name="WinOpBtn" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="6" ry="6" width="100" height="100" stroke="#0F172A" stroke-width="2" fill="${bgHex}" /></g></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#FFFFFF" text-anchor="center" font-family="Arial" fonten="Arial" font-size="12" sh="16" cst="0" /></g></g></g></g>`
        );
        addTxtBlock(w.x + 6, w.y + Math.max(4, Math.round(w.height / 2) - 10), Math.max(30, w.width - 12), 20, w.label, {
          color: '#FFFFFF',
          fontSize: 11,
          bold: true,
          align: 'center',
        });
        continue;
      }

      // 13. NUMERIC_DISPLAY / NUMERIC_INPUT -> Real Haiwell NumShowIput (btn226) / TxtShowIput (btn212)
      const isString = bound?.tag.dataType === 'STRING';
      const isInput = w.type === 'NUMERIC_INPUT';
      const decimals = w.precision ?? (bound?.tag.dataType === 'FLOAT32' ? 1 : 0);
      const unitStr = w.unit ?? bound?.tag.unit ?? '';
      const labelH = 18;
      const boxY = w.y + labelH;
      const boxH = Math.max(24, w.height - labelH);
      addTxtBlock(w.x + 2, w.y, Math.max(40, w.width - 4), labelH, w.label, {
        color: '#334155',
        fontSize: 10,
        bold: true,
        align: 'left',
      });

      const seq = nextSymDbId++;
      const symType = isString ? 'TxtShowIput' : 'NumShowIput';
      const symId = `${symType}_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const cardFill = w.visualRole === 'KPI_HERO' ? '#EFF6FF' : w.visualRole === 'DANGER_ACTION' ? '#FEF2F2' : '#FFFFFF';
      const cardBorder = w.visualRole === 'KPI_HERO' ? '#2563EB' : w.visualRole === 'DANGER_ACTION' ? '#DC2626' : '#94A3B8';
      const btn226 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['btn226_0'];
      const grp = ensureSvgGroup(`btn226_${cardFill.replace('#', '')}`, [
        {
          stateKey: '0',
          symbolId: `btn226_${cardFill.replace('#', '')}_0`,
          color: cardFill,
          symbolXml: btn226.symbolXml.replace(/#C7E1F0/gi, cardFill),
        },
      ]);
      const sx = (w.width / 100).toFixed(6);
      const sy = (boxH / 100).toFixed(6);
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
        '#0F172A',
        w.visualRole === 'KPI_HERO' ? 14 : 12,
        true,
        'at',
        bindings,
        'btn226'
      );
      const attrs = bound
        ? isString
          ? `IsIput="false" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `SignDisp="true" IsPwdDisp="false" KilobitDisp="false" IsIput="${isInput}" ShowLeftTag="false" ShowRightTag="${Boolean(unitStr)}" DifVar="false" LeftTag="" RightTag="${xmlEsc(unitStr)}" NumHex="10" IntNum="6" DcmPls="${decimals}" HwLimit="num" IputMaxVal="${w.max ?? 32767}" IputMinVal="${w.min ?? -32768}" Font="" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" WrtVar="${isInput ? xmlEsc(bound.fullName) : ''}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
        : `SignDisp="true" IsIput="false" DcmPls="${decimals}" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar=""`;
      svgElements.push(
        `<g transform="matrix(${sx},0,0,${sy},${w.x},${boxY})" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${attrs}><hwsymbol id="${hwkey}" newsym="true" defGId="btn226" title="Numeric input/display" name="${symType}" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="4" ry="4" width="100" height="100" stroke="${cardBorder}" stroke-width="2" fill="${cardFill}" /></g></g><g sign="text"><textBlock localid="at" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#0F172A" text-anchor="center" font-family="Arial" fonten="Arial" font-size="${w.visualRole === 'KPI_HERO' ? 14 : 12}" sh="18" font-weight="bold" cst="0">${isString ? '---' : `0${unitStr ? ` ${xmlEsc(unitStr)}` : ''}`}</textBlock></g></g></g></g>`
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
              <CanvasColor>${xmlEsc(screen.backgroundColor || '#F1F5F9')}</CanvasColor>
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
    <DicSymbolWinIdAndWindowId />
  </Windows>
  <Tasks>
    <ListTask />
  </Tasks>
  <Events>
    <ListEventModel />
  </Events>
  <Boms>
    <ListBom />
  </Boms>
  <Reports>
    <ListReport />
  </Reports>
  <VariableGroups>
    <ListVariableGroup />
  </VariableGroups>
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
