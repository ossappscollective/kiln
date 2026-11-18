import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReleaseTable,
  buildText,
  buildsForRelease,
  ciFor,
  defaultReleaseFilter,
  filterGroups,
  planCell,
  planFor,
  tableSummary,
} from './releases-table.ts';
import type { AppBuild, PlanSummary, ReleaseSummary } from './types.ts';

function release(partial: Partial<ReleaseSummary> & { id: string }): ReleaseSummary {
  return {
    appId: 'ios-1',
    platform: 'ios',
    version: '2.1.0',
    track: null,
    build: '45',
    status: 'live',
    rawState: 'READY_FOR_SALE',
    rolloutFraction: null,
    versionCodes: null,
    storeUpdatedAt: 1_700_000_000_000,
    syncedAt: 1_700_000_100_000,
    ...partial,
  };
}

function build(partial: Partial<AppBuild> & { buildNumber: string }): AppBuild {
  return {
    platform: 'ios',
    version: '2.1.0',
    tracks: [],
    status: null,
    rawState: '',
    uploadedAt: 1,
    syncedAt: 1,
    linkState: 'unlinked',
    link: null,
    diagnostic: null,
    ...partial,
  };
}

const run = (status: string, conclusion: string | null) => ({
  id: 'r1',
  workflow: 'ios.yml',
  title: null,
  status,
  conclusion,
  active: status !== 'completed',
  url: null,
  branch: null,
  startedAt: 1,
  updatedAt: 1,
});

function linked(buildNumber: string, status: string, conclusion: string | null, platform: 'ios' | 'android' = 'ios'): AppBuild {
  return build({
    buildNumber,
    platform,
    linkState: 'linked',
    link: {
      state: 'linked',
      source: 'manual',
      confidence: 'high',
      evidence: null,
      manual: true,
      reason: '',
      candidates: 1,
      linkedAt: 1,
      linkedBy: null,
      run: run(status, conclusion),
      commit: null,
    } as never,
  });
}

function plan(partial: Partial<PlanSummary> = {}): PlanSummary {
  return {
    id: 'p1',
    appId: 'ios-1',
    appName: 'Acme',
    appPlatform: 'ios',
    appIdentifier: 'com.acme',
    version: '2.1.0',
    platform: null,
    targetDate: null,
    blocked: false,
    blockedReason: null,
    notes: '',
    createdBy: 'u',
    createdAt: 1,
    updatedAt: 1,
    released: false,
    due: { dueSoon: false, overdue: false, daysLeft: null },
    readiness: { ready: false, required: { total: 0, done: 0, open: 0 }, notes: {} as never, reasons: [] },
    checklist: { total: 4, done: 1 },
    rollout: null,
    ...partial,
  } as PlanSummary;
}

test('buildText shows version codes on Android and the build on iOS', () => {
  assert.equal(buildText(release({ id: 'a' })), '45');
  assert.equal(buildText(release({ id: 'a', build: null })), '—');
  assert.equal(buildText(release({ id: 'a', platform: 'android', build: '312', versionCodes: ['311', '312'] })), '311, 312');
});

test('buildsForRelease matches by platform and build number or version code', () => {
  const builds = [build({ buildNumber: '45' }), build({ buildNumber: '46' }), build({ buildNumber: '312', platform: 'android' })];
  assert.deepEqual(
    buildsForRelease(release({ id: 'a' }), builds).map((b) => b.buildNumber),
    ['45'],
  );
  const android = release({ id: 'b', platform: 'android', build: '312', versionCodes: ['312', '999'] });
  assert.deepEqual(
    buildsForRelease(android, builds).map((b) => b.buildNumber),
    ['312'],
  );
  assert.deepEqual(buildsForRelease(release({ id: 'c', build: null }), builds), []);
});

test('ciFor reports the run, a tag, no link, no build, or unknown', () => {
  const r = release({ id: 'a' });
  assert.equal(ciFor(r, null).state, 'unknown');
  assert.equal(ciFor(r, []).label, 'No build');
  assert.equal(ciFor(r, [build({ buildNumber: '45' })]).label, 'Not linked');
  assert.equal(ciFor(r, [build({ buildNumber: '45', linkState: 'tag' })]).label, 'Tag found');
  const ok = ciFor(r, [linked('45', 'completed', 'success')]);
  assert.equal(ok.state, 'run');
  assert.equal(ok.label, 'Succeeded');
  assert.equal(ok.tone, 'ok');
  assert.equal(ciFor(r, [linked('45', 'completed', 'failure')]).tone, 'bad');
  assert.equal(ciFor(r, [linked('45', 'in_progress', null)]).dot, true);
});

test('ciFor prefers the build with a run when a release has several', () => {
  const android = release({ id: 'b', platform: 'android', build: '312', versionCodes: ['311', '312'] });
  const builds = [build({ buildNumber: '311', platform: 'android' }), linked('312', 'completed', 'success', 'android')];
  assert.equal(ciFor(android, builds).label, 'Succeeded');
});

test('planFor finds the own plan, or a plan for both on the other app', () => {
  const r = release({ id: 'a' });
  assert.equal(planFor(r, {}), null);
  assert.equal(planFor(r, { 'ios-1': [plan({ version: '9.9.9' })] }), null);
  const own = planFor(r, { 'ios-1': [plan()] });
  assert.equal(own?.viaApp, false);
  // A plan for Android only on the iOS record does not cover the iOS release.
  assert.equal(planFor(r, { 'ios-1': [plan({ platform: 'android' })] }), null);
  const android = release({ id: 'b', appId: 'and-1', platform: 'android' });
  const via = planFor(android, { 'ios-1': [plan()], 'and-1': [] });
  assert.equal(via?.viaApp, true);
  assert.equal(planFor(android, { 'ios-1': [plan({ platform: 'ios' })], 'and-1': [] }), null);
});

test('planCell says blocked, released, overdue, due soon, ready or progress, in that order', () => {
  assert.equal(planCell(null).label, 'No plan');
  assert.equal(planCell(null, false).label, '—');
  const cell = (p: Partial<PlanSummary>) => planCell({ plan: plan(p), viaApp: false });
  assert.equal(cell({ blocked: true, released: true, blockedReason: 'Legal' }).label, 'Blocked');
  assert.equal(cell({ released: true, due: { dueSoon: false, overdue: true, daysLeft: -1 } }).label, 'Released');
  assert.equal(cell({ due: { dueSoon: false, overdue: true, daysLeft: -2 }, targetDate: '2026-01-01' }).label, 'Overdue');
  assert.equal(cell({ due: { dueSoon: true, overdue: false, daysLeft: 1 } }).label, 'Due soon');
  assert.equal(cell({ readiness: { ready: true } as never }).label, 'Ready');
  const progress = cell({});
  assert.equal(progress.label, 'In progress');
  assert.equal(progress.title, '1 of 4 checklist items done.');
  assert.equal(planCell({ plan: plan(), viaApp: true }).kind, 'plan');
});

const iosReleases = [
  release({ id: 'i1', version: '2.1.0', status: 'rolling_out', rolloutFraction: 0.2 }),
  release({ id: 'i2', version: '2.0.0', build: '40' }),
];
const androidReleases = [
  release({ id: 'a1', appId: 'and-1', platform: 'android', version: '2.1.0', track: 'production', build: '312', versionCodes: ['312'], status: 'live', rolloutFraction: null }),
  release({ id: 'a2', appId: 'and-1', platform: 'android', version: '2.1.0', track: 'beta', build: '313', versionCodes: ['313'], status: 'in_review' }),
  release({ id: 'a3', appId: 'and-1', platform: 'android', version: '1.9.0', build: '300', versionCodes: ['300'] }),
];

test('buildReleaseTable groups by version, newest first, iOS before Android', () => {
  const groups = buildReleaseTable({
    releases: { 'ios-1': iosReleases, 'and-1': androidReleases },
    plans: { 'ios-1': [plan()], 'and-1': [] },
    builds: { 'ios-1': [linked('45', 'completed', 'success')] },
    appIds: ['ios-1', 'and-1'],
  });
  assert.deepEqual(
    groups.map((g) => g.version),
    ['2.1.0', '2.0.0', '1.9.0'],
  );
  const g = groups[0];
  assert.deepEqual(g?.platforms, ['ios', 'android']);
  assert.deepEqual(
    g?.rows.map((r) => `${r.platform}:${r.track ?? ''}`),
    ['ios:', 'android:production', 'android:beta'],
  );
  assert.equal(g?.inProgress, true);
  const iosRow = g?.rows[0];
  assert.equal(iosRow?.rolloutText, '20%');
  assert.equal(iosRow?.ci.label, 'Succeeded');
  assert.equal(iosRow?.plan.label, 'In progress');
  assert.equal(iosRow?.trackText, 'App Store');
  // The Android rows have no builds loaded (no entry) and the plan on the iOS app covers both.
  const play = g?.rows[1];
  assert.equal(play?.ci.state, 'unknown');
  assert.equal(play?.plan.kind === 'plan' && play.plan.viaApp, true);
  assert.equal(play?.trackText, 'Production');
  assert.equal(groups[1]?.inProgress, false);
});

test('buildReleaseTable without plans says so, not "No plan"', () => {
  const groups = buildReleaseTable({ releases: { 'ios-1': iosReleases }, plans: null, builds: {}, appIds: ['ios-1'] });
  assert.equal(groups[0]?.rows[0]?.plan.label, '—');
});

test('filterGroups: search and in progress only drop rows and empty groups', () => {
  const groups = buildReleaseTable({
    releases: { 'ios-1': iosReleases, 'and-1': androidReleases },
    plans: {},
    builds: {},
    appIds: ['ios-1', 'and-1'],
  });
  assert.equal(filterGroups(groups, defaultReleaseFilter()).length, 3);
  const open = filterGroups(groups, { query: '', inProgressOnly: true });
  assert.deepEqual(
    open.map((g) => [g.version, g.rows.length]),
    [['2.1.0', 2]],
  );
  assert.deepEqual(
    filterGroups(groups, { query: '1.9', inProgressOnly: false }).map((g) => g.version),
    ['1.9.0'],
  );
  assert.deepEqual(
    filterGroups(groups, { query: 'beta', inProgressOnly: false }).map((g) => g.rows.length),
    [1],
  );
  assert.equal(tableSummary(open), '1 version, 2 releases');
  assert.equal(tableSummary(groups), '3 versions, 5 releases');
});
