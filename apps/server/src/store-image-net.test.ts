import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rgbPng } from './png-test-helpers.ts';
import type { Exchange, ExchangeRequest } from './services/safe-fetch.ts';
import { downloadStoreImage, imageUrlOf, isStoreImageHost } from './services/store-image-net.ts';

const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
const png = rgbPng(3, 2, () => [1, 2, 3]);
const ok = (body: Uint8Array, headers: Record<string, string> = {}) => ({ status: 200, headers, body, overflow: false });

test('hosts: Apple and Google image hosts only, subdomains included, nothing that merely ends alike', () => {
  for (const h of ['is1.mzstatic.com', 'mzstatic.com', 'play-lh.googleusercontent.com', 'lh3.ggpht.com']) assert.equal(isStoreImageHost(h), true, h);
  for (const h of ['evilmzstatic.com', 'mzstatic.com.evil.test', 'localhost', '127.0.0.1', 'googleusercontent.com.evil.test', 'example.com']) assert.equal(isStoreImageHost(h), false, h);
});

test('imageUrlOf fills Apple’s template, keeps Google’s url, and refuses anything else', () => {
  const apple = { url: 'https://is1.mzstatic.com/image/thumb/AbC/{w}x{h}bb.{f}', urlKind: 'apple_template' as const, width: 1320, height: 2868 };
  assert.equal(imageUrlOf(apple), 'https://is1.mzstatic.com/image/thumb/AbC/1320x2868bb.png');
  assert.equal(imageUrlOf(apple, { maxSide: 478, format: 'jpg' }), 'https://is1.mzstatic.com/image/thumb/AbC/220x478bb.jpg');
  assert.equal(imageUrlOf({ ...apple, width: null }), null);
  assert.equal(imageUrlOf({ ...apple, url: 'http://is1.mzstatic.com/x/{w}x{h}bb.{f}' }), null, 'plain http');
  assert.equal(imageUrlOf({ ...apple, url: 'https://evil.test/{w}x{h}bb.{f}' }), null, 'another host');
  assert.equal(imageUrlOf({ ...apple, url: 'https://user:pw@is1.mzstatic.com/x/{w}x{h}bb.{f}' }), null, 'credentials in the url');
  assert.equal(imageUrlOf({ ...apple, url: 'https://is1.mzstatic.com:8443/x/{w}x{h}bb.{f}' }), null, 'a port');
  assert.equal(imageUrlOf({ url: 'https://play-lh.googleusercontent.com/abc', urlKind: 'play_url', width: null, height: null }), 'https://play-lh.googleusercontent.com/abc');
  assert.equal(imageUrlOf({ url: 'file:///etc/passwd', urlKind: 'play_url', width: null, height: null }), null);
});

test('downloads an image, sniffs it from its bytes and hashes it; the answer header is not trusted', async () => {
  const seen: ExchangeRequest[] = [];
  const exchange: Exchange = async (r) => {
    seen.push(r);
    return ok(png, { 'content-type': 'text/html' });
  };
  const out = await downloadStoreImage({ resolve, exchange }, 'https://is1.mzstatic.com/a/1x1bb.png');
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.format, 'png');
    assert.deepEqual([out.width, out.height], [3, 2]);
    assert.equal(out.sha256.length, 64);
  }
  assert.equal(seen[0]?.url.hostname, 'is1.mzstatic.com');
  assert.equal(seen[0]?.headers.cookie, undefined);
  assert.equal(seen[0]?.headers.authorization, undefined);
});

test('refuses: a host off the list, plain http, a redirect to another host, an oversize body, a non image', async () => {
  const never: Exchange = async () => {
    throw new Error('must not connect');
  };
  const a = await downloadStoreImage({ resolve, exchange: never }, 'https://evil.test/a.png');
  assert.ok(!a.ok && a.code === 'blocked' && /evil\.test/.test(a.message));
  const b = await downloadStoreImage({ resolve, exchange: never }, 'http://is1.mzstatic.com/a.png');
  assert.ok(!b.ok && b.code === 'blocked');
  let calls = 0;
  const redirect: Exchange = async () => {
    calls++;
    return { status: 302, headers: { location: 'https://evil.test/steal' }, body: new Uint8Array(0), overflow: false };
  };
  const c = await downloadStoreImage({ resolve, exchange: redirect }, 'https://is1.mzstatic.com/a.png');
  assert.ok(!c.ok && c.code === 'blocked');
  assert.equal(calls, 1, 'the redirect target was never contacted');
  const big: Exchange = async () => ({ status: 200, headers: {}, body: new Uint8Array(10), overflow: true });
  const d = await downloadStoreImage({ resolve, exchange: big }, 'https://is1.mzstatic.com/a.png', { maxBytes: 5 });
  assert.ok(!d.ok && d.code === 'too_large');
  const html: Exchange = async () => ok(new TextEncoder().encode('<html>not an image at all</html>'), { 'content-type': 'image/png' });
  const e = await downloadStoreImage({ resolve, exchange: html }, 'https://is1.mzstatic.com/a.png');
  assert.ok(!e.ok && e.code === 'not_an_image');
  const privateResolve = async () => [{ address: '10.0.0.5', family: 4 as const }];
  const f = await downloadStoreImage({ resolve: privateResolve, exchange: never }, 'https://is1.mzstatic.com/a.png');
  assert.ok(!f.ok && f.code === 'blocked');
  const limited: Exchange = async () => ({ status: 429, headers: { 'retry-after': '12' }, body: new Uint8Array(0), overflow: false });
  const g = await downloadStoreImage({ resolve, exchange: limited }, 'https://is1.mzstatic.com/a.png');
  assert.ok(!g.ok && g.code === 'rate_limited' && g.retryAfter === 12);
});
