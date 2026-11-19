import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { type Database, migrate } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { createApp } from './app.ts';
import { createLoginLimiter } from './limiter.ts';

const PASSWORD = 'correct horse battery staple';
const cheap = { N: 1024, r: 8, p: 1 };
const pem = (word: string) => `-----BEGIN PRIVATE KEY-----\n${word}\n-----END PRIVATE KEY-----`;
const ascSecret = (word: string) =>
  JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: pem(word) });

// Every test below runs once per database (SQLite, and Postgres when MRM_TEST_POSTGRES_URL is set).
async function boot(db: Database, overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  await migrate(db);
  const masterKey = randomBytes(32);
  const app = createApp({ db, masterKey, version: '1.2.3', cost: cheap, ...overrides });
  return { app, db, masterKey };
}

type App = Awaited<ReturnType<typeof boot>>['app'];

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

async function register(app: App) {
  const res = await app.request(
    '/api/auth/register',
    json({
      email: 'Ada@Example.com',
      displayName: 'Ada',
      password: PASSWORD,
      workspaceName: 'Acme Apps',
    }),
  );
  return { res, cookie: cookieOf(res), body: (await res.json()) as { workspaceId: string } };
}

// ----- health ---------------------------------------------------------------------------------

dbTest('health is ok when the database answers', async (db) => {
  const { app } = await boot(db);
  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: 'ok',
    version: '1.2.3',
    database: { dialect: db.dialect, ok: true },
  });
});

dbTest('health reports a database failure without leaking the error', async (db) => {
  const { app } = await boot(db);
  db.ping = async () => {
    throw new Error('connection refused to 10.0.0.5');
  };
  const res = await app.request('/api/health');
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.match(text, /degraded/);
  assert.doesNotMatch(text, /10\.0\.0\.5/);
});

dbTest('unknown API routes are JSON 404s', async (db) => {
  const { app } = await boot(db);
  const res = await app.request('/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

// ----- first-run setup and sessions -----------------------------------------------------------

dbTest('first run: status asks for setup, then register signs the owner in', async (db) => {
  const { app } = await boot(db);
  assert.deepEqual(await (await app.request('/api/auth/status')).json(), {
    mode: 'multi',
    setupRequired: true,
    user: null,
  });

  const { res, cookie, body } = await register(app);
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Lax/i);

  const me = await app.request('/api/me', { headers: { cookie } });
  const data = (await me.json()) as {
    user: { email: string };
    workspaces: { id: string; role: string }[];
  };
  assert.equal(data.user.email, 'ada@example.com');
  assert.deepEqual(data.workspaces, [{ id: body.workspaceId, name: 'Acme Apps', role: 'owner' }]);
});

dbTest('registration closes after the first account', async (db) => {
  const { app } = await boot(db);
  await register(app);
  const second = await app.request(
    '/api/auth/register',
    json({
      email: 'eve@example.com',
      displayName: 'Eve',
      password: PASSWORD,
      workspaceName: 'Mine',
    }),
  );
  assert.equal(second.status, 403);
  assert.deepEqual(await second.json(), { error: 'registration_closed' });
});

dbTest('register validates its input', async (db) => {
  const { app } = await boot(db);
  const res = await app.request(
    '/api/auth/register',
    json({
      email: 'not-an-email',
      displayName: '',
      password: 'short',
      workspaceName: 'x',
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { issues: { path: string }[] };
  assert.deepEqual(body.issues.map((i) => i.path).sort(), ['displayName', 'email', 'password']);
});

dbTest('login, logout, and a session that no longer works afterwards', async (db) => {
  const { app } = await boot(db);
  await register(app);
  const login = await app.request(
    '/api/auth/login',
    json({ email: 'ada@example.com', password: PASSWORD }),
  );
  assert.equal(login.status, 200);
  const cookie = cookieOf(login);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 200);

  const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 204);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 401);
});

dbTest('wrong password and unknown email look the same', async (db) => {
  const { app } = await boot(db);
  await register(app);
  const wrong = await app.request(
    '/api/auth/login',
    json({ email: 'ada@example.com', password: 'nope-nope-nope' }),
  );
  const unknown = await app.request(
    '/api/auth/login',
    json({ email: 'who@example.com', password: 'nope-nope-nope' }),
  );
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

dbTest(
  'repeated failures lock the account for a while, and a correct password then still waits',
  async (db) => {
    let time = 1_000_000;
    const { app } = await boot(db, {
      now: () => time,
      limiter: createLoginLimiter({ max: 3, windowMs: 60_000, now: () => time }),
    });
    await register(app);
    for (let i = 0; i < 3; i++) {
      await app.request(
        '/api/auth/login',
        json({ email: 'ada@example.com', password: 'wrong-wrong-wrong' }),
      );
    }
    const blocked = await app.request(
      '/api/auth/login',
      json({ email: 'ada@example.com', password: PASSWORD }),
    );
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    time += 61_000;
    const later = await app.request(
      '/api/auth/login',
      json({ email: 'ada@example.com', password: PASSWORD }),
    );
    assert.equal(later.status, 200);
  },
);

dbTest('sessions expire', async (db) => {
  let time = 1_000_000;
  const { app } = await boot(db, { now: () => time });
  const { cookie } = await register(app);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 200);
  time += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 401);
});

dbTest('protected routes refuse anonymous requests', async (db) => {
  const { app } = await boot(db);
  assert.equal((await app.request('/api/me')).status, 401);
  assert.equal((await app.request('/api/workspaces/anything/credentials')).status, 401);
});

// ----- cross-site protection ------------------------------------------------------------------

dbTest(
  'a state-changing request from another origin is refused, same origin and no origin pass',
  async (db) => {
    const { app } = await boot(db);
    const body = { email: 'ada@example.com', password: PASSWORD };
    const foreign = await app.request(
      'http://mrm.test/api/auth/login',
      json(body, { origin: 'https://evil.example', host: 'mrm.test' }),
    );
    assert.equal(foreign.status, 403);
    const own = await app.request(
      'http://mrm.test/api/auth/login',
      json(body, { origin: 'http://mrm.test', host: 'mrm.test' }),
    );
    assert.equal(own.status, 401); // reached the handler (no account yet)
    const none = await app.request(
      'http://mrm.test/api/auth/login',
      json(body, { host: 'mrm.test' }),
    );
    assert.equal(none.status, 401);
  },
);

dbTest('trusted origins are allowed', async (db) => {
  const { app } = await boot(db, { trustedOrigins: ['http://localhost:5173'] });
  const res = await app.request(
    'http://mrm.test/api/auth/login',
    json({ email: 'a@b.co', password: 'x' }, { origin: 'http://localhost:5173', host: 'mrm.test' }),
  );
  assert.equal(res.status, 401);
});

// ----- credentials ----------------------------------------------------------------------------

dbTest('credentials: create, list without the secret, rotate, delete, all audited', async (db) => {
  const { app, masterKey } = await boot(db);
  const { cookie, body } = await register(app);
  const base = `/api/workspaces/${body.workspaceId}`;
  const secret = ascSecret('TOPSECRET');

  const created = await app.request(
    `${base}/credentials`,
    json({ kind: 'app_store_connect', label: 'Acme ASC key', secret }, { cookie }),
  );
  assert.equal(created.status, 201);
  const { credential } = (await created.json()) as { credential: { id: string } };
  assert.doesNotMatch(JSON.stringify(credential), /TOPSECRET/);

  const listed = await (await app.request(`${base}/credentials`, { headers: { cookie } })).text();
  assert.match(listed, /Acme ASC key/);
  assert.doesNotMatch(listed, /TOPSECRET/);

  const [stored] = await db.query('SELECT ciphertext FROM credentials');
  assert.doesNotMatch(String(stored?.ciphertext), /TOPSECRET/);

  const rotated = await app.request(`${base}/credentials/${credential.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ secret: ascSecret('new-secret') }),
  });
  assert.equal(rotated.status, 204);
  const badRotate = await app.request(`${base}/credentials/${credential.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ secret: 'just text' }),
  });
  assert.equal(badRotate.status, 400);
  assert.equal(((await badRotate.json()) as { error: string }).error, 'invalid_secret');

  const removed = await app.request(`${base}/credentials/${credential.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(removed.status, 204);
  assert.equal(
    (
      await app.request(`${base}/credentials/${credential.id}`, {
        method: 'DELETE',
        headers: { cookie },
      })
    ).status,
    404,
  );

  const audit = (await (await app.request(`${base}/audit`, { headers: { cookie } })).json()) as {
    events: { action: string; actorType: string; actorName: string | null }[];
  };
  const actions = audit.events.map((e) => e.action);
  for (const expected of [
    'workspace.create',
    'credential.create',
    'credential.rotate',
    'credential.delete',
  ]) {
    assert.ok(actions.includes(expected), expected);
  }
  assert.doesNotMatch(JSON.stringify(audit), /TOPSECRET|new-secret/);
  assert.equal(audit.events.find((e) => e.action === 'credential.create')?.actorName, 'Ada');
  assert.equal(masterKey.length, 32);
});

dbTest('a stored secret decrypts only for its own workspace and id', async (db) => {
  const { app, masterKey } = await boot(db);
  const { cookie, body } = await register(app);
  const created = await app.request(
    `/api/workspaces/${body.workspaceId}/credentials`,
    json({ kind: 'github_token', label: 'gh', secret: 'ghp_abc' }, { cookie }),
  );
  const { credential } = (await created.json()) as { credential: { id: string } };
  const { useCredentialSecret } = await import('./services/credentials.ts');
  const actor = { type: 'system' as const, id: 'test' };
  assert.equal(
    await useCredentialSecret(
      db,
      masterKey,
      { workspaceId: body.workspaceId, id: credential.id, purpose: 'test' },
      actor,
      1,
    ),
    'ghp_abc',
  );
  // Move the row to another credential id: the binding must break decryption.
  await db.execute('UPDATE credentials SET id = ? WHERE id = ?', ['moved', credential.id]);
  await assert.rejects(
    useCredentialSecret(
      db,
      masterKey,
      { workspaceId: body.workspaceId, id: 'moved', purpose: 'test' },
      actor,
      2,
    ),
  );
});

dbTest('a secret that cannot be right for its kind is refused with a reason', async (db) => {
  const { app } = await boot(db);
  const { cookie, body } = await register(app);
  const res = await app.request(
    `/api/workspaces/${body.workspaceId}/credentials`,
    json(
      { kind: 'app_store_connect', label: 'x', secret: JSON.stringify({ keyId: 'K' }) },
      { cookie },
    ),
  );
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error: string; message: string };
  assert.equal(data.error, 'invalid_secret');
  assert.match(data.message, /Issuer ID/);
});

dbTest('credential input is validated', async (db) => {
  const { app } = await boot(db);
  const { cookie, body } = await register(app);
  const res = await app.request(
    `/api/workspaces/${body.workspaceId}/credentials`,
    json({ kind: 'password_manager', label: '', secret: '' }, { cookie }),
  );
  assert.equal(res.status, 400);
});

// ----- roles and isolation --------------------------------------------------------------------

async function addMember(db: Database, workspaceId: string, role: string) {
  const { createSession } = await import('./services/accounts.ts');
  const id = `user-${role}`;
  await db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)', [
    id,
    `${role}@x.io`,
    role,
  ]);
  await db.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
    workspaceId,
    id,
    role,
  ]);
  const { token } = await createSession(db, id, Date.now());
  return `mrm_session=${token}`;
}

dbTest('a viewer cannot read credentials and a member cannot write them', async (db) => {
  const { app } = await boot(db);
  const { body } = await register(app);
  const base = `/api/workspaces/${body.workspaceId}`;
  const viewer = await addMember(db, body.workspaceId, 'viewer');
  const member = await addMember(db, body.workspaceId, 'member');

  assert.equal(
    (await app.request(`${base}/credentials`, { headers: { cookie: viewer } })).status,
    403,
  );
  assert.equal(
    (await app.request(`${base}/credentials`, { headers: { cookie: member } })).status,
    200,
  );
  const write = await app.request(
    `${base}/credentials`,
    json({ kind: 'github_token', label: 'x', secret: 'y' }, { cookie: member }),
  );
  assert.equal(write.status, 403);
});

dbTest(
  'someone outside a workspace gets 404, the same as for a workspace that does not exist',
  async (db) => {
    const { app } = await boot(db);
    const { body } = await register(app);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await addMember(db, 'other', 'owner');
    const real = await app.request(`/api/workspaces/${body.workspaceId}/credentials`, {
      headers: { cookie: outsider },
    });
    const missing = await app.request('/api/workspaces/no-such/credentials', {
      headers: { cookie: outsider },
    });
    assert.equal(real.status, 404);
    assert.equal(missing.status, 404);
  },
);

// ----- behaviour that depends on the database -------------------------------------------------

dbTest('two first-run registrations at once: exactly one wins', async (db) => {
  const { app } = await boot(db);
  const attempt = (email: string) =>
    app.request(
      '/api/auth/register',
      json({
        email,
        displayName: 'Someone',
        password: PASSWORD,
        workspaceName: 'Race',
      }),
    );
  const results = await Promise.all([
    attempt('a@example.com'),
    attempt('b@example.com'),
    attempt('c@example.com'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403, 403]);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM users'))[0]?.n), 1);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM workspaces'))[0]?.n), 1);
});

dbTest(
  'the audit list is newest first, honours its limit, and names only user actors',
  async (db) => {
    const { listAudit, recordAudit } = await import('./services/audit.ts');
    await boot(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'W', 0)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u', 'u@x.io', 'Una', 0)",
    );
    const base = { workspaceId: 'w', action: 'x.y' };
    await recordAudit(db, { ...base, actor: { type: 'user', id: 'u' }, at: 1 });
    // An actor id that matches a user id must not be resolved to that user unless it is a user actor.
    await recordAudit(db, { ...base, actor: { type: 'system', id: 'u' }, detail: { n: 2 }, at: 2 });
    await recordAudit(db, {
      ...base,
      actor: { type: 'system', id: 'cron' },
      target: { type: 't', id: 'i' },
      at: 3,
    });

    const all = await listAudit(db, 'w');
    assert.deepEqual(
      all.map((e) => e.at),
      [3, 2, 1],
    );
    assert.deepEqual(
      all.map((e) => e.actorName),
      [null, null, 'Una'],
    );
    assert.deepEqual(all[0]?.targetId, 'i');
    assert.deepEqual(all[1]?.detail, { n: 2 });
    assert.equal(all[2]?.targetType, null);
    assert.deepEqual(
      (await listAudit(db, 'w', 2)).map((e) => e.at),
      [3, 2],
    );
    assert.deepEqual(await listAudit(db, 'other'), []);
  },
);
