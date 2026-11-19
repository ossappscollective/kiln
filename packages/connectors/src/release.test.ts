import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleReleaseConnector } from './appstore-release.ts';
import { StoreError } from './errors.ts';
import { PlayReleaseConnector } from './play-release.ts';
import { ReleaseDriftError, ReleaseOutcomeUnknownError, releaseStateHash, sameReleaseState } from './release-types.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, FakePlayDraftApi } from './store-draft.fixtures.ts';

/**
 * The irreversible step (docs/api/releases-write.md): release an approved App Store version, start a draft release of a
 * Google Play track. Fakes only: nothing here reaches a store.
 */

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();
const APP = '10746822401';
const PKG = 'com.example.coffee';
const accept = () => true;
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function apple(configure?: (api: FakeAppleDraftApi) => void, platform: 'ios' | 'macos' = 'ios') {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleReleaseConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: appleKey.privateKey },
    appStoreId: APP,
    platform,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}
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
const waiting = (api: FakeAppleDraftApi, id = 'v-next') => {
  const v = api.versions.find((x) => x.id === id);
  if (v) v.state = 'PENDING_DEVELOPER_RELEASE';
};
const releasePosts = (api: FakeAppleDraftApi) => api.seen.filter((s) => s.method === 'POST' && s.path === '/v1/appStoreVersionReleaseRequests');
const draftTrack = (api: FakePlayDraftApi, codes: string[] = ['241']) => {
  api.tracks = [
    {
      track: 'production',
      releases: [
        { name: '2.0', status: 'completed', versionCodes: ['200'] },
        { name: '2.1', status: 'draft', versionCodes: codes, releaseNotes: [{ language: 'en-US', text: 'Fixes' }] },
      ],
    },
  ];
};

// ----- App Store ---------------------------------------------------------------------------------------------

test('App Store: a version waiting for release is read with its build and its phased release', async () => {
  const { api, connector } = apple((a) => {
    waiting(a);
    a.phased.set('v-next', { id: 'ph-1', state: 'INACTIVE' });
  });
  const state = await connector.readReleaseState({});
  assert.equal(state.store, 'appstoreconnect');
  if (state.store !== 'appstoreconnect') return;
  assert.equal(state.releasable, true);
  assert.equal(state.ambiguous, false);
  assert.deepEqual(state.version, { id: 'v-next', versionString: '2.1', state: 'PENDING_DEVELOPER_RELEASE', releaseType: null });
  assert.equal(state.build?.buildNumber, '57');
  assert.deepEqual(state.phasedRelease, { id: 'ph-1', state: 'INACTIVE' });
  assert.equal(api.writes().length, 0);
});

test('App Store: release sends one release request for the waiting version and nothing else', async () => {
  const { api, connector } = apple(waiting);
  const result = await connector.release({ request: {}, guard: accept });
  assert.equal(result.via, 'release_request');
  assert.ok(result.releaseRequestId);
  assert.equal(releasePosts(api).length, 1);
  assert.equal(api.releaseRequests[0], 'v-next');
  assert.deepEqual(api.writes().length, 1, 'no version, review submission, phased release or build was written');
  const body = releasePosts(api)[0]?.body as { data: { type: string; relationships: { appStoreVersion: { data: { id: string } } } } };
  assert.equal(body.data.type, 'appStoreVersionReleaseRequests');
  assert.equal(body.data.relationships.appStoreVersion.data.id, 'v-next');
});

test('App Store: when the guard says the store changed nothing is sent', async () => {
  const { api, connector } = apple(waiting);
  await assert.rejects(connector.release({ request: {}, guard: () => false }), (error) => error instanceof ReleaseDriftError);
  assert.equal(api.writes().length, 0);
});

test('App Store: a version that is not waiting is refused and nothing is sent', async () => {
  const { api, connector } = apple();
  const state = await connector.readReleaseState({});
  if (state.store === 'appstoreconnect') {
    assert.equal(state.releasable, false);
    assert.equal(state.version, null);
    assert.ok(state.versions.some((v) => v.state === 'PREPARE_FOR_SUBMISSION'));
  }
  await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => error instanceof StoreError && error.kind === 'invalid_input');
  assert.equal(api.writes().length, 0);
});

test('App Store: two versions waiting need the marketing version to be named', async () => {
  const { api, connector } = apple((a) => {
    waiting(a);
    a.versions.push({ id: 'v-other', versionString: '2.2', state: 'PENDING_DEVELOPER_RELEASE' });
  });
  const state = await connector.readReleaseState({});
  if (state.store === 'appstoreconnect') {
    assert.equal(state.ambiguous, true);
    assert.equal(state.version, null);
    assert.equal(state.releasable, false);
  }
  await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => error instanceof StoreError && error.kind === 'invalid_input');
  assert.equal(api.writes().length, 0);
  const named = await connector.release({ request: { version: '2.2' }, guard: accept });
  assert.ok(named.releaseRequestId);
  assert.deepEqual(api.releaseRequests, ['v-other']);
});

test('App Store: a named version that does not wait is not released', async () => {
  const { api, connector } = apple(waiting);
  await assert.rejects(connector.release({ request: { version: '2.0' }, guard: accept }), (error) => error instanceof StoreError && error.kind === 'invalid_input');
  assert.equal(api.writes().length, 0);
});

test('App Store: macOS releases the macOS version only', async () => {
  const { api, connector } = apple((a) => {
    a.versions.push({ id: 'v-mac', versionString: '2.1', state: 'PENDING_DEVELOPER_RELEASE', platform: 'MAC_OS' });
    waiting(a);
  }, 'macos');
  const state = await connector.readReleaseState({});
  if (state.store === 'appstoreconnect') assert.equal(state.version?.id, 'v-mac');
  await connector.release({ request: {}, guard: accept });
  assert.deepEqual(api.releaseRequests, ['v-mac']);
});

test('App Store: a refused release (4xx) is an error and is not retried', async () => {
  const { api, connector } = apple((a) => {
    waiting(a);
    a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appStoreVersionReleaseRequests' ? reply(409, { errors: [{ status: '409', code: 'STATE_ERROR.INVALID_STATE', title: 'The version is not waiting for release' }] }) : undefined);
  });
  await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => error instanceof StoreError && !(error instanceof ReleaseOutcomeUnknownError));
  assert.equal(releasePosts(api).length, 1);
});

test('App Store: a 429 on the release is not retried', async () => {
  const { api, connector } = apple((a) => {
    waiting(a);
    a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appStoreVersionReleaseRequests' ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } }) : undefined);
  });
  await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => error instanceof StoreError);
  assert.equal(releasePosts(api).length, 1);
});

test('App Store: a 5xx or a lost answer on the release is an unknown outcome, never sent again', async () => {
  for (const make of [() => reply(503, { errors: [] }), () => new TypeError('socket hang up')]) {
    const { api, connector } = apple((a) => {
      waiting(a);
      a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appStoreVersionReleaseRequests' ? make() : undefined);
    });
    await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => error instanceof ReleaseOutcomeUnknownError);
    assert.equal(releasePosts(api).length, 1);
  }
});

test('App Store: a 403 names what Apple refused without a key or token in the message', async () => {
  const { connector } = apple((a) => {
    waiting(a);
    a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appStoreVersionReleaseRequests' ? reply(403, { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden' }] }) : undefined);
  });
  await assert.rejects(connector.release({ request: {}, guard: accept }), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'forbidden');
    assert.doesNotMatch(error.message, /BEGIN|eyJ/);
    return true;
  });
});

test('App Store: the state hash follows what the person confirms', async () => {
  const a = apple(waiting);
  const s1 = await a.connector.readReleaseState({});
  const s2 = await a.connector.readReleaseState({});
  assert.ok(sameReleaseState(s1, s2));
  assert.equal(releaseStateHash(s1), releaseStateHash(s2));
  a.api.phased.set('v-next', { id: 'ph-9', state: 'INACTIVE' });
  const s3 = await a.connector.readReleaseState({});
  assert.ok(!sameReleaseState(s1, s3));
  assert.notEqual(releaseStateHash(s1), releaseStateHash(s3));
});

// ----- Google Play -------------------------------------------------------------------------------------------

test('Google Play: the draft release, the others and the codes Play does not list are read', async () => {
  const { api, connector } = play((a) => draftTrack(a, ['241', '999']));
  const state = await connector.readReleaseState({ track: 'production' });
  assert.equal(state.store, 'googleplay');
  if (state.store !== 'googleplay') return;
  assert.equal(state.release?.name, '2.1');
  assert.equal(state.release?.status, 'draft');
  assert.deepEqual(state.release?.versionCodes, ['241', '999']);
  assert.deepEqual(state.missingCodes, ['999']);
  assert.equal(state.others.length, 1);
  assert.equal(state.ambiguous, false);
  assert.equal(api.commits.length, 0);
});

test('Google Play: release starts the draft to the share, keeps the other releases and commits once without holding it back', async () => {
  const { api, connector } = play((a) => draftTrack(a));
  const result = await connector.release({ request: { track: 'production', userFraction: 0.1 }, guard: accept });
  assert.equal(result.via, 'edit_commit');
  assert.equal(api.commits.length, 1);
  const query = api.commits[0]?.query ?? '';
  assert.match(query, /changesInReviewBehavior=ERROR_IF_IN_REVIEW/);
  assert.doesNotMatch(query, /changesNotSentForReview/);
  const releases = api.tracks.find((t) => t.track === 'production')?.releases ?? [];
  assert.equal(releases.length, 2);
  assert.deepEqual(releases.find((r) => r.name === '2.0'), { name: '2.0', status: 'completed', versionCodes: ['200'] });
  const started = releases.find((r) => r.name === '2.1');
  assert.equal(started?.status, 'inProgress');
  assert.equal(started?.userFraction, 0.1);
  assert.deepEqual(started?.versionCodes, ['241']);
  assert.deepEqual(started?.releaseNotes, [{ language: 'en-US', text: 'Fixes' }], 'the notes are not touched');
});

test('Google Play: a share of 1 completes the release and carries no userFraction', async () => {
  const { api, connector } = play((a) => draftTrack(a));
  await connector.release({ request: { track: 'production', userFraction: 1 }, guard: accept });
  const started = api.tracks.find((t) => t.track === 'production')?.releases.find((r) => r.name === '2.1');
  assert.equal(started?.status, 'completed');
  assert.equal(started?.userFraction, undefined);
});

test('Google Play: a missing or out of range share is refused before any edit is opened', async () => {
  for (const userFraction of [undefined, 0, -0.5, 1.5, Number.NaN]) {
    const { api, connector } = play((a) => draftTrack(a));
    await assert.rejects(
      connector.release({ request: { track: 'production', ...(userFraction !== undefined ? { userFraction } : {}) }, guard: accept }),
      (error) => error instanceof StoreError && error.kind === 'invalid_input',
    );
    assert.equal(api.seen.length, 0);
  }
  const { connector } = play();
  await assert.rejects(connector.release({ request: { userFraction: 0.1 }, guard: accept }), (error) => error instanceof StoreError && error.kind === 'invalid_input');
});

test('Google Play: when the guard says the store changed nothing is written and the edit is deleted', async () => {
  const { api, connector } = play((a) => draftTrack(a));
  await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.2 }, guard: () => false }), (error) => error instanceof ReleaseDriftError);
  assert.equal(api.commits.length, 0);
  assert.ok(!api.seen.some((s) => s.method === 'PUT'));
  assert.ok(api.seen.some((s) => s.method === 'DELETE'));
  assert.equal(api.tracks[0]?.releases.find((r) => r.name === '2.1')?.status, 'draft');
});

test('Google Play: a track without a draft release is refused', async () => {
  const { api, connector } = play();
  await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.2 }, guard: accept }), (error) => error instanceof StoreError && error.kind === 'invalid_input');
  assert.equal(api.commits.length, 0);
  assert.ok(!api.seen.some((s) => s.method === 'PUT'));
});

test('Google Play: two drafts need the version codes to pick one', async () => {
  const { api, connector } = play((a) => {
    a.tracks = [
      {
        track: 'production',
        releases: [
          { name: 'a', status: 'draft', versionCodes: ['240'] },
          { name: 'b', status: 'draft', versionCodes: ['241'] },
        ],
      },
    ];
  });
  const state = await connector.readReleaseState({ track: 'production' });
  if (state.store === 'googleplay') {
    assert.equal(state.ambiguous, true);
    assert.equal(state.release, null);
  }
  await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.5 }, guard: accept }), (error) => error instanceof StoreError);
  assert.equal(api.commits.length, 0);
  await connector.release({ request: { track: 'production', versionCodes: ['241'], userFraction: 0.5 }, guard: accept });
  const releases = api.tracks[0]?.releases ?? [];
  assert.equal(releases.find((r) => r.name === 'a')?.status, 'draft');
  assert.equal(releases.find((r) => r.name === 'b')?.status, 'inProgress');
});

test('Google Play: a release already rolling out in the track is shown among the others', async () => {
  const { connector } = play((a) => {
    a.tracks = [
      {
        track: 'production',
        releases: [
          { name: '2.0', status: 'inProgress', userFraction: 0.5, versionCodes: ['200'] },
          { name: '2.1', status: 'draft', versionCodes: ['241'] },
        ],
      },
    ];
  });
  const state = await connector.readReleaseState({ track: 'production' });
  if (state.store === 'googleplay') assert.deepEqual(state.others.map((o) => [o.status, o.userFraction]), [['inProgress', 0.5]]);
});

test('Google Play: changes already in review are an error, nothing is cancelled and the track is unchanged', async () => {
  const { api, connector } = play((a) => {
    draftTrack(a);
    a.commitAnswer = 'in_review';
  });
  await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.1 }, guard: accept }), (error) => error instanceof StoreError && error.kind === 'changes_in_review');
  assert.equal(api.commits.length, 1);
  assert.equal(api.tracks[0]?.releases.find((r) => r.name === '2.1')?.status, 'draft');
});

test('Google Play: a 5xx or a lost answer on the commit is an unknown outcome, never committed again', async () => {
  for (const commitAnswer of ['server_error', 'cut'] as const) {
    const { api, connector } = play((a) => {
      draftTrack(a);
      a.commitAnswer = commitAnswer;
    });
    await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.1 }, guard: accept }), (error) => error instanceof ReleaseOutcomeUnknownError);
    assert.equal(api.commits.length, 1);
    assert.ok(!api.seen.some((s) => s.method === 'DELETE'), 'the edit of an unknown outcome is left alone');
  }
});

test('Google Play: a rejected track update commits nothing', async () => {
  const { api, connector } = play((a) => {
    draftTrack(a);
    a.hook = (s) => (s.method === 'PUT' ? reply(400, { error: { code: 400, message: 'Invalid release' } }) : undefined);
  });
  await assert.rejects(connector.release({ request: { track: 'production', userFraction: 0.1 }, guard: accept }), (error) => error instanceof StoreError);
  assert.equal(api.commits.length, 0);
});
