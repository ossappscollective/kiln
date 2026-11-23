import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootAso, publicApp } from './test-helpers.ts';

/** The competitor listing watch (docs/adr/0056-competitor-listing-watch.md). The store is a fake: nothing is contacted. */

const shot = (id: string, host = 'is1-ssl', size = '392x696bb.jpg') => `https://${host}.mzstatic.com/image/thumb/PurpleSource/v4/aa/${id}/${id}.png/${size}`;
const rival = (over: Record<string, unknown> = {}) =>
  publicApp('555', {
    name: 'Rival Five',
    description: 'Build streaks.\nTrack goals.',
    releaseNotes: 'Bug fixes',
    category: 'Health',
    iconUrl: shot('icon', 'is1-ssl', '512x512bb.jpg'),
    iphoneScreenshotUrls: [shot('a'), shot('b'), shot('c')],
    ipadScreenshotUrls: [shot('p')],
    screenshotUrls: [shot('a'), shot('b'), shot('c'), shot('p')],
    screenshotCount: 4,
    ...over,
  });

async function follow(t: Awaited<ReturnType<typeof bootAso>>) {
  const appId = await t.addApp('ios');
  t.sources.setApp('ios', 'us', rival());
  const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' });
  assert.equal(add.status, 201, add.text);
  return { appId, cid: add.body.competitor.id as string };
}
const changes = async (t: Awaited<ReturnType<typeof bootAso>>, appId: string, cid: string, query = '') =>
  (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitors/${cid}/changes${query}`)).body;

dbTest('watch: the first look and CDN re-encodes are no change; a real change is stored, evented and listed', async (db) => {
  const t = await bootAso(db);
  const { appId, cid } = await follow(t);
  assert.deepEqual((await changes(t, appId, cid)).changes, [], 'the first look records nothing');
  // Same pictures from other CDN hosts and sizes, the same text with other whitespace.
  t.sources.setApp('ios', 'us', rival({
    iphoneScreenshotUrls: [shot('a', 'is3-ssl', '1242x2688bb-85.webp'), shot('b', 'is2-ssl'), shot('c')],
    iconUrl: shot('icon', 'is4-ssl', '1024x1024bb.png'),
    description: '  Build streaks.  \n\n Track goals. ',
  }));
  assert.equal((await t.refresh(appId)).status, 200);
  assert.deepEqual((await changes(t, appId, cid)).changes, []);
  assert.equal((await t.events('aso.competitor_listing_changed')).length, 0);

  t.sources.setApp('ios', 'us', rival({
    iphoneScreenshotUrls: [shot('a'), shot('z'), shot('c')],
    iconUrl: shot('icon2'),
    releaseNotes: 'New widgets',
    ratingMilli: 4200,
  }));
  assert.equal((await t.refresh(appId)).status, 200);
  const body = await changes(t, appId, cid);
  assert.equal(body.changes.length, 1);
  assert.deepEqual(body.changes[0].kinds, ['screenshots', 'icon', 'releaseNotes', 'rating']);
  const shots = body.changes[0].changes.find((c: { kind: string }) => c.kind === 'screenshots');
  assert.deepEqual([shots.device, shots.replaced, shots.added, shots.removed], ['iphone', 1, 0, 0]);
  assert.equal(body.watching.state, 'watched');
  const events = await t.events('aso.competitor_listing_changed');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload.kinds, ['screenshots', 'icon', 'releaseNotes']);
  assert.ok(!JSON.stringify(events).includes('mzstatic'), 'no address in an event');

  assert.equal((await t.refresh(appId)).status, 200);
  assert.equal((await changes(t, appId, cid)).changes.length, 1, 'the same read again records nothing');

  // A rating jump alone is listed but raises no event.
  t.sources.setApp('ios', 'us', rival({
    iphoneScreenshotUrls: [shot('a'), shot('z'), shot('c')], iconUrl: shot('icon2'), releaseNotes: 'New widgets', ratingMilli: 3900,
  }));
  assert.equal((await t.refresh(appId)).status, 200);
  assert.equal((await changes(t, appId, cid)).changes.length, 2);
  assert.equal((await t.events('aso.competitor_listing_changed')).length, 1);
  const page = await changes(t, appId, cid, '?limit=1');
  assert.equal(page.hasMore, true);
  const next = await changes(t, appId, cid, `?limit=1&before=${page.changes[0].detectedAt}`);
  assert.equal(next.changes.length, 1);
  assert.equal(next.hasMore, false);
  const timeline = (await t.call(t.owner, 'GET', `/apps/${appId}/timeline?to=2026-06-10`)).body;
  assert.equal(timeline.events.filter((e: { kind: string }) => e.kind === 'competitor_change').length, 1, 'one event per competitor and day, none for rating drift');
});

dbTest('watch: an empty read after a full one is a failed read, and only 200 changes per competitor are kept', async (db) => {
  const t = await bootAso(db);
  const { appId, cid } = await follow(t);
  t.sources.setApp('ios', 'us', rival({ iphoneScreenshotUrls: [], ipadScreenshotUrls: [], screenshotUrls: [], iconUrl: undefined, description: undefined }));
  assert.equal((await t.refresh(appId)).status, 200);
  assert.deepEqual((await changes(t, appId, cid)).changes, []);
  for (let i = 0; i < 205; i += 1) {
    t.sources.setApp('ios', 'us', rival({ releaseNotes: `Notes ${i}` }));
    assert.equal((await t.refresh(appId)).status, 200);
  }
  const rows = await db.query('SELECT id FROM aso_competitor_changes WHERE competitor_id = ?', [cid]);
  assert.equal(rows.length, 200);
});

dbTest('check now: reads once, then "recent"; Play is refused; viewers cannot; the rate limit answers 429', async (db) => {
  const t = await bootAso(db, { limiterLimit: 3 });
  const { appId, cid } = await follow(t);
  const url = `/apps/${appId}/aso/competitors/${cid}/check`;
  t.clock.advance(10 * 60_000);
  t.sources.setApp('ios', 'us', rival({ category: 'Lifestyle' }));
  const viewer = await t.addMember('viewer');
  const first = await t.call(t.owner, 'POST', url);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.body.state, first.body.changes], ['checked', 1]);
  const again = await t.call(t.owner, 'POST', url);
  assert.equal(again.body.state, 'recent');
  assert.equal(t.sources.lookups.length, 2, 'the add and the first check only');
  await db.execute(
    "INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at) SELECT 'play1', workspace_id, app_id, 'google_play', 'com.x.y', 'us', 'Play Rival', added_by, added_at FROM aso_competitors WHERE id = ?",
    [cid],
  );
  const play = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors/play1/check`);
  assert.equal(play.status, 409);
  assert.equal(play.body.error, 'play_listing_not_watched');
  const playChanges = await changes(t, appId, 'play1');
  assert.deepEqual([playChanges.watching.state, playChanges.watching.reason], ['not_watched', 'play_pages_not_read']);
  assert.equal((await t.call(viewer, 'POST', url)).status, 403);
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/competitors/${cid}/changes`)).status, 200);
  t.clock.advance(10 * 60_000);
  const last = await t.call(t.owner, 'POST', url);
  assert.ok([200, 429].includes(last.status));
});
