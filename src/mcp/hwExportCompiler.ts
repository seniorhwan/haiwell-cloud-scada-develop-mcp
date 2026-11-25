import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowSize;
    raw[rowOff] = 0; // filter type None
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

function getRoleColors(role?: HmiVisualRole, type?: HmiWidget['type']): {
  state0: string;
  state1: string;
  text: string;
  border: string;
} {
  switch (role) {
    case 'PRIMARY_ACTION':
      return { state0: '#16A34A', state1: '#22C55E', text: '#FFFFFF', border: '#15803D' };
    case 'DANGER_ACTION':
      return { state0: '#DC2626', state1: '#EF4444', text: '#FFFFFF', border: '#B91C1C' };
    case 'WARNING_ACTION':
      return { state0: '#D97706', state1: '#F59E0B', text: '#FFFFFF', border: '#B45309' };
    case 'KPI_HERO':
      return { state0: '#FFFFFF', state1: '#EFF6FF', text: '#0F172A', border: '#2563EB' };
    case 'STATUS_READONLY':
      return { state0: '#F8FAFC', state1: '#E2E8F0', text: '#0F172A', border: '#94A3B8' };
    default:
      if (type === 'BIT_LAMP') {
        return { state0: '#94A3B8', state1: '#16A34A', text: '#0F172A', border: '#475569' };
      }
      if (type === 'BIT_BUTTON') {
        return { state0: '#2563EB', state1: '#3B82F6', text: '#FFFFFF', border: '#1D4ED8' };
      }
      if (type === 'ALARM_BANNER') {
        return { state0: '#FEF2F2', state1: '#FEE2E2', text: '#991B1B', border: '#DC2626' };
      }
      if (type === 'NAV_BAR') {
        return { state0: '#1E293B', state1: '#334155', text: '#F8FAFC', border: '#0F172A' };
      }
      if (type === 'GROUP_PANEL') {
        return { state0: '#FFFFFF', state1: '#FFFFFF', text: '#0F172A', border: '#CBD5E1' };
      }
      return { state0: '#FFFFFF', state1: '#F1F5F9', text: '#0F172A', border: '#94A3B8' };
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

/**
 * Compiles validated HMI screens + bound PLC/Internal variables from a HaiwellProject
 * into an official Haiwell Cloud Scada 3.50.x `<HwExportModel>` `.hwExport` XML file
 * ready for native `Project(P) -> Import(I)` or `Project display -> Import`.
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

  const ensurePic = (color: string) => {
    const { base64, md5 } = generateSolidPngBase64(color);
    if (!pictures.has(md5)) {
      pictures.set(md5, { id: nextPicId++, md5, base64 });
    }
    return md5;
  };

  const ensureFlatSymbol = (
    symbolId: string,
    color: string,
    borderColor: string,
    rx = 6
  ): SymbolLibEntry => {
    const existing = symbolLibs.get(symbolId);
    if (existing) return existing;
    const md5 = ensurePic(color);
    const symbolXml = `<symbol symbolId="${symbolId}" hwsymbolId="HWButton26" set="{'HWBackColor':'${color}'}"><g><rect localid="SymColor" x="0" y="0" rx="${rx}" ry="${rx}" width="100" height="100" stroke="${borderColor}" stroke-width="2" fill="${color}" /></g></symbol>`;
    const entry: SymbolLibEntry = { symbolId, md5, color, symbolXml };
    symbolLibs.set(symbolId, entry);
    return entry;
  };

  const ensureGroup = (
    groupId: string,
    color0: string,
    border0: string,
    color1?: string,
    border1?: string,
    rx = 6
  ): SymbolGroupEntry => {
    const existing = symbolGroups.get(groupId);
    if (existing) return existing;
    const s0 = ensureFlatSymbol(`${groupId}_0`, color0, border0, rx);
    const stateIds: Record<string, string> = { '0': s0.symbolId };
    const colors: Record<string, string> = { '0': color0 };
    if (color1) {
      const s1 = ensureFlatSymbol(`${groupId}_1`, color1, border1 ?? border0, rx);
      stateIds['1'] = s1.symbolId;
      colors['1'] = color1;
    }
    const grp: SymbolGroupEntry = { groupId, stateIds, colors };
    symbolGroups.set(groupId, grp);
    return grp;
  };

  // Pre-seed TxtBlock shared shape group (shap001)
  const textGroup = ensureGroup('shap001', '#FFFFFF', 'none', undefined, undefined, 0);

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
      const fontWeight = opts.bold ? 'bold' : 'normal';
      const align = opts.align ?? 'left';
      const bg = opts.bg ?? '#FFFFFF';
      const bgOp = opts.bgOpacity ?? 0;

      const textJson = JSON.stringify({
        t: text,
        f: 'Arial',
        fe: 'Arial',
        s: String(fontSize),
        sh: Number((fontSize * 1.33).toFixed(2)),
        fs: opts.bold ? 'Bold' : 'Regular',
        u: 0,
        st: 0,
      });

      symRecords.push({
        id: seq,
        name: 'TxtBlock',
        symbolName: symId,
        hwkey,
        groupId: textGroup.groupId,
        winId: winDbId,
        md5Config: JSON.stringify({ '0': ensurePic('#FFFFFF') }),
        textConfig: textJson,
        stateCount: 1,
        textContent: text,
        textLocalId: 'at',
        textColor: txtColor,
        fontSize,
        fontWeight,
        varBindings: [],
      });

      svgElements.push(
        `<g transform="matrix(1,0,0,1,${x},${y})" hw-PowerTime="10" sym-type="TxtBlock" v="0.6" id="${symId}" hwkey="${hwkey}" TxtAlign="${align}" TxtColor="${txtColor}" IsResize="false" HWBackColor="${bg}" HWBackOpacity="${bgOp === 0 ? 0 : 100}" Blinking="false" SwCtrl="false" IsOFFCtrl="false" BlinkingTime="1000" IsTextToPicture="false" Txt="${xmlEsc(text)}" IsTextBlock="true" SwCtrlVar=""><hwsymbol id="${hwkey}" newsym="true" defGId="shap001" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="Text" title-en="Text" name="TxtBlock" /><g><g sign="state"><g sign="svg" /><g sign="text"><textBlock localid="at" x="0" y="0" width="${w}" height="${h}" fill="${bg}" stroke="none" text-color="${txtColor}" fill-opacity="${bgOp}" text-anchor="${align}" vertical-align="milldle" font-family="Arial" fonten="Arial" font-size="${fontSize}" sh="${(fontSize * 1.33).toFixed(2)}" wrap="nowrap" font-weight="${fontWeight}" font-style="normal" text-decoration="normal">${xmlEsc(text)}</textBlock></g></g></g></g>`
      );
    };

    const addRectSymbol = (
      symType: 'BitSw' | 'BitLamp' | 'NumShowIput' | 'TxtShowIput' | 'WinOpBtn' | 'Shape',
      wgt: HmiWidget,
      colors: { state0: string; state1: string; text: string; border: string },
      extraAttrs: string,
      varBindings: { propName: string; varId: number }[],
      optionsRect: {
        twoState?: boolean;
        rx?: number;
        displayText?: string;
        fontSize?: number;
        bold?: boolean;
      } = {}
    ) => {
      const seq = nextSymDbId++;
      const symId = `${symType}_${seq}`;
      const hwkey = `${symId}_${seq}`;
      const grpKey = `grp_${symType}_${colors.state0.replace('#', '')}_${(optionsRect.twoState ? colors.state1 : '1s').replace('#', '')}_${colors.border.replace('#', '')}`;
      const grp = ensureGroup(
        grpKey,
        colors.state0,
        colors.border,
        optionsRect.twoState ? colors.state1 : undefined,
        optionsRect.twoState ? colors.border : undefined,
        optionsRect.rx ?? 6
      );
      const sx = (wgt.width / 100).toFixed(6);
      const sy = (wgt.height / 100).toFixed(6);
      const dispText = optionsRect.displayText ?? '';
      const fontSize = optionsRect.fontSize ?? 12;
      const md5Map: Record<string, string> = {};
      const stateTxtMap: Record<string, unknown> = {};
      const langTxtMap: Record<string, unknown> = {};

      for (const [stKey, sid] of Object.entries(grp.stateIds)) {
        md5Map[stKey] = symbolLibs.get(sid)!.md5;
        const single = {
          t: dispText,
          f: 'Arial',
          s: fontSize,
          sh: Number((fontSize * 1.33).toFixed(2)),
          fs: optionsRect.bold ? 'Bold' : 'Regular',
          u: 0,
          st: 0,
          fe: 'Arial',
        };
        stateTxtMap[stKey] = { c: colors.text, ism: 1, single, [lang]: single };
        langTxtMap[stKey] = {
          c: colors.text,
          t: dispText,
          f: 'Arial',
          s: String(fontSize),
          sh: String(Number((fontSize * 1.33).toFixed(2))),
          fs: optionsRect.bold ? 'Bold' : 'Regular',
          u: '0',
          st: '0',
          fe: 'Arial',
        };
      }

      symRecords.push({
        id: seq,
        name: symType,
        symbolName: symId,
        hwkey,
        groupId: grp.groupId,
        winId: winDbId,
        md5Config: JSON.stringify(md5Map),
        textConfig: JSON.stringify(stateTxtMap),
        stateCount: Object.keys(grp.stateIds).length,
        textContent: JSON.stringify(langTxtMap),
        textLocalId: 'st',
        textColor: colors.text,
        fontSize,
        fontWeight: optionsRect.bold ? 'bold' : 'normal',
        varBindings,
      });

      const state0Block = `<g sign="state"><g sign="svg"><g><rect x="0" y="0" rx="${optionsRect.rx ?? 6}" ry="${optionsRect.rx ?? 6}" width="100" height="100" stroke="${colors.border}" stroke-width="2" fill="${colors.state0}" /></g></g><g sign="text"><g><textBlock localid="st" x="0" y="0" width="100" height="100" fill="none" stroke="none" text-color="${colors.text}" text-anchor="center" font-family="Arial" fonten="Arial" font-size="${fontSize}" sh="${(fontSize * 1.33).toFixed(2)}" font-weight="${optionsRect.bold ? 'bold' : 'normal'}" font-style="normal" text-decoration="normal" cst="0">${xmlEsc(dispText)}</textBlock></g></g></g>`;

      svgElements.push(
        `<g transform="matrix(${sx},0,0,${sy},${wgt.x},${wgt.y})" hw-PowerTime="10" sym-type="${symType}" v="0.4" id="${symId}" hwkey="${hwkey}" ${extraAttrs}><hwsymbol id="${hwkey}" newsym="true" defGId="${grp.groupId}" IsShowSafe="false" IsShowRemoteControl="false" IsShowShortcutKey="false" title="${symType}" title-en="${symType}" name="${symType}" /><g>${state0Block}</g></g>`
      );
    };

    // Render pipes first (underneath widgets) if present
    for (const pipe of screen.pipes ?? []) {
      const boundFlow = bindTag(pipe.flowTagName);
      if (boundFlow) usedVarIds.add(boundFlow.varId);
      const pts = pipe.waypoints.map((p) => `${p.x},${p.y}`).join(' ');
      const stroke = pipe.fluid === 'SIGNAL' ? '#2563EB' : '#475569';
      const dash = pipe.fluid === 'SIGNAL' ? ' stroke-dasharray="6,4"' : '';
      svgElements.push(
        `<polyline fill="none" stroke="${stroke}" stroke-width="4"${dash} marker-end="url(#arrow2)" points="${pts}" />`
      );
      if (pipe.label && pipe.waypoints.length >= 2) {
        const midX = Math.round((pipe.waypoints[0].x + pipe.waypoints[pipe.waypoints.length - 1].x) / 2) - 48;
        const midY = Math.round((pipe.waypoints[0].y + pipe.waypoints[pipe.waypoints.length - 1].y) / 2) - 22;
        addTxtBlock(Math.max(0, midX), Math.max(0, midY), 120, 20, pipe.label, {
          color: stroke,
          fontSize: 11,
          bold: true,
          align: 'center',
        });
      }
    }

    for (const w of screen.widgets) {
      totalWidgets++;
      const colors = getRoleColors(w.visualRole, w.type);
      const bound = bindTag(w.tagName);
      if (bound) usedVarIds.add(bound.varId);

      if (w.type === 'GROUP_PANEL') {
        addRectSymbol(
          'Shape',
          w,
          { state0: '#FFFFFF', state1: '#FFFFFF', text: '#0F172A', border: '#CBD5E1' },
          `StCt="1" RemoteOperation="true"`,
          [],
          { twoState: false, rx: 6 }
        );
        addTxtBlock(w.x + 12, w.y + 8, Math.max(80, w.width - 24), 24, w.label, {
          color: '#334155',
          fontSize: 13,
          bold: true,
          align: 'left',
        });
        continue;
      }

      if (w.type === 'LABEL') {
        addTxtBlock(w.x, w.y, w.width, w.height, w.label, {
          color: colors.text,
          fontSize: 13,
          bold: true,
          align: 'left',
        });
        continue;
      }

      if (w.type === 'BIT_BUTTON') {
        const attrs = bound
          ? `RvrsSt="false" DifVar="false" ActnLock="false" LockLogic="off" StCt="2" ActnType="sw" ActnEff="false" WhthCnfrmBox="false" WrtVar="${xmlEsc(bound.fullName)}" WrtVar-UseAddr="false" WrtVar-id="${bound.varId}"`
          : `RvrsSt="false" DifVar="false" ActnLock="false" LockLogic="off" StCt="2" ActnType="sw" ActnEff="false" WhthCnfrmBox="false" WrtVar=""`;
        addRectSymbol(
          'BitSw',
          w,
          colors,
          attrs,
          bound ? [{ propName: 'WrtVar-id', varId: bound.varId }] : [],
          { twoState: true, rx: 6 }
        );
        addTxtBlock(w.x + 6, w.y + Math.max(4, Math.round(w.height / 2) - 12), Math.max(40, w.width - 12), 24, w.label, {
          color: colors.text,
          fontSize: 14,
          bold: true,
          align: 'center',
        });
        continue;
      }

      if (w.type === 'BIT_LAMP') {
        const lampColors =
          w.visualRole === 'DANGER_ACTION'
            ? { state0: '#FCA5A5', state1: '#16A34A', text: '#0F172A', border: '#DC2626' }
            : { state0: '#CBD5E1', state1: '#16A34A', text: '#0F172A', border: '#64748B' };
        const attrs = bound
          ? `RvrsSt="false" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" RdVar="${xmlEsc(bound.fullName)}" EnblExps="" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
          : `RvrsSt="false" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" RdVar="" EnblExps=""`;
        addRectSymbol(
          'BitLamp',
          w,
          lampColors,
          attrs,
          bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
          { twoState: true, rx: 8 }
        );
        addTxtBlock(w.x + 6, w.y + Math.max(4, Math.round(w.height / 2) - 11), Math.max(40, w.width - 12), 22, w.label, {
          color: '#0F172A',
          fontSize: 12,
          bold: true,
          align: 'center',
        });
        continue;
      }

      if (w.type === 'NAV_BAR') {
        const firstScreenName = targetScreens[0]?.name ?? 'Main_display';
        const navTarget =
          w.targetScreenId && targetScreens.find((s) => s.id === w.targetScreenId)?.name
            ? targetScreens.find((s) => s.id === w.targetScreenId)!.name
            : firstScreenName;
        addRectSymbol(
          'WinOpBtn',
          w,
          colors,
          `Fun="show_spef_pic" Pic="${xmlEsc(navTarget)}" SubPic="" IsPrintHidden="false" ActnEff="false" WhthCnfrmBox="false" ActnLock="false" StCt="1"`,
          [],
          { twoState: false, rx: 6 }
        );
        addTxtBlock(w.x + 12, w.y + Math.max(4, Math.round(w.height / 2) - 11), Math.max(60, w.width - 24), 22, w.label, {
          color: colors.text,
          fontSize: 13,
          bold: true,
          align: 'center',
        });
        continue;
      }

      if (
        w.type === 'NUMERIC_DISPLAY' ||
        w.type === 'NUMERIC_INPUT' ||
        w.type === 'GAUGE' ||
        w.type === 'BAR_GRAPH' ||
        w.type === 'DATA_TABLE' ||
        w.type === 'TREND_CHART'
      ) {
        const isString = bound?.tag.dataType === 'STRING';
        const isInput = w.type === 'NUMERIC_INPUT';
        const decimals = w.precision ?? (bound?.tag.dataType === 'FLOAT32' ? 1 : 0);
        const unitStr = w.unit ?? bound?.tag.unit ?? '';
        const cardH = Math.max(24, w.height - 24);
        const cardWgt: HmiWidget = { ...w, y: w.y + 22, height: cardH };

        addTxtBlock(w.x + 4, w.y + 2, Math.max(40, w.width - 8), 20, w.label, {
          color: '#475569',
          fontSize: 11,
          bold: true,
          align: 'left',
        });

        if (isString) {
          const attrs = bound
            ? `IsIput="false" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
            : `IsIput="false" DifVar="false" DispLgth="32" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar=""`;
          addRectSymbol(
            'TxtShowIput',
            cardWgt,
            colors,
            attrs,
            bound ? [{ propName: 'RdVar-id', varId: bound.varId }] : [],
            { twoState: false, rx: 4, displayText: '---', fontSize: 14, bold: true }
          );
        } else {
          const attrs = bound
            ? `SignDisp="true" IsPwdDisp="false" KilobitDisp="false" IsIput="${isInput}" ShowLeftTag="false" ShowRightTag="${Boolean(unitStr)}" DifVar="false" LeftTag="" RightTag="${xmlEsc(unitStr)}" NumHex="10" IntNum="6" DcmPls="${decimals}" HwLimit="num" IputMaxVal="${w.max ?? 32767}" IputMinVal="${w.min ?? -32768}" Font="" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar="${xmlEsc(bound.fullName)}" WrtVar="${isInput ? xmlEsc(bound.fullName) : ''}" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`
            : `SignDisp="true" IsIput="false" DcmPls="${decimals}" TxtAlign="center" TxtColor="#0F172A" StCt="1" RdVar=""`;
          const bindings = bound
            ? isInput
              ? [
                  { propName: 'RdVar-id', varId: bound.varId },
                  { propName: 'WrtVar-id', varId: bound.varId },
                ]
              : [{ propName: 'RdVar-id', varId: bound.varId }]
            : [];
          addRectSymbol('NumShowIput', cardWgt, colors, attrs, bindings, {
            twoState: false,
            rx: 4,
            displayText: '0',
            fontSize: w.visualRole === 'KPI_HERO' ? 18 : 15,
            bold: true,
          });
        }
        continue;
      }

      // ALARM_BANNER, STATION, CONVEYOR, ACTUATOR, PUMP, VALVE, TANK, etc.
      if (bound && bound.tag.dataType === 'BOOL') {
        addRectSymbol(
          'BitLamp',
          w,
          { state0: '#E2E8F0', state1: '#22C55E', text: '#0F172A', border: colors.border },
          `RvrsSt="false" StCt="2" Model="none" Type="on" IsOFFCtrl="false" FrqTime="1000" RdVar="${xmlEsc(bound.fullName)}" EnblExps="" RdVar-UseAddr="false" RdVar-id="${bound.varId}"`,
          [{ propName: 'RdVar-id', varId: bound.varId }],
          { twoState: true, rx: 6 }
        );
      } else {
        addRectSymbol(
          'Shape',
          w,
          colors,
          `StCt="1" RemoteOperation="true"`,
          [],
          { twoState: false, rx: 6 }
        );
      }
      addTxtBlock(w.x + 8, w.y + Math.max(4, Math.round(w.height / 2) - 11), Math.max(40, w.width - 16), 22, w.label, {
        color: colors.text,
        fontSize: 12,
        bold: true,
        align: 'center',
      });
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
