import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, type Platform, type Role } from '@kiln/core';
import type { PlatformScope } from '../app-scope.ts';
import type { LastPublish } from '../pending.ts';
import { deriveAppState, deriveTopBar, scopeRecords } from './derive.ts';
import {
  ANDROID,
  dismissedRun,
  facts,
  failedRun,
  type FlowKind,
  internalTesting,
  IOS,
  pipelineOf,
  running,
  unknownRun,
} from './fixtures.ts';
import {
  type AppFacts,
  type AppState,
  GUARDED_ACTIONS,
  type GuardedAction,
  PRIMARY_ACTIONS,
  type ActionOffer,
} from './types.ts';

/**
 * The invariants of the model, checked over the cartesian product of the fact dimensions (docs/state-model.md): pending x publishing x
 * last run x release flow x promotable release x pending known x scope x role. Every combination is generated in code and asserted;
 * a failure names the combination. A new fact dimension belongs here.
 */

const RIGHT: Record<GuardedAction, Parameters<typeof can>[1]> = {
  publish: 'store.publish',
  push: 'store.push_draft',
  discard: 'changesets.write',
  submit: 'store.submit',
  release: 'store.release',
  promote: 'store.release',
  create_version: 'store.push_draft',
  rollout: 'releases.rollout',
  prepare_release: 'changesets.write',
  start_release: 'ci.dispatch',
};
/** The guarded action behind an offer (null: it only reads or links). */
const GUARD: Partial<Record<ActionOffer['action'], GuardedAction>> = {
  publish_again: 'publish',
  promote: 'promote',
  start_release: 'start_release',
  prepare_release: 'prepare_release',
  attach_build: 'prepare_release',
};
const HELD: GuardedAction[] = ['promote', 'release', 'submit', 'create_version', 'prepare_release', 'start_release'];

type Run = 'none' | 'failed' | 'dismissed' | 'unknown';
const runOf = (kind: Run, platform: Platform): LastPublish | null =>
  kind === 'none' ? null : kind === 'failed' ? failedRun(platform) : kind === 'dismissed' ? dismissedRun(platform) : unknownRun(platform);

type Combo = {
  pendingIos: number;
  pendingAndroid: number;
  blocking: number;
  publishingIos: boolean;
  publishingAndroid: boolean;
  runIos: Run;
  runAndroid: Run;
  flowIos: FlowKind;
  flowAndroid: FlowKind;
  promotable: boolean;
  known: boolean;
  scope: PlatformScope;
  role: Role;
};

const label = (c: Combo): string => JSON.stringify(c);

function build(c: Combo): AppFacts {
  return facts({
    role: c.role,
    pending: { [IOS.id]: { count: c.pendingIos, blocking: c.blocking }, [ANDROID.id]: { count: c.pendingAndroid, blocking: 0 } },
    pendingKnown: c.known,
    publishing: { [IOS.id]: c.publishingIos ? running() : null, [ANDROID.id]: c.publishingAndroid ? running() : null },
    lastRun: { [IOS.id]: runOf(c.runIos, 'ios'), [ANDROID.id]: runOf(c.runAndroid, 'android') },
    releases: { [ANDROID.id]: c.promotable ? [internalTesting()] : [] },
    pipelines: { [IOS.id]: pipelineOf(IOS, c.flowIos), [ANDROID.id]: pipelineOf(ANDROID, c.flowAndroid) },
  });
}

/** What is true in scope, computed here from the facts, independently of the model. */
function expected(c: Combo) {
  const ids = scopeRecords([IOS, ANDROID], c.scope).map((r) => r.id);
  const has = (id: string) => ids.indexOf(id) >= 0;
  const publishing = (has(IOS.id) && c.publishingIos) || (has(ANDROID.id) && c.publishingAndroid);
  const failed = (id: string, publishingNow: boolean, run: Run) => has(id) && run !== 'none' && run !== 'dismissed' && !publishingNow;
  const failure = failed(IOS.id, c.publishingIos, c.runIos) || failed(ANDROID.id, c.publishingAndroid, c.runAndroid);
  const pending = (has(IOS.id) ? c.pendingIos : 0) + (has(ANDROID.id) ? c.pendingAndroid : 0);
  return { ids, publishing, failure, pending };
}

function check(c: Combo, s: AppState): void {
  const e = expected(c);
  const at = label(c);
  const fail = (what: string) => assert.fail(`${what}\n  ${at}\n  phase=${s.phase} headline="${s.headline}" primary=${s.primaryAction.action}`);

  // Priority: publishing > publish_failed > changes_pending > the release flow.
  if (e.publishing) {
    if (s.phase !== 'publishing') fail('a publish runs in scope: the phase must be publishing');
  } else if (e.failure) {
    if (s.phase !== 'publish_failed') fail('an undismissed failure in scope: the phase must be publish_failed');
  } else if (e.pending > 0) {
    if (s.phase !== 'changes_pending') fail('changes pending in scope: the phase must be changes_pending');
  } else if (['publishing', 'publish_failed', 'changes_pending'].indexOf(s.phase) >= 0) fail('a phase above the flow without its fact');

  // One count.
  if (s.pendingCount !== e.pending) fail(`pendingCount ${s.pendingCount} != ${e.pending}`);
  if (s.platforms.reduce((n, p) => n + p.pending.count, 0) !== e.pending) fail('the platforms do not add up to the count');
  const badge = s.badge;
  if ((badge.kind === 'pending' || badge.kind === 'failed' || badge.kind === 'publishing') && badge.count !== e.pending) fail('the badge shows another count');

  // The badge is never idle while something is pending, running or failed in scope.
  if (e.publishing && badge.kind !== 'publishing') fail('top bar must show publishing');
  if (!e.publishing && e.failure && badge.kind !== 'failed') fail('top bar must show failed');
  if (!e.publishing && !e.failure && e.pending > 0 && badge.kind !== 'pending') fail('top bar must show the pending count');
  if (!e.publishing && !e.failure && e.pending === 0 && badge.kind !== 'idle') fail('top bar idle only when nothing happens');

  // "Nothing is waiting" is only said when nothing is waiting, and the count was read.
  const nothing = /nothing is waiting/i.test(s.headline);
  if (nothing && (e.publishing || e.failure || e.pending > 0 || !c.known)) fail('"Nothing is waiting" said while something is');
  if (!c.known && (s.phase === 'ready_to_release' || s.phase === 'idle')) fail('ready_to_release / idle with an unread count');

  // The failure speaks.
  if (s.phase === 'publish_failed') {
    if (s.headline !== 'The last publish failed') fail('failure headline');
    if (s.primaryAction.action !== 'show_pending' || !s.primaryAction.enabled) fail('failure: primary must be show_pending, on');
    const again = s.secondaryActions.find((a) => a.action === 'publish_again');
    if (again === undefined) fail('failure: publish_again must be offered');
    if (s.failures.length === 0 || s.reason === '') fail('failure: the reason must be shown');
    for (const p of s.platforms) {
      if (p.failure === null) continue;
      for (const a of HELD) if (p.verdicts[a].enabled) fail(`failure: ${a} must be off for ${p.platform}`);
      for (const a of HELD) if (p.verdicts[a].code !== 'publish_failed' && p.verdicts[a].code !== 'role' && p.verdicts[a].code !== 'unsupported') fail(`failure: ${a} off for another reason`);
    }
    const promo = s.promotion;
    if (promo && promo.offer.enabled && s.platforms.some((p) => p.failure !== null && p.appId === promo.option.appId)) fail('promote on a failed app');
    if (s.flow !== null) fail('failure: the release flow must not speak over it');
  }

  // A failure holds the same actions back on every record in scope (the card speaks for the scope).
  if (s.phase === 'publish_failed') {
    for (const p of s.platforms) for (const a of HELD) if (p.verdicts[a].enabled) fail(`failure: ${a} on for ${p.platform} while the scope has a failed publish`);
    for (const a of HELD) if (s.verdicts[a].enabled) fail(`failure: ${a} on over the scope`);
  }

  // Publishing: nothing mutates, anywhere.
  if (s.phase === 'publishing') {
    for (const a of GUARDED_ACTIONS) if (s.verdicts[a].enabled) fail(`publishing: ${a} must be off`);
    for (const p of s.platforms) if (p.publishing !== null) for (const a of GUARDED_ACTIONS) if (p.verdicts[a].enabled) fail(`publishing: ${a} on for the record that publishes`);
    if (s.primaryAction.action !== 'show_pending') fail('publishing: primary is show_pending');
    if (s.secondaryActions.length > 0) fail('publishing: no secondary action');
    if (s.promotion?.offer.enabled) fail('publishing: promote on');
    if (s.flow !== null) fail('publishing: flow shown');
  }
  // The same, per record, whatever the phase (the server answers 409 for each of these).
  for (const p of s.platforms) if (p.publishing !== null) for (const a of GUARDED_ACTIONS) if (p.verdicts[a].enabled) fail(`${a} on while ${p.platform} publishes`);

  // Pending speaks.
  if (s.phase === 'changes_pending') {
    if (s.headline.indexOf(String(e.pending)) < 0) fail('changes_pending: the headline names the count');
    if (s.primaryAction.action !== 'show_pending') fail('changes_pending: primary is show_pending');
  }

  // Scope.
  for (const p of s.platforms) if (e.ids.indexOf(p.appId) < 0) fail('a platform outside the scope is in the state');
  if (s.platforms.length !== e.ids.length) fail('every record in scope has a state');
  for (const f of s.failures) if (e.ids.indexOf(f.appId) < 0) fail('a failure outside the scope');
  for (const p of s.publishing) if (e.ids.indexOf(p.appId) < 0) fail('a publish outside the scope');
  const offers: ActionOffer[] = [s.primaryAction, ...s.secondaryActions];
  if (s.flow) for (const r of s.flow.rows) offers.push(r.offer);
  if (s.flow) for (const o of s.flow.others) offers.push(o.offer);
  if (s.promotion) offers.push(s.promotion.offer);
  for (const o of offers) if (o.appId !== null && e.ids.indexOf(o.appId) < 0) fail(`an offer for a record outside the scope (${o.action})`);
  if (s.flow) for (const r of s.flow.rows) for (const pl of r.platforms) if (scopeRecords([IOS, ANDROID], c.scope).every((x) => x.platform !== pl)) fail('a train of another platform');
  const out = [IOS, ANDROID].filter((r) => e.ids.indexOf(r.id) < 0);
  const outPending = out.reduce((n, r) => n + (r.id === IOS.id ? c.pendingIos : c.pendingAndroid), 0);
  if (s.elsewhere.pendingCount !== outPending) fail('elsewhere count');

  // Offers: closed enum, honest reasons, never enabled against a verdict or a role.
  for (const o of offers) {
    if (PRIMARY_ACTIONS.indexOf(o.action) < 0) fail(`unknown action ${o.action}`);
    if (o.enabled && o.disabledReason !== null) fail('an enabled offer carries a reason');
    if (!o.enabled && (o.disabledReason ?? '') === '') fail(`a disabled offer (${o.action}) without a reason`);
    const guard = GUARD[o.action];
    if (guard !== undefined && o.enabled) {
      const own = o.appId === null ? undefined : s.platforms.find((p) => p.appId === o.appId);
      const verdict = own ? own.verdicts[guard] : s.verdicts[guard];
      if (!verdict.enabled) fail(`${o.action} offered on against its verdict`);
    }
  }

  // Role: no right, no enabled mutating action.
  for (const a of GUARDED_ACTIONS) {
    if (can(c.role, RIGHT[a])) continue;
    if (s.verdicts[a].enabled) fail(`${a} on for ${c.role}`);
    for (const p of s.platforms) if (p.verdicts[a].enabled) fail(`${a} on for ${c.role} on ${p.platform}`);
  }
  for (const o of offers) {
    const guard = GUARD[o.action];
    if (guard !== undefined && o.enabled && !can(c.role, RIGHT[guard])) fail(`${o.action} on for ${c.role}`);
  }
  if (s.canDo('promote', 'android').enabled !== (s.platforms.find((p) => p.platform === 'android')?.verdicts.promote.enabled ?? false)) fail('canDo and verdicts disagree');
  if (s.canDo('push', 'macos' as Platform).code !== 'no_platform') fail('a platform the app does not have is no_platform');
  if (s.canDo('publish', 'ios').enabled && !s.platforms.some((p) => p.platform === 'ios')) fail('canDo for a platform outside the scope');

  // The top bar from the same state.
  const bar = deriveTopBar(s, null);
  if (JSON.stringify(bar) !== JSON.stringify(s.badge)) fail('deriveTopBar(state) differs from the badge');
}

const SCOPES: PlatformScope[] = ['ios', 'android', 'both'];
const ROLES: Role[] = ['owner', 'member', 'viewer'];
const RUNS: Run[] = ['none', 'failed', 'dismissed', 'unknown'];
const FLOWS: FlowKind[] = ['none', 'needs_you', 'in_review', 'running', 'rejected'];

function* combos(): Generator<Combo> {
  for (const role of ROLES)
    for (const scope of SCOPES)
      for (const known of [true, false])
        for (const pendingIos of [0, 7])
          for (const pendingAndroid of [0, 29]) {
            const blocking = pendingAndroid > 0 && pendingIos > 0 ? 2 : 0;
            for (const publishingIos of [false, true])
              for (const publishingAndroid of [false, true])
                for (const runIos of RUNS)
                  for (const runAndroid of RUNS)
                    for (const flowIos of ['none', 'needs_you', 'in_review'] as FlowKind[])
                      for (const flowAndroid of FLOWS)
                        for (const promotable of [false, true])
                          yield { pendingIos, pendingAndroid, blocking, publishingIos, publishingAndroid, runIos, runAndroid, flowIos, flowAndroid, promotable, known, scope, role };
          }
}

test('every combination of the facts keeps every invariant', () => {
  let n = 0;
  for (const c of combos()) {
    const s = deriveAppState(build(c), c.scope);
    check(c, s);
    n += 1;
  }
  assert.ok(n > 50_000, `the product is big enough to mean something (${n})`);
});

test('deriving twice from the same facts gives the same answer (pure, no hidden state)', () => {
  const f = build({ pendingIos: 7, pendingAndroid: 29, blocking: 2, publishingIos: false, publishingAndroid: false, runIos: 'none', runAndroid: 'failed', flowIos: 'needs_you', flowAndroid: 'in_review', promotable: true, known: true, scope: 'both', role: 'owner' });
  const strip = (s: AppState) => JSON.stringify({ ...s, canDo: undefined });
  assert.equal(strip(deriveAppState(f, 'both')), strip(deriveAppState(f, 'both')));
});

test('the dimensions are not all the same: the product reaches every phase', () => {
  const seen = new Set<string>();
  for (const c of combos()) seen.add(deriveAppState(build(c), c.scope).phase);
  for (const phase of ['publishing', 'publish_failed', 'changes_pending', 'release_needs_you', 'in_review', 'release_running', 'ready_to_release', 'idle', 'unknown'])
    assert.ok(seen.has(phase), `no combination reaches ${phase}`);
});
