import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { HAIWELL_NATIVE_SYMBOLS, type NativeSymbolBBox } from './haiwellNativeSymbols';
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function parseHexColor(hex: string): [number, number, number, number] {
  const clean = (hex || '#CBD5E1').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
      255,
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
      255,
    ];
  }
  return [203, 213, 225, 255];
}

const PNG_CACHE = new Map<string, { base64: string; md5: string }>();

/**
 * Generates a minimal valid RGBA PNG thumbnail for DicSymPic (<SourcePicture>)
 * and computes its exact MD5 hex digest for PicMd5 / SymbolStateMd5Config.
 */
export function generateSolidPngBase64(
  hexColor: string,
  width = 24,
  height = 24
): { base64: string; md5: string } {
  const key = `${hexColor.toUpperCase()}_${width}x${height}`;
  const cached = PNG_CACHE.get(key);
  if (cached) return cached;

  const [r, g, b, a] = parseHexColor(hexColor);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowSize;
    raw[rowOff] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowOff + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  const entry = {
    base64: png.toString('base64'),
    md5: crypto.createHash('md5').update(png).digest('hex'),
  };
  PNG_CACHE.set(key, entry);
  return entry;
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

/**
 * Computes exact SVG matrix(sx,0,0,sy,tx,ty) placing a native symbol's measured bbox
 * cleanly inside (targetX, targetY, targetW, targetH).
 */
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

/**
 * Rewrites shared native gradient IDs (HWIDone, HWIDtwo, etc.) per widget hwkey
 * so multiple gauges, switches, lamps, or motors never collide in <svg>.
 */
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

interface SymbolLibEntry {
  symbolId: string;
  md5: string;
  color: string;
  symbolXml: string;
}

interface SymbolGroupEntry {
  groupId: string;
  stateIds: Record<string, string>;
  colors: Record<string, string>;
}

interface SymRecord {
  id: number;
  name: string;
  symbolName: string;
  hwkey: string;
  groupId: string;
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
 * into an official Haiwell Cloud Scada 3.50.x `<HwExportModel>` `.hwExport` XML file
 * using authentic Graphics Library symbols (HWIstrument3, HWCursor3, ConveyorBelt1,
 * HWAlarmTableControlNew, RealTimeCurves, HWHistoricalDataTableNew, HWBoard2/3,
 * lamp013, sw006, Motor1, HWReactor25, HWGear1, HWClock4, HWArrow1, HWChannel1).
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

  const ensurePic = (color: string, realAssetKey?: string): string => {
    if (realAssetKey && HAIWELL_NATIVE_SYMBOLS.librarySymbols[realAssetKey]?.pngBase64) {
      const asset = HAIWELL_NATIVE_SYMBOLS.librarySymbols[realAssetKey];
      if (!pictures.has(asset.md5)) {
        pictures.set(asset.md5, { id: nextPicId++, md5: asset.md5, base64: asset.pngBase64 });
      }
      return asset.md5;
    }
    const { base64, md5 } = generateSolidPngBase64(color);
    if (!pictures.has(md5)) {
      pictures.set(md5, { id: nextPicId++, md5, base64 });
    }
    return md5;
  };

  const ensureLibrarySymbol = (
    symbolId: string,
    color: string,
    symbolXml: string,
    realAssetKey?: string
  ): SymbolLibEntry => {
    const existing = symbolLibs.get(symbolId);
    if (existing) return existing;
    const md5 = ensurePic(color, realAssetKey);
    const entry: SymbolLibEntry = { symbolId, md5, color, symbolXml };
    symbolLibs.set(symbolId, entry);
    return entry;
  };

  const ensureFlatSymbol = (
    symbolId: string,
    color: string,
    borderColor: string,
    rx = 6
  ): SymbolLibEntry => {
    const symbolXml = `<symbol symbolId="${symbolId}" hwsymbolId="HWButton26" set="{'HWBackColor':'${color}'}"><g><rect localid="SymColor" x="0" y="0" rx="${rx}" ry="${rx}" width="100" height="100" stroke="${borderColor}" stroke-width="2" fill="${color}" /></g></symbol>`;
    return ensureLibrarySymbol(symbolId, color, symbolXml);
  };

  const ensureGroup = (
    groupId: string,
    entries: { stateKey: string; symbolId: string; color: string; symbolXml: string; realAssetKey?: string }[]
  ): SymbolGroupEntry => {
    const existing = symbolGroups.get(groupId);
    if (existing) return existing;
    const stateIds: Record<string, string> = {};
    const colors: Record<string, string> = {};
    for (const e of entries) {
      const s = ensureLibrarySymbol(e.symbolId, e.color, e.symbolXml, e.realAssetKey);
      stateIds[e.stateKey] = s.symbolId;
      colors[e.stateKey] = e.color;
    }
    const grp: SymbolGroupEntry = { groupId, stateIds, colors };
    symbolGroups.set(groupId, grp);
    return grp;
  };

  const textGroup = ensureGroup('shap001', [
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
      varBindings: { propName: string; varId: number }[] = []
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

    // Render native pipes (HWChannel1 + HWArrow1) underneath widgets
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
        const spanH = Math.max(16, Math.abs(p1.y - p0.y));
        if (pipe.fluid === 'SIGNAL') {
          const ptsStr = pts.map((p) => `${p.x},${p.y}`).join(' ');
          svgElements.push(
            `<polyline fill="none" stroke="#2563EB" stroke-width="3" stroke-dasharray="6,4" marker-end="url(#arrow2)" points="${ptsStr}" />`
          );
        } else {
          // Clean horizontal metallic industrial pipe + native HWArrow1
          svgElements.push(
            `<g><rect x="${minX}" y="${minY - 5}" width="${spanW}" height="10" rx="2" fill="#94A3B8" stroke="#334155" stroke-width="1.5" /><line x1="${minX}" y1="${minY - 2}" x2="${minX + spanW}" y2="${minY - 2}" stroke="#E2E8F0" stroke-width="2" /></g>`
          );
          placeDllSymbol('HWArrow1', 'HWArrow1', minX + Math.round(spanW / 2) - 16, minY - 12, 32, 24, {
            preserveAspect: true,
            extraAttrs: 'StCt="1" HWBackColor="#16A34A"',
          });
        }
        if (pipe.label) {
          const midX = Math.round((p0.x + p1.x) / 2) - 60;
          const midY = Math.round((p0.y + p1.y) / 2) - 24;
          addTxtBlock(Math.max(0, midX), Math.max(0, midY), 120, 18, pipe.label, {
            color: pipe.fluid === 'SIGNAL' ? '#1D4ED8' : '#334155',
            fontSize: 11,
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

      // 1. GROUP_PANEL -> Real Haiwell HWBoard3 (sharp 3D beveled industrial panel) or dark header bar
      if (w.type === 'GROUP_PANEL') {
        const isDark = w.props?.theme === 'dark';
        if (isDark) {
          const seq = nextSymDbId++;
          const symId = `Shape_${seq}`;
          const hwkey = `${symId}_${seq}`;
          registerTextOnlyRecord('Shape', symId, hwkey, textGroup.groupId, { '0': ensurePic('#1E293B') }, '', '#F8FAFC', 14, true, 'st');
          svgElements.push(
            `<g transform="matrix(${(w.width / 100).toFixed(6)},0,0,${(w.height / 100).toFixed(6)},${w.x},${w.y})" hw-PowerTime="10" sym-type="Shape" v="0.2" id="${symId}" hwkey="${hwkey}" StCt="1" RemoteOperation="true"><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" title="Graphics" name="Shape" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="2" ry="2" width="100" height="100" stroke="#0F172A" stroke-width="2" fill="#1E293B" /></g></g></g></g></g>`
          );
        } else {
          placeDllSymbol('HWBoard3', 'HWBoard3', w.x, w.y, w.width, w.height, {
            preserveAspect: false,
            extraAttrs: `HWSurface1="out" HWSurface2="in" HWBackColor1="#CBD5E1" HWBackColor2="#F8FAFC"`,
            transformVisual: (vis) =>
              vis
                .replace(/fill="#DDDDDD"/g, 'fill="#F8FAFC"')
                .replace(/stroke="#FFFFFF"/g, 'stroke="#FFFFFF"')
                .replace(/stroke="#666666"/g, 'stroke="#94A3B8"'),
          });
        }
        if (w.label) {
          addTxtBlock(w.x + 14, w.y + (isDark ? 10 : 8), Math.max(80, w.width - 28), 22, w.label, {
            color: isDark ? '#F8FAFC' : '#0F172A',
            fontSize: isDark ? 14 : 12,
            bold: true,
            align: 'left',
          });
        }
        continue;
      }

      // 2. LABEL (or HWClock4 live digital clock)
      if (w.type === 'LABEL') {
        if (w.props?.nativeSymbol === 'HWClock4') {
          const seq = nextSymDbId++;
          const symId = `Clock4_${seq}`;
          const hwkey = `HWClock4_${seq}_${seq}`;
          registerTextOnlyRecord('HWClock4', symId, hwkey, textGroup.groupId, { '0': ensurePic('#1E293B') }, '00:00:00', '#38BDF8', 14, true, 'at');
          svgElements.push(
            `<g transform="matrix(1,0,0,1,${w.x},${w.y})" hw-PowerTime="10" sym-type="HWClock4" v="0.3" id="${symId}" hwkey="${hwkey}" Font="" TxtColor="#38BDF8" HWBackColor="#1E293B" HWBackOpacity="100" IsTextBlock="true" DateEnable="true" DataType="7" DataSign="/" WeekEnable="false" TimeEnable="true"><hwsymbol ChangeToPicture="true" id="${hwkey}" newSym="true" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Clock" name="HWClock4" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w.width}" height="${w.height}" fill="#1E293B" fill-opacity="0" stroke="none" text-color="#38BDF8" text-anchor="right" font-family="Arial" fonten="Arial" font-size="14" sh="18.66" font-weight="bold" wrap="nowrap">2026/11/25 21:20</textBlock></g></g></g></g>`
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

      // 3. BIT_BUTTON -> Real Haiwell sw006 (HWNewSwitch2) metallic-bezel industrial pushbutton
      if (w.type === 'BIT_BUTTON') {
        const pal = getPushbuttonPalette(w.visualRole);
        const seq = nextSymDbId++;
        const symId = `BitSw_${seq}`;
        const hwkey = `${symId}_${seq}`;
        const sw0 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['sw006_0'];
        const sw1 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['sw006_1'];
        const tint0 = scopeGradientIds(sw0.innerSvg.replace(/#750000/gi, pal.state0), hwkey);
        const xml0 = sw0.symbolXml.replace(/#750000/gi, pal.state0);
        const xml1 = sw1.symbolXml.replace(/#FF2D2D/gi, pal.state1);
        const grp = ensureGroup(`sw006_${pal.state0.replace('#', '')}`, [
          { stateKey: '0', symbolId: `sw006_${pal.state0.replace('#', '')}_0`, color: pal.state0, symbolXml: xml0, realAssetKey: 'sw006_0' },
          { stateKey: '1', symbolId: `sw006_${pal.state0.replace('#', '')}_1`, color: pal.state1, symbolXml: xml1, realAssetKey: 'sw006_1' },
        ]);

        const btnSize = Math.min(w.width, Math.max(36, w.height - 20));
        const tf = computeNativeMatrix(sw0.bbox, w.x, w.y, w.width, btnSize, true);
        const wrtAttrs = bound
          ? `WrtVar="${xmlEsc(bound.fullName)}" WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"`
          : `WrtVar=""`;

        symRecords.push({
          id: seq,
          name: 'BitSw',
          symbolName: symId,
          hwkey,
          groupId: grp.groupId,
          winId: winDbId,
          md5Config: JSON.stringify({
            '0': symbolLibs.get(grp.stateIds['0'])!.md5,
            '1': symbolLibs.get(grp.stateIds['1'])!.md5,
          }),
          textConfig: JSON.stringify({}),
          stateCount: 2,
          textContent: JSON.stringify({}),
          textLocalId: 'st',
          textColor: pal.text,
          fontSize: 11,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'WrtVar-id', varId: bound.varId }] : [],
        });

        svgElements.push(
          `<g transform="${tf}" hw-PowerTime="10" sym-type="BitSw" v="0.1" id="${symId}" hwkey="${hwkey}" RvrsSt="false" DifVar="false" ActnLock="false" LockLogic="off" StCt="2" ActnType="sw" ActnEff="false" WhthCnfrmBox="false" ${wrtAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="sw006" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit switch" title-en="Bit switch" name="BitSw" /><g><g sign="state"><g sign="svg">${tint0}</g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" cst="0" /></g></g></g></g>`
        );
        addTxtBlock(w.x, w.y + btnSize + 2, w.width, 18, w.label, {
          color: '#0F172A',
          fontSize: 11,
          bold: true,
          align: 'center',
        });
        continue;
      }

      // 4. BIT_LAMP -> Real Haiwell lamp013 (HWLight8) glowing 3D pilot LED
      if (w.type === 'BIT_LAMP') {
        const offHex = w.visualRole === 'DANGER_ACTION' ? '#DC2626' : '#64748B';
        const onHex = '#22C55E';
        const seq = nextSymDbId++;
        const symId = `BitLamp_${seq}`;
        const hwkey = `${symId}_${seq}`;
        const l0 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['lamp013_0'];
        const l1 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['lamp013_1'];
        const ledSvg = scopeGradientIds(l0.innerSvg.replace(/#006000/gi, offHex), hwkey);
        const xml0 = l0.symbolXml.replace(/#006000/gi, offHex);
        const xml1 = l1.symbolXml.replace(/#28FF28/gi, onHex);
        const grp = ensureGroup(`lamp013_${offHex.replace('#', '')}`, [
          { stateKey: '0', symbolId: `lamp013_${offHex.replace('#', '')}_0`, color: offHex, symbolXml: xml0, realAssetKey: 'lamp013_0' },
          { stateKey: '1', symbolId: `lamp013_${offHex.replace('#', '')}_1`, color: onHex, symbolXml: xml1, realAssetKey: 'lamp013_1' },
        ]);

        const horizontal = w.width >= w.height * 2.2;
        const ledSize = horizontal ? Math.min(34, w.height - 4) : Math.min(w.width, Math.max(24, w.height - 20));
        const ledX = horizontal ? w.x + 4 : w.x;
        const ledY = horizontal ? w.y + Math.round((w.height - ledSize) / 2) : w.y;
        const tf = computeNativeMatrix(l0.bbox, ledX, ledY, horizontal ? ledSize : w.width, ledSize, true);
        const rdAttrs = bound
          ? `RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `RdVar=""`;

        symRecords.push({
          id: seq,
          name: 'BitLamp',
          symbolName: symId,
          hwkey,
          groupId: grp.groupId,
          winId: winDbId,
          md5Config: JSON.stringify({
            '0': symbolLibs.get(grp.stateIds['0'])!.md5,
            '1': symbolLibs.get(grp.stateIds['1'])!.md5,
          }),
          textConfig: JSON.stringify({}),
          stateCount: 2,
          textContent: JSON.stringify({}),
          textLocalId: 'st',
          textColor: '#0F172A',
          fontSize: 11,
          fontWeight: 'bold',
          varBindings: bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
        });

        svgElements.push(
          `<g transform="${tf}" hw-PowerTime="10" sym-type="BitLamp" v="0.4" id="${symId}" hwkey="${hwkey}" RvrsSt="false" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" EnblExps="" ${rdAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="lamp013" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Bit lamp" title-en="Bit lamp" name="BitLamp" /><g><g sign="state"><g sign="svg">${ledSvg}</g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#000000" text-anchor="center" font-family="Arial" fonten="Arial" font-size="10" sh="13.33" cst="0" /></g></g></g></g>`
        );

        if (horizontal) {
          addTxtBlock(w.x + ledSize + 10, w.y + Math.round((w.height - 18) / 2), Math.max(40, w.width - ledSize - 12), 18, w.label, {
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
          transformVisual: (vis) => vis.replace(/>仪表</g, `>${xmlEsc(w.unit || '%')}<`),
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
          transformVisual: (vis) => vis.replace(/>游标</g, `>${xmlEsc(w.unit || 'Qty')}<`).replace(/>000</g, '>0<'),
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

      // 11. STATION / ACTUATOR / PUMP / VALVE / TANK -> Real Haiwell HWBoard3 + Machine/Motor/Gear/Reactor25
      if (w.type === 'STATION' || w.type === 'ACTUATOR' || w.type === 'PUMP' || w.type === 'VALVE' || w.type === 'TANK') {
        const iconKey =
          typeof w.props?.nativeSymbol === 'string' && HAIWELL_NATIVE_SYMBOLS.dllSymbols[w.props.nativeSymbol]
            ? w.props.nativeSymbol
            : w.type === 'STATION'
              ? 'HWReactor25'
              : w.type === 'ACTUATOR'
                ? 'Motor1'
                : w.type === 'PUMP'
                  ? 'Motor1'
                  : 'HWReactor25';

        if (w.type === 'STATION') {
          placeDllSymbol('HWBoard3', 'HWBoard3', w.x, w.y, w.width, w.height, {
            preserveAspect: false,
            extraAttrs: `HWSurface1="out" HWSurface2="in" HWBackColor1="#E2E8F0" HWBackColor2="#F8FAFC"`,
          });
          addTxtBlock(w.x + 12, w.y + 8, Math.max(60, w.width - 24), 22, w.label, {
            color: '#0F172A',
            fontSize: 12,
            bold: true,
            align: 'center',
          });
          placeDllSymbol(iconKey, iconKey, w.x + Math.round(w.width * 0.14), w.y + 38, Math.round(w.width * 0.56), Math.max(48, w.height - 64), {
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
        const grp = ensureGroup(`btn214_${bgHex.replace('#', '')}`, [
          {
            stateKey: '0',
            symbolId: `btn214_${bgHex.replace('#', '')}_0`,
            color: bgHex,
            symbolXml: btnAsset.symbolXml.replace(/#77C34F/gi, bgHex),
            realAssetKey: 'btn214_0',
          },
        ]);
        const sx = (w.width / 100).toFixed(6);
        const sy = (w.height / 100).toFixed(6);
        registerTextOnlyRecord('WinOpBtn', symId, hwkey, grp.groupId, { '0': symbolLibs.get(grp.stateIds['0'])!.md5 }, '', '#FFFFFF', 12, true, 'st');
        svgElements.push(
          `<g transform="matrix(${sx},0,0,${sy},${w.x},${w.y})" hw-PowerTime="10" sym-type="WinOpBtn" v="0.1" id="${symId}" hwkey="${hwkey}" Fun="show_spef_pic" Pic="${xmlEsc(navTarget)}" SubPic="" IsPrintHidden="false" ActnEff="false" WhthCnfrmBox="false" ActnLock="false" StCt="1"><hwsymbol id="${hwkey}" newsym="true" defGId="btn214" title="Picture operation button" name="WinOpBtn" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="6" ry="6" width="100" height="100" stroke="#0F172A" stroke-width="2" fill="${bgHex}" /></g></g><g sign="text"><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#FFFFFF" text-anchor="center" font-family="Arial" fonten="Arial" font-size="12" sh="16" cst="0" /></g></g></g></g>`
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
        fontSize: 11,
        bold: true,
        align: 'left',
      });

      const seq = nextSymDbId++;
      const symType = isString ? 'TxtShowIput' : 'NumShowIput';
      const symId = `${symType}_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const cardFill = w.visualRole === 'KPI_HERO' ? '#EFF6FF' : '#FFFFFF';
      const cardBorder = w.visualRole === 'KPI_HERO' ? '#2563EB' : '#94A3B8';
      const btn226 = HAIWELL_NATIVE_SYMBOLS.librarySymbols['btn226_0'];
      const grp = ensureGroup(`btn226_${cardFill.replace('#', '')}`, [
        {
          stateKey: '0',
          symbolId: `btn226_${cardFill.replace('#', '')}_0`,
          color: cardFill,
          symbolXml: btn226.symbolXml.replace(/#C7E1F0/gi, cardFill),
          realAssetKey: 'btn226_0',
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
        w.visualRole === 'KPI_HERO' ? 16 : 13,
        true,
        'at',
        bindings
      );
      const attrs = bound
        ? isString
          ? `IsIput="false" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `SignDisp="true" IsPwdDisp="false" KilobitDisp="false" IsIput="${isInput}" ShowLeftTag="false" ShowRightTag="${Boolean(unitStr)}" DifVar="false" LeftTag="" RightTag="${xmlEsc(unitStr)}" NumHex="10" IntNum="6" DcmPls="${decimals}" HwLimit="num" IputMaxVal="${w.max ?? 32767}" IputMinVal="${w.min ?? -32768}" Font="" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" WrtVar="${isInput ? xmlEsc(bound.fullName) : ''}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
        : `SignDisp="true" IsIput="false" DcmPls="${decimals}" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar=""`;
      svgElements.push(
        `<g transform="matrix(${sx},0,0,${sy},${w.x},${boxY})" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${attrs}><hwsymbol id="${hwkey}" newsym="true" defGId="btn226" title="Numeric input/display" name="${symType}" /><g><g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="4" ry="4" width="100" height="100" stroke="${cardBorder}" stroke-width="2" fill="${cardFill}" /></g></g><g sign="text"><textBlock localid="at" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="#0F172A" text-anchor="center" font-family="Arial" fonten="Arial" font-size="${w.visualRole === 'KPI_HERO' ? 16 : 13}" sh="20" font-weight="bold" cst="0">${isString ? '---' : `0${unitStr ? ` ${xmlEsc(unitStr)}` : ''}`}</textBlock></g></g></g></g>`
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
    .map(
      (s) => `      <SerializableDictionary>
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
            <DefaultGroupId>${xmlEsc(s.groupId)}</DefaultGroupId>
            <StateCount>${s.stateCount}</StateCount>
            <IsPublicWindow>0</IsPublicWindow>
          </ProjectSymbol>
        </value>
      </SerializableDictionary>`
    )
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
            <DefaultDisplaySetting>${xmlEsc(
              JSON.stringify(
                Object.fromEntries(Object.entries(g.colors).map(([k, v]) => [k, { HWBackColor: v }]))
              )
            )}</DefaultDisplaySetting>
            <StateCount>${Object.keys(g.stateIds).length}</StateCount>
            <SymbolType>svg</SymbolType>
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
            <SymbolType>svg</SymbolType>
            <PicMd5>${lib.md5}</PicMd5>
            <SymbolXml>${xmlEsc(lib.symbolXml)}</SymbolXml>
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
