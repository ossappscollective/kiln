import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BuildFacet,
  buildLabel,
  connectionLabel,
  deviceFacts,
  deviceLine,
  emptyFilters,
  filterOptions,
  isOpen,
  linkExpired,
  listQuery,
  statusBadge,
  symbolicationNote,
  syncLine,
  type TestflightListItem,
  testerLabel,
  testerOptions,
  testflightConsoleUrl,
  triageDiff,
} from './testflight.ts';

const NOW = Date.UTC(2026, 10, 22, 12);

const item = (over: Partial<TestflightListItem> = {}): TestflightListItem => ({
  id: 'i1',
  kind: 'feedback',
  createdAt: NOW - 60_000,
  buildNumber: '42',
  version: '2.5.0',
  platform: 'IOS',
  bundleId: 'com.example.app',
  tester: '3FA9C1',
  testerEmail: null,
  deviceModel: 'iPhone16,2',
  deviceFamily: 'IPHONE',
  osVersion: '18.1',
  locale: 'fr_FR',
  timeZone: 'Europe/Paris',
  architecture: 'arm64e',
  connectionType: 'WIFI',
  pairedWatch: null,
  appUptimeMs: 61_000,
  diskFreeBytes: 12_000_000_000,
  diskTotalBytes: 128_000_000_000,
  batteryPercent: 80,
  screenWidth: 430,
  screenHeight: 932,
  crashLogState: 'none',
  crashLogTruncated: false,
  signature: null,
  symbolicated: null,
  status: 'new',
  assigneeUserId: null,
  statusChangedAt: null,
  statusChangedBy: null,
  firstSeenAt: NOW,
  comment: 'The button does nothing',
  commentTruncated: false,
  screenshotCount: 1,
  hasNote: false,
  ...over,
});

test('every status has a word and a tone; only new, seen and in progress are open', () => {
  assert.deepEqual(statusBadge('new'), { label: 'New', tone: 'info' });
  assert.equal(statusBadge('in_progress').label, 'In progress');
  assert.equal(statusBadge('resolved').tone, 'ok');
  assert.equal(statusBadge('ignored').tone, 'neutral');
  assert.deepEqual((['new', 'seen', 'in_progress', 'resolved', 'ignored'] as const).map(isOpen), [
    true,
    true,
    true,
    false,
    false,
  ]);
});

test('a build is named by version and number, number, version, or not at all', () => {
  assert.equal(buildLabel('42', '2.5.0'), '2.5.0 (build 42)');
  assert.equal(buildLabel('42', null), 'Build 42');
  assert.equal(buildLabel(null, '2.5.0'), '2.5.0');
  assert.equal(buildLabel(null, null), 'Unknown build');
});

test('a tester is the email for who may see it, else the code, else anonymous', () => {
  assert.equal(testerLabel({ tester: '3FA9C1', testerEmail: 'a@example.com' }), 'a@example.com');
  assert.equal(testerLabel({ tester: '3FA9C1', testerEmail: null }), 'Tester 3FA9C1');
  assert.equal(testerLabel({ tester: null, testerEmail: null }), 'Anonymous tester');
});

test('the device line and the facts keep only what Apple gave', () => {
  assert.equal(
    deviceLine({ deviceModel: 'iPhone16,2', platform: 'IOS', osVersion: '18.1' }),
    'iPhone16,2 · iOS 18.1',
  );
  assert.equal(
    deviceLine({ deviceModel: null, platform: 'MAC_OS', osVersion: '15.1' }),
    'macOS 15.1',
  );
  assert.equal(deviceLine({ deviceModel: null, platform: null, osVersion: null }), '');
  const facts = deviceFacts(item({ pairedWatch: null, locale: null }));
  const labels = facts.map((f) => f.label);
  assert.ok(labels.includes('Device'));
  assert.ok(labels.includes('Battery'));
  assert.ok(!labels.includes('Language'));
  assert.ok(!labels.includes('Paired watch'));
  assert.equal(facts.find((f) => f.label === 'Connection')?.value, 'Wi-Fi');
  assert.equal(facts.find((f) => f.label === 'Screen (points)')?.value, '430 × 932');
  assert.equal(connectionLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
});

test('the crash note never claims the log is symbolicated', () => {
  assert.match(symbolicationNote({ symbolicated: true, signature: 'x' }), /does not check/);
  assert.match(
    symbolicationNote({ symbolicated: false, signature: 'x' }),
    /probably not symbolicated/,
  );
  assert.match(symbolicationNote({ symbolicated: null, signature: null }), /may or may not/);
});

test('the list query carries the kind and only the filters that are set, encoded', () => {
  assert.equal(listQuery(emptyFilters()), 'kind=feedback');
  assert.equal(
    listQuery(
      {
        ...emptyFilters('crash'),
        build: '42',
        version: '2.5.0',
        status: 'new,seen,in_progress',
        tester: '3FA9C1',
        signature: 'EXC_BAD_ACCESS (SIGSEGV) | A b',
      },
      'abc',
    ),
    'kind=crash&build=42&version=2.5.0&status=new%2Cseen%2Cin_progress&tester=3FA9C1&signature=EXC_BAD_ACCESS%20(SIGSEGV)%20%7C%20A%20b&cursor=abc',
  );
});

test('filter options are the versions and builds that have something of the kind; testers are codes only', () => {
  const builds: BuildFacet[] = [
    { buildNumber: '43', version: '2.6.0', feedback: 0, crashes: 2, lastAt: 2 },
    { buildNumber: '42', version: '2.5.0', feedback: 3, crashes: 1, lastAt: 1 },
    { buildNumber: '41', version: '2.5.0', feedback: 1, crashes: 0, lastAt: 0 },
  ];
  assert.deepEqual(filterOptions(builds, 'feedback').versions, ['2.5.0']);
  assert.deepEqual(
    filterOptions(builds, 'feedback').builds.map((b) => b.value),
    ['42', '41'],
  );
  assert.deepEqual(
    filterOptions(builds, 'crash').builds.map((b) => b.value),
    ['43', '42'],
  );
  assert.deepEqual(testerOptions([item(), item({ id: 'i2' }), item({ id: 'i3', tester: null })]), [
    { value: '3FA9C1', label: 'Tester 3FA9C1' },
  ]);
});

test('a triage diff holds only what changed; an empty note clears it', () => {
  const base = { status: 'new' as const, assigneeUserId: null, internalNote: 'x' };
  assert.deepEqual(
    triageDiff(base, { status: 'new', assigneeUserId: null, internalNote: 'x' }),
    {},
  );
  assert.deepEqual(triageDiff(base, { status: 'seen', assigneeUserId: 'u1', internalNote: 'x' }), {
    status: 'seen',
    assigneeUserId: 'u1',
  });
  assert.deepEqual(triageDiff(base, { status: 'new', assigneeUserId: null, internalNote: '  ' }), {
    internalNote: null,
  });
  assert.deepEqual(
    triageDiff(
      { ...base, internalNote: null },
      { status: 'new', assigneeUserId: null, internalNote: '' },
    ),
    {},
  );
});

test('the sync line says never, read, partial or failed (with or without a copy)', () => {
  assert.match(syncLine(null, NOW).text, /Never read/);
  const ok = {
    lastAttemptAt: NOW,
    lastSyncedAt: NOW - 120_000,
    lastError: null,
    failures: 0,
    complete: true,
    warnings: [],
  };
  assert.equal(syncLine(ok, NOW).tone, 'neutral');
  assert.equal(syncLine({ ...ok, complete: false }, NOW).tone, 'warn');
  assert.equal(syncLine({ ...ok, lastError: 'boom', failures: 1 }, NOW).tone, 'bad');
  assert.match(syncLine({ ...ok, lastSyncedAt: null, lastError: 'boom' }, NOW).text, /boom/);
});

test('the console link needs the Apple id; an expired screenshot link is told', () => {
  assert.equal(
    testflightConsoleUrl('6740123456'),
    'https://appstoreconnect.apple.com/apps/6740123456/testflight',
  );
  assert.equal(testflightConsoleUrl(null), null);
  assert.equal(testflightConsoleUrl('abc'), null);
  assert.equal(
    linkExpired({ expiresAt: NOW + 5_000 }, NOW),
    true,
    'about to expire counts as expired',
  );
  assert.equal(linkExpired({ expiresAt: NOW + 3_600_000 }, NOW), false);
  assert.equal(linkExpired({ expiresAt: null }, NOW), false);
});
