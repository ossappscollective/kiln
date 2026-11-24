import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actions } from '@kiln/core';
import { eventTypes } from '../../services/event-types.ts';
import {
  alertCatalog,
  alertGroups,
  alertSeverities,
  alertsFromEvent,
  alertTypeIds,
  configurableAlertTypes,
  notAlertable,
  redactAlertData,
  resolveParams,
} from './catalog.ts';
import { digestDue, inQuietHours, isValidTimeZone, localTime, quietEndsAt } from './time.ts';

test('every alert type is complete: ids are unique, defaults fit the allowed channels, the audience is a real action', () => {
  assert.equal(new Set(alertTypeIds).size, alertTypeIds.length);
  for (const d of alertCatalog) {
    assert.match(d.id, /^[a-z]+(\.[a-z_]+)+$/, d.id);
    assert.ok(alertSeverities.includes(d.severity), d.id);
    assert.ok(alertGroups.includes(d.group), d.id);
    assert.ok((actions as readonly string[]).includes(d.audience), `${d.id} audience`);
    for (const c of d.defaultChannels)
      assert.ok(d.allowedChannels.includes(c), `${d.id} default ${c} is allowed`);
    assert.ok(d.maxPerHour >= 1, d.id);
    assert.ok(d.dedupe.startsWith(d.id.split('.')[0] ?? ''), `${d.id} dedupe template`);
    for (const p of Object.values(d.params))
      assert.ok(p.min <= p.default && p.default <= p.max, `${d.id} param range`);
  }
  assert.ok(configurableAlertTypes.every((d) => d.id !== 'test.alert'));
});

test('the catalog covers the conditions the task names, with severity and scope', () => {
  const want = [
    'release.rejected',
    'release.approved',
    'release.live',
    'release.halted',
    'store.sync_failed',
    'credential.invalid',
    'ci.run_failed',
    'analytics.sync_failing',
    'review.low_rating',
    'review.new',
    'rating.dropped',
    'aso.rank_dropped',
    'listing.drift',
    'pending.stale',
    'ai.suggestion_ready',
    'security.stepup_failed',
    'system.smtp_failing',
    'security.token_created',
    'security.member_added',
  ];
  for (const id of want) assert.ok((alertTypeIds as readonly string[]).includes(id), id);
  const byId = new Map(alertCatalog.map((d) => [d.id, d]));
  assert.equal(byId.get('release.rejected')?.severity, 'critical');
  assert.equal(byId.get('review.low_rating')?.scope, 'app');
  assert.equal(byId.get('credential.invalid')?.scope, 'workspace');
});

test('every event type is either named by an alert type or listed as not alertable, with a reason', () => {
  const named = new Set(
    alertCatalog.flatMap((d) => (d.source.kind === 'event' ? d.source.events : [])),
  );
  for (const type of eventTypes) {
    assert.ok(
      named.has(type) !== type in notAlertable,
      `${type}: exactly one of "alert type" and "not alertable"`,
    );
  }
  for (const [type, reason] of Object.entries(notAlertable)) {
    assert.ok((eventTypes as readonly string[]).includes(type), `${type} is an event type`);
    assert.ok(String(reason).length > 10);
  }
});

test('titles and bodies render from ids and names alone, never print undefined, and an alert about mail never travels by mail', () => {
  for (const d of alertCatalog) {
    for (const text of [d.title({}), d.body({})]) {
      assert.ok(text.length > 0, d.id);
      assert.doesNotMatch(text, /undefined|\[object|NaN/, `${d.id}: ${text}`);
    }
  }
  const smtp = alertCatalog.find((d) => d.id === 'system.smtp_failing');
  assert.ok(smtp && !smtp.allowedChannels.includes('email'));
});

test('redaction keeps ids, names and numbers and drops anything that looks like a secret', () => {
  const out = redactAlertData({
    appId: 'a1',
    tokenId: 't1',
    token: 'kiln_secret',
    apiKey: 'k',
    password: 'p',
    ciphertext: 'c',
    rating: 2,
    ok: true,
    none: null,
    nested: { x: 1 },
    long: 'x'.repeat(1000),
  });
  assert.deepEqual(Object.keys(out).sort(), ['appId', 'long', 'none', 'ok', 'rating', 'tokenId']);
  assert.equal(String(out.long).length, 300);
});

test('events become alerts by the rules of the catalog', () => {
  const at = Date.UTC(2026, 0, 5, 12);
  const status = (to: string) => ({
    type: 'app.release.status_changed',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: { version: '2.0', track: '', build: '9', from: 'in_review', to },
    createdAt: at,
  });
  const ids = (e: Parameters<typeof alertsFromEvent>[0]) => alertsFromEvent(e).map((m) => m.def.id);
  assert.deepEqual(ids(status('rejected')), ['release.rejected']);
  assert.deepEqual(ids(status('approved')), ['release.approved']);
  assert.deepEqual(ids(status('live')), ['release.live']);
  assert.deepEqual(ids(status('halted')), ['release.halted']);
  assert.deepEqual(ids(status('draft')), []);
  const rollout = (action: string) => ({
    type: 'release.rollout_changed',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: { action, version: '2.0' },
    createdAt: at,
  });
  assert.deepEqual(ids(rollout('halt')), ['release.halted']);
  assert.deepEqual(ids(rollout('resume')), []);
  const ci = (conclusion: string | null) => ({
    type: 'ci.run_finished',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: { runId: 'r', conclusion },
    createdAt: at,
  });
  assert.deepEqual(ids(ci('failure')), ['ci.run_failed']);
  assert.deepEqual(ids(ci('timed_out')), ['ci.run_failed']);
  assert.deepEqual(ids(ci('success')), []);
  const eas = (type: string, key: string, id: string) => ({
    type,
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: {
      appId: 'a1',
      [key]: id,
      platform: 'ios',
      version: '1.4.0',
      buildNumber: '57',
      code: null,
    },
    createdAt: at,
  });
  assert.deepEqual(ids(eas('eas.build_failed', 'buildId', 'b1')), ['eas.build_failed']);
  assert.deepEqual(ids(eas('eas.submission_failed', 'submissionId', 's1')), [
    'eas.submission_failed',
  ]);
  // Once per id: the same build raised later (another event, another time) has the same dedupe key; another build has another.
  const keyOf = (type: string, key: string, id: string, createdAt: number) => {
    const m = alertsFromEvent({ ...eas(type, key, id), createdAt })[0];
    return m?.def.dedupeKey(m.data);
  };
  assert.equal(
    keyOf('eas.build_failed', 'buildId', 'b1', 1),
    keyOf('eas.build_failed', 'buildId', 'b1', 99999),
  );
  assert.notEqual(
    keyOf('eas.build_failed', 'buildId', 'b1', 1),
    keyOf('eas.build_failed', 'buildId', 'b2', 1),
  );
  assert.equal(keyOf('eas.submission_failed', 'submissionId', 's1', 1), 'eas.submission_failed:s1');
  const stuck = (group: string, createdAt: number) => ({
    type: 'eas.update_rollout_stuck',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: {
      appId: 'a1',
      updateId: 'u1',
      group,
      platform: 'ios',
      channel: 'production',
      percentage: 25,
      hours: 49,
      message: 'SECRET-UPDATE-MESSAGE',
    },
    createdAt,
  });
  const stuckAlert = alertsFromEvent(stuck('g1', 1))[0];
  assert.deepEqual(ids(stuck('g1', 1)), ['eas.update_rollout_stuck']);
  // Once per update group (90 days); ids, platform, channel and percentage only: never the update message.
  assert.equal(stuckAlert?.def.dedupeKey(stuckAlert.data), 'eas.update_rollout_stuck:a1:g1');
  assert.equal(stuckAlert?.def.dedupeWindowMs, 90 * 24 * 3_600_000);
  assert.ok(!JSON.stringify(stuckAlert?.data).includes('SECRET-UPDATE-MESSAGE'));
  assert.equal(stuckAlert?.def.params.hours?.default, 48);
  const rank = (change: string, delta?: number) => ({
    type: 'aso.rank_changed',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: { keywordId: 'k', change, delta, from: 3, to: 20 },
    createdAt: at,
  });
  assert.deepEqual(ids(rank('down', -12)), ['aso.rank_dropped']);
  assert.deepEqual(ids(rank('down', -4)), [], 'below the threshold of ten places');
  assert.deepEqual(ids(rank('up', 15)), []);
  assert.deepEqual(ids(rank('dropped')), ['aso.rank_dropped']);
  const step = (failedCount: number) => ({
    type: 'stepup.failed',
    workspaceId: 'w',
    subject: {},
    payload: { userId: 'u', failedCount, reason: 'invalid_password' },
    createdAt: at,
  });
  assert.deepEqual(ids(step(1)), []);
  assert.deepEqual(ids(step(3)), ['security.stepup_failed']);
  const cred = (saved: boolean) => ({
    type: 'credential.test_failed',
    workspaceId: 'w',
    subject: {},
    payload: { credentialId: saved ? 'c1' : null, kind: 'github_token', saved },
    createdAt: at,
  });
  assert.deepEqual(ids(cred(true)), ['credential.invalid']);
  assert.deepEqual(ids(cred(false)), [], 'a test of an unsaved form is not an alert');
  // Thresholds come from the workspace: a lower limit alerts on a smaller drop.
  assert.equal(
    alertsFromEvent(rank('down', -4), (d) => resolveParams(d, { minDrop: 3 })).length,
    1,
  );
});

test('the text of an alert holds ids and names only: no review text, no store answer', () => {
  const m = alertsFromEvent({
    type: 'review.new_low_rating',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: {
      reviewId: 'r1',
      rating: 1,
      store: 'appstore',
      text: 'secret review text',
      authorName: 'Somebody',
    },
    createdAt: 1,
  })[0];
  assert.ok(m);
  const all = `${m.def.title(m.data)} ${m.def.body(m.data)} ${JSON.stringify(m.data)}`;
  assert.doesNotMatch(all, /secret review text|Somebody/);
});

test('resolveParams keeps stored thresholds inside their range', () => {
  const d = alertCatalog.find((x) => x.id === 'pending.stale');
  assert.ok(d);
  assert.deepEqual(resolveParams(d, { days: 3 }), { days: 3 });
  assert.deepEqual(resolveParams(d, { days: 9999 }), { days: 90 });
  assert.deepEqual(resolveParams(d, { days: 'x' }), { days: 7 });
  assert.deepEqual(resolveParams(d, null), { days: 7 });
});

// ----- time rules ------------------------------------------------------------------------------------------

test('quiet hours follow the timezone of the person, across midnight and daylight saving time', () => {
  const paris = { start: 22 * 60, end: 7 * 60, timezone: 'Europe/Paris' };
  // January: Paris is UTC+1, so 21:30 UTC is 22:30 there.
  assert.ok(inQuietHours(paris, Date.UTC(2026, 0, 5, 21, 30)));
  assert.ok(!inQuietHours(paris, Date.UTC(2026, 0, 5, 12, 0)));
  assert.ok(inQuietHours(paris, Date.UTC(2026, 0, 6, 5, 59)), '06:59 in Paris');
  assert.ok(!inQuietHours(paris, Date.UTC(2026, 0, 6, 6, 0)), '07:00 in Paris');
  // July: UTC+2, so the same UTC time is an hour later on the wall clock.
  assert.equal(localTime('Europe/Paris', Date.UTC(2026, 6, 5, 20, 30)).minutes, 22 * 60 + 30);
  assert.ok(inQuietHours(paris, Date.UTC(2026, 6, 5, 20, 30)));
  assert.equal(quietEndsAt(paris, Date.UTC(2026, 0, 5, 21, 30)), Date.UTC(2026, 0, 6, 6, 0));
  assert.equal(
    quietEndsAt(paris, Date.UTC(2026, 0, 5, 12, 0)),
    Date.UTC(2026, 0, 5, 12, 0),
    'not quiet: now',
  );
  assert.ok(!inQuietHours({ start: null, end: null, timezone: null }, 0));
  assert.ok(
    !inQuietHours({ start: 60, end: 60, timezone: 'UTC' }, 3_600_000),
    'an empty window is never quiet',
  );
  assert.ok(
    isValidTimeZone('America/New_York') && !isValidTimeZone('Mars/Base') && !isValidTimeZone(''),
  );
});

test('a digest is due once per local day (daily) or on Mondays (weekly), from its hour', () => {
  const base = { hour: 8, timezone: 'Europe/Paris' };
  const mon8 = Date.UTC(2026, 0, 5, 7, 0); // Monday 08:00 in Paris
  assert.ok(digestDue({ ...base, mode: 'daily', lastAt: null }, mon8));
  assert.ok(
    !digestDue({ ...base, mode: 'daily', lastAt: null }, mon8 - 3_600_000),
    'before the hour',
  );
  assert.ok(
    !digestDue({ ...base, mode: 'daily', lastAt: mon8 }, mon8 + 3_600_000),
    'already sent today',
  );
  assert.ok(digestDue({ ...base, mode: 'daily', lastAt: mon8 }, mon8 + 24 * 3_600_000));
  assert.ok(!digestDue({ ...base, mode: 'off', lastAt: null }, mon8));
  assert.ok(digestDue({ ...base, mode: 'weekly', lastAt: null }, mon8));
  assert.ok(
    !digestDue({ ...base, mode: 'weekly', lastAt: null }, mon8 + 24 * 3_600_000),
    'Tuesday',
  );
  assert.ok(
    !digestDue({ ...base, mode: 'weekly', lastAt: mon8 - 3 * 24 * 3_600_000 }, mon8),
    'sent three days ago',
  );
  assert.ok(digestDue({ ...base, mode: 'weekly', lastAt: mon8 - 7 * 24 * 3_600_000 }, mon8));
});
