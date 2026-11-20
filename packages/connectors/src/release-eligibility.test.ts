import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleDraftConnector } from './appstore-draft.ts';
import { StoreError } from './errors.ts';
import { PlayDraftConnector } from './play-draft.ts';
import {
  appleBuildEligibility,
  type BuildFacts,
  playCodeEligibility,
} from './release-eligibility.ts';
import {
  isStoreNotesHistoryReader,
  MAX_BUILDS_WITH_NOTES,
  MAX_NOTE_CHARS,
  MAX_NOTE_LOCALES,
} from './release-types.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, FakePlayDraftApi } from './store-draft.fixtures.ts';

/** Eligibility verdicts, TestFlight notes and the notes history of earlier versions (docs/api/releases-write.md). Fakes only. */

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();

function apple(configure?: (api: FakeAppleDraftApi) => void) {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleDraftConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: appleKey.privateKey },
    appStoreId: '10746822401',
    platform: 'ios',
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
    packageName: 'com.example.coffee',
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}
const builds = async (connector: AppleDraftConnector) => {
  const list = await connector.listReleaseCandidates({});
  if (list.store !== 'appstoreconnect') throw new Error('unreachable');
  return list.builds;
};
const calls = (api: FakeAppleDraftApi, re: RegExp) => api.seen.filter((s) => re.test(s.path));

// ----- the verdict --------------------------------------------------------------------------------------

const facts = (over: Partial<BuildFacts> = {}): BuildFacts => ({
  buildNumber: '58',
  version: '2.1',
  processingState: 'VALID',
  expired: false,
  exportCompliance: 'answered',
  attached: false,
  ...over,
});
const draft = { versionString: '2.1' };

test('verdict: every reason has a code, a severity and a plain sentence', () => {
  const cases: [
    Partial<BuildFacts>,
    { versionString: string | null } | null,
    string,
    boolean,
    string,
  ][] = [
    [{}, draft, 'ok', true, 'ok'],
    [{ processingState: 'PROCESSING' }, draft, 'processing', false, 'blocked'],
    [{ processingState: 'FAILED' }, draft, 'failed', false, 'blocked'],
    [{ processingState: 'INVALID' }, draft, 'invalid', false, 'blocked'],
    [{ processingState: null }, draft, 'state_unknown', false, 'blocked'],
    [{ processingState: 'SOMETHING_NEW' }, draft, 'state_unknown', false, 'blocked'],
    [{ expired: true }, draft, 'expired', false, 'blocked'],
    [{ version: '2.0' }, draft, 'wrong_version', true, 'warning'],
    [{}, null, 'no_editable_version', false, 'blocked'],
    [{ attached: true }, draft, 'already_attached', false, 'ok'],
    [{ exportCompliance: 'missing' }, draft, 'export_compliance_missing', true, 'warning'],
    [{ exportCompliance: 'unknown' }, draft, 'ok', true, 'ok'],
    [{ version: null }, draft, 'ok', true, 'ok'],
  ];
  for (const [over, editable, code, eligible, severity] of cases) {
    const v = appleBuildEligibility(facts(over), editable);
    assert.deepEqual(
      [v.code, v.eligible, v.severity],
      [code, eligible, severity],
      JSON.stringify(over),
    );
    assert.ok(v.message.length > 10 && v.message.endsWith('.'), v.message);
  }
  assert.match(
    appleBuildEligibility(facts({ version: '2.0' }), draft).message,
    /was built as version 2\.0, and the version being prepared is named 2\.1/,
  );
  // Expiry wins over the processing state: an expired build is never offered.
  assert.equal(
    appleBuildEligibility(facts({ expired: true, processingState: 'PROCESSING' }), draft).code,
    'expired',
  );
});

test('verdict (Google Play): a code in a live release is blocked, one in the draft is already there, else it is free', () => {
  assert.deepEqual(playCodeEligibility({ versionCode: '1', inTrack: [] }).code, 'ok');
  assert.equal(
    playCodeEligibility({ versionCode: '1', inTrack: [{ name: 'x', status: 'draft' }] }).code,
    'already_in_draft',
  );
  const live = playCodeEligibility({
    versionCode: '1',
    inTrack: [{ name: 'x', status: 'completed' }],
  });
  assert.deepEqual([live.code, live.eligible, live.severity], ['already_live', false, 'blocked']);
  assert.match(
    playCodeEligibility({ versionCode: '1', inTrack: [{ name: 'x', status: 'inProgress' }] })
      .message,
    /rolling out/,
  );
});

// ----- App Store builds ---------------------------------------------------------------------------------

test('App Store: each build carries its verdict; a build of another version can still be chosen, with a warning', async () => {
  const { connector } = apple((a) => {
    a.buildList.push({
      id: 'b-20',
      version: '41',
      processingState: 'VALID',
      expired: false,
      uploadedDate: '2026-09-01T09:00:00-07:00',
      marketing: '2.0',
    });
  });
  const list = await builds(connector);
  const by = Object.fromEntries(list.map((b) => [b.id, b.eligibility.code]));
  assert.deepEqual(by, {
    'b-1': 'already_attached',
    'b-2': 'ok',
    'b-3': 'processing',
    'b-old': 'expired',
    'b-20': 'wrong_version',
  });
  // The older fields stay for older clients.
  assert.equal(list.find((b) => b.id === 'b-2')?.selectable, true);
});

test('App Store: export compliance missing is a warning; unknown when Apple does not say or rejects the field', async () => {
  const { api, connector } = apple((a) => {
    const b2 = a.buildList.find((b) => b.id === 'b-2');
    if (b2) b2.usesNonExemptEncryption = null;
    const b1 = a.buildList.find((b) => b.id === 'b-1');
    if (b1) b1.usesNonExemptEncryption = false;
  });
  const list = await builds(connector);
  assert.deepEqual(
    list.map((b) => [b.id, b.exportCompliance]),
    [
      ['b-1', 'answered'],
      ['b-2', 'missing'],
      ['b-3', 'unknown'],
      ['b-old', 'unknown'],
    ],
  );
  const b2 = list.find((b) => b.id === 'b-2');
  assert.deepEqual(
    [b2?.eligibility.code, b2?.eligibility.severity, b2?.eligibility.eligible],
    ['export_compliance_missing', 'warning', true],
  );
  assert.match(
    decodeURIComponent(calls(api, /^\/v1\/builds$/)[0]?.query ?? ''),
    /fields\[builds\]=[^&]*usesNonExemptEncryption/,
  );

  // Apple rejects the field list: the read is repeated without it and nothing else changes.
  const rejected = apple((a) => {
    a.rejectComplianceField = true;
  });
  const again = await builds(rejected.connector);
  assert.equal(again.length, 4);
  assert.ok(again.every((b) => b.exportCompliance === 'unknown'));
  const reads = calls(rejected.api, /^\/v1\/builds$/);
  assert.equal(reads.length, 2);
  assert.doesNotMatch(decodeURIComponent(reads[1]?.query ?? ''), /usesNonExemptEncryption/);
});

// ----- TestFlight notes ---------------------------------------------------------------------------------

test('TestFlight notes: read for processed builds only, each build on its own, capped, never from a build that cannot be chosen', async () => {
  const long = 'x'.repeat(MAX_NOTE_CHARS + 500);
  const { api, connector } = apple((a) => {
    a.testNotes.set('b-1', [
      { locale: 'en-US', whatsNew: 'Try the new login' },
      { locale: 'de-DE', whatsNew: '  ' },
      { locale: 'fr-FR', whatsNew: long },
    ]);
    a.testNotes.set('b-2', [{ locale: 'en-US', whatsNew: 'SECRET-NOTE' }]);
    a.testNotesFail.set('b-2', 403);
    a.testNotes.set('b-3', [{ locale: 'en-US', whatsNew: 'processing build' }]);
  });
  const list = await builds(connector);
  const by = Object.fromEntries(list.map((b) => [b.id, b.testNotes]));
  assert.deepEqual(
    by['b-1']?.locales.map((l) => [l.locale, l.truncated, l.text.length]),
    [
      ['en-US', false, 17],
      ['fr-FR', true, MAX_NOTE_CHARS],
    ],
  );
  assert.equal(by['b-1']?.read, true);
  assert.deepEqual(
    by['b-2'],
    { read: false, locales: [], error: 'forbidden' },
    'one failing build does not hide the others',
  );
  assert.deepEqual(
    by['b-3'],
    { read: false, locales: [] },
    'a build that is still processing is not asked',
  );
  assert.deepEqual(by['b-old'], { read: false, locales: [] }, 'an expired one neither');
  assert.deepEqual(
    calls(api, /betaBuildLocalizations$/)
      .map((s) => s.path)
      .sort(),
    ['/v1/builds/b-1/betaBuildLocalizations', '/v1/builds/b-2/betaBuildLocalizations'],
  );
  assert.ok(!JSON.stringify(list.map((b) => b.testNotes.error)).includes('SECRET'));
  assert.equal(api.writes().length, 0);
});

test('TestFlight notes: at most the newest builds are read, and at most so many languages each', async () => {
  const { api, connector } = apple((a) => {
    a.buildList = Array.from({ length: 12 }, (_, i) => ({
      id: `b-${i}`,
      version: String(100 - i),
      processingState: 'VALID',
      expired: false,
      uploadedDate: `2026-11-${String(20 - i).padStart(2, '0')}T09:00:00Z`,
      marketing: '2.1',
    }));
    a.testNotes.set(
      'b-0',
      Array.from({ length: MAX_NOTE_LOCALES + 10 }, (_, i) => ({
        locale: `l${i}`,
        whatsNew: 'text',
      })),
    );
  });
  const list = await builds(connector);
  assert.equal(list.length, 12);
  assert.equal(calls(api, /betaBuildLocalizations$/).length, MAX_BUILDS_WITH_NOTES);
  assert.equal(list[0]?.testNotes.locales.length, MAX_NOTE_LOCALES);
  assert.equal(list[MAX_BUILDS_WITH_NOTES]?.testNotes.read, false);
  assert.equal(list[MAX_BUILDS_WITH_NOTES - 1]?.testNotes.read, true);
});

test('TestFlight notes: a rate limit or a server error is a code, not a message', async () => {
  const { connector } = apple((a) => {
    a.testNotesFail.set('b-1', 500);
    a.testNotesFail.set('b-2', 404);
  });
  const list = await builds(connector);
  assert.equal(list.find((b) => b.id === 'b-1')?.testNotes.error, 'unavailable');
  assert.equal(list.find((b) => b.id === 'b-2')?.testNotes.error, 'not_found');
});

// ----- notes history ------------------------------------------------------------------------------------

const history = (a: FakeAppleDraftApi) => {
  a.versions = [
    {
      id: 'v-10',
      versionString: '1.0',
      state: 'REPLACED_WITH_NEW_VERSION',
      createdDate: '2025-01-10T10:00:00Z',
    },
    {
      id: 'v-15',
      versionString: '1.5',
      state: 'READY_FOR_DISTRIBUTION',
      createdDate: '2025-06-10T10:00:00Z',
    },
    {
      id: 'v-20',
      versionString: '2.0',
      state: 'READY_FOR_DISTRIBUTION',
      createdDate: '2026-01-10T10:00:00Z',
    },
    {
      id: 'v-mac',
      versionString: '9.0',
      state: 'READY_FOR_DISTRIBUTION',
      platform: 'MAC_OS',
      createdDate: '2026-02-10T10:00:00Z',
    },
    {
      id: 'v-next',
      versionString: '2.1',
      state: 'PREPARE_FOR_SUBMISSION',
      createdDate: '2026-10-10T10:00:00Z',
    },
  ];
  a.locs.clear();
  a.locs.set('l1', {
    versionId: 'v-10',
    locale: 'en-US',
    attributes: { locale: 'en-US', whatsNew: 'First release' },
  });
  a.locs.set('l2', {
    versionId: 'v-15',
    locale: 'en-US',
    attributes: { locale: 'en-US', whatsNew: 'Dark mode' },
  });
  a.locs.set('l3', {
    versionId: 'v-15',
    locale: 'de-DE',
    attributes: { locale: 'de-DE', whatsNew: 'Dunkelmodus' },
  });
  a.locs.set('l4', {
    versionId: 'v-20',
    locale: 'en-US',
    attributes: { locale: 'en-US', whatsNew: 'Bug fixes' },
  });
  a.locs.set('l5', {
    versionId: 'v-next',
    locale: 'en-US',
    attributes: { locale: 'en-US', whatsNew: '  ' },
  });
  a.locs.set('lm', {
    versionId: 'v-mac',
    locale: 'en-US',
    attributes: { locale: 'en-US', whatsNew: 'Mac only' },
  });
};

test('notes history (App Store): this platform only, newest version first, with the version, state and date', async () => {
  const { api, connector } = apple(history);
  assert.ok(isStoreNotesHistoryReader(connector));
  const read = await connector.readNotesHistory({});
  assert.deepEqual(
    read.entries.map((e) => [e.version, e.locale, e.text, e.state]),
    [
      ['2.0', 'en-US', 'Bug fixes', 'READY_FOR_DISTRIBUTION'],
      ['1.5', 'en-US', 'Dark mode', 'READY_FOR_DISTRIBUTION'],
      ['1.5', 'de-DE', 'Dunkelmodus', 'READY_FOR_DISTRIBUTION'],
      ['1.0', 'en-US', 'First release', 'REPLACED_WITH_NEW_VERSION'],
    ],
  );
  assert.equal(read.entries[0]?.at, Date.parse('2026-01-10T10:00:00Z'));
  assert.ok(read.entries.every((e) => e.source === 'appstoreconnect' && e.track === null));
  assert.deepEqual([read.truncated, read.versionsRead, read.failed], [false, 4, 0]);
  assert.equal(api.writes().length, 0);

  const de = await connector.readNotesHistory({ locale: 'de_de' });
  assert.deepEqual(
    de.entries.map((e) => [e.version, e.locale]),
    [['1.5', 'de-DE']],
  );
  const two = await connector.readNotesHistory({ maxVersions: 2 });
  assert.equal(two.truncated, true);
  assert.deepEqual(
    [...new Set(two.entries.map((e) => e.version))],
    ['2.1', '2.0'].filter((v) => two.entries.some((e) => e.version === v)),
  );
});

test('notes history (App Store): a version that cannot be read is counted; all of them failing is the error', async () => {
  const { api, connector } = apple(history);
  api.hook = (seen) =>
    /v-15\/appStoreVersionLocalizations$/.test(seen.path)
      ? new Response('{}', { status: 500 })
      : undefined;
  const partial = await connector.readNotesHistory({});
  assert.equal(partial.failed, 1);
  assert.deepEqual([...new Set(partial.entries.map((e) => e.version))], ['2.0', '1.0']);

  api.hook = (seen) =>
    /appStoreVersionLocalizations$/.test(seen.path)
      ? new Response(
          JSON.stringify({ errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'No' }] }),
          { status: 403 },
        )
      : undefined;
  await assert.rejects(
    connector.readNotesHistory({}),
    (error) => error instanceof StoreError && error.kind === 'forbidden',
  );
});

test('notes history (App Store): a long text is cut and says so', async () => {
  const { connector } = apple((a) => {
    history(a);
    a.locs.set('l4', {
      versionId: 'v-20',
      locale: 'en-US',
      attributes: { locale: 'en-US', whatsNew: 'y'.repeat(MAX_NOTE_CHARS + 1) },
    });
  });
  const read = await connector.readNotesHistory({});
  assert.deepEqual(
    [read.entries[0]?.truncated, read.entries[0]?.text.length],
    [true, MAX_NOTE_CHARS],
  );
});

test('notes history (Google Play): the notes of the releases the tracks hold, highest version code first, no dates', async () => {
  const { api, connector } = play((a) => {
    a.tracks = [
      {
        track: 'production',
        releases: [
          {
            name: '2.0',
            status: 'completed',
            versionCodes: ['200'],
            releaseNotes: [
              { language: 'en-US', text: 'Two' },
              { language: 'de-DE', text: 'Zwei' },
            ],
          },
        ],
      },
      {
        track: 'beta',
        releases: [
          {
            name: '2.1',
            status: 'inProgress',
            userFraction: 0.5,
            versionCodes: ['241', '240'],
            releaseNotes: [{ language: 'en-US', text: 'Two one' }],
          },
          { name: 'empty', status: 'draft', versionCodes: ['300'] },
        ],
      },
    ];
  });
  assert.ok(isStoreNotesHistoryReader(connector));
  const read = await connector.readNotesHistory({});
  assert.deepEqual(
    read.entries.map((e) => [e.version, e.track, e.locale, e.state, e.at]),
    [
      ['2.1', 'beta', 'en-US', 'inProgress', null],
      ['2.0', 'production', 'en-US', 'completed', null],
      ['2.0', 'production', 'de-DE', 'completed', null],
    ],
  );
  assert.equal(read.versionsRead, 3);
  assert.deepEqual(
    read.entries.map((e) => e.versionCodes),
    [['241', '240'], ['200'], ['200']],
    'the version codes of the release tell two releases of one track apart',
  );
  assert.deepEqual(
    (await connector.readNotesHistory({ locale: 'de-DE' })).entries.map((e) => e.text),
    ['Zwei'],
  );
  assert.equal(api.commits.length, 0, 'a read never commits');
});
