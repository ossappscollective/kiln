import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { readImageHeader } from '@mrm/core';
import { chunk, makePng, rgbaPng, rgbPng } from './png-test-helpers.ts';
import {
  decodePng,
  encodePng,
  flatten,
  hasTransparentPixels,
  resample,
  resizeCover,
} from './services/png-codec.ts';

const px = (r: { data: Uint8Array; width: number }, x: number, y: number, n = 4) =>
  Array.from(r.data.slice((y * r.width + x) * n, (y * r.width + x) * n + n));

test('decodes RGBA with every row filter', () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    const png = rgbaPng(5, 4, (x, y) => [x * 40, y * 60, (x * y * 7) & 255, 255 - x * 10], filter);
    const d = decodePng(png);
    assert.ok(d.ok, `filter ${filter}`);
    if (!d.ok) return;
    assert.deepEqual(px(d.raster, 3, 2), [120, 120, 42, 225]);
    assert.deepEqual(px(d.raster, 0, 0), [0, 0, 0, 255]);
    assert.equal(d.meta.hadAlpha, true);
  }
});

test('decodes RGB, grey, grey alpha and palette with tRNS', () => {
  const rgb = decodePng(rgbPng(2, 2, (x, y) => [x * 100, y * 100, 7]));
  assert.ok(rgb.ok);
  if (rgb.ok) {
    assert.deepEqual(px(rgb.raster, 1, 1), [100, 100, 7, 255]);
    assert.equal(rgb.meta.hadAlpha, false);
  }
  const grey = decodePng(
    makePng({ width: 3, height: 1, colour: 0, rows: [Uint8Array.from([0, 128, 255])] }),
  );
  assert.ok(grey.ok);
  if (grey.ok) assert.deepEqual(px(grey.raster, 1, 0), [128, 128, 128, 255]);
  const ga = decodePng(
    makePng({
      width: 2,
      height: 1,
      colour: 4,
      rows: [Uint8Array.from([10, 255, 200, 64])],
      filter: 1,
    }),
  );
  assert.ok(ga.ok);
  if (ga.ok) {
    assert.deepEqual(px(ga.raster, 1, 0), [200, 200, 200, 64]);
    assert.equal(ga.meta.hadAlpha, true);
  }
  const pal = decodePng(
    makePng({
      width: 3,
      height: 1,
      colour: 3,
      rows: [Uint8Array.from([0, 1, 2])],
      plte: [255, 0, 0, 0, 255, 0, 0, 0, 255],
      trns: [255, 128],
    }),
  );
  assert.ok(pal.ok);
  if (pal.ok) {
    assert.deepEqual(px(pal.raster, 1, 0), [0, 255, 0, 128]);
    assert.deepEqual(px(pal.raster, 2, 0), [0, 0, 255, 255]);
    assert.equal(pal.meta.hadAlpha, true);
  }
});

test('decodes palette and grey images of fewer than 8 bits and the tRNS colour key', () => {
  // 4 pixels of 2 bits: indexes 0 1 2 3 packed into one byte 0b00_01_10_11.
  const pal = decodePng(
    makePng({
      width: 4,
      height: 1,
      colour: 3,
      depth: 2,
      rows: [Uint8Array.from([0b00011011])],
      plte: [0, 0, 0, 10, 10, 10, 20, 20, 20, 30, 30, 30],
    }),
  );
  assert.ok(pal.ok);
  if (pal.ok)
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => px(pal.raster, x, 0)[0]),
      [0, 10, 20, 30],
    );
  const grey1 = decodePng(
    makePng({ width: 8, height: 1, colour: 0, depth: 1, rows: [Uint8Array.from([0b10100000])] }),
  );
  assert.ok(grey1.ok);
  if (grey1.ok)
    assert.deepEqual(
      [0, 1, 2].map((x) => px(grey1.raster, x, 0)[0]),
      [255, 0, 255],
    );
  const key = decodePng(
    makePng({
      width: 2,
      height: 1,
      colour: 2,
      rows: [Uint8Array.from([1, 2, 3, 9, 9, 9])],
      trns: [0, 1, 0, 2, 0, 3],
    }),
  );
  assert.ok(key.ok);
  if (key.ok) {
    assert.equal(px(key.raster, 0, 0)[3], 0);
    assert.equal(px(key.raster, 1, 0)[3], 255);
  }
});

test('refuses what it cannot decode, with a message', () => {
  const sixteen = makePng({ width: 1, height: 1, colour: 2, depth: 16, rows: [new Uint8Array(6)] });
  const a = decodePng(sixteen);
  assert.ok(!a.ok && a.code === 'unsupported' && /16 bit/.test(a.message));
  const adam = decodePng(
    makePng({ width: 1, height: 1, colour: 2, rows: [new Uint8Array(3)], interlace: 1 }),
  );
  assert.ok(!adam.ok && adam.code === 'unsupported' && /nterlaced/.test(adam.message));
  const notPng = decodePng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]));
  assert.ok(!notPng.ok && notPng.code === 'not_png');
  const good = rgbPng(2, 2, () => [1, 2, 3]);
  const cut = decodePng(good.subarray(0, good.length - 20));
  assert.ok(!cut.ok && cut.code === 'corrupt');
  const bad = Buffer.from(good);
  bad[bad.length - 20] = (bad[bad.length - 20] as number) ^ 0xff; // inside the IDAT data or its checksum
  const damaged = decodePng(bad);
  assert.ok(!damaged.ok && damaged.code === 'corrupt');
  const huge = decodePng(makePng({ width: 9000, height: 9000, colour: 0, depth: 1, rows: [] }));
  assert.ok(!huge.ok && huge.code === 'too_large');
});

test('a decompression bomb is stopped at the size the header promised', () => {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(4, 0);
  head.writeUInt32BE(4, 4);
  head[8] = 8;
  head[9] = 2;
  const bomb = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.alloc(50_000_000))),
    chunk('IEND', new Uint8Array(0)),
  ]);
  const d = decodePng(bomb);
  assert.ok(!d.ok && d.code === 'corrupt');
});

test('flatten composites on the background and drops the alpha channel', () => {
  const d = decodePng(
    rgbaPng(
      3,
      1,
      (x) =>
        [
          [255, 0, 0, 255],
          [0, 0, 0, 0],
          [0, 0, 255, 128],
        ][x] as [number, number, number, number],
    ),
  );
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(hasTransparentPixels(d.raster), true);
  const white = flatten(d.raster, [255, 255, 255]);
  assert.equal(white.channels, 3);
  assert.deepEqual(px(white, 0, 0, 3), [255, 0, 0]);
  assert.deepEqual(px(white, 1, 0, 3), [255, 255, 255]);
  assert.deepEqual(px(white, 2, 0, 3), [127, 127, 255]);
  const black = flatten(d.raster, [0, 0, 0]);
  assert.deepEqual(px(black, 1, 0, 3), [0, 0, 0]);
  assert.deepEqual(px(black, 2, 0, 3), [0, 0, 128]);
});

test('encode then decode gives the same pixels; the header reader sees no alpha in an RGB file', () => {
  const src = decodePng(rgbaPng(16, 9, (x, y) => [x * 15, y * 28, (x + y) * 5, 255]));
  assert.ok(src.ok);
  if (!src.ok) return;
  const rgb = flatten(src.raster, [255, 255, 255]);
  const bytes = encodePng(rgb);
  const header = readImageHeader(bytes);
  assert.ok(
    header.ok &&
      header.format === 'png' &&
      header.width === 16 &&
      header.height === 9 &&
      header.hasAlpha === false,
  );
  const back = decodePng(bytes);
  assert.ok(back.ok);
  if (back.ok)
    assert.deepEqual(
      Array.from(back.raster.data.filter((_, i) => i % 4 !== 3)),
      Array.from(rgb.data),
    );
  // And RGBA round trips too.
  const again = decodePng(encodePng(src.raster));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(Array.from(again.raster.data), Array.from(src.raster.data));
});

test('colour space chunks are kept, transparency chunks are not', () => {
  const srgb = chunk('sRGB', Uint8Array.from([0]));
  const png = makePng({
    width: 1,
    height: 1,
    colour: 3,
    rows: [Uint8Array.from([0])],
    plte: [1, 2, 3],
    trns: [0],
    extra: [srgb],
  });
  const d = decodePng(png);
  assert.ok(d.ok);
  if (!d.ok) return;
  const out = Buffer.from(encodePng(flatten(d.raster, [255, 255, 255]), d.meta.keep));
  assert.ok(out.includes('sRGB'));
  assert.ok(!out.includes('tRNS'));
  assert.ok(!out.includes('PLTE'));
});

test('resample: a constant image stays constant, downscale averages, upscale interpolates', () => {
  const flat = decodePng(rgbPng(8, 8, () => [10, 200, 30]));
  assert.ok(flat.ok);
  if (!flat.ok) return;
  const small = resample(flat.raster, { x: 0, y: 0, w: 8, h: 8 }, 3, 5);
  assert.equal(small.width, 3);
  assert.equal(small.height, 5);
  assert.ok(
    Array.from({ length: 15 }, (_, i) => px(small, i % 3, Math.floor(i / 3), 4)).every(
      (p) => p[0] === 10 && p[1] === 200 && p[2] === 30,
    ),
  );
  // A black and white checker of 2x2 blocks averages to mid grey when scaled by 2.
  const checker = decodePng(
    rgbPng(4, 4, (x, y) => (((x >> 1) + (y >> 1)) & 1 ? [255, 255, 255] : [0, 0, 0])),
  );
  assert.ok(checker.ok);
  if (!checker.ok) return;
  const half = resample(checker.raster, { x: 0, y: 0, w: 4, h: 4 }, 2, 2);
  assert.deepEqual(px(half, 0, 0, 4).slice(0, 3), [0, 0, 0]);
  assert.deepEqual(px(half, 1, 0, 4).slice(0, 3), [255, 255, 255]);
  const quarter = resample(checker.raster, { x: 0, y: 0, w: 4, h: 4 }, 1, 1);
  assert.equal(px(quarter, 0, 0, 4)[0], 128);
  // Upscaling a left black, right white pair gives a ramp in between and keeps the ends.
  const pair = decodePng(rgbPng(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255])));
  assert.ok(pair.ok);
  if (!pair.ok) return;
  const wide = resample(pair.raster, { x: 0, y: 0, w: 2, h: 1 }, 8, 1);
  const ramp = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => px(wide, x, 0, 4)[0] as number);
  assert.equal(ramp[0], 0);
  assert.equal(ramp[7], 255);
  assert.ok(ramp.every((v, i) => i === 0 || v >= (ramp[i - 1] as number)));
});

test('resizeCover reaches the exact size and crops the long side from the centre', () => {
  // 8x4 image: left half red, right half blue; cover into 2x2 keeps the middle 4x4 (half red, half blue).
  const src = decodePng(rgbPng(8, 4, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255])));
  assert.ok(src.ok);
  if (!src.ok) return;
  const out = resizeCover(src.raster, 2, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual(px(out, 0, 0).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(px(out, 1, 1).slice(0, 3), [0, 0, 255]);
  const tall = resizeCover(src.raster, 4, 8);
  assert.equal(tall.width, 4);
  assert.equal(tall.height, 8);
});

test('premultiplied resampling does not bleed the colour of a transparent pixel', () => {
  const src = decodePng(rgbaPng(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0])));
  assert.ok(src.ok);
  if (!src.ok) return;
  const one = resample(src.raster, { x: 0, y: 0, w: 2, h: 1 }, 1, 1);
  assert.deepEqual(px(one, 0, 0), [255, 0, 0, 128]);
});
