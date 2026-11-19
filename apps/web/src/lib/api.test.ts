import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi, messageFor } from './api.ts';

type Call = { path: string; init: RequestInit | undefined };

function fake(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('sends JSON with the right method and path, and returns the parsed body', async () => {
  const { calls, fetchImpl } = fake(() => jsonResponse({ user: { id: 'u' } }));
  const api = createApi({ fetch: fetchImpl });
  const result = await api.login({ email: 'a@b.co', password: 'pw' });
  assert.deepEqual(result, { user: { id: 'u' } });
  assert.equal(calls[0]?.path, '/api/auth/login');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { email: 'a@b.co', password: 'pw' });
  assert.deepEqual(calls[0]?.init?.headers, { 'content-type': 'application/json' });
});

test('a bodyless request sends no content type, and 204 resolves to undefined', async () => {
  const { calls, fetchImpl } = fake(() => new Response(null, { status: 204 }));
  const api = createApi({ fetch: fetchImpl });
  assert.equal(await api.logout(), undefined);
  assert.equal(calls[0]?.init?.headers, undefined);
});

test('ids are escaped in paths', async () => {
  const { calls, fetchImpl } = fake(() => new Response(null, { status: 204 }));
  await createApi({ fetch: fetchImpl }).deleteCredential('w/1', 'c 2');
  assert.equal(calls[0]?.path, '/api/workspaces/w%2F1/credentials/c%202');
});

test('an error response becomes an ApiError with a sentence for the person', async () => {
  const { fetchImpl } = fake(() => jsonResponse({ error: 'invalid_credentials' }, 401));
  await assert.rejects(
    createApi({ fetch: fetchImpl }).login({ email: 'a', password: 'b' }),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 401);
      assert.equal(e.code, 'invalid_credentials');
      assert.equal(e.message, 'The email or password is wrong.');
      return true;
    },
  );
});

test('a 401 outside sign-in tells the app the session ended, but a failed sign-in does not', async () => {
  let ended = 0;
  const { fetchImpl } = fake(() => jsonResponse({ error: 'unauthenticated' }, 401));
  const api = createApi({ fetch: fetchImpl, onUnauthenticated: () => void ended++ });
  await assert.rejects(api.me());
  assert.equal(ended, 1);
  await assert.rejects(api.login({ email: 'a', password: 'b' }));
  assert.equal(ended, 1);
});

test('rate limiting reports the wait in minutes', async () => {
  const { fetchImpl } = fake(() =>
    jsonResponse({ error: 'too_many_attempts' }, 429, { 'retry-after': '600' }),
  );
  await assert.rejects(
    createApi({ fetch: fetchImpl }).login({ email: 'a', password: 'b' }),
    /10 minutes/,
  );
});

test('an unreachable server gets its own message', async () => {
  const api = createApi({
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(api.status(), (e: unknown) => e instanceof ApiError && e.code === 'network');
});

test('a non-JSON error body still produces a message', async () => {
  const { fetchImpl } = fake(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(createApi({ fetch: fetchImpl }).status(), /server had a problem/);
});

test('validation issues and secret problems come through', () => {
  assert.equal(
    messageFor(400, {
      error: 'invalid_request',
      issues: [{ path: 'password', message: 'Use at least 12 characters' }],
    }),
    'password: Use at least 12 characters',
  );
  assert.equal(
    messageFor(400, { error: 'invalid_secret', message: 'Fill in: Key ID.' }),
    'Fill in: Key ID.',
  );
});

test('testing a typed secret posts it to the test endpoint and returns the verdict', async () => {
  const { calls, fetchImpl } = fake(() =>
    jsonResponse({ ok: true, message: 'Connected.', details: ['Key is valid'] }),
  );
  const result = await createApi({ fetch: fetchImpl }).testSecret('w/1', {
    kind: 'github_token',
    secret: 's3cret',
  });
  assert.deepEqual(result, { ok: true, message: 'Connected.', details: ['Key is valid'] });
  assert.equal(calls[0]?.path, '/api/workspaces/w%2F1/credentials/test');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    kind: 'github_token',
    secret: 's3cret',
  });
});

test('testing a saved credential posts without a body and escapes the id', async () => {
  const { calls, fetchImpl } = fake(() => jsonResponse({ ok: false, message: 'Rejected.' }));
  const result = await createApi({ fetch: fetchImpl }).testCredential('w1', 'c 2');
  assert.deepEqual(result, { ok: false, message: 'Rejected.' });
  assert.equal(calls[0]?.path, '/api/workspaces/w1/credentials/c%202/test');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, undefined);
});

test('a rate-limited test reports the wait and keeps retryAfter', async () => {
  const { fetchImpl } = fake(() =>
    jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '30' }),
  );
  await assert.rejects(createApi({ fetch: fetchImpl }).testCredential('w1', 'c1'), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfter, 30);
    assert.equal(e.message, 'Too many requests. Try again in 30 seconds.');
    return true;
  });
});

test('an invalid secret surfaces the server message', async () => {
  const { fetchImpl } = fake(() =>
    jsonResponse({ error: 'invalid_secret', message: 'Fill in: Key ID.' }, 400),
  );
  await assert.rejects(
    createApi({ fetch: fetchImpl }).testSecret('w1', { kind: 'app_store_connect', secret: '{}' }),
    /Fill in: Key ID\./,
  );
});

test('member and invitation calls use the right method, path and body', async () => {
  const { calls, fetchImpl } = fake((call) =>
    call.init?.method === 'GET' || call.init?.method === 'POST'
      ? jsonResponse(
          { members: [], invitations: [], invitation: { id: 'i1' }, token: 't' },
          call.init?.method === 'POST' ? 201 : 200,
        )
      : new Response(null, { status: 204 }),
  );
  const api = createApi({ fetch: fetchImpl });
  await api.members('w/1');
  await api.changeRole('w/1', 'u 2', 'viewer');
  await api.removeMember('w/1', 'u 2');
  await api.invitations('w/1');
  const created = await api.createInvitation('w/1', { email: 'a@b.co', role: 'member' });
  await api.revokeInvitation('w/1', 'i 1');
  assert.equal(created.token, 't');
  assert.deepEqual(
    calls.map((c) => [c.init?.method, c.path]),
    [
      ['GET', '/api/workspaces/w%2F1/members'],
      ['PATCH', '/api/workspaces/w%2F1/members/u%202'],
      ['DELETE', '/api/workspaces/w%2F1/members/u%202'],
      ['GET', '/api/workspaces/w%2F1/invitations'],
      ['POST', '/api/workspaces/w%2F1/invitations'],
      ['DELETE', '/api/workspaces/w%2F1/invitations/i%201'],
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { role: 'viewer' });
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { email: 'a@b.co', role: 'member' });
});

test('the invitation token is escaped in the path', async () => {
  const { calls, fetchImpl } = fake(() =>
    jsonResponse({ workspaceName: 'Acme', email: 'a@b.co', role: 'member', valid: true }),
  );
  const api = createApi({ fetch: fetchImpl });
  assert.equal((await api.invitation('a/b')).workspaceName, 'Acme');
  await api.acceptInvitation('a/b', { displayName: 'Bob', password: 'pw' });
  await api.acceptInvitation('a/b');
  assert.equal(calls[0]?.path, '/api/invitations/a%2Fb');
  assert.equal(calls[1]?.path, '/api/invitations/a%2Fb/accept');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    displayName: 'Bob',
    password: 'pw',
  });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {});
});

test('a rejected invitation request says what to do', async () => {
  const cases: [string, number, string | RegExp][] = [
    ['last_owner', 409, /at least one owner/],
    ['already_member', 409, /already a member/],
    ['already_invited', 409, /pending invitation/],
    ['email_mismatch', 403, /different email/],
    ['account_exists', 409, /Sign in with it/],
    ['disabled_in_single_user_mode', 403, /single-user/],
  ];
  for (const [error, status, message] of cases) {
    const { fetchImpl } = fake(() => jsonResponse({ error }, status));
    await assert.rejects(createApi({ fetch: fetchImpl }).acceptInvitation('t'), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, error);
      assert.match(e.message, message);
      return true;
    });
  }
  const { fetchImpl } = fake(() =>
    jsonResponse({ error: 'last_owner', message: 'Make someone else an owner first.' }, 409),
  );
  await assert.rejects(
    createApi({ fetch: fetchImpl }).removeMember('w', 'u'),
    /Make someone else an owner first\./,
  );
});

test('listing calls only read, with the filter in the query string', async () => {
  const { calls, fetchImpl } = fake(() => jsonResponse({ items: [], nextCursor: null }));
  const api = createApi({ fetch: fetchImpl });
  await api.appListingLive('w', 'a/1');
  await api.appListingDrift('w', 'a/1');
  await api.appListingHistory('w', 'a/1');
  await api.appListingHistory('w', 'a/1', {
    locale: 'en-US',
    field: 'name',
    cursor: '10:x',
    limit: 25,
  });
  assert.deepEqual(
    calls.map((c) => [c.init?.method, c.path]),
    [
      ['GET', '/api/workspaces/w/apps/a%2F1/listing/live'],
      ['GET', '/api/workspaces/w/apps/a%2F1/listing/drift'],
      ['GET', '/api/workspaces/w/apps/a%2F1/listing/history'],
      [
        'GET',
        '/api/workspaces/w/apps/a%2F1/listing/history?locale=en-US&field=name&cursor=10%3Ax&limit=25',
      ],
    ],
  );
});

test('reading the repository listing is a POST that has no body, and a missing link has a sentence', async () => {
  const { calls, fetchImpl } = fake(() => jsonResponse({ error: 'no_repository' }, 422));
  const api = createApi({ fetch: fetchImpl });
  await assert.rejects(api.refreshAppRepoListing('w', 'a'), /not linked to a repository/);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.path, '/api/workspaces/w/apps/a/listing/repo-refresh');
  assert.equal(calls[0]?.init?.body, undefined);
});

test('the refresh and clone codes have a message', () => {
  for (const error of [
    'base_changed',
    'refresh_conflicts',
    'nothing_to_apply',
    'changed_meanwhile',
    'clone_busy',
  ]) {
    const message = messageFor(409, { error });
    assert.ok(message.length > 20, error);
    assert.notEqual(message, error);
  }
  assert.match(messageFor(409, { error: 'change_conflict' }), /refresh/i);
});

test('the staged-changes calls use the documented routes, and the push sends only the hash', async () => {
  const { calls, fetchImpl } = fake(() => jsonResponse({ staged: {} }));
  const api = createApi({ fetch: fetchImpl });
  await api.storeDraftConfig('w1');
  await api.appStaged('w1', 'a/1');
  await api.stageText('w1', 'a1', { locale: 'en-US', field: 'description', from: 'repo' });
  await api.stageAssets('w1', 'a1', {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
    from: 'repo',
    paths: ['x.png'],
  });
  await api.unstageItem('w1', 'a1', 'en-US/screenshot:iphone_6_5');
  await api.clearStaged('w1', 'a1');
  await api.previewStagedPush('w1', 'a1');
  await api.pushStagedDraft('w1', 'a1', 'f'.repeat(64));
  const seen = calls.map((c) => `${c.init?.method} ${c.path}`);
  assert.deepEqual(seen, [
    'GET /api/workspaces/w1/store-draft/config',
    'GET /api/workspaces/w1/apps/a%2F1/staged',
    'PUT /api/workspaces/w1/apps/a1/staged/text',
    'PUT /api/workspaces/w1/apps/a1/staged/assets',
    'DELETE /api/workspaces/w1/apps/a1/staged/items?id=en-US%2Fscreenshot%3Aiphone_6_5',
    'DELETE /api/workspaces/w1/apps/a1/staged',
    'POST /api/workspaces/w1/apps/a1/staged/push/preview',
    'POST /api/workspaces/w1/apps/a1/staged/push',
  ]);
  assert.deepEqual(JSON.parse(String(calls[7]?.init?.body)), { confirmHash: 'f'.repeat(64) });
});
