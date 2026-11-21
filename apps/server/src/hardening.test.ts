import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { dbTest } from '@kiln/db/testing';
import { createLoginLimiter } from './limiter.ts';
import { boot, PASSWORD, registerOwner, send } from './testkit.ts';

const login = (
  app: Awaited<ReturnType<typeof boot>>['app'],
  email: string,
  password: string,
  extra: Record<string, string> = {},
  env?: unknown,
) =>
  app.request('/api/auth/login', send('POST', { email, password }, undefined, extra), env as never);

const WRONG = 'wrong-wrong-wrong';

// ----- login limiter -----------------------------------------------------------------------------

dbTest('concurrent wrong passwords cannot all slip past the limit', async (db) => {
  const { app } = await boot(db, { limiter: createLoginLimiter({ max: 3 }) });
  await registerOwner(app);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => login(app, 'ada@example.com', WRONG)),
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 3);
  assert.equal(statuses.filter((s) => s === 429).length, 47);
  // And the right password is locked out too, until the window ends.
  assert.equal((await login(app, 'ada@example.com', PASSWORD)).status, 429);
});

dbTest('a successful login resets the per-email count', async (db) => {
  const { app } = await boot(db, { limiter: createLoginLimiter({ max: 3 }) });
  await registerOwner(app);
  for (let round = 0; round < 3; round++) {
    assert.equal((await login(app, 'ada@example.com', WRONG)).status, 401);
    assert.equal((await login(app, 'ada@example.com', WRONG)).status, 401);
    assert.equal((await login(app, 'ada@example.com', PASSWORD)).status, 200);
  }
});

dbTest(
  'unknown invitation tokens cannot flush login lockouts (separate limiter instances)',
  async (db) => {
    const { app } = await boot(db, {
      // Tiny on purpose: a shared instance would have evicted the lockout long before 40 tokens.
      limiter: createLoginLimiter({ max: 2, maxKeys: 4 }),
      inviteLimiter: createLoginLimiter({ max: 2, maxKeys: 4 }),
    });
    await registerOwner(app);
    for (let i = 0; i < 2; i++) await login(app, 'ada@example.com', WRONG);
    assert.equal((await login(app, 'ada@example.com', PASSWORD)).status, 429);
    for (let i = 0; i < 40; i++) {
      const res = await app.request(`/api/invitations/${randomBytes(32).toString('base64url')}`);
      assert.ok(res.status === 404 || res.status === 429);
    }
    assert.equal((await login(app, 'ada@example.com', PASSWORD)).status, 429, 'still locked out');
  },
);

dbTest('a burst of bad invitation attempts is capped too', async (db) => {
  const { app } = await boot(db, { inviteLimiter: createLoginLimiter({ max: 3 }) });
  const token = randomBytes(32).toString('base64url');
  const statuses = (
    await Promise.all(Array.from({ length: 20 }, () => app.request(`/api/invitations/${token}`)))
  ).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 404).length, 3);
  assert.equal(statuses.filter((s) => s === 429).length, 17);
});

// ----- limit by client address -------------------------------------------------------------------

const socket = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

dbTest('logins are also limited per client address, across different emails', async (db) => {
  const { app } = await boot(db, { ipLimiter: createLoginLimiter({ max: 3 }) });
  await registerOwner(app);
  const from = socket('198.51.100.7');
  for (let i = 0; i < 3; i++)
    assert.equal((await login(app, `nobody${i}@example.com`, WRONG, {}, from)).status, 401);
  const blocked = await login(app, 'nobody9@example.com', WRONG, {}, from);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // The real owner behind the same address is held too; another address is not.
  assert.equal((await login(app, 'ada@example.com', PASSWORD, {}, from)).status, 429);
  assert.equal(
    (await login(app, 'ada@example.com', PASSWORD, {}, socket('198.51.100.8'))).status,
    200,
  );
});

dbTest('X-Forwarded-For is ignored unless KILN_TRUST_PROXY is set', async (db) => {
  const { app } = await boot(db, { ipLimiter: createLoginLimiter({ max: 2 }) });
  const from = socket('198.51.100.7');
  for (let i = 0; i < 2; i++)
    await login(app, 'x@example.com', WRONG, { 'x-forwarded-for': `203.0.113.${i}` }, from);
  // The socket address is what counts, whatever the header says.
  assert.equal(
    (await login(app, 'x@example.com', WRONG, { 'x-forwarded-for': '203.0.113.99' }, from)).status,
    429,
  );
});

dbTest(
  'behind a trusted proxy the address is the last X-Forwarded-For entry, not a spoofable first one',
  async (db) => {
    const { app } = await boot(db, { trustProxy: true, ipLimiter: createLoginLimiter({ max: 2 }) });
    const proxy = socket('10.0.0.1');
    const hop = (spoof: string) => ({ 'x-forwarded-for': `${spoof}, 203.0.113.9` });
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await login(app, 'x@example.com', WRONG, hop(`1.1.1.${i}`), proxy)).status,
        401,
      );
    assert.equal((await login(app, 'x@example.com', WRONG, hop('1.1.1.200'), proxy)).status, 429);
    const other = { 'x-forwarded-for': '203.0.113.10' };
    assert.equal((await login(app, 'x@example.com', WRONG, other, proxy)).status, 401);
  },
);

dbTest('successful logins do not use up the address limit', async (db) => {
  const { app } = await boot(db, { ipLimiter: createLoginLimiter({ max: 2 }) });
  await registerOwner(app);
  const from = socket('198.51.100.7');
  for (let i = 0; i < 6; i++)
    assert.equal((await login(app, 'ada@example.com', PASSWORD, {}, from)).status, 200);
});

// ----- register ----------------------------------------------------------------------------------

dbTest('a closed instance refuses /register without spending a password hash', async (db) => {
  const { app } = await boot(db);
  await registerOwner(app);
  let reads = 0;
  const spy = {
    get N() {
      reads++;
      return 1024;
    },
    r: 8,
    p: 1,
  };
  const { app: sameDb } = await boot(db, { cost: spy });
  const res = await sameDb.request(
    '/api/auth/register',
    send('POST', {
      email: 'eve@example.com',
      displayName: 'Eve',
      password: PASSWORD,
      workspaceName: 'Mine',
    }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'registration_closed' });
  assert.equal(reads, 0, 'scrypt was not run');
});

// ----- body size ---------------------------------------------------------------------------------

dbTest(
  'oversized bodies are refused with a JSON error; the public routes have the smaller limit',
  async (db) => {
    const { app } = await boot(db);
    const owner = await registerOwner(app);

    const big = await login(app, 'ada@example.com', 'x'.repeat(300 * 1024));
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as { error: string }).error, 'payload_too_large');

    const accept = await app.request(
      `/api/invitations/${randomBytes(32).toString('base64url')}/accept`,
      send('POST', { displayName: 'x'.repeat(300 * 1024) }),
    );
    assert.equal(accept.status, 413);

    // 200 KB passes the public limit's size but is not an issue for a signed-in route either.
    const mid = await app.request(
      `/api/workspaces/${owner.workspaceId}/credentials`,
      send(
        'POST',
        { kind: 'github_token', label: 'x', secret: 'x'.repeat(200 * 1024) },
        owner.cookie,
      ),
    );
    assert.equal(mid.status, 400, 'reached the handler (its own 64 KB secret limit)');

    const huge = await app.request(
      `/api/workspaces/${owner.workspaceId}/credentials`,
      send(
        'POST',
        { kind: 'github_token', label: 'x', secret: 'x'.repeat(1100 * 1024) },
        owner.cookie,
      ),
    );
    assert.equal(huge.status, 413);
    assert.equal(((await huge.json()) as { error: string }).error, 'payload_too_large');
  },
);

dbTest('the limit holds for a body without a Content-Length (streamed)', async (db) => {
  const { app } = await boot(db);
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ >= 8) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
  assert.equal(res.status, 413);
});

// ----- security headers --------------------------------------------------------------------------

dbTest(
  'every response carries the security headers; the invitation route keeps no-referrer',
  async (db) => {
    const { app } = await boot(db);
    for (const path of ['/api/health', '/api/me', '/api/nope']) {
      const res = await app.request(path);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.match(csp, /object-src 'none'/, path);
      assert.match(csp, /script-src 'self'(;|$)/, path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
      assert.equal(res.headers.get('strict-transport-security'), null, "HSTS is the proxy's job");
    }
    const invite = await app.request(`/api/invitations/${randomBytes(32).toString('base64url')}`);
    assert.equal(invite.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(invite.headers.get('x-frame-options'));
  },
);

dbTest('the static UI and its fallback are served with the same headers', async (db) => {
  const dir = mkdtempSync(join(tmpdir(), 'mrm-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'export {};');
  const { app } = await boot(db, { webDist: relative(process.cwd(), dir) });
  for (const path of ['/', '/assets/a.js', '/some/client/route']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
  }
});

// ----- query parameters --------------------------------------------------------------------------

dbTest(
  'audit limit must be a whole number from 1 to 500: anything else is a 400, never a 500',
  async (db) => {
    const { app } = await boot(db);
    const owner = await registerOwner(app);
    const get = (query: string) =>
      app.request(`/api/workspaces/${owner.workspaceId}/audit${query}`, {
        headers: { cookie: owner.cookie },
      });
    for (const bad of [
      '1.5',
      '0',
      '-1',
      'abc',
      '1e3',
      '0x10',
      '501',
      '99999999999',
      '%20',
      '1,2',
      'NaN',
      'Infinity',
    ]) {
      const res = await get(`?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad}`);
      const body = (await res.json()) as { error: string; issues: { path: string }[] };
      assert.equal(body.error, 'invalid_request');
      assert.equal(body.issues[0]?.path, 'limit');
    }
    assert.equal((await get('?limit=1')).status, 200);
    assert.equal((await get('?limit=500')).status, 200);
    assert.equal((await get('')).status, 200);
    const one = (await (await get('?limit=1')).json()) as { events: unknown[] };
    assert.equal(one.events.length, 1);
  },
);
