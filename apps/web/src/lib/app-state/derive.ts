import { can, type Platform, platformLabel, type Role, supports } from '@kiln/core';
import type { AttentionItem } from '../app-attention.ts';
import { appAddress, type PlatformScope } from '../app-scope.ts';
import { t } from '../i18n/t.ts';
import {
  chooseNextStep,
  type NextStep,
  nextStepTrains,
  orderTrains,
  trainDest,
} from '../next-step.ts';
import type { LastPublish } from '../pending.ts';
import { type PromoteOption, promoteHref } from '../play-promote.ts';
import { headlineReason, partlyPublished } from '../publish-failure.ts';
import type { Publishing } from '../publishing.ts';
import { detailText, headlineText, disabledReason as publishingReason } from '../publishing.ts';
import type { Train } from '../release-trains.ts';
import { reviewUrl } from '../store-links.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import { candidateTrain } from './candidate-trains.ts';
import {
  analyzeCandidates,
  type CandidateAnalysis,
  buildsWithPipeline,
  pipelineIsObsolete,
  quietPipeline,
  releasesWithPipeline,
  SUPERSEDED_STATES,
} from './candidates.ts';
import {
  type ActionOffer,
  type AppFacts,
  type AppState,
  type CandidateView,
  type Elsewhere,
  type Flow,
  type FlowOther,
  type FlowRow,
  GUARDED_ACTIONS,
  type GuardedAction,
  type PendingFacts,
  type Phase,
  type PlatformState,
  type PrimaryAction,
  type Promotion,
  type StateNotice,
  type TopBarBadge,
  type Verdict,
  type VerdictCode,
} from './types.ts';

/**
 * `deriveAppState(facts, scope)`: the ONE answer to "what is true about this app" (docs/state-model.md). Pure.
 *
 * Priority of the phase, first that applies:
 *   publishing > publish_failed (until dismissed or a later success) > changes_pending > release flow (release_needs_you, in_review,
 *   release_running, ready_to_release) > idle. `unknown` stands in for ready_to_release and idle while the pending count is not read yet:
 *   "nothing is waiting" is never said about a count nobody has read.
 *
 * Hard invariants (tests/derive.test.ts runs them over every combination of the facts):
 *  - while a publish of a record in scope runs, no guarded action is on;
 *  - an undismissed failure never lets the card say "nothing is waiting", shows the failure and offers show_pending and publish_again;
 *    promote, release, submit, create_version, prepare_release and start_release are off with "Resolve the failed publish first";
 *  - a pending count above 0 never lets the card say "nothing is waiting", and the top bar shows it (pending, or failed, or publishing);
 *  - one count: the card, the badge and `pendingCount` are the same number, summed over the records in scope;
 *  - the scope filters everything: headline, actions, counts and badge look at the records in scope only (the rest is `elsewhere`);
 *  - a role without the right never gets an enabled guarded action.
 */

// ---------------------------------------------------------------------------------------------
// Scope

/** The records the scope holds: every record for `both`, else the records of that platform. */
export function scopeRecords(records: readonly AppSummary[], scope: PlatformScope): AppSummary[] {
  return records.filter((r) => scope === 'both' || r.platform === scope);
}

/** The scope that names exactly these records of the app (a page hands over the records it shows). */
export function scopeFor(
  records: readonly AppSummary[],
  scoped: readonly Pick<AppSummary, 'id' | 'platform'>[],
): PlatformScope {
  const first = scoped[0];
  if (first === undefined || scoped.length > 1) return 'both';
  return first.platform;
}

// ---------------------------------------------------------------------------------------------
// Verdicts, per record

/** The right each guarded action needs. `start_release` also needs a linked repository (see `verdictOf`). */
const RIGHT: Readonly<
  Record<
    GuardedAction,
    | 'store.publish'
    | 'store.push_draft'
    | 'changesets.write'
    | 'store.submit'
    | 'store.release'
    | 'releases.rollout'
    | 'ci.dispatch'
  >
> = {
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

/**
 * Actions a failed publish of the record holds back: they would act on a store state the failed publish left half written. `publish`
 * (publish again), `push`, `discard` and `rollout` stay: they are the way out, and halting or resuming a live rollout is never held
 * back by a failed draft push.
 */
const HELD_BY_FAILURE: ReadonlySet<GuardedAction> = new Set<GuardedAction>([
  'promote',
  'release',
  'submit',
  'create_version',
  'prepare_release',
  'start_release',
]);

const ok: Verdict = { enabled: true, code: 'ok', reason: null };
const no = (code: VerdictCode, reason: string): Verdict => ({ enabled: false, code, reason });

type RecordContext = {
  role: Role;
  record: AppSummary;
  /** The publish of this record. */
  publishing: Publishing | null;
  /** The failure of this record. */
  failure: LastPublish | null;
  /**
   * The first publish that runs on ANY record of the app, in scope or not: a record's actions are held back by its own publish and by
   * its siblings' (one batch writes the app's store state; nothing may write beside it, whatever platform the page shows). A failure
   * holds back its own record only: the staged content it left half written is per record.
   */
  appPublishing: Publishing | null;
  pending: PendingFacts;
  publishBatchEnabled: boolean | null;
  now: number;
};

/** Whether the action is one this record's store does at all (Play has tracks, Apple creates versions); null when it does. */
function unsupportedReason(action: GuardedAction, c: RecordContext): string | null {
  if (action === 'promote' && !supports(c.record.platform, 'releaseTracks'))
    return t('state:verdict.unsupportedPromote');
  if (action === 'create_version' && !supports(c.record.platform, 'versionCreation'))
    return t('state:verdict.unsupportedVersion');
  if (action === 'start_release' && c.record.repositoryId === null)
    return t('state:verdict.noRepository');
  return null;
}

/** The verdict of one action for one record. The order is the priority: publishing, unsupported, role, failure, then the action's own. */
export function verdictOf(action: GuardedAction, c: RecordContext): Verdict {
  // A running publish comes first: whatever the record or the role, nothing is written while the batch writes (the server answers 409).
  const running = c.publishing ?? c.appPublishing;
  if (running !== null) return no('publishing', publishingReason(running, c.now));
  const unsupported = unsupportedReason(action, c);
  if (unsupported !== null) return no('unsupported', unsupported);
  if (!can(c.role, RIGHT[action])) return no('role', t('state:verdict.role'));
  if (action === 'start_release' && !can(c.role, 'repositories.read'))
    return no('role', t('state:verdict.role'));
  if (c.failure !== null && HELD_BY_FAILURE.has(action))
    return no('publish_failed', t('state:verdict.publishFailed'));
  if (action === 'publish') {
    if (c.publishBatchEnabled === false) return no('switch_off', t('state:verdict.switchOff'));
    if (c.pending.count <= 0 && c.failure === null)
      return no('nothing_to_publish', t('state:verdict.nothingToPublish'));
  }
  return ok;
}

const CODE_ORDER: readonly VerdictCode[] = [
  'publishing',
  'publish_failed',
  'role',
  'switch_off',
  'nothing_to_publish',
  'unsupported',
  'no_platform',
  'ok',
];

/** The verdict over several records: off while any of them publishes or holds a failure that this action waits for; else on for all (publish: for any). */
function combine(action: GuardedAction, verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return no('no_platform', t('state:verdict.noPlatform'));
  const applicable = verdicts.filter((v) => v.code !== 'unsupported');
  if (applicable.length === 0) return verdicts[0] as Verdict;
  const block = (code: VerdictCode) => applicable.find((v) => v.code === code);
  const hard = block('publishing') ?? block('publish_failed') ?? block('role');
  if (hard !== undefined) return hard;
  if (action === 'publish') {
    const on = applicable.find((v) => v.enabled);
    if (on !== undefined) return on;
  }
  const off = applicable
    .filter((v) => !v.enabled)
    .sort((a, b) => CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code))[0];
  return off ?? ok;
}

function verdictsOf(c: RecordContext): Record<GuardedAction, Verdict> {
  const out = {} as Record<GuardedAction, Verdict>;
  for (const action of GUARDED_ACTIONS) out[action] = verdictOf(action, c);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Offers

const offerOf = (
  action: PrimaryAction,
  label: string,
  verdict: Verdict | null,
  extra: { appId?: string | null; href?: string | null; external?: boolean } = {},
): ActionOffer => ({
  action,
  label,
  enabled: verdict === null ? true : verdict.enabled,
  disabledReason: verdict === null || verdict.enabled ? null : verdict.reason,
  appId: extra.appId ?? null,
  href: extra.href ?? null,
  external: extra.external ?? false,
});

const NONE = (): ActionOffer => offerOf('none', '', null);

/** Which of the closed set of actions a train's button is, and the guarded action that decides whether it can be pressed. */
function trainAction(
  train: Pick<Train, 'button'>,
  external: boolean,
): { action: PrimaryAction; guard: GuardedAction | null } {
  if (external) return { action: 'follow_review', guard: null };
  if (train.button.action === 'create_release')
    return { action: 'create_release', guard: 'create_version' };
  if (train.button.page === 'release') return { action: 'open_release', guard: null };
  if (train.button.step === 'build') return { action: 'attach_build', guard: 'prepare_release' };
  return { action: 'prepare_release', guard: 'prepare_release' };
}

// ---------------------------------------------------------------------------------------------
// The state

const noPending: PendingFacts = { count: 0, blocking: 0 };
const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** The failure to show: not completed, not dismissed, and not while a newer publish of the record runs. */
export const activeFailure = (
  run: LastPublish | null | undefined,
  publishing: Publishing | null,
): LastPublish | null =>
  run != null && !run.completed && !run.dismissed && publishing === null ? run : null;

function recordContext(
  facts: AppFacts,
  record: AppSummary,
  appPublishing: Publishing | null = null,
): RecordContext {
  const publishing = facts.publishing[record.id] ?? null;
  const p = facts.pending[record.id] ?? noPending;
  return {
    role: facts.role,
    record,
    publishing,
    failure: activeFailure(facts.lastRun[record.id], publishing),
    appPublishing,
    pending: { count: whole(p.count), blocking: whole(p.blocking) },
    publishBatchEnabled: facts.publishBatchEnabled,
    now: facts.now,
  };
}

/** The phase of one release flow step (what the trains and the attention list say), once nothing above it applies. */
function flowPhase(step: NextStep, known: boolean): Phase {
  // A step that comes from a release candidate (a newer build in the store) has its own phases.
  const asked = step.kind === 'train' ? step.train?.candidate : undefined;
  if (asked === 'create_release') return 'candidate_ready';
  if (asked === 'attach_build' || asked === 'submit') return 'version_in_prep';
  if (step.kind === 'start' || step.kind === 'prepare')
    return known ? 'ready_to_release' : 'unknown';
  if (step.kind === 'idle') return known ? 'idle' : 'unknown';
  if (step.kind === 'attention') return 'release_needs_you';
  if (step.rows.length > 0) {
    if (step.rows.some((r) => r.urgent)) return 'release_needs_you';
    return step.rows.every((r) => r.waiting?.who === 'store') ? 'in_review' : 'release_running';
  }
  if (step.tone === 'bad' || step.waiting?.who === 'you') return 'release_needs_you';
  if (step.waiting?.who === 'store') return 'in_review';
  return 'release_running';
}

const toneOf = (
  phase: Phase,
  step: { tone: 'bad' | 'warn' | 'info' | 'neutral' } | null,
): AppState['tone'] => {
  if (phase === 'publish_failed') return 'bad';
  if (phase === 'changes_pending') return 'warn';
  if (phase === 'publishing') return 'info';
  return step === null ? 'neutral' : step.tone;
};

export function deriveAppState(facts: AppFacts, scope: PlatformScope): AppState {
  const scoped = scopeRecords(facts.records, scope);
  const outside = facts.records.filter((r) => scoped.indexOf(r) < 0);
  const appPublishing = facts.records.reduce<Publishing | null>(
    (found, r) => found ?? facts.publishing[r.id] ?? null,
    null,
  );
  const contexts = scoped.map((r) => recordContext(facts, r, appPublishing));
  const byApp: Record<string, RecordContext> = {};
  for (const c of contexts) byApp[c.record.id] = c;

  const publishing = contexts
    .filter((c) => c.publishing !== null)
    .map((c) => ({
      appId: c.record.id,
      platform: c.record.platform,
      name: c.record.name,
      entry: c.publishing as Publishing,
    }));
  const failures = contexts
    .filter((c) => c.failure !== null)
    .map((c) => ({
      appId: c.record.id,
      platform: c.record.platform,
      name: c.record.name,
      run: c.failure as LastPublish,
    }));
  const pendingCount = contexts.reduce((n, c) => n + c.pending.count, 0);
  const blockingCount = contexts.reduce((n, c) => n + c.pending.blocking, 0);
  const pendingKnown = facts.pendingKnown;

  const elsewhere: Elsewhere = { platforms: [], pendingCount: 0, publishing: false, failed: false };
  for (const r of outside) {
    const c = recordContext(facts, r);
    if (elsewhere.platforms.indexOf(r.platform) < 0) elsewhere.platforms.push(r.platform);
    elsewhere.pendingCount += c.pending.count;
    elsewhere.publishing = elsewhere.publishing || c.publishing !== null;
    elsewhere.failed = elsewhere.failed || c.failure !== null;
  }

  // Verdicts per record, then over the scope.
  const perRecord: Record<string, Record<GuardedAction, Verdict>> = {};
  for (const c of contexts) perRecord[c.record.id] = verdictsOf(c);
  const verdicts = {} as Record<GuardedAction, Verdict>;
  for (const action of GUARDED_ACTIONS)
    verdicts[action] = combine(
      action,
      contexts.map((c) => (perRecord[c.record.id] as Record<GuardedAction, Verdict>)[action]),
    );
  const verdictFor = (action: GuardedAction, platform?: Platform): Verdict => {
    if (platform === undefined) return verdicts[action];
    const c = contexts.find((x) => x.record.platform === platform);
    return c === undefined
      ? no('no_platform', t('state:verdict.noPlatform'))
      : (perRecord[c.record.id] as Record<GuardedAction, Verdict>)[action];
  };
  const verdictOfRecord = (action: GuardedAction, appId: string | null): Verdict => {
    const own = appId === null ? undefined : perRecord[appId];
    return own === undefined ? verdicts[action] : own[action];
  };

  // The candidates (candidates.ts): what is live, which build is the newest one that is newer, which versions are left behind. One
  // analysis per record, from the store versions, the store builds and the release pipeline; every surface reads this answer.
  const analyses: Record<string, CandidateAnalysis> = {};
  for (const r of facts.records) {
    const p = facts.pipelines[r.id] ?? null;
    analyses[r.id] = analyzeCandidates({
      appId: r.id,
      platform: r.platform,
      releases: releasesWithPipeline(r.id, r.platform, facts.releases[r.id], p),
      builds: buildsWithPipeline(r.platform, facts.builds?.[r.id], p),
    });
  }

  // The release flow: from the pipelines of the records in scope (never another platform's: Android never shows iOS's build). A pipeline
  // whose draft or build is left behind (not newer than what is live) says nothing; a version in Prepare or a build nobody took is the
  // candidate's step instead (one step, not two).
  const pipelines: {
    app: NonNullable<AppFacts['pipelines'][string]>['app'];
    pipeline: NonNullable<AppFacts['pipelines'][string]>['pipeline'];
  }[] = [];
  const leftBehind = new Set<string>();
  for (const r of facts.records) {
    let p = facts.pipelines[r.id];
    if (p == null) continue;
    const analysis = analyses[r.id] as CandidateAnalysis;
    if (pipelineIsObsolete(p, analysis)) {
      leftBehind.add(r.id);
      p = quietPipeline(p);
    } else if (analysis.plan !== null && SUPERSEDED_STATES.indexOf(p.pipeline.state) >= 0) continue;
    pipelines.push(p);
  }
  const platforms = scoped.map((r) => r.platform);
  const planTrains: Train[] = [];
  for (const r of scoped) {
    const plan = (analyses[r.id] as CandidateAnalysis).plan;
    if (plan !== null) planTrains.push(candidateTrain(plan, r.platform));
  }
  const trains = orderTrains([...nextStepTrains(pipelines, platforms), ...planTrains]);
  const scopedIds = scoped.map((r) => r.id);
  const heldAttention = (item: AttentionItem): boolean =>
    pendingCount > 0 && item.id.slice(-':staged'.length) === ':staged';
  const attention = facts.attention.filter(
    (item) =>
      scopedIds.some((id) => item.id.indexOf(`${id}:`) === 0) &&
      !heldAttention(item) &&
      // "Release left unfinished" about a version that is left behind is not news.
      !(item.id.slice(-':unfinished'.length) === ':unfinished' &&
        leftBehind.has(item.id.slice(0, item.id.length - ':unfinished'.length))),
  );
  const canStart =
    can(facts.role, 'ci.dispatch') &&
    can(facts.role, 'repositories.read') &&
    scoped.some((m) => m.repositoryId !== null);
  const canPrepare = can(facts.role, 'changesets.write') && scoped.length > 0;
  const recordById = (id: string) => facts.records.find((r) => r.id === id);
  const step = chooseNextStep({
    trains,
    attention,
    scope,
    canStart,
    canPrepare,
    reviewUrlOf: (appId) => {
      const r = recordById(appId);
      return r === undefined ? null : reviewUrl(r);
    },
  });

  // ---- Phase
  let phase: Phase;
  if (publishing.length > 0) phase = 'publishing';
  else if (failures.length > 0) phase = 'publish_failed';
  else if (pendingCount > 0) phase = 'changes_pending';
  else {
    phase = flowPhase(step, pendingKnown);
  }

  // ---- The flow as the card draws it (only when it has something of its own to say)
  let flow: Flow | null = null;
  if (
    phase !== 'publishing' &&
    phase !== 'publish_failed' &&
    (step.kind === 'train' || step.kind === 'attention')
  ) {
    const rows: FlowRow[] = step.rows.map((row) => {
      const train = trains.find((x) => x.key === row.key);
      const kind = train
        ? trainAction(train, row.external)
        : { action: 'open_release' as PrimaryAction, guard: null };
      return {
        ...row,
        offer: offerOf(
          kind.action,
          row.label,
          kind.guard === null ? null : verdictOfRecord(kind.guard, row.appId),
          {
            appId: row.appId,
            href: row.href,
            external: row.external,
          },
        ),
      };
    });
    const others: FlowOther[] = step.otherTrains.map((o, i) => {
      const train = trains[i + 1];
      const kind = train
        ? trainAction(train, o.external)
        : { action: 'open_release' as PrimaryAction, guard: null };
      return {
        title: o.title,
        text: o.text,
        offer: offerOf(
          kind.action,
          o.label,
          kind.guard === null ? null : verdictOfRecord(kind.guard, train?.button.appId ?? null),
          {
            appId: train?.button.appId ?? null,
            href: o.href,
            external: o.external,
          },
        ),
      };
    });
    flow = { step, rows, others };
  }

  // ---- The offer that leads the flow (the train's button, or Start / Prepare release)
  const flowPrimary = (): ActionOffer => {
    const p = step.primary;
    if (p === null) return NONE();
    if ('action' in p) {
      return p.action === 'start-release'
        ? offerOf('start_release', p.label, verdicts.start_release)
        : offerOf('prepare_release', p.label, verdicts.prepare_release);
    }
    const lead = trains[0];
    const external = p.external === true;
    const kind =
      step.kind === 'train' && lead
        ? trainAction(lead, external)
        : {
            action: external
              ? ('follow_review' as PrimaryAction)
              : ('open_release' as PrimaryAction),
            guard: null,
          };
    const appId = step.kind === 'train' && lead ? lead.button.appId : null;
    return offerOf(
      kind.action,
      p.label,
      kind.guard === null ? null : verdictOfRecord(kind.guard, appId),
      { appId, href: p.href, external },
    );
  };

  // ---- Promote (Google Play: a release in a testing track)
  let promotion: Promotion | null = null;
  if (can(facts.role, RIGHT.promote)) {
    for (const r of scoped) {
      if (!supports(r.platform, 'releaseTracks')) continue;
      const option = (analyses[r.id] as CandidateAnalysis).promote[0];
      if (option === undefined) continue;
      promotion = { option, offer: promoteOffer(option, verdictFor('promote', r.platform), r.id) };
      break;
    }
  }

  // ---- Candidates ("Ready to release"), the versions left behind and the quiet notices
  const candidates: CandidateView[] = [];
  const notices: StateNotice[] = [];
  const obsolete: AppState['obsolete'] = [];
  const analysisInScope: Record<string, CandidateAnalysis> = {};
  for (const r of scoped) {
    const analysis = analyses[r.id] as CandidateAnalysis;
    analysisInScope[r.id] = analysis;
    const plan = analysis.plan;
    if (plan !== null) {
      const train = planTrains.find((x) => x.appIds[0] === r.id);
      const dest = train === undefined ? null : trainDest(train, { scope, reviewUrlOf: undefined });
      const kind = train === undefined ? null : trainAction(train, false);
      if (train !== undefined && kind !== null && dest !== null)
        candidates.push({
          plan,
          appId: r.id,
          platform: r.platform,
          offer: offerOf(
            kind.action,
            train.button.label,
            kind.guard === null ? null : verdictOfRecord(kind.guard, r.id),
            { appId: r.id, href: dest.href },
          ),
        });
    }
    for (const o of analysis.obsolete) {
      obsolete.push(o);
      notices.push({
        kind: 'obsolete_version',
        appId: r.id,
        platform: r.platform,
        version: o.version,
        text: t('state:obsolete.notice', { version: o.version }),
        href: reviewUrl(r),
        linkLabel: supports(r.platform, 'releaseTracks')
          ? t('state:obsolete.linkPlay')
          : t('state:obsolete.linkApple'),
      });
    }
    if (analysis.processing !== null)
      notices.push({
        kind: 'build_processing',
        appId: r.id,
        platform: r.platform,
        version: analysis.processing.version,
        text: t('state:notice.processing', {
          build: analysis.processing.buildNumber,
          version: analysis.processing.version,
        }),
        href: null,
        linkLabel: null,
      });
  }

  // ---- The words, the primary action and the others
  const first = (list: { appId: string }[]): string =>
    list[0] ? list[0].appId : (scoped[0]?.id ?? '');
  const pendingHref = (appId: string) =>
    appAddress(appId, 'pending', scope === 'both' ? null : scope);
  const showPending = (label: string, appId: string): ActionOffer =>
    offerOf('show_pending', label, null, { appId, href: pendingHref(appId) });
  let headline: string;
  let reason: string;
  let primaryAction: ActionOffer;
  let secondaryActions: ActionOffer[] = [];

  if (phase === 'publishing') {
    const lead = publishing[0] as (typeof publishing)[number];
    headline = headlineText(lead.platform);
    reason = `${detailText(lead.entry, facts.now)} ${t('publish:publishing.pendingOff')}`;
    primaryAction = showPending(t('publish:publishing.showPending'), lead.appId);
  } else if (phase === 'publish_failed') {
    const lead = failures[0] as (typeof failures)[number];
    // A publish that was applied in part is said so: part of the app is in the store, part is not (not a plain failure where nothing changed).
    headline = failures.some((f) => partlyPublished(f.run, f.platform) !== null)
      ? t('state:failed.partlyHeadline')
      : t('state:failed.headline');
    reason = failureReason(failures, pendingCount);
    primaryAction = showPending(t('publish:publishing.showPending'), lead.appId);
    secondaryActions = [
      offerOf('publish_again', t('state:action.publishAgain'), verdicts.publish, {
        appId: lead.appId,
      }),
    ];
  } else if (phase === 'changes_pending') {
    headline = t('state:pending.headline', { count: pendingCount });
    reason =
      blockingCount > 0
        ? t('state:pending.blocking', { count: blockingCount })
        : t('state:pending.reason');
    const withChanges = contexts.find((c) => c.pending.count > 0);
    primaryAction = showPending(
      t('state:action.review'),
      withChanges ? withChanges.record.id : first([]),
    );
    const lead = flowPrimary();
    if (lead.action !== 'none') secondaryActions = [lead];
  } else if (phase === 'unknown') {
    headline = t('state:unknown.headline');
    reason = t('state:unknown.reason');
    primaryAction = NONE();
  } else {
    headline = step.title;
    reason = step.text;
    primaryAction = step.rows.length > 0 ? NONE() : flowPrimary();
  }

  // ---- Platforms
  const platformStates: PlatformState[] = contexts.map((c) => {
    let p: Phase;
    if (c.publishing !== null) p = 'publishing';
    else if (c.failure !== null) p = 'publish_failed';
    else if (c.pending.count > 0) p = 'changes_pending';
    else
      p =
        phase === 'publishing' || phase === 'publish_failed' || phase === 'changes_pending'
          ? 'idle'
          : phase;
    return {
      platform: c.record.platform,
      appId: c.record.id,
      name: c.record.name,
      phase: p,
      pending: c.pending,
      publishing: c.publishing,
      failure: c.failure,
      verdicts: perRecord[c.record.id] as Record<GuardedAction, Verdict>,
    };
  });

  // ---- The badge of the top bar
  let badge: TopBarBadge;
  if (publishing.length > 0)
    badge = {
      kind: 'publishing',
      count: pendingCount,
      appId: (publishing[0] as (typeof publishing)[number]).appId,
      elsewhere: false,
    };
  else if (failures.length > 0)
    badge = {
      kind: 'failed',
      count: pendingCount,
      appId: (failures[0] as (typeof failures)[number]).appId,
    };
  else if (pendingCount > 0)
    badge = { kind: 'pending', count: pendingCount, blocking: blockingCount > 0 };
  else badge = { kind: 'idle' };

  return {
    scope,
    platforms: platformStates,
    phase,
    tone: toneOf(
      phase,
      phase === 'release_needs_you' ||
        phase === 'in_review' ||
        phase === 'release_running' ||
        phase === 'ready_to_release' ||
        phase === 'idle'
        ? step
        : null,
    ),
    headline,
    reason,
    primaryAction,
    secondaryActions,
    badge,
    pendingCount,
    blockingCount,
    pendingKnown,
    publishing,
    failures,
    flow,
    rest: step.items,
    promotion,
    candidates,
    obsolete,
    notices,
    analysis: analysisInScope,
    elsewhere,
    verdicts,
    canDo: verdictFor,
  };
}

/** The offer of "Promote to production": its label, the verdict of that record, and the address that opens Prepare release. */
export function promoteOffer(option: PromoteOption, verdict: Verdict, appId: string): ActionOffer {
  return offerOf('promote', option.label, verdict, { appId, href: promoteHref(option) });
}

/**
 * What a release row of the Releases table offers for ITS release: the promote offer of that record, or null (not promotable, newer than
 * production it is not, or no right). The option comes from the candidate analysis: the table decides nothing.
 */
export function promoteOfferFor(
  state: Pick<AppState, 'canDo' | 'analysis'>,
  role: Role,
  release: Pick<ReleaseSummary, 'appId' | 'platform' | 'track' | 'version'>,
): Promotion | null {
  if (!can(role, RIGHT.promote)) return null;
  const option = (state.analysis[release.appId]?.promote ?? []).find(
    (o) => o.from === release.track && o.version === release.version,
  );
  if (option === undefined) return null;
  return {
    option,
    offer: promoteOffer(option, state.canDo('promote', release.platform), release.appId),
  };
}

function failureReason(
  failures: readonly { platform: Platform; run: LastPublish }[],
  pendingCount: number,
): string {
  const lines: string[] = [];
  for (const f of failures) {
    const partly = partlyPublished(f.run, f.platform);
    const why = [partly?.sentence ?? '', headlineReason(f.run) || t('state:failed.reasonUnknown')]
      .filter((x) => x !== '')
      .join(' ');
    lines.push(failures.length > 1 ? `${platformLabel(f.platform)}: ${why}` : why);
  }
  if (failures.some((f) => f.run.results.some((r) => r.outcome === 'unknown')))
    lines.push(t('state:failed.checkStore'));
  if (pendingCount > 0) lines.push(t('state:failed.kept', { count: pendingCount }));
  return lines.join(' ');
}

// ---------------------------------------------------------------------------------------------
// The top bar

/**
 * The badge of the top bar. A publish anywhere in the workspace outranks everything (the button follows it, with the open app's count
 * kept); then the open app's own badge (failed, pending). `other` is the first record of ANOTHER app that publishes, or null.
 */
export function deriveTopBar(
  state: AppState | null,
  other: string | null,
  workspaceCount = 0,
): TopBarBadge {
  if (state !== null && state.badge.kind === 'publishing') return state.badge;
  if (other !== null)
    return {
      kind: 'publishing',
      count: state === null ? workspaceCount : state.pendingCount,
      appId: other,
      elsewhere: true,
    };
  return state === null ? { kind: 'idle' } : state.badge;
}
