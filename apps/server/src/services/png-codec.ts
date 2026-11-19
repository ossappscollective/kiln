import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A small PNG codec in pure TypeScript (no image library is installed and none is wanted: the input is hostile),
 * for the "fix" actions of the Assets tab (docs/adr/0012-assets-two-way-sync.md): flatten the alpha channel onto a
 * background, scale or crop to a required size, write the result again.
 *
 * Decoding handles NON-INTERLACED PNG files of bit depth 8 in every colour type (grey, RGB, palette with `tRNS`, grey
 * with alpha, RGBA), palette and grey images of 1, 2 and 4 bits, and the `tRNS` colour key of grey and RGB images. 16 bit
 * and interlaced (Adam7) files are refused with a message, never decoded wrongly. Every chunk is CRC checked, the decoded
 * size is bounded before anything is allocated (`MAX_PIXELS`), and zlib is told the largest output it may produce, so a
 * decompression bomb stops at the size the header promised.
 *
 * Encoding writes 8 bit RGB (no alpha) or RGBA, adaptive filtering (each row picks the filter with the smallest sum of
 * absolute values), and keeps the colour space chunks of the source (`sRGB`, `iCCP`, `gAMA`, `cHRM`, `pHYs`) so a
 * flattened file does not change colour.
 */

/** Pixels (width x height) accepted. 40 million is above anything a store takes (7680 x 4320 is 33 million). */
export const MAX_PIXELS = 40_000_000;

/** An image as 8 bit samples, `channels` per pixel: 3 (RGB) or 4 (RGBA), rows top to bottom, no padding. */
export type Raster = { width: number; height: number; channels: 3 | 4; data: Uint8Array };

export type PngMeta = {
  /** The chunks to copy to the output, whole (length, type, data, CRC). Colour space and density only. */
  keep: Uint8Array[];
  /** The image had transparency (an alpha channel, or `tRNS`). */
  hadAlpha: boolean;
};

export type DecodeResult =
  | { ok: true; raster: Raster; meta: PngMeta }
  | { ok: false; code: 'not_png' | 'unsupported' | 'corrupt' | 'too_large'; message: string };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, i: number): number =>
  (((b[i] as number) << 24) |
    ((b[i + 1] as number) << 16) |
    ((b[i + 2] as number) << 8) |
    (b[i + 3] as number)) >>>
  0;

const KEEP = new Set(['sRGB', 'iCCP', 'gAMA', 'cHRM', 'pHYs']);
const BAD = (message: string): DecodeResult => ({ ok: false, code: 'corrupt', message });

/** Samples per pixel of a colour type. */
const SAMPLES: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function decodePng(input: Uint8Array): DecodeResult {
  for (let i = 0; i < 8; i++)
    if (input[i] !== SIGNATURE[i])
      return { ok: false, code: 'not_png', message: 'The file is not a PNG.' };
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  const keep: Uint8Array[] = [];
  let sawIhdr = false;
  let sawIdat = false;
  let sawEnd = false;
  while (pos + 12 <= input.length && !sawEnd) {
    const length = u32(input, pos);
    const type = String.fromCharCode(
      input[pos + 4] as number,
      input[pos + 5] as number,
      input[pos + 6] as number,
      input[pos + 7] as number,
    );
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > input.length) return BAD('The PNG is cut off.');
    if (crc32(input, pos + 4, dataEnd) !== u32(input, dataEnd))
      return BAD(`The ${type} chunk of the PNG is damaged (bad checksum).`);
    const data = input.subarray(dataStart, dataEnd);
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) return BAD('The PNG does not start with its header.');
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8] as number;
      colour = data[9] as number;
      if (data[10] !== 0 || data[11] !== 0)
        return {
          ok: false,
          code: 'unsupported',
          message: 'This PNG uses a compression or filter method that does not exist.',
        };
      if (data[12] === 1)
        return {
          ok: false,
          code: 'unsupported',
          message:
            'Interlaced (Adam7) PNG files are not supported here. Export the image again without interlacing.',
        };
      if (data[12] !== 0) return BAD('The PNG header is damaged.');
      const allowed = DEPTHS[colour];
      if (!allowed || allowed.indexOf(depth) === -1)
        return BAD('The PNG header names a colour type or bit depth that does not exist.');
      if (depth === 16)
        return {
          ok: false,
          code: 'unsupported',
          message: 'A 16 bit PNG is not supported here. Export it as 8 bit.',
        };
      if (width < 1 || height < 1) return BAD('The PNG has no pixels.');
      if (width * height > MAX_PIXELS)
        return {
          ok: false,
          code: 'too_large',
          message: `The image is ${width} x ${height} px; at most ${MAX_PIXELS / 1_000_000} million pixels are handled here.`,
        };
      sawIhdr = true;
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      sawIdat = true;
      idatBytes += length;
      if (idatBytes > 64 * 1024 * 1024)
        return { ok: false, code: 'too_large', message: 'The image data is larger than 64 MB.' };
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
    } else if (KEEP.has(type) && !sawIdat) {
      keep.push(input.subarray(pos, dataEnd + 4));
    }
    pos = dataEnd + 4;
  }
  if (!sawIhdr || !sawIdat) return BAD('The PNG holds no image data.');
  if (
    colour === 3 &&
    (palette === null || palette.length === 0 || palette.length % 3 !== 0 || palette.length > 768)
  )
    return BAD('The PNG palette is missing or damaged.');

  const samples = SAMPLES[colour] as number;
  const bitsPerPixel = samples * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = (rowBytes + 1) * height;
  const joined = new Uint8Array(idatBytes);
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  let raw: Buffer;
  try {
    // A bomb stops at the size the header promised (one byte more is an error, not a truncation).
    raw = inflateSync(joined, { maxOutputLength: expected + 1 });
  } catch {
    return BAD('The image data of the PNG could not be decompressed.');
  }
  if (raw.length !== expected) return BAD('The image data of the PNG has the wrong length.');

  // Unfilter in place, row by row.
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)] as number;
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x] as number;
      const a = x >= bpp ? (out[dst + x - bpp] as number) : 0;
      const b = y > 0 ? (out[up + x] as number) : 0;
      const c = y > 0 && x >= bpp ? (out[up + x - bpp] as number) : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return BAD('The PNG uses a row filter that does not exist.');
      }
      out[dst + x] = r & 0xff;
    }
  }

  // To RGBA, 8 bit.
  const rgba = new Uint8Array(width * height * 4);
  const maxSample = (1 << depth) - 1;
  const scale = depth < 8 ? 255 / maxSample : 1;
  const sample = (row: number, index: number): number => {
    if (depth === 8) return out[row * rowBytes + index] as number;
    const bit = index * depth;
    const byte = out[row * rowBytes + (bit >> 3)] as number;
    return (byte >> (8 - depth - (bit & 7))) & maxSample;
  };
  const key = trns !== null && (colour === 0 || colour === 2) ? trns : null;
  const transparent =
    colour === 4 || colour === 6 || (colour === 3 && trns !== null) || key !== null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 0) {
        const g = sample(y, x);
        const v = Math.round(g * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] =
          key !== null && g === (((key[0] as number) << 8) | (key[1] as number)) ? 0 : 255;
      } else if (colour === 2) {
        const r = sample(y, x * 3);
        const g = sample(y, x * 3 + 1);
        const b = sample(y, x * 3 + 2);
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = key !== null && key[1] === r && key[3] === g && key[5] === b ? 0 : 255;
      } else if (colour === 3) {
        const i = sample(y, x);
        const p = palette as Uint8Array;
        if (i * 3 + 2 >= p.length) return BAD('A pixel of the PNG points outside its palette.');
        rgba[o] = p[i * 3] as number;
        rgba[o + 1] = p[i * 3 + 1] as number;
        rgba[o + 2] = p[i * 3 + 2] as number;
        rgba[o + 3] = trns !== null && i < trns.length ? (trns[i] as number) : 255;
      } else if (colour === 4) {
        const g = sample(y, x * 2);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = sample(y, x * 2 + 1);
      } else {
        rgba[o] = sample(y, x * 4);
        rgba[o + 1] = sample(y, x * 4 + 1);
        rgba[o + 2] = sample(y, x * 4 + 2);
        rgba[o + 3] = sample(y, x * 4 + 3);
      }
    }
  }
  return {
    ok: true,
    raster: { width, height, channels: 4, data: rgba },
    meta: { keep, hadAlpha: transparent },
  };
}

/** Whether any pixel of an RGBA raster is not fully opaque. */
export function hasTransparentPixels(r: Raster): boolean {
  if (r.channels !== 4) return false;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== 255) return true;
  return false;
}

/** Composites onto an opaque background colour: the result has 3 channels. Rounded, not truncated. */
export function flatten(r: Raster, background: readonly [number, number, number]): Raster {
  const n = r.width * r.height;
  const out = new Uint8Array(n * 3);
  if (r.channels === 3) {
    out.set(r.data);
    return { width: r.width, height: r.height, channels: 3, data: out };
  }
  for (let i = 0; i < n; i++) {
    const a = r.data[i * 4 + 3] as number;
    for (let c = 0; c < 3; c++) {
      const v = r.data[i * 4 + c] as number;
      out[i * 3 + c] =
        a === 255 ? v : Math.round((v * a + (background[c] as number) * (255 - a)) / 255);
    }
  }
  return { width: r.width, height: r.height, channels: 3, data: out };
}

// ---------------------------------------------------------------------------------------------
// Resampling

type Weights = { start: number; w: Float32Array }[];

/**
 * For each output index the source pixels that contribute and their weights: exact area coverage when the image
 * gets smaller (every source pixel counts in proportion to how much of it falls in the output pixel), linear
 * interpolation between the two nearest centres when it gets larger. `from`/`span` select the source window.
 */
function weights(dst: number, from: number, span: number, srcLen: number): Weights {
  const out: Weights = [];
  const scale = span / dst;
  for (let i = 0; i < dst; i++) {
    if (scale > 1) {
      const a = from + i * scale;
      const b = a + scale;
      const first = Math.max(0, Math.floor(a));
      const last = Math.min(srcLen - 1, Math.ceil(b) - 1);
      const w = new Float32Array(last - first + 1);
      let sum = 0;
      for (let s = first; s <= last; s++) {
        const cover = Math.min(b, s + 1) - Math.max(a, s);
        w[s - first] = cover > 0 ? cover : 0;
        sum += w[s - first] as number;
      }
      for (let k = 0; k < w.length; k++) w[k] = (w[k] as number) / sum;
      out.push({ start: first, w });
    } else {
      const centre = from + (i + 0.5) * scale - 0.5;
      const lo = Math.max(0, Math.min(srcLen - 1, Math.floor(centre)));
      const hi = Math.min(srcLen - 1, lo + 1);
      const t = Math.min(1, Math.max(0, centre - lo));
      out.push(
        hi === lo
          ? { start: lo, w: Float32Array.of(1) }
          : { start: lo, w: Float32Array.of(1 - t, t) },
      );
    }
  }
  return out;
}

/**
 * Scales the window (`x`, `y`, `w`, `h`) of the raster to `width` x `height`. Separable, in floating point; images with
 * alpha are resampled premultiplied so a transparent pixel's colour does not bleed.
 */
export function resample(
  r: Raster,
  win: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): Raster {
  const ch = r.channels;
  const premul = ch === 4;
  const wx = weights(width, win.x, win.w, r.width);
  const wy = weights(height, win.y, win.h, r.height);
  // Horizontal pass over the rows the window needs only.
  const rowsNeeded = new Set<number>();
  for (const w of wy) for (let k = 0; k < w.w.length; k++) rowsNeeded.add(w.start + k);
  const mid = new Map<number, Float32Array>();
  for (const y of rowsNeeded) {
    const row = new Float32Array(width * ch);
    for (let x = 0; x < width; x++) {
      const { start, w } = wx[x] as { start: number; w: Float32Array };
      for (let k = 0; k < w.length; k++) {
        const o = (y * r.width + start + k) * ch;
        const wk = w[k] as number;
        if (premul) {
          const a = (r.data[o + 3] as number) / 255;
          row[x * 4] = (row[x * 4] as number) + (r.data[o] as number) * a * wk;
          row[x * 4 + 1] = (row[x * 4 + 1] as number) + (r.data[o + 1] as number) * a * wk;
          row[x * 4 + 2] = (row[x * 4 + 2] as number) + (r.data[o + 2] as number) * a * wk;
          row[x * 4 + 3] = (row[x * 4 + 3] as number) + (r.data[o + 3] as number) * wk;
        } else {
          for (let c = 0; c < ch; c++)
            row[x * ch + c] = (row[x * ch + c] as number) + (r.data[o + c] as number) * wk;
        }
      }
    }
    mid.set(y, row);
  }
  const out = new Uint8Array(width * height * ch);
  const acc = new Float32Array(width * ch);
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    const { start, w } = wy[y] as { start: number; w: Float32Array };
    for (let k = 0; k < w.length; k++) {
      const row = mid.get(start + k) as Float32Array;
      const wk = w[k] as number;
      for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] as number) + (row[i] as number) * wk;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      if (premul) {
        const a = acc[x * 4 + 3] as number;
        const alpha = a / 255;
        for (let c = 0; c < 3; c++)
          out[o + c] = alpha > 0 ? clamp((acc[x * 4 + c] as number) / alpha) : 0;
        out[o + 3] = clamp(a);
      } else {
        for (let c = 0; c < ch; c++) out[o + c] = clamp(acc[x * ch + c] as number);
      }
    }
  }
  return { width, height, channels: ch, data: out };
}

const clamp = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** Scales to exactly `width` x `height`: the largest centred window with the target's aspect ratio is cropped, then scaled ("cover"). */
export function resizeCover(r: Raster, width: number, height: number): Raster {
  const target = width / height;
  const have = r.width / r.height;
  let w = r.width;
  let h = r.height;
  if (have > target) w = r.height * target;
  else h = r.width / target;
  return resample(r, { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h }, width, height);
}

// ---------------------------------------------------------------------------------------------
// Encoding

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
};

/** Filters one row with each of the five filters and keeps the one with the smallest sum of absolute (signed) values. */
function filterRows(r: Raster): Uint8Array {
  const ch = r.channels;
  const rowBytes = r.width * ch;
  const out = new Uint8Array((rowBytes + 1) * r.height);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  for (let y = 0; y < r.height; y++) {
    const row = r.data.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? r.data.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    const scores = [0, 0, 0, 0, 0];
    for (let x = 0; x < rowBytes; x++) {
      const v = row[x] as number;
      const a = x >= ch ? (row[x - ch] as number) : 0;
      const b = prev ? (prev[x] as number) : 0;
      const c = prev && x >= ch ? (prev[x - ch] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const f = [v, v - a, v - b, v - ((a + b) >> 1), v - paeth];
      for (let k = 0; k < 5; k++) {
        const byte = (f[k] as number) & 0xff;
        (candidates[k] as Uint8Array)[x] = byte;
        scores[k] = (scores[k] as number) + (byte < 128 ? byte : 256 - byte);
      }
    }
    let best = 0;
    for (let k = 1; k < 5; k++) if ((scores[k] as number) < (scores[best] as number)) best = k;
    out[y * (rowBytes + 1)] = best;
    out.set(candidates[best] as Uint8Array, y * (rowBytes + 1) + 1);
  }
  return out;
}

/** Writes an 8 bit RGB or RGBA PNG. `keep` are chunks of the source to carry over (colour space, density). */
export function encodePng(r: Raster, keep: readonly Uint8Array[] = []): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, r.width);
  view.setUint32(4, r.height);
  header[8] = 8;
  header[9] = r.channels === 4 ? 6 : 2;
  const idat = deflateSync(filterRows(r), { level: 9 });
  const parts: Uint8Array[] = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    ...keep,
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
