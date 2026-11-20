import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleSubmitConnector } from './appstore-submit.ts';
import { StoreError } from './errors.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, sha256 } from './store-draft.fixtures.ts';
import { DraftOutcomeUnknownError, type DraftReadRequest } from './store-draft-types.ts';
import {
  SubmitDriftError,
  SubmitOutcomeUnknownError,
  sameSubmitState,
  submitKey,
} from './store-submit-types.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = '10746822401';
const REQUEST: DraftReadRequest = {
  text: [{ locale: 'en-US', field: 'description' }],
  assets: [
    {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      target: 'APP_IPHONE_65',
      width: 1242,
      height: 2688,
    },
  ],
};
const accept = () => true;
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(configure?: (api: FakeAppleDraftApi) => void) {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleSubmitConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
}

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify((error as StoreError).details ?? [])}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
}

/** The only requests a submit may make that change anything. */
const SUBMIT_WRITES = ['POST /v1/reviewSubmissions', 'POST /v1/reviewSubmissionItems'];

test('readSubmitState shows the version, its build, release type, every locale and the draft, and writes nothing', async () => {
  const { api, connector } = setup((a) => {
    const v = a.versions.find((x) => x.id === 'v-next');
    if (v) v.releaseType = 'MANUAL';
    a.addPlacements('loc-en', 'IPHONE_65_PROFILE', [
      { name: 'a.png', bytes: new Uint8Array([1, 2, 3]) },
    ]);
  });
  const state = await connector.readSubmitState(REQUEST);
  assert.deepEqual(state.version, {
    id: 'v-next',
    versionString: '2.1',
    state: 'PREPARE_FOR_SUBMISSION',
    releaseType: 'MANUAL',
  });
  assert.deepEqual(state.build, {
    id: 'b-1',
    version: '57',
    processingState: 'VALID',
    expired: false,
  });
  assert.equal(state.alreadySubmitted, false);
  assert.equal(state.openReviewSubmissions, 0);
  assert.deepEqual(state.tracks, []);
  assert.equal(state.locales[0]?.locale, 'en-US');
  assert.equal(state.locales[0]?.text.description, 'Old description');
  assert.equal(state.locales[0]?.text.promotional_text, null);
  assert.deepEqual(
    state.locales[0]?.assets.map((a) => [a.kind, a.device, a.target, a.images.length]),
    [['screenshot', null, 'IPHONE_65_PROFILE', 1]],
  );
  assert.equal(state.draft?.text[0]?.value, 'Old description');
  assert.equal(state.draft?.assets[0]?.placementGroup, 'IPHONE_65_PROFILE');
  assert.deepEqual(api.writes(), []);
});

test('a version without a build reads as null, not as an error', async () => {
  const { connector } = setup((a) => a.builds.clear());
  assert.equal((await connector.readSubmitState(REQUEST)).build, null);
});

test('a version that is already in review is reported as submitted and its draft is not read', async () => {
  const { connector } = setup((a) => {
    a.versions = [
      { id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' },
      { id: 'v-next', versionString: '2.1', state: 'WAITING_FOR_REVIEW' },
    ];
  });
  const state = await connector.readSubmitState(REQUEST);
  assert.equal(state.alreadySubmitted, true);
  assert.equal(state.draft, null);
  assert.equal(state.version?.state, 'WAITING_FOR_REVIEW');
});

test('no version to submit, or two editable ones, is refused rather than guessed', async () => {
  const none = setup((a) => {
    a.versions = [{ id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' }];
  });
  await assert.rejects(
    none.connector.readSubmitState(REQUEST),
    (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version',
  );
  const two = setup((a) =>
    a.versions.push({ id: 'v-x', versionString: '2.2', state: 'PREPARE_FOR_SUBMISSION' }),
  );
  await assert.rejects(
    two.connector.readSubmitState(REQUEST),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
});

test('unsubmitted review submissions are counted, and a read that fails is "unknown", not an error', async () => {
  const counted = setup((a) =>
    a.submissions.set('sub-old', { state: 'READY_FOR_REVIEW', versions: [] }),
  );
  assert.equal((await counted.connector.readSubmitState(REQUEST)).openReviewSubmissions, 1);
  const unknown = setup((a) => {
    a.hook = (s) =>
      /reviewSubmissions$/.test(s.path) && s.method === 'GET'
        ? reply(400, {
            errors: [{ status: '400', code: 'PARAMETER_ERROR.INVALID', title: 'filter' }],
          })
        : undefined;
  });
  assert.equal((await unknown.connector.readSubmitState(REQUEST)).openReviewSubmissions, null);
});

test('submit: create the review submission, add the version, then submitted: true. Nothing else', async () => {
  const { api, connector } = setup();
  const result = await connector.submit({ request: REQUEST, guard: accept });
  assert.equal(result.via, 'review_submission');
  assert.match(result.submissionId ?? '', /^sub-/);
  assert.equal(result.submissionState, 'WAITING_FOR_REVIEW');
  assert.equal(result.before.version?.id, 'v-next');
  assert.deepEqual(
    api.writes().map((w) => w.replace(/sub-\d+/, 'sub')),
    [...SUBMIT_WRITES, 'PATCH /v1/reviewSubmissions/sub'],
  );
  const [create, item, patch] = api.seen
    .filter((s) => s.method !== 'GET')
    .map((s) => s.body as { data: Record<string, unknown> });
  assert.deepEqual(create?.data, {
    type: 'reviewSubmissions',
    relationships: { app: { data: { type: 'apps', id: APP } } },
  });
  assert.deepEqual(item?.data, {
    type: 'reviewSubmissionItems',
    relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: result.submissionId } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-next' } },
    },
  });
  assert.deepEqual(patch?.data, {
    type: 'reviewSubmissions',
    id: result.submissionId,
    attributes: { submitted: true },
  });
  // The release type is never touched, no draft is written, no version is created.
  for (const s of api.seen.filter((x) => x.method !== 'GET')) {
    assert.ok(
      !/appStoreVersions|appStoreVersionLocalizations|appAssetLibrary|phasedRelease|appStoreVersionReleaseRequests/i.test(
        s.path,
      ),
      `unexpected ${s.method} ${s.path}`,
    );
  }
  assert.equal(api.versions.find((v) => v.id === 'v-next')?.state, 'WAITING_FOR_REVIEW');
  // The read afterwards sees the version in review.
  const after = await connector.readSubmitState(REQUEST);
  assert.equal(after.alreadySubmitted, true);
});

test('the guard sees the freshest read and a refusal writes nothing', async () => {
  const { api, connector } = setup();
  let seenState: unknown;
  await assert.rejects(
    connector.submit({
      request: REQUEST,
      guard: (current) => {
        seenState = current;
        return false;
      },
    }),
    (e: unknown) => e instanceof SubmitDriftError && e.current.version?.id === 'v-next',
  );
  assert.ok(seenState);
  assert.deepEqual(api.writes(), []);
});

test('a version already in review is never submitted again', async () => {
  const { api, connector } = setup((a) => {
    a.versions = [{ id: 'v-next', versionString: '2.1', state: 'IN_REVIEW' }];
  });
  await assert.rejects(
    connector.submit({ request: REQUEST, guard: accept }),
    (e: unknown) => e instanceof StoreError && /already in review/.test(e.message),
  );
  assert.deepEqual(api.writes(), []);
});

test('a refusal before the last request says nothing was submitted and is no unknown outcome', async () => {
  for (const [path, label] of [
    ['/v1/reviewSubmissions', 'create'],
    ['/v1/reviewSubmissionItems', 'item'],
  ] as const) {
    const { api, connector } = setup((a) => {
      a.hook = (s) =>
        s.method === 'POST' && s.path === path
          ? reply(409, {
              errors: [
                {
                  status: '409',
                  code: 'STATE_ERROR',
                  title: 'Not allowed',
                  detail: 'The version has no build.',
                },
              ],
            })
          : undefined;
    });
    await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
      assert.ok(e instanceof StoreError, label);
      assert.ok(!(e instanceof SubmitOutcomeUnknownError), label);
      assert.match(e.message, /Nothing was submitted for review/);
      assertNoSecrets(e);
      return true;
    });
    // The request that hands the version to review (`submitted`) is never sent.
    assert.ok(
      !api.seen.some((s) => s.method === 'PATCH' && JSON.stringify(s.body).includes('"submitted"')),
      `${label}: never reached the last request`,
    );
    // A submission this call created and could not fill is cancelled, so empty drafts do not pile up in App Store Connect.
    const cancelled = api.seen.filter(
      (s) => s.method === 'PATCH' && JSON.stringify(s.body).includes('"canceled":true'),
    );
    assert.equal(cancelled.length, label === 'item' ? 1 : 0, label);
  }
});

test('a failed cancel of the empty review submission never hides the real failure', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'POST' && s.path === '/v1/reviewSubmissionItems'
        ? reply(409, { errors: [{ status: '409', code: 'STATE_ERROR', title: 'Not allowed' }] })
        : s.method === 'PATCH'
          ? reply(500)
          : undefined;
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.match(e.message, /Nothing was submitted for review/);
    return true;
  });
  assert.ok(
    api.seen.some((s) => s.method === 'PATCH'),
    'the cancel was tried',
  );
});

test('a lost answer before the last request is a plain failure that mentions the unsubmitted submission', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'POST' && s.path === '/v1/reviewSubmissionItems' ? reply(503) : undefined;
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(
      e instanceof StoreError &&
        !(e instanceof SubmitOutcomeUnknownError) &&
        !(e instanceof DraftOutcomeUnknownError),
    );
    assert.match(e.message, /unsubmitted review submission/);
    return true;
  });
  assert.equal(api.seen.filter((s) => s.method === 'POST').length, 2, 'nothing was repeated');
});

test('the last request refused: nothing was submitted, and it is not an unknown outcome', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PATCH'
        ? reply(409, {
            errors: [
              {
                status: '409',
                code: 'STATE_ERROR',
                title: 'Missing metadata',
                detail: 'Complete the metadata.',
              },
            ],
          })
        : undefined;
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(e instanceof StoreError && !(e instanceof SubmitOutcomeUnknownError));
    assert.match(e.message, /was not submitted/);
    assertNoSecrets(e);
    return true;
  });
});

test('a 5xx or a cut connection on the last request is an unknown outcome and is never retried', async () => {
  for (const mode of ['5xx', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.hook = (s) => {
        if (s.method !== 'PATCH') return undefined;
        return mode === '5xx'
          ? reply(503, { errors: [{ status: '503', code: 'UNAVAILABLE', title: 'x' }] })
          : new TypeError('socket hang up');
      };
    });
    await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
      assert.ok(e instanceof SubmitOutcomeUnknownError, mode);
      assertNoSecrets(e);
      return true;
    });
    assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 1, `${mode}: one attempt`);
  }
});

test('a 429 is not waited out or retried', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'POST' && s.path === '/v1/reviewSubmissions'
        ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
        : undefined;
  });
  await assert.rejects(
    connector.submit({ request: REQUEST, guard: accept }),
    (e: unknown) => e instanceof StoreError && e.kind === 'rate_limited',
  );
  assert.equal(api.seen.filter((s) => s.method === 'POST').length, 1);
});

test('a 403 message never carries the key', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PATCH'
        ? reply(403, {
            errors: [
              {
                status: '403',
                code: 'FORBIDDEN_ERROR',
                title: 'Forbidden',
                detail: `no ${key.privateKey}`,
              },
            ],
          })
        : undefined;
  });
  await assert.rejects(connector.submit({ request: REQUEST, guard: accept }), (e: unknown) => {
    assert.ok(e instanceof StoreError && e.kind === 'forbidden');
    assertNoSecrets(e);
    return true;
  });
});

test('submitKey changes with the listing, the build, the release type and the draft, and not with the order of the request', async () => {
  const { api, connector } = setup();
  const first = await connector.readSubmitState(REQUEST);
  assert.ok(sameSubmitState(first, await connector.readSubmitState(REQUEST)));
  assert.ok(
    sameSubmitState(
      first,
      await connector.readSubmitState({ ...REQUEST, text: [...REQUEST.text].reverse() }),
    ),
  );
  const loc = api.locs.get('loc-en');
  if (loc) loc.attributes.promotionalText = 'Edited in App Store Connect';
  assert.ok(
    !sameSubmitState(first, await connector.readSubmitState(REQUEST)),
    'a text outside the pushed items counts',
  );
  const second = await connector.readSubmitState(REQUEST);
  api.builds.set('v-next', { id: 'b-2', version: '58', processingState: 'VALID', expired: false });
  assert.ok(
    !sameSubmitState(second, await connector.readSubmitState(REQUEST)),
    'a new build counts',
  );
  const third = await connector.readSubmitState(REQUEST);
  const v = api.versions.find((x) => x.id === 'v-next');
  if (v) v.releaseType = 'AFTER_APPROVAL';
  assert.ok(
    !sameSubmitState(third, await connector.readSubmitState(REQUEST)),
    'the release type counts',
  );
  // The listing part of the key holds hashes of texts, never the text (the key is only ever hashed itself).
  assert.ok(!JSON.stringify(submitKey(third).locales).includes('Old description'));
  assert.ok(
    JSON.stringify(submitKey(third).locales).includes(
      sha256(new TextEncoder().encode('Old description')),
    ),
  );
});

test('a bad App Store id is refused when the connector is built', () => {
  assert.throws(
    () =>
      new AppleSubmitConnector({
        credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
        appStoreId: '12; DROP',
      }),
    /not a number/,
  );
});

test("Apple associatedErrors of a 409 on a version are kept: the kind of resource and Apple's sentence, without ids", async () => {
  const { appleErrorDetails } = await import('./appstoreconnect.ts');
  const details = appleErrorDetails({
    errors: [
      {
        code: 'STATE_ERROR.ENTITY_STATE_INVALID',
        title: 'The version is not in a valid state.',
        detail: "appStoreVersions with id 'abc' is not in valid state.",
        meta: {
          associatedErrors: {
            '/v1/ageRatingDeclarations/1234-aaaa': [
              {
                code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED',
                detail: "You must provide a value for the attribute 'gambling' with this request",
                source: { pointer: '/data/attributes/gambling' },
              },
            ],
            '/v1/appScreenshotSets/9': [{ code: 'X', title: 'Screenshots are missing' }],
          },
        },
      },
    ],
  });
  assert.equal(details.length, 3);
  assert.equal(
    details[1]?.detail,
    "ageRatingDeclarations: You must provide a value for the attribute 'gambling' with this request",
  );
  assert.equal(details[1]?.pointer, '/data/attributes/gambling');
  assert.equal(details[2]?.detail, 'appScreenshotSets: Screenshots are missing');
  assert.ok(!JSON.stringify(details).includes('1234-aaaa'));
});

test('an age rating reason of Apple comes with what to do about it', async () => {
  const { appleFixHint } = await import('./appstoreconnect.ts');
  assert.match(
    appleFixHint([
      { detail: "ageRatingDeclarations: You must provide a value for the attribute 'socialMedia'" },
    ]),
    /App Information, Age Rating/,
  );
  assert.equal(appleFixHint([{ detail: 'something else' }]), '');
});
