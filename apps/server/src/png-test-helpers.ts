import { deflateSync } from 'node:zlib';
import { crc32 } from './services/png-codec.ts';

/** Fixture PNG files made in the tests (no binary file is checked in). */

export const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
};

export type PngSpec = {
  width: number;
  height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey alpha, 6 RGBA. */
  colour: 0 | 2 | 3 | 4 | 6;
  depth?: 1 | 2 | 4 | 8 | 16;
  /** Raw samples of each row (packed for depths under 8), before filtering. */
  rows: Uint8Array[];
  plte?: number[];
  trns?: number[];
  /** Filter byte of every row (default 0); the rows are filtered with it, so the decoder must undo it. */
  filter?: number;
  interlace?: 0 | 1;
  extra?: Buffer[];
};

/** Applies PNG filter `type` to one row. */
function filterRow(row: Uint8Array, prev: Uint8Array | null, bpp: number, type: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let x = 0; x < row.length; x++) {
    const a = x >= bpp ? (row[x - bpp] as number) : 0;
    const b = prev ? (prev[x] as number) : 0;
    const c = prev && x >= bpp ? (prev[x - bpp] as number) : 0;
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    const pred = [0, a, b, (a + b) >> 1, paeth][type] as number;
    out[x] = ((row[x] as number) - pred) & 0xff;
  }
  return out;
}

export function makePng(spec: PngSpec): Buffer {
  const depth = spec.depth ?? 8;
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[spec.colour];
  const bpp = Math.max(1, (samples * depth) >> 3);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(spec.width, 0);
  head.writeUInt32BE(spec.height, 4);
  head[8] = depth;
  head[9] = spec.colour;
  head[12] = spec.interlace ?? 0;
  const type = spec.filter ?? 0;
  const raw: number[] = [];
  spec.rows.forEach((row, y) => {
    raw.push(type, ...filterRow(row, y > 0 ? (spec.rows[y - 1] as Uint8Array) : null, bpp, type));
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    ...(spec.extra ?? []),
    ...(spec.plte ? [chunk('PLTE', Uint8Array.from(spec.plte))] : []),
    ...(spec.trns ? [chunk('tRNS', Uint8Array.from(spec.trns))] : []),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A solid RGBA image where the pixel at (x, y) is `pixel(x, y)`. */
export function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], filter = 0): Buffer {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), x * 4);
    rows.push(row);
  }
  return makePng({ width, height, colour: 6, rows, filter });
}

export function rgbPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filter = 0): Buffer {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 3);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), x * 3);
    rows.push(row);
  }
  return makePng({ width, height, colour: 2, rows, filter });
}
