import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { type Database, migrate } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import {
  allowedHosts,
  createLaunchGate,
  LOCAL_USER_EMAIL,
  parseExtraHosts,
  secretsMatch,
} from './single-user.ts';

const PORT = 8787;
const SECRET = randomBytes(32).toString('base64url');
const cheap = { N: 1024, r: 8, p: 1 };
const HOST = `127.0.0.1:${PORT}`;
const pem = '-----BEGIN PRIVATE KEY-----\nSINGLEUSERKEY\n-----END PRIVATE KEY-----';
const ascSecret = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: pem });

/** Boots the app. Requests carry a valid Host header unless the test overrides it. */
async function boot(
  db: Database,
  options: { single?: boolean; secret?: string; extraHosts?: string[] } = {},
) {
  await migrate(db);
  const secret = options.secret ?? SECRET;
  const app = createApp({
    db,
    masterKey: randomBytes(32),
    version: '1.2.3',
    cost: cheap,
    singleUser:
      options.single === false
        ? undefined
        : { launchSecret: secret, port: PORT, extraHosts: options.extraHosts },
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { host: HOST, ...(init.headers as Record<string, string> | undefined) },
    });
  return { app, db, request, secret };
}

const launchPath = (secret: string) => `/api/auth/launch?secret=${encodeURIComponent(secret)}`;
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function launch(request: Awaited<ReturnType<typeof boot>>['request'], secret = SECRET) {
  const res = await request(launchPath(secret));
  return { res, cookie: cookieOf(res) };
}

const count = async (db: Database, table: 'users' | 'sessions' | 'workspaces') => {
  const [row] = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n);
};

// ----- config ---------------------------------------------------------------------------------

const masterKey = randomBytes(32).toString('base64');

test('config: mode defaults to multi, without a host restriction or a launch secret', () => {
  const config = loadConfig({ MRM_MASTER_KEY: masterKey });
  assert.equal(config.mode, 'multi');
  assert.equal(config.host, undefined);
  assert.equal(config.launchSecret, undefined);
});

test('config: multi mode ignores a launch secret, even a bad one', () => {
  const config = loadConfig({ MRM_MASTER_KEY: masterKey, MRM_LAUNCH_SECRET: 'short' });
  assert.equal(config.mode, 'multi');
  assert.equal(config.launchSecret, undefined);
});

test('config: single_user binds to loopback and keeps the secret', () => {
  const config = loadConfig({
    MRM_MASTER_KEY: masterKey,
    MRM_MODE: 'single_user',
    MRM_LAUNCH_SECRET: SECRET,
  });
  assert.equal(config.mode, 'single_user');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.launchSecret, SECRET);
  const hex = randomBytes(32).toString('hex');
  assert.equal(
    loadConfig({ MRM_MASTER_KEY: masterKey, MRM_MODE: 'single_user', MRM_LAUNCH_SECRET: hex })
      .launchSecret,
    hex,
  );
});

test('config: single_user needs a strong secret, and errors never echo it', () => {
  const env = { MRM_MASTER_KEY: masterKey, MRM_MODE: 'single_user' };
  assert.throws(() => loadConfig(env), /MRM_LAUNCH_SECRET is required/);
  assert.throws(
    () => loadConfig({ ...env, MRM_LAUNCH_SECRET: '  ' }),
    /MRM_LAUNCH_SECRET is required/,
  );

  const weak = [
    'hunter2hunter2',
    randomBytes(16).toString('base64url'), // 16 bytes
    randomBytes(31).toString('base64url'), // 31 bytes
    `${randomBytes(32).toString('base64')}`, // padding and + / are not URL-safe
    'a'.repeat(64), // long but not random
    'ab'.repeat(40),
  ];
  for (const secret of weak) {
    assert.throws(
      () => loadConfig({ ...env, MRM_LAUNCH_SECRET: secret }),
      (error: Error) => /MRM_LAUNCH_SECRET/.test(error.message) && !error.message.includes(secret),
      secret,
    );
  }
});

test('config: an unknown mode is rejected', () => {
  assert.throws(() => loadConfig({ MRM_MASTER_KEY: masterKey, MRM_MODE: 'solo' }), /MRM_MODE/);
});

test('config: MRM_ALLOWED_HOSTS defaults to none and is parsed for single_user only', () => {
  const env = { MRM_MASTER_KEY: masterKey, MRM_MODE: 'single_user', MRM_LAUNCH_SECRET: SECRET };
  assert.deepEqual(loadConfig(env).allowedHosts, []);
  assert.deepEqual(
    loadConfig({ ...env, MRM_ALLOWED_HOSTS: ' localhost:5173, ,[::1]:5174 ,LOCALHOST:3000' })
      .allowedHosts,
    ['localhost:5173', '[::1]:5174', 'localhost:3000'],
  );
  assert.deepEqual(
    loadConfig({ MRM_MASTER_KEY: masterKey, MRM_ALLOWED_HOSTS: 'evil.example' }).allowedHosts,
    [],
  );
});

test('config: MRM_ALLOWED_HOSTS refuses anything that is not loopback with a port', () => {
  const env = { MRM_MASTER_KEY: masterKey, MRM_MODE: 'single_user', MRM_LAUNCH_SECRET: SECRET };
  for (const bad of [
    'evil.example:5173',
    'localhost',
    'localhost:0',
    'localhost:99999',
    '*',
    '*:5173',
    '0.0.0.0:5173',
    'localhost:5173x',
    'a.localhost:5173',
    'localhost:5173/x',
  ]) {
    assert.throws(() => loadConfig({ ...env, MRM_ALLOWED_HOSTS: bad }), /MRM_ALLOWED_HOSTS/, bad);
  }
  assert.deepEqual(parseExtraHosts(''), []);
});

// ----- the gate -------------------------------------------------------------------------------

test('secretsMatch compares by value', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('', 'abc'), false);
  assert.equal(secretsMatch('abc', 'abcd'), false);
});

test('the gate spends the secret once and can give it back', () => {
  const gate = createLaunchGate('s3cret');
  assert.equal(gate.consume('nope'), false);
  assert.equal(gate.spent, false);
  assert.equal(gate.consume('s3cret'), true);
  assert.equal(gate.spent, true);
  assert.equal(gate.consume('s3cret'), false);
  gate.restore();
  assert.equal(gate.consume('s3cret'), true);
});

test('allowed hosts are loopback names with the configured port', () => {
  assert.deepEqual(allowedHosts(9000), ['localhost:9000', '127.0.0.1:9000', '[::1]:9000']);
});

// ----- launch ---------------------------------------------------------------------------------

dbTest(
  'launch: the right secret redirects to / with an HttpOnly Lax session cookie',
  async (db) => {
    const { request } = await boot(db);
    const res = await request(launchPath(SECRET));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^mrm_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, new RegExp(SECRET));
    assert.doesNotMatch(await res.text(), new RegExp(SECRET));
  },
);

dbTest(
  'launch: creates the local user and workspace on first use, as owner, with no password',
  async (db) => {
    const { request } = await boot(db);
    assert.equal(await count(db, 'users'), 0);
    const { cookie } = await launch(request);

    const me = (await (await request('/api/me', { headers: { cookie } })).json()) as {
      user: { email: string; displayName: string };
      workspaces: { id: string; name: string; role: string }[];
    };
    assert.equal(me.user.email, LOCAL_USER_EMAIL);
    assert.equal(me.workspaces.length, 1);
    assert.equal(me.workspaces[0]?.role, 'owner');
    assert.equal(await count(db, 'users'), 1);
    assert.equal(await count(db, 'workspaces'), 1);
    const [row] = await db.query('SELECT password_hash FROM users');
    assert.equal(row?.password_hash, null);
  },
);

dbTest(
  'launch: the session works like any other (credentials, role checks, audit actor)',
  async (db) => {
    const { request } = await boot(db);
    const { cookie } = await launch(request);
    const me = (await (await request('/api/me', { headers: { cookie } })).json()) as {
      workspaces: { id: string }[];
    };
    const base = `/api/workspaces/${me.workspaces[0]?.id}`;

    const created = await request(
      `${base}/credentials`,
      post({ kind: 'app_store_connect', label: 'Local ASC key', secret: ascSecret }, { cookie }),
    );
    assert.equal(created.status, 201);

    const audit = (await (await request(`${base}/audit`, { headers: { cookie } })).json()) as {
      events: { action: string; actorType: string; actorName: string | null }[];
    };
    const actions = audit.events.map((e) => e.action);
    assert.ok(actions.includes('workspace.create'));
    assert.ok(actions.includes('credential.create'));
    const event = audit.events.find((e) => e.action === 'credential.create');
    assert.equal(event?.actorType, 'user');
    assert.equal(event?.actorName, 'Local user');
    assert.doesNotMatch(JSON.stringify(audit), /SINGLEUSERKEY/);

    // Workspaces the user is not in still look like they do not exist.
    assert.equal(
      (await request('/api/workspaces/nope/credentials', { headers: { cookie } })).status,
      404,
    );
  },
);

dbTest('launch: the secret works once', async (db) => {
  const { request } = await boot(db);
  const first = await launch(request);
  assert.equal(first.res.status, 302);

  const again = await request(launchPath(SECRET), { headers: { cookie: first.cookie } });
  assert.equal(again.status, 403);
  assert.deepEqual(await again.json(), { error: 'invalid_launch_secret' });
  assert.equal(again.headers.get('set-cookie'), null);
  assert.equal(await count(db, 'sessions'), 1);
  // The first session keeps working.
  assert.equal((await request('/api/me', { headers: { cookie: first.cookie } })).status, 200);
});

dbTest(
  'launch: concurrent attempts with the right secret produce exactly one session',
  async (db) => {
    const { request } = await boot(db);
    const results = await Promise.all(Array.from({ length: 8 }, () => request(launchPath(SECRET))));
    assert.equal(results.filter((r) => r.status === 302).length, 1);
    assert.equal(results.filter((r) => r.status === 403).length, 7);
    assert.equal(await count(db, 'sessions'), 1);
    assert.equal(await count(db, 'users'), 1);
  },
);

dbTest(
  'launch: wrong, empty, missing and near-miss secrets are refused and change nothing',
  async (db) => {
    const { request } = await boot(db);
    const lastChar = SECRET.endsWith('A') ? 'B' : 'A';
    const attempts = [
      '/api/auth/launch',
      '/api/auth/launch?secret=',
      launchPath('wrong'),
      launchPath(SECRET.slice(0, -1)),
      launchPath(`${SECRET}x`),
      launchPath(SECRET.slice(0, -1) + lastChar),
      launchPath(SECRET.toUpperCase() === SECRET ? SECRET.toLowerCase() : SECRET.toUpperCase()),
    ];
    for (const path of attempts) {
      const res = await request(path);
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { error: 'invalid_launch_secret' }, path);
      assert.equal(res.headers.get('set-cookie'), null, path);
    }
    assert.equal(await count(db, 'users'), 0);
    assert.equal(await count(db, 'sessions'), 0);
    // Failed guesses do not spend the real secret.
    assert.equal((await request(launchPath(SECRET))).status, 302);
  },
);

dbTest('launch: only GET exists; a POST does not start a session', async (db) => {
  const { request } = await boot(db);
  const res = await request(launchPath(SECRET), { method: 'POST' });
  assert.ok(res.status === 404 || res.status === 405);
  assert.equal(await count(db, 'sessions'), 0);
});

dbTest(
  'launch: a second launch (new secret, e.g. app restart) reuses the same user and workspace',
  async (db) => {
    const first = await boot(db);
    const a = await launch(first.request);
    const second = await boot(db, { secret: randomBytes(32).toString('base64url') });
    const b = await launch(second.request, second.secret);
    assert.equal(b.res.status, 302);
    assert.equal(await count(db, 'users'), 1);
    assert.equal(await count(db, 'workspaces'), 1);
    assert.equal(await count(db, 'sessions'), 2);
    // The old session is still good: it is the same database.
    assert.equal((await second.request('/api/me', { headers: { cookie: a.cookie } })).status, 200);
  },
);

dbTest(
  'launch: refuses a database that already has other accounts, and does not spend the secret',
  async (db) => {
    const hosted = await boot(db, { single: false });
    const reg = await hosted.app.request(
      '/api/auth/register',
      post({
        email: 'ada@example.com',
        displayName: 'Ada',
        password: 'correct horse battery staple',
        workspaceName: 'Acme',
      }),
    );
    assert.equal(reg.status, 201);

    const { request } = await boot(db);
    for (let i = 0; i < 2; i++) {
      const res = await request(launchPath(SECRET));
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'not_a_single_user_database' });
    }
    assert.equal(await count(db, 'users'), 1);
    assert.equal(await count(db, 'sessions'), 1);
  },
);

dbTest('launch: a database failure gives the secret back', async (db) => {
  const { request } = await boot(db);
  const transaction = db.transaction.bind(db);
  db.transaction = (async () => {
    throw new Error('disk full');
  }) as typeof db.transaction;
  assert.equal((await request(launchPath(SECRET))).status, 500);
  db.transaction = transaction;
  assert.equal((await request(launchPath(SECRET))).status, 302);
});

// ----- status, register, login, logout --------------------------------------------------------

dbTest(
  'status reports the mode, never asks for setup, and shows the user once launched',
  async (db) => {
    const { request } = await boot(db);
    assert.deepEqual(await (await request('/api/auth/status')).json(), {
      mode: 'single_user',
      setupRequired: false,
      user: null,
    });
    const { cookie } = await launch(request);
    const status = (await (await request('/api/auth/status', { headers: { cookie } })).json()) as {
      mode: string;
      setupRequired: boolean;
      user: { email: string } | null;
    };
    assert.equal(status.mode, 'single_user');
    assert.equal(status.user?.email, LOCAL_USER_EMAIL);
  },
);

dbTest('without a session the API answers 401', async (db) => {
  const { request } = await boot(db);
  assert.equal((await request('/api/me')).status, 401);
  assert.equal(
    (await request('/api/me', { headers: { cookie: 'mrm_session=guess' } })).status,
    401,
  );
});

dbTest(
  'single-user mode: register, login and logout are disabled with a clear error',
  async (db) => {
    const { request } = await boot(db);
    const body = {
      email: 'ada@example.com',
      displayName: 'Ada',
      password: 'correct horse battery staple',
      workspaceName: 'Acme',
    };
    const register = await request('/api/auth/register', post(body));
    assert.equal(register.status, 403);
    const payload = (await register.json()) as { error: string; message: string };
    assert.equal(payload.error, 'disabled_in_single_user_mode');
    assert.match(payload.message, /desktop shell/);

    const login = await request(
      '/api/auth/login',
      post({ email: body.email, password: body.password }),
    );
    assert.equal(login.status, 403);
    assert.equal(((await login.json()) as { error: string }).error, 'disabled_in_single_user_mode');
    assert.equal((await request('/api/auth/logout', { method: 'POST' })).status, 403);
    assert.equal(await count(db, 'users'), 0);
  },
);

dbTest('single-user mode: the local user cannot log in even by guessing its email', async (db) => {
  const { request } = await boot(db);
  await launch(request);
  const res = await request('/api/auth/login', post({ email: LOCAL_USER_EMAIL, password: '' }));
  assert.equal(res.status, 403);
});

dbTest(
  'the local user has no password even when the database is opened in multi mode',
  async (db) => {
    const { request } = await boot(db);
    await launch(request);
    const multi = await boot(db, { single: false });
    for (const password of ['', 'password', LOCAL_USER_EMAIL]) {
      const res = await multi.app.request(
        '/api/auth/login',
        post({ email: LOCAL_USER_EMAIL, password }),
      );
      assert.equal(res.status, 401);
    }
  },
);

// ----- host guard (DNS rebinding) -------------------------------------------------------------

dbTest(
  'host guard: only localhost, 127.0.0.1 and [::1] on the configured port get through',
  async (db) => {
    const { app } = await boot(db);
    for (const host of [
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
      `LOCALHOST:${PORT}`,
    ]) {
      const res = await app.request('/api/health', { headers: { host } });
      assert.equal(res.status, 200, host);
    }
    const refused = [
      'evil.example',
      `evil.example:${PORT}`,
      `localhost.evil.example:${PORT}`,
      `127.0.0.1.evil.example:${PORT}`,
      `localhost:${PORT + 1}`,
      '127.0.0.1',
      'localhost',
      '0.0.0.0:8787',
      `192.168.1.20:${PORT}`,
      `[::ffff:127.0.0.1]:${PORT}`,
      `localhost:${PORT}.evil.example`,
      `user@localhost:${PORT}`,
    ];
    for (const host of refused) {
      const res = await app.request('/api/health', { headers: { host } });
      assert.equal(res.status, 403, host);
      assert.deepEqual(await res.json(), { error: 'bad_host' }, host);
    }
  },
);

dbTest(
  'host guard: extra dev hosts are exact, and the server port rule is unchanged',
  async (db) => {
    const { app } = await boot(db, { extraHosts: ['localhost:5173'] });
    assert.equal(
      (await app.request('/api/health', { headers: { host: 'localhost:5173' } })).status,
      200,
    );
    for (const host of [
      'localhost:5174',
      '127.0.0.1:5173',
      'evil.example:5173',
      `localhost:${PORT}`,
    ]) {
      const expected = host === `localhost:${PORT}` ? 200 : 403;
      assert.equal(
        (await app.request('/api/health', { headers: { host } })).status,
        expected,
        host,
      );
    }
  },
);

dbTest(
  'host guard: covers every path, and a refused launch does not spend the secret',
  async (db) => {
    const { app } = await boot(db);
    const evil = { host: `rebind.evil.example:${PORT}` };
    for (const path of [
      '/',
      '/index.html',
      '/api/me',
      '/api/auth/status',
      '/api/nope',
      launchPath(SECRET),
    ]) {
      assert.equal((await app.request(path, { headers: evil })).status, 403, path);
    }
    const ok = await app.request(launchPath(SECRET), { headers: { host: HOST } });
    assert.equal(ok.status, 302);
  },
);

dbTest('host guard: a rebound page cannot use a valid cookie or a matching Origin', async (db) => {
  const { app, request } = await boot(db);
  const { cookie } = await launch(request);
  const evil = `rebind.evil.example:${PORT}`;
  const read = await app.request('/api/me', { headers: { host: evil, cookie } });
  assert.equal(read.status, 403);
  const write = await app.request('/api/auth/status', {
    method: 'POST',
    headers: { host: evil, origin: `http://${evil}`, cookie },
  });
  assert.equal(write.status, 403);
  assert.deepEqual(await write.json(), { error: 'bad_host' });
});

dbTest(
  'host guard: X-Forwarded-Host is refused, so it cannot fake the same-origin check',
  async (db) => {
    const { request } = await boot(db);
    const { cookie } = await launch(request);
    const me = (await (await request('/api/me', { headers: { cookie } })).json()) as {
      workspaces: { id: string }[];
    };
    const res = await request(
      `/api/workspaces/${me.workspaces[0]?.id}/credentials`,
      post(
        { kind: 'app_store_connect', label: 'x', secret: ascSecret },
        {
          cookie,
          origin: 'http://evil.example',
          'x-forwarded-host': 'evil.example',
        },
      ),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'bad_host' });
  },
);

dbTest(
  'same-origin check still applies: a cross-site POST with a valid cookie is refused',
  async (db) => {
    const { request } = await boot(db);
    const { cookie } = await launch(request);
    const me = (await (await request('/api/me', { headers: { cookie } })).json()) as {
      workspaces: { id: string }[];
    };
    const base = `/api/workspaces/${me.workspaces[0]?.id}/credentials`;
    const body = { kind: 'app_store_connect', label: 'x', secret: ascSecret };

    const cross = await request(base, post(body, { cookie, origin: 'http://localhost:3000' }));
    assert.equal(cross.status, 403);
    assert.deepEqual(await cross.json(), { error: 'bad_origin' });

    const own = await request(base, post(body, { cookie, origin: `http://${HOST}` }));
    assert.equal(own.status, 201);
  },
);

// ----- multi-user mode is untouched -----------------------------------------------------------

dbTest('multi mode: /api/auth/launch does not exist, whatever the secret', async (db) => {
  const { app } = await boot(db, { single: false });
  for (const path of ['/api/auth/launch', launchPath(SECRET), launchPath('')]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'not_found' }, path);
    assert.equal(res.headers.get('set-cookie'), null, path);
  }
  assert.equal((await app.request(launchPath(SECRET), { method: 'POST' })).status, 404);
});

dbTest('multi mode: status reports mode multi and register and login still work', async (db) => {
  const { app } = await boot(db, { single: false });
  assert.deepEqual(await (await app.request('/api/auth/status')).json(), {
    mode: 'multi',
    setupRequired: true,
    user: null,
  });

  const reg = await app.request(
    '/api/auth/register',
    post({
      email: 'ada@example.com',
      displayName: 'Ada',
      password: 'correct horse battery staple',
      workspaceName: 'Acme',
    }),
  );
  assert.equal(reg.status, 201);
  const login = await app.request(
    '/api/auth/login',
    post({
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    }),
  );
  assert.equal(login.status, 200);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST' })).status, 204);
});

dbTest('multi mode: any Host header is accepted', async (db) => {
  const { app } = await boot(db, { single: false });
  for (const host of ['mrm.example.com', 'evil.example:1', 'localhost:1']) {
    assert.equal((await app.request('/api/health', { headers: { host } })).status, 200, host);
  }
});
