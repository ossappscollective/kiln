import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSourceCandidate } from '@kiln/core';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { FakeAppleDraftApi } from '../store-draft.fixtures.ts';
import { AppleReviewDetailConnector } from './appstore-review-detail.ts';
import { AppleSubmitConnector } from './appstore-submit.ts';

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const key = fx.appleKeyPem();

type Call = { method: string; path: string; body: unknown };
type Attrs = Record<string, unknown>;
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FULL: Attrs = {
  contactFirstName: 'Marie',
  contactLastName: 'Girard',
  contactPhone: '+33 1 23 45 67 89',
  contactEmail: 'marie.girard@example.test',
  demoAccountRequired: true,
  demoAccountName: 'reviewer@example.test',
  demoAccountPassword: 'Tr0ub4dor-secret',
  notes: 'Open Settings, then Account.',
};
const SECRETS = ['Marie', 'Girard', '+33 1 23', 'example.test', 'Tr0ub4dor', 'Open Settings'];

const v = (id: string, versionString: string, state: string): ReviewSourceCandidate => ({
  id,
  versionString,
  state,
  editable: state === 'PREPARE_FOR_SUBMISSION',
});
const VERSIONS = [
  v('v-new', '2.0.1', 'PREPARE_FOR_SUBMISSION'),
  v('v-live', '1.19.0', 'READY_FOR_SALE'),
  v('v-old', '1.18.0', 'REPLACED_WITH_NEW_VERSION'),
];

/** `details`: by version id, the attributes of its review detail (absent: 404). `post`/`patch` may answer with an error. */
function setup(
  details: Record<string, Attrs | undefined>,
  options: { write?: () => Response; read?: (id: string) => Response | undefined } = {},
) {
  const calls: Call[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const read = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/.exec(url.pathname);
    if (method === 'GET' && read) {
      const id = read[1] as string;
      const custom = options.read?.(id);
      if (custom) return custom;
      const attributes = details[id];
      return attributes === undefined
        ? json(404, { errors: [{ code: 'NOT_FOUND', title: 'none' }] })
        : json(200, { data: { type: 'appStoreReviewDetails', id: `rd-${id}`, attributes } });
    }
    if (method === 'POST' && url.pathname === '/v1/appStoreReviewDetails')
      return options.write?.() ?? json(201, { data: { type: 'appStoreReviewDetails', id: 'rd-created' } });
    if (method === 'PATCH' && /^\/v1\/appStoreReviewDetails\/[^/]+$/.test(url.pathname))
      return options.write?.() ?? json(200, { data: { type: 'appStoreReviewDetails', id: 'x' } });
    return json(404, { errors: [{ code: 'NOT_FOUND', title: 'no' }] });
  };
  const connector = new AppleReviewDetailConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fetchFake,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { calls, connector };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const noPersonalData = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
};

test('the previous version has full details: one POST for the new version with the same fields', async () => {
  const { calls, connector } = setup({ 'v-live': FULL });
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.outcome, 'created');
  assert.deepEqual(done.from, { id: 'v-live', versionString: '1.19.0' });
  assert.equal(done.fieldsCopied, 8);
  assert.deepEqual(writes(calls), [
    {
      method: 'POST',
      path: '/v1/appStoreReviewDetails',
      body: {
        data: {
          type: 'appStoreReviewDetails',
          attributes: FULL,
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-new' } } },
        },
      },
    },
  ]);
  // the result is counts and a masked summary
  assert.deepEqual(done.summary, {
    contact: 'M. G.',
    phone: true,
    email: true,
    demoAccount: 'required',
    demoCredentials: true,
    notes: true,
  });
  noPersonalData(done);
});

test('the live version is preferred; one without details is skipped for the next', async () => {
  const { calls, connector } = setup({ 'v-old': { ...FULL, contactFirstName: 'Old' } });
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.from?.versionString, '1.18.0');
  assert.equal((writes(calls)[0]?.body as { data: { attributes: Attrs } }).data.attributes.contactFirstName, 'Old');
});

test('no previous version has any detail: nothing is written', async () => {
  const none = setup({});
  assert.deepEqual(await none.connector.carryOver(VERSIONS, 'v-new'), {
    outcome: 'no_source',
    from: null,
    fieldsCopied: 0,
    summary: null,
  });
  assert.deepEqual(writes(none.calls), []);
  // a detail that exists but is blank is "none" too
  const blank = setup({ 'v-live': { contactFirstName: '  ', contactEmail: '', notes: null, demoAccountRequired: false } });
  assert.equal((await blank.connector.carryOver(VERSIONS, 'v-new')).outcome, 'no_source');
  assert.deepEqual(writes(blank.calls), []);
});

test('the new version already has details: only its blank attributes are patched, filled ones are untouched', async () => {
  const { calls, connector } = setup({
    'v-live': FULL,
    'v-new': { contactFirstName: 'Paul', contactLastName: '  ', contactPhone: null, demoAccountRequired: false },
  });
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.outcome, 'merged');
  const sent = writes(calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, 'PATCH');
  assert.equal(sent[0]?.path, '/v1/appStoreReviewDetails/rd-v-new');
  const attributes = (sent[0]?.body as { data: { id: string; attributes: Attrs } }).data.attributes;
  assert.equal(attributes.contactFirstName, undefined, 'a filled value is never overwritten');
  assert.equal(attributes.contactLastName, 'Girard');
  assert.equal(attributes.contactPhone, FULL.contactPhone);
  assert.equal(attributes.demoAccountPassword, FULL.demoAccountPassword);
  // the target has text of its own, so its demoAccountRequired=false stays
  assert.equal(attributes.demoAccountRequired, undefined);
  noPersonalData(done);
});

test('an untouched blank detail on the new version takes the demo account requirement too', async () => {
  const { calls, connector } = setup({ 'v-live': FULL, 'v-new': { demoAccountRequired: false } });
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.outcome, 'merged');
  assert.equal((writes(calls)[0]?.body as { data: { attributes: Attrs } }).data.attributes.demoAccountRequired, true);
});

test('a complete detail on the new version is left alone', async () => {
  const { calls, connector } = setup({ 'v-live': FULL, 'v-new': { ...FULL, notes: 'mine' } });
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.outcome, 'already_complete');
  assert.deepEqual(writes(calls), []);
});

test('previewCarry never writes, and reads no target for a version that does not exist yet', async () => {
  const { calls, connector } = setup({ 'v-live': FULL });
  const done = await connector.previewCarry(VERSIONS.slice(1), null);
  assert.equal(done.outcome, 'created');
  assert.equal(done.from?.versionString, '1.19.0');
  assert.deepEqual(writes(calls), []);
  assert.ok(!calls.some((c) => c.path.includes('v-new')));
  noPersonalData(done);
});

test('a refused write is a result, not a throw, and nothing personal is in it, even when Apple quotes the value', async () => {
  const { connector } = setup(
    { 'v-live': FULL },
    {
      write: () =>
        json(409, {
          errors: [
            { status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', title: 'Invalid', detail: 'contactEmail marie.girard@example.test is not valid' },
          ],
        }),
    },
  );
  const done = await connector.carryOver(VERSIONS, 'v-new');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.httpStatus, 409);
  assert.equal(typeof done.code, 'string');
  noPersonalData(done);
});

test('a source that cannot be read is a failed result; one unreadable version is skipped for the next', async () => {
  const broken = setup({ 'v-live': FULL }, { read: () => json(500, {}) });
  const failed = await broken.connector.carryOver(VERSIONS, 'v-new');
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(writes(broken.calls), []);
  const skip = setup({ 'v-old': FULL }, { read: (id) => (id === 'v-live' ? json(500, {}) : undefined) });
  assert.equal((await skip.connector.carryOver(VERSIONS, 'v-new')).from?.versionString, '1.18.0');
});

test('readFacts holds presence only; a version without a detail is "exists false"; a failed read is null', async () => {
  const { connector } = setup({ 'v-live': FULL, 'v-new': { contactFirstName: ' ', contactEmail: 'a@b.test' } });
  const full = await connector.readFacts('v-live');
  assert.equal(full?.exists, true);
  assert.equal(full?.demoAccountPassword, true);
  noPersonalData(full);
  const partial = await connector.readFacts('v-new');
  assert.equal(partial?.contactFirstName, false);
  assert.equal(partial?.contactEmail, true);
  assert.equal((await connector.readFacts('v-none'))?.exists, false);
  const down = setup({}, { read: () => json(500, {}) });
  assert.equal(await down.connector.readFacts('v-live'), null);
});

test('no message carries a value when Apple answers a read with an error that quotes it', async () => {
  const { connector } = setup(
    {},
    { read: () => json(403, { errors: [{ status: '403', code: 'FORBIDDEN', title: 'no', detail: 'contactEmail marie.girard@example.test' }] }) },
  );
  await assert.rejects(connector.readDetail('v-live'), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    noPersonalData(`${e.message} ${JSON.stringify(e.details ?? [])}`);
    return true;
  });
});

test('the submit connector reads presence of the review information, and the version to copy from when it is missing', async () => {
  const api = new FakeAppleDraftApi();
  api.versions = [
    { id: 'v-live', versionString: '1.19.0', state: 'READY_FOR_DISTRIBUTION' },
    { id: 'v-next', versionString: '2.0.1', state: 'PREPARE_FOR_SUBMISSION' },
  ];
  const detail = (id: string) => ({ data: { type: 'appStoreReviewDetails', id: `rd-${id}`, attributes: id === 'v-live' ? FULL : { contactFirstName: ' ' } } });
  api.hook = (s) => {
    const m = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/.exec(s.path);
    return m && s.method === 'GET' ? json(200, detail(m[1] as string)) : undefined;
  };
  const connector = new AppleSubmitConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: '10746822401',
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  const state = await connector.readSubmitState({ text: [], assets: [] });
  assert.equal(state.reviewDetail?.exists, true);
  assert.equal(state.reviewDetail?.contactFirstName, false);
  assert.deepEqual(state.reviewSource, { id: 'v-live', versionString: '1.19.0' });
  noPersonalData(state.reviewDetail);
  assert.deepEqual(api.writes(), []);
});
