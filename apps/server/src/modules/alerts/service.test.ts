import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dbTest } from '@mrm/db/testing';
import { bootAlerts } from './test-helpers.ts';
import { sendDueDigests } from './digest.ts';
import { deliveryOutcomes } from './service.ts';
import type { Resolver, SendResult, sendPinned } from '../../services/webhook-transport.ts';

const T0 = Date.UTC(2026, 0, 5, 12, 0); // a Monday at noon UTC
const settings = (
  t: Awaited<ReturnType<typeof bootAlerts>>,
  cookie: string,
  body: Record<string, unknown>,
) => t.call(cookie, 'PUT', '/alerts/settings', body);

dbTest(
  'an event raises an alert: an inbox row, a queued email, and the log says what happened on each channel',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    await t.rejected(app, '2.0', T0);
    const [alert] = await t.alerts();
    assert.equal(alert?.type, 'release.rejected');
    assert.equal(alert?.severity, 'critical');
    assert.equal(alert?.title, 'Moon Diary 2.0 was rejected in store review');
    assert.equal(Number(alert?.count), 1);
    assert.equal((await t.inbox()).length, 1);
    const rows = await t.log();
    const by = (channel: string) => rows.find((r) => r.channel === channel);
    assert.equal(by('in_app')?.status, 'sent');
    assert.equal(by('desktop')?.outcome, 'queued_for_client');
    assert.equal(by('email')?.status, 'queued');
    assert.equal(
      by('webhook')?.outcome,
      'no_endpoint',
      'the rule says webhook, but no endpoint is configured',
    );
    assert.equal(await t.runMail(), 1);
    assert.equal(t.mail.sent.length, 1);
    assert.equal(t.mail.sent[0]?.to, 'ada@example.com');
    assert.match(String(t.mail.sent[0]?.subject), /^\[critical\] Moon Diary 2\.0 was rejected/);
    assert.doesNotMatch(String(t.mail.sent[0]?.text), /undefined/);
    assert.equal((await t.log("channel = 'email'"))[0]?.outcome, 'ok');
    // With no webhook listening, the alert is not written into the event log as well (the webhook test below covers the event).
    const events = await t.call(t.owner, 'GET', '/events?type=alert.raised');
    assert.equal(events.body.events.length, 0);
  },
);

dbTest(
  'repeats collapse into one alert with a count, and a different subject is a new alert',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    await t.rejected(app, '2.0', T0);
    await t.rejected(app, '2.0', T0 + 60_000);
    await t.rejected(app, '2.0', T0 + 120_000);
    let alerts = await t.alerts();
    assert.equal(alerts.length, 1);
    assert.equal(Number(alerts[0]?.count), 3);
    assert.equal((await t.inbox()).length, 1, 'one inbox row');
    assert.equal(await t.runMail(), 1, 'one email, not three');
    await t.rejected(app, '2.1', T0 + 180_000);
    alerts = await t.alerts();
    assert.equal(alerts.length, 2);
    // After the window the same key is news again.
    await t.rejected(app, '2.0', T0 + 8 * 24 * 3_600_000);
    assert.equal((await t.alerts()).length, 3);
  },
);

dbTest('a workspace is capped per alert type and hour; the rest are only counted', async (db) => {
  const t = await bootAlerts(db);
  const app = await t.addApp();
  assert.equal(
    (await t.call(t.owner, 'PUT', '/alerts/rules/release.rejected', { maxPerHour: 2 })).status,
    200,
  );
  for (let i = 0; i < 5; i++) await t.rejected(app, `3.${i}`, T0 + i * 1000);
  const alerts = await t.alerts();
  assert.equal(alerts.length, 2, 'two alerts, then throttled');
  assert.equal(Number(alerts[1]?.count), 4, 'the newest one counts the three it held back');
  assert.equal((await t.inbox()).length, 2);
  // An hour later the cap is free again.
  await t.rejected(app, '4.0', T0 + 2 * 3_600_000);
  assert.equal((await t.alerts()).length, 3);
});

dbTest(
  'a rule that is switched off raises nothing; a different channel set changes who is told how',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    assert.equal(
      (await t.call(t.owner, 'PUT', '/alerts/rules/release.rejected', { enabled: false })).status,
      200,
    );
    await t.rejected(app, '2.0', T0);
    assert.equal((await t.alerts()).length, 0);
    assert.equal(
      (
        await t.call(t.owner, 'PUT', '/alerts/rules/release.rejected', {
          enabled: true,
          channels: ['in_app'],
        })
      ).status,
      200,
    );
    await t.rejected(app, '2.1', T0);
    assert.equal((await t.log("channel = 'email'")).length, 0);
    assert.equal((await t.inbox()).length, 1);
    assert.equal(
      (await t.call(t.owner, 'DELETE', '/alerts/rules/release.rejected')).body.rule.custom,
      false,
    );
  },
);

dbTest("a person's own channels win over the workspace rule, per app first", async (db) => {
  const t = await bootAlerts(db);
  const a = await t.addApp('a1', 'Alpha');
  const b = await t.addApp('b1', 'Beta');
  // Mail for every app, but not for Beta.
  assert.equal(
    (
      await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', {
        channels: ['in_app', 'email'],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', {
        appId: b,
        channels: ['in_app'],
      })
    ).status,
    200,
  );
  await t.emit('review.new_low_rating', { reviewId: 'r1', rating: 1, store: 'appstore' }, a, T0);
  await t.emit(
    'review.new_low_rating',
    { reviewId: 'r2', rating: 2, store: 'appstore' },
    b,
    T0 + 1000,
  );
  const emails = await t.log("channel = 'email'");
  assert.equal(emails.length, 1);
  const forAlpha = await db.query("SELECT id FROM alerts WHERE app_id = 'a1'");
  assert.equal(String(emails[0]?.alert_id), String(forAlpha[0]?.id));
  // Removing the choice brings the workspace rule back; desktop pulls the inbox in with it.
  await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', { channels: ['desktop'] });
  const prefs = (await t.call(t.owner, 'GET', '/alerts/settings')).body.preferences;
  assert.deepEqual(prefs.find((p: { appId: string | null }) => p.appId === null).channels, [
    'in_app',
    'desktop',
  ]);
});

dbTest(
  'quiet hours hold mail and desktop notifications, but never a critical alert',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    assert.equal(
      (
        await settings(t, t.owner, {
          quietStart: 22 * 60,
          quietEnd: 7 * 60,
          timezone: 'Europe/Paris',
        })
      ).status,
      200,
    );
    await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', {
      channels: ['desktop', 'email'],
    });
    const night = Date.UTC(2026, 0, 5, 21, 30); // 22:30 in Paris
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r1', rating: 1, store: 'appstore' },
      app,
      night,
    );
    let [inbox] = await t.inbox();
    assert.equal(Number(inbox?.desktop), 0, 'no desktop notification at night');
    const held = (await t.log("channel = 'email'"))[0];
    assert.equal(held?.status, 'deferred');
    assert.equal(held?.outcome, 'quiet_hours');
    assert.equal((await t.log("channel = 'desktop'"))[0]?.outcome, 'quiet_hours');
    // The job waits for the morning: nothing runs at night, the mail goes at 07:00 Paris (06:00 UTC).
    assert.equal(await t.runMail(night + 3_600_000), 0);
    assert.equal(await t.runMail(Date.UTC(2026, 0, 6, 6, 0, 1)), 1);
    assert.equal(t.mail.sent.length, 1);
    // Critical alerts ignore quiet hours.
    await t.rejected(app, '2.0', night);
    const critical = (await t.log("channel = 'email' AND status = 'queued'"))[0];
    assert.ok(critical);
    assert.equal(await t.runMail(night + 1000), 1);
    [inbox] = await db.query(
      "SELECT i.desktop FROM alert_inbox i JOIN alerts a ON a.id = i.alert_id WHERE a.type = 'release.rejected'",
    );
    assert.equal(Number(inbox?.desktop), 1);
  },
);

dbTest(
  'the lowest severity a person wants filters every channel, and the log says why',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    assert.equal((await settings(t, t.owner, { minSeverity: 'critical' })).status, 200);
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r1', rating: 1, store: 'appstore' },
      app,
      T0,
    );
    assert.equal((await t.inbox()).length, 0);
    assert.ok((await t.log("outcome = 'below_minimum_severity'")).length >= 1);
    await t.rejected(app, '2.0', T0);
    assert.equal((await t.inbox()).length, 1);
  },
);

dbTest(
  'mutes and snoozes silence an app or an alert type for one person until they end',
  async (db) => {
    const t = await bootAlerts(db);
    const a = await t.addApp('a1', 'Alpha');
    const b = await t.addApp('b1', 'Beta');
    const mute = await t.call(t.owner, 'POST', '/alerts/mutes', { appId: a });
    assert.equal(mute.status, 201);
    assert.equal(mute.body.mute.until, null);
    await t.rejected(a, '1.0', Date.now());
    await t.rejected(b, '1.0', Date.now());
    assert.equal((await t.inbox()).length, 1, 'only Beta got through');
    assert.ok((await t.log("outcome = 'muted'")).length >= 1);
    // A snooze of one alert type, an hour long, expires.
    await t.call(t.owner, 'POST', '/alerts/mutes', { alertType: 'review.low_rating', hours: 1 });
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r1', rating: 1, store: 'appstore' },
      b,
      Date.now(),
    );
    assert.equal((await t.inbox()).length, 1);
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r2', rating: 1, store: 'appstore' },
      b,
      Date.now() + 2 * 3_600_000,
    );
    assert.equal((await t.inbox()).length, 2, 'the snooze ended');
    const list = (await t.call(t.owner, 'GET', '/alerts/settings')).body.mutes;
    assert.ok(list.length >= 1);
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/alerts/mutes/${mute.body.mute.id}`)).status,
      204,
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/alerts/mutes/${mute.body.mute.id}`)).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', '/alerts/mutes', { alertType: 'nope' })).status,
      400,
    );
  },
);

dbTest(
  "a digest holds non-critical mail until the person's digest hour, and critical alerts still go at once",
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    await settings(t, t.owner, { digest: 'daily', digestHour: 8, timezone: 'UTC' });
    await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', {
      channels: ['in_app', 'email'],
    });
    const now = Date.now();
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r1', rating: 1, store: 'appstore' },
      app,
      now,
    );
    await t.emit(
      'review.new_low_rating',
      { reviewId: 'r2', rating: 2, store: 'appstore' },
      app,
      now + 1000,
    );
    await t.rejected(app, '2.0', now);
    assert.equal(await t.runMail(now + 5000), 1, 'only the critical alert was mailed');
    assert.equal((await t.log("outcome = 'in_digest'")).length, 2);
    // Turning the digest on counted from then, so nothing is due yet today; the next 08:00 is tomorrow.
    assert.deepEqual(await sendDueDigests(db, now + 1000), { due: 0, sent: 0 });
    const tomorrow =
      Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000 + 8 * 3_600_000 + 5 * 60_000;
    assert.deepEqual(await sendDueDigests(db, tomorrow), { due: 1, sent: 1 });
    assert.equal(await t.runMail(tomorrow + 1000), 1);
    const digest = t.mail.sent.at(-1);
    assert.match(String(digest?.subject), /^Alert digest: 2 alerts/);
    assert.equal((await t.log("outcome = 'digest_sent'")).length, 2);
    assert.deepEqual(
      await sendDueDigests(db, tomorrow + 3_600_000),
      { due: 0, sent: 0 },
      'once per day',
    );
  },
);

dbTest(
  'mail is retried with backoff when waiting can help, and is not when it cannot; the log never holds provider text',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    t.mail.script.push(
      { ok: false, code: 'smtp_timeout' },
      { ok: false, code: 'smtp_connection_failed' },
    );
    await t.rejected(app, '2.0', T0);
    const at = Date.now() + 1000;
    assert.equal(await t.runMail(at), 1);
    let row = (await t.log("channel = 'email'"))[0];
    assert.equal(row?.status, 'retrying');
    assert.equal(row?.outcome, 'smtp_timeout');
    const [job] = await db.query(
      "SELECT status, run_at, attempts FROM jobs WHERE queue = 'alert.deliver'",
    );
    assert.equal(job?.status, 'queued');
    assert.ok(Number(job?.run_at) >= at + 5000, 'the queue waited (backoff)');
    assert.equal(await t.runMail(at + 1000), 0, 'not yet');
    assert.equal(await t.runMail(at + 10_000), 1);
    assert.equal((await t.log("channel = 'email'"))[0]?.outcome, 'smtp_connection_failed');
    assert.equal(await t.runMail(at + 60_000), 1, 'third attempt succeeds');
    row = (await t.log("channel = 'email'"))[0];
    assert.equal(row?.status, 'sent');
    assert.equal(Number(row?.attempts), 3);
    // A failure waiting cannot fix is final at once.
    t.mail.script.push({ ok: false, code: 'smtp_auth_failed' });
    await t.rejected(app, '9.0', T0 + 1000);
    await t.runMail(at + 120_000);
    const final = (await t.log("channel = 'email'")).at(-1);
    assert.equal(final?.status, 'failed');
    assert.equal(final?.outcome, 'smtp_auth_failed');
    assert.equal((await db.query("SELECT status FROM jobs WHERE status = 'queued'")).length, 0);
    for (const r of await t.log())
      assert.ok(
        (deliveryOutcomes as readonly string[]).includes(String(r.outcome)),
        `outcome ${r.outcome} is in the vocabulary`,
      );
  },
);

dbTest('a mail that nobody set up is reported as such, not retried forever', async (db) => {
  const t = await bootAlerts(db);
  const app = await t.addApp();
  t.mail.script.push({ ok: false, code: 'smtp_not_configured' });
  await t.rejected(app, '2.0', T0);
  await t.runMail();
  const row = (await t.log("channel = 'email'"))[0];
  assert.equal(row?.status, 'failed');
  assert.equal(row?.outcome, 'smtp_not_configured');
});

dbTest('too many emails for one person in an hour are logged, not sent', async (db) => {
  const t = await bootAlerts(db);
  const app = await t.addApp();
  await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', { channels: ['email'] });
  await t.call(t.owner, 'PUT', '/alerts/rules/review.low_rating', { maxPerHour: 1000 });
  for (let i = 0; i < 23; i++)
    await t.emit(
      'review.new_low_rating',
      { reviewId: `r${i}`, rating: 1, store: 'appstore' },
      app,
      Date.now() + i,
    );
  assert.equal((await t.log("channel = 'email' AND status = 'queued'")).length, 20);
  assert.equal((await t.log("outcome = 'user_rate_limited'")).length, 3);
});

dbTest(
  'who is told follows the role: admin alerts reach admins only, and a viewer gets the app alerts they may read',
  async (db) => {
    const t = await bootAlerts(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const app = await t.addApp();
    await t.emit(
      'token.created',
      { tokenId: 't1', name: 'CI', role: 'admin', createdBy: t.ownerId },
      undefined,
      T0,
    );
    await t.rejected(app, '2.0', T0);
    const who = async (type: string) =>
      (
        await db.query(
          'SELECT i.user_id FROM alert_inbox i JOIN alerts a ON a.id = i.alert_id WHERE a.type = ? ORDER BY i.user_id',
          [type],
        )
      ).map((r) => String(r.user_id));
    assert.deepEqual(
      await who('security.token_created'),
      [t.ownerId],
      'a token is news for admins only (in_app is its default channel)',
    );
    assert.deepEqual((await who('release.rejected')).length, 3);
    assert.equal((await t.call(viewer, 'GET', '/alerts/unread-count')).body.unreadCount, 1);
    assert.equal((await t.call(member, 'GET', '/alerts/unread-count')).body.unreadCount, 1);
  },
);

const PUBLIC: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

dbTest(
  'the webhook channel is the alert.raised event, sent through the existing signed webhooks',
  async (db) => {
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const send: typeof sendPinned = async (url, body, headers) => {
      sent.push({ url, body, headers });
      return { ok: true, status: 200, body: 'ok' } as SendResult;
    };
    const t = await bootAlerts(db, {
      masterKey: randomBytes(32),
      webhooks: { resolve: PUBLIC, send },
    });
    const app = await t.addApp();
    const hook = await t.call(t.owner, 'POST', '/webhooks', {
      url: 'https://hooks.example.com/mrm',
      eventTypes: ['alert.raised'],
    });
    assert.equal(hook.status, 201);
    await t.rejected(app, '2.0', T0);
    const deliveries = await db.query(
      "SELECT event_type FROM webhook_deliveries WHERE event_type = 'alert.raised'",
    );
    assert.equal(deliveries.length, 1);
    assert.equal((await t.log("channel = 'webhook'"))[0]?.outcome, 'queued_for_endpoints');
    const body = JSON.parse(
      String((await db.query('SELECT body FROM webhook_deliveries'))[0]?.body),
    );
    assert.equal(body.type, 'alert.raised');
    assert.equal(body.data.alertType, 'release.rejected');
    assert.equal(body.data.title, 'Moon Diary 2.0 was rejected in store review');
    assert.doesNotMatch(JSON.stringify(body), /secret|password/i);
    // An alert about an alert would loop: raising one does not raise another.
    assert.equal((await t.alerts()).length, 1);
  },
);
