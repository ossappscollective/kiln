import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreImageRecord } from '@kiln/connectors';
import { checkStoreImages } from '@kiln/core';
import { rgbPng } from '../../png-test-helpers.ts';
import type { Exchange, ExchangeRequest } from '../../services/safe-fetch.ts';
import { imageUrlOf } from './store-image-net.ts';
import {
  clearStoreImageCaches,
  probeMissingSizes,
  type StoreImagesContext,
} from './store-images.ts';

/**
 * Google serves a downscaled rendition of an image unless its address carries a size option. The fake CDN does the same: the plain
 * address is 512x250, `=s0` is the original 1024x500. A size must come from the original, never from the rendition.
 */
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
const fake = () => {
  const seen: ExchangeRequest[] = [];
  const exchange: Exchange = async (request) => {
    seen.push(request);
    const original = request.url.pathname.endsWith('=s0');
    const body = new Uint8Array(
      rgbPng(original ? 1024 : 512, original ? 500 : 250, () => [10, 20, 30]),
    );
    return {
      status: 200,
      headers: { 'content-length': String(body.length) },
      body,
      overflow: false,
    };
  };
  return { seen, exchange };
};
const record = (over: Partial<StoreImageRecord> = {}): StoreImageRecord => ({
  locale: 'en-US',
  kind: 'feature_graphic',
  device: null,
  target: 'featureGraphic',
  position: 1,
  id: 'img1',
  name: null,
  width: null,
  height: null,
  bytes: null,
  checksum: 'ab'.repeat(32),
  checksumKind: 'sha256',
  state: null,
  url: 'https://lh3.googleusercontent.com/abc123',
  urlKind: 'play_url',
  ...over,
});

test('an address of Google gets the original size option, a thumbnail its own, an existing option is replaced', () => {
  const src = {
    url: 'https://lh3.googleusercontent.com/abc=w512-h250',
    urlKind: 'play_url' as const,
    width: null,
    height: null,
  };
  assert.equal(imageUrlOf(src, { original: true }), 'https://lh3.googleusercontent.com/abc=s0');
  assert.equal(imageUrlOf(src, { maxSide: 160 }), 'https://lh3.googleusercontent.com/abc=s160');
});

test('probe: the size comes from the original file, so a 1024x500 feature graphic has no size error', async () => {
  clearStoreImageCaches();
  const cdn = fake();
  const images = [record()];
  const ctx = { net: { resolve, exchange: cdn.exchange } } as unknown as StoreImagesContext;
  const done = await probeMissingSizes(ctx, 'w1', 'a1', images);
  assert.deepEqual(done, { probed: 1, failed: 0 });
  assert.ok(
    cdn.seen.every((r) => r.url.pathname.endsWith('=s0')),
    'only the original size is ever read',
  );
  assert.equal(cdn.seen[0]?.headers.range, 'bytes=0-196607');
  assert.equal(images[0]?.width, 1024);
  assert.equal(images[0]?.height, 500);
  assert.equal(images[0]?.sizeFrom, 'header');
  const problems = checkStoreImages({
    platform: 'android',
    sets: [
      {
        platform: 'android',
        locale: 'en-US',
        kind: 'feature_graphic',
        device: null,
        deviceLabel: 'Feature graphic',
        target: 'featureGraphic',
        files: images.map((i) => ({
          ref: 'r',
          position: 1,
          name: i.name,
          width: i.width,
          height: i.height,
          bytes: i.bytes,
          sizeFrom: i.sizeFrom ?? null,
          checksum: null,
          checksumKind: null,
          state: null,
          downloadable: true,
        })),
      },
    ],
  });
  assert.equal(problems.filter((p) => p.severity === 'error').length, 0);
});

test('probe: a second read uses the cache, a failing host leaves the image unchecked', async () => {
  clearStoreImageCaches();
  const cdn = fake();
  const ctx = { net: { resolve, exchange: cdn.exchange } } as unknown as StoreImagesContext;
  await probeMissingSizes(ctx, 'w1', 'a1', [record()]);
  const again = [record()];
  await probeMissingSizes(ctx, 'w1', 'a1', again);
  assert.equal(cdn.seen.length, 1);
  assert.equal(again[0]?.width, 1024);
  clearStoreImageCaches();
  const down = {
    net: {
      resolve,
      exchange: (async () => ({
        status: 500,
        headers: {},
        body: new Uint8Array(0),
        overflow: false,
      })) as Exchange,
    },
  } as unknown as StoreImagesContext;
  const lost = [record({ id: 'img2' })];
  assert.deepEqual(await probeMissingSizes(down, 'w1', 'a1', lost), { probed: 0, failed: 1 });
  assert.equal(lost[0]?.width, null);
});
