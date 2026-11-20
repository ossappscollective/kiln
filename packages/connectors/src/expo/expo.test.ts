import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExpoClient, EXPO_API_ORIGIN, graphqlErrorKind, normalizeExpoOrigin } from './client.ts';
import { ExpoError, type ExpoErrorKind } from './errors.ts';
import {
  ACCOUNT,
  appJson,
  graphqlError,
  noViewer,
  PROJECT_ID,
  project,
  projectById as projectByIdBody,
  projectByFullName as projectByFullNameBody,
  robotViewer,
  TOKEN,
  userViewer,
} from './expo.fixtures.ts';
import {
  expoProjectByFullName,
  expoProjectById,
  expoViewer,
  isExpoProjectId,
  normalizeExpoFullName,
} from './queries.ts';
import { readExpoProjectFromAppJson } from './app-json.ts';
import { verifyExpoCredential } from './verify-expo.ts';

type Call = { url: string; init: RequestInit; body: { query: string; variables?: unknown; operationName?: string } };
type Answer = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** A fetch that answers from a queue (the last answer repeats) and remembers every request. */
function fakeFetch(...answers: (Answer | Error)[]) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    const answer = next ?? {};
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    });
  };
  return { fetch: fetchFn, calls };
}

const client = (f: ReturnType<typeof fakeFetch>, extra: Partial<Parameters<typeof createExpoClient>[0]> = {}) =>
  createExpoClient({ token: TOKEN, fetch: f.fetch, ...extra });

async function failure(run: () => Promise<unknown>): Promise<ExpoError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExpoError, String(error));
    return error;
  }
  throw new Error('did not throw');
}

/** Nothing an error says may carry the token or Expo's own words. */
const clean = (error: ExpoError) => {
  assert.ok(!error.message.includes(TOKEN), 'the token');
  assert.ok(!JSON.stringify(error).includes(TOKEN), 'the token in the object');
  assert.ok(!/Entity not authorized|does not exist/i.test(error.message), "Expo's text");
};

test('the request: POST {origin}/graphql, bearer token, JSON body, no redirects', async () => {
  const f = fakeFetch({ body: robotViewer() });
  await expoViewer(client(f));
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.expo.dev/graphql');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(call.init.redirect, 'manual');
  assert.match(call.body.query, /meActor/);
  assert.equal(call.body.operationName, 'MrmViewer');
});

test('apiOrigin: default, a proxy with a path, trailing slashes; refuses credentials, queries and other schemes', () => {
  assert.equal(normalizeExpoOrigin(undefined), EXPO_API_ORIGIN);
  assert.equal(normalizeExpoOrigin('https://proxy.example.com/expo//'), 'https://proxy.example.com/expo');
  assert.equal(normalizeExpoOrigin('http://localhost:8080'), 'http://localhost:8080');
  for (const bad of ['not a url', 'ftp://api.expo.dev', 'https://u:p@api.expo.dev', 'https://api.expo.dev?x=1', 'https://api.expo.dev#f']) {
    assert.throws(() => normalizeExpoOrigin(bad), (e) => e instanceof ExpoError && e.kind === 'invalid_input', bad);
  }
});

test('the origin is used for the request', async () => {
  const f = fakeFetch({ body: robotViewer() });
  await expoViewer(client(f, { apiOrigin: 'https://proxy.example.com/expo/' }));
  assert.equal(f.calls[0]?.url, 'https://proxy.example.com/expo/graphql');
});

test('a token with a space or a line break, or none, is refused before anything is sent', () => {
  const f = fakeFetch({});
  for (const token of ['', '   ', 'abc def', 'abc\ndef']) {
    assert.throws(() => createExpoClient({ token, fetch: f.fetch }), (e) => e instanceof ExpoError && e.kind === 'auth');
  }
  assert.equal(f.calls.length, 0);
});

test('HTTP statuses map to the shared kinds, and no message carries the token', async () => {
  const rows: [Answer, ExpoErrorKind][] = [
    [{ status: 401, body: { message: `bad token ${TOKEN}` } }, 'auth'],
    [{ status: 403 }, 'forbidden'],
    [{ status: 429, headers: { 'retry-after': '12' } }, 'rate_limited'],
    [{ status: 500 }, 'server'],
    [{ status: 503, text: 'upstream' }, 'server'],
    [{ status: 302, headers: { location: 'https://evil.example/' } }, 'unexpected'],
    [{ status: 404 }, 'unexpected'],
    [{ text: 'not json' }, 'unexpected'],
    [{ text: '[]' }, 'unexpected'],
    [{ body: { nothing: true } }, 'unexpected'],
  ];
  for (const [answer, kind] of rows) {
    const f = fakeFetch(answer);
    const error = await failure(() => expoViewer(client(f)));
    assert.equal(error.kind, kind, JSON.stringify(answer));
    clean(error);
  }
});

test('429 carries the seconds to wait (default 60, bounded)', async () => {
  const wait = async (header?: string) =>
    (
      await failure(() =>
        expoViewer(client(fakeFetch({ status: 429, ...(header ? { headers: { 'retry-after': header } } : {}) }))),
      )
    ).retryAfterSeconds;
  assert.equal(await wait('12'), 12);
  assert.equal(await wait(), 60);
  assert.equal(await wait('999999'), 3600);
  assert.equal(await wait('soon'), 60);
});

test('GraphQL errors (answered with HTTP 200) map by wording and code, without copying Expo text', async () => {
  const rows: [string, Record<string, unknown>, ExpoErrorKind][] = [
    ['Entity not authorized', {}, 'forbidden'],
    ['Experience with id 123 does not exist', {}, 'not_found'],
    ['Unexpected server error', {}, 'server'],
    ['You must be logged in to do this', {}, 'auth'],
    ['Too many requests', {}, 'rate_limited'],
    ['Something odd', { errorCode: 'ODD_THING' }, 'unexpected'],
    ['Something odd', { errorCode: 'AUTHENTICATION_ERROR' }, 'auth'],
  ];
  for (const [message, extensions, kind] of rows) {
    const error = await failure(() => expoViewer(client(fakeFetch({ body: graphqlError(message, extensions) }))));
    assert.equal(error.kind, kind, message);
    clean(error);
  }
  const coded = await failure(() =>
    expoViewer(client(fakeFetch({ body: graphqlError('x', { errorCode: 'SOME_CODE' }) }))),
  );
  assert.equal(coded.code, 'SOME_CODE');
  const free = await failure(() =>
    expoViewer(client(fakeFetch({ body: graphqlError('x', { errorCode: 'has spaces and <html>' }) }))),
  );
  assert.equal(free.code, undefined, 'only a constant-like code is kept');
  assert.equal(graphqlErrorKind('', undefined), 'unexpected');
});

test('a token echoed in an error body is never in the message', async () => {
  const error = await failure(() =>
    expoViewer(client(fakeFetch({ body: graphqlError(`Invalid token ${TOKEN}`) }))),
  );
  clean(error);
});

test('network failure and timeout are `network`; the timeout says so', async () => {
  const down = await failure(() => expoViewer(client(fakeFetch(new TypeError(`connect ECONNREFUSED ${TOKEN}`)))));
  assert.equal(down.kind, 'network');
  assert.equal(down.timedOut, false);
  clean(down);

  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  const slow = await failure(() => expoViewer(createExpoClient({ token: TOKEN, fetch: hang, timeoutMs: 20 })));
  assert.equal(slow.kind, 'network');
  assert.equal(slow.timedOut, true);
  clean(slow);
});

test('a caller can abort a request', async () => {
  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  const controller = new AbortController();
  const pending = failure(() =>
    createExpoClient({ token: TOKEN, fetch: hang }).graphql({ query: '{ x }' }, { signal: controller.signal }),
  );
  controller.abort();
  assert.equal((await pending).kind, 'network');
});

test('an answer larger than the cap is refused', async () => {
  const big = fakeFetch({ text: JSON.stringify({ data: { pad: 'x'.repeat(5000) } }) });
  const error = await failure(() => expoViewer(client(big, { maxResponseBytes: 1000 })));
  assert.equal(error.kind, 'unexpected');
});

test('viewer: a robot, a person, an unknown token (null), and unreadable shapes', async () => {
  const robot = await expoViewer(client(fakeFetch({ body: robotViewer() })));
  assert.deepEqual(robot, {
    id: 'robot-1',
    typename: 'Robot',
    kind: 'robot',
    displayName: 'mobile-release-manager',
    username: null,
    accounts: [ACCOUNT],
  });
  const person = await expoViewer(client(fakeFetch({ body: userViewer() })));
  assert.equal(person?.kind, 'user');
  assert.equal(person?.username, 'ada');
  assert.equal(person?.accounts.length, 2);
  assert.equal(await expoViewer(client(fakeFetch({ body: noViewer() }))), null);
  for (const body of [
    { data: { meActor: 'x' } },
    { data: { meActor: { id: 'a' } } },
    { data: { meActor: { __typename: 'Robot', id: 'a', accounts: [{ id: 'x' }] } } },
  ]) {
    assert.equal((await failure(() => expoViewer(client(fakeFetch({ body }))))).kind, 'unexpected');
  }
  const sso = await expoViewer(
    client(fakeFetch({ body: { data: { meActor: { __typename: 'SSOUser', id: 's', displayName: 'S', accounts: [] } } } })),
  );
  assert.equal(sso?.kind, 'sso_user');
  const other = await expoViewer(
    client(fakeFetch({ body: { data: { meActor: { __typename: 'Mystery', id: 's', accounts: [] } } } })),
  );
  assert.equal(other?.kind, 'other');
  assert.equal(other?.displayName, 'Mystery');
});

test('project by full name: accepts @a/b and a/b, sends the normalized name, reads the project', async () => {
  const f = fakeFetch({ body: projectByFullNameBody() });
  const found = await expoProjectByFullName(client(f), 'acme/trail-notes');
  assert.deepEqual(found, {
    id: PROJECT_ID,
    name: 'Trail Notes',
    fullName: '@acme/trail-notes',
    slug: 'trail-notes',
    ownerAccount: ACCOUNT,
  });
  assert.deepEqual(f.calls[0]?.body.variables, { fullName: '@acme/trail-notes' });
  assert.match(f.calls[0]?.body.query ?? '', /byFullName\(fullName: \$fullName\)/);
  await expoProjectByFullName(client(f), '@acme/trail-notes');
  assert.deepEqual(f.calls[1]?.body.variables, { fullName: '@acme/trail-notes' });
});

test('project by id: sends the id, reads the project; a null answer is not_found', async () => {
  const f = fakeFetch({ body: projectByIdBody() });
  assert.equal((await expoProjectById(client(f), PROJECT_ID)).slug, 'trail-notes');
  assert.deepEqual(f.calls[0]?.body.variables, { appId: PROJECT_ID });
  assert.match(f.calls[0]?.body.query ?? '', /byId\(appId: \$appId\)/);
  await expoProjectById(client(f), PROJECT_ID.toUpperCase());
  assert.deepEqual(f.calls[1]?.body.variables, { appId: PROJECT_ID }, 'sent in lower case');
  const noApp = await failure(() => expoProjectById(client(fakeFetch({ body: { data: { other: 1 } } })), PROJECT_ID));
  assert.equal(noApp.kind, 'unexpected', 'no `app` in the answer is unreadable, not "not found"');
  const none = await failure(() => expoProjectById(client(fakeFetch({ body: projectByIdBody(null) })), PROJECT_ID));
  assert.equal(none.kind, 'not_found');
  const missing = await failure(() =>
    expoProjectById(client(fakeFetch({ body: graphqlError(`Experience with id ${PROJECT_ID} does not exist`) })), PROJECT_ID),
  );
  assert.equal(missing.kind, 'not_found');
});

test('a project with a missing field is unreadable; a missing name falls back to the slug', async () => {
  const bad = await failure(() =>
    expoProjectById(client(fakeFetch({ body: projectByIdBody(project({ slug: '' })) })), PROJECT_ID),
  );
  assert.equal(bad.kind, 'unexpected');
  const unnamed = await expoProjectById(
    client(fakeFetch({ body: projectByIdBody(project({ name: undefined })) })),
    PROJECT_ID,
  );
  assert.equal(unnamed.name, 'trail-notes');
});

test('a bad reference is refused before anything is sent', async () => {
  const f = fakeFetch({});
  assert.equal((await failure(() => expoProjectById(client(f), 'not-a-uuid'))).kind, 'invalid_input');
  assert.equal((await failure(() => expoProjectByFullName(client(f), 'no slash'))).kind, 'invalid_input');
  assert.equal((await failure(() => expoProjectByFullName(client(f), '@a/b/c'))).kind, 'invalid_input');
  assert.equal(f.calls.length, 0);
});

test('project id and full name helpers', () => {
  assert.equal(isExpoProjectId(PROJECT_ID), true);
  assert.equal(isExpoProjectId(PROJECT_ID.toUpperCase()), true);
  assert.equal(isExpoProjectId('2f1c8e5a-7b3d-4c9e-8a61'), false);
  assert.equal(normalizeExpoFullName(' @acme/trail-notes '), '@acme/trail-notes');
  assert.equal(normalizeExpoFullName('acme/trail.notes_2'), '@acme/trail.notes_2');
  assert.equal(normalizeExpoFullName('@acme'), undefined);
  assert.equal(normalizeExpoFullName('@/x'), undefined);
});

test('app.json: the project id, owner and slug; other shapes are read leniently, code is never run', () => {
  assert.deepEqual(readExpoProjectFromAppJson(appJson()), { projectId: PROJECT_ID, owner: 'acme', slug: 'trail-notes' });
  assert.deepEqual(readExpoProjectFromAppJson(appJson(PROJECT_ID.toUpperCase())), {
    projectId: PROJECT_ID,
    owner: 'acme',
    slug: 'trail-notes',
  });
  // Without the `expo` wrapper.
  assert.equal(
    readExpoProjectFromAppJson(JSON.stringify({ slug: 's', extra: { eas: { projectId: PROJECT_ID } } }))?.projectId,
    PROJECT_ID,
  );
  // No project id, or one that is not a UUID.
  assert.equal(readExpoProjectFromAppJson('{"expo":{"slug":"s"}}')?.projectId, null);
  assert.equal(readExpoProjectFromAppJson(appJson('not-a-uuid'))?.projectId, null);
  // Not JSON: module.exports = ... is never evaluated.
  assert.equal(readExpoProjectFromAppJson('module.exports = { expo: {} }'), undefined);
  assert.equal(readExpoProjectFromAppJson('[]'), undefined);
  assert.equal(readExpoProjectFromAppJson('"x"'), undefined);
});

test('verify: a robot, a person, no token, an unknown token, and every failure kind in words', async () => {
  const robot = await verifyExpoCredential(TOKEN, { fetch: fakeFetch({ body: robotViewer() }).fetch });
  assert.equal(robot.ok, true);
  assert.match(robot.message, /Connected to Expo as mobile-release-manager/);
  assert.ok(robot.details?.includes('Type: robot user'));
  assert.ok(robot.details?.includes('Accounts: acme'));

  const person = await verifyExpoCredential(TOKEN, { fetch: fakeFetch({ body: userViewer() }).fetch });
  assert.equal(person.ok, true);
  assert.ok(person.details?.some((d) => /robot user with the Developer role is recommended/.test(d)));
  assert.ok(person.details?.includes('Accounts: ada, acme'));

  assert.equal((await verifyExpoCredential('  ')).ok, false);
  assert.match((await verifyExpoCredential('a b')).message, /no spaces/);
  const unknown = await verifyExpoCredential(TOKEN, { fetch: fakeFetch({ body: noViewer() }).fetch });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /did not recognize the token/);

  for (const answer of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 500 }, { text: 'x' }]) {
    const result = await verifyExpoCredential(TOKEN, { fetch: fakeFetch(answer).fetch });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  const offline = await verifyExpoCredential(TOKEN, { fetch: fakeFetch(new Error(`down ${TOKEN}`)).fetch });
  assert.equal(offline.ok, false);
  assert.match(offline.message, /Could not reach Expo/);
  assert.ok(!JSON.stringify(offline).includes(TOKEN));
});

test('verify: the token and the name Expo sends are redacted from what is shown', async () => {
  const body = {
    data: { meActor: { __typename: 'Robot', id: 'r', displayName: `bot ${TOKEN}`, accounts: [{ id: 'a', name: 'acme' }] } },
  };
  const result = await verifyExpoCredential(TOKEN, { fetch: fakeFetch({ body }).fetch });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('verify: a custom origin is used', async () => {
  const f = fakeFetch({ body: robotViewer() });
  await verifyExpoCredential(TOKEN, { fetch: f.fetch, apiOrigin: 'http://127.0.0.1:9' });
  assert.equal(f.calls[0]?.url, 'http://127.0.0.1:9/graphql');
});
