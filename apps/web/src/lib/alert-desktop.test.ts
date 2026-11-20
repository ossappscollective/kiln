import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESKTOP_KINDS,
  DEVICE_KEY,
  desktopKindEntries,
  deviceEnabled,
  kindUsesDesktop,
  MAX_SEEN,
  notificationTitle,
  planNotifications,
  readDeviceChoice,
  remember,
  writeDeviceChoice,
} from './alert-desktop.ts';
import type { CatalogEntry, InboxAlert } from './alerts.ts';

const NOW = 1_800_000_000_000;

const alert = (id: string, over: Partial<InboxAlert> = {}): InboxAlert => ({
  id,
  type: 'release.in_review',
  severity: 'info',
  title: `Weather 3.1.1 is in store review (${id})`,
  body: 'The store moved 3.1.1 of Weather from waiting to in review.',
  appId: 'app-1',
  count: 1,
  firstAt: NOW + 1,
  lastAt: NOW + 1,
  resolvedAt: null,
  read: false,
  desktop: true,
  ...over,
});

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({
    id,
    group: 'releases',
    groupLabel: 'Releases',
    label: id,
    description: '',
    severity: 'info',
    scope: 'app',
    defaultChannels: ['in_app'],
    allowedChannels: ['in_app', 'email', 'desktop', 'webhook'],
    audience: 'apps.read',
    source: 'event',
    events: [],
    dedupe: '',
    dedupeWindowHours: 1,
    params: [],
    visible: true,
    rule: { enabled: true, channels: ['in_app'] },
    ...over,
  }) as unknown as CatalogEntry;

test('planNotifications: only flagged, unread, new and unseen alerts are shown', () => {
  const plan = planNotifications({
    alerts: [
      alert('a'),
      alert('not-flagged', { desktop: false }),
      alert('read', { read: true }),
      alert('old', { lastAt: NOW - 1 }),
      alert('seen'),
    ],
    seen: ['seen'],
    startedAt: NOW,
    deviceOn: true,
  });
  assert.deepEqual(
    plan.show.map((a) => a.id),
    ['a'],
  );
  assert.deepEqual(plan.mark, ['a']);
});

test('planNotifications: one alert notifies once, even when read again', () => {
  const input = { alerts: [alert('a')], seen: [] as string[], startedAt: NOW, deviceOn: true };
  const first = planNotifications(input);
  assert.equal(first.show.length, 1);
  const seen = remember(input.seen, first.mark);
  // The same alert comes back with a larger count and a later time: still not shown again.
  const again = planNotifications({
    ...input,
    alerts: [alert('a', { count: 4, lastAt: NOW + 60_000 })],
    seen,
  });
  assert.deepEqual(again, { show: [], mark: [] });
});

test('planNotifications: quiet when the device switch is off, and nothing replays when it is turned on', () => {
  const off = planNotifications({
    alerts: [alert('a'), alert('b')],
    seen: [],
    startedAt: NOW,
    deviceOn: false,
  });
  assert.deepEqual(off.show, []);
  assert.deepEqual(off.mark, ['a', 'b']);
  const later = planNotifications({
    alerts: [alert('a'), alert('b')],
    seen: remember([], off.mark),
    startedAt: NOW,
    deviceOn: true,
  });
  assert.deepEqual(later.show, []);
});

test('planNotifications: at most three at once, the others are marked so they never arrive as a burst', () => {
  const alerts = ['1', '2', '3', '4', '5'].map((id) => alert(id));
  const plan = planNotifications({ alerts, seen: [], startedAt: NOW, deviceOn: true });
  assert.deepEqual(
    plan.show.map((a) => a.id),
    ['1', '2', '3'],
  );
  assert.deepEqual(plan.mark, ['1', '2', '3', '4', '5']);
  assert.deepEqual(planNotifications({ alerts: [], seen: [], startedAt: NOW, deviceOn: true }), {
    show: [],
    mark: [],
  });
});

test('remember: no duplicates, bounded, newest kept', () => {
  assert.deepEqual(remember(['a'], ['a', 'b']), ['a', 'b']);
  const many = Array.from({ length: MAX_SEEN + 20 }, (_, i) => `id${i}`);
  const kept = remember([], many);
  assert.equal(kept.length, MAX_SEEN);
  assert.equal(kept[kept.length - 1], `id${MAX_SEEN + 19}`);
});

test('notificationTitle: the title only, cleaned and bounded', () => {
  assert.equal(
    notificationTitle(alert('x', { title: 'Weather: iOS 3.1.1 is now in review' })),
    'Weather: iOS 3.1.1 is now in review',
  );
  assert.equal(notificationTitle({ title: '  a\nb\u0007c  ' }), 'a b c');
  const long = notificationTitle({ title: 'x'.repeat(500) });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
  assert.equal(notificationTitle({ title: '' }), '');
});

test('the device switch: an explicit choice wins, otherwise it follows the permission', () => {
  assert.equal(deviceEnabled(null, 'granted'), true, 'allowed before the switch existed');
  assert.equal(deviceEnabled(null, 'default'), false);
  assert.equal(deviceEnabled(true, 'granted'), true);
  assert.equal(deviceEnabled(true, 'denied'), false, 'on, but the system says no');
  assert.equal(deviceEnabled(false, 'granted'), false);

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(readDeviceChoice(storage), null);
  writeDeviceChoice(storage, true);
  assert.equal(store.get(DEVICE_KEY), 'on');
  assert.equal(readDeviceChoice(storage), true);
  writeDeviceChoice(storage, false);
  assert.equal(readDeviceChoice(storage), false);
  assert.equal(readDeviceChoice(undefined), null);
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readDeviceChoice(broken), null);
  assert.doesNotThrow(() => writeDeviceChoice(broken, true));
});

test('the kinds card lists the known kinds in order, and only those this person can use', () => {
  const catalog = [
    entry('release.rejected'),
    entry('release.in_review'),
    entry('release.halted', { visible: false }),
    entry('release.approved', { allowedChannels: ['in_app'] }),
    entry('store.sync_failed', { rule: { enabled: false, channels: [] } } as Partial<CatalogEntry>),
    entry('something.else'),
  ];
  assert.deepEqual(
    desktopKindEntries(catalog).map((e) => e.id),
    ['release.in_review', 'release.rejected'],
  );
  assert.equal(
    DESKTOP_KINDS.indexOf('release.in_review') < DESKTOP_KINDS.indexOf('release.rejected'),
    true,
  );

  const rejected = entry('release.rejected', {
    rule: { enabled: true, channels: ['in_app', 'desktop'] },
  } as Partial<CatalogEntry>);
  assert.equal(kindUsesDesktop(rejected, []), true, 'the workspace default');
  assert.equal(
    kindUsesDesktop(rejected, [
      { alertType: 'release.rejected', appId: null, channels: ['in_app'] } as never,
    ]),
    false,
    'the person turned it off',
  );
});
