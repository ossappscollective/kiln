import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { pruneTestflight, testerKey } from './store.ts';
import { ASC_SECRET, bootTestflight, crash, CRASH_LOG, item } from './test-helpers.ts';
import { createTestflightAfterReviews } from './index.ts';
import { defaultTestflightConnectorFactory } from './shared.ts';

/** The line of the private key, as a store error could echo it. */
const KEY_LINE = (JSON.parse(ASC_SECRET) as { privateKey: string }).privateKey.split('\n')[1] ?? '';

dbTest('before a sync there is nothing; Google Play has no TestFlight; an unknown app is a 404', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  const res = await t.list(appId);
  assert.equal(res.status, 200);
  assert.equal(res.body.api, true);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.sync, null);
  assert.equal(res.body.counts.feedback, 0);
  assert.equal(t.store.reads, 0, 'reading the list asks Apple nothing');

  const play = await t.addApp('android');
  assert.equal((await t.list(play)).body.api, false);
  const refused = await t.sync(play);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'testflight_not_supported');
  assert.equal(refused.body.code, 'testflight.unsupported');
  assert.equal(t.store.reads, 0);
  assert.equal((await t.call(t.owner, 'GET', t.path('nope'))).status, 404);
  assert.equal((await t.call(t.owner, 'POST', t.path('nope', '/sync'))).status, 404);
});

dbTest('the first sync stores feedback and crashes with their logs and raises no alert; later ones alert once per new submission', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  const first = await t.sync(appId);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.sync.added, { feedback: 2, crashes: 1 });
  assert.equal(first.body.sync.crashLogs, 1);
  assert.equal(t.built[0]?.storeAppId, '1234567890');
  assert.equal((await t.events('testflight.feedback')).length, 0, 'the first read of an app is a baseline');
  assert.equal((await t.events('testflight.crash')).length, 0);

  const feedback = (await t.list(appId)).body;
  assert.equal(feedback.counts.feedback, 2);
  assert.equal(feedback.counts.crashes, 1);
  assert.deepEqual(feedback.items.map((i: { buildNumber: string }) => i.buildNumber), ['42', '43'], 'newest first');
  assert.equal(feedback.sync.failures, 0);
  assert.deepEqual(feedback.builds.map((b: { buildNumber: string }) => b.buildNumber), ['42', '43']);

  // A second sync with the same data adds nothing; one with new submissions alerts.
  assert.equal((await t.sync(appId)).body.sync.added.feedback, 0);
  t.store.items.push(item({ id: 'f9', buildNumber: '44', createdAt: Date.UTC(2026, 10, 22) }), crash({ id: 'c9', buildNumber: '44' }));
  t.store.logs.set('c9', CRASH_LOG);
  const again = await t.sync(appId);
  assert.deepEqual(again.body.sync.added, { feedback: 1, crashes: 1 });
  const fEvents = await t.events('testflight.feedback');
  const cEvents = await t.events('testflight.crash');
  assert.equal(fEvents.length, 1);
  assert.equal(cEvents.length, 1);
  assert.equal(fEvents[0]?.buildNumber, '44');
  assert.equal(fEvents[0]?.platform, 'ios');
  assert.ok(typeof fEvents[0]?.submissionId === 'string');
  // No comment, no email, no log anywhere in what leaves the module.
  const everything = JSON.stringify([fEvents, cEvents, (await t.call(t.owner, 'GET', '/alerts/inbox')).body, await t.audit()]);
  for (const secret of ['The button does nothing', 'It crashed', 'tester@example.com', 'EXC_BAD_ACCESS']) {
    assert.ok(!everything.includes(secret), secret);
  }
  const inbox = (await t.call(t.owner, 'GET', '/alerts/inbox')).body;
  assert.ok(JSON.stringify(inbox).includes('testflight.crash'), 'the alert is raised');
  assert.ok(JSON.stringify(inbox).includes('testflight.feedback'));
});

dbTest('more new submissions than the cap raise single alerts up to the cap and one grouped alert', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  t.store.items = [item({ id: 'seed' })];
  await t.sync(appId);
  for (let i = 0; i < 13; i++) t.store.items.push(item({ id: `n${i}`, createdAt: Date.UTC(2026, 10, 21, 1, i) }));
  await t.sync(appId);
  const events = await t.events('testflight.feedback');
  assert.equal(events.filter((e) => e.grouped !== true).length, 10);
  const grouped = events.filter((e) => e.grouped === true);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.count, 3);
});

dbTest('crash logs are stored with a signature; groups count by build and by signature; a missing or failing log is told apart', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  t.store.items = [
    crash({ id: 'c1' }),
    crash({ id: 'c2', buildNumber: '43', version: '2.6.0', createdAt: Date.UTC(2026, 10, 22), email: 'b@example.com' }),
    crash({ id: 'c3', createdAt: Date.UTC(2026, 10, 18) }),
    crash({ id: 'c4', createdAt: Date.UTC(2026, 10, 17) }),
  ];
  t.store.logs = new Map([
    ['c1', CRASH_LOG],
    ['c2', CRASH_LOG],
    ['c3', null],
  ]);
  t.store.logErrors.set('c4', new StoreError('appstoreconnect', 'unexpected', 'boom'));
  const done = await t.sync(appId);
  assert.equal(done.status, 200, done.text);
  assert.match(done.body.sync.warnings.join(' '), /could not be read/);

  const list = (await t.list(appId, 'kind=crash')).body;
  const byId = new Map<string, { crashLogState: string; signature: string | null; symbolicated: boolean | null }>(
    list.items.map((i: { id: string; crashLogState: string; signature: string | null; symbolicated: boolean | null }) => [i.id, i]),
  );
  assert.equal(list.items.length, 4);
  const states = list.items.map((i: { crashLogState: string }) => i.crashLogState).sort();
  assert.deepEqual(states, ['missing', 'none', 'stored', 'stored']);
  const stored = [...byId.values()].filter((i) => i.crashLogState === 'stored');
  assert.equal(stored[0]?.signature, 'EXC_BAD_ACCESS (SIGSEGV) | Example -[SettingsViewController reload]');
  assert.equal(stored[0]?.symbolicated, true);

  const groups = (await t.call(t.owner, 'GET', t.path(appId, '/crash-groups'))).body;
  assert.deepEqual(groups.byBuild.map((b: { buildNumber: string; count: number }) => [b.buildNumber, b.count]), [['43', 1], ['42', 3]]);
  const sig = groups.bySignature.find((g: { signature: string | null }) => g.signature !== null);
  assert.equal(sig.count, 2);
  assert.deepEqual(sig.builds.sort(), ['42', '43']);
  assert.equal(groups.bySignature.find((g: { signature: string | null }) => g.signature === null).count, 2);

  // The log of the failing one is tried again by the next sync; a stored one is not read again.
  t.store.logErrors.clear();
  t.store.logs.set('c4', CRASH_LOG);
  t.store.logReads.length = 0;
  await t.sync(appId);
  assert.deepEqual(t.store.logReads, ['c4']);
  const one = (await t.call(t.owner, 'GET', t.path(appId, `/${[...byId.keys()].find((k) => byId.get(k)?.crashLogState === 'none')}`))).body.item;
  assert.equal(one.crashLogState, 'stored');
  assert.equal(one.crashLog, CRASH_LOG);
  assert.equal(one.crashLogTruncated, false);
});

dbTest('a huge crash log is cut and says so', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  t.store.items = [crash({ id: 'big' })];
  t.store.logs = new Map([['big', `${CRASH_LOG}${'x'.repeat(100_000)}`]]);
  await t.sync(appId);
  const id = (await t.list(appId, 'kind=crash')).body.items[0].id as string;
  const one = (await t.call(t.owner, 'GET', t.path(appId, `/${id}`))).body.item;
  assert.equal(one.crashLog.length, 64 * 1024);
  assert.equal(one.crashLogTruncated, true);
  assert.equal(one.signature, 'EXC_BAD_ACCESS (SIGSEGV) | Example -[SettingsViewController reload]', 'the signature is read from the whole log');
});

dbTest('filters: build, version, status, tester and a cursor; the email is for administrators only', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  assert.deepEqual((await t.list(appId, 'build=43')).body.items.map((i: { buildNumber: string }) => i.buildNumber), ['43']);
  assert.equal((await t.list(appId, 'version=2.5.0')).body.items.length, 2);
  assert.equal((await t.list(appId, 'version=9')).body.items.length, 0);
  assert.equal((await t.list(appId, 'status=resolved')).body.items.length, 0);
  assert.equal((await t.list(appId, 'status=new,seen')).body.items.length, 2);
  assert.equal((await t.list(appId, 'status=bogus')).status, 400);
  assert.equal((await t.list(appId, 'kind=bogus')).status, 400);
  assert.equal((await t.list(appId, 'tester=zz')).status, 400);

  const key = testerKey((await t.call(t.owner, 'GET', '/workspaces')).body?.workspaces?.[0]?.id ?? '', 'tester@example.com');
  const all = (await t.list(appId)).body.items as { tester: string | null; testerEmail: string | null }[];
  const known = all.find((i) => i.tester !== null);
  assert.match(known?.tester ?? '', /^[0-9A-F]{6}$/);
  assert.equal((await t.list(appId, `tester=${known?.tester}`)).body.items.length, 1);
  assert.equal(all.find((i) => i.tester === null)?.testerEmail, null, 'an anonymous tester has no email');
  void key;

  assert.equal(known?.testerEmail, 'tester@example.com', 'the owner sees the email');
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  const asAdmin = (await t.list(appId, '', admin)).body.items.find((i: { tester: string | null }) => i.tester !== null);
  assert.equal(asAdmin.testerEmail, 'tester@example.com');
  for (const cookie of [member, viewer]) {
    const seen = await t.list(appId, '', cookie);
    assert.equal(seen.status, 200);
    assert.ok(!seen.text.includes('tester@example.com'), 'below administrators the email is never sent');
    const id = seen.body.items[0].id as string;
    const detail = await t.call(cookie, 'GET', t.path(appId, `/${id}`));
    assert.ok(!detail.text.includes('tester@example.com'));
  }

  const page1 = (await t.list(appId, 'limit=1')).body;
  assert.equal(page1.items.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = (await t.list(appId, `limit=1&cursor=${page1.nextCursor}`)).body;
  assert.equal(page2.items.length, 1);
  assert.notEqual(page2.items[0].id, page1.items[0].id);
  assert.equal(page2.nextCursor, null);
  assert.equal((await t.list(appId, 'cursor=garbage')).status, 400);
});

dbTest('triage: status, assignee and note; kept across syncs; audited without the note; roles and unknown assignee checked', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  const id = (await t.list(appId)).body.items[0].id as string;
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');

  assert.equal((await t.call(viewer, 'PATCH', t.path(appId, `/${id}`), { status: 'seen' })).status, 403);
  const empty = await t.call(t.owner, 'PATCH', t.path(appId, `/${id}`), {});
  assert.equal(empty.status, 400);

  const done = await t.call(member, 'PATCH', t.path(appId, `/${id}`), { status: 'in_progress', internalNote: 'Looks like the settings screen' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.item.status, 'in_progress');
  assert.equal(done.body.item.internalNote, 'Looks like the settings screen');
  assert.ok(done.body.item.statusChangedAt > 0);

  const nobody = await t.call(t.owner, 'PATCH', t.path(appId, `/${id}`), { assigneeUserId: 'nobody' });
  assert.equal(nobody.status, 422);
  assert.equal(nobody.body.code, 'testflight.assigneeNotMember');
  assert.equal((await t.call(t.owner, 'PATCH', t.path(appId, '/nope'), { status: 'seen' })).status, 404);

  await t.sync(appId);
  const after = (await t.call(t.owner, 'GET', t.path(appId, `/${id}`))).body.item;
  assert.equal(after.status, 'in_progress', 'a sync never overwrites triage');
  assert.equal(after.internalNote, 'Looks like the settings screen');
  assert.equal((await t.list(appId, 'status=in_progress')).body.items.length, 1);
  assert.equal((await t.list(appId)).body.counts.openFeedback, 2);

  const triage = (await t.audit('testflight.triage'))[0];
  assert.deepEqual(triage?.detail.changed, ['status', 'note']);
  assert.ok(!JSON.stringify(await t.audit()).includes('settings screen'), 'the note is never audited');
});

dbTest('a failed sync keeps what was stored and records why; a key line never reaches the answer; a refusal is told', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  t.store.listError = new Error(`broke ${KEY_LINE}`);
  const failed = await t.sync(appId);
  assert.ok(failed.status >= 400);
  assert.ok(!failed.text.includes(KEY_LINE));
  const after = (await t.list(appId)).body;
  assert.equal(after.items.length, 2, 'the stored copy stays');
  assert.equal(after.sync.failures, 1);
  assert.ok(after.sync.lastError);
  assert.ok(!JSON.stringify(after).includes(KEY_LINE));

  t.store.listError = new StoreError('appstoreconnect', 'forbidden', 'nope', 403);
  const forbidden = await t.sync(appId);
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.body.error, 'store_forbidden');
  assert.equal((await t.list(appId)).body.sync.failures, 2);

  t.store.listError = undefined;
  t.store.warnings = ['The list of crash submissions was cut at its limit.'];
  t.store.complete = false;
  const partial = await t.sync(appId);
  assert.equal(partial.body.sync.complete, false);
  const ok = (await t.list(appId)).body;
  assert.equal(ok.sync.failures, 0);
  assert.equal(ok.sync.lastError, null);
  assert.equal(ok.sync.complete, false);
  assert.deepEqual(ok.sync.warnings, ['The list of crash submissions was cut at its limit.']);
});

dbTest('a sync that takes too long times out and records it', async (db) => {
  let release: () => void = () => undefined;
  const t = await bootTestflight(db, { read: { timeoutMs: 25 } });
  const appId = await t.addApp('ios');
  t.store.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const res = await t.sync(appId);
  release();
  assert.equal(res.status, 504);
  assert.equal((await t.list(appId)).body.sync.failures, 1);
});

dbTest('syncs are rate limited with the budget of the app sync, and who may sync, read or triage is the role of the reviews', async (db) => {
  const t = await bootTestflight(db, {}, { appSync: { limiter: createTestLimiter({ limit: 1 }) } });
  const appId = await t.addApp('ios');
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  assert.equal((await t.sync(appId, viewer)).status, 403);
  assert.equal((await t.list(appId, '', viewer)).status, 200);
  assert.equal((await t.sync(appId, member)).status, 200);
  const limited = await t.sync(appId, member);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'sync.tooManySyncs');
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.list(appId, '', outsider)).status, 404);
});

dbTest('screenshot links are read on demand, sent without caching and never stored or logged', async (db) => {
  const t = await bootTestflight(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  const list = (await t.list(appId)).body.items as { id: string; screenshotCount: number }[];
  const withShot = list.find((i) => i.screenshotCount === 1);
  assert.ok(withShot);
  const res = await t.call(t.owner, 'GET', t.path(appId, `/${withShot?.id}/screenshots`));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.screenshots[0].url, 'https://example.invalid/shot.png?token=SECRET-LINK');
  assert.equal(res.body.screenshots[0].expiresAt, Date.UTC(2026, 10, 22, 13));
  const stored = await db.query('SELECT screenshots_json FROM testflight_feedback');
  assert.ok(!JSON.stringify(stored).includes('SECRET-LINK'));
  const row = await db.query("SELECT detail FROM audit_events WHERE detail LIKE '%SECRET-LINK%'");
  assert.equal(row.length, 0);
  // A crash has none; an unknown id is a 404.
  const crashId = (await t.list(appId, 'kind=crash')).body.items[0].id as string;
  assert.deepEqual((await t.call(t.owner, 'GET', t.path(appId, `/${crashId}/screenshots`))).body.screenshots, []);
  assert.equal((await t.call(t.owner, 'GET', t.path(appId, '/nope/screenshots'))).status, 404);
});

dbTest('retention removes old submissions; deleting the app removes its rows; the scheduled read runs after the reviews of the same app', async (db) => {
  const masterKey = randomBytes(32);
  const t = await bootTestflight(db, {}, { masterKey });
  const appId = await t.addApp('ios');
  await t.sync(appId);
  const removed = await pruneTestflight(db, Date.UTC(2026, 10, 20));
  assert.equal(removed, 1, 'only the submission of 19 November is older');
  assert.equal((await t.list(appId)).body.counts.feedback, 1);

  const second = await t.addApp('ios', 'Second');
  const handler = createTestflightAfterReviews({
    db,
    masterKey,
    now: Date.now,
    readFactory: () => t.store,
    readTimeoutMs: 5000,
  });
  await handler({ workspaceId: t.workspaceId, appId: second, requestedBy: 'scheduler' }, {} as never);
  assert.equal((await t.list(second)).body.counts.feedback, 2);
  await handler({ nonsense: true }, {} as never);
  assert.equal(typeof defaultTestflightConnectorFactory, 'function');

  const del = await t.call(t.owner, 'DELETE', `/apps/${second}`);
  assert.equal(del.status, 204, del.text);
  const [left] = await db.query('SELECT COUNT(*) AS n FROM testflight_feedback WHERE app_id = ?', [second]);
  assert.equal(Number(left?.n), 0);
});
