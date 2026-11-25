import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { rgbPng } from '../../png-test-helpers.ts';
import type { ExchangeRequest } from '../../services/safe-fetch.ts';
import {
  COMPETITOR_IMAGE_REF,
  COMPETITOR_IMAGE_SIZES,
  isAppleImageHost,
  renditionUrl,
} from './competitor-images.ts';
import { bootAso, publicApp } from './test-helpers.ts';

/** The competitor image proxy (docs/adr/0056-competitor-listing-watch.md). The CDN is a fake exchange: nothing is contacted. */

const png = rgbPng(3, 2, () => [1, 2, 3]);
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
const shot = (id: string) =>
  `https://is1-ssl.mzstatic.com/image/thumb/PurpleSource/v4/aa/${id}/${id}.png/392x696bb.jpg`;

test('hosts and addresses: https on mzstatic.com only; a rendition segment is resized, nothing else is touched', () => {
  for (const h of ['mzstatic.com', 'is1-ssl.mzstatic.com'])
    assert.equal(isAppleImageHost(h), true, h);
  for (const h of [
    'evilmzstatic.com',
    'mzstatic.com.evil.test',
    'googleusercontent.com',
    'localhost',
    '127.0.0.1',
  ])
    assert.equal(isAppleImageHost(h), false, h);
  assert.equal(
    renditionUrl(shot('a'), 160),
    'https://is1-ssl.mzstatic.com/image/thumb/PurpleSource/v4/aa/a/a.png/160x160bb.jpg',
  );
  assert.equal(
    renditionUrl('https://is1-ssl.mzstatic.com/us/r30/Purple/screen696x696.jpeg?x=1#y', 160),
    'https://is1-ssl.mzstatic.com/us/r30/Purple/screen696x696.jpeg',
  );
  for (const bad of [
    'http://is1-ssl.mzstatic.com/a/1x1bb.jpg',
    'https://evil.test/a/1x1bb.jpg',
    'https://u:p@is1-ssl.mzstatic.com/a.jpg',
    'https://is1-ssl.mzstatic.com:8443/a.jpg',
    'https://127.0.0.1/a.jpg',
    'not a url',
  ])
    assert.equal(renditionUrl(bad, 160), null, bad);
  assert.deepEqual([...COMPETITOR_IMAGE_SIZES], [96, 160, 320, 640]);
});

test('refs: only the stored grammar passes; an address, a path or a traversal never does', () => {
  for (const ok of [
    'icon',
    's.p.0',
    's.i.12',
    'c.0d4f5a7e-1111-2222-3333-444455556666.b.p.3',
    'c.0d4f5a7e-1111-2222-3333-444455556666.a.icon.0',
  ])
    assert.equal(COMPETITOR_IMAGE_REF.test(ok), true, ok);
  for (const bad of [
    '',
    'https://is1.mzstatic.com/a.jpg',
    '../icon',
    's.x.1',
    's.p.123',
    'c.x.b.p.1',
    'icon\n',
    'c.0d4f5a7e-1111-2222-3333-444455556666.z.p.1',
    '//evil.test',
  ])
    assert.equal(COMPETITOR_IMAGE_REF.test(bad), false, JSON.stringify(bad));
});

async function boot(
  exchange: (req: ExchangeRequest) => Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    body: Uint8Array;
    overflow: boolean;
  }>,
  imageLimit?: number,
) {
  const t = await bootAso(db_, {
    net: { resolve, exchange },
    ...(imageLimit !== undefined ? { imageLimit } : {}),
  });
  return t;
}
let db_: Database;

const raw = (
  t: Awaited<ReturnType<typeof bootAso>>,
  path: string,
  cookie = t.owner,
  headers: Record<string, string> = {},
) => t.app.request(`/api/workspaces/${t.workspaceId}${path}`, { headers: { cookie, ...headers } });

dbTest(
  'the proxy serves only stored refs, from mzstatic.com, capped, sniffed, cached and per workspace limited',
  async (db) => {
    db_ = db;
    const requested: string[] = [];
    let mode: 'png' | 'html' | 'big' = 'png';
    const t = await boot(async (req) => {
      requested.push(`${req.url.hostname}${req.url.pathname}`);
      if (mode === 'big')
        return {
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array(10),
          overflow: true,
        };
      return {
        status: 200,
        headers: { 'content-type': mode === 'html' ? 'text/html' : 'image/png' },
        body: mode === 'html' ? new TextEncoder().encode('<html>') : png,
        overflow: false,
      };
    }, 6);
    const appId = await t.addApp('ios');
    t.sources.setApp(
      'ios',
      'us',
      publicApp('555', {
        iconUrl: shot('icon'),
        iphoneScreenshotUrls: [shot('a'), shot('b')],
        ipadScreenshotUrls: [],
        screenshotUrls: [shot('a'), shot('b')],
      }),
    );
    const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
      externalId: '555',
    });
    const cid = add.body.competitor.id as string;
    const url = (ref: string, extra = '') =>
      `/apps/${appId}/aso/competitors/${cid}/image?ref=${encodeURIComponent(ref)}${extra}`;

    const ok = await raw(t, url('s.p.1', '&size=160'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('cache-control') ?? '', /^private,.*stale-while-revalidate/);
    assert.deepEqual(requested, [
      'is1-ssl.mzstatic.com/image/thumb/PurpleSource/v4/aa/b/b.png/160x160bb.jpg',
    ]);
    const etag = ok.headers.get('etag') ?? '';
    assert.equal(
      (await raw(t, url('s.p.1', '&size=160'), t.owner, { 'if-none-match': etag })).status,
      304,
    );
    assert.equal((await raw(t, url('s.p.1', '&size=160'))).status, 200);
    assert.equal(requested.length, 1, 'the second read came from the cache');
    assert.equal((await raw(t, url('icon'))).status, 200);

    // Validation and unknown refs: nothing is fetched.
    const before = requested.length;
    assert.equal((await raw(t, url('https://evil.test/x.png'))).status, 400);
    assert.equal((await raw(t, url('s.p.9'))).status, 404, 'no such screenshot');
    assert.equal((await raw(t, url('s.i.0'))).status, 404, 'no iPad screenshot stored');
    assert.equal((await raw(t, `/apps/${appId}/aso/competitors/nope/image?ref=icon`)).status, 404);
    assert.equal((await raw(t, `/apps/${appId}/aso/competitors/${cid}/image`)).status, 400);
    assert.equal(requested.length, before);

    // A stored address that is not Apple's CDN (nothing like it can be stored by the watch, but the proxy does not trust the table).
    await db.execute('UPDATE aso_competitors SET listing_state = ? WHERE id = ?', [
      JSON.stringify({
        icon: 'https://evil.test/i.png',
        iphone: ['http://is1.mzstatic.com/a.png'],
        ipad: [],
      }),
      cid,
    ]);
    assert.equal((await raw(t, url('icon'))).status, 422);
    assert.equal((await raw(t, url('s.p.0'))).status, 422);
    assert.equal(requested.length, before);

    // The body is checked: something that is not an image, or too large, is refused.
    await db.execute('UPDATE aso_competitors SET listing_state = ? WHERE id = ?', [
      JSON.stringify({ icon: shot('other'), iphone: [shot('c')], ipad: [] }),
      cid,
    ]);
    mode = 'html';
    const html = await raw(t, url('icon'));
    assert.equal(html.status, 422);
    assert.equal(JSON.parse(await html.text()).error, 'image_not_an_image');
    mode = 'big';
    assert.equal(JSON.parse(await (await raw(t, url('s.p.0'))).text()).error, 'image_too_large');

    // Another workspace member without aso.read cannot; a viewer can read.
    const viewer = await t.addMember('viewer');
    mode = 'png';
    assert.equal((await raw(t, url('s.p.0', '&size=320'), viewer)).status, 200);
    assert.equal((await raw(t, url('s.p.0'), 'kiln_session=nope')).status, 401);
    // The per workspace budget (6 fetches in this test): the rest is 429 with Retry-After.
    let limited = 0;
    for (const size of [96, 640, 320, 160, 96]) {
      const res = await raw(t, url('s.p.0', `&size=${size}`));
      if (res.status === 429) {
        limited += 1;
        assert.ok(res.headers.get('retry-after'));
      }
    }
    assert.ok(limited > 0);
  },
);

dbTest('the search icon proxy only serves refs the search handed out, for this app', async (db) => {
  db_ = db;
  const t = await boot(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: png,
    overflow: false,
  }));
  const appId = await t.addApp('ios');
  t.sources.appResults.set('us|habit', [
    publicApp('111', { name: 'Habit One', iconUrl: shot('icon') }),
    publicApp('222', { name: 'Habit Two', iconUrl: 'http://example.invalid/i.png' }),
  ]);
  const found = await t.call(
    t.owner,
    'GET',
    `/apps/${appId}/aso/competitors/search?q=habit&country=us`,
  );
  assert.equal(found.status, 200, found.text);
  const [one, two] = found.body.results;
  assert.match(one.iconRef, /^[0-9a-f]{32}$/);
  assert.equal(two.iconRef, null);
  assert.equal(
    (await raw(t, `/apps/${appId}/aso/competitors/search-image?ref=${one.iconRef}`)).status,
    200,
  );
  assert.equal(
    (await raw(t, `/apps/${appId}/aso/competitors/search-image?ref=${'0'.repeat(32)}`)).status,
    404,
  );
  assert.equal(
    (await raw(t, `/apps/${appId}/aso/competitors/search-image?ref=https://evil.test/a.png`))
      .status,
    400,
  );
  const other = await t.addApp('ios');
  assert.equal(
    (await raw(t, `/apps/${other}/aso/competitors/search-image?ref=${one.iconRef}`)).status,
    404,
    'a ref belongs to the app it was given for',
  );
  const viewer = await t.addMember('viewer');
  assert.equal(
    (await raw(t, `/apps/${appId}/aso/competitors/search-image?ref=${one.iconRef}`, viewer)).status,
    403,
    'searching needs aso.write',
  );
});
