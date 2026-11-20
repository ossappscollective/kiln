import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppleVersionConnector,
  VersionDriftError,
  VersionOutcomeUnknownError,
} from './appstore-version.ts';
import { StoreError } from './errors.ts';
import * as fx from './store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = '10746822401';

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const version = (id: string, versionString: string, platform: string, state: string) => ({
  id,
  type: 'appStoreVersions',
  attributes: { versionString, platform, appVersionState: state },
});
const LISTED = [
  version('v-live', '3.1.1', 'IOS', 'READY_FOR_SALE'),
  version('v-old', '3.0', 'IOS', 'REPLACED_WITH_NEW_VERSION'),
  version('m-live', '9.0', 'MAC_OS', 'READY_FOR_SALE'),
];

function setup(
  options: { post?: () => Response; list?: unknown[]; platform?: 'ios' | 'macos' } = {},
) {
  const calls: Call[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET' && url.pathname === `/v1/apps/${APP}/appStoreVersions`)
      return json(200, { data: options.list ?? LISTED });
    if (method === 'POST' && url.pathname === '/v1/appStoreVersions')
      return (
        options.post?.() ??
        json(201, {
          data: version(
            'v-new',
            body.data.attributes.versionString,
            body.data.attributes.platform,
            'PREPARE_FOR_SUBMISSION',
          ),
        })
      );
    return json(404, { errors: [{ code: 'NOT_FOUND', title: 'no' }] });
  };
  const connector = new AppleVersionConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    platform: options.platform ?? 'ios',
    fetch: fetchFake,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { calls, connector };
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

test('readVersions lists the versions of the platform only and marks the editable ones', async () => {
  const { connector } = setup({
    list: [
      ...LISTED,
      version('v-next', '3.2', 'IOS', 'PREPARE_FOR_SUBMISSION'),
      version('v-rej', '3.3', 'IOS', 'REJECTED'),
    ],
  });
  const state = await connector.readVersions();
  assert.deepEqual(
    state.versions.map((v) => [v.versionString, v.editable]),
    [
      ['3.1.1', false],
      ['3.0', false],
      ['3.2', true],
      ['3.3', true],
    ],
  );
});

test('createVersion posts the documented body once, for the platform of the record', async () => {
  const { connector, calls } = setup();
  const done = await connector.createVersion({
    request: { versionString: '3.1.2' },
    guard: () => true,
  });
  assert.deepEqual(posts(calls), [
    {
      method: 'POST',
      path: '/v1/appStoreVersions',
      body: {
        data: {
          type: 'appStoreVersions',
          attributes: { platform: 'IOS', versionString: '3.1.2' },
          relationships: { app: { data: { type: 'apps', id: APP } } },
        },
      },
    },
  ]);
  assert.deepEqual(done.version, {
    id: 'v-new',
    versionString: '3.1.2',
    state: 'PREPARE_FOR_SUBMISSION',
  });
  assert.equal(done.before.versions.length, 2);
});

test('createVersion: macOS uses MAC_OS and an explicit release type is sent', async () => {
  const { connector, calls } = setup({ platform: 'macos' });
  await connector.createVersion({
    request: { versionString: '9.0.1', releaseType: 'MANUAL' },
    guard: () => true,
  });
  const body = posts(calls)[0]?.body as { data: { attributes: Record<string, string> } };
  assert.deepEqual(body.data.attributes, {
    platform: 'MAC_OS',
    versionString: '9.0.1',
    releaseType: 'MANUAL',
  });
});

test('a guard that refuses writes nothing and reports the state it saw', async () => {
  const { connector, calls } = setup();
  await assert.rejects(
    connector.createVersion({ request: { versionString: '3.1.2' }, guard: () => false }),
    (e) => e instanceof VersionDriftError && e.current.versions.length === 2,
  );
  assert.equal(posts(calls).length, 0);
});

test("a 409 is a refusal with Apple's reasons, sent once and not retried", async () => {
  const { connector, calls } = setup({
    post: () =>
      json(409, {
        errors: [
          {
            code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
            title: 'The version string is invalid',
            detail: 'The version string you provided is not valid.',
            source: { pointer: '/data/attributes/versionString' },
          },
        ],
      }),
  });
  await assert.rejects(
    connector.createVersion({ request: { versionString: '3.1.2' }, guard: () => true }),
    (e) =>
      e instanceof StoreError &&
      !(e instanceof VersionOutcomeUnknownError) &&
      e.status === 409 &&
      e.details?.[0]?.pointer === '/data/attributes/versionString',
  );
  assert.equal(posts(calls).length, 1);
});

test('a 5xx is an unknown outcome and a 429 is not retried', async () => {
  const lost = setup({ post: () => json(503) });
  await assert.rejects(
    lost.connector.createVersion({ request: { versionString: '3.1.2' }, guard: () => true }),
    (e) => e instanceof VersionOutcomeUnknownError,
  );
  assert.equal(posts(lost.calls).length, 1);
  const limited = setup({
    post: () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
  });
  await assert.rejects(
    limited.connector.createVersion({ request: { versionString: '3.1.2' }, guard: () => true }),
    (e) => e instanceof StoreError,
  );
  assert.equal(posts(limited.calls).length, 1);
});

test('errors carry no key material', async () => {
  const { connector } = setup({
    post: () => json(403, { errors: [{ code: 'FORBIDDEN', title: 'no' }] }),
  });
  await assert.rejects(
    connector.createVersion({ request: { versionString: '3.1.2' }, guard: () => true }),
    (e) => {
      assert.ok(e instanceof Error);
      const all = `${e.message} ${e.stack ?? ''}`;
      assert.ok(!all.includes('PRIVATE KEY'));
      assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(all));
      return true;
    },
  );
});
