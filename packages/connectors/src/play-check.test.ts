import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from './errors.ts';
import { PlayReleaseConnector } from './play-release.ts';
import { isStorePlayReleaseChecker, type PlayCheckRelease } from './release-types.ts';
import * as fx from './store.fixtures.ts';
import { FakePlayDraftApi } from './store-draft.fixtures.ts';

/**
 * "Check with Google Play" (docs/adr/0025-play-release-checks.md): a proposed release is staged in an edit, the edit is
 * validated and ALWAYS deleted, and it is NEVER committed. Fakes only: nothing here reaches Google Play.
 */

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const googleKey = fx.googleKeyPem();
const PKG = 'com.example.coffee';

function play(configure?: (api: FakePlayDraftApi) => void) {
  const api = new FakePlayDraftApi();
  configure?.(api);
  const connector = new PlayReleaseConnector({
    serviceAccount: fx.serviceAccountJson(googleKey.privateKey),
    packageName: PKG,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}

const proposal = (over: Partial<PlayCheckRelease> = {}): PlayCheckRelease => ({
  track: 'production',
  name: '2.1',
  versionCodes: ['241'],
  status: 'inProgress',
  userFraction: 0.1,
  notes: [
    { locale: 'en-US', text: 'Fixes' },
    { locale: 'de-DE', text: 'Korrekturen' },
  ],
  ...over,
});

const writes = (api: FakePlayDraftApi) => api.writes().map((w) => w.replace(/\/edits\/\d+/, '/edits/EDIT'));

test('the connector is a Play release checker', () => {
  assert.ok(isStorePlayReleaseChecker(play().connector));
});

test('no errors: the release is staged, validated with an empty body, the edit is deleted and nothing is committed', async () => {
  const { api, connector } = play();
  const result = await connector.checkPlayRelease(proposal());
  assert.deepEqual(result, { outcome: 'no_errors', findings: [] });
  assert.deepEqual(writes(api), [
    'POST /edits',
    'PUT /edits/EDIT/tracks/production',
    'POST /edits/EDIT:validate',
    'DELETE /edits/EDIT',
  ]);
  assert.equal(api.commits.length, 0);
  assert.equal(api.validations, 1);
  const put = api.seen.find((s) => s.method === 'PUT' && /\/tracks\//.test(s.path));
  assert.deepEqual(put?.body, {
    track: 'production',
    releases: [
      { name: '2.0', status: 'completed', versionCodes: ['200'] },
      {
        status: 'inProgress',
        versionCodes: ['241'],
        name: '2.1',
        userFraction: 0.1,
        releaseNotes: [
          { language: 'en-US', text: 'Fixes' },
          { language: 'de-DE', text: 'Korrekturen' },
        ],
      },
    ],
  });
  const validate = api.seen.find((s) => /:validate$/.test(s.path));
  assert.equal(validate?.body, undefined, 'the request body of edits.validate is empty');
  // The committed track is untouched.
  assert.equal(api.tracks[0]?.releases.length, 1);
});

test('a completed proposal replaces the older completed release; a rollout keeps it', async () => {
  const done = play();
  await done.connector.checkPlayRelease(proposal({ status: 'completed', userFraction: undefined }));
  const put = done.api.seen.find((s) => s.method === 'PUT' && /\/tracks\//.test(s.path));
  const releases = (put?.body as { releases: { status: string; userFraction?: number }[] }).releases;
  assert.deepEqual(
    releases.map((r) => r.status),
    ['completed'],
  );
  assert.equal(releases[0]?.userFraction, undefined);
});

test('a release with the same codes is replaced, empty notes and a blank name are not sent', async () => {
  const { api, connector } = play((a) => {
    a.tracks = [
      {
        track: 'beta',
        releases: [{ name: 'old', status: 'draft', versionCodes: ['241'] }],
      },
    ];
  });
  await connector.checkPlayRelease(
    proposal({ track: 'beta', status: 'draft', userFraction: undefined, name: '  ', notes: [{ locale: 'en-US', text: '   ' }] }),
  );
  const put = api.seen.find((s) => s.method === 'PUT' && /\/tracks\//.test(s.path));
  assert.deepEqual(put?.body, {
    track: 'beta',
    releases: [{ status: 'draft', versionCodes: ['241'] }],
  });
});

test('Google refuses the edit: the finding is Google words, the edit is deleted, nothing is committed', async () => {
  const { api, connector } = play((a) => {
    a.validateAnswer = 'invalid';
  });
  const result = await connector.checkPlayRelease(proposal());
  assert.equal(result.outcome, 'errors');
  assert.deepEqual(result.findings, [
    { stage: 'validate', message: 'Version code 241 has been used in a release that is already live.' },
  ]);
  assert.equal(api.commits.length, 0);
  assert.ok(writes(api).includes('DELETE /edits/EDIT'));
});

test('Google refuses the release already when it is staged: a stage finding, no validate call', async () => {
  const { api, connector } = play((a) => {
    a.trackUpdateRefusal = 'Release notes are too long.';
  });
  const result = await connector.checkPlayRelease(proposal());
  assert.deepEqual(result, {
    outcome: 'errors',
    findings: [{ stage: 'stage', message: 'Release notes are too long.' }],
  });
  assert.equal(api.validations, 0);
  assert.equal(api.commits.length, 0);
  assert.ok(writes(api).includes('DELETE /edits/EDIT'));
});

test('a failure of Google is an error, not a finding, and the edit is still deleted', async () => {
  const { api, connector } = play((a) => {
    a.validateAnswer = 'server_error';
  });
  await assert.rejects(connector.checkPlayRelease(proposal()), (e: unknown) => {
    assert.ok(e instanceof StoreError && e.kind === 'server');
    const text = `${e.message} ${e.stack ?? ''}`;
    assert.ok(!text.includes('PRIVATE KEY') && !text.includes(fx.ACCESS_TOKEN));
    return true;
  });
  assert.ok(writes(api).includes('DELETE /edits/EDIT'));
  assert.equal(api.commits.length, 0);
});

test('no access (403) is an error, not a finding', async () => {
  const { api, connector } = play((a) => {
    a.hook = (s) =>
      /:validate$/.test(s.path)
        ? new Response(JSON.stringify({ error: { code: 403, message: 'no' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : undefined;
  });
  await assert.rejects(
    connector.checkPlayRelease(proposal()),
    (e: unknown) => e instanceof StoreError && e.kind === 'forbidden',
  );
  assert.equal(api.commits.length, 0);
});

test('a bad proposal is refused before any call', async () => {
  const bad: Partial<PlayCheckRelease>[] = [
    { versionCodes: [] },
    { versionCodes: ['x1'] },
    { track: 'pro duction' },
    { status: 'inProgress', userFraction: 1 },
    { status: 'inProgress', userFraction: 0 },
    { status: 'inProgress', userFraction: undefined },
    { status: 'draft', userFraction: 0.5 },
    { status: 'completed', userFraction: 0.5 },
  ];
  for (const over of bad) {
    const { api, connector } = play();
    await assert.rejects(
      connector.checkPlayRelease(proposal(over)),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
      JSON.stringify(over),
    );
    assert.equal(api.seen.filter((s) => s.host !== 'oauth2.googleapis.com').length, 0);
  }
});
