import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { can } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { ASC_SECRET, bootExperiments, customPage, experiment } from './test-helpers.ts';

/** The line of the private key, as a store error could echo it. */
const KEY_LINE = (JSON.parse(ASC_SECRET) as { privateKey: string }).privateKey.split('\n')[1] ?? '';

dbTest('before a sync there is nothing; Google Play has no API and a tracker only', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  const res = await t.list(appId);
  assert.equal(res.status, 200);
  assert.equal(res.body.api, true);
  assert.deepEqual(res.body.experiments, []);
  assert.deepEqual(res.body.customPages, []);
  assert.deepEqual(res.body.notes, []);
  assert.equal(res.body.sync, null);
  assert.equal(res.body.app.store, 'appstoreconnect');
  assert.equal(t.store.reads, 0, 'reading the list asks no store');

  const play = await t.addApp('android');
  const android = await t.list(play);
  assert.equal(android.body.api, false);
  assert.equal(android.body.sync, null);
  const refused = await t.sync(play);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'experiments_not_supported');
  assert.equal(refused.body.code, 'experiments.unsupported');
  assert.equal(t.store.reads, 0);
  assert.equal((await t.call(t.owner, 'GET', t.path('nope'))).status, 404);
});

dbTest('a sync stores experiments with treatments and pages with versions and locales', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  const synced = await t.sync(appId);
  assert.equal(synced.status, 200, synced.text);
  assert.equal(synced.body.sync.experiments, 2);
  assert.equal(synced.body.sync.customPages, 2);
  assert.equal(synced.body.sync.complete, true);
  assert.equal(t.built[0]?.storeAppId, '1234567890', 'the connector is built for the store id');

  const list = (await t.list(appId)).body;
  assert.equal(list.sync.experimentCount, 2);
  assert.equal(list.sync.pageCount, 2);
  assert.equal(list.sync.failures, 0);
  assert.equal(list.sync.lastError, null);
  assert.deepEqual(list.experiments.map((e: { id: string }) => e.id), ['e1', 'e0'], 'newest first');
  const [e1] = list.experiments;
  assert.equal(e1.state, 'approved');
  assert.equal(e1.trafficProportion, 30);
  assert.equal(e1.reviewRequired, true);
  assert.equal(e1.startsAt, Date.UTC(2026, 9, 1));
  assert.deepEqual(e1.treatments.map((x: { name: string }) => x.name), ['Blue icon', 'New shots']);
  assert.equal(e1.treatments[0].locales[0].assets.screenshots, 3);
  const [c1, c2] = list.customPages;
  assert.equal(c1.name, 'Autumn');
  assert.equal(c2.name, 'Spring campaign');
  assert.equal(c2.deepLink, 'myapp://spring');
  assert.equal(c2.url, 'https://apps.apple.com/app/id1234567890?ppid=c1');
  assert.deepEqual(c2.locales.map((l: { locale: string }) => l.locale), ['en-US', 'fr-FR']);

  const events = await t.audit();
  assert.deepEqual(events.map((e) => e.action), ['experiments.synced']);
  assert.deepEqual(events[0]?.detail, {
    appId,
    store: 'appstoreconnect',
    experiments: 2,
    customPages: 2,
    complete: true,
    warnings: 0,
  });
});

dbTest('a second sync replaces the copy; a refused part keeps what was stored; a cap replaces only what it lists', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  t.store.result = {
    ...t.store.result,
    experiments: [experiment({ id: 'e9', name: 'New' })],
    customPages: [],
  };
  await t.sync(appId);
  let list = (await t.list(appId)).body;
  assert.deepEqual(list.experiments.map((e: { id: string }) => e.id), ['e9']);
  assert.deepEqual(list.customPages, []);

  // Apple refused the experiments part (a warning): the stored experiments stay, the pages are replaced.
  t.store.result = {
    experiments: [],
    customPages: [customPage({ id: 'c7', name: 'Only' })],
    complete: true,
    warnings: ['App Store Connect did not give the experiments of this app.'],
    experimentsRead: false,
    customPagesRead: true,
  };
  await t.sync(appId);
  list = (await t.list(appId)).body;
  assert.deepEqual(list.experiments.map((e: { id: string }) => e.id), ['e9']);
  assert.deepEqual(list.customPages.map((p: { id: string }) => p.id), ['c7']);
  assert.equal(list.sync.warnings.length, 1);

  // A cut list replaces only the items it lists: e9 stays and e10 is added; nothing is deleted.
  t.store.result = {
    experiments: [experiment({ id: 'e10', name: 'Added' })],
    customPages: [],
    complete: false,
    warnings: ['cut'],
    experimentsRead: true,
    customPagesRead: true,
  };
  await t.sync(appId);
  list = (await t.list(appId)).body;
  assert.deepEqual(list.experiments.map((e: { id: string }) => e.id).sort(), ['e10', 'e9']);
  assert.equal(list.customPages.length, 1);
  assert.equal(list.sync.complete, false);
});

dbTest('a failed sync keeps the last good copy, says what went wrong and never leaks the key', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  t.store.listError = new StoreError(
    'appstoreconnect',
    'server',
    `Apple failed. ${KEY_LINE}`,
    500,
  );
  const failed = await t.sync(appId);
  assert.equal(failed.status, 502);
  assert.ok(!failed.text.includes(KEY_LINE));
  const list = (await t.list(appId)).body;
  assert.equal(list.experiments.length, 2, 'the last good copy stays');
  assert.equal(list.sync.failures, 1);
  assert.ok(typeof list.sync.lastError === 'string' && !list.sync.lastError.includes(KEY_LINE));
  assert.equal(typeof list.sync.lastSyncedAt, 'number');
  assert.deepEqual(
    (await t.audit()).map((e) => e.action),
    ['experiments.synced'],
    'a failed sync is not a synced event',
  );

  t.store.listError = undefined;
  await t.sync(appId);
  assert.equal((await t.list(appId)).body.sync.failures, 0);
});

dbTest('a sync that does not answer in time is a 504', async (db) => {
  const t = await bootExperiments(db, { read: { timeoutMs: 20 } });
  const appId = await t.addApp('ios');
  t.store.gate = new Promise(() => undefined);
  const res = await t.sync(appId);
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
  assert.equal((await t.list(appId)).body.sync.failures, 1);
});

dbTest('the sync is rate limited per workspace; an unknown app costs no slot', async (db) => {
  const t = await bootExperiments(db, {}, { appSync: { limiter: createTestLimiter({ limit: 2 }) } });
  const appId = await t.addApp('ios');
  assert.equal((await t.sync('missing')).status, 404);
  assert.equal((await t.sync(appId)).status, 200);
  assert.equal((await t.sync(appId)).status, 200);
  const third = await t.sync(appId);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'rate_limited');
});

dbTest('who may read, sync and write notes; another workspace sees nothing', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const cookie = await t.addMember(role);
    assert.equal((await t.list(appId, cookie)).status, 200, `${role} reads`);
    const synced = await t.sync(appId, cookie);
    assert.equal(synced.status === 403, !can(role, 'apps.sync'), `${role} sync: ${synced.status}`);
    const note = await t.call(cookie, 'POST', t.path(appId, '/notes'), { kind: 'experiment', name: 'x' });
    assert.equal(note.status === 403, !can(role, 'aso.write'), `${role} note: ${note.status}`);
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [method, path] of [
    ['GET', t.path(appId)],
    ['POST', t.path(appId, '/sync')],
    ['POST', t.path(appId, '/notes')],
    ['DELETE', t.path(appId, '/notes/n1')],
  ] as const) {
    assert.equal((await t.call(outsider, method, path)).status, 404, `${method} ${path}`);
    assert.equal((await t.call(outsider, method, path, undefined, 'other')).status, 404);
  }
});

dbTest('the manual tracker: create, change, clear, delete; checks and audit without the text', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('android');
  const made = await t.call(t.owner, 'POST', t.path(appId, '/notes'), {
    kind: 'experiment',
    name: 'Icon test',
    status: 'running',
    startedOn: '2026-11-01',
    url: 'https://play.google.com/console/',
    note: 'secret learnings',
  });
  assert.equal(made.status, 201, made.text);
  const id = made.body.note.id as string;
  assert.equal(made.body.note.status, 'running');
  assert.equal(made.body.note.endedOn, null);
  const defaults = await t.call(t.owner, 'POST', t.path(appId, '/notes'), {
    kind: 'custom_page',
    name: 'Spring',
    listing: 'spring-2026',
  });
  assert.equal(defaults.body.note.status, 'planned');
  assert.equal(defaults.body.note.listing, 'spring-2026');
  assert.equal(defaults.body.note.note, '');

  const changed = await t.call(t.owner, 'PATCH', t.path(appId, `/notes/${id}`), {
    status: 'finished',
    endedOn: '2026-11-20',
    url: null,
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.body.note.status, 'finished');
  assert.equal(changed.body.note.url, null);
  assert.equal(changed.body.note.name, 'Icon test', 'what was not sent stays');
  assert.equal(changed.body.note.startedOn, '2026-11-01');

  const list = (await t.list(appId)).body;
  assert.equal(list.notes.length, 2);
  assert.equal(list.api, false);

  const bad = async (body: Record<string, unknown>, status = 400) =>
    assert.equal(
      (await t.call(t.owner, 'POST', t.path(appId, '/notes'), { kind: 'experiment', name: 'n', ...body })).status,
      status,
      JSON.stringify(body),
    );
  await bad({ name: '' });
  await bad({ name: 'a\nb' });
  await bad({ status: 'done' });
  await bad({ startedOn: '2026-13-40' });
  await bad({ url: 'javascript:alert(1)' });
  await bad({ listing: 'Has Capitals' });
  await bad({ note: 'x'.repeat(2001) });
  await bad({ extra: true });
  const order = await t.call(t.owner, 'POST', t.path(appId, '/notes'), {
    kind: 'experiment',
    name: 'n',
    startedOn: '2026-11-05',
    endedOn: '2026-11-01',
  });
  assert.equal(order.status, 422);
  assert.equal(order.body.code, 'experiments.datesOrder');
  const reverse = await t.call(t.owner, 'PATCH', t.path(appId, `/notes/${id}`), { startedOn: '2026-12-01' });
  assert.equal(reverse.status, 422, 'an end date before the new start date');

  assert.equal((await t.call(t.owner, 'PATCH', t.path(appId, '/notes/missing'), { name: 'x' })).status, 404);
  assert.equal((await t.call(t.owner, 'DELETE', t.path(appId, `/notes/${id}`))).status, 200);
  assert.equal((await t.call(t.owner, 'DELETE', t.path(appId, `/notes/${id}`))).body.error, 'note_not_found');
  const other = await t.addApp('android');
  assert.equal((await t.call(t.owner, 'DELETE', t.path(other, `/notes/${defaults.body.note.id}`))).status, 404, 'a note belongs to its app');

  const events = await t.audit();
  assert.deepEqual(events.map((e) => e.action), [
    'experiments.note_created',
    'experiments.note_created',
    'experiments.note_updated',
    'experiments.note_deleted',
  ]);
  assert.ok(!JSON.stringify(events).includes('secret learnings'), 'the text is never audited');
});

dbTest('deleting the app deletes its experiments, sync status and notes', async (db) => {
  const t = await bootExperiments(db);
  const appId = await t.addApp('ios');
  const keep = await t.addApp('ios');
  await t.sync(appId);
  await t.sync(keep);
  await t.call(t.owner, 'POST', t.path(appId, '/notes'), { kind: 'experiment', name: 'n' });
  await t.call(t.owner, 'POST', t.path(keep, '/notes'), { kind: 'experiment', name: 'n' });
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  for (const table of ['store_experiments', 'store_experiments_sync', 'store_experiment_notes']) {
    const [row] = await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`, [appId]);
    assert.equal(Number(row?.n), 0, table);
    const [kept] = await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`, [keep]);
    assert.ok(Number(kept?.n) > 0, `${table} of the other app stays`);
  }
});
