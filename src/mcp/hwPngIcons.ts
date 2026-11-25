import crypto from 'node:crypto';
import zlib from 'node:zlib';

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
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array
): { base64: string; md5: string } {
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
    const dst = y * rowSize;
    raw[dst] = 0;
    const src = y * width * 4;
    raw.set(rgba.subarray(src, src + width * 4), dst + 1);
  }

  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  return {
    base64: png.toString('base64'),
    md5: crypto.createHash('md5').update(png).digest('hex'),
  };
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = (hex || '#CBD5E1').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [203, 213, 225];
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [
    clampByte(a[0] + (b[0] - a[0]) * u),
    clampByte(a[1] + (b[1] - a[1]) * u),
    clampByte(a[2] + (b[2] - a[2]) * u),
  ];
}

function blendPixel(
  rgba: Uint8Array,
  idx: number,
  r: number,
  g: number,
  b: number,
  alpha: number
) {
  const a = Math.max(0, Math.min(1, alpha));
  if (a <= 0) return;
  const oldA = rgba[idx + 3] / 255;
  const outA = a + oldA * (1 - a);
  if (outA <= 0) return;
  rgba[idx] = clampByte((r * a + rgba[idx] * oldA * (1 - a)) / outA);
  rgba[idx + 1] = clampByte((g * a + rgba[idx + 1] * oldA * (1 - a)) / outA);
  rgba[idx + 2] = clampByte((b * a + rgba[idx + 2] * oldA * (1 - a)) / outA);
  rgba[idx + 3] = clampByte(outA * 255);
}

function roundedRectSdf(px: number, py: number, minX: number, minY: number, maxX: number, maxY: number, r: number): number {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hw = (maxX - minX) / 2 - r;
  const hh = (maxY - minY) / 2 - r;
  const dx = Math.max(Math.abs(px - cx) - hw, 0);
  const dy = Math.max(Math.abs(py - cy) - hh, 0);
  return Math.hypot(dx, dy) - r;
}

const SOLID_CACHE = new Map<string, { base64: string; md5: string }>();
const BTN_CACHE = new Map<string, { base64: string; md5: string }>();
const LED_CACHE = new Map<string, { base64: string; md5: string }>();

export function generateSolidPngBase64(
  hexColor: string,
  width = 24,
  height = 24
): { base64: string; md5: string } {
  const key = `${hexColor.toUpperCase()}_${width}x${height}`;
  const cached = SOLID_CACHE.get(key);
  if (cached) return cached;
  const [r, g, b] = parseHexRgb(hexColor);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = 255;
  }
  const entry = encodeRgbaPng(width, height, rgba);
  SOLID_CACHE.set(key, entry);
  return entry;
}

/**
 * Generates a crisp 96x96 3D industrial pushbutton PNG on transparent background
 * for Haiwell <SymbolType>image</SymbolType> BitSw widgets.
 */
export function generatePushbuttonPng(
  baseHex: string,
  pressed: boolean,
  size = 96
): { base64: string; md5: string } {
  const key = `${baseHex.toUpperCase()}_${pressed ? '1' : '0'}_${size}`;
  const cached = BTN_CACHE.get(key);
  if (cached) return cached;

  const baseRgb = parseHexRgb(baseHex);
  const darkRgb = mixRgb(baseRgb, [0, 0, 0], pressed ? 0.25 : 0.45);
  const brightRgb = mixRgb(baseRgb, [255, 255, 255], pressed ? 0.65 : 0.48);
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const pad = size * 0.05;
  const rad = size * 0.11;
  const ringR = size * 0.36;
  const domeR = size * 0.29;
  const shift = pressed ? size * 0.015 : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const sdfBox = roundedRectSdf(x + 0.5, y + 0.5, pad, pad, size - pad, size - pad, rad);
      if (sdfBox < 1.2) {
        const cov = Math.max(0, Math.min(1, 0.8 - sdfBox));
        // Brushed metallic bezel with top-left highlight and bottom-right shadow
        const edgeDist = -sdfBox;
        let col: [number, number, number] = [214, 222, 232];
        if (edgeDist < 3.5) {
          col = x + y < size ? [248, 250, 252] : [100, 116, 139];
        } else {
          const grad = (x + y) / (2 * size);
          col = mixRgb([238, 242, 247], [182, 194, 209], grad);
        }
        blendPixel(rgba, idx, col[0], col[1], col[2], cov);
      }

      // Recessed dark collar ring
      const dRing = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (dRing < ringR + 1.2) {
        const cov = Math.max(0, Math.min(1, ringR + 0.6 - dRing));
        const grad = (x + y) / (2 * size);
        const collar = mixRgb([51, 65, 85], [148, 163, 184], grad);
        blendPixel(rgba, idx, collar[0], collar[1], collar[2], cov);
      }

      // 3D colored pushbutton dome
      const dx = x + 0.5 - (c + shift);
      const dy = y + 0.5 - (c + shift);
      const dDome = Math.hypot(dx, dy);
      if (dDome < domeR + 1.0) {
        const cov = Math.max(0, Math.min(1, domeR + 0.5 - dDome));
        const specDist = Math.hypot(dx + domeR * 0.34, dy + domeR * 0.34) / domeR;
        const rimT = Math.pow(Math.min(1, dDome / domeR), 1.7);
        let domeCol = mixRgb(baseRgb, darkRgb, rimT);
        const specGlow = Math.max(0, 1 - specDist * 1.15);
        domeCol = mixRgb(domeCol, brightRgb, specGlow * 0.78);
        if (pressed) {
          domeCol = mixRgb(domeCol, [255, 255, 255], 0.14);
        }
        blendPixel(rgba, idx, domeCol[0], domeCol[1], domeCol[2], cov);
      }
    }
  }

  const entry = encodeRgbaPng(size, size, rgba);
  BTN_CACHE.set(key, entry);
  return entry;
}

/**
 * Generates a crisp 96x96 3D pilot LED lamp PNG on transparent background
 * for Haiwell <SymbolType>image</SymbolType> BitLamp widgets.
 */
export function generateLedLampPng(
  baseHex: string,
  lit: boolean,
  size = 96
): { base64: string; md5: string } {
  const key = `${baseHex.toUpperCase()}_${lit ? '1' : '0'}_${size}`;
  const cached = LED_CACHE.get(key);
  if (cached) return cached;

  const baseRgb = parseHexRgb(baseHex);
  const darkRgb = mixRgb(baseRgb, [0, 0, 0], lit ? 0.32 : 0.52);
  const centerRgb = lit ? mixRgb(baseRgb, [255, 255, 255], 0.58) : mixRgb(baseRgb, [255, 255, 255], 0.18);
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const outerR = size * 0.45;
  const innerBezelR = size * 0.38;
  const lensR = size * 0.34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const dist = Math.hypot(dx, dy);

      // Outer brushed chrome bezel
      if (dist < outerR + 1.2) {
        const cov = Math.max(0, Math.min(1, outerR + 0.6 - dist));
        const grad = (x + y) / (2 * size);
        const bezel = mixRgb([241, 245, 249], [71, 85, 105], grad);
        blendPixel(rgba, idx, bezel[0], bezel[1], bezel[2], cov);
      }

      // Dark inner collar
      if (dist < innerBezelR + 1.0) {
        const cov = Math.max(0, Math.min(1, innerBezelR + 0.5 - dist));
        blendPixel(rgba, idx, 30, 41, 59, cov);
      }

      // Glossy radial LED lens
      if (dist < lensR + 1.0) {
        const cov = Math.max(0, Math.min(1, lensR + 0.5 - dist));
        const t = Math.pow(Math.min(1, dist / lensR), 1.45);
        let lens = mixRgb(centerRgb, darkRgb, t);
        const specDist = Math.hypot(dx + lensR * 0.33, dy + lensR * 0.33) / lensR;
        const spec = Math.max(0, 1 - specDist * 1.9);
        lens = mixRgb(lens, [255, 255, 255], spec * (lit ? 0.92 : 0.55));
        blendPixel(rgba, idx, lens[0], lens[1], lens[2], cov);
      }
    }
  }

  const entry = encodeRgbaPng(size, size, rgba);
  LED_CACHE.set(key, entry);
  return entry;
}
