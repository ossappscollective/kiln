import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@kiln/db/testing';
import { mapSearchResults, safeIconUrl } from './competitor-search.ts';
import { bootAso, OWN_IOS_ID, publicApp, slowDown } from './test-helpers.ts';

// Hand-written fixtures in the shape of PublicApp (what the connector yields); no real Apple answer was used.

test('mapSearchResults: capped plain text, https icons, own and followed marked, duplicates and bad ids dropped', () => {
  const rows = mapSearchResults(
    [
      publicApp('111', {
        iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/x/512x512bb.jpg',
        name: '  Rival <b>One</b>\n',
        developer: 'Acme Ltd',
        category: 'Health & Fitness',
        ratingMilli: 4567,
        ratingCount: 12,
      }),
      publicApp('111'),
      publicApp('222', { iconUrl: 'http://example.invalid/a.png', price: '$4.99' }),
      publicApp('333', { name: '' }),
      publicApp('not-a-number'),
      publicApp(OWN_IOS_ID),
      publicApp('444', { name: 'x'.repeat(500), ratingMilli: 9000 }),
    ],
    { ownId: OWN_IOS_ID, followed: new Set(['222']) },
  );
  assert.deepEqual(
    rows.map((r) => [r.externalId, r.state]),
    [
      ['111', 'available'],
      ['222', 'followed'],
      [OWN_IOS_ID, 'own'],
      ['444', 'available'],
    ],
  );
  assert.equal(rows[0]?.name, 'Rival b One /b');
  assert.equal(rows[0]?.ratingAverage, 4.57);
  assert.equal(rows[0]?.iconUrl, 'https://is1-ssl.mzstatic.com/image/thumb/x/512x512bb.jpg');
  assert.equal(rows[2]?.iconUrl, null);
  assert.equal(safeIconUrl('https://example.invalid/a.png'), null);
  assert.equal(rows[1]?.iconUrl, null);
  assert.equal(rows[1]?.price, '$4.99');
  assert.equal(rows[3]?.name.length, 120);
  assert.equal(rows[3]?.ratingAverage, null);
  assert.equal(safeIconUrl('https://user:pw@example.invalid/a.png'), null);
  assert.equal(safeIconUrl('javascript:alert(1)'), null);
});

dbTest(
  'search route: results with state, cached country, errors, rights, nothing stored',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    t.sources.appResults.set('de|pomodoro', [
      publicApp('555', { developer: 'Focus GmbH', category: 'Productivity' }),
      publicApp(OWN_IOS_ID),
    ]);
    const url = (q: string, c = 'de') =>
      `/apps/${appId}/aso/competitors/search?q=${encodeURIComponent(q)}&country=${c}`;
    const ok = await t.call(t.owner, 'GET', url('Pomodoro'));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.country, 'de');
    assert.deepEqual(
      ok.body.results.map((r: { state: string }) => r.state),
      ['available', 'own'],
    );
    assert.deepEqual(t.sources.appSearches[0], {
      platform: 'ios',
      term: 'Pomodoro',
      country: 'de',
      limit: 10,
    });
    // Follow it, then the same search says so (in that storefront only).
    t.sources.setApp('ios', 'de', publicApp('555'));
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
          externalId: '555',
          country: 'de',
        })
      ).status,
      201,
    );
    assert.equal((await t.call(t.owner, 'GET', url('Pomodoro'))).body.results[0].state, 'followed');
    t.sources.appResults.set('us|pomodoro', [publicApp('555')]);
    assert.equal(
      (await t.call(t.owner, 'GET', url('Pomodoro', 'us'))).body.results[0].state,
      'available',
    );
    // Bad input.
    assert.equal((await t.call(t.owner, 'GET', url('a'))).status, 400);
    assert.equal((await t.call(t.owner, 'GET', url('ab', 'zzz'))).status, 400);
    // The store asks to slow down: 429 with Retry-After, no raw store text.
    t.sources.searchError = slowDown(30);
    const slow = await t.call(t.owner, 'GET', url('Pomodoro'));
    assert.equal(slow.status, 429);
    t.sources.searchError = undefined;
    // A viewer may not search (it reads the public store); a Google Play app has no search.
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', url('Pomodoro'))).status, 403);
    const play = await t.addApp('android');
    const refused = await t.call(t.owner, 'GET', `/apps/${play}/aso/competitors/search?q=pomodoro`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'search_app_store_only');
    assert.equal(t.sources.appSearches.length, 4);
  },
);
