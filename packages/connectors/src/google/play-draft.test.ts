import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { FakePlayDraftApi, md5Of, sha256 } from '../store-draft.fixtures.ts';
import {
  type DraftApplyInput,
  DraftDriftError,
  type DraftFile,
  DraftOutcomeUnknownError,
  type DraftSlot,
} from '../store-draft-types.ts';
import { PlayDraftConnector } from './play-draft.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.googleKeyPem();
const PKG = 'com.example.coffee';
const EDIT = fx.googleEdit.id;
const PHONE: DraftSlot = {
  locale: 'en-US',
  kind: 'screenshot',
  device: 'phone',
  target: 'phoneScreenshots',
};
const ICON: DraftSlot = { locale: 'en-US', kind: 'icon', device: null, target: 'icon' };

const file = (name: string, seed: number, size = 12): DraftFile => {
  const bytes = new Uint8Array(size).map((_, i) => (seed + i) % 251);
  return { name, mime: 'image/png', bytes, md5: md5Of(bytes), sha256: sha256(bytes) };
};
const accept = () => true;
const input = (over: Partial<DraftApplyInput> = {}): DraftApplyInput => ({
  text: [],
  assets: [],
  guard: accept,
  ...over,
});

function setup(configure?: (api: FakePlayDraftApi) => void) {
  const api = new FakePlayDraftApi();
  configure?.(api);
  const connector = new PlayDraftConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: PKG,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!text.includes(fx.ACCESS_TOKEN));
}

test('readDraft reads listings and image sets in a throwaway edit and commits nothing', async () => {
  const { api, connector } = setup((a) =>
    a.setImages('en-US', 'phoneScreenshots', [new Uint8Array([1, 2, 3])]),
  );
  const state = await connector.readDraft({
    text: [
      { locale: 'en-US', field: 'title' },
      { locale: 'en-US', field: 'video' },
      { locale: 'fr-FR', field: 'title' },
    ],
    assets: [PHONE, ICON],
  });
  assert.equal(state.store, 'googleplay');
  assert.equal(state.version, null);
  assert.deepEqual(state.text, [
    { locale: 'en-US', field: 'title', value: 'Old title', localeExists: true },
    { locale: 'en-US', field: 'video', value: null, localeExists: true },
    { locale: 'fr-FR', field: 'title', value: null, localeExists: false },
  ]);
  assert.deepEqual(
    state.assets[0]?.images.map((i) => [i.checksum, i.checksumKind]),
    [[sha256(new Uint8Array([1, 2, 3])), 'sha256']],
  );
  assert.deepEqual(state.assets[1]?.images, []);
  assert.deepEqual(
    api.writes().map((w) => w.split(' ')[0]),
    ['POST', 'DELETE'],
  );
  assert.equal(api.commits.length, 0);
});

test('text: one listing PUT with the unchanged members kept, then a commit held back from review', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({
      text: [
        { locale: 'en-US', field: 'title', value: 'New title' },
        { locale: 'en-US', field: 'short_description', value: 'Old short' },
      ],
    }),
  );
  assert.equal(result.commit, 'not_sent_for_review');
  assert.deepEqual(
    result.steps.map((s) => [s.target, s.outcome]),
    [
      ['title', 'applied'],
      ['short_description', 'already_same'],
    ],
  );
  const put = api.seen.find((s) => s.method === 'PUT');
  assert.deepEqual(put?.body, {
    language: 'en-US',
    title: 'New title',
    shortDescription: 'Old short',
    fullDescription: 'Old full',
  });
  assert.equal(api.commits.length, 1);
  const q = new URLSearchParams(api.commits[0]?.query ?? '');
  assert.equal(q.get('changesNotSentForReview'), 'true');
  assert.equal(q.get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
  assert.equal(api.listings.get('en-US')?.title, 'New title');
  assert.deepEqual(api.writes(), [
    `POST /edits`,
    `PUT /edits/${EDIT}/listings/en-US`,
    `POST /edits/${EDIT}:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
  ]);
});

test('nothing that would send for review is ever called, and every commit carries the hold-back flag', async () => {
  const { api, connector } = setup();
  await connector.applyDraft(
    input({
      text: [{ locale: 'en-US', field: 'title', value: 'T' }],
      assets: [{ ...PHONE, files: [file('a.png', 1)] }],
    }),
  );
  for (const s of api.seen) {
    assert.ok(
      !/\/(tracks|bundles|apks|submit|publish|release)/i.test(s.path),
      `unexpected ${s.path}`,
    );
    if (s.path.endsWith(':commit')) assert.match(s.query, /changesNotSentForReview=true/);
  }
});

test('a text that already matches opens an edit, changes nothing, commits nothing and deletes the edit', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({ text: [{ locale: 'en-US', field: 'title', value: 'Old title' }] }),
  );
  assert.equal(result.commit, 'none');
  assert.deepEqual(result.steps, [
    { type: 'text', locale: 'en-US', target: 'title', outcome: 'already_same' },
  ]);
  assert.equal(api.commits.length, 0);
  assert.deepEqual(
    api.writes().map((w) => w.split(' ')[0]),
    ['POST', 'DELETE'],
  );
});

test('a new language gets a listing with only the staged members', async () => {
  const { api, connector } = setup();
  await connector.applyDraft(input({ text: [{ locale: 'fr-FR', field: 'title', value: 'Café' }] }));
  assert.deepEqual(api.listings.get('fr-FR'), { language: 'fr-FR', title: 'Café' });
});

test('images: the set is deleted and uploaded in order as raw bytes, checked against SHA-256, then committed once', async () => {
  const { api, connector } = setup((a) =>
    a.setImages('en-US', 'phoneScreenshots', [new Uint8Array([7, 7])]),
  );
  const a = file('a.png', 1);
  const b = file('b.png', 40, 30);
  const result = await connector.applyDraft(input({ assets: [{ ...PHONE, files: [a, b] }] }));
  assert.deepEqual(result.steps, [
    {
      type: 'asset',
      locale: 'en-US',
      target: 'phoneScreenshots',
      outcome: 'applied',
      uploaded: 2,
      removed: 1,
    },
  ]);
  const base = `/edits/${EDIT}/listings/en-US/phoneScreenshots`;
  assert.deepEqual(api.writes(), [
    'POST /edits',
    `DELETE ${base}`,
    `POST upload${base}?uploadType=media`,
    `POST upload${base}?uploadType=media`,
    `POST /edits/${EDIT}:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
  ]);
  const uploads = api.seen.filter((s) => s.path.startsWith('/upload/'));
  assert.deepEqual(
    uploads.map((u) => [...(u.bytes ?? [])]),
    [[...a.bytes], [...b.bytes]],
  );
  assert.ok(uploads.every((u) => u.headers.get('content-type') === 'image/png'));
  assert.deepEqual(
    api.images.get('en-US/phoneScreenshots')?.map((i) => i.sha256),
    [a.sha256, b.sha256],
  );
});

test('an upload whose stored checksum differs is not committed', async () => {
  const { api, connector } = setup((a) => {
    a.corruptUploads = true;
  });
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...PHONE, files: [file('a.png', 1)] }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.match(e.message, /nothing was committed/);
      return true;
    },
  );
  assert.equal(api.commits.length, 0);
  assert.deepEqual(
    api.images.get('en-US/phoneScreenshots') ?? [],
    [],
    'the committed state is untouched',
  );
  assert.ok(
    api
      .writes()
      .some((w) => w.startsWith('DELETE /edits/17744839219283') && !w.includes('/listings/')),
    'the edit was thrown away',
  );
});

test('a set that already matches is not touched and nothing is committed', async () => {
  const a = file('a.png', 1);
  const { api, connector } = setup((p) => p.setImages('en-US', 'icon', [a.bytes]));
  const result = await connector.applyDraft(input({ assets: [{ ...ICON, files: [a] }] }));
  assert.equal(result.commit, 'none');
  assert.equal(result.steps[0]?.outcome, 'already_same');
  assert.equal(api.commits.length, 0);
});

test('the guard sees the draft read inside the edit; a refusal writes and commits nothing', async () => {
  const { api, connector } = setup();
  await assert.rejects(
    connector.applyDraft(
      input({
        text: [{ locale: 'en-US', field: 'title', value: 'x' }],
        guard: (s) => s.text[0]?.value === 'something else',
      }),
    ),
    (e: unknown) => e instanceof DraftDriftError && e.current.text[0]?.value === 'Old title',
  );
  assert.equal(api.commits.length, 0);
  assert.ok(!api.writes().some((w) => w.startsWith('PUT')));
});

test('changes already in review: a plain refusal, nothing is applied, the edit is deleted', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'in_review';
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'changes_in_review');
      assertNoSecrets(e);
      return true;
    },
  );
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
  assert.equal(api.commits.length, 1, 'no retry');
});

test('when Google will not hold changes back, the answer is draft_not_allowed and there is no commit without the flag', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'not_sent_refused';
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'draft_not_allowed',
  );
  assert.equal(api.commits.length, 1);
  assert.match(api.commits[0]?.query ?? '', /changesNotSentForReview=true/);
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
});

test('draft_not_allowed keeps Google\'s own sentence, a catalogue code and no secret', async () => {
  const { connector } = setup((a) => {
    a.commitAnswer = 'not_sent_refused';
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'draft_not_allowed');
      assert.equal(e.status, 400);
      assert.equal(e.code, 'store.google.draftNotAllowed');
      assert.match(e.details?.[0]?.detail ?? '', /Changes are sent for review automatically/);
      assert.ok(!/Make the change in Play Console instead/.test(e.message));
      assertNoSecrets(e);
      return true;
    },
  );
});

test('pushAndSubmit: the same edit, committed WITHOUT the hold-back, so Google sends it for review', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'not_sent_refused';
  });
  const a = file('a.png', 1);
  const result = await connector.pushAndSubmit(
    input({
      text: [{ locale: 'en-US', field: 'title', value: 'New title' }],
      assets: [{ ...PHONE, files: [a] }],
    }),
  );
  assert.equal(result.commit, 'sent_for_review');
  assert.equal(api.commits.length, 1, 'one commit, never a second try');
  const q = new URLSearchParams(api.commits[0]?.query ?? '');
  assert.equal(q.has('changesNotSentForReview'), false);
  assert.equal(q.get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
  assert.equal(api.listings.get('en-US')?.title, 'New title');
  assert.deepEqual(
    api.images.get('en-US/phoneScreenshots')?.map((i) => i.sha256),
    [a.sha256],
  );
  const base = `/edits/${EDIT}/listings/en-US/phoneScreenshots`;
  assert.deepEqual(api.writes(), [
    'POST /edits',
    `PUT /edits/${EDIT}/listings/en-US`,
    `DELETE ${base}`,
    `POST upload${base}?uploadType=media`,
    `POST /edits/${EDIT}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
  ]);
});

test('pushAndSubmit builds the edit exactly like applyDraft (same writes before the commit)', async () => {
  const draft = setup();
  const combined = setup();
  const write = () =>
    input({
      text: [{ locale: 'en-US', field: 'title', value: 'Same' }],
      assets: [{ ...PHONE, files: [file('a.png', 3), file('b.png', 9, 20)] }],
    });
  await draft.connector.applyDraft(write());
  await combined.connector.pushAndSubmit(write());
  const beforeCommit = (api: FakePlayDraftApi) =>
    api.writes().filter((w) => !w.includes(':commit'));
  assert.deepEqual(beforeCommit(combined.api), beforeCommit(draft.api));
});

test('pushAndSubmit: changes already in review is refused, nothing is applied, no retry', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'in_review';
  });
  await assert.rejects(
    connector.pushAndSubmit(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'changes_in_review',
  );
  assert.equal(api.commits.length, 1);
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
});

test('pushAndSubmit: the guard refuses a changed store before anything is written or committed', async () => {
  const { api, connector } = setup();
  await assert.rejects(
    connector.pushAndSubmit(
      input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }], guard: () => false }),
    ),
    (e: unknown) => e instanceof DraftDriftError,
  );
  assert.equal(api.commits.length, 0);
  assert.deepEqual(
    api.writes().filter((w) => !w.startsWith('DELETE /edits/')),
    ['POST /edits'],
  );
});

test('pushAndSubmit: nothing that differs is not committed, so nothing is sent', async () => {
  const { api, connector } = setup();
  const result = await connector.pushAndSubmit(
    input({ text: [{ locale: 'en-US', field: 'title', value: 'Old title' }] }),
  );
  assert.equal(result.commit, 'none');
  assert.equal(api.commits.length, 0);
});

test('pushAndSubmit: a 5xx or a cut connection is an unknown outcome and the commit is not repeated', async () => {
  for (const mode of ['server_error', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.commitAnswer = mode;
    });
    await assert.rejects(
      connector.pushAndSubmit(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
      (e: unknown) => e instanceof DraftOutcomeUnknownError && /sending them for review/.test(e.message),
      mode,
    );
    assert.equal(api.commits.length, 1, mode);
  }
});

test('applyDraft never uses the combined commit: a draft step is not sent for review even when only a draft release changes, unless Google refuses the hold-back for it', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'not_sent_refused';
  });
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...PHONE, files: [file('a.png', 1)] }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'draft_not_allowed',
  );
  assert.equal(api.commits.length, 1);
  assert.match(api.commits[0]?.query ?? '', /changesNotSentForReview=true/);
});

test('a 5xx or a cut connection on the commit is an unknown outcome, never retried, and the edit is left alone', async () => {
  for (const mode of ['server_error', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.commitAnswer = mode;
    });
    await assert.rejects(
      connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
      (e: unknown) => {
        assert.ok(e instanceof DraftOutcomeUnknownError, mode);
        assertNoSecrets(e);
        return true;
      },
    );
    assert.equal(api.commits.length, 1, `${mode}: one commit`);
    // The edit may have been applied; reading back tells.
    assert.equal(api.listings.get('en-US')?.title, 'New');
    const after = await connector.readDraft({
      text: [{ locale: 'en-US', field: 'title' }],
      assets: [],
    });
    assert.equal(after.text[0]?.value, 'New');
  }
});

test('a failure before the commit changes nothing: the edit is deleted', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PUT'
        ? reply(400, {
            error: { code: 400, message: 'Invalid listing', status: 'INVALID_ARGUMENT' },
          })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => e instanceof StoreError,
  );
  assert.equal(api.commits.length, 0);
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
});

test('a 429 on a write is not retried', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PUT'
        ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => e instanceof StoreError,
  );
  assert.equal(api.seen.filter((s) => s.method === 'PUT').length, 1);
});

test('a 403 is explained without secrets', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PUT'
        ? reply(403, {
            error: { code: 403, message: `denied ${key.privateKey}`, status: 'PERMISSION_DENIED' },
          })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'New' }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'forbidden');
      assertNoSecrets(e);
      return true;
    },
  );
});

test('a bad package name is refused when the connector is built', () => {
  assert.throws(
    () =>
      new PlayDraftConnector({
        serviceAccount: fx.serviceAccountJson(key.privateKey),
        packageName: '../x',
      }),
    StoreError,
  );
});

// ---------------------------------------------------------------------------------------------
// ONE edit, ONE commit: the texts, the graphics and the release go to Google together (docs/adr/0069-one-play-commit.md)

const RELEASE_FIELDS = [
  { field: 'track', locale: '', value: 'production' },
  { field: 'version_codes', locale: '', value: '240' },
  { field: 'release_notes', locale: 'en-US', value: 'Fixes' },
];

test('pushAndSubmit with start: texts, graphics and the release are ONE edit and ONE commit', async () => {
  const { api, connector } = setup();
  const a = file('a.png', 1);
  const result = await connector.pushAndSubmit(
    input({
      text: [{ locale: 'en-US', field: 'title', value: 'New title' }],
      assets: [{ ...PHONE, files: [a] }],
      fields: RELEASE_FIELDS,
      start: { userFraction: 1 },
    }),
  );
  assert.equal(result.commit, 'sent_for_review');
  assert.equal(api.commits.length, 1, 'one commit for everything');
  assert.equal(api.seen.filter((s) => s.method === 'POST' && s.path.endsWith('/edits')).length, 1, 'one edit');
  const q = new URLSearchParams(api.commits[0]?.query ?? '');
  assert.equal(q.has('changesNotSentForReview'), false);
  assert.equal(q.get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
  assert.equal(api.validations, 1, 'the whole edit is validated before the one commit');
  const production = api.tracks.find((t) => t.track === 'production');
  const made = production?.releases.find((r) => r.versionCodes.join() === '240');
  assert.equal(made?.status, 'completed');
  assert.equal(made?.userFraction, undefined);
  assert.deepEqual(made?.releaseNotes, [{ language: 'en-US', text: 'Fixes' }]);
  // The older completed release is replaced (one completed release only), the listing and the images are written.
  assert.equal(production?.releases.some((r) => r.versionCodes.join() === '200'), false);
  assert.equal(api.listings.get('en-US')?.title, 'New title');
  assert.deepEqual(api.images.get('en-US/phoneScreenshots')?.map((i) => i.sha256), [a.sha256]);
  assert.ok(result.steps.some((s) => s.target === 'release_start' && s.outcome === 'applied'));
  const writes = api.writes();
  assert.equal(writes.filter((w) => w.includes(':commit')).length, 1);
  assert.equal(writes[writes.length - 1]?.includes(':commit'), true, 'the commit is the last write');
  assert.ok(writes.some((w) => w.startsWith('POST /edits/') && w.includes(':validate')));
});

test('pushAndSubmit with start and a share: the release is inProgress with that share', async () => {
  const { api, connector } = setup();
  await connector.pushAndSubmit(
    input({ fields: RELEASE_FIELDS, start: { userFraction: 0.2 } }),
  );
  const production = api.tracks.find((t) => t.track === 'production');
  const made = production?.releases.find((r) => r.versionCodes.join() === '240');
  assert.equal(made?.status, 'inProgress');
  assert.equal(made?.userFraction, 0.2);
  assert.ok(production?.releases.some((r) => r.versionCodes.join() === '200'), 'the live release keeps serving the rest');
  assert.equal(api.commits.length, 1);
});

test('pushAndSubmit with start turns an existing draft with the same codes into the release', async () => {
  const { api, connector } = setup((a) => {
    a.tracks[0]?.releases.push({ status: 'draft', versionCodes: ['240'], name: 'Draft' });
  });
  await connector.pushAndSubmit(input({ fields: RELEASE_FIELDS, start: { userFraction: 1 } }));
  const releases = api.tracks.find((t) => t.track === 'production')?.releases ?? [];
  assert.equal(releases.filter((r) => r.status === 'draft').length, 0);
  assert.equal(releases.find((r) => r.versionCodes.join() === '240')?.status, 'completed');
  assert.equal(api.commits.length, 1);
});

test('pushAndSubmit with start: changes in review refuse the one commit and NOTHING is applied (edit deleted)', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'in_review';
  });
  await assert.rejects(
    connector.pushAndSubmit(
      input({
        text: [{ locale: 'en-US', field: 'title', value: 'New title' }],
        assets: [{ ...PHONE, files: [file('a.png', 1)] }],
        fields: RELEASE_FIELDS,
        start: { userFraction: 1 },
      }),
    ),
    (e: unknown) => e instanceof StoreError && e.kind === 'changes_in_review',
  );
  assert.equal(api.commits.length, 1, 'never a second commit');
  assert.equal(new URLSearchParams(api.commits[0]?.query ?? '').get('changesInReviewBehavior'), 'ERROR_IF_IN_REVIEW');
  assert.equal(api.openEdit, false, 'the edit was deleted, so no half-written change lingers');
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
  assert.deepEqual(api.images.get('en-US/phoneScreenshots') ?? [], []);
  assert.deepEqual(api.tracks[0]?.releases.map((r) => r.versionCodes.join()), ['200']);
});

test('replaceReview is the ONLY way to CANCEL_IN_REVIEW_AND_SUBMIT: it cancels the review and sends everything together', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'in_review';
  });
  const result = await connector.pushAndSubmit(
    input({
      text: [{ locale: 'en-US', field: 'title', value: 'New title' }],
      fields: RELEASE_FIELDS,
      start: { userFraction: 1 },
      replaceReview: true,
    }),
  );
  assert.equal(result.commit, 'sent_for_review');
  assert.equal(api.commits.length, 1);
  assert.equal(
    new URLSearchParams(api.commits[0]?.query ?? '').get('changesInReviewBehavior'),
    'CANCEL_IN_REVIEW_AND_SUBMIT',
  );
  assert.equal(api.reviewsCancelled, 1);
  assert.equal(api.listings.get('en-US')?.title, 'New title');
  assert.equal(api.tracks[0]?.releases.some((r) => r.versionCodes.join() === '240' && r.status === 'completed'), true);
});

test('every commit without replaceReview carries ERROR_IF_IN_REVIEW (draft push, combined push, combined push with a release)', async () => {
  for (const run of [
    (c: PlayDraftConnector) => c.applyDraft(input({ text: [{ locale: 'en-US', field: 'title', value: 'A' }] })),
    (c: PlayDraftConnector) => c.pushAndSubmit(input({ text: [{ locale: 'en-US', field: 'title', value: 'B' }] })),
    (c: PlayDraftConnector) => c.pushAndSubmit(input({ fields: RELEASE_FIELDS, start: { userFraction: 1 } })),
  ]) {
    const { api, connector } = setup();
    await run(connector);
    assert.equal(api.commits.length, 1);
    assert.equal(
      new URLSearchParams(api.commits[0]?.query ?? '').get('changesInReviewBehavior'),
      'ERROR_IF_IN_REVIEW',
    );
  }
});

test('a draft push never starts a release and never replaces a review: refused before the edit is opened', async () => {
  for (const extra of [{ start: { userFraction: 1 } }, { replaceReview: true }] as const) {
    const { api, connector } = setup();
    await assert.rejects(
      connector.applyDraft(input({ fields: RELEASE_FIELDS, ...extra })),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
    );
    assert.equal(api.seen.filter((s) => s.method !== 'GET' && !s.path.endsWith('/token')).length, 0);
  }
});

test('start refuses a share that is not above 0 and at most 1, and codes the track already holds', async () => {
  for (const userFraction of [0, 1.5, Number.NaN]) {
    const { api, connector } = setup();
    await assert.rejects(
      connector.pushAndSubmit(input({ fields: RELEASE_FIELDS, start: { userFraction } })),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
    );
    assert.equal(api.commits.length, 0);
  }
  const { api, connector } = setup();
  await assert.rejects(
    connector.pushAndSubmit(
      input({
        fields: [
          { field: 'track', locale: '', value: 'production' },
          { field: 'version_codes', locale: '', value: '200' },
        ],
        start: { userFraction: 1 },
      }),
    ),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  assert.equal(api.commits.length, 0);
  assert.equal(api.openEdit, false);
});

test('start: a validation Google refuses applies nothing and is never committed', async () => {
  const { api, connector } = setup((a) => {
    a.validateAnswer = 'invalid';
  });
  await assert.rejects(
    connector.pushAndSubmit(
      input({
        text: [{ locale: 'en-US', field: 'title', value: 'New title' }],
        fields: RELEASE_FIELDS,
        start: { userFraction: 1 },
      }),
    ),
    (e: unknown) => e instanceof StoreError,
  );
  assert.equal(api.commits.length, 0);
  assert.equal(api.openEdit, false);
  assert.equal(api.listings.get('en-US')?.title, 'Old title');
});

test('start: a lost commit answer is an unknown outcome, not repeated, and the edit is kept', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'cut';
  });
  await assert.rejects(
    connector.pushAndSubmit(input({ fields: RELEASE_FIELDS, start: { userFraction: 1 } })),
    (e: unknown) => e instanceof DraftOutcomeUnknownError,
  );
  assert.equal(api.commits.length, 1);
});
