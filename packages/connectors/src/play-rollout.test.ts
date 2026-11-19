import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { PlayRolloutConnector, playRolloutState } from './play-rollout.ts';
import { RolloutDriftError, RolloutOutcomeUnknownError } from './rollout-types.ts';
import * as fx from './store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.googleKeyPem();
const PKG = 'com.example.coffee';
const EDITS = `/androidpublisher/v3/applications/${PKG}/edits`;
const EDIT = `${EDITS}/${fx.googleEdit.id}`;
const TRACK = `${EDIT}/tracks/production`;
const COMMIT = `${EDIT}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`;
const target = { track: 'production', versionCodes: ['240'] };

/** A production track as `tracks.get` answers: a rollout in progress on top of a completed release. */
const trackJson = (over: Record<string, unknown> = {}) => ({
  track: 'production',
  releases: [
    {
      name: '2.4.0',
      versionCodes: ['240'],
      status: 'inProgress',
      userFraction: 0.1,
      releaseNotes: [{ language: 'en-US', text: 'Fixes the camera.' }],
      inAppUpdatePriority: 3,
      ...over,
    },
    {
      name: '2.3.0',
      versionCodes: ['230'],
      status: 'completed',
      releaseNotes: [{ language: 'en-US', text: 'Older.' }],
    },
  ],
});

function setup(track: unknown = trackJson()) {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({ method: 'POST', match: EDITS, json: fx.googleEdit })
    .on({ method: 'GET', match: TRACK, json: track })
    .on({ method: 'DELETE', match: EDIT, json: {} });
  const connector = new PlayRolloutConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: PKG,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}
const accept = () => true;
const calls = (fake: fx.FakeFetch) =>
  fake.calls
    .filter((c) => c.url.pathname !== '/token')
    .map((c) =>
      `${c.method} ${c.url.pathname}${c.url.search}`.replace(
        `/androidpublisher/v3/applications/${PKG}`,
        '',
      ),
    );

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!text.includes(fx.ACCESS_TOKEN));
}

test('readState opens an edit, reads the track, deletes the edit and commits nothing', async () => {
  const { fake, connector } = setup();
  const state = await connector.readState(target);
  assert.deepEqual(state, {
    store: 'googleplay',
    platform: 'android',
    track: 'production',
    versionCodes: ['240'],
    name: '2.4.0',
    status: 'inProgress',
    userFraction: 0.1,
    otherReleases: 1,
  });
  assert.deepEqual(calls(fake), [
    'POST /edits',
    'GET /edits/17744839219283/tracks/production',
    'DELETE /edits/17744839219283',
  ]);
  assert.deepEqual(fake.unexpected, []);
});

test('readState matches the version codes as a set, and says not_found for another release or track', async () => {
  const multi = {
    track: 'production',
    releases: [{ versionCodes: ['10', '2'], status: 'halted', userFraction: 0.5 }],
  };
  const { connector } = setup(multi);
  assert.equal(
    (await connector.readState({ track: 'production', versionCodes: ['2', '10'] })).store,
    'googleplay',
  );
  await assert.rejects(
    connector.readState({ track: 'production', versionCodes: ['2'] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'not_found',
  );
  const missing = setup();
  missing.fake.clear('GET', TRACK).on({
    method: 'GET',
    match: TRACK,
    status: 404,
    json: { error: { code: 404, message: 'Track not found' } },
  });
  await assert.rejects(
    missing.connector.readState(target),
    (e: unknown) =>
      e instanceof StoreError && e.kind === 'not_found' && /production track/.test(e.message),
  );
  assert.equal(playRolloutState(null, target), undefined);
});

test('invalid targets are refused before any request', async () => {
  const { fake, connector } = setup();
  for (const bad of [
    { track: '../x', versionCodes: ['1'] },
    { track: 'production', versionCodes: [] },
    { track: 'production', versionCodes: ['abc'] },
    { track: 'production', versionCodes: Array.from({ length: 51 }, (_, i) => String(i + 1)) },
    { version: '1.0' },
  ]) {
    await assert.rejects(
      connector.readState(bad),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
    );
  }
  assert.equal(fake.calls.length, 0);
  assert.throws(
    () =>
      new PlayRolloutConnector({
        serviceAccount: fx.serviceAccountJson(key.privateKey),
        packageName: '../etc',
      }),
    StoreError,
  );
});

test('raising the share: edit, read, update with EVERY release kept as read, commit that never cancels a review', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'PUT', match: TRACK, json: {} })
    .on({ method: 'POST', match: COMMIT, json: fx.googleEdit });
  const seen: unknown[] = [];
  const done = await connector.applyChange({
    target,
    change: { action: 'set_fraction', userFraction: 0.25 },
    guard: (state) => {
      seen.push(state);
      return true;
    },
  });
  assert.deepEqual(fake.unexpected, []);
  assert.equal(seen.length, 1, 'the guard sees the state read inside the edit');
  assert.deepEqual(calls(fake), [
    'POST /edits',
    'GET /edits/17744839219283/tracks/production',
    'PUT /edits/17744839219283/tracks/production',
    'POST /edits/17744839219283:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW',
  ]);
  const put = JSON.parse(fake.calls.find((c) => c.method === 'PUT')?.body ?? '{}');
  assert.equal(put.track, 'production');
  assert.equal(put.releases.length, 2, 'the other release is sent back');
  assert.deepEqual(
    put.releases[0],
    { ...trackJson().releases[0], status: 'inProgress', userFraction: 0.25 },
    'notes and priority kept',
  );
  assert.deepEqual(put.releases[1], trackJson().releases[1], 'unchanged');
  assert.equal(
    fake.calls.find((c) => c.url.pathname.endsWith(':commit'))?.body,
    undefined,
    'the commit has an empty body',
  );
  assert.equal(done.before.store === 'googleplay' && done.before.userFraction, 0.1);
  assert.equal(done.after.store === 'googleplay' && done.after.userFraction, 0.25);
  assert.ok(
    fake.calls.every((c) => c.method !== 'DELETE'),
    'a committed edit is not deleted',
  );
  for (const c of fake.calls.filter((x) => x.url.pathname !== '/token'))
    assert.equal(c.headers.get('authorization'), `Bearer ${fx.ACCESS_TOKEN}`);
});

test('halt keeps the share, resume sets in progress again, complete drops the share', async () => {
  const run = async (
    track: unknown,
    change: Parameters<PlayRolloutConnector['applyChange']>[0]['change'],
  ) => {
    const { fake, connector } = setup(track);
    fake
      .on({ method: 'PUT', match: TRACK, json: {} })
      .on({ method: 'POST', match: COMMIT, json: fx.googleEdit });
    await connector.applyChange({ target, change, guard: accept });
    return JSON.parse(fake.calls.find((c) => c.method === 'PUT')?.body ?? '{}').releases[0];
  };
  const halted = await run(trackJson(), { action: 'halt' });
  assert.equal(halted.status, 'halted');
  assert.equal(halted.userFraction, 0.1);
  const resumed = await run(trackJson({ status: 'halted', userFraction: 0.2 }), {
    action: 'resume',
  });
  assert.equal(resumed.status, 'inProgress');
  assert.equal(resumed.userFraction, 0.2);
  const completed = await run(trackJson(), { action: 'complete' });
  assert.equal(completed.status, 'completed');
  assert.equal('userFraction' in completed, false);
  assert.deepEqual(completed.releaseNotes, trackJson().releases[0]?.releaseNotes);
});

test('a guard that refuses sends nothing: RolloutDriftError with the state read, and the edit is deleted', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.applyChange({ target, change: { action: 'halt' }, guard: () => false }),
    (e: unknown) =>
      e instanceof RolloutDriftError &&
      e.current.store === 'googleplay' &&
      e.current.userFraction === 0.1,
  );
  assert.deepEqual(calls(fake), [
    'POST /edits',
    'GET /edits/17744839219283/tracks/production',
    'DELETE /edits/17744839219283',
  ]);
});

test('a change the rules refuse is refused before the update, even when the guard accepts', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.applyChange({
      target,
      change: { action: 'set_fraction', userFraction: 0.05 },
      guard: accept,
    }),
    (e: unknown) =>
      e instanceof StoreError && e.kind === 'invalid_input' && /can only go up/.test(e.message),
  );
  assert.ok(fake.calls.every((c) => c.method !== 'PUT' && !c.url.pathname.endsWith(':commit')));
});

test('a failed update applies nothing: no commit, the edit is deleted, the error is the store’s', async () => {
  for (const [status, kind] of [
    [500, 'server'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const) {
    const { fake, connector } = setup();
    fake.on({ method: 'PUT', match: TRACK, status, json: { error: { message: 'no' } } });
    await assert.rejects(
      connector.applyChange({ target, change: { action: 'halt' }, guard: accept }),
      (e: unknown) => {
        assertNoSecrets(e);
        return (
          e instanceof StoreError && !(e instanceof RolloutOutcomeUnknownError) && e.kind === kind
        );
      },
      String(status),
    );
    assert.equal(fake.called('POST', COMMIT).length, 0, 'never committed');
    assert.equal(fake.called('DELETE', EDIT).length, 1, 'the edit is abandoned');
  }
  const { fake, connector } = setup();
  fake.on({ method: 'PUT', match: TRACK, status: 403, json: { error: { message: 'x' } } });
  await assert.rejects(
    connector.applyChange({ target, change: { action: 'halt' }, guard: accept }),
    /allowed to release/,
  );
});

test('a 429 on a write is not waited out and not retried', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'PUT',
    match: TRACK,
    status: 429,
    json: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
    headers: { 'retry-after': '1' },
  });
  await assert.rejects(
    connector.applyChange({ target, change: { action: 'halt' }, guard: accept }),
    (e: unknown) => e instanceof StoreRateLimitError,
  );
  assert.equal(fake.called('PUT', TRACK).length, 1);
  assert.equal(fake.called('POST', COMMIT).length, 0);
});

test('an unknown commit outcome (5xx or a cut connection) is RolloutOutcomeUnknownError, never retried, edit left alone', async () => {
  for (const route of [
    { status: 503, json: { error: { message: 'busy' } } },
    { throws: new TypeError('fetch failed') },
  ] as const) {
    const { fake, connector } = setup();
    fake
      .on({ method: 'PUT', match: TRACK, json: {} })
      .on({ method: 'POST', match: COMMIT, ...route });
    await assert.rejects(
      connector.applyChange({ target, change: { action: 'halt' }, guard: accept }),
      (e: unknown) => {
        assertNoSecrets(e);
        return e instanceof RolloutOutcomeUnknownError && /not known whether/.test(e.message);
      },
    );
    assert.equal(fake.called('POST', COMMIT).length, 1, 'no retry');
    assert.equal(fake.called('PUT', TRACK).length, 1);
    assert.equal(
      fake.called('DELETE', EDIT).length,
      0,
      'an edit that may be committing is not deleted',
    );
  }
});

test('changes in review: the commit fails with changes_in_review, nothing is applied, the edit is deleted', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'PUT', match: TRACK, json: {} }).on({
    method: 'POST',
    match: COMMIT,
    status: 400,
    json: {
      error: {
        code: 400,
        status: 'FAILED_PRECONDITION',
        message: 'You already have changes in review.',
        details: [{ reason: 'CHANGES_ALREADY_IN_REVIEW' }],
      },
    },
  });
  await assert.rejects(
    connector.applyChange({ target, change: { action: 'halt' }, guard: accept }),
    (e: unknown) =>
      e instanceof StoreError &&
      e.kind === 'changes_in_review' &&
      /does not cancel a review/.test(e.message),
  );
  assert.equal(fake.called('POST', COMMIT).length, 1);
  assert.equal(fake.called('DELETE', EDIT).length, 1);
});

test('a 401 on the commit is retried once with a new token (Google rejected the token, not the request)', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'PUT', match: TRACK, json: {} })
    .on({ method: 'POST', match: COMMIT, status: 401, json: {}, times: 1 })
    .on({ method: 'POST', match: COMMIT, json: fx.googleEdit });
  await connector.applyChange({ target, change: { action: 'halt' }, guard: accept });
  assert.equal(fake.called('POST', COMMIT).length, 2);
});
