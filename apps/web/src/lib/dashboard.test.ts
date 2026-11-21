import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedEvents,
  computeReadiness,
  dashboardBucket,
  RELEASE_STATES,
  type ReleaseState,
  type RolloutSummary,
  transition,
} from '@kiln/core';
import {
  attentionItems,
  attentionOf,
  attentionSummary,
  BUCKET_INFO,
  blockedCount,
  buildBoard,
  nextAction,
  readViewMode,
  STEPS,
  saveViewMode,
  VIEW_MODE_KEY,
} from './dashboard.ts';
import type { ReleaseLoad } from './portfolio.ts';
import type { AppSummary, PlanSummary, ReleaseSummary } from './types.ts';

let counter = 0;

function app(partial: Partial<AppSummary> = {}): AppSummary {
  counter += 1;
  return {
    id: `a${counter}`,
    name: 'Acme',
    platform: 'ios',
    identifier: 'com.acme.app',
    storeAppId: null,
    credentialId: 'c1',
    repositoryId: null,
    createdAt: 0,
    lastSyncedAt: 1_000,
    lastSyncAttemptAt: 1_000,
    lastSyncError: null,
    ...partial,
  };
}

function release(appId: string, partial: Partial<ReleaseSummary> = {}): ReleaseSummary {
  counter += 1;
  return {
    id: `r${counter}`,
    appId,
    platform: 'ios',
    version: '1.0.0',
    track: null,
    build: null,
    status: 'live',
    rawState: 'READY_FOR_SALE',
    rolloutFraction: null,
    versionCodes: null,
    storeUpdatedAt: null,
    syncedAt: 1_000,
    ...partial,
  };
}

const ready = (releases: ReleaseSummary[]): ReleaseLoad => ({ state: 'ready', releases });

function plan(appId: string, partial: Partial<PlanSummary> = {}): PlanSummary {
  counter += 1;
  return {
    id: `p${counter}`,
    appId,
    appName: 'Acme',
    appPlatform: 'ios',
    appIdentifier: 'com.acme.app',
    version: '1.0.0',
    platform: null,
    targetDate: null,
    blocked: false,
    blockedReason: null,
    notes: '',
    createdBy: 'u1',
    createdAt: 0,
    updatedAt: 0,
    released: false,
    due: { dueSoon: false, overdue: false, daysLeft: null },
    readiness: computeReadiness({
      items: [],
      notes: [{ locale: 'en-US', text: 'Fixes' }],
      platform: null,
    }),
    checklist: { total: 0, done: 0 },
    rollout: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------------------------

test('every state has a next action, and its event is one the lifecycle allows', () => {
  for (const platform of ['ios', 'android'] as const) {
    for (const state of RELEASE_STATES) {
      const step = STEPS[state];
      assert.ok(step[platform].length > 0, `${platform} ${state}`);
      if (step.event === null) {
        assert.deepEqual(allowedEvents(platform, state), [], `${state} is the end`);
      } else if (!(platform === 'ios' && state === 'propagating')) {
        // `propagating` only exists on Android; no iOS release is ever in it.
        assert.equal(
          transition(platform, state, step.event).ok,
          true,
          `${platform} ${state} ${step.event}`,
        );
      }
    }
  }
});

test('next action wording differs where the platforms differ', () => {
  const ios = nextAction({ platform: 'ios', status: 'ready' });
  const android = nextAction({ platform: 'android', status: 'ready' });
  assert.match(ios.text, /App Store Connect/);
  assert.match(android.text, /Play Console/);
  assert.equal(ios.kind, 'act');
  assert.equal(nextAction({ platform: 'ios', status: 'in_review' }).kind, 'wait');
  assert.equal(nextAction({ platform: 'android', status: 'live' }).kind, 'done');
  assert.match(nextAction({ platform: 'android', status: 'rolling_out' }).text, /staged rollout/);
  assert.match(nextAction({ platform: 'ios', status: 'rolling_out' }).text, /phased release/);
  assert.match(nextAction({ platform: 'ios', status: 'rejected' }).text, /rejection/);
  assert.match(nextAction({ platform: 'ios', status: 'halted' }).text, /resume/);
});

test('an unmapped state says to check the store, with the raw state', () => {
  const next = nextAction({ platform: 'ios', status: null, rawState: 'PENDING_CONTRACT' });
  assert.match(next.text, /PENDING_CONTRACT/);
  assert.match(nextAction({ platform: 'ios', status: null }).text, /Sync/);
});

test('a manual block comes first and names the reason; a rejection keeps the lifecycle text', () => {
  const blocked = nextAction({
    platform: 'ios',
    status: 'in_review',
    blocked: { kind: 'other', reason: 'Waiting for legal' },
  });
  assert.deepEqual(blocked, { kind: 'blocked', text: 'Resolve the block: Waiting for legal' });
  const rejected = nextAction({
    platform: 'ios',
    status: 'rejected',
    blocked: { kind: 'rejection', reason: 'The store rejected this version.' },
  });
  assert.equal(rejected.kind, 'act');
  assert.match(rejected.text, /fix the problem/);
});

test('while preparing, open required items and missing notes come before the lifecycle step', () => {
  const open = computeReadiness({
    items: [
      { required: true, done: false },
      { required: true, done: false },
    ],
    notes: [],
    platform: null,
  });
  assert.equal(
    nextAction({ platform: 'ios', status: 'draft', readiness: open }).text,
    'Finish the checklist: 2 required items left',
  );
  const one = computeReadiness({
    items: [{ required: true, done: false }],
    notes: [],
    platform: null,
  });
  assert.equal(
    nextAction({ platform: 'ios', status: 'ready', readiness: one }).text,
    'Finish the checklist: 1 required item left',
  );

  const noNotes = computeReadiness({ items: [], notes: [], platform: null });
  assert.equal(
    nextAction({ platform: 'ios', status: 'ready', readiness: noNotes }).text,
    'Write the release notes',
  );
  const missing = computeReadiness({
    items: [],
    notes: [
      { locale: 'de-DE', text: '' },
      { locale: 'en-US', text: 'x' },
    ],
    platform: null,
  });
  assert.equal(
    nextAction({ platform: 'android', status: 'ready', readiness: missing }).text,
    'Write the release notes for de-DE',
  );
  const long = computeReadiness({
    items: [],
    notes: [{ locale: 'en-US', text: 'x'.repeat(501) }],
    platform: null,
  });
  assert.match(
    nextAction({ platform: 'android', status: 'ready', readiness: long }).text,
    /Shorten/,
  );

  const fine = computeReadiness({
    items: [],
    notes: [{ locale: 'en-US', text: 'ok' }],
    platform: null,
  });
  assert.match(
    nextAction({ platform: 'ios', status: 'ready', readiness: fine }).text,
    /Submit it for review/,
  );
  // After submission the checklist no longer matters.
  assert.match(
    nextAction({ platform: 'ios', status: 'in_review', readiness: open }).text,
    /App Review/,
  );
});

test('a plan with no store version says to add the version', () => {
  const next = nextAction({ platform: 'android', status: null, planned: true });
  assert.match(next.text, /Play Console/);
  assert.match(
    nextAction({ platform: 'ios', status: null, planned: true }).text,
    /App Store Connect/,
  );
});

// ---------------------------------------------------------------------------------------------

test('buckets follow dashboardBucket and every column exists, in order', () => {
  const a = app();
  const releases: Record<string, ReleaseLoad> = {
    [a.id]: ready([release(a.id, { status: 'approved' })]),
  };
  const board = buildBoard({ apps: [a], releases, plans: null });
  assert.deepEqual(
    board.columns.map((c) => c.bucket),
    ['preparing', 'in_review', 'ready_to_release', 'live'],
  );
  assert.deepEqual(
    board.columns.map((c) => c.label),
    ['Preparing', 'In review', 'Ready to release', 'Live'],
  );
  assert.equal(BUCKET_INFO.live.label, 'Live');
  assert.deepEqual(
    board.columns.map((c) => c.cards.length),
    [0, 0, 1, 0],
  );

  for (const state of RELEASE_STATES) {
    const x = app();
    const b = buildBoard({
      apps: [x],
      releases: { [x.id]: ready([release(x.id, { status: state as ReleaseState })]) },
      plans: null,
    });
    const column = b.columns.find((c) => c.cards.length === 1);
    assert.equal(column?.bucket, dashboardBucket(state), state);
  }
});

test('iOS and Android of the same identifier are separate cards', () => {
  const ios = app({ platform: 'ios' });
  const android = app({ platform: 'android' });
  const board = buildBoard({
    apps: [android, ios],
    releases: {
      [ios.id]: ready([release(ios.id, { status: 'in_review', version: '2.0.0' })]),
      [android.id]: ready([
        release(android.id, {
          platform: 'android',
          status: 'rolling_out',
          version: '2.0.0',
          track: 'production',
          rolloutFraction: 0.2,
        }),
      ]),
    },
    plans: null,
  });
  const cards = board.columns.flatMap((c) => c.cards);
  assert.equal(cards.length, 2);
  assert.deepEqual(new Set(cards.map((c) => c.platform)), new Set(['ios', 'android']));
  assert.equal(board.columns[1]?.cards[0]?.platform, 'ios');
  const live = board.columns[3]?.cards[0];
  assert.equal(live?.platform, 'android');
  assert.equal(live?.rolloutFraction, 0.2);
  assert.match(live?.href ?? '', /^#\/portfolio\/a\d+\/release\/2\.0\.0$/);
});

test('the newest version decides the card; an older live version does not hide a newer one in review', () => {
  const a = app();
  const board = buildBoard({
    apps: [a],
    releases: {
      [a.id]: ready([
        release(a.id, { version: '1.9.0', status: 'live' }),
        release(a.id, { version: '1.10.0', status: 'in_review' }),
      ]),
    },
    plans: null,
  });
  assert.equal(board.columns[1]?.cards[0]?.version, '1.10.0');
  assert.equal(board.columns[3]?.cards.length, 0);
});

test('a rejected release is flagged blocked, with a reason', () => {
  const a = app();
  const board = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { status: 'rejected' })]) },
    plans: null,
  });
  const card = board.columns[1]?.cards[0];
  assert.equal(card?.blocked?.kind, 'rejection');
  assert.match(card?.blocked?.reason ?? '', /rejected/);
  assert.equal(blockedCount(board), 1);
});

test('a plan can block a release, with its reason, and carries the deadline flags', () => {
  const a = app();
  const p = plan(a.id, {
    version: '1.0.0',
    blocked: true,
    blockedReason: 'Waiting for legal',
    due: { dueSoon: false, overdue: true, daysLeft: -2 },
  });
  const board = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { status: 'ready' })]) },
    plans: [p],
  });
  const card = board.columns[0]?.cards[0];
  assert.deepEqual(card?.blocked, { kind: 'other', reason: 'Waiting for legal' });
  assert.equal(card?.due?.overdue, true);
  assert.equal(card?.planId, p.id);
  assert.equal(card?.next.kind, 'blocked');
  // A plan for another app or version does not leak onto the card.
  const other = plan('someone-else', { blocked: true, blockedReason: 'x' });
  const clean = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { status: 'ready' })]) },
    plans: [other],
  });
  assert.equal(clean.columns[0]?.cards[0]?.blocked, null);
});

test('a plan for a version the store does not have yet is a card in Preparing', () => {
  const a = app();
  const p = plan(a.id, { version: '2.0.0' });
  const board = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { version: '1.0.0', status: 'live' })]) },
    plans: [p],
  });
  assert.equal(board.columns[3]?.cards.length, 0);
  const card = board.columns[0]?.cards[0];
  assert.equal(card?.planned, true);
  assert.equal(card?.version, '2.0.0');
  // An older plan, or one already released, adds no card.
  const old = plan(a.id, { version: '0.9.0' });
  const done = plan(a.id, { version: '3.0.0', released: true });
  const quiet = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { status: 'live' })]) },
    plans: [old, done],
  });
  assert.equal(quiet.columns[3]?.cards.length, 1);
  assert.equal(quiet.columns[0]?.cards.length, 0);
});

test('apps without a card are listed with the reason', () => {
  const loading = app();
  const failed = app();
  const empty = app();
  const odd = app();
  const board = buildBoard({
    apps: [loading, failed, empty, odd],
    releases: {
      [failed.id]: { state: 'error' },
      [empty.id]: ready([]),
      [odd.id]: ready([release(odd.id, { status: null, rawState: 'WEIRD' })]),
    },
    plans: null,
  });
  assert.deepEqual(
    board.unplaced.map((u) => [u.app.id, u.reason, u.rawState]),
    [
      [loading.id, 'loading', null],
      [failed.id, 'error', null],
      [empty.id, 'no_releases', null],
      [odd.id, 'unmapped', 'WEIRD'],
    ],
  );
  assert.ok(board.columns.every((c) => c.cards.length === 0));
});

test('cards sort blocked first, then overdue, due soon, then by name', () => {
  const apps = ['Delta', 'Alpha', 'Bravo', 'Charlie'].map((name) => app({ name }));
  const [delta, , bravo, charlie] = apps as [AppSummary, AppSummary, AppSummary, AppSummary];
  const releases = Object.fromEntries(
    apps.map((a) => [a.id, ready([release(a.id, { status: 'draft' })])]),
  );
  const plans = [
    plan(delta.id, { blocked: true, blockedReason: 'x' }),
    plan(bravo.id, { due: { dueSoon: false, overdue: true, daysLeft: -1 } }),
    plan(charlie.id, { due: { dueSoon: true, overdue: false, daysLeft: 1 } }),
  ];
  const board = buildBoard({ apps, releases, plans });
  assert.deepEqual(
    board.columns[0]?.cards.map((c) => c.appName),
    ['Delta', 'Bravo', 'Charlie', 'Alpha'],
  );
});

// ---------------------------------------------------------------------------------------------

test('the view choice is remembered, defaults to the list and survives broken storage', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  assert.equal(readViewMode(storage), 'list');
  saveViewMode('board', storage);
  assert.equal(data.get(VIEW_MODE_KEY), 'board');
  assert.equal(readViewMode(storage), 'board');
  saveViewMode('list', storage);
  assert.equal(readViewMode(storage), 'list');
  data.set(VIEW_MODE_KEY, 'tiles');
  assert.equal(readViewMode(storage), 'list');

  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(readViewMode(broken), 'list');
  assert.doesNotThrow(() => saveViewMode('board', broken));
  // No localStorage at all (node): the list, and no throw.
  assert.equal(readViewMode(), 'list');
  assert.doesNotThrow(() => saveViewMode('board'));
});

// ---------------------------------------------------------------------------------------------
// Due soon and overdue

const summary = (partial: Partial<RolloutSummary> = {}): RolloutSummary => ({
  kind: 'steps',
  total: 5,
  done: 2,
  skipped: 0,
  planned: 3,
  planPercent: 5,
  current: { index: 2, percent: 5 },
  next: { id: 's3', index: 3, percent: 20, plannedAt: 1 },
  dueSteps: 0,
  nextPlannedAt: 1,
  ...partial,
});

test('attention: a plan with a passed deadline, a due rollout step or a close deadline is listed; others are not', () => {
  assert.equal(attentionOf(plan('a1')), null);
  assert.equal(
    attentionOf(plan('a1', { due: { dueSoon: false, overdue: false, daysLeft: 9 } })),
    null,
  );
  const overdue = attentionOf(plan('a1', { due: { dueSoon: false, overdue: true, daysLeft: -2 } }));
  assert.equal(overdue?.kind, 'overdue');
  assert.deepEqual(overdue?.reasons, ['Overdue by 2 days']);
  const soon = attentionOf(plan('a1', { due: { dueSoon: true, overdue: false, daysLeft: 1 } }));
  assert.equal(soon?.kind, 'due_soon');
  assert.deepEqual(soon?.reasons, ['Due in 1 day']);
  const step = attentionOf(plan('a1', { rollout: summary({ dueSteps: 2 }) }));
  assert.equal(step?.kind, 'rollout_due');
  assert.deepEqual(step?.reasons, ['2 rollout steps are past the planned time. Next: 20%.']);
  // Both: the most urgent is the kind, every reason is kept.
  const both = attentionOf(
    plan('a1', {
      due: { dueSoon: false, overdue: true, daysLeft: -1 },
      rollout: summary({ dueSteps: 1 }),
    }),
  );
  assert.equal(both?.kind, 'overdue');
  assert.equal(both?.reasons.length, 2);
  assert.match(both?.href ?? '', /release\/1\.0\.0$/);
  // A release that is out, and a phased release (no steps to be late), have none.
  assert.equal(
    attentionOf(
      plan('a1', { released: true, due: { dueSoon: false, overdue: true, daysLeft: -2 } }),
    ),
    null,
  );
  assert.equal(
    attentionOf(plan('a1', { rollout: summary({ kind: 'apple_phased', dueSteps: 0, total: 0 }) })),
    null,
  );
});

test('attention items are ordered overdue (longest first), rollout due, then due soon (soonest first)', () => {
  const a = plan('a1', { version: '1.0.0', due: { dueSoon: true, overdue: false, daysLeft: 2 } });
  const b = plan('a1', { version: '1.1.0', due: { dueSoon: true, overdue: false, daysLeft: 0 } });
  const c = plan('a1', { version: '1.2.0', due: { dueSoon: false, overdue: true, daysLeft: -1 } });
  const d = plan('a1', { version: '1.3.0', due: { dueSoon: false, overdue: true, daysLeft: -5 } });
  const e = plan('a1', { version: '1.4.0', rollout: summary({ dueSteps: 1 }) });
  const f = plan('a1', { version: '1.5.0' });
  const items = attentionItems([a, b, c, d, e, f]);
  assert.deepEqual(
    items.map((i) => i.version),
    ['1.3.0', '1.2.0', '1.4.0', '1.1.0', '1.0.0'],
  );
  assert.equal(attentionSummary(items), '2 overdue, 1 with a rollout step due, 2 due soon.');
  assert.equal(attentionSummary([]), '');
  assert.deepEqual(attentionItems([]), []);
});

test('board cards carry the rollout summary of their plan, none once the release is out', () => {
  const a = app();
  const p = plan(a.id, { version: '1.0.0', rollout: summary() });
  const live = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { version: '1.0.0', status: 'rolling_out' })]) },
    plans: [p],
  });
  assert.equal(live.columns.flatMap((c) => c.cards)[0]?.rollout?.done, 2);
  const out = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([release(a.id, { version: '1.0.0', status: 'live' })]) },
    plans: [{ ...p, released: true }],
  });
  assert.equal(out.columns.flatMap((c) => c.cards)[0]?.rollout, null);
  const planned = buildBoard({
    apps: [a],
    releases: { [a.id]: ready([]) },
    plans: [plan(a.id, { version: '2.0.0', rollout: summary() })],
  });
  assert.equal(planned.columns.flatMap((c) => c.cards)[0]?.rollout?.total, 5);
});
