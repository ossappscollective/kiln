import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readImageHeader } from '@kiln/core';
import { rgbaPng, rgbPng } from './png-test-helpers.ts';
import { fixImage, parseHexColour } from './services/image-fix.ts';

const slot = { kind: 'screenshot' as const, device: 'iphone_6_9' };

test('remove_alpha flattens on white by default and the header reader agrees', () => {
  const png = rgbaPng(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : [10, 20, 30, 255]));
  assert.equal(
    readImageHeader(png).ok && (readImageHeader(png) as { hasAlpha: boolean }).hasAlpha,
    true,
  );
  const out = fixImage({
    platform: 'ios',
    slot,
    name: 'shot.png',
    bytes: png,
    kind: 'remove_alpha',
  });
  assert.ok(out.ok);
  if (!out.ok) return;
  const h = readImageHeader(out.bytes);
  assert.ok(h.ok && h.hasAlpha === false && h.width === 4 && h.height === 4);
  assert.equal(out.name, 'shot.png');
  assert.match(out.summary, /#ffffff/);
  const black = fixImage({
    platform: 'ios',
    slot,
    name: 'shot.png',
    bytes: png,
    kind: 'remove_alpha',
    background: parseHexColour('#000000'),
  });
  assert.ok(black.ok);
});

test('remove_alpha refuses a file without alpha, a JPEG and a 16 bit PNG, each with a reason', () => {
  const rgb = fixImage({
    platform: 'ios',
    slot,
    name: 'a.png',
    bytes: rgbPng(2, 2, () => [1, 2, 3]),
    kind: 'remove_alpha',
  });
  assert.ok(!rgb.ok && rgb.code === 'nothing_to_fix');
  const jpeg = fixImage({
    platform: 'ios',
    slot,
    name: 'a.jpg',
    bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0, 0, 0, 0, 0, 0]),
    kind: 'remove_alpha',
  });
  assert.ok(!jpeg.ok && jpeg.code === 'not_png' && /JPEG/.test(jpeg.message));
  const junk = fixImage({
    platform: 'ios',
    slot,
    name: 'a.png',
    bytes: Uint8Array.from([1, 2, 3]),
    kind: 'resize',
  });
  assert.ok(!junk.ok && junk.code === 'not_png');
});

test('rename_extension keeps the bytes', () => {
  const png = rgbPng(2, 2, () => [1, 2, 3]);
  const out = fixImage({
    platform: 'ios',
    slot,
    name: 'shot.jpg',
    bytes: png,
    kind: 'rename_extension',
  });
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.name, 'shot.png');
    assert.equal(out.bytes, png);
  }
  const same = fixImage({
    platform: 'ios',
    slot,
    name: 'shot.png',
    bytes: png,
    kind: 'rename_extension',
  });
  assert.ok(!same.ok && same.code === 'nothing_to_fix');
});

test('resize goes to the nearest required size; a range-only slot says so', () => {
  const png = rgbPng(660, 1434, () => [9, 9, 9]); // half of 1320 x 2868
  const out = fixImage({ platform: 'ios', slot, name: 'shot.png', bytes: png, kind: 'resize' });
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.width, 1320);
    assert.equal(out.height, 2868);
    const h = readImageHeader(out.bytes);
    assert.ok(h.ok && h.width === 1320);
  }
  const play = fixImage({
    platform: 'android',
    slot: { kind: 'screenshot', device: 'phone' },
    name: 'a.png',
    bytes: png,
    kind: 'resize',
  });
  assert.ok(!play.ok && play.code === 'no_target_size' && /320 to 3840/.test(play.message));
  const feature = fixImage({
    platform: 'android',
    slot: { kind: 'feature_graphic', device: null },
    name: 'f.png',
    bytes: rgbPng(2048, 1000, () => [1, 1, 1]),
    kind: 'resize',
  });
  assert.ok(feature.ok);
  if (feature.ok) assert.deepEqual([feature.width, feature.height], [1024, 500]);
});

test('parseHexColour', () => {
  assert.deepEqual(parseHexColour('#ff8000'), [255, 128, 0]);
  assert.equal(parseHexColour('red'), undefined);
});

test('a resize never adds an alpha channel to an image that has none', () => {
  const out = fixImage({
    platform: 'ios',
    slot: { kind: 'screenshot', device: 'iphone_6_5' },
    name: 'a.png',
    bytes: rgbPng(621, 1344, () => [5, 6, 7]),
    kind: 'resize',
  });
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.hasAlpha, false);
    const header = readImageHeader(out.bytes);
    assert.ok(header.ok && header.hasAlpha === false);
  }
});
