import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { planRow } from './link.ts';
import {
  apps,
  errorBody,
} from '../../../../../packages/connectors/src/revenuecat/revenuecat.fixtures.ts';
import { bootRevenueCat, json, PROJECT_ID, REVENUECAT_KEY } from './test-helpers.ts';

const q = (credentialId: string, projectId?: string) =>
  `credentialId=${credentialId}${projectId ? `&projectId=${projectId}` : ''}`;

dbTest(
  'detect lists the project and its apps; the one with this app’s bundle id is suggested; other stores are "not mapped"',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.addApp('ios');
    t.rc.seedApps(await t.identifierOf(appId));
    const res = await t.detect(appId, q(t.rcCredential));
    assert.equal(res.status, 200, res.text);
    const { options } = res.body;
    assert.deepEqual(options.projects, [{ id: PROJECT_ID, name: 'MagicWeather' }]);
    assert.equal(options.projectId, PROJECT_ID, 'the only project is chosen');
    const byType = Object.fromEntries(options.apps.map((a: { type: string }) => [a.type, a]));
    assert.deepEqual(
      [
        byType.app_store.suggested,
        byType.app_store.linkable,
        byType.app_store.matches,
        byType.app_store.note,
      ],
      [true, true, true, null],
    );
    // Another store of Apple does not fit an iOS app record, Play does not either; Stripe is not mapped at all.
    assert.equal(byType.play_store.linkable, false);
    assert.match(byType.play_store.note, /does not fit the store of this app/);
    assert.equal(byType.stripe.mapped, false);
    assert.equal(byType.stripe.linkable, false);
    assert.match(byType.stripe.note, /^Not mapped/);
    assert.equal(options.apps[0].type, 'app_store', 'the suggestion comes first');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
  },
);

dbTest(
  'detect with several projects asks for one; an unknown project or credential is a sentence',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.addApp('android');
    t.rc.seedApps(await t.identifierOf(appId));
    t.rc.projects = [...t.rc.projects, { object: 'project', id: 'proj2', name: 'Other' }];
    const first = await t.detect(appId, q(t.rcCredential));
    assert.equal(first.body.options.projectId, null);
    assert.equal(first.body.options.apps, null);
    assert.equal(first.body.options.projects.length, 2);
    const chosen = await t.detect(appId, q(t.rcCredential, PROJECT_ID));
    assert.equal(
      chosen.body.options.apps.find((a: { suggested: boolean }) => a.suggested).type,
      'play_store',
    );
    assert.equal((await t.detect(appId, q('nope'))).body.error, 'credential_not_found');
    const github = await t.addCredential();
    assert.equal((await t.detect(appId, q(github))).body.error, 'credential_kind');
    assert.equal((await t.detect(appId, '')).status, 400);
  },
);

dbTest(
  'a macOS app prefers the legacy Mac App Store app and also accepts the shared App Store app (universal purchase)',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.addApp('macos');
    const identifier = await t.identifierOf(appId);
    t.rc.seedApps(identifier);
    // The Mac App Store app has the identifier of this record: it wins over the shared App Store app of the same bundle id.
    t.rc.apps = [
      { ...apps.ios, app_store: { bundle_id: identifier } },
      { ...apps.mac, mac_app_store: { bundle_id: identifier } },
      { ...apps.play, play_store: { package_name: identifier } },
    ];
    const both = (await t.detect(appId, q(t.rcCredential))).body.options.apps;
    assert.equal(both[0].type, 'mac_app_store');
    assert.equal(both[0].suggested, true);
    assert.equal(both.find((a: { type: string }) => a.type === 'app_store').linkable, true);
    assert.equal(both.find((a: { type: string }) => a.type === 'app_store').suggested, false);
    assert.equal(both.find((a: { type: string }) => a.type === 'play_store').linkable, false);
    // A universal purchase has no Mac App Store app: the shared App Store app is the suggestion.
    t.rc.apps = [{ ...apps.ios, app_store: { bundle_id: identifier.toUpperCase() } }];
    const universal = (await t.detect(appId, q(t.rcCredential))).body.options.apps;
    assert.deepEqual(
      [universal[0].type, universal[0].suggested],
      ['app_store', true],
      'bundle ids match without regard to letter case',
    );
  },
);

dbTest('saving a link stores what RevenueCat said, audits it, and never the key', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.addApp('ios');
  t.rc.seedApps(await t.identifierOf(appId));
  assert.deepEqual((await t.call(t.owner, 'GET', t.base(appId))).body, {
    supported: true,
    link: null,
    sync: null,
  });
  const res = await t.put(appId, {
    credentialId: t.rcCredential,
    projectId: PROJECT_ID,
    revenueCatAppId: apps.ios.id,
  });
  assert.equal(res.status, 200, res.text);
  const { link } = res.body;
  assert.equal(link.projectName, 'MagicWeather');
  assert.equal(link.revenueCatAppName, 'Magic iOS');
  assert.equal(link.revenueCatAppType, 'app_store');
  assert.equal(link.revenueCatIdentifier, await t.identifierOf(appId));
  assert.equal(link.identifierMatches, true);
  assert.equal(link.credentialAvailable, true);
  assert.equal(link.credentialLabel, 'GitHub');
  const read = await t.call(t.owner, 'GET', t.base(appId));
  assert.deepEqual(read.body.link, link);
  const rows = await t.rcAudit();
  assert.deepEqual(
    rows.map((r) => r.action),
    ['credential.use', 'revenuecat.link_set'],
  );
  assert.ok(rows[0]?.detail.includes('revenuecat.link'));
  assert.ok(rows[1]?.detail.includes(apps.ios.id));
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
});

dbTest(
  'a macOS app record links to a Mac App Store app, or to the shared App Store app; a different bundle id is shown, not refused',
  async (db) => {
    const t = await bootRevenueCat(db);
    const mac = await t.linked('macos');
    const link = (await t.call(t.owner, 'GET', t.base(mac))).body.link;
    assert.equal(link.revenueCatAppType, 'mac_app_store');
    assert.equal(
      link.identifierMatches,
      false,
      'RevenueCat holds another bundle id: said, not refused',
    );
    const universal = await t.addApp('macos');
    t.rc.seedApps(await t.identifierOf(universal));
    const res = await t.put(universal, {
      credentialId: t.rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId: apps.ios.id,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.link.revenueCatAppType, 'app_store');
    assert.equal(res.body.link.identifierMatches, true);
  },
);

dbTest(
  'an app of another store, or one that does not fit the platform, cannot be linked: "not mapped", never an error that breaks anything',
  async (db) => {
    const t = await bootRevenueCat(db);
    const ios = await t.addApp('ios');
    t.rc.seedApps(await t.identifierOf(ios));
    const body = (revenueCatAppId: string) => ({
      credentialId: t.rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId,
    });
    const stripe = await t.put(ios, body(apps.stripe.id));
    assert.equal(stripe.status, 422);
    assert.equal(stripe.body.error, 'revenuecat_app_not_mapped');
    assert.match(stripe.body.message, /^Not mapped/);
    const play = await t.put(ios, body(apps.play.id));
    assert.equal(play.body.error, 'revenuecat_app_not_mapped');
    assert.match(play.body.message, /does not fit the store of this app/);
    const android = await t.addApp('android');
    assert.equal((await t.put(android, body(apps.ios.id))).body.error, 'revenuecat_app_not_mapped');
    assert.equal((await t.put(ios, body('nope'))).body.error, 'revenuecat_not_found');
    assert.equal(
      (await t.put(ios, { ...body(apps.ios.id), projectId: 'other' })).body.error,
      'revenuecat_not_found',
    );
    assert.equal((await t.call(t.owner, 'GET', t.base(ios))).body.link, null, 'nothing was saved');
  },
);

dbTest(
  'RevenueCat refusing the key while linking is a fixed sentence; a rate limit says when to try again',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.addApp('ios');
    t.rc.seedApps(await t.identifierOf(appId));
    const body = {
      credentialId: t.rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId: apps.ios.id,
    };
    t.rc.next.push(json(errorBody('authentication_error'), 401));
    const auth = await t.put(appId, body);
    assert.equal(auth.status, 422);
    assert.equal(auth.body.error, 'revenuecat_auth');
    t.rc.next.push(json(errorBody('authorization_error'), 403));
    assert.equal((await t.put(appId, body)).body.error, 'revenuecat_forbidden');
    t.rc.next.push(json({}, 429, { 'retry-after': '12' }));
    const limited = await t.put(appId, body);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '12');
    assert.equal(limited.body.retryAfterSeconds, 12);
    t.rc.next.push(json({}, 503));
    assert.equal((await t.put(appId, body)).status, 502);
    t.rc.next.push(new TypeError(`ECONNREFUSED ${REVENUECAT_KEY}`));
    const down = await t.put(appId, body);
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'revenuecat_unavailable');
    assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
  },
);

dbTest('the credential must be a RevenueCat credential of this workspace', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.addApp('ios');
  t.rc.seedApps(await t.identifierOf(appId));
  const github = await t.addCredential();
  const body = (credentialId: string) => ({
    credentialId,
    projectId: PROJECT_ID,
    revenueCatAppId: apps.ios.id,
  });
  assert.equal((await t.put(appId, body(github))).body.error, 'credential_kind');
  assert.equal((await t.put(appId, body('nope'))).body.error, 'credential_not_found');
  assert.equal(t.rc.calls.length, 0, 'RevenueCat was not asked');
  assert.equal((await t.put(appId, { ...body(t.rcCredential), extra: 1 })).status, 400);
  assert.equal((await t.put(appId, { credentialId: t.rcCredential })).status, 400);
});

dbTest(
  'rights: members read the link, only owners and admins change it; non-members get 404',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');
    for (const cookie of [member, viewer]) {
      assert.equal((await t.call(cookie, 'GET', t.base(appId))).status, 200);
      assert.equal((await t.call(cookie, 'GET', t.base(appId, '/products'))).status, 200);
      assert.equal((await t.put(appId, {}, cookie)).status, 403);
      assert.equal((await t.call(cookie, 'DELETE', t.base(appId))).status, 403);
      assert.equal((await t.detect(appId, q(t.rcCredential), cookie)).status, 403);
    }
    assert.equal(
      (await t.call(viewer, 'POST', t.base(appId, '/sync'))).status,
      403,
      'a viewer does not sync',
    );
    const outsider = await t.call(t.owner, 'GET', t.base(appId), undefined, 'other-workspace');
    assert.equal(outsider.status, 404);
    assert.equal((await t.call(t.owner, 'GET', t.base('nope'))).status, 404);
    assert.equal(
      (
        await t.put('nope', {
          credentialId: t.rcCredential,
          projectId: PROJECT_ID,
          revenueCatAppId: 'x',
        })
      ).status,
      404,
    );
  },
);

dbTest(
  'removing the link removes the stored copy too, audits it, and changes nothing at RevenueCat',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    assert.equal((await t.rcSync(appId)).status, 200);
    assert.ok((await db.query('SELECT 1 FROM revenuecat_products')).length > 0);
    const calls = t.rc.calls.length;
    assert.equal((await t.call(t.owner, 'DELETE', t.base(appId))).status, 204);
    for (const table of [
      'app_revenuecat_links',
      'revenuecat_products',
      'revenuecat_entitlements',
      'revenuecat_offerings',
      'revenuecat_sync',
    ]) {
      assert.equal((await db.query(`SELECT 1 FROM ${table}`)).length, 0, table);
    }
    assert.equal(t.rc.calls.length, calls, 'RevenueCat was not asked');
    assert.equal((await t.call(t.owner, 'DELETE', t.base(appId))).status, 404);
    assert.ok((await t.rcAudit()).some((a) => a.action === 'revenuecat.link_remove'));
    assert.equal((await t.rcSync(appId)).body.error, 'revenuecat_not_linked');
  },
);

dbTest(
  'relinking to another project or app clears the stored copy; saving the same link again keeps it',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    await t.rcSync(appId);
    const same = await t.put(appId, {
      credentialId: t.rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId: apps.ios.id,
    });
    assert.equal(same.status, 200);
    assert.ok(
      (await db.query('SELECT 1 FROM revenuecat_products')).length > 0,
      'the same link keeps its copy',
    );
    t.rc.apps = [
      ...t.rc.apps,
      { ...apps.ios, id: 'appios0002', app_store: { bundle_id: 'com.acme.other' } },
    ];
    const other = await t.put(appId, {
      credentialId: t.rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId: 'appios0002',
    });
    assert.equal(other.status, 200, other.text);
    assert.equal(other.body.link.identifierMatches, false);
    assert.equal(
      (await db.query('SELECT 1 FROM revenuecat_products')).length,
      0,
      'a copy of another app is not this one’s',
    );
    assert.equal((await db.query('SELECT 1 FROM revenuecat_sync')).length, 0);
  },
);

dbTest('a deleted credential leaves the link, which then says it cannot be used', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await db.execute('DELETE FROM credentials WHERE id = ?', [t.rcCredential]);
  const link = (await t.call(t.owner, 'GET', t.base(appId))).body.link;
  assert.equal(link.credentialAvailable, false);
  assert.equal(link.credentialLabel, null);
  const sync = await t.rcSync(appId);
  assert.equal(sync.status, 422);
  assert.equal(sync.body.error, 'credential_not_found');
  assert.equal(
    (await t.call(t.owner, 'GET', t.base(appId))).body.sync.failures,
    1,
    'the failure is kept for the screen',
  );
});

dbTest('the link routes are rate limited per workspace', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.addApp('ios');
  t.rc.seedApps(await t.identifierOf(appId));
  let last = 200;
  for (let i = 0; i < 25; i++) last = (await t.detect(appId, q(t.rcCredential))).status;
  assert.equal(last, 429);
});

const rcApp = (id: string, type: string, identifier: string | null) => ({
  id,
  name: id,
  type,
  store: type === 'stripe' ? null : (type as 'app_store' | 'mac_app_store' | 'play_store'),
  identifier,
});
const rec = (platform: 'ios' | 'android' | 'macos', identifier = 'com.acme.one') => ({
  id: `${platform}1`,
  name: 'One',
  platform,
  identifier,
});
const p1 = { id: 'p1', name: 'Alpha' };
const p2 = { id: 'p2', name: 'Beta' };

dbTest('planRow proposes the one app with this identifier and a fitting store type', async () => {
  const row = planRow(rec('ios', 'com.Acme.One'), [
    {
      project: p1,
      apps: [
        rcApp('a_play', 'play_store', 'com.acme.one'),
        rcApp('a_ios', 'app_store', 'com.acme.one'),
        rcApp('a_other', 'app_store', 'com.acme.two'),
        rcApp('a_stripe', 'stripe', 'com.acme.one'),
      ],
    },
  ]);
  assert.deepEqual(row.proposal, { projectId: 'p1', revenueCatAppId: 'a_ios' });
  assert.equal(row.ambiguous, false);
  // Only apps that fit the iOS store are offered: not the Play app, not Stripe.
  assert.deepEqual(row.candidates.map((c) => c.revenueCatAppId), ['a_ios', 'a_other']);
});

dbTest('planRow never picks when two projects match, or when nothing does', async () => {
  const twice = planRow(rec('android', 'com.acme.one'), [
    { project: p1, apps: [rcApp('x', 'play_store', 'com.acme.one')] },
    { project: p2, apps: [rcApp('y', 'play_store', 'com.acme.one')] },
  ]);
  assert.equal(twice.proposal, null);
  assert.equal(twice.ambiguous, true);
  assert.equal(twice.candidates.length, 2);
  // Package names are compared exactly, bundle ids are not.
  const none = planRow(rec('android', 'com.acme.one'), [
    { project: p1, apps: [rcApp('x', 'play_store', 'com.Acme.One')] },
  ]);
  assert.equal(none.proposal, null);
  assert.equal(none.ambiguous, false);
  assert.equal(none.candidates.length, 1, 'still offered to choose by hand');
});

dbTest('planRow prefers the Mac App Store app of a macOS record; a linked record is left alone', async () => {
  const row = planRow(rec('macos'), [
    {
      project: p1,
      apps: [rcApp('shared', 'app_store', 'com.acme.one'), rcApp('mac', 'mac_app_store', 'com.acme.one')],
    },
  ]);
  assert.equal(row.proposal?.revenueCatAppId, 'mac');
  const linked = planRow(rec('ios'), [{ project: p1, apps: [rcApp('a', 'app_store', 'com.acme.one')] }], true);
  assert.deepEqual([linked.linked, linked.proposal, linked.candidates], [true, null, []]);
});

dbTest('the plan route reads RevenueCat once and proposes a link per record; it saves nothing', async (db) => {
  const t = await bootRevenueCat(db);
  const ios = await t.addApp('ios');
  const android = await t.addApp('android');
  const done = await t.linked('ios');
  t.rc.seedApps(await t.identifierOf(ios));
  const res = await t.call(t.owner, 'GET', `/revenuecat/plan?credentialId=${t.rcCredential}`);
  assert.equal(res.status, 200, res.text);
  const rows = res.body.plan.rows as { appId: string; linked: boolean; proposal: unknown }[];
  const byId = Object.fromEntries(rows.map((r) => [r.appId, r]));
  assert.equal(byId[done]?.linked, true);
  assert.equal(byId[done]?.proposal, null);
  assert.ok((byId[ios]?.proposal as { projectId: string }).projectId === PROJECT_ID);
  assert.equal(byId[android]?.proposal, null, 'no RevenueCat app has its package name');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await db.query('SELECT 1 FROM app_revenuecat_links WHERE app_id = ?', [ios])).length, 0);
  assert.equal((await t.call(t.owner, 'GET', '/revenuecat/plan')).status, 400);
  assert.equal(
    (await t.call(t.owner, 'GET', '/revenuecat/plan?credentialId=nope')).body.error,
    'credential_not_found',
  );
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
});

dbTest('integration-links lists the linked records of both integrations (database only)', async (db) => {
  const t = await bootRevenueCat(db);
  const linked = await t.linked('ios');
  await t.addApp('android');
  const res = await t.call(t.owner, 'GET', '/integration-links');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { revenuecat: [linked], expo: [] });
});
