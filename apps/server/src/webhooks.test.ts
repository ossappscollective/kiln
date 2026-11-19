import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { decryptSecret } from '@mrm/vault';
import { claimNext, completeJob, failJob } from './jobs.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { emitEvent } from './services/events.ts';
import {
  type Resolver,
  sendPinned as realSend,
  type SendResult,
  type sendPinned,
} from './services/webhook-transport.ts';
import {
  createWebhookHandler,
  signWebhook,
  WEBHOOK_QUEUE,
  webhookAad,
} from './services/webhooks.ts';
import { seedWorkspace } from './testkit.ts';

type Boot = Awaited<ReturnType<typeof bootRepoApp>>;
type Sent = { url: string; body: string; headers: Record<string, string> };

const PUBLIC: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const URL_OK = 'https://hooks.example.com/mrm';
const masterKey = randomBytes(32);

/** An app with webhooks pointed at a fake receiver, and a way to run the delivery jobs. */
async function bootHooks(db: Parameters<typeof bootRepoApp>[0], resolve: Resolver = PUBLIC) {
  const sent: Sent[] = [];
  const reply: { next: SendResult[]; fallback: SendResult } = {
    next: [],
    fallback: { ok: true, status: 200, body: 'ok' },
  };
  const send: typeof sendPinned = async (url, body, headers) => {
    sent.push({ url, body, headers });
    return reply.next.shift() ?? reply.fallback;
  };
  const t = await bootRepoApp(db, undefined, { masterKey, webhooks: { resolve, send } });
  const handler = createWebhookHandler({ db, masterKey, now: Date.now, resolve, send });
  /** Runs every job that is due at `at`, the way the worker does. Returns how many ran. */
  const run = async (at = Date.now() + 1000) => {
    let ran = 0;
    for (let job = await claimNext(db, at); job; job = await claimNext(db, at)) {
      ran++;
      try {
        await handler(job.payload, job);
        await completeJob(db, job);
      } catch (error) {
        await failJob(db, job, error, { maxAttempts: 5, now: at });
      }
    }
    return ran;
  };
  const create = async (body: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'POST', '/webhooks', { url: URL_OK, eventTypes: ['*'], ...body });
  return { ...t, sent, reply, run, create, handler };
}
type Hooks = Awaited<ReturnType<typeof bootHooks>>;

const deliveries = async (t: Hooks, id: string, query = '') =>
  (await t.call(t.owner, 'GET', `/webhooks/${id}/deliveries${query}`)).body.deliveries as {
    id: string;
    status: string;
    attempts: number;
    eventType: string;
    eventId: number | null;
    responseCode: number | null;
    responseBody: string | null;
    error: string | null;
    redeliveryOf: string | null;
    createdAt: number;
  }[];

// ----- management -----------------------------------------------------------------------------

dbTest('creating a webhook returns the secret once, and stores it only encrypted', async (db) => {
  const t = await bootHooks(db);
  const res = await t.create({
    description: 'CI',
    eventTypes: ['app.synced', 'changeset.applied', 'app.synced'],
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const secret = res.body.secret as string;
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(res.body.webhook.eventTypes, ['app.synced', 'changeset.applied']);
  assert.equal(res.body.webhook.enabled, true);
  assert.equal(res.body.webhook.lastDelivery, null);
  assert.equal('secret' in res.body.webhook, false);

  // Nothing read later has it.
  const id = res.body.webhook.id as string;
  const list = await t.call(t.owner, 'GET', '/webhooks');
  const one = await t.call(t.owner, 'GET', `/webhooks/${id}`);
  assert.equal(list.body.webhooks.length, 1);
  assert.equal(one.body.webhook.url, URL_OK);
  assert.equal(JSON.stringify([list.body, one.body]).includes(secret), false);
  assert.equal(JSON.stringify(list.body).includes('ciphertext'), false);

  // At rest it is ciphertext that only decrypts with the workspace-bound context.
  const [row] = await db.query('SELECT ciphertext FROM webhook_endpoints WHERE id = ?', [id]);
  const stored = String(row?.ciphertext);
  assert.equal(stored.includes(secret), false);
  assert.equal(decryptSecret(stored, masterKey, webhookAad(t.workspaceId, id)), secret);
  assert.throws(() => decryptSecret(stored, masterKey, webhookAad('other', id)));

  // Not in the audit log either, and the audit names the actor.
  const audit = (await t.auditActions()).filter((a) => a.action === 'webhook.create');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.targetId, id);
  assert.equal(audit[0]?.detail.includes(secret), false);
  assert.equal(audit[0]?.actorType, 'user');
});

dbTest('only owners and admins manage webhooks; a token never does', async (db) => {
  const t = await bootHooks(db);
  const created = await t.create();
  const id = created.body.webhook.id as string;
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  assert.equal((await t.create({}, admin)).status, 201);
  for (const cookie of [member, viewer]) {
    assert.equal((await t.call(cookie, 'GET', '/webhooks')).status, 403);
    assert.equal((await t.call(cookie, 'GET', `/webhooks/${id}`)).status, 403);
    assert.equal((await t.create({}, cookie)).status, 403);
    assert.equal(
      (await t.call(cookie, 'PATCH', `/webhooks/${id}`, { enabled: false })).status,
      403,
    );
    assert.equal((await t.call(cookie, 'DELETE', `/webhooks/${id}`)).status, 403);
    assert.equal((await t.call(cookie, 'POST', `/webhooks/${id}/rotate-secret`)).status, 403);
    assert.equal((await t.call(cookie, 'POST', `/webhooks/${id}/test`)).status, 403);
    assert.equal((await t.call(cookie, 'GET', `/webhooks/${id}/deliveries`)).status, 403);
  }
  assert.equal((await t.app.request(`/api/workspaces/${t.workspaceId}/webhooks`)).status, 401);

  // Even an admin-level token is refused: webhooks are for people with a session.
  const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'Bot', role: 'admin' });
  const auth = { authorization: `Bearer ${minted.body.token}` };
  const get = await t.app.request(`/api/workspaces/${t.workspaceId}/webhooks`, { headers: auth });
  assert.equal(get.status, 403);
  const post = await t.app.request(`/api/workspaces/${t.workspaceId}/webhooks`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ url: URL_OK, eventTypes: ['*'] }),
  });
  assert.equal(post.status, 403);
  assert.equal((await t.call(t.owner, 'GET', '/webhooks')).body.webhooks.length, 2);
});

dbTest('create refuses bad input and dangerous URLs', async (db) => {
  const t = await bootHooks(db);
  const bad: [string, Record<string, unknown>][] = [
    ['http', { url: 'http://hooks.example.com/x' }],
    ['no url', { url: '' }],
    ['not a url', { url: 'nonsense' }],
    ['credentials', { url: 'https://a:b@hooks.example.com/x' }],
    ['metadata', { url: 'https://169.254.169.254/latest' }],
    ['loopback', { url: 'https://127.0.0.1/x' }],
    ['localhost', { url: 'https://localhost/x' }],
    ['private', { url: 'https://10.0.0.1/x' }],
    ['too long', { url: `https://hooks.example.com/${'a'.repeat(2100)}` }],
  ];
  for (const [name, body] of bad) assert.equal((await t.create(body)).status, 400, name);
  assert.equal(
    (await t.create({ url: 'https://169.254.169.254/latest' })).body.error,
    'invalid_url',
  );
  assert.equal((await t.create({ eventTypes: [] })).status, 400);
  assert.equal((await t.create({ eventTypes: ['nope'] })).status, 400);
  assert.equal((await t.create({ eventTypes: ['app.synced', 5] })).status, 400);
  assert.equal((await t.create({ eventTypes: Array(21).fill('*') })).status, 400);
  assert.equal((await t.create({ description: 'd'.repeat(201) })).status, 400);
  assert.equal((await t.call(t.owner, 'GET', '/webhooks')).body.webhooks.length, 0);
});

dbTest(
  'a host name that resolves inside the network is refused at creation and update',
  async (db) => {
    const answers = { list: [{ address: '93.184.216.34', family: 4 }] };
    const t = await bootHooks(db, async () => answers.list);
    const good = await t.create();
    assert.equal(good.status, 201);
    answers.list = [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.9', family: 4 },
    ];
    const created = await t.create({ url: 'https://rebind.example.com/x' });
    assert.equal(created.status, 400);
    assert.equal(created.body.error, 'invalid_url');
    const updated = await t.call(t.owner, 'PATCH', `/webhooks/${good.body.webhook.id}`, {
      url: 'https://rebind.example.com/x',
    });
    assert.equal(updated.status, 400);
    // A DNS hiccup does not block saving: the delivery will try again later.
    answers.list = [];
    assert.equal((await t.create({ url: 'https://later.example.com/x' })).status, 201);
  },
);

dbTest('a workspace has a limited number of webhooks, and bodies are size-limited', async (db) => {
  const t = await bootHooks(db);
  for (let i = 0; i < 20; i++)
    assert.equal((await t.create({ url: `https://hooks.example.com/${i}` })).status, 201);
  const over = await t.create();
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'too_many_webhooks');
  const res = await t.app.request(`/api/workspaces/${t.workspaceId}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: t.owner },
    body: JSON.stringify({ url: URL_OK, eventTypes: ['*'], description: 'x'.repeat(40_000) }),
  });
  assert.equal(res.status, 413);
});

dbTest(
  'PATCH changes the fields it is given, audits the names of them, and refuses an empty patch',
  async (db) => {
    const t = await bootHooks(db);
    const { body } = await t.create({ description: 'old', eventTypes: ['app.synced'] });
    const id = body.webhook.id as string;
    const res = await t.call(t.owner, 'PATCH', `/webhooks/${id}`, {
      url: 'https://hooks.example.com/new',
      description: null,
      eventTypes: ['changeset.created'],
      enabled: false,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      {
        url: res.body.webhook.url,
        description: res.body.webhook.description,
        types: res.body.webhook.eventTypes,
        on: res.body.webhook.enabled,
      },
      {
        url: 'https://hooks.example.com/new',
        description: null,
        types: ['changeset.created'],
        on: false,
      },
    );
    assert.equal((await t.call(t.owner, 'PATCH', `/webhooks/${id}`, {})).status, 400);
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/webhooks/${id}`, { eventTypes: [] })).status,
      400,
    );
    assert.equal((await t.call(t.owner, 'PATCH', '/webhooks/nope', { enabled: true })).status, 404);
    const audit = (await t.auditActions()).find((a) => a.action === 'webhook.update');
    assert.ok(audit);
    assert.match(audit.detail, /eventTypes/);
  },
);

dbTest('deleting a webhook removes its deliveries; unknown ids are 404', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create();
  const id = body.webhook.id as string;
  assert.equal((await t.call(t.owner, 'POST', `/webhooks/${id}/test`)).status, 202);
  assert.equal((await t.call(t.owner, 'DELETE', `/webhooks/${id}`)).status, 204);
  assert.equal((await t.call(t.owner, 'DELETE', `/webhooks/${id}`)).status, 404);
  assert.equal((await t.call(t.owner, 'GET', `/webhooks/${id}`)).status, 404);
  assert.equal(
    (await db.query('SELECT id FROM webhook_deliveries WHERE endpoint_id = ?', [id])).length,
    0,
  );
  // The job that was waiting finds nothing and sends nothing.
  await t.run();
  assert.equal(t.sent.length, 0);
  assert.ok(
    (await t.auditActions()).some((a) => a.action === 'webhook.delete' && a.targetId === id),
  );
});

dbTest('rotating the secret returns a new one once, and later deliveries use it', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create({ eventTypes: ['app.synced'] });
  const id = body.webhook.id as string;
  const first = body.secret as string;
  const rotated = await t.call(t.owner, 'POST', `/webhooks/${id}/rotate-secret`);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.get('cache-control'), 'no-store');
  const second = rotated.body.secret as string;
  assert.notEqual(second, first);
  assert.match(second, /^whsec_/);
  assert.equal((await t.call(t.owner, 'POST', '/webhooks/nope/rotate-secret')).status, 404);

  await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 1 } });
  await t.run();
  const hit = t.sent[0];
  assert.ok(hit);
  const ts = hit.headers['x-mrm-timestamp'] ?? '';
  assert.equal(hit.headers['x-mrm-signature'], `v1=${signWebhook(second, ts, hit.body)}`);
  assert.notEqual(hit.headers['x-mrm-signature'], `v1=${signWebhook(first, ts, hit.body)}`);
  const audits = JSON.stringify(await t.auditActions());
  assert.equal(audits.includes(first) || audits.includes(second), false);
});

// ----- delivery -------------------------------------------------------------------------------

dbTest('an event is delivered, signed, to the endpoints that asked for its type', async (db) => {
  const t = await bootHooks(db);
  const wanted = await t.create({ url: 'https://a.example.com/in', eventTypes: ['app.synced'] });
  const all = await t.create({ url: 'https://b.example.com/in', eventTypes: ['*'] });
  const other = await t.create({
    url: 'https://c.example.com/in',
    eventTypes: ['changeset.created'],
  });
  const off = await t.create({ url: 'https://d.example.com/in', enabled: false });
  const event = await emitEvent(db, {
    workspaceId: t.workspaceId,
    type: 'app.synced',
    subject: { appId: 'a1' },
    payload: { found: 3 },
  });
  assert.equal(await t.run(), 2);

  assert.deepEqual(t.sent.map((s) => s.url).sort(), [
    'https://a.example.com/in',
    'https://b.example.com/in',
  ]);
  const hit = t.sent.find((s) => s.url === 'https://a.example.com/in');
  assert.ok(hit);
  assert.deepEqual(JSON.parse(hit.body), {
    id: event.id,
    type: 'app.synced',
    workspaceId: t.workspaceId,
    createdAt: event.createdAt,
    subject: { appId: 'a1' },
    data: { found: 3 },
  });
  assert.equal(hit.headers['content-type'], 'application/json');
  assert.equal(hit.headers['x-mrm-event'], 'app.synced');
  assert.match(hit.headers['x-mrm-delivery'] ?? '', /^[0-9a-f-]{36}$/);
  assert.match(hit.headers['x-mrm-timestamp'] ?? '', /^[0-9]{10}$/);
  const signature = hit.headers['x-mrm-signature'] ?? '';
  assert.match(signature, /^v1=[0-9a-f]{64}$/);
  assert.equal(
    signature,
    `v1=${signWebhook(wanted.body.secret, hit.headers['x-mrm-timestamp'] ?? '', hit.body)}`,
  );
  // Each endpoint is signed with its own secret.
  const second = t.sent.find((s) => s.url === 'https://b.example.com/in');
  assert.equal(
    second?.headers['x-mrm-signature'],
    `v1=${signWebhook(all.body.secret, second?.headers['x-mrm-timestamp'] ?? '', second?.body ?? '')}`,
  );
  assert.notEqual(second?.headers['x-mrm-signature'], signature);

  const log = await deliveries(t, wanted.body.webhook.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.status, 'success');
  assert.equal(log[0]?.attempts, 1);
  assert.equal(log[0]?.eventId, event.id);
  assert.equal(log[0]?.responseCode, 200);
  assert.equal((await deliveries(t, other.body.webhook.id)).length, 0);
  assert.equal((await deliveries(t, off.body.webhook.id)).length, 0);
  const listed = (await t.call(t.owner, 'GET', '/webhooks')).body.webhooks as {
    id: string;
    lastDelivery: { status: string } | null;
  }[];
  assert.equal(
    listed.find((w) => w.id === wanted.body.webhook.id)?.lastDelivery?.status,
    'success',
  );
});

dbTest("events of one workspace are never delivered to another workspace's webhook", async (db) => {
  const t = await bootHooks(db);
  const mine = await t.create({ url: 'https://mine.example.com/in' });
  const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
  await emitEvent(db, {
    workspaceId: other.workspaceId,
    type: 'app.synced',
    payload: { secretish: 'theirs' },
  });
  await t.run();
  assert.equal(t.sent.length, 0);
  assert.equal((await deliveries(t, mine.body.webhook.id)).length, 0);
  // And their cookie cannot see or touch mine: they are not members of my workspace, and my
  // webhook id means nothing in theirs.
  const id = mine.body.webhook.id as string;
  for (const [method, path] of [
    ['GET', `/webhooks/${id}`],
    ['PATCH', `/webhooks/${id}`],
    ['DELETE', `/webhooks/${id}`],
    ['POST', `/webhooks/${id}/rotate-secret`],
    ['POST', `/webhooks/${id}/test`],
    ['GET', `/webhooks/${id}/deliveries`],
  ] as const) {
    const body = method === 'PATCH' ? { enabled: false } : undefined;
    assert.equal(
      (await t.call(other.cookie, method, path, body)).status,
      404,
      `${method} ${path} in my workspace`,
    );
    assert.equal(
      (await t.call(other.cookie, method, path, body, other.workspaceId)).status,
      404,
      `${method} ${path} in theirs`,
    );
  }
  assert.deepEqual(
    (await t.call(other.cookie, 'GET', '/webhooks', undefined, other.workspaceId)).body.webhooks,
    [],
  );
  assert.equal(
    (await t.call(t.owner, 'GET', `/webhooks/${id}`)).status,
    200,
    'nothing of mine was changed',
  );
});

dbTest('a failing receiver is retried with backoff, then the delivery succeeds', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create({ eventTypes: ['app.synced'] });
  const id = body.webhook.id as string;
  t.reply.next.push(
    { ok: true, status: 503, body: 'try later' },
    { ok: false, kind: 'timeout', message: 'No answer within 10 seconds.', transient: true },
  );
  await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced' });

  const start = Date.now();
  assert.equal(await t.run(start + 1000), 1);
  let [log] = await deliveries(t, id);
  assert.equal(log?.status, 'retrying');
  assert.equal(log?.attempts, 1);
  assert.equal(log?.responseCode, 503);
  assert.equal(log?.responseBody, 'try later');
  assert.match(log?.error ?? '', /503/);
  // Not due again right away: the backoff keeps it waiting.
  assert.equal(await t.run(start + 2000), 0);
  const [job] = await db.query("SELECT run_at FROM jobs WHERE queue = ? AND status = 'queued'", [
    WEBHOOK_QUEUE,
  ]);
  assert.ok(Number(job?.run_at) >= start + 5000, 'the first retry waits several seconds');

  assert.equal(await t.run(start + 60_000), 1);
  [log] = await deliveries(t, id);
  assert.equal(log?.status, 'retrying');
  assert.equal(log?.attempts, 2);
  assert.match(log?.error ?? '', /No answer/);

  assert.equal(await t.run(start + 10 * 60_000), 1);
  [log] = await deliveries(t, id);
  assert.equal(log?.status, 'success');
  assert.equal(log?.attempts, 3);
  assert.equal(log?.error, null);
  assert.equal(t.sent.length, 3);
  assert.equal(new Set(t.sent.map((s) => s.body)).size, 1, 'every attempt sends the same body');
  assert.equal(
    new Set(t.sent.map((s) => s.headers['x-mrm-delivery'])).size,
    1,
    'and carries the same delivery id',
  );
});

dbTest('a receiver that keeps failing ends as failed after the attempts are used', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create();
  t.reply.fallback = { ok: true, status: 500, body: 'no' };
  await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced' });
  let at = Date.now();
  for (let i = 0; i < 8; i++) {
    at += 2 * 3600_000;
    await t.run(at);
  }
  const [log] = await deliveries(t, body.webhook.id);
  assert.equal(log?.status, 'failed');
  assert.equal(log?.attempts, 5);
  assert.equal(t.sent.length, 5, 'no sixth attempt');
  const [job] = await db.query('SELECT status FROM jobs WHERE queue = ?', [WEBHOOK_QUEUE]);
  assert.equal(job?.status, 'failed');
});

dbTest(
  'an address that is not allowed fails at once with the real transport, and is not retried',
  async (db) => {
    const t = await bootHooks(db);
    const { body } = await t.create({ eventTypes: ['app.synced'] });
    // The real transport is what refuses (the fake would send anywhere): the name now points inside.
    const strict = createWebhookHandler({
      db,
      masterKey,
      now: Date.now,
      resolve: async () => [{ address: '169.254.169.254', family: 4 }],
      send: realSend,
    });
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced' });
    const job = await claimNext(db, Date.now() + 1000);
    assert.ok(job);
    await strict(job.payload, job); // does not throw: nothing to retry
    await completeJob(db, job);
    const [log] = await deliveries(t, body.webhook.id);
    assert.equal(log?.status, 'failed');
    assert.match(log?.error ?? '', /not allowed/);
    assert.equal(t.sent.length, 0);
  },
);

dbTest('the delivery log is paged, newest first, and shows no secret', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create({ eventTypes: ['app.synced'] });
  const id = body.webhook.id as string;
  // A receiver that echoes the signing secret back in its answer.
  t.reply.fallback = { ok: true, status: 200, body: `got it, secret ${body.secret}\u0000` };
  for (let i = 0; i < 3; i++)
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { i } });
  await t.run();
  const all = await deliveries(t, id);
  assert.equal(all.length, 3);
  const times = all.map((d) => d.createdAt);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  assert.equal(all[0]?.responseBody, 'got it, secret [redacted]');
  assert.equal(JSON.stringify(all).includes(body.secret), false);
  assert.equal((await deliveries(t, id, '?limit=2')).length, 2);
  for (const bad of ['?limit=0', '?limit=101', '?limit=abc', '?limit=1.5']) {
    assert.equal(
      (await t.call(t.owner, 'GET', `/webhooks/${id}/deliveries${bad}`)).status,
      400,
      bad,
    );
  }
  assert.equal((await t.call(t.owner, 'GET', '/webhooks/nope/deliveries')).status, 404);
});

dbTest(
  'a disabled webhook, or a secret that cannot be read, fails the delivery without sending',
  async (db) => {
    const t = await bootHooks(db);
    const { body } = await t.create({ eventTypes: ['app.synced'] });
    const id = body.webhook.id as string;
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 1 } });
    await t.call(t.owner, 'PATCH', `/webhooks/${id}`, { enabled: false });
    await t.run();
    let log = (await deliveries(t, id))[0];
    assert.equal(log?.status, 'failed');
    assert.match(log?.error ?? '', /disabled/);

    await t.call(t.owner, 'PATCH', `/webhooks/${id}`, { enabled: true });
    await db.execute('UPDATE webhook_endpoints SET ciphertext = ? WHERE id = ?', ['garbage', id]);
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 2 } });
    await t.run();
    // Two deliveries can share a timestamp: look for the one about the secret, not at a position.
    log = (await deliveries(t, id)).find((d) => /Rotate/.test(d.error ?? ''));
    assert.equal(log?.status, 'failed');
    assert.match(log?.error ?? '', /Rotate/);
    assert.equal(t.sent.length, 0);
    // Rotating repairs it.
    await t.call(t.owner, 'POST', `/webhooks/${id}/rotate-secret`);
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 3 } });
    await t.run();
    assert.equal(t.sent.length, 1);
  },
);

dbTest('a test event goes through the same path, and says it is a test', async (db) => {
  const t = await bootHooks(db);
  const { body } = await t.create({ eventTypes: ['changeset.applied'] });
  const id = body.webhook.id as string;
  const res = await t.call(t.owner, 'POST', `/webhooks/${id}/test`);
  assert.equal(res.status, 202);
  assert.match(res.body.deliveryId, /^[0-9a-f-]{36}$/);
  assert.equal((await t.call(t.owner, 'POST', '/webhooks/nope/test')).status, 404);
  await t.run();
  const hit = t.sent[0];
  assert.equal(hit?.headers['x-mrm-event'], 'webhook.test');
  const parsed = JSON.parse(hit?.body ?? '{}');
  assert.equal(parsed.type, 'webhook.test');
  assert.equal(parsed.id, null);
  assert.equal(parsed.workspaceId, t.workspaceId);
  assert.equal(
    hit?.headers['x-mrm-signature'],
    `v1=${signWebhook(body.secret, hit?.headers['x-mrm-timestamp'] ?? '', hit?.body ?? '')}`,
  );
  const [log] = await deliveries(t, id);
  assert.equal(log?.eventType, 'webhook.test');
  assert.equal(log?.eventId, null);
  assert.equal(log?.status, 'success');
  assert.ok((await t.auditActions()).some((a) => a.action === 'webhook.test' && a.targetId === id));
  // A test is not an event: the feed does not show it.
  assert.deepEqual((await t.call(t.owner, 'GET', '/events?since=0')).body.events, []);
});

dbTest(
  'redelivery sends the same body again as a new delivery that points at the first',
  async (db) => {
    const t = await bootHooks(db);
    const { body } = await t.create({ eventTypes: ['app.synced'] });
    const id = body.webhook.id as string;
    t.reply.next.push({ ok: true, status: 500, body: 'oops' });
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 7 } });
    await t.run(Date.now() + 1000);
    const [first] = await deliveries(t, id);
    assert.ok(first);
    const res = await t.call(t.owner, 'POST', `/webhooks/${id}/deliveries/${first.id}/redeliver`);
    assert.equal(res.status, 202);
    await t.run(Date.now() + 2000);
    const again = (await deliveries(t, id)).find((d) => d.id === res.body.deliveryId);
    assert.equal(again?.redeliveryOf, first.id);
    assert.equal(again?.status, 'success');
    assert.equal(again?.eventId, first.eventId);
    const bodies = t.sent.map((s) => s.body);
    assert.equal(bodies[0], bodies.at(-1));
    // Redelivering a redelivery still points at the original.
    const third = await t.call(
      t.owner,
      'POST',
      `/webhooks/${id}/deliveries/${res.body.deliveryId}/redeliver`,
    );
    assert.equal(third.status, 202);
    await t.run(Date.now() + 3000);
    assert.equal(
      (await deliveries(t, id)).find((d) => d.id === third.body.deliveryId)?.redeliveryOf,
      first.id,
    );

    assert.equal(
      (await t.call(t.owner, 'POST', `/webhooks/${id}/deliveries/nope/redeliver`)).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/webhooks/nope/deliveries/${first.id}/redeliver`)).status,
      404,
    );
    const other = await t.create({ url: 'https://other.example.com/x' });
    const crossed = await t.call(
      t.owner,
      'POST',
      `/webhooks/${other.body.webhook.id}/deliveries/${first.id}/redeliver`,
    );
    assert.equal(crossed.status, 404, 'a delivery of another endpoint');
    const outsider = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
    assert.equal(
      (await t.call(outsider.cookie, 'POST', `/webhooks/${id}/deliveries/${first.id}/redeliver`))
        .status,
      404,
    );
    assert.equal(
      (
        await t.call(
          outsider.cookie,
          'POST',
          `/webhooks/${id}/deliveries/${first.id}/redeliver`,
          undefined,
          outsider.workspaceId,
        )
      ).status,
      404,
    );
  },
);

dbTest(
  'tests and redeliveries are rate limited per workspace, and an unknown id costs no slot',
  async (db) => {
    const t = await bootHooks(db);
    const { body } = await t.create();
    const id = body.webhook.id as string;
    for (let i = 0; i < 20; i++) await t.call(t.owner, 'POST', '/webhooks/nope/test');
    let accepted = 0;
    let limited: Awaited<ReturnType<Boot['call']>> | undefined;
    for (let i = 0; i < 12; i++) {
      const res = await t.call(t.owner, 'POST', `/webhooks/${id}/test`);
      if (res.status === 202) accepted++;
      else limited ??= res;
    }
    assert.equal(accepted, 10);
    assert.equal(limited?.status, 429);
    assert.equal(limited?.body.error, 'rate_limited');
    assert.ok(Number(limited?.headers.get('retry-after')) > 0);
  },
);

test('signWebhook is HMAC-SHA256 over "<timestamp>.<body>" as hex', () => {
  assert.equal(
    signWebhook('whsec_test', 1700000000, '{"a":1}'),
    signWebhook('whsec_test', '1700000000', '{"a":1}'),
  );
  assert.match(signWebhook('whsec_test', 1, 'x'), /^[0-9a-f]{64}$/);
  assert.notEqual(signWebhook('whsec_test', 1, 'x'), signWebhook('whsec_test', 2, 'x'));
  assert.notEqual(signWebhook('whsec_test', 1, 'x'), signWebhook('whsec_other', 1, 'x'));
  assert.notEqual(signWebhook('whsec_test', 1, 'x'), signWebhook('whsec_test', 1, 'y'));
  assert.notEqual(
    signWebhook('whsec_test', 11, 'x'),
    signWebhook('whsec_test', 1, '1x'),
    'the dot separates them',
  );
});
