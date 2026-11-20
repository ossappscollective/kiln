import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import { RolloutDriftError, RolloutOutcomeUnknownError } from '../rollout-types.ts';
import * as fx from '../store.fixtures.ts';
import { AppleRolloutConnector, parseApplePhasedRelease } from './appstore-rollout.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = '10746822401';
const VERSIONS = `/v1/apps/${APP}/appStoreVersions?limit=200`;
const PHASED_OF = (versionId: string) =>
  `/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`;
const PATCH = '/v1/appStoreVersionPhasedReleases/pr-1';
const target = { version: '2.0' };

const versions = {
  data: [
    {
      type: 'appStoreVersions',
      id: 'v-20',
      attributes: {
        platform: 'IOS',
        versionString: '2.0',
        appVersionState: 'READY_FOR_DISTRIBUTION',
      },
    },
    {
      type: 'appStoreVersions',
      id: 'v-21',
      attributes: { platform: 'IOS', versionString: '2.1', appVersionState: 'WAITING_FOR_REVIEW' },
    },
    {
      type: 'appStoreVersions',
      id: 'v-mac',
      attributes: { platform: 'MAC_OS', versionString: '2.0', appVersionState: 'READY_FOR_SALE' },
    },
  ],
  links: { self: `${fx.APPLE_BASE}${VERSIONS}` },
};
const phased = (state: string, extra: Record<string, unknown> = {}) => ({
  data: {
    type: 'appStoreVersionPhasedReleases',
    id: 'pr-1',
    attributes: {
      phasedReleaseState: state,
      startDate: '2026-11-16T08:00:00Z',
      totalPauseDuration: 1,
      currentDayNumber: 3,
      ...extra,
    },
  },
});

function setup(options: { versions?: unknown; phased?: unknown } = {}) {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'GET', match: VERSIONS, json: options.versions ?? versions })
    .on({ method: 'GET', match: PHASED_OF('v-20'), json: options.phased ?? phased('ACTIVE') });
  const connector = new AppleRolloutConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}
const accept = () => true;

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
}

test('parseApplePhasedRelease is tolerant: missing fields are null', () => {
  assert.deepEqual(parseApplePhasedRelease(undefined), {
    id: null,
    state: null,
    currentDayNumber: null,
    startDate: null,
    totalPauseDays: null,
  });
  const p = parseApplePhasedRelease(phased('paused').data);
  assert.deepEqual(p, {
    id: 'pr-1',
    state: 'PAUSED',
    currentDayNumber: 3,
    startDate: Date.parse('2026-11-16T08:00:00Z'),
    totalPauseDays: 1,
  });
});

test('readState finds the iOS version by its marketing version and reads its phased release', async () => {
  const { fake, connector } = setup();
  const state = await connector.readState(target);
  assert.deepEqual(state, {
    store: 'appstoreconnect',
    platform: 'ios',
    version: '2.0',
    storeVersionId: 'v-20',
    versionState: 'READY_FOR_DISTRIBUTION',
    phasedReleaseId: 'pr-1',
    phasedReleaseState: 'ACTIVE',
    currentDayNumber: 3,
    startDate: Date.parse('2026-11-16T08:00:00Z'),
    totalPauseDays: 1,
  });
  assert.deepEqual(fake.unexpected, []);
  assert.ok(
    fake.calls.every((c) => c.method === 'GET'),
    'reading never writes',
  );
});

test('a version without a phased release (404 or data null), and a version that does not exist', async () => {
  const none = setup();
  none.fake
    .clear('GET', PHASED_OF('v-20'))
    .on({ method: 'GET', match: PHASED_OF('v-20'), status: 404, json: fx.apple404 });
  const state = await none.connector.readState(target);
  assert.ok(
    state.store === 'appstoreconnect' &&
      state.phasedReleaseId === null &&
      state.phasedReleaseState === null,
  );
  const empty = setup();
  empty.fake
    .clear('GET', PHASED_OF('v-20'))
    .on({ method: 'GET', match: PHASED_OF('v-20'), json: { data: null } });
  assert.ok((await empty.connector.readState(target)).store === 'appstoreconnect');
  await assert.rejects(
    none.connector.readState({ version: '9.9' }),
    (e: unknown) => e instanceof StoreError && e.kind === 'not_found',
  );
  // The macOS version with the same string is not the iOS one; two iOS versions with one string are refused.
  const twice = setup({
    versions: {
      data: [
        ...versions.data,
        {
          type: 'appStoreVersions',
          id: 'v-20b',
          attributes: { platform: 'IOS', versionString: '2.0' },
        },
      ],
    },
  });
  await assert.rejects(twice.connector.readState(target), /more than one iOS version/);
  await assert.rejects(
    none.connector.readState({ track: 'production', versionCodes: ['1'] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  await assert.rejects(
    none.connector.readState({ version: '../x' }),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
});

test('pause: one PATCH with the documented JSON:API document, after a fresh read and the guard', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'PATCH', match: PATCH, json: phased('PAUSED', { currentDayNumber: 4 }) });
  const seen: unknown[] = [];
  const done = await connector.applyChange({
    target,
    change: { action: 'pause' },
    guard: (s) => {
      seen.push(s);
      return true;
    },
  });
  assert.deepEqual(fake.unexpected, []);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['GET', 'GET', 'PATCH'],
  );
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch?.body ?? '{}'), {
    data: {
      type: 'appStoreVersionPhasedReleases',
      id: 'pr-1',
      attributes: { phasedReleaseState: 'PAUSED' },
    },
  });
  assert.match(patch?.headers.get('authorization') ?? '', /^Bearer eyJ/);
  assert.ok(done.before.store === 'appstoreconnect' && done.before.phasedReleaseState === 'ACTIVE');
  assert.ok(
    done.after.store === 'appstoreconnect' &&
      done.after.phasedReleaseState === 'PAUSED' &&
      done.after.currentDayNumber === 4,
    'merged with what Apple answered',
  );
});

test('resume and release to all send ACTIVE and COMPLETE', async () => {
  for (const [state, change, sent] of [
    ['PAUSED', 'resume', 'ACTIVE'],
    ['ACTIVE', 'release_to_all', 'COMPLETE'],
    ['PAUSED', 'release_to_all', 'COMPLETE'],
  ] as const) {
    const { fake, connector } = setup({ phased: phased(state) });
    fake.on({ method: 'PATCH', match: PATCH, json: phased(sent) });
    const done = await connector.applyChange({ target, change: { action: change }, guard: accept });
    assert.equal(
      JSON.parse(fake.calls.find((c) => c.method === 'PATCH')?.body ?? '{}').data.attributes
        .phasedReleaseState,
      sent,
    );
    assert.ok(done.after.store === 'appstoreconnect' && done.after.phasedReleaseState === sent);
  }
});

test('a guard that refuses sends nothing; a change the rules refuse sends nothing', async () => {
  const drift = setup();
  await assert.rejects(
    drift.connector.applyChange({ target, change: { action: 'pause' }, guard: () => false }),
    (e: unknown) =>
      e instanceof RolloutDriftError &&
      e.current.store === 'appstoreconnect' &&
      e.current.phasedReleaseState === 'ACTIVE',
  );
  assert.ok(drift.fake.calls.every((c) => c.method === 'GET'));
  // No un-release: a COMPLETE phased release cannot be paused, resumed or released again.
  for (const change of ['pause', 'resume', 'release_to_all'] as const) {
    const done = setup({ phased: phased('COMPLETE') });
    await assert.rejects(
      done.connector.applyChange({ target, change: { action: change }, guard: accept }),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
    );
    assert.ok(done.fake.calls.every((c) => c.method === 'GET'));
  }
  await assert.rejects(
    setup().connector.applyChange({
      target,
      change: { action: 'constructor' } as never,
      guard: accept,
    }),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
});

test('a refusal is the store’s answer with nothing applied; 403 and 405 explain the key', async () => {
  const body409 = {
    errors: [
      {
        status: '409',
        code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
        title: 'x',
        detail: 'You cannot change the state of a phased release in the current version state.',
      },
    ],
  };
  for (const [status, json, kind] of [
    [409, body409, 'unexpected'],
    [
      403,
      { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'x', detail: 'y' }] },
      'forbidden',
    ],
    [
      405,
      { errors: [{ status: '405', code: 'METHOD_NOT_ALLOWED', title: 'x', detail: 'y' }] },
      'unsupported',
    ],
  ] as const) {
    const { fake, connector } = setup();
    fake.on({ method: 'PATCH', match: PATCH, status, json });
    await assert.rejects(
      connector.applyChange({ target, change: { action: 'pause' }, guard: accept }),
      (e: unknown) => {
        assertNoSecrets(e);
        return (
          e instanceof StoreError &&
          !(e instanceof RolloutOutcomeUnknownError) &&
          e.kind === kind &&
          e.status === status
        );
      },
      String(status),
    );
    assert.equal(fake.called('PATCH', PATCH).length, 1);
  }
});

test('a 429 on the write is not waited out and not retried', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'PATCH',
    match: PATCH,
    status: 429,
    json: {},
    headers: { 'retry-after': '1' },
  });
  await assert.rejects(
    connector.applyChange({ target, change: { action: 'pause' }, guard: accept }),
    (e: unknown) => e instanceof StoreRateLimitError,
  );
  assert.equal(fake.called('PATCH', PATCH).length, 1);
});

test('an unknown outcome (5xx, cut connection) is RolloutOutcomeUnknownError and the PATCH is never repeated', async () => {
  for (const route of [
    { status: 502, json: {} },
    { throws: new TypeError('fetch failed') },
  ] as const) {
    const { fake, connector } = setup();
    fake.on({ method: 'PATCH', match: PATCH, ...route });
    await assert.rejects(
      connector.applyChange({ target, change: { action: 'release_to_all' }, guard: accept }),
      (e: unknown) => {
        assertNoSecrets(e);
        return e instanceof RolloutOutcomeUnknownError && /not known whether/.test(e.message);
      },
    );
    assert.equal(fake.called('PATCH', PATCH).length, 1, 'no retry');
  }
});

test('the lookup follows paging links only on the API host', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match: VERSIONS,
    json: { data: [], links: { next: 'https://evil.example/v1/apps/x/appStoreVersions?cursor=1' } },
  });
  const connector = new AppleRolloutConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: fake.fetch,
    now: () => T0,
  });
  await assert.rejects(connector.readState(target), /another host/);
  assert.equal(fake.calls.length, 1);
  assert.throws(
    () =>
      new AppleRolloutConnector({
        credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
        appStoreId: '../apps',
      }),
    StoreError,
  );
});
