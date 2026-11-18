import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleDraftConnector } from './appstore-draft.ts';
import { StoreError } from './errors.ts';
import {
  type DraftApplyInput,
  type DraftFile,
  DraftDriftError,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftSlot,
  sameDraftState,
} from './store-draft-types.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, md5Of, sha256 } from './store-draft.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = '10746822401';
const SLOT: DraftSlot = { locale: 'en-US', kind: 'screenshot', device: 'iphone', target: 'APP_IPHONE_65' };

const file = (name: string, seed: number, size = 11): DraftFile => {
  const bytes = new Uint8Array(size).map((_, i) => (seed + i) % 251);
  return { name, mime: 'image/png', bytes, md5: md5Of(bytes), sha256: sha256(bytes) };
};
const accept = () => true;

function setup(configure?: (api: FakeAppleDraftApi) => void) {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleDraftConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}
const input = (over: Partial<DraftApplyInput> = {}): DraftApplyInput => ({ text: [], assets: [], guard: accept, ...over });
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify((error as StoreError).details ?? [])}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n')) if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
  assert.ok(!text.includes('blobstore.apple.com'), 'no upload URL');
}

/** Never anything that would submit, release or create a version. */
function assertNeverSubmits(api: FakeAppleDraftApi) {
  for (const s of api.seen) {
    assert.ok(!/submission|appStoreVersionSubmissions|reviewSubmission|phasedRelease|releaseRequest/i.test(s.path), `unexpected ${s.method} ${s.path}`);
    if (s.method === 'POST') assert.ok(['/v1/appStoreVersionLocalizations', '/v1/appScreenshotSets', '/v1/appScreenshots'].includes(s.path), `unexpected POST ${s.path}`);
  }
}

test('readDraft finds the one editable version and reports text and sets without writing', async () => {
  const { api, connector } = setup((a) => a.addSet('loc-en', 'APP_IPHONE_65', [{ name: 'one.png', bytes: new Uint8Array([1, 2, 3]) }]));
  const state = await connector.readDraft({
    text: [
      { locale: 'en-US', field: 'description' },
      { locale: 'en-US', field: 'release_notes' },
      { locale: 'de-DE', field: 'description' },
    ],
    assets: [SLOT, { ...SLOT, target: 'APP_IPHONE_67' }, { ...SLOT, locale: 'de-DE' }],
  });
  assert.equal(state.store, 'appstoreconnect');
  assert.deepEqual(state.version, { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' });
  assert.deepEqual(state.text, [
    { locale: 'en-US', field: 'description', value: 'Old description', localeExists: true },
    { locale: 'en-US', field: 'release_notes', value: 'Old news', localeExists: true },
    { locale: 'de-DE', field: 'description', value: null, localeExists: false },
  ]);
  assert.equal(state.assets[0]?.setExists, true);
  assert.deepEqual(state.assets[0]?.images.map((i) => [i.name, i.checksum, i.checksumKind, i.state]), [['one.png', md5Of(new Uint8Array([1, 2, 3])), 'md5', 'COMPLETE']]);
  assert.equal(state.assets[1]?.setExists, false);
  assert.equal(state.assets[2]?.setExists, false);
  assert.deepEqual(api.writes(), []);
});

test('the live version is never the one written to: no editable version is its own error', async () => {
  const { connector } = setup((a) => {
    a.versions = [{ id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' }, { id: 'v-rev', versionString: '2.1', state: 'WAITING_FOR_REVIEW' }];
  });
  await assert.rejects(connector.readDraft({ text: [], assets: [] }), (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version');
  await assert.rejects(connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })), (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version');
});

test('two editable versions are refused rather than guessed', async () => {
  const { connector } = setup((a) => {
    a.versions.push({ id: 'v-other', versionString: '2.2', state: 'PREPARE_FOR_SUBMISSION' });
  });
  await assert.rejects(connector.readDraft({ text: [], assets: [] }), (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input');
});

test('text: only the changed attributes are sent, in one PATCH per locale, and nothing is submitted', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({
      text: [
        { locale: 'en-US', field: 'description', value: 'New description' },
        { locale: 'en-US', field: 'keywords', value: 'old' },
        { locale: 'en-US', field: 'release_notes', value: 'New news' },
      ],
    }),
  );
  assert.equal(result.commit, 'none');
  assert.deepEqual(result.steps.map((s) => [s.target, s.outcome]), [['description', 'applied'], ['keywords', 'already_same'], ['release_notes', 'applied']]);
  assert.deepEqual(api.writes(), ['PATCH /v1/appStoreVersionLocalizations/loc-en']);
  const patch = api.seen.find((s) => s.method === 'PATCH');
  assert.deepEqual(patch?.body, { data: { type: 'appStoreVersionLocalizations', id: 'loc-en', attributes: { description: 'New description', whatsNew: 'New news' } } });
  assert.equal(api.locs.get('loc-en')?.attributes.description, 'New description');
  assertNeverSubmits(api);
});

test('a text that already matches sends nothing at all', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'Old description' }] }));
  assert.deepEqual(result.steps, [{ type: 'text', locale: 'en-US', target: 'description', outcome: 'already_same' }]);
  assert.deepEqual(api.writes(), []);
});

test('a locale the draft does not have is created on the editable version', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(input({ text: [{ locale: 'de-DE', field: 'description', value: 'Neu' }] }));
  assert.deepEqual(result.steps.map((s) => [s.type, s.locale, s.target]), [['locale', 'de-DE', 'locale'], ['text', 'de-DE', 'description']]);
  assert.deepEqual(api.writes(), ['POST /v1/appStoreVersionLocalizations']);
  const post = api.seen.find((s) => s.method === 'POST');
  assert.deepEqual(post?.body, {
    data: { type: 'appStoreVersionLocalizations', attributes: { locale: 'de-DE', description: 'Neu' }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-next' } } } },
  });
  assertNeverSubmits(api);
});

test('screenshots: reserve, upload every part without the JWT, commit with the MD5, wait, order', async () => {
  const { api, connector } = setup();
  const a = file('01.png', 1, 11);
  const b = file('02.png', 50, 20);
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, files: [a, b] }] }));
  assert.deepEqual(result.steps, [{ type: 'asset', locale: 'en-US', target: 'APP_IPHONE_65', outcome: 'applied', uploaded: 2, removed: 0 }]);
  assert.equal(result.commit, 'none');

  const order = api.writes().map((w) => w.replace(/(shot|set)-\d+/g, '$1'));
  assert.deepEqual(order, [
    'POST /v1/appScreenshotSets',
    'POST /v1/appScreenshots',
    'PUT store-030.blobstore.apple.com/up/shot',
    'PUT store-030.blobstore.apple.com/up/shot',
    'PATCH /v1/appScreenshots/shot',
    'POST /v1/appScreenshots',
    'PUT store-030.blobstore.apple.com/up/shot',
    'PUT store-030.blobstore.apple.com/up/shot',
    'PATCH /v1/appScreenshots/shot',
    'PATCH /v1/appScreenshotSets/set/relationships/appScreenshots',
  ]);
  // The parts are the byte ranges Apple asked for, with Apple's own headers, and carry no credential.
  const puts = api.seen.filter((s) => s.method === 'PUT');
  assert.equal(puts.length, 4);
  for (const p of puts) {
    assert.equal(p.headers.get('authorization'), null);
    assert.equal(p.headers.get('content-type'), 'image/png');
    assert.ok(p.headers.get('x-apple-part'));
  }
  const sent = new Uint8Array([...(puts[0]?.bytes ?? []), ...(puts[1]?.bytes ?? [])]);
  assert.deepEqual([...sent], [...a.bytes]);
  const created = [...api.shots.values()];
  assert.deepEqual(created.map((s) => [s.fileName, s.checksum, s.state]), [['01.png', a.md5, 'COMPLETE'], ['02.png', b.md5, 'COMPLETE']]);
  const commits = api.seen.filter((s) => s.method === 'PATCH' && /appScreenshots\/shot/.test(s.path));
  assert.deepEqual((commits[0]?.body as { data: { attributes: unknown } }).data.attributes, { uploaded: true, sourceFileChecksum: a.md5 });
  // The JWT only went to Apple's API.
  for (const s of api.seen) assert.equal(s.headers.get('authorization')?.startsWith('Bearer ') ?? false, s.host === 'api.appstoreconnect.apple.com');
  assertNeverSubmits(api);
});

test('a set that already holds exactly these files in this order is left alone (a repeated push adds nothing)', async () => {
  const { api, connector } = setup();
  const a = file('01.png', 1);
  const b = file('02.png', 9);
  const write = { ...SLOT, files: [a, b] };
  await connector.applyDraft(input({ assets: [write] }));
  const before = api.seen.length;
  const again = await connector.applyDraft(input({ assets: [write] }));
  assert.equal(again.steps[0]?.outcome, 'already_same');
  assert.deepEqual(api.seen.slice(before).filter((s) => s.method !== 'GET'), []);
  assert.equal(api.shots.size, 2);
});

test('replacing a set uploads the new files first, deletes the old ones after, and puts the new order', async () => {
  const { api, connector } = setup((a) => a.addSet('loc-en', 'APP_IPHONE_65', [{ name: 'old1.png', bytes: new Uint8Array([9, 9, 9]) }, { name: 'old2.png', bytes: new Uint8Array([8, 8, 8]) }]));
  const n = file('new.png', 3);
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, files: [n] }] }));
  assert.deepEqual(result.steps[0], { type: 'asset', locale: 'en-US', target: 'APP_IPHONE_65', outcome: 'applied', uploaded: 1, removed: 2 });
  const order = api.writes().map((w) => w.replace(/(shot|set)-\d+/g, '$1'));
  const firstDelete = order.findIndex((w) => w.startsWith('DELETE'));
  const lastCommit = order.map((w, i) => (w.startsWith('PATCH /v1/appScreenshots/') ? i : -1)).reduce((x, y) => Math.max(x, y), -1);
  assert.ok(lastCommit < firstDelete, 'upload finished before anything was deleted');
  assert.deepEqual([...api.shots.values()].map((s) => s.fileName), ['new.png']);
  assert.equal(api.sets.size, 1);
  // The same set is reused, not recreated.
  assert.ok(!order.includes('POST /v1/appScreenshotSets'));
});

test('a set with no room for both is emptied first', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `o${i}.png`, bytes: new Uint8Array([i + 1, 2, 3]) }));
  const { api, connector } = setup((a) => a.addSet('loc-en', 'APP_IPHONE_65', many));
  await connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('a.png', 1), file('b.png', 2), file('c.png', 3)] }] }));
  const order = api.writes();
  const firstUpload = order.findIndex((w) => w.startsWith('POST /v1/appScreenshots'));
  assert.equal(order.slice(0, firstUpload).filter((w) => w.startsWith('DELETE')).length, 8);
  assert.deepEqual([...api.shots.values()].map((s) => s.fileName), ['a.png', 'b.png', 'c.png']);
});

test('a screenshot for a locale the draft lacks creates the locale first', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, locale: 'fr-FR', files: [file('f.png', 4)] }] }));
  assert.deepEqual(result.steps.map((s) => s.type), ['locale', 'asset']);
  assert.ok(api.writes()[0] === 'POST /v1/appStoreVersionLocalizations');
});

test('the guard sees the freshest read and a refusal writes nothing', async () => {
  const { api, connector } = setup();
  let seenState: unknown;
  await assert.rejects(
    connector.applyDraft(
      input({
        text: [{ locale: 'en-US', field: 'description', value: 'x' }],
        guard: (current) => {
          seenState = current;
          return false;
        },
      }),
    ),
    (e: unknown) => e instanceof DraftDriftError && e.current.version?.id === 'v-next',
  );
  assert.ok(seenState);
  assert.deepEqual(api.writes(), []);
});

test('sameDraftState ignores the order of the request and sees a changed text', async () => {
  const { api, connector } = setup();
  const request = { text: [{ locale: 'en-US', field: 'description' }, { locale: 'en-US', field: 'keywords' }], assets: [] };
  const first = await connector.readDraft(request);
  const second = await connector.readDraft({ ...request, text: [...request.text].reverse() });
  assert.ok(sameDraftState(first, second));
  const loc = api.locs.get('loc-en');
  if (loc) loc.attributes.description = 'Someone edited this in App Store Connect';
  assert.ok(!sameDraftState(first, await connector.readDraft(request)));
});

test('a refusal before anything was applied is the plain store error', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) => (s.method === 'PATCH' ? reply(409, { errors: [{ status: '409', code: 'STATE_ERROR', title: 'Not editable', detail: 'The version is not editable.' }] }) : undefined);
  });
  await assert.rejects(connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.ok(!(e instanceof DraftPartialError));
    assertNoSecrets(e);
    return true;
  });
});

test('a refusal after a step was applied is a DraftPartialError that lists what was written', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appScreenshotSets' ? reply(422, { errors: [{ status: '422', code: 'ENTITY_ERROR', title: 'Bad display type' }] }) : undefined);
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'New' }], assets: [{ ...SLOT, files: [file('a.png', 1)] }] })),
    (e: unknown) => {
      assert.ok(e instanceof DraftPartialError);
      assert.deepEqual(e.completed.map((s) => [s.type, s.target, s.outcome]), [['text', 'description', 'applied']]);
      assert.deepEqual(e.failed, { type: 'asset', locale: 'en-US', target: 'APP_IPHONE_65' });
      assertNoSecrets(e);
      return true;
    },
  );
  assert.equal(api.locs.get('loc-en')?.attributes.description, 'New');
});

test('a 5xx or a cut connection on a write is an unknown outcome and is never retried', async () => {
  for (const mode of ['5xx', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.hook = (s) => {
        if (s.method !== 'PATCH') return undefined;
        return mode === '5xx' ? reply(503, { errors: [{ status: '503', code: 'UNAVAILABLE', title: 'x' }] }) : new TypeError('socket hang up');
      };
    });
    await assert.rejects(connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })), (e: unknown) => {
      assert.ok(e instanceof DraftOutcomeUnknownError, mode);
      assertNoSecrets(e);
      return true;
    });
    assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 1, `${mode}: one attempt`);
  }
});

test('a 429 on a write is not waited out or retried', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => (s.method === 'PATCH' ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } }) : undefined);
  });
  await assert.rejects(connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })), (e: unknown) => e instanceof StoreError && e.kind === 'rate_limited');
  assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 1);
});

test('an unknown outcome part way keeps the steps that finished', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) => (s.method === 'POST' && s.path === '/v1/appScreenshotSets' ? reply(502) : undefined);
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'New' }], assets: [{ ...SLOT, files: [file('a.png', 1)] }] })),
    (e: unknown) => e instanceof DraftOutcomeUnknownError && e.completed.length === 1 && e.completed[0]?.target === 'description',
  );
});

test('a screenshot Apple fails to process is removed again and reported without secrets', async () => {
  const { api, connector } = setup((a) => a.failProcessing.add('bad.png'));
  await assert.rejects(connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('bad.png', 1)] }] })), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.equal(e.kind, 'invalid_input');
    assert.match(e.message, /bad\.png/);
    assertNoSecrets(e);
    return true;
  });
  assert.equal(api.shots.size, 0);
});

test('processing that never finishes stops after the polls, and the error says so', async () => {
  const { connector } = setup((a) => {
    a.pollsBeforeComplete = 1000;
  });
  await assert.rejects(connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('slow.png', 1)] }] })), /had not finished processing slow\.png/);
});

test('an upload address that is not Apple\'s is never used', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => {
      if (s.method === 'POST' && s.path === '/v1/appScreenshots') {
        return reply(201, { data: { type: 'appScreenshots', id: 'shot-x', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://evil.example.com/steal', offset: 0, length: 11, requestHeaders: [] }] } } });
      }
      return undefined;
    };
  });
  await assert.rejects(connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('a.png', 1)] }] })), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(!e.message.includes('evil.example.com'));
    return true;
  });
  assert.equal(api.seen.filter((s) => s.host === 'evil.example.com').length, 0);
});

test('a failed upload part is a refusal that names no address, and nothing is committed', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => (s.method === 'PUT' ? reply(403, { message: 'Request has expired' }) : undefined);
  });
  await assert.rejects(connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('a.png', 1)] }] })), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assertNoSecrets(e);
    return true;
  });
  assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 0);
});

test('an 401 or 403 message never carries the key', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) => (s.method === 'PATCH' ? reply(403, { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden', detail: `no ${key.privateKey}` }] }) : undefined);
  });
  await assert.rejects(connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })), (e: unknown) => {
    assert.ok(e instanceof StoreError && e.kind === 'forbidden');
    assertNoSecrets(e);
    return true;
  });
});

test('a paging link to another host is not followed with the token', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => (s.method === 'GET' && s.path.endsWith('/appStoreVersions') ? reply(200, { data: [], links: { next: 'https://evil.example.com/next' } }) : undefined);
  });
  await assert.rejects(connector.readDraft({ text: [], assets: [] }), (e: unknown) => e instanceof StoreError && e.kind === 'unexpected');
  assert.equal(api.seen.filter((s) => s.host === 'evil.example.com').length, 0);
});

test('a bad App Store id is refused when the connector is built', () => {
  assert.throws(() => new AppleDraftConnector({ credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey }, appStoreId: '12; DROP' }), /not a number/);
});
