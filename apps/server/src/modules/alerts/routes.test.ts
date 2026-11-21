import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { seedWorkspace } from '../../testkit.ts';
import { bootAlerts } from './test-helpers.ts';

type T = Awaited<ReturnType<typeof bootAlerts>>;
const bearer = (t: T, token: string, method: string, path: string, body?: unknown) =>
  t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const makeToken = async (t: T, input: Record<string, unknown>) =>
  (await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input })).body
    .token as string;

dbTest(
  'the catalog is readable by every role, hides what a role can never receive, and is 404 to strangers',
  async (db) => {
    const t = await bootAlerts(db);
    const viewer = await t.addMember('viewer');
    const catalog = (await t.call(viewer, 'GET', '/alerts/catalog')).body.catalog as {
      id: string;
      visible: boolean;
      rule: { enabled: boolean; channels: string[] };
    }[];
    assert.ok(catalog.length >= 25);
    assert.equal(catalog.find((c) => c.id === 'release.rejected')?.visible, true);
    assert.equal(catalog.find((c) => c.id === 'security.token_created')?.visible, false);
    assert.ok(!catalog.some((c) => c.id === 'test.alert'));
    assert.deepEqual(catalog.find((c) => c.id === 'release.rejected')?.rule.channels, [
      'in_app',
      'email',
      'desktop',
      'webhook',
    ]);
    const stranger = await t.app.request(`/api/workspaces/${t.workspaceId}/alerts/catalog`);
    assert.equal(stranger.status, 401);
    const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
    assert.equal((await t.call(other.cookie, 'GET', '/alerts/catalog')).status, 404);
  },
);

dbTest(
  'members change their own settings, viewers cannot, and what they send is checked',
  async (db) => {
    const t = await bootAlerts(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    assert.equal(
      (await t.call(viewer, 'PUT', '/alerts/settings', { minSeverity: 'warning' })).status,
      403,
    );
    assert.equal((await t.call(viewer, 'GET', '/alerts/settings')).status, 200);
    const ok = await t.call(member, 'PUT', '/alerts/settings', {
      minSeverity: 'warning',
      quietStart: 1320,
      quietEnd: 420,
      timezone: 'Europe/Paris',
      digest: 'weekly',
      digestHour: 9,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.digest, 'weekly');
    assert.ok(ok.body.settings.lastDigestAt > 0, 'counting starts when the digest is turned on');
    const again = (await t.call(member, 'GET', '/alerts/settings')).body.settings;
    assert.equal(again.timezone, 'Europe/Paris');
    // Settings are per person: the owner has the defaults.
    assert.equal(
      (await t.call(t.owner, 'GET', '/alerts/settings')).body.settings.minSeverity,
      'info',
    );
    for (const bad of [
      { timezone: 'Mars/Base' },
      { minSeverity: 'loud' },
      { quietStart: 2000 },
      { digest: 'hourly' },
      { digestHour: 24 },
      { extra: 1 },
    ]) {
      assert.equal(
        (await t.call(member, 'PUT', '/alerts/settings', bad)).status,
        400,
        JSON.stringify(bad),
      );
    }
    assert.equal(
      (await t.call(member, 'PUT', '/alerts/preferences/release.live', { channels: ['webhook'] }))
        .status,
      400,
      'webhook is not a personal channel',
    );
    assert.equal(
      (
        await t.call(member, 'PUT', '/alerts/preferences/system.smtp_failing', {
          channels: ['email'],
        })
      ).status,
      400,
      'mail failures never travel by mail',
    );
    assert.equal(
      (
        await t.call(member, 'PUT', '/alerts/preferences/security.token_created', {
          appId: 'x',
          channels: ['in_app'],
        })
      ).status,
      400,
      'workspace alerts have no app',
    );
    assert.equal(
      (await t.call(member, 'PUT', '/alerts/preferences/nope', { channels: [] })).status,
      404,
    );
  },
);

dbTest(
  'only admins set workspace rules; thresholds and channels are checked; changes are audited',
  async (db) => {
    const t = await bootAlerts(db);
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    assert.equal(
      (await t.call(member, 'PUT', '/alerts/rules/pending.stale', { params: { days: 3 } })).status,
      403,
    );
    const ok = await t.call(admin, 'PUT', '/alerts/rules/pending.stale', {
      params: { days: 3 },
      channels: ['in_app', 'email'],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.rule.params, { days: 3 });
    assert.equal(ok.body.rule.custom, true);
    assert.equal(
      (await t.call(admin, 'PUT', '/alerts/rules/pending.stale', { params: { days: 0 } })).status,
      400,
    );
    assert.equal(
      (await t.call(admin, 'PUT', '/alerts/rules/pending.stale', { params: { hours: 3 } })).status,
      400,
    );
    assert.equal(
      (await t.call(admin, 'PUT', '/alerts/rules/system.smtp_failing', { channels: ['email'] }))
        .status,
      400,
    );
    assert.equal(
      (await t.call(admin, 'PUT', '/alerts/rules/test.alert', { enabled: false })).status,
      404,
    );
    assert.equal(
      (await t.call(admin, 'PUT', '/alerts/rules/pending.stale', { maxPerHour: 0 })).status,
      400,
    );
    assert.ok(
      (await t.auditActions()).some(
        (a) => a.action === 'alert.rule_set' && a.targetId === 'pending.stale',
      ),
    );
    assert.equal((await t.call(member, 'DELETE', '/alerts/rules/pending.stale')).status, 403);
    assert.equal(
      (await t.call(admin, 'DELETE', '/alerts/rules/pending.stale')).body.rule.params.days,
      7,
    );
    assert.ok((await t.auditActions()).some((a) => a.action === 'alert.rule_reset'));
  },
);

dbTest(
  "the inbox is each person's own; reading changes only their copy; paging works",
  async (db) => {
    const t = await bootAlerts(db);
    const member = await t.addMember('member');
    const app = await t.addApp();
    for (let i = 0; i < 3; i++) await t.rejected(app, `1.${i}`, Date.now() + i * 1000);
    const mine = await t.call(t.owner, 'GET', '/alerts/inbox');
    assert.equal(mine.body.alerts.length, 3);
    assert.equal(mine.body.unreadCount, 3);
    assert.equal(
      mine.body.alerts[0].title,
      'Moon Diary 1.2 was rejected in store review',
      'newest first',
    );
    const page = await t.call(t.owner, 'GET', `/alerts/inbox?limit=2`);
    assert.equal(page.body.hasMore, true);
    const next = await t.call(
      t.owner,
      'GET',
      `/alerts/inbox?limit=2&before=${page.body.alerts[1].lastAt}`,
    );
    assert.equal(next.body.alerts.length, 1);
    const ids = [mine.body.alerts[0].id];
    assert.equal(
      (await t.call(t.owner, 'POST', '/alerts/inbox/read', { ids })).body.unreadCount,
      2,
    );
    assert.equal(
      (await t.call(member, 'GET', '/alerts/unread-count')).body.unreadCount,
      3,
      'the member has their own copy',
    );
    assert.equal((await t.call(member, 'POST', '/alerts/inbox/read', { ids })).body.marked, 1);
    assert.equal((await t.call(t.owner, 'GET', '/alerts/inbox?unread=1')).body.alerts.length, 2);
    assert.equal(
      (await t.call(t.owner, 'POST', '/alerts/inbox/read', { all: true })).body.unreadCount,
      0,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', '/alerts/inbox/read', { all: true, ids })).status,
      400,
    );
    assert.equal((await t.call(t.owner, 'POST', '/alerts/inbox/read', {})).status, 400);
    assert.equal((await t.call(t.owner, 'GET', '/alerts/inbox?limit=0')).status, 400);
  },
);

dbTest(
  'the delivery log: members see their own rows, admins the workspace, and nothing in it is free text',
  async (db) => {
    const t = await bootAlerts(db);
    const member = await t.addMember('member');
    const app = await t.addApp();
    await t.rejected(app, '2.0', Date.now());
    const mine = (await t.call(member, 'GET', '/alerts/deliveries')).body.deliveries as {
      userId: string;
      channel: string;
      outcome: string;
    }[];
    assert.ok(mine.length > 0);
    assert.ok(mine.every((d) => d.userId === `user-member-${t.workspaceId}`));
    assert.equal((await t.call(member, 'GET', '/alerts/deliveries?scope=workspace')).status, 403);
    const all = (await t.call(t.owner, 'GET', '/alerts/deliveries?scope=workspace&limit=100')).body
      .deliveries as { userId: string | null; channel: string }[];
    assert.ok(all.some((d) => d.channel === 'webhook' && d.userId === null));
    assert.ok(all.length > mine.length);
    assert.ok(!JSON.stringify(all).includes('ada@example.com'), 'no address in the log');
  },
);

dbTest(
  'send a test: each channel travels its real path, the webhook needs an admin, and tests are rate limited',
  async (db) => {
    const t = await bootAlerts(db);
    const member = await t.addMember('member');
    const inApp = await t.call(member, 'POST', '/alerts/test', { channel: 'in_app' });
    assert.equal(inApp.status, 202);
    assert.equal((await t.call(member, 'GET', '/alerts/inbox')).body.alerts[0].title, 'Test alert');
    const desktop = await t.call(member, 'POST', '/alerts/test', { channel: 'desktop' });
    assert.ok(
      (await t.call(member, 'GET', '/alerts/inbox')).body.alerts.some(
        (a: { desktop: boolean }) => a.desktop,
      ),
    );
    assert.ok(
      desktop.body.deliveries.some(
        (d: { channel: string; outcome: string }) =>
          d.channel === 'desktop' && d.outcome === 'queued_for_client',
      ),
    );
    const email = await t.call(member, 'POST', '/alerts/test', { channel: 'email' });
    assert.ok(
      email.body.deliveries.some(
        (d: { channel: string; status: string }) => d.channel === 'email' && d.status === 'queued',
      ),
    );
    assert.equal(await t.runMail(), 1);
    assert.equal(t.mail.sent.at(-1)?.to, `user-member-${t.workspaceId}@x.io`);
    assert.equal(
      (await t.call(member, 'POST', '/alerts/test', { channel: 'webhook' })).status,
      403,
    );
    const hook = await t.call(t.owner, 'POST', '/alerts/test', { channel: 'webhook' });
    assert.equal(hook.status, 202);
    assert.equal(hook.body.deliveries[0].channel, 'webhook');
    assert.equal(hook.body.deliveries[0].outcome, 'no_endpoint');
    assert.equal((await t.call(member, 'POST', '/alerts/test', { channel: 'pigeon' })).status, 400);
    // A test is no alert for the others, and it does not count against a type's cap or leave a collapsed alert behind.
    assert.equal((await t.alerts()).length, 0);
    assert.equal(
      (await t.call(t.owner, 'GET', '/alerts/inbox')).body.alerts.length,
      0,
      "the owner got nothing of the member's tests",
    );
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'POST', '/alerts/test', { channel: 'in_app' })).status, 403);
    let last = 202;
    for (let i = 0; i < 12 && last === 202; i++)
      last = (await t.call(t.owner, 'POST', '/alerts/test', { channel: 'in_app' })).status;
    assert.equal(last, 429);
  },
);

dbTest(
  'API tokens reach only the operations that are open to them: reading, and the rules only when the token names them',
  async (db) => {
    const t = await bootAlerts(db);
    const everything = await makeToken(t, {});
    assert.equal((await bearer(t, everything, 'GET', '/alerts/catalog')).status, 200);
    assert.equal((await bearer(t, everything, 'GET', '/alerts/inbox')).status, 200);
    assert.equal((await bearer(t, everything, 'GET', '/alerts/deliveries')).status, 200);
    // The person's own state is never a token's business, and the rules are explicit-only.
    for (const [method, path, body] of [
      ['PUT', '/alerts/settings', { minSeverity: 'warning' }],
      ['GET', '/alerts/settings', undefined],
      ['POST', '/alerts/mutes', { hours: 1 }],
      ['POST', '/alerts/inbox/read', { all: true }],
      ['POST', '/alerts/test', { channel: 'in_app' }],
      ['PUT', '/alerts/rules/pending.stale', { enabled: false }],
    ] as const) {
      const res = await bearer(t, everything, method, path, body);
      assert.ok(res.status === 403 || res.status === 404, `${method} ${path} -> ${res.status}`);
    }
    const named = await makeToken(t, { actions: ['alerts.manage', 'alerts.read'] });
    assert.equal(
      (await bearer(t, named, 'PUT', '/alerts/rules/pending.stale', { enabled: false })).status,
      200,
    );
    const readOnly = await makeToken(t, { role: 'viewer' });
    assert.equal((await bearer(t, readOnly, 'GET', '/alerts/catalog')).status, 200);
    assert.equal(
      (await bearer(t, readOnly, 'PUT', '/alerts/rules/pending.stale', { enabled: true })).status,
      403,
    );
  },
);
