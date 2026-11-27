import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { FakePlayDraftApi, sha256 } from '../store-draft.fixtures.ts';
import type { DraftReadRequest } from '../store-draft-types.ts';
import {
  SubmitDriftError,
  SubmitOutcomeUnknownError,
  sameSubmitState,
} from '../store-submit-types.ts';
import { PlaySubmitConnector } from './play-submit.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.googleKeyPem();
const PKG = 'com.example.coffee';
const REQUEST: DraftReadRequest = {
  text: [{ locale: 'en-US', field: 'title' }],
  assets: [{ locale: 'en-US', kind: 'screenshot', device: 'phone', target: 'phoneScreenshots' }],
};
const accept = () => true;
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(configure?: (api: FakePlayDraftApi) => void) {
  const api = new FakePlayDraftApi();
  configure?.(api);
  const connector = new PlaySubmitConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: PKG,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!text.includes(fx.ACCESS_TOKEN));
}

test('readSubmitState lists every locale, the images, the tracks (read only) and the draft, and deletes its edit', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { api, connector } = setup((a) => {
    a.setImages('en-US', 'phoneScreenshots', [bytes]);
    a.tracks = [
      {
        track: 'production',
        releases: [{ name: '2.0', status: 'inProgress', userFraction: 0.1, versionCodes: ['200'] }],
      },
    ];
  });
  const state = await connector.readSubmitState(REQUEST);
  assert.equal(state.version, null);
  assert.equal(state.alreadySubmitted, false);
  assert.deepEqual(state.tracks, [
    {
      track: 'production',
      releases: [{ name: '2.0', status: 'inProgress', userFraction: 0.1, versionCodes: ['200'] }],
    },
  ]);
  assert.equal(state.locales[0]?.text.title, 'Old title');
  const phone = state.locales[0]?.assets.find((a) => a.target === 'phoneScreenshots');
  assert.deepEqual(
    [phone?.kind, phone?.device, phone?.images.map((i) => i.checksum)],
    ['screenshot', 'phone', [sha256(bytes)]],
  );
  assert.equal(state.draft?.text[0]?.value, 'Old title');
  assert.equal(state.draft?.assets[0]?.images[0]?.checksum, sha256(bytes));
  assert.deepEqual(
    api.writes().map((w) => w.replace(/\d{6,}/, 'EDIT')),
    ['POST /edits', 'DELETE /edits/EDIT'],
    'only the edit is opened and deleted',
  );
  assert.equal(api.commits.length, 0);
});

test('submit commits WITHOUT changesNotSentForReview and with ERROR_IF_IN_REVIEW, and writes nothing else', async () => {
  const { api, connector } = setup();
  const result = await connector.submit({ request: REQUEST, guard: accept });
  assert.equal(result.via, 'edit_commit');
  assert.equal(result.submissionId, null);
  assert.equal(api.commits.length, 1);
  assert.equal(api.commits[0]?.query, '?changesInReviewBehavior=ERROR_IF_IN_REVIEW');
  assert.ok(!/changesNotSentForReview/.test(api.commits[0]?.query ?? ''));
  assert.ok(!/CANCEL_IN_REVIEW/.test(api.commits[0]?.query ?? ''));
  // Never a listing, an image or a track: no rollout can move.
  for (const s of api.seen.filter((x) => x.method !== 'GET' && !x.path.endsWith('/token'))) {
    assert.ok(
      /\/edits$/.test(s.path) ||
        /:commit$/.test(s.path) ||
        (s.method === 'DELETE' && /\/edits\/[^/]+$/.test(s.path)),
      `unexpected ${s.method} ${s.path}`,
    );
  }
  assert.ok(api.seen.every((s) => !/\/tracks\/[^/]/.test(s.path)));
});

test('the guard sees the freshest read; a refusal commits nothing and deletes the edit', async () => {
  const { api, connector } = setup();
  await assert.rejects(
    connector.submit({ request: REQUEST, guard: () => false }),
    (e: unknown) => e instanceof SubmitDriftError && e.current.tracks.length === 1,
  );
  assert.equal(api.commits.length, 0);
  assert.ok(api.seen.some((s) => s.method === 'DELETE'));
});

test('changes already in review are refused and the review is not cancelled', async () => {
  const { api, connector } = setup((a) => {
    a.commitAnswer = 'in_review';
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(e instanceof StoreError && e.kind === 'changes_in_review');
    assertNoSecrets(e);
    return true;
  });
  assert.equal(api.commits.length, 1, 'one attempt');
  assert.ok(
    api.seen.some((s) => s.method === 'DELETE'),
    'the edit is deleted after a refusal',
  );
});

test('a 5xx or a cut connection on the commit is an unknown outcome, never retried, and the edit is left alone', async () => {
  for (const mode of ['server_error', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.commitAnswer = mode;
    });
    await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
      assert.ok(e instanceof SubmitOutcomeUnknownError, mode);
      assertNoSecrets(e);
      return true;
    });
    assert.equal(api.commits.length, 1, `${mode}: one attempt`);
    assert.ok(
      !api.seen.some((s) => s.method === 'DELETE'),
      `${mode}: the edit is not deleted after an unknown commit`,
    );
  }
});

test('a 403 on the commit is a refusal without the key', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.path.endsWith(':commit')
        ? reply(403, {
            error: { code: 403, status: 'PERMISSION_DENIED', message: `no ${key.privateKey}` },
          })
        : undefined;
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(e instanceof StoreError && e.kind === 'forbidden');
    assertNoSecrets(e);
    return true;
  });
});

test('submitKey follows the tracks and the listing: a rollout that moved changes what is confirmed', async () => {
  const { api, connector } = setup();
  const first = await connector.readSubmitState(REQUEST);
  assert.ok(sameSubmitState(first, await connector.readSubmitState(REQUEST)));
  api.tracks = [
    {
      track: 'production',
      releases: [{ name: '2.0', status: 'inProgress', userFraction: 0.5, versionCodes: ['200'] }],
    },
  ];
  assert.ok(!sameSubmitState(first, await connector.readSubmitState(REQUEST)));
  const second = await connector.readSubmitState(REQUEST);
  api.listings.set('de-DE', { language: 'de-DE', title: 'Titel' });
  assert.ok(
    !sameSubmitState(second, await connector.readSubmitState(REQUEST)),
    'a locale nobody pushed changes it too',
  );
});

test('readSubmitState reads every image type the rules know: TV and Wear screenshots and the TV banner included', async () => {
  const { connector } = setup((a) => {
    a.listings.set('en-US', {
      language: 'en-US',
      title: 't',
      shortDescription: 's',
      fullDescription: 'f',
    });
    a.setImages('en-US', 'tvScreenshots', [new Uint8Array([1]), new Uint8Array([2])]);
    a.setImages('en-US', 'wearScreenshots', [new Uint8Array([3])]);
    a.setImages('en-US', 'tvBanner', [new Uint8Array([4])]);
  });
  const state = await connector.readSubmitState(REQUEST);
  const sets = (state.locales[0]?.assets ?? []).map((a) => [
    a.kind,
    a.device,
    a.target,
    a.images.length,
  ]);
  assert.ok(
    sets.some((x) => x[1] === 'tv' && x[3] === 2),
    'tv screenshots read',
  );
  assert.ok(
    sets.some((x) => x[1] === 'wear' && x[3] === 1),
    'wear screenshots read',
  );
  assert.ok(
    sets.some((x) => x[0] === 'tv_banner' && x[3] === 1),
    'tv banner read',
  );
  // Google gives no pixel size in the listing: a size is known only to the server (header measurement, a note), so none rule fires here
  assert.ok(
    state.locales[0]?.assets.every((a) =>
      a.images.every((i) => i.width === null && i.height === null),
    ),
  );
});

test('readSubmitState reads the image sets a few at a time, not one after the other, and keeps their order', async () => {
  const languages = ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'ja-JP'];
  const { api } = setup((a) => {
    for (const language of languages)
      a.listings.set(language, {
        language,
        title: language,
        shortDescription: 's',
        fullDescription: 'f',
      });
    a.setImages('fr-FR', 'phoneScreenshots', [new Uint8Array([9, 9])]);
  });
  let running = 0;
  let most = 0;
  const imageRead = /\/listings\/[^/]+\/[^/]+$/;
  const inner = api.fetch;
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (
      !imageRead.test(url.split('?')[0] ?? '') ||
      (init?.method !== undefined && init.method !== 'GET')
    )
      return inner(input, init);
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await inner(input, init);
    } finally {
      running -= 1;
    }
  }) as typeof fetch;
  const connectorSlow = new PlaySubmitConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: PKG,
    fetch: slow,
    now: () => T0,
    sleep: async () => undefined,
  });
  const state = await connectorSlow.readSubmitState(REQUEST);
  assert.ok(most > 1, `image reads ran one at a time (most at once: ${most})`);
  assert.ok(most <= 4, `more than 4 image reads at once (${most})`);
  assert.deepEqual(
    state.locales.map((l) => l.locale),
    [...api.listings.keys()],
  );
  const fr = state.locales.find((l) => l.locale === 'fr-FR');
  assert.equal(fr?.assets.find((a) => a.target === 'phoneScreenshots')?.images.length, 1);
  assert.equal(
    state.locales
      .find((l) => l.locale === 'de-DE')
      ?.assets.find((a) => a.target === 'phoneScreenshots')?.images.length,
    0,
  );
});
