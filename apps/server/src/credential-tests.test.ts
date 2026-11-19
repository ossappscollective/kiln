import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { type Database, migrate } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { createApp } from './app.ts';
import {
  createCredentialTester,
  createTestLimiter,
  type Verifier,
  type VerifierLookup,
} from './services/credential-tests.ts';

const PASSWORD = 'correct horse battery staple';
const cheap = { N: 1024, r: 8, p: 1 };
const TOKEN = 'ghp_SECRETTOKEN1234567890abcdef';
const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ascSecret = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
const post = (cookie: string): RequestInit => ({ method: 'POST', headers: { cookie } });
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

type Calls = { kind: string; secret: string }[];

/** Verifiers that answer from a table and remember what they were asked. */
function fakeVerifiers(table: Partial<Record<string, Verifier>> = {}) {
  const calls: Calls = [];
  const lookup: VerifierLookup = (kind) => {
    const verifier = table[kind];
    if (!verifier) return undefined;
    return async (secret, options) => {
      calls.push({ kind, secret });
      return verifier(secret, options);
    };
  };
  return { lookup, calls };
}

const passes: Verifier = async () => ({
  ok: true,
  message: 'Connected as ada.',
  details: ['Signed in as: ada'],
});
const fails: Verifier = async () => ({ ok: false, message: 'GitHub rejected the token.' });

async function boot(db: Database, overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  await migrate(db);
  const app = createApp({
    db,
    masterKey: randomBytes(32),
    version: '1',
    cost: cheap,
    ...overrides,
  });
  const res = await app.request(
    '/api/auth/register',
    json({
      email: 'ada@example.com',
      displayName: 'Ada',
      password: PASSWORD,
      workspaceName: 'Acme',
    }),
  );
  const { workspaceId } = (await res.json()) as { workspaceId: string };
  const cookie = cookieOf(res);
  const base = `/api/workspaces/${workspaceId}`;
  return { app, db, cookie, workspaceId, base };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function addMember(db: Database, workspaceId: string, role: string) {
  const { createSession } = await import('./services/accounts.ts');
  const id = `user-${role}-${workspaceId}`;
  await db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)', [
    id,
    `${role}-${workspaceId}@x.io`,
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

async function save(b: Booted, kind: string, secret: string, label = 'cred') {
  const res = await b.app.request(
    `${b.base}/credentials`,
    json({ kind, label, secret }, { cookie: b.cookie }),
  );
  assert.equal(res.status, 201);
  return ((await res.json()) as { credential: { id: string } }).credential.id;
}

const auditOf = async (b: Booted, action: string) => {
  const res = await b.app.request(`${b.base}/audit`, { headers: { cookie: b.cookie } });
  const { events } = (await res.json()) as {
    events: { action: string; detail: Record<string, unknown> | null; targetId: string | null }[];
  };
  return events.filter((e) => e.action === action);
};

/** Every row of every table that could hold a secret, as one string. */
async function dump(db: Database) {
  const parts: string[] = [];
  for (const table of ['credentials', 'audit_events']) {
    const rows = await db.query(`SELECT * FROM ${table}`);
    // The ciphertext is expected to differ from the secret; compare everything else.
    parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
  }
  return parts.join('\n');
}

const noSecrets = (text: string) => {
  for (const secret of [TOKEN, KEY_LINE])
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 8)}`);
};

// ----- unsaved secrets ------------------------------------------------------------------------

dbTest(
  'testing an unsaved secret returns the verifier result, stores nothing, and is audited without the secret',
  async (db) => {
    const v = fakeVerifiers({ github_token: passes, app_store_connect: fails });
    const b = await boot(db, { credentialTests: { verifiers: v.lookup } });

    const ok = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true,
      message: 'Connected as ada.',
      details: ['Signed in as: ada'],
    });

    const bad = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'app_store_connect', secret: ascSecret }, { cookie: b.cookie }),
    );
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { ok: false, message: 'GitHub rejected the token.' });

    assert.deepEqual(v.calls, [
      { kind: 'github_token', secret: TOKEN },
      { kind: 'app_store_connect', secret: ascSecret },
    ]);
    assert.equal((await db.query('SELECT id FROM credentials')).length, 0);
    const events = await auditOf(b, 'credential.test');
    assert.deepEqual(events.map((e) => e.detail).reverse(), [
      { kind: 'github_token', ok: true, saved: false },
      { kind: 'app_store_connect', ok: false, saved: false },
    ]);
    assert.ok(events.every((e) => e.targetId === null));
    noSecrets(await dump(db));
  },
);

dbTest('an unsaved secret of the wrong shape is a 400 and costs nothing', async (db) => {
  const v = fakeVerifiers({ app_store_connect: passes });
  const b = await boot(db, { credentialTests: { verifiers: v.lookup } });
  const res = await b.app.request(
    `${b.base}/credentials/test`,
    json(
      { kind: 'app_store_connect', secret: JSON.stringify({ keyId: 'K' }) },
      { cookie: b.cookie },
    ),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, 'invalid_secret');
  assert.match(body.message, /Issuer ID/);

  const unknownKind = await b.app.request(
    `${b.base}/credentials/test`,
    json({ kind: 'password_manager', secret: 'x' }, { cookie: b.cookie }),
  );
  assert.equal(unknownKind.status, 400);
  assert.equal(((await unknownKind.json()) as { error: string }).error, 'invalid_request');
  const empty = await b.app.request(
    `${b.base}/credentials/test`,
    json({ kind: 'github_token', secret: '' }, { cookie: b.cookie }),
  );
  assert.equal(empty.status, 400);

  assert.equal(v.calls.length, 0);
  assert.equal((await auditOf(b, 'credential.test')).length, 0);
});

dbTest('/credentials/test is not mistaken for a credential id', async (db) => {
  const b = await boot(db, {
    credentialTests: { verifiers: fakeVerifiers({ github_token: passes }).lookup },
  });
  await save(b, 'github_token', TOKEN);
  const res = await b.app.request(
    `${b.base}/credentials/test`,
    json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
  );
  assert.equal(res.status, 200);
  // A saved credential literally called "test" is not reachable by that route either.
  const missing = await b.app.request(`${b.base}/credentials/test/test`, post(b.cookie));
  assert.equal(missing.status, 404);
});

// ----- saved credentials ----------------------------------------------------------------------

dbTest(
  'testing a saved credential decrypts it, records the result, lists it, and audits use and test',
  async (db) => {
    let time = Date.now();
    const v = fakeVerifiers({ github_token: passes });
    const b = await boot(db, { now: () => time, credentialTests: { verifiers: v.lookup } });
    const id = await save(b, 'github_token', TOKEN, 'Personal');

    const before = (await (
      await b.app.request(`${b.base}/credentials`, { headers: { cookie: b.cookie } })
    ).json()) as { credentials: { lastTest: unknown }[] };
    assert.equal(before.credentials[0]?.lastTest, null);

    time += 5_000;
    const res = await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      message: 'Connected as ada.',
      details: ['Signed in as: ada'],
    });
    assert.deepEqual(v.calls, [{ kind: 'github_token', secret: TOKEN }]);

    const listed = (await (
      await b.app.request(`${b.base}/credentials`, { headers: { cookie: b.cookie } })
    ).json()) as {
      credentials: { id: string; lastTest: { at: number; ok: boolean; message: string } | null }[];
    };
    assert.deepEqual(listed.credentials[0]?.lastTest, {
      at: time,
      ok: true,
      message: 'Connected as ada.',
    });

    const uses = await auditOf(b, 'credential.use');
    assert.deepEqual(
      uses.map((e) => e.detail),
      [{ purpose: 'connection test' }],
    );
    const tests = await auditOf(b, 'credential.test');
    assert.deepEqual(
      tests.map((e) => [e.targetId, e.detail]),
      [[id, { ok: true }]],
    );
    noSecrets(await dump(db));
  },
);

dbTest(
  'a failing test is remembered, a later pass replaces it, and rotating the secret clears it',
  async (db) => {
    let time = Date.now();
    let verifier: Verifier = fails;
    const b = await boot(db, {
      now: () => time,
      credentialTests: {
        verifiers: (kind) => (kind === 'github_token' ? (s, o) => verifier(s, o) : undefined),
      },
    });
    const id = await save(b, 'github_token', TOKEN);
    const lastTest = async () => {
      const res = await b.app.request(`${b.base}/credentials`, { headers: { cookie: b.cookie } });
      return ((await res.json()) as { credentials: { lastTest: unknown }[] }).credentials[0]
        ?.lastTest;
    };

    time += 1000;
    assert.equal(
      (
        (await (
          await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie))
        ).json()) as { ok: boolean }
      ).ok,
      false,
    );
    assert.deepEqual(await lastTest(), {
      at: time,
      ok: false,
      message: 'GitHub rejected the token.',
    });

    verifier = passes;
    time += 1000;
    await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
    assert.deepEqual(await lastTest(), { at: time, ok: true, message: 'Connected as ada.' });
    assert.deepEqual(
      (await auditOf(b, 'credential.test')).map((e) => e.detail),
      [{ ok: true }, { ok: false }],
    );

    const rotated = await b.app.request(`${b.base}/credentials/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: b.cookie },
      body: JSON.stringify({ secret: 'ghp_anotherTOKEN0987654321' }),
    });
    assert.equal(rotated.status, 204);
    assert.equal(await lastTest(), null);
  },
);

dbTest('a credential in another workspace, or one that does not exist, is a 404', async (db) => {
  const v = fakeVerifiers({ github_token: passes });
  const b = await boot(db, { credentialTests: { verifiers: v.lookup } });
  const id = await save(b, 'github_token', TOKEN);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const otherOwner = await addMember(db, 'other', 'owner');

  const cross = await b.app.request(
    `/api/workspaces/other/credentials/${id}/test`,
    post(otherOwner),
  );
  assert.equal(cross.status, 404);
  const missing = await b.app.request(`${b.base}/credentials/nope/test`, post(b.cookie));
  assert.equal(missing.status, 404);
  assert.equal(v.calls.length, 0);
  assert.equal((await auditOf(b, 'credential.use')).length, 0);
  // Someone outside the workspace entirely.
  assert.equal(
    (await b.app.request(`${b.base}/credentials/${id}/test`, post(otherOwner))).status,
    404,
  );
  assert.equal(
    (
      await b.app.request(
        `${b.base}/credentials/test`,
        json({ kind: 'github_token', secret: TOKEN }, { cookie: otherOwner }),
      )
    ).status,
    404,
  );
});

dbTest('a stored secret that no longer decrypts is reported, not a 500', async (db) => {
  const v = fakeVerifiers({ github_token: passes });
  const b = await boot(db, { credentialTests: { verifiers: v.lookup } });
  const id = await save(b, 'github_token', TOKEN);
  await db.execute('UPDATE credentials SET ciphertext = ? WHERE id = ?', ['not-a-ciphertext', id]);
  const res = await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; message: string };
  assert.equal(body.ok, false);
  assert.match(body.message, /could not be decrypted/);
  assert.equal(v.calls.length, 0);
});

// ----- roles ----------------------------------------------------------------------------------

dbTest(
  'testing needs credentials.write: members and viewers get 403 on both routes',
  async (db) => {
    const v = fakeVerifiers({ github_token: passes });
    const b = await boot(db, { credentialTests: { verifiers: v.lookup } });
    const id = await save(b, 'github_token', TOKEN);
    for (const role of ['member', 'viewer']) {
      const cookie = await addMember(db, b.workspaceId, role);
      const unsaved = await b.app.request(
        `${b.base}/credentials/test`,
        json({ kind: 'github_token', secret: TOKEN }, { cookie }),
      );
      assert.equal(unsaved.status, 403, `${role} unsaved`);
      const saved = await b.app.request(`${b.base}/credentials/${id}/test`, post(cookie));
      assert.equal(saved.status, 403, `${role} saved`);
    }
    assert.equal(v.calls.length, 0);
    assert.equal(
      (
        await b.app.request(
          `${b.base}/credentials/test`,
          json({ kind: 'github_token', secret: TOKEN }),
        )
      ).status,
      401,
    );
  },
);

dbTest('an admin may test', async (db) => {
  const b = await boot(db, {
    credentialTests: { verifiers: fakeVerifiers({ github_token: passes }).lookup },
  });
  const cookie = await addMember(db, b.workspaceId, 'admin');
  const res = await b.app.request(
    `${b.base}/credentials/test`,
    json({ kind: 'github_token', secret: TOKEN }, { cookie }),
  );
  assert.equal(res.status, 200);
});

// ----- rate limit -----------------------------------------------------------------------------

dbTest(
  'ten tests per workspace per minute, then 429 with Retry-After, on both routes',
  async (db) => {
    let time = Date.now();
    const v = fakeVerifiers({ github_token: passes });
    const b = await boot(db, { now: () => time, credentialTests: { verifiers: v.lookup } });
    const id = await save(b, 'github_token', TOKEN);
    const unsaved = () =>
      b.app.request(
        `${b.base}/credentials/test`,
        json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
      );

    for (let i = 0; i < 5; i++) assert.equal((await unsaved()).status, 200);
    for (let i = 0; i < 5; i++) {
      time += 1000;
      assert.equal(
        (await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie))).status,
        200,
      );
    }
    const limited = await unsaved();
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, 'rate_limited');
    const wait = Number(limited.headers.get('retry-after'));
    assert.ok(wait > 0 && wait <= 60, `retry-after ${wait}`);
    assert.equal(
      (await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie))).status,
      429,
    );
    assert.equal(v.calls.length, 10);

    // Requests that were refused before testing did not use a slot, and an unknown id costs none.
    assert.equal(
      (await b.app.request(`${b.base}/credentials/nope/test`, post(b.cookie))).status,
      404,
    );

    time += wait * 1000;
    assert.equal((await unsaved()).status, 200);
  },
);

dbTest('the limit is per workspace', async (db) => {
  const v = fakeVerifiers({ github_token: passes });
  const b = await boot(db, {
    credentialTests: { verifiers: v.lookup, limiter: createTestLimiter({ limit: 2 }) },
  });
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const other = await addMember(db, 'other', 'owner');
  const run = (base: string, cookie: string) =>
    b.app.request(
      `${base}/credentials/test`,
      json({ kind: 'github_token', secret: TOKEN }, { cookie }),
    );
  assert.equal((await run(b.base, b.cookie)).status, 200);
  assert.equal((await run(b.base, b.cookie)).status, 200);
  assert.equal((await run(b.base, b.cookie)).status, 429);
  assert.equal((await run('/api/workspaces/other', other)).status, 200);
});

test('the limiter is a sliding window on an injected clock', () => {
  let time = 0;
  const limiter = createTestLimiter({ limit: 3, windowMs: 60_000, now: () => time });
  assert.equal(limiter.take('w'), 0);
  time = 10_000;
  assert.equal(limiter.take('w'), 0);
  time = 20_000;
  assert.equal(limiter.take('w'), 0);
  time = 30_000;
  assert.equal(limiter.take('w'), 30); // the first slot frees at 60 s
  assert.equal(limiter.take('x'), 0);
  time = 60_000;
  assert.equal(limiter.take('w'), 0);
  assert.equal(limiter.take('w'), 10);
});

// ----- timeouts, missing and misbehaving verifiers --------------------------------------------

dbTest('a test that hangs is stopped after the timeout, and its request is aborted', async (db) => {
  let aborted = false;
  const hangs: Verifier = (_secret, options) =>
    new Promise(() => {
      void options.fetch('https://example.test/', {}).catch(() => {
        aborted = true;
      });
    });
  const fetchHangs: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const b = await boot(db, {
    credentialTests: {
      verifiers: fakeVerifiers({ github_token: hangs }).lookup,
      fetch: fetchHangs,
      timeoutMs: 50,
    },
  });
  const started = Date.now();
  const res = await b.app.request(
    `${b.base}/credentials/test`,
    json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; message: string };
  assert.equal(body.ok, false);
  assert.match(body.message, /took longer/);
  assert.ok(Date.now() - started < 5000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, true);
});

dbTest(
  'a kind without a verifier says testing is not available yet, and a saved one records that',
  async (db) => {
    const b = await boot(db, { credentialTests: { verifiers: fakeVerifiers({}).lookup } });
    const res = await b.app.request(
      `${b.base}/credentials/test`,
      json(
        {
          kind: 'google_play',
          secret: JSON.stringify({ client_email: 'a@b.iam', private_key: PEM }),
        },
        { cookie: b.cookie },
      ),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: false,
      message: 'Testing this kind of credential is not available yet.',
    });
    const id = await save(b, 'github_token', TOKEN);
    const saved = await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { ok: boolean }).ok, false);
  },
);

dbTest(
  'the default lookup finds connector verifiers at call time and tolerates missing ones',
  async (db) => {
    const calls: string[] = [];
    const fetchFake: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ login: 'ada' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo' },
      });
    };
    const b = await boot(db, { credentialTests: { fetch: fetchFake } });
    const res = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
    );
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /Connected as ada/);
    assert.deepEqual(calls, ['GET /user']);
    // The other kinds either have a verifier (when its connector exists) or answer "not available".
    const asc = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'app_store_connect', secret: ascSecret }, { cookie: b.cookie }),
    );
    assert.equal(asc.status, 200);
    assert.equal(typeof ((await asc.json()) as { message: string }).message, 'string');
  },
);

dbTest(
  'a verifier that throws or echoes the secret never leaks it, and nothing is a 500',
  async (db) => {
    const throws: Verifier = async () => {
      throw new Error(`boom with ${TOKEN}`);
    };
    const echoes: Verifier = async (secret) => ({
      ok: false,
      message: `GitHub said: bad credentials ${secret}`,
      details: [`key line ${KEY_LINE}`, 'fine'],
    });
    const b = await boot(db, {
      credentialTests: {
        verifiers: fakeVerifiers({ github_token: throws, app_store_connect: echoes }).lookup,
      },
    });

    const thrown = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'github_token', secret: TOKEN }, { cookie: b.cookie }),
    );
    assert.equal(thrown.status, 200);
    const thrownText = await thrown.text();
    assert.match(thrownText, /could not be completed/);
    noSecrets(thrownText);

    const echoed = await b.app.request(
      `${b.base}/credentials/test`,
      json({ kind: 'app_store_connect', secret: ascSecret }, { cookie: b.cookie }),
    );
    assert.equal(echoed.status, 200);
    const echoedText = await echoed.text();
    noSecrets(echoedText);
    assert.match(echoedText, /\[redacted\]/);
    assert.match(echoedText, /fine/);

    // Saved: what is stored for display is redacted too.
    const id = await save(b, 'app_store_connect', ascSecret);
    await b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
    noSecrets(await dump(db));
  },
);

test('the tester bounds the size of what a verifier returns', async () => {
  const many: Verifier = async () => ({
    ok: true,
    message: 'x'.repeat(5000),
    details: Array.from({ length: 50 }, () => 'd'.repeat(1000)),
  });
  const run = createCredentialTester({ verifiers: () => many });
  const out = await run('github_token', TOKEN);
  assert.equal(out.message.length, 500);
  assert.equal(out.details?.length, 20);
  assert.equal(out.details?.[0]?.length, 300);
});

dbTest(
  'a test that finishes after the secret was rotated is not attached to the new secret',
  async (db) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slowPass: Verifier = async () => {
      started();
      await gate;
      return { ok: true, message: 'Connected as the OLD token.' };
    };
    const v = fakeVerifiers({ github_token: slowPass });
    const b = await boot(db, { credentialTests: { verifiers: v.lookup } });
    const id = await save(b, 'github_token', TOKEN);

    const pending = b.app.request(`${b.base}/credentials/${id}/test`, post(b.cookie));
    await running; // the verifier holds the old secret
    const rotated = await b.app.request(`${b.base}/credentials/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: b.cookie },
      body: JSON.stringify({ secret: 'ghp_ROTATEDTOKEN1234567890abcdef' }),
    });
    assert.equal(rotated.status, 204);
    release();

    const answer = (await (await pending).json()) as { ok: boolean; superseded?: boolean };
    assert.equal(answer.ok, true);
    assert.equal(answer.superseded, true);

    const list = (await (
      await b.app.request(`${b.base}/credentials`, { headers: { cookie: b.cookie } })
    ).json()) as {
      credentials: { id: string; lastTest: unknown }[];
    };
    assert.equal(
      list.credentials.find((c) => c.id === id)?.lastTest,
      null,
      'nothing remembered for the new secret',
    );
    assert.equal((await auditOf(b, 'credential.test')).length, 0);
  },
);

test('the limiter never clears everything when it is full: busy keys keep their count', () => {
  const limiter = createTestLimiter({ limit: 1, maxKeys: 5 });
  assert.equal(limiter.take('busy'), 0);
  assert.ok(limiter.take('busy') > 0);
  // Other workspaces arrive; 'busy' is the oldest, so it may go once the map is full, but a flood
  // of keys never resets the ones that are newer than the oldest.
  for (const k of ['a', 'b', 'c']) assert.equal(limiter.take(k), 0);
  assert.equal(limiter.take('d'), 0); // full: evicts one, not all
  assert.ok(limiter.take('c') > 0, 'a recent key kept its count');
  assert.ok(limiter.take('d') > 0);
});
