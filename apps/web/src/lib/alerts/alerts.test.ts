import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  badgeCount,
  type CatalogEntry,
  describeOutcome,
  effectiveChannels,
  groupInbox,
  type InboxAlert,
  inboxHeadline,
  matrixGroups,
  minutesToTime,
  outcomeLabels,
  type Preference,
  quietSummary,
  timeToMinutes,
  toggleChannel,
} from './alerts.ts';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'release.rejected',
  group: 'release',
  groupLabel: 'Releases',
  label: 'Release rejected',
  description: 'The store rejected a version.',
  severity: 'critical',
  scope: 'app',
  defaultChannels: ['in_app', 'email'],
  allowedChannels: ['in_app', 'email', 'desktop', 'webhook'],
  audience: 'Everyone',
  source: 'event',
  events: ['release.status_changed'],
  dedupe: 'app+version',
  dedupeWindowHours: 24,
  params: [],
  visible: true,
  rule: {
    alertType: 'release.rejected',
    enabled: true,
    channels: ['in_app', 'email', 'webhook'],
    maxPerHour: 10,
    params: {},
    custom: false,
  },
  ...over,
});

const alert = (over: Partial<InboxAlert>): InboxAlert => ({
  id: 'a1',
  type: 'release.rejected',
  severity: 'critical',
  title: 'Rejected',
  body: '',
  appId: null,
  count: 1,
  firstAt: 1,
  lastAt: 1,
  resolvedAt: null,
  read: false,
  desktop: false,
  ...over,
});

test('every outcome code the server writes has a sentence, and no sentence is for a code the server never writes', () => {
  const source = readFileSync(
    new URL('../../../../server/src/modules/alerts/service.ts', import.meta.url),
    'utf8',
  );
  const block = /export const deliveryOutcomes = \[([^\]]*)\]/.exec(source);
  assert.ok(block, 'the outcome list is found in the server source');
  const codes = (block[1] ?? '')
    .split(',')
    .map((s) => s.replace(/['\s]/g, ''))
    .filter((s) => s !== '');
  assert.ok(codes.length > 10);
  assert.deepEqual(Object.keys(outcomeLabels).sort(), codes.slice().sort());
  assert.equal(describeOutcome('something_new'), 'Unknown result.');
});

test('effectiveChannels: an app choice wins over the all-apps choice, which wins over the workspace rule; the webhook is never personal', () => {
  const e = entry();
  assert.deepEqual(effectiveChannels(e, [], e.id, null), ['in_app', 'email']);
  const prefs: Preference[] = [
    { alertType: e.id, appId: null, channels: ['email'] },
    { alertType: e.id, appId: 'app-1', channels: ['in_app'] },
  ];
  assert.deepEqual(effectiveChannels(e, prefs, e.id, null), ['email']);
  assert.deepEqual(effectiveChannels(e, prefs, e.id, 'app-1'), ['in_app']);
  assert.deepEqual(effectiveChannels(e, prefs, e.id, 'app-2'), ['email']);
});

test('effectiveChannels: desktop brings the inbox with it, and channels a type does not allow are dropped', () => {
  const e = entry({ allowedChannels: ['in_app', 'desktop'] });
  const prefs: Preference[] = [{ alertType: e.id, appId: null, channels: ['desktop', 'email'] }];
  assert.deepEqual(effectiveChannels(e, prefs, e.id, null), ['in_app', 'desktop']);
});

test('toggleChannel keeps the order, and ties desktop to the inbox', () => {
  assert.deepEqual(toggleChannel(['email'], 'desktop', true), ['in_app', 'email', 'desktop']);
  assert.deepEqual(toggleChannel(['in_app', 'desktop'], 'in_app', false), []);
  assert.deepEqual(toggleChannel(['in_app', 'email'], 'email', false), ['in_app']);
  assert.deepEqual(toggleChannel([], 'email', true), ['email']);
});

test('groupInbox puts open warnings and criticals first, drops empty groups, and keeps resolved ones last', () => {
  const groups = groupInbox([
    alert({ id: 'i', severity: 'info' }),
    alert({ id: 'r', resolvedAt: 5 }),
    alert({ id: 'w', severity: 'warning' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['attention', 'info', 'resolved'],
  );
  assert.deepEqual(
    groups.map((g) => g.alerts.map((a) => a.id)),
    [['w'], ['i'], ['r']],
  );
  assert.deepEqual(groupInbox([]), []);
});

test('matrixGroups follows the catalog order and leaves out what the role cannot receive', () => {
  const groups = matrixGroups([
    entry({ id: 'a', group: 'x', groupLabel: 'X' }),
    entry({ id: 'b', group: 'y', groupLabel: 'Y', visible: false }),
    entry({ id: 'c', group: 'x', groupLabel: 'X' }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.entries.map((e) => e.id)]),
    [['x', ['a', 'c']]],
  );
});

test('times: 24-hour text to minutes and back, and a bad text is not a time', () => {
  assert.equal(timeToMinutes('22:30'), 22 * 60 + 30);
  assert.equal(timeToMinutes('7:05'), 7 * 60 + 5);
  assert.equal(timeToMinutes('24:00'), null);
  assert.equal(timeToMinutes('noon'), null);
  assert.equal(minutesToTime(7 * 60 + 5), '07:05');
  assert.equal(minutesToTime(null), '');
  assert.match(
    quietSummary({ quietStart: 22 * 60, quietEnd: 7 * 60, timezone: 'Europe/Berlin' }),
    /22:00 to 07:00 \(Europe\/Berlin\)/,
  );
  assert.equal(
    quietSummary({ quietStart: null, quietEnd: null, timezone: null }),
    'No quiet hours',
  );
});

test('badgeCount is empty for none and stops at 99+', () => {
  assert.equal(badgeCount(0), '');
  assert.equal(badgeCount(7), '7');
  assert.equal(badgeCount(100), '99+');
});

test('inboxHeadline says what needs attention first, then how many are unread', () => {
  const a = (severity: 'info' | 'warning', resolvedAt: number | null = null) =>
    ({ id: String(Math.random()), severity, resolvedAt }) as never;
  const groups = groupInbox([a('warning'), a('warning'), a('info'), a('warning', 5)]);
  assert.equal(inboxHeadline(groups, 3), '2 need attention, 3 unread');
  assert.equal(inboxHeadline(groupInbox([a('warning')]), 0), '1 needs attention');
  assert.equal(inboxHeadline(groupInbox([a('info')]), 1), 'Nothing needs attention, 1 unread');
  assert.equal(inboxHeadline([], 0), 'Nothing needs attention');
});
