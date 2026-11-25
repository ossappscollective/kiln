import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { claimNext, completeJob } from '../../jobs.ts';
import type { SendResult } from '../../services/webhook-transport.ts';
import { seedWorkspace } from '../../testkit.ts';
import { bootAlerts } from '../alerts/test-helpers.ts';
import { createChatDeliveryHandler } from './delivery.ts';
import { CHAT_QUEUE } from './destinations.ts';
import { sendDueChatDigests } from './digest.ts';

const SLACK = 'https://hooks.slack.com/services/T000/B000/SECRETabcd';
const TEAMS =
  'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=TEAMSsecret9';

type Sent = { url: string; body: string; headers: Record<string, string> };

/** An app with chat: a fake transport that records what would be sent, a clock the tests move, and a runner for the chat jobs. */
async function bootChat(db: Database, overrides: Record<string, unknown> = {}) {
  const masterKey = randomBytes(32);
  const sent: Sent[] = [];
  const script: SendResult[] = [];
  let clock = Date.now();
  const send = async (
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<SendResult> => {
    sent.push({ url, body, headers });
    return script.shift() ?? { ok: true, status: 200, body: 'ok' };
  };
  const t = await bootAlerts(db, {
    masterKey,
    publicOrigin: 'https://kiln.example.com',
    chat: { send },
    ...overrides,
  });
  const handler = createChatDeliveryHandler({
    db,
    masterKey,
    now: () => clock,
    send,
    maxAttempts: 5,
  });
  const at = (ms: number) => {
    clock = ms;
  };
  /** Runs the chat jobs due at `when`, the way the worker does. */
  const run = async (when = clock) => {
    clock = when;
    let ran = 0;
    for (let job = await claimNext(db, when); job; job = await claimNext(db, when)) {
      if (job.queue !== CHAT_QUEUE) continue;
      ran++;
      await handler(job.payload, job);
      await completeJob(db, job);
    }
    return ran;
  };
  const create = async (body: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'POST', '/chat/destinations', {
      provider: 'slack',
      name: 'Releases',
      url: SLACK,
      ...body,
    });
  const deliveries = (where = '1 = 1') =>
    db.query(`SELECT * FROM chat_deliveries WHERE ${where} ORDER BY created_at, id`);
  const approved = (appId: string) =>
    t.emit(
      'app.release.status_changed',
      { version: '2.0', track: '', build: '7', from: 'in_review', to: 'approved' },
      appId,
    );
  return { ...t, masterKey, sent, script, at, run, create, deliveries, approved, now: () => clock };
}

dbTest(
  'a destination is created with the default rules, and the webhook URL is never returned, logged or audited',
  async (db) => {
    const t = await bootChat(db);
    const made = await t.create();
    assert.equal(made.status, 201);
    const d = made.body.destination;
    assert.equal(d.provider, 'slack');
    assert.equal(d.urlHint, 'abcd');
    assert.equal(d.locale, 'en');
    assert.equal(d.allowAnyHost, false);
    assert.equal(d.routes.length, 2, 'every critical alert, and the release events');
    assert.deepEqual(d.routes[0].alertTypes, ['*']);
    assert.equal(d.routes[0].minSeverity, 'critical');
    assert.ok(d.routes[1].alertTypes.includes('release.approved'));
    assert.equal(d.routes[1].minSeverity, 'info');

    const listed = await t.call(t.owner, 'GET', '/chat/destinations');
    assert.equal(listed.status, 200);
    const one = await t.call(t.owner, 'GET', `/chat/destinations/${d.id}`);
    assert.equal(one.body.destination.urlHint, 'abcd');
    await t
      .call(t.owner, 'PATCH', `/chat/destinations/${d.id}`, {
        name: 'Release room',
        url: TEAMS.replace('logic.azure.com', 'logic.azure.com'),
      })
      .then((r) =>
        assert.equal(r.status, 400, 'a Teams address on a Slack destination is refused'),
      );
    const patched = await t.call(t.owner, 'PATCH', `/chat/destinations/${d.id}`, {
      name: 'Release room',
      url: `${SLACK}wxyz`,
    });
    assert.equal(patched.body.destination.urlHint, 'wxyz');

    const [row] = await db.query(
      'SELECT ciphertext, url_hint FROM chat_destinations WHERE id = ?',
      [d.id],
    );
    assert.ok(!String(row?.ciphertext).includes('SECRET'), 'stored encrypted');
    assert.ok(!String(row?.ciphertext).includes('hooks.slack.com'));
    await t.call(t.owner, 'POST', `/chat/destinations/${d.id}/test`);
    await t.run(Date.now() + 5000);
    const everything = [
      ...t.texts,
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
      JSON.stringify(await t.deliveries()),
    ].join('\n');
    assert.ok(!everything.includes('SECRETabcd'), 'the secret part of the URL appears nowhere');
    assert.ok(!everything.includes('services/T000'));
    const audit = await db.query(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'chat.%' ORDER BY created_at",
    );
    assert.deepEqual(
      audit.map((a) => a.action),
      ['chat.destination.create', 'chat.destination.update', 'chat.destination.test'],
    );
    assert.ok(String(audit[0]?.detail).includes('abcd'));
    const removed = await t.call(t.owner, 'DELETE', `/chat/destinations/${d.id}`);
    assert.equal(removed.status, 204);
    assert.equal((await t.call(t.owner, 'GET', `/chat/destinations/${d.id}`)).status, 404);
    assert.equal((await db.query('SELECT * FROM chat_routes')).length, 0);
    assert.equal((await db.query('SELECT * FROM chat_deliveries')).length, 0);
    assert.ok(
      (await db.query("SELECT 1 FROM audit_events WHERE action = 'chat.destination.delete'"))
        .length === 1,
    );
  },
);

dbTest(
  'only owners and admins see or change destinations; tokens and strangers cannot',
  async (db) => {
    const t = await bootChat(db);
    const made = await t.create();
    const id = made.body.destination.id as string;
    for (const role of ['member', 'viewer'] as const) {
      const cookie = await t.addMember(role);
      assert.equal((await t.call(cookie, 'GET', '/chat/destinations')).status, 403, role);
      assert.equal(
        (await t.call(cookie, 'GET', `/chat/destinations/${id}/deliveries`)).status,
        403,
        role,
      );
      assert.equal((await t.create({}, cookie)).status, 403, role);
      assert.equal((await t.call(cookie, 'DELETE', `/chat/destinations/${id}`)).status, 403, role);
      assert.equal(
        (await t.call(cookie, 'POST', `/chat/destinations/${id}/test`)).status,
        403,
        role,
      );
    }
    const admin = await t.addMember('admin');
    assert.equal((await t.call(admin, 'GET', '/chat/destinations')).status, 200);
    // A token can never hold the right, whatever its role.
    const token = (await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin' })).body
      .token as string;
    const viaToken = await t.app.request(`/api/workspaces/${t.workspaceId}/chat/destinations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(viaToken.status, 403);
    assert.equal(
      (await t.app.request(`/api/workspaces/${t.workspaceId}/chat/destinations`)).status,
      401,
    );
    const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
    assert.equal((await t.call(other.cookie, 'GET', '/chat/destinations')).status, 404);
    assert.equal(
      (await t.call(other.cookie, 'GET', `/chat/destinations/${id}`, undefined, other.workspaceId))
        .status,
      404,
      'not visible from another workspace',
    );
  },
);

dbTest(
  'the address: https, the providers hosts unless the admin allows others, never a private address',
  async (db) => {
    const t = await bootChat(db);
    const bad = await t.create({ url: 'https://example.com/hook' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'host_not_allowed');
    assert.equal(bad.body.code, 'chat.hostNotAllowed');
    assert.ok(bad.body.params.hosts.includes('hooks.slack.com'));
    assert.equal(
      (await t.create({ url: 'http://hooks.slack.com/services/a' })).body.error,
      'invalid_url',
    );
    assert.equal(
      (await t.create({ url: 'https://user:pw@hooks.slack.com/services/a' })).body.error,
      'invalid_url',
    );
    assert.equal((await t.create({ url: 'not a url' })).body.code, 'chat.urlInvalid');
    assert.equal(
      (await t.create({ provider: 'teams', url: SLACK })).status,
      400,
      'a Slack address is not a Teams address',
    );
    assert.equal((await t.create({ provider: 'teams', name: 'Teams', url: TEAMS })).status, 201);
    const own = await t.create({ url: 'https://chat.corp.example.com/hook', allowAnyHost: true });
    assert.equal(own.status, 201, 'the admin chose to allow another host');
    assert.equal(own.body.destination.allowAnyHost, true);
    for (const url of [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest',
      'https://localhost/hook',
      'https://[::1]/hook',
    ]) {
      const refused = await t.create({ url, allowAnyHost: true });
      assert.equal(refused.status, 400, url);
      assert.equal(refused.body.error, 'invalid_url', url);
    }
    assert.equal((await t.create({ name: '' })).status, 400);
    assert.equal((await t.create({ locale: 'xx' })).status, 400);
    assert.equal((await t.create({ routes: [{ alertTypes: ['nope'] }] })).status, 400);
  },
);

dbTest(
  'an alert reaches the destinations whose rules take it, in their language, once, with a link to Kiln',
  async (db) => {
    const t = await bootChat(db);
    const app = await t.addApp('app1', 'Moon Diary');
    const fr = (await t.create({ name: 'FR', locale: 'fr' })).body.destination;
    const teams = (await t.create({ name: 'Teams', provider: 'teams', url: TEAMS, locale: 'de' }))
      .body.destination;
    const other = (
      await t.create({
        name: 'Other app',
        routes: [{ alertTypes: ['*'], appIds: ['someone-else'] }],
      })
    ).body.destination;
    const off = (await t.create({ name: 'Off', enabled: false })).body.destination;
    await t.rejected(app);
    await t.rejected(app); // the same alert again: collapsed by the alert system, no second message
    assert.equal(
      (await t.deliveries()).length,
      2,
      'FR and Teams only: not the other app, not the disabled one',
    );
    const forFr = await t.deliveries('destination_id = ?'.replace('?', `'${fr.id}'`));
    assert.equal(forFr.length, 1);
    assert.equal(forFr[0]?.status, 'queued');
    const frBody = JSON.parse(String(forFr[0]?.payload));
    assert.ok(JSON.stringify(frBody).includes('Moon Diary'));
    assert.ok(JSON.stringify(frBody).includes('Que faire'), 'French frame');
    assert.ok(
      JSON.stringify(frBody).includes('https://kiln.example.com/#/portfolio/app1/releases'),
    );
    const forTeams = JSON.parse(
      String((await t.deliveries(`destination_id = '${teams.id}'`))[0]?.payload),
    );
    assert.equal(forTeams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.ok(JSON.stringify(forTeams).includes('Was zu tun ist'), 'German frame');
    assert.equal((await t.deliveries(`destination_id IN ('${other.id}', '${off.id}')`)).length, 0);

    assert.equal(await t.run(Date.now() + 10_000), 2);
    assert.equal(t.sent.length, 2);
    const slackCall = t.sent.find((s) => s.url === SLACK);
    assert.ok(slackCall, 'the stored address is decrypted for the send');
    assert.equal(slackCall?.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(slackCall?.body ?? '{}').attachments[0].blocks[0].type, 'header');
    assert.ok(t.sent.some((s) => s.url === TEAMS));
    const done = await t.deliveries();
    assert.ok(
      done.every((r) => r.status === 'sent' && r.outcome === 'ok' && Number(r.http_status) === 200),
    );
    assert.equal((await t.alerts()).length, 1);
  },
);

dbTest(
  'the release events default: info alerts reach the destination, other info alerts do not; routes can be replaced',
  async (db) => {
    const t = await bootChat(db);
    const app = await t.addApp();
    const d = (await t.create()).body.destination;
    await t.approved(app); // release.approved: info, a release event
    await t.emit('review.new', { appId: app, store: 'appstoreconnect', rating: 5, count: 1 }, app); // info, not a release type
    const types = async () => (await t.deliveries()).map((r) => String(r.alert_id));
    assert.equal((await types()).length, 1);
    const replaced = await t.call(t.owner, 'PUT', `/chat/destinations/${d.id}/routes`, {
      routes: [
        { alertTypes: ['release.approved'], minSeverity: 'critical' },
        { alertTypes: ['release.rejected'], platforms: ['android'] },
      ],
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.destination.routes.length, 2);
    await t.approved(app); // collapsed (same key); use another version for a new alert
    await t.emit(
      'app.release.status_changed',
      { version: '3.0', track: '', build: '8', from: 'in_review', to: 'approved' },
      app,
    );
    assert.equal((await t.deliveries()).length, 1, 'approved is info, the rule wants critical');
    await t.rejected(app); // ios app, the rule wants android
    assert.equal((await t.deliveries()).length, 1);
    assert.equal(
      (await t.call(t.owner, 'PUT', `/chat/destinations/nope/routes`, { routes: [] })).status,
      404,
    );
  },
);

dbTest(
  'a daily summary holds what is below critical, sends critical at once, and is one message at the hour',
  async (db) => {
    const t = await bootChat(db);
    const app = await t.addApp('app1', 'Moon Diary');
    const d = (await t.create({ digest: 'daily', digestHour: 8, timezone: 'UTC', locale: 'es' }))
      .body.destination;
    const day = Date.UTC(2030, 0, 10);
    t.at(day);
    await t.emit(
      'app.release.status_changed',
      { version: '2.0', track: '', build: '7', from: 'in_review', to: 'approved' },
      app,
      day + 60_000,
    );
    await t.emit(
      'app.release.status_changed',
      { version: '2.1', track: '', build: '8', from: 'in_review', to: 'rejected' },
      app,
      day + 120_000,
    );
    const rows = await t.deliveries();
    assert.deepEqual(
      rows.map((r) => [r.status, r.outcome]),
      [
        ['deferred', 'in_digest'],
        ['queued', 'queued'],
      ],
    );
    assert.equal(rows[0]?.payload, null);
    // Not yet 08:00 UTC the same day, so nothing is due; the destination counts from its last digest.
    assert.deepEqual(
      await sendDueChatDigests(db, day + 3 * 3_600_000),
      { due: 0, sent: 0 },
      'first the summary of the day before',
    );
    await db.execute('UPDATE chat_destinations SET last_digest_at = ? WHERE id = ?', [
      day - 86_400_000,
      d.id,
    ]);
    assert.deepEqual(
      await sendDueChatDigests(db, day + 3 * 3_600_000),
      { due: 0, sent: 0 },
      'before the hour',
    );
    assert.deepEqual(await sendDueChatDigests(db, day + 9 * 3_600_000), { due: 1, sent: 1 });
    assert.deepEqual(
      await sendDueChatDigests(db, day + 9 * 3_600_000 + 1000),
      { due: 0, sent: 0 },
      'once a day',
    );
    const after = await t.deliveries();
    assert.equal(after.filter((r) => r.kind === 'digest').length, 1);
    assert.equal(after.find((r) => r.outcome === 'digest_sent')?.status, 'sent');
    const digest = JSON.parse(String(after.find((r) => r.kind === 'digest')?.payload));
    assert.ok(JSON.stringify(digest).includes('Resumen de alertas'));
    assert.ok(
      JSON.stringify(digest).includes('https://kiln.example.com/#/portfolio/app1/releases'),
    );
    await t.run(day + 9 * 3_600_000);
    await t.run(day + 9 * 3_600_000 + 1000); // paced: one message a second
    assert.equal(t.sent.length, 2, 'the critical alert and the summary');
    const second = await sendDueChatDigests(db, day + 33 * 3_600_000);
    assert.deepEqual(second, { due: 1, sent: 0 }, 'a day with nothing collected sends nothing');
  },
);

dbTest(
  'delivery: 429 waits for Retry-After, 5xx backs off, a gone webhook fails at once, and the log keeps codes only',
  async (db) => {
    const t = await bootChat(db);
    const app = await t.addApp();
    const d = (await t.create()).body.destination;
    await t.rejected(app);
    const base = Date.now() + 10_000;
    t.script.push({ ok: true, status: 429, body: 'rate limited: SECRETabcd', retryAfter: '30' });
    assert.equal(await t.run(base), 1);
    let [row] = await t.deliveries();
    assert.equal(row?.status, 'retrying');
    assert.equal(row?.outcome, 'rate_limited');
    assert.equal(Number(row?.http_status), 429);
    assert.equal(Number(row?.attempts), 1);
    assert.equal(await t.run(base + 29_000), 0, 'not before Retry-After');
    t.script.push({ ok: true, status: 503, body: '' });
    assert.equal(await t.run(base + 30_000), 1);
    [row] = await t.deliveries();
    assert.equal(row?.outcome, 'server_error');
    assert.equal(Number(row?.attempts), 2);
    assert.equal(await t.run(base + 30_000 + 9_000), 0, 'second backoff is 10 s');
    assert.equal(await t.run(base + 30_000 + 10_000), 1);
    [row] = await t.deliveries();
    assert.equal(row?.status, 'sent');
    assert.equal(row?.outcome, 'ok');
    assert.equal(Number(row?.attempts), 3);
    assert.ok(!JSON.stringify(row).includes('SECRET'), 'nothing the provider said is stored');

    await t.rejected(await t.addApp('app2', 'Other'));
    t.script.push({ ok: true, status: 404, body: 'no_service' });
    await t.run(base + 100_000);
    const gone = (await t.deliveries()).at(-1);
    assert.equal(gone?.status, 'failed');
    assert.equal(gone?.outcome, 'webhook_gone');
    assert.equal(Number(gone?.attempts), 1, 'not retried');
    const log = await t.call(t.owner, 'GET', `/chat/destinations/${d.id}/deliveries?limit=5`);
    assert.equal(log.status, 200);
    assert.equal(log.body.deliveries.length, 2);
    assert.ok(!('payload' in log.body.deliveries[0]));
    assert.equal(
      log.body.deliveries[0].title === null || typeof log.body.deliveries[0].title === 'string',
      true,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/chat/destinations/${d.id}/deliveries?limit=0`)).status,
      400,
    );
  },
);

dbTest('delivery gives up after five attempts', async (db) => {
  const t = await bootChat(db);
  const app = await t.addApp();
  await t.create();
  await t.rejected(app);
  let when = Date.now() + 10_000;
  for (let i = 0; i < 5; i++) {
    t.script.push({ ok: false, kind: 'timeout', message: 'No answer', transient: true });
    await t.run(when);
    when += 3_600_000;
  }
  const [row] = await t.deliveries();
  assert.equal(row?.status, 'failed');
  assert.equal(row?.outcome, 'timeout');
  assert.equal(Number(row?.attempts), 5);
});

dbTest(
  'pacing: a second message for the same destination waits one second without costing an attempt',
  async (db) => {
    const t = await bootChat(db);
    const a1 = await t.addApp('a1', 'One');
    const a2 = await t.addApp('a2', 'Two');
    await t.create();
    await t.rejected(a1);
    await t.rejected(a2);
    const base = Date.now() + 10_000;
    assert.equal(await t.run(base), 2);
    assert.equal(t.sent.length, 1, 'one message in this second');
    const rows = await t.deliveries();
    assert.deepEqual(rows.map((r) => r.status).sort(), ['queued', 'sent']);
    assert.equal(Number(rows.find((r) => r.status === 'queued')?.attempts), 0);
    assert.equal(await t.run(base + 1000), 1);
    assert.equal(t.sent.length, 2);
    assert.ok((await t.deliveries()).every((r) => r.status === 'sent'));
  },
);

dbTest(
  'SSRF: the real transport refuses a name that resolves inside the network, and the log says so',
  async (db) => {
    const masterKey = randomBytes(32);
    const t = await bootAlerts(db, { masterKey, publicOrigin: 'https://kiln.example.com' });
    const app = await t.addApp();
    const made = await t.call(t.owner, 'POST', '/chat/destinations', {
      provider: 'slack',
      name: 'S',
      url: SLACK,
    });
    const id = made.body.destination.id as string;
    await t.rejected(app);
    const { sendPinned } = await import('../../services/webhook-transport.ts');
    const resolved: string[] = [];
    const handler = createChatDeliveryHandler({
      db,
      masterKey,
      now: Date.now,
      send: (url, body, headers, options) => {
        resolved.push(url);
        return sendPinned(url, body, headers, {
          ...options,
          resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        });
      },
    });
    for (
      let job = await claimNext(db, Date.now() + 5000);
      job;
      job = await claimNext(db, Date.now() + 5000)
    ) {
      if (job.queue !== CHAT_QUEUE) continue;
      await handler(job.payload, job);
      await completeJob(db, job);
    }
    const [row] = await db.query(
      'SELECT status, outcome, attempts FROM chat_deliveries WHERE destination_id = ?',
      [id],
    );
    assert.equal(resolved.length, 1);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.outcome, 'blocked_address');

    // Switching the allowance off after the fact: a stored address outside the provider's hosts is refused at send time too.
    await db.execute('UPDATE chat_destinations SET allow_any_host = 0 WHERE id = ?', [id]);
    const { encryptSecret } = await import('@kiln/vault');
    const { chatAad } = await import('./destinations.ts');
    await db.execute('UPDATE chat_destinations SET ciphertext = ? WHERE id = ?', [
      encryptSecret('https://example.com/hook', masterKey, chatAad(t.workspaceId, id)),
      id,
    ]);
    await t.rejected(await t.addApp('app9', 'Nine'));
    for (
      let job = await claimNext(db, Date.now() + 5000);
      job;
      job = await claimNext(db, Date.now() + 5000)
    ) {
      if (job.queue !== CHAT_QUEUE) continue;
      await handler(job.payload, job);
      await completeJob(db, job);
    }
    const last = (
      await db.query(
        'SELECT outcome FROM chat_deliveries ORDER BY created_at DESC, id DESC LIMIT 1',
      )
    )[0];
    assert.equal(last?.outcome, 'host_not_allowed');
    assert.equal(resolved.length, 1, 'nothing was sent to the refused host');
  },
);

dbTest(
  'the test message: queued through the same path, even from a disabled destination, rate limited, 404 for strangers',
  async (db) => {
    const t = await bootChat(db);
    const d = (await t.create({ locale: 'de', enabled: false })).body.destination;
    const queued = await t.call(t.owner, 'POST', `/chat/destinations/${d.id}/test`);
    assert.equal(queued.status, 202);
    assert.ok(queued.body.deliveryId);
    assert.equal(await t.run(Date.now() + 5000), 1);
    const [row] = await t.deliveries();
    assert.equal(row?.kind, 'test');
    assert.equal(row?.status, 'sent');
    assert.ok(String(row?.payload).includes('Kiln-Testnachricht'));
    assert.equal((await t.call(t.owner, 'POST', `/chat/destinations/nope/test`)).status, 404);
    let limited = 0;
    for (let i = 0; i < 12; i++)
      if ((await t.call(t.owner, 'POST', `/chat/destinations/${d.id}/test`)).status === 429)
        limited++;
    assert.ok(limited > 0, 'the per-workspace budget applies');
    // Disabled destinations get no alerts, only tests.
    const app = await t.addApp();
    await t.rejected(app);
    assert.equal((await t.deliveries("kind = 'alert'")).length, 0);
  },
);

dbTest('limits: at most 20 destinations and 20 rules per destination', async (db) => {
  const t = await bootChat(db);
  for (let i = 0; i < 20; i++) assert.equal((await t.create({ name: `D${i}` })).status, 201);
  const over = await t.create({ name: 'one too many' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'chat.tooManyDestinations');
  const d = (await t.call(t.owner, 'GET', '/chat/destinations')).body.destinations[0];
  const many = Array.from({ length: 21 }, () => ({ alertTypes: ['*'] }));
  assert.equal(
    (await t.call(t.owner, 'PUT', `/chat/destinations/${d.id}/routes`, { routes: many })).status,
    400,
  );
});
