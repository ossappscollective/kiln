import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleDraftConnector } from './appstore-draft.ts';
import { StoreError } from './errors.ts';
import { PlayDraftConnector } from './play-draft.ts';
import { type DraftApplyInput, type DraftFieldWrite, DraftOutcomeUnknownError, DraftDriftError } from './store-draft-types.ts';
import { isStoreReleaseReader } from './release-types.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, FakePlayDraftApi } from './store-draft.fixtures.ts';

/**
 * Release fields of a draft (docs/api/releases-write.md): the App Store version's own fields, its build and phased release,
 * and the draft release of a Google Play track; and the reads that let a person pick a build or a version code. Fakes only.
 */

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();
const APP = '10746822401';
const PKG = 'com.example.coffee';
const accept = () => true;
const input = (over: Partial<DraftApplyInput> = {}): DraftApplyInput => ({ text: [], assets: [], guard: accept, ...over });
const field = (name: string, value: string, locale = ''): DraftFieldWrite => ({ field: name, locale, value });
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function apple(configure?: (api: FakeAppleDraftApi) => void, platform: 'ios' | 'macos' = 'ios') {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleDraftConnector({
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
  const connector = new PlayDraftConnector({
    serviceAccount: fx.serviceAccountJson(googleKey.privateKey),
    packageName: PKG,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}

/** Nothing that releases, submits or creates a version. */
const NEVER = /reviewSubmission|appStoreVersionReleaseRequests|appStoreVersionSubmissions|:commit\?(?!.*changesNotSentForReview=true)/;
function assertDraftOnlyApple(api: FakeAppleDraftApi) {
  for (const s of api.seen) assert.ok(!NEVER.test(s.path), `unexpected ${s.method} ${s.path}`);
  assert.equal(api.releaseRequests.length, 0);
}

// ----- App Store: reading ----------------------------------------------------------------------------------

test('App Store: readDraft shows the version fields, the attached build, the wanted build and the phased release', async () => {
  const { api, connector } = apple((a) => {
    const v = a.versions.find((x) => x.id === 'v-next');
    if (v) Object.assign(v, { releaseType: 'MANUAL', earliestReleaseDate: '2026-12-01T10:00:00+00:00', copyright: '2026 Old Inc.' });
    a.phased.set('v-next', { id: 'ph-1', state: 'INACTIVE' });
  });
  const state = await connector.readDraft({
    text: [],
    assets: [],
    fields: [field('version_string', '2.2'), field('release_type', 'SCHEDULED'), field('earliest_release_date', '2027-01-01T00:00:00Z'), field('copyright', 'x'), field('build', 'b-2'), field('phased_release', 'off')],
  });
  const by = (name: string) => state.fields?.find((f) => f.field === name);
  assert.equal(by('version_string')?.value, '2.1');
  assert.equal(by('release_type')?.value, 'MANUAL');
  assert.equal(by('earliest_release_date')?.value, '2026-12-01T10:00:00Z', 'Apple’s +00:00 is the canonical Z form');
  assert.equal(by('copyright')?.value, '2026 Old Inc.');
  assert.equal(by('build')?.value, 'b-1');
  assert.deepEqual(by('build')?.facts, { currentNumber: '57', wantedFound: true, wantedNumber: '58', wantedProcessingState: 'VALID', wantedExpired: false });
  assert.equal(by('phased_release')?.value, 'on');
  assert.equal(by('phased_release')?.facts?.phasedReleaseId, 'ph-1');
  assert.deepEqual(state.version, { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' }, 'the version carries no attributes');
  assert.equal(api.writes().length, 0);
});

test('App Store: a build Apple does not know, and one that is still processing, are reported as facts', async () => {
  const { connector } = apple();
  const state = await connector.readDraft({ text: [], assets: [], fields: [field('build', 'nope')] });
  assert.equal(state.fields?.[0]?.facts?.wantedFound, false);
  const processing = await connector.readDraft({ text: [], assets: [], fields: [field('build', 'b-3')] });
  assert.equal(processing.fields?.[0]?.facts?.wantedProcessingState, 'PROCESSING');
});

// ----- App Store: writing ----------------------------------------------------------------------------------

test('App Store: one PATCH for the version fields and the build, then the phased release; a second push changes nothing', async () => {
  const { api, connector } = apple();
  const fields = [field('version_string', '2.2'), field('release_type', 'MANUAL'), field('copyright', '2026 Acme'), field('build', 'b-2'), field('phased_release', 'on')];
  const done = await connector.applyDraft(input({ fields }));
  assert.equal(done.commit, 'none');
  assert.deepEqual(done.steps.map((s) => [s.type, s.target, s.outcome]).sort(), [
    ['field', 'build', 'applied'],
    ['field', 'copyright', 'applied'],
    ['field', 'phased_release', 'applied'],
    ['field', 'release_type', 'applied'],
    ['field', 'version_string', 'applied'],
  ]);
  assert.deepEqual(api.writes(), ['PATCH /v1/appStoreVersions/v-next', 'POST /v1/appStoreVersionPhasedReleases']);
  const patch = api.seen.find((s) => s.method === 'PATCH')?.body as { data: { attributes: Record<string, string>; relationships: { build: { data: { id: string } } } } };
  assert.deepEqual(patch.data.attributes, { versionString: '2.2', releaseType: 'MANUAL', copyright: '2026 Acme' });
  assert.deepEqual(patch.data.relationships.build.data, { type: 'builds', id: 'b-2' });
  const post = api.seen.find((s) => s.method === 'POST')?.body as { data: { attributes: { phasedReleaseState: string } } };
  assert.equal(post.data.attributes.phasedReleaseState, 'INACTIVE', 'switching it on does not start it: Apple starts it at the release');
  assert.equal(api.versions.find((v) => v.id === 'v-next')?.versionString, '2.2');
  assert.equal(api.builds.get('v-next')?.id, 'b-2');
  assert.equal(api.phased.size, 1);
  assertDraftOnlyApple(api);

  api.seen.length = 0;
  const again = await connector.applyDraft(input({ fields }));
  assert.deepEqual(again.steps.map((s) => s.outcome), ['already_same', 'already_same', 'already_same', 'already_same', 'already_same']);
  assert.deepEqual(api.writes(), [], 'a repeated push sends nothing');
});

test('App Store: phased release off deletes the phased release; only what differs is sent', async () => {
  const { api, connector } = apple((a) => {
    a.phased.set('v-next', { id: 'ph-1', state: 'INACTIVE' });
  });
  const done = await connector.applyDraft(input({ fields: [field('phased_release', 'off'), field('release_type', 'AFTER_APPROVAL')] }));
  assert.deepEqual(api.writes(), ['PATCH /v1/appStoreVersions/v-next', 'DELETE /v1/appStoreVersionPhasedReleases/ph-1']);
  assert.equal(api.phased.size, 0);
  assert.deepEqual(done.steps.map((s) => s.outcome), ['applied', 'applied']);
  const off = await connector.applyDraft(input({ fields: [field('phased_release', 'off')] }));
  assert.deepEqual(off.steps.map((s) => s.outcome), ['already_same']);
});

test('App Store: the guard sees the fields before anything is written, and a drift writes nothing', async () => {
  const { api, connector } = apple();
  await assert.rejects(
    connector.applyDraft(input({ fields: [field('copyright', '2026 Acme')], guard: () => false })),
    (error) => error instanceof DraftDriftError && error.current.fields?.[0]?.field === 'copyright',
  );
  assert.deepEqual(api.writes(), []);
});

test('App Store: Apple refusing the build is a plain refusal (nothing was applied); a lost answer is an unknown outcome', async () => {
  const refused = apple((a) => {
    const b = a.buildList.find((x) => x.id === 'b-2');
    if (b) b.processingState = 'INVALID';
  });
  await assert.rejects(refused.connector.applyDraft(input({ fields: [field('build', 'b-2')] })), (error) => error instanceof StoreError && !(error instanceof DraftOutcomeUnknownError));
  const lost = apple((a) => {
    a.hook = (s) => (s.method === 'PATCH' ? new TypeError('socket hang up') : undefined);
  });
  await assert.rejects(lost.connector.applyDraft(input({ fields: [field('copyright', '2026 Acme')] })), (error) => error instanceof DraftOutcomeUnknownError);
  const server = apple((a) => {
    a.hook = (s) => (s.method === 'PATCH' ? reply(503) : undefined);
  });
  await assert.rejects(server.connector.applyDraft(input({ fields: [field('copyright', '2026 Acme')] })), (error) => error instanceof DraftOutcomeUnknownError);
});

test('App Store: a version that is not editable is refused before any field is written', async () => {
  const { api, connector } = apple((a) => {
    for (const v of a.versions) if (v.id === 'v-next') v.state = 'WAITING_FOR_REVIEW';
  });
  await assert.rejects(connector.applyDraft(input({ fields: [field('copyright', 'x')] })), (error) => error instanceof StoreError && error.kind === 'no_editable_version');
  assert.deepEqual(api.writes(), []);
});

// ----- App Store: the reads ----------------------------------------------------------------------------------

test('App Store: listReleaseCandidates lists the builds of this platform with processing state, expiry and the attached build', async () => {
  const { api, connector } = apple();
  assert.ok(isStoreReleaseReader(connector));
  const list = await connector.listReleaseCandidates({});
  assert.equal(list.store, 'appstoreconnect');
  if (list.store !== 'appstoreconnect') throw new Error('unreachable');
  assert.deepEqual(list.version, { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' });
  assert.equal(list.attachedBuildId, 'b-1');
  assert.deepEqual(list.builds.map((b) => [b.id, b.buildNumber, b.version, b.processingState, b.expired, b.selectable, b.attached]), [
    ['b-1', '57', '2.1', 'VALID', false, true, true],
    ['b-2', '58', '2.1', 'VALID', false, true, false],
    ['b-3', '59', '2.1', 'PROCESSING', false, false, false],
    ['b-old', '40', '2.0', 'VALID', true, false, false],
  ]);
  assert.match(list.builds[2]?.reason ?? '', /not processed \(PROCESSING\)/);
  assert.match(list.builds[3]?.reason ?? '', /expired/);
  assert.equal(list.builds[0]?.uploadedDate, '2026-11-17T09:00:00-08:00');
  assert.equal(list.truncatedAt, null);
  const query = api.seen.find((s) => s.path === '/v1/builds')?.query ?? '';
  assert.match(decodeURIComponent(query), /filter\[app\]=10746822401/);
  assert.match(decodeURIComponent(query), /filter\[preReleaseVersion\.platform\]=IOS/);
  assert.equal(api.writes().length, 0);
  const only = await connector.listReleaseCandidates({ version: '2.0' });
  assert.deepEqual(only.store === 'appstoreconnect' ? only.builds.map((b) => b.id) : [], ['b-old']);
});

test('macOS: only the Mac builds are listed, and the Mac version is the one read', async () => {
  const { api, connector } = apple((a) => {
    a.versions.push({ id: 'v-mac', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION', platform: 'MAC_OS' });
    a.builds.set('v-mac', { id: 'b-mac', version: '9', processingState: 'VALID', expired: false });
  }, 'macos');
  const list = await connector.listReleaseCandidates({});
  if (list.store !== 'appstoreconnect') throw new Error('unreachable');
  assert.equal(list.platform, 'macos');
  assert.deepEqual(list.builds.map((b) => b.id), ['b-mac']);
  assert.equal(list.version?.id, 'v-mac');
  assert.match(decodeURIComponent(api.seen.find((s) => s.path === '/v1/builds')?.query ?? ''), /preReleaseVersion\.platform\]=MAC_OS/);
});

test('App Store: readEditableRelease shows the version, release type, date, copyright, build, phased release and the notes', async () => {
  const { connector } = apple((a) => {
    const v = a.versions.find((x) => x.id === 'v-next');
    if (v) Object.assign(v, { releaseType: 'SCHEDULED', earliestReleaseDate: '2026-12-01T10:00:00Z', copyright: '2026 Acme' });
    a.phased.set('v-next', { id: 'ph-1', state: 'INACTIVE' });
  });
  const release = await connector.readEditableRelease();
  if (release.store !== 'appstoreconnect') throw new Error('unreachable');
  assert.equal(release.version.versionString, '2.1');
  assert.equal(release.releaseType, 'SCHEDULED');
  assert.equal(release.earliestReleaseDate, '2026-12-01T10:00:00Z');
  assert.equal(release.copyright, '2026 Acme');
  assert.deepEqual(release.build, { id: 'b-1', buildNumber: '57', processingState: 'VALID', expired: false });
  assert.deepEqual(release.phasedRelease, { id: 'ph-1', state: 'INACTIVE' });
  assert.deepEqual(release.releaseNotes, [{ locale: 'en-US', text: 'Old news' }]);
});

test('App Store: with no editable version the reads say so, and the build list still works', async () => {
  const { connector } = apple((a) => {
    for (const v of a.versions) if (v.id === 'v-next') v.state = 'IN_REVIEW';
  });
  await assert.rejects(connector.readEditableRelease(), (error) => error instanceof StoreError && error.kind === 'no_editable_version');
  const list = await connector.listReleaseCandidates({});
  assert.equal(list.store === 'appstoreconnect' ? list.version : 'x', null);
});

// ----- Google Play -----------------------------------------------------------------------------------------

test('Google Play: readDraft of the release fields with no draft release; missing version codes are a fact', async () => {
  const { api, connector } = play();
  const state = await connector.readDraft({
    text: [],
    assets: [],
    fields: [field('track', 'production'), field('release_name', '2.4.0'), field('version_codes', '240,999'), field('release_notes', 'Fixes', 'en-US')],
  });
  const by = (name: string) => state.fields?.find((f) => f.field === name);
  assert.equal(by('track')?.value, 'production');
  assert.deepEqual(by('track')?.facts, { draftCount: 0, otherInProgress: 0 });
  assert.equal(by('release_name')?.value, null);
  assert.equal(by('version_codes')?.value, null);
  assert.equal(by('version_codes')?.facts?.missing, '999', 'Play lists 240 as uploaded and 999 not');
  assert.equal(by('release_notes')?.value, null);
  assert.equal(api.commits.length, 0);
  assert.equal(api.seen.filter((s) => s.method === 'PUT').length, 0);
});

test('Google Play: a draft release is created next to the others and committed held back from review; never a share', async () => {
  const { api, connector } = play();
  const fields = [field('track', 'production'), field('release_name', '2.4.0'), field('version_codes', '240,241'), field('release_notes', 'Fixes and speed', 'en-US'), field('release_notes', 'Korrekturen', 'de-DE')];
  const done = await connector.applyDraft(input({ fields }));
  assert.equal(done.commit, 'not_sent_for_review');
  assert.deepEqual(done.steps.map((s) => [s.type, s.target, s.locale, s.outcome]), [
    ['field', 'track', '', 'already_same'],
    ['field', 'release_name', '', 'applied'],
    ['field', 'version_codes', '', 'applied'],
    ['field', 'release_notes', 'en-US', 'applied'],
    ['field', 'release_notes', 'de-DE', 'applied'],
  ]);
  const put = api.seen.find((s) => s.method === 'PUT' && /\/tracks\/production$/.test(s.path))?.body as { track: string; releases: Record<string, unknown>[] };
  assert.equal(put.track, 'production');
  assert.equal(put.releases.length, 2, 'the completed release is sent back unchanged');
  assert.deepEqual(put.releases[0], { name: '2.0', status: 'completed', versionCodes: ['200'] });
  assert.deepEqual(put.releases[1], {
    status: 'draft',
    name: '2.4.0',
    versionCodes: ['240', '241'],
    releaseNotes: [
      { language: 'en-US', text: 'Fixes and speed' },
      { language: 'de-DE', text: 'Korrekturen' },
    ],
  });
  assert.ok(!('userFraction' in (put.releases[1] as object)), 'a draft holds no share');
  assert.equal(api.commits.length, 1);
  assert.match(api.commits[0]?.query ?? '', /changesNotSentForReview=true/);
  assert.match(api.commits[0]?.query ?? '', /changesInReviewBehavior=ERROR_IF_IN_REVIEW/);
  assert.deepEqual(api.tracks.find((t) => t.track === 'production')?.releases.map((r) => r.status), ['completed', 'draft']);

  api.seen.length = 0;
  const again = await connector.applyDraft(input({ fields }));
  assert.equal(again.commit, 'none', 'nothing differs: no commit');
  assert.ok(again.steps.every((s) => s.outcome === 'already_same'));
  assert.equal(api.seen.filter((s) => s.method === 'PUT').length, 0);
  assert.equal(api.commits.length, 1, 'still the one commit of the first push');
});

test('Google Play: an existing draft release keeps what is not staged; only the staged fields change', async () => {
  const { api, connector } = play((a) => {
    a.tracks.push({
      track: 'beta',
      releases: [{ name: 'old name', status: 'draft', versionCodes: ['240'], releaseNotes: [{ language: 'en-US', text: 'Old notes' }, { language: 'fr-FR', text: 'Anciennes notes' }] }, { name: 'live', status: 'inProgress', userFraction: 0.2, versionCodes: ['200'] }],
    });
  });
  const done = await connector.applyDraft(input({ fields: [field('track', 'beta'), field('release_notes', 'New notes', 'en-US')] }));
  assert.equal(done.commit, 'not_sent_for_review');
  const beta = api.tracks.find((t) => t.track === 'beta')?.releases ?? [];
  assert.deepEqual(beta[0], {
    name: 'old name',
    status: 'draft',
    versionCodes: ['240'],
    releaseNotes: [{ language: 'en-US', text: 'New notes' }, { language: 'fr-FR', text: 'Anciennes notes' }],
  });
  assert.deepEqual(beta[1], { name: 'live', status: 'inProgress', userFraction: 0.2, versionCodes: ['200'] }, 'the rolling release is untouched');
});

test('Google Play: no draft release and no version codes is refused and nothing is committed; two drafts are not guessed between', async () => {
  const none = play();
  await assert.rejects(none.connector.applyDraft(input({ fields: [field('track', 'production'), field('release_notes', 'Fixes', 'en-US')] })), (error) => error instanceof StoreError && error.kind === 'invalid_input');
  assert.equal(none.api.commits.length, 0);
  assert.equal(none.api.seen.filter((s) => s.method === 'PUT').length, 0);
  const two = play((a) => {
    a.tracks.push({ track: 'beta', releases: [{ status: 'draft', versionCodes: ['240'] }, { status: 'draft', versionCodes: ['241'] }] });
  });
  await assert.rejects(two.connector.applyDraft(input({ fields: [field('track', 'beta'), field('release_name', 'x')] })), (error) => error instanceof StoreError && /more than one draft/.test(error.message));
  assert.equal(two.api.commits.length, 0);
});

test('Google Play: the intended share is never sent; a lost commit answer is an unknown outcome', async () => {
  const { api, connector } = play((a) => {
    a.commitAnswer = 'cut';
  });
  await assert.rejects(
    connector.applyDraft(input({ fields: [field('track', 'production'), field('version_codes', '240'), field('user_fraction', '0.1')] })),
    (error) => error instanceof DraftOutcomeUnknownError,
  );
  const put = api.seen.find((s) => s.method === 'PUT' && /tracks\/production/.test(s.path))?.body as { releases: Record<string, unknown>[] };
  assert.ok(put.releases.every((r) => !('userFraction' in r)));
});

test('Google Play: listReleaseCandidates lists uploaded version codes and where the track uses them; readEditableRelease the draft', async () => {
  const { api, connector } = play((a) => {
    a.apks = [{ versionCode: 100, binary: { sha256: 'd'.repeat(64) } }];
    a.tracks = [{ track: 'production', releases: [{ name: '2.0', status: 'completed', versionCodes: ['200'] }, { name: 'next', status: 'draft', versionCodes: ['240'], releaseNotes: [{ language: 'en-US', text: 'Hi' }] }] }];
  });
  assert.ok(isStoreReleaseReader(connector));
  const list = await connector.listReleaseCandidates({ track: 'production' });
  if (list.store !== 'googleplay') throw new Error('unreachable');
  assert.deepEqual(list.codes.map((c) => [c.versionCode, c.source, c.inTrack.map((t) => t.status)]), [
    ['241', 'bundle', []],
    ['240', 'bundle', ['draft']],
    ['200', 'bundle', ['completed']],
    ['100', 'apk', []],
  ]);
  const release = await connector.readEditableRelease({ track: 'production' });
  if (release.store !== 'googleplay') throw new Error('unreachable');
  assert.deepEqual(release.draft, { name: 'next', status: 'draft', userFraction: null, versionCodes: ['240'], notes: [{ locale: 'en-US', text: 'Hi' }] });
  assert.deepEqual(release.others.map((o) => o.status), ['completed']);
  assert.equal(api.commits.length, 0, 'reads never commit');
  await assert.rejects(connector.listReleaseCandidates({}), (error) => error instanceof StoreError && error.kind === 'invalid_input');
});
