import assert from 'node:assert/strict';
import { StoreError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootStaged } from './modules/publish/test-helpers.ts';

/**
 * "Check with Google Play" (docs/api/releases-write.md, docs/adr/0025-play-release-checks.md): a read-style route that asks Google
 * whether a proposed release would be refused. Fakes only: no store is contacted.
 */

const BODY = {
  track: 'production',
  versionCodes: ['241'],
  releaseName: '2.1',
  userFraction: 0.1,
  notes: [{ locale: 'en-US', text: 'Fixes' }],
};
const check = (
  t: Awaited<ReturnType<typeof bootStaged>>,
  app: string,
  body: unknown,
  cookie = t.owner,
) => t.call(cookie, 'POST', `/apps/${app}/release/play-check`, body);

dbTest(
  'a check asks the connector with what was proposed, needs no switch, never releases, and is audited as a credential use',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: false }, release: { enabled: false } });
    const app = await t.addApp('android');
    const res = await check(t, app, BODY);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(
      [
        res.body.check.outcome,
        res.body.check.committed,
        res.body.check.status,
        res.body.check.userFraction,
      ],
      ['no_errors', false, 'inProgress', 0.1],
    );
    assert.match(res.body.check.note, /Play Console may still show warnings/);
    assert.doesNotMatch(res.body.check.note, /no warnings\./);
    const asked = t.releaseStores.android.checks;
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], {
      track: 'production',
      versionCodes: ['241'],
      status: 'inProgress',
      userFraction: 0.1,
      name: '2.1',
      notes: [{ locale: 'en-US', text: 'Fixes' }],
    });
    assert.equal(t.releaseStores.android.releaseCalls, 0, 'a check never releases');
    const uses = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'store.release_check',
    );
    assert.equal(uses.length, 1);
    assert.equal((await t.audit('store.release%')).length, 0);
    // The notes are never audited.
    const all = JSON.stringify(await t.audit('%'));
    assert.ok(!all.includes('Fixes'));
  },
);

dbTest('what Google refused is returned as findings, with the sentence for errors', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  t.releaseStores.android.checkResult = {
    outcome: 'errors',
    findings: [{ stage: 'validate', message: 'Version code 241 is already used.' }],
  };
  const res = await check(t, app, { ...BODY, userFraction: undefined });
  assert.equal(res.status, 200);
  assert.equal(res.body.check.outcome, 'errors');
  assert.equal(res.body.check.status, 'draft');
  assert.deepEqual(res.body.check.findings, [
    { stage: 'validate', message: 'Version code 241 is already used.' },
  ]);
  assert.match(res.body.check.note, /reported errors/);
});

dbTest('100% is checked as completed, with no share', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  const res = await check(t, app, { ...BODY, userFraction: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.check.status, 'completed');
  const asked = t.releaseStores.android.checks[0];
  assert.equal(asked?.status, 'completed');
  assert.equal(asked?.userFraction, undefined);
});

dbTest('a bad request is refused before any store is reached', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  const ios = await t.addApp('ios');
  const refused = async (body: unknown, status: number, error: string, id = app) => {
    const res = await check(t, id, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.error, error, JSON.stringify(body));
  };
  await refused({ ...BODY, track: 'pro duction' }, 422, 'track_required');
  await refused({ ...BODY, versionCodes: [] }, 400, 'invalid_request');
  await refused({ ...BODY, versionCodes: ['12x'] }, 400, 'invalid_request');
  await refused({ ...BODY, userFraction: 1.5 }, 400, 'invalid_request');
  await refused({ ...BODY, userFraction: 0.12345 }, 422, 'invalid_user_fraction');
  await refused({ ...BODY, status: 'draft' }, 422, 'invalid_user_fraction');
  await refused(
    { ...BODY, status: 'inProgress', userFraction: undefined },
    422,
    'invalid_user_fraction',
  );
  await refused({ ...BODY, status: 'completed' }, 422, 'invalid_user_fraction');
  await refused({ ...BODY, notes: [{ locale: 'english', text: 'x' }] }, 422, 'invalid_locale');
  await refused(
    {
      ...BODY,
      notes: [
        { locale: 'en-US', text: 'a' },
        { locale: 'en_US', text: 'b' },
      ],
    },
    422,
    'invalid_request',
  );
  await refused({ ...BODY, surprise: true }, 400, 'invalid_request');
  await refused(BODY, 422, 'not_applicable', ios);
  assert.equal(t.releaseStores.android.checks.length, 0);
  assert.equal(t.releaseStores.ios.checks.length, 0);
  assert.equal(t.releaseBuilt.length, 0, 'no connector was built');
  assert.equal(
    (await t.call(t.owner, 'POST', '/apps/no-such-app/release/play-check', BODY)).status,
    404,
  );
});

dbTest('rights: a viewer may check, a stranger gets 404', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  const viewer = await t.addMember('viewer');
  assert.equal((await check(t, app, BODY, viewer)).status, 200);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await check(t, app, BODY, outsider)).status, 404);
});

dbTest(
  'a store failure is an answer with a fixed sentence and no secret; a check can time out',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    t.releaseStores.android.checkError = new StoreError(
      'googleplay',
      'forbidden',
      'Google Play refused (403).',
      403,
    );
    const denied = await check(t, app, BODY);
    assert.equal(denied.status, 422);
    assert.equal(denied.body.error, 'store_forbidden');
    t.releaseStores.android.checkError = new StoreError(
      'googleplay',
      'server',
      'Google Play failed (HTTP 503).',
      503,
    );
    const down = await check(t, app, BODY);
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'store_unavailable');
    assert.match(down.body.message, /Nothing was saved in Google Play/);
    t.releaseStores.android.checkError = new Error('socket PRIVATE KEY bearer abc');
    const odd = await check(t, app, BODY);
    assert.equal(odd.status, 502);
    assert.equal(odd.body.error, 'check_failed');
    assert.ok(!odd.text.includes('PRIVATE KEY'));
    const all = [denied.text, down.text, odd.text].join('\n');
    for (const leak of ['PRIVATE KEY', 'client_email', 'mrm_'])
      assert.ok(!all.includes(leak), leak);
  },
);

dbTest('checks are rate limited per workspace', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  let last = 0;
  for (let i = 0; i < 12 && last !== 429; i++) last = (await check(t, app, BODY)).status;
  assert.equal(last, 429);
  const again = await check(t, app, BODY);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'rate_limited');
});
