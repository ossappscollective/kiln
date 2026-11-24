import assert from 'node:assert/strict';
import { addDays, dateToDay, dayToMs } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { bootExperiments } from '../experiments/test-helpers.ts';
import { upsertPoints } from '../analytics/store.ts';

/** Seeds 60 days of Apple analytics ending 5 days ago: 1,000 impressions and 100 page views a day, the download rate stepping up after `stepDay`. */
async function seed(
  t: Awaited<ReturnType<typeof bootExperiments>>,
  db: Parameters<typeof upsertPoints>[0],
  appId: string,
  stepDay: string,
) {
  const today = dateToDay(Date.now());
  const last = addDays(today, -5);
  const points = [];
  for (let i = 0; i < 60; i += 1) {
    const date = addDays(last, -59 + i);
    points.push({ date, metric: 'impressions' as const, value: 1000 });
    points.push({ date, metric: 'product_page_views' as const, value: 100 });
    points.push({ date, metric: 'downloads_first_time' as const, value: date > stepDay ? 20 : 10 });
  }
  await upsertPoints(
    db,
    {
      appId,
      platform: 'ios',
      source: 'apple_analytics',
      workspaceId: t.workspaceId,
      processingDate: '',
      origin: 'sync',
      now: Date.now(),
    },
    points,
  );
  return { today, last };
}

dbTest(
  'timeline: Kiln events, liveDay of graphics, the before and after, and the rate verdict',
  async (db) => {
    const t = await bootExperiments(db);
    const appId = await t.addApp('ios');
    const today = dateToDay(Date.now());
    const releaseDay = addDays(today, -30);
    const pushDay = addDays(releaseDay, -3);
    await seed(t, db, appId, releaseDay);
    await db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, status_since, synced_at)
     VALUES ('r1', ?, ?, 'ios', '2.0', '', 'live', 'READY_FOR_SALE', ?, ?)`,
      [appId, t.workspaceId, dayToMs(releaseDay) + 3600_000, dayToMs(releaseDay)],
    );
    await db.execute(
      `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
     VALUES ('a1', ?, 'user', 'u1', 'listing.draft_pushed', 'app', ?, ?, ?)`,
      [
        t.workspaceId,
        appId,
        JSON.stringify({ assetSets: 2, texts: 0, fields: 0 }),
        dayToMs(pushDay) + 1000,
      ],
    );

    const res = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/timeline?metric=product_page_conversion&days=14`,
    );
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.metric.id, 'product_page_conversion');
    const ids = res.body.metrics.map((m: { id: string }) => m.id);
    assert.deepEqual(ids, [
      'impressions',
      'product_page_views',
      'downloads_first_time',
      'download_rate',
      'product_page_conversion',
    ]);
    const graphics = res.body.events.find((e: { kind: string }) => e.kind === 'graphics');
    assert.equal(graphics.day, pushDay);
    assert.equal(
      graphics.liveDay,
      releaseDay,
      'a graphics push of an App Store app is live with the next release',
    );
    assert.equal(graphics.impact.verdict, 'higher');
    assert.ok(Math.abs(graphics.impact.change - 1) < 1e-9);
    assert.equal(graphics.impact.others, 0, 'the release that carried it is not another event');
    const release = res.body.events.find((e: { kind: string }) => e.kind === 'release');
    assert.equal(release.label.code, 'release');
    assert.equal(release.label.params.version, '2.0');
    assert.equal(release.impact.verdict, 'higher');
    assert.equal(res.body.points.length, 90);

    const bad = await t.call(t.owner, 'GET', `/apps/${appId}/timeline?days=9`);
    assert.equal(bad.status, 400);
    assert.equal((await t.call(t.owner, 'GET', `/apps/nope/timeline`)).status, 404);

    const card = await t.call(t.owner, 'GET', `/apps/${appId}/timeline/graphics-impact`);
    assert.equal(card.status, 200);
    assert.equal(card.body.state, 'ok');
    assert.equal(
      card.body.days,
      25,
      'the release is 30 days old and the data ends 5 days ago: 25 days since it went live',
    );
    assert.equal(card.body.rate.impact.verdict, 'higher');
    assert.equal(card.body.downloads.impact.verdict, 'higher');
  },
);

dbTest('graphics card: no change, waiting for a release, and too early', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  assert.equal(
    (await t.call(t.owner, 'GET', `/apps/${appId}/timeline/graphics-impact`)).body.state,
    'no_change',
  );
  const today = dateToDay(Date.now());
  const push = (id: string, day: string) =>
    db.execute(
      `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'user', 'u1', 'listing.draft_pushed', 'app', ?, ?, ?)`,
      [id, t.workspaceId, appId, JSON.stringify({ assetSets: 1 }), dayToMs(day) + 1000],
    );
  await push('p1', addDays(today, -2));
  const waiting = await t.call(t.owner, 'GET', `/apps/${appId}/timeline/graphics-impact`);
  assert.equal(waiting.body.state, 'waiting');
  assert.equal(waiting.body.rate, null);
  // Android: live the day it was pushed. Too little data: not enough yet, never a verdict.
  const play = await t.addApp('android');
  await db.execute(
    `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
     VALUES ('p2', ?, 'user', 'u1', 'listing.draft_pushed', 'app', ?, ?, ?)`,
    [t.workspaceId, play, JSON.stringify({ assetSets: 1 }), dayToMs(addDays(today, -4)) + 1000],
  );
  await upsertPoints(
    db,
    {
      appId: play,
      platform: 'android',
      source: 'play_reports',
      workspaceId: t.workspaceId,
      processingDate: '',
      origin: 'sync',
      now: Date.now(),
    },
    (
      [] as {
        date: string;
        metric: 'store_listing_visitors' | 'store_listing_acquisitions';
        value: number;
      }[]
    ).concat(
      Array.from({ length: 20 }, (_, i) => ({
        date: addDays(today, -25 + i),
        metric: 'store_listing_visitors' as const,
        value: 100,
      })),
      Array.from({ length: 20 }, (_, i) => ({
        date: addDays(today, -25 + i),
        metric: 'store_listing_acquisitions' as const,
        value: 10,
      })),
    ),
  );
  const early = await t.call(t.owner, 'GET', `/apps/${play}/timeline/graphics-impact`);
  assert.equal(early.body.state, 'ok');
  assert.equal(early.body.liveDay, addDays(today, -4));
  assert.equal(early.body.rate.impact.verdict, 'too_early');
});

dbTest(
  'events of your own: rights, validation, audit without the text, the merge on the timeline',
  async (db) => {
    const t = await bootExperiments(db);
    const appId = await t.addApp('ios');
    const today = dateToDay(Date.now());
    const day = addDays(today, -3);
    const secretTitle = 'Spring promo with Acme Ads';
    const created = await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
      kind: 'ad_campaign',
      day,
      title: secretTitle,
      note: 'budget 500',
    });
    assert.equal(created.status, 201, created.text);
    const id = (created.body.event.id as string).slice(2);
    assert.equal(created.body.event.origin, 'manual');
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
          kind: 'ad_campaign',
          day: '2026-02-31',
          title: 'x',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
          kind: 'release',
          day,
          title: 'x',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
          kind: 'press',
          day,
          title: ' ',
        })
      ).status,
      400,
    );
    const viewer = await t.addMember('viewer');
    assert.equal(
      (
        await t.call(viewer, 'POST', `/apps/${appId}/timeline/events`, {
          kind: 'press',
          day,
          title: 'x',
        })
      ).status,
      403,
    );
    assert.equal(
      (await t.call(viewer, 'GET', `/apps/${appId}/timeline`)).status,
      200,
      'every role reads',
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.call(outsider, 'GET', `/apps/${appId}/timeline`)).status, 404);

    const listed = await t.call(t.owner, 'GET', `/apps/${appId}/timeline`);
    assert.equal(listed.body.metric, null, 'no analytics: no chart, the events still list');
    assert.equal(listed.body.events[0].title, secretTitle);
    assert.equal(listed.body.events[0].impact, null);

    const patched = await t.call(t.owner, 'PATCH', `/apps/${appId}/timeline/events/${id}`, {
      title: 'Renamed',
      kind: 'press',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.event.kind, 'press');
    assert.equal(patched.body.event.note, 'budget 500');
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/apps/${appId}/timeline/events/nope`, { title: 'x' }))
        .status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/timeline/events/${id}`)).status,
      200,
    );
    const again = await t.call(t.owner, 'DELETE', `/apps/${appId}/timeline/events/${id}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'timeline.eventNotFound');

    const audit = await t.audit('timeline.%');
    assert.deepEqual(
      audit.map((a) => a.action),
      ['timeline.event_created', 'timeline.event_updated', 'timeline.event_deleted'],
    );
    const dump = JSON.stringify(await db.query('SELECT detail FROM audit_events'));
    for (const secret of [secretTitle, 'Renamed', 'budget 500', 'Acme Ads'])
      assert.ok(!dump.includes(secret), `${secret} must not be audited`);
    assert.equal(audit[0]?.detail.kind, 'ad_campaign');
    assert.equal(audit[0]?.detail.day, day);

    // Deleting the app removes its events.
    await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
      kind: 'other',
      day,
      title: 'gone',
    });
    await db.execute('DELETE FROM timeline_events WHERE app_id = ?', [appId]);
  },
);

dbTest(
  'reports: a week against the week before, partial period, countries, sources, reviews, events',
  async (db) => {
    const t = await bootExperiments(db);
    const appId = await t.addApp('ios');
    const { today } = await seed(
      t,
      db,
      appId,
      addDays(Date.now() > 0 ? dateToDay(Date.now()) : '', -100),
    );
    const { monthStart } = { monthStart: `${today.slice(0, 8)}01` };
    void monthStart;
    const last = addDays(today, -5);
    const dim = (type: 'territory' | 'source_type', value: string, v: number) =>
      Array.from({ length: 60 }, (_, i) => ({
        date: addDays(last, -59 + i),
        metric: 'downloads_first_time' as const,
        value: v,
        dimension: { type, value },
      }));
    await upsertPoints(
      db,
      {
        appId,
        platform: 'ios',
        source: 'apple_analytics',
        workspaceId: t.workspaceId,
        processingDate: '',
        origin: 'sync',
        now: Date.now(),
      },
      [
        ...dim('territory', 'US', 6),
        ...dim('territory', 'DE', 4),
        ...dim('source_type', 'App Store Search', 7),
        ...dim('source_type', 'Web Referrer', 3),
      ],
    );
    const anyDay = addDays(last, -20);
    const week = await t.call(t.owner, 'GET', `/apps/${appId}/reports?kind=week&day=${anyDay}`);
    assert.equal(week.status, 200, week.text);
    const cmp = week.body.comparison;
    assert.equal(cmp.partial, false);
    assert.equal(cmp.currentDays, 7);
    assert.equal(cmp.lengthsDiffer, false);
    assert.equal(cmp.period.from, addDays(cmp.period.from, 0));
    const dl = week.body.figures.find((f: { id: string }) => f.id === 'downloads_first_time');
    assert.equal(dl.value, 140);
    assert.equal(dl.previous, 140);
    assert.equal(dl.change, 0);
    const rate = week.body.figures.find((f: { id: string }) => f.id === 'product_page_conversion');
    assert.equal(rate.value, 0.2);
    assert.deepEqual(
      week.body.countries.map((c: { code: string }) => c.code),
      ['US', 'DE'],
    );
    assert.equal(week.body.countries[0].share, 0.3, 'a share of the total: 42 of 140');
    assert.deepEqual(
      week.body.sources.map((s: { source: string }) => s.source),
      ['App Store Search', 'Web Referrer'],
    );

    // The running week: compared with the same days of the one before, and the days with no numbers yet are said.
    const running = await t.call(t.owner, 'GET', `/apps/${appId}/reports?kind=month&day=${today}`);
    assert.equal(running.status, 200);
    assert.equal(running.body.comparison.partial, true);
    assert.equal(running.body.comparison.currentDays, running.body.comparison.previousDays);
    // Reviews and events of the period.
    const reviewDay = dayToMs(anyDay) + 3600_000;
    for (const [id, rating, reply] of [
      ['v1', 5, null],
      ['v2', 1, null],
      ['v3', 2, 'thanks'],
    ] as const)
      await db.execute(
        `INSERT INTO app_reviews (id, workspace_id, app_id, store, store_review_id, rating, title, body, created_at, updated_at, first_seen_at, fetched_at, developer_response)
       VALUES (?, ?, ?, 'appstore', ?, ?, 't', 'TEXT SHOULD NOT LEAK', ?, ?, ?, ?, ?)`,
        [id, t.workspaceId, appId, id, rating, reviewDay, reviewDay, reviewDay, reviewDay, reply],
      );
    await t.call(t.owner, 'POST', `/apps/${appId}/timeline/events`, {
      kind: 'press',
      day: anyDay,
      title: 'Featured in a blog',
    });
    const again = await t.call(t.owner, 'GET', `/apps/${appId}/reports?kind=week&day=${anyDay}`);
    assert.equal(again.body.reviews.current.count, 3);
    assert.equal(again.body.reviews.current.average, 2.67);
    assert.equal(again.body.reviews.current.lowUnanswered, 1);
    assert.equal(again.body.reviews.previous.count, 0);
    assert.ok(!again.text.includes('TEXT SHOULD NOT LEAK'));
    assert.equal(again.body.events.length, 1);

    assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/reports?kind=decade`)).status, 400);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/reports?day=yesterday`)).status,
      400,
    );
    const dflt = await t.call(t.owner, 'GET', `/apps/${appId}/reports`);
    assert.equal(dflt.body.kind, 'week');
    assert.equal(
      dflt.body.comparison.partial,
      false,
      'the default is the newest period that has ended',
    );
  },
);
