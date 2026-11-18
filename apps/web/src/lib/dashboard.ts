import {
  type Blocked,
  DASHBOARD_BUCKETS,
  type DashboardBucket,
  type DueFlags,
  type Platform,
  type Readiness,
  type ReleaseEvent,
  type ReleaseState,
  type RolloutSummary,
  dashboardBucket,
  formatPercent,
} from '@mrm/core';
import { appHref, compareVersions, latestRelease, type ReleaseLoad } from './portfolio.ts';
import { dueText, releaseHref } from './release.ts';
import type { AppSummary, PlanSummary } from './types.ts';

// ---------------------------------------------------------------------------------------------
// View choice, remembered in this browser

export type ViewMode = 'list' | 'board';

export const VIEW_MODE_KEY = 'mrm.portfolio.view';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** The saved view, or the list. Storage that is missing or throws (private mode, blocked) gives the list. */
export function readViewMode(storage?: ReadableStorage): ViewMode {
  try {
    const store = storage ?? globalThis.localStorage;
    return store.getItem(VIEW_MODE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

/** Remembers the view. A failure to save is ignored: the choice still applies for this visit. */
export function saveViewMode(mode: ViewMode, storage?: WritableStorage): void {
  try {
    (storage ?? globalThis.localStorage).setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

// ---------------------------------------------------------------------------------------------
// Columns

export const BUCKET_INFO: Record<DashboardBucket, { label: string; description: string }> = {
  preparing: { label: 'Preparing', description: 'Being prepared: no build chosen yet, or ready to submit.' },
  in_review: { label: 'In review', description: 'Submitted and waiting, or rejected and waiting for a fix.' },
  ready_to_release: { label: 'Ready to release', description: 'Approved and waiting to be released.' },
  live: { label: 'Live', description: 'Rolling out, live or halted.' },
};

// ---------------------------------------------------------------------------------------------
// The next action, from the lifecycle

export type NextAction = {
  /** `act`: a person does it (in the store console or here). `wait`: the store does. */
  kind: 'act' | 'wait' | 'done' | 'blocked';
  text: string;
};

type Step = {
  /** The lifecycle event this action leads to; null at the end of the road. */
  event: ReleaseEvent | null;
  kind: 'act' | 'wait' | 'done';
  ios: string;
  android: string;
};

const both = (text: string) => ({ ios: text, android: text });

/**
 * What to do next for each state. Every `event` is one the state machine in @mrm/core allows from
 * that state (a test checks it), so this table cannot drift from the lifecycle. The store consoles
 * are where these actions happen: this product writes nothing to a store.
 */
export const STEPS: Record<ReleaseState, Step> = {
  draft: { event: 'choose_build', kind: 'act', ...both('Choose the build to submit') },
  build_chosen: { event: 'mark_ready', kind: 'act', ...both('Finish the checklist, then mark it ready') },
  ready: {
    event: 'submit',
    kind: 'act',
    ios: 'Submit it for review in App Store Connect',
    android: 'Send it for review in Google Play Console',
  },
  in_review: {
    event: 'approve',
    kind: 'wait',
    ios: 'Wait for App Review',
    android: 'Wait for the Google Play review',
  },
  rejected: { event: 'fix', kind: 'act', ...both('Read the rejection, fix the problem and submit again') },
  approved: {
    event: 'release',
    kind: 'act',
    ios: 'Release it in App Store Connect',
    android: 'Start the rollout in Google Play Console',
  },
  propagating: { event: 'propagated', kind: 'wait', ...both('Wait for Google Play to show the release') },
  rolling_out: {
    event: 'complete',
    kind: 'wait',
    ios: 'Watch the phased release until it reaches everyone',
    android: 'Watch the staged rollout and raise it to everyone when it looks healthy',
  },
  live: { event: null, kind: 'done', ...both('Nothing to do. Plan the next version.') },
  halted: { event: 'resume', kind: 'act', ...both('Decide whether to resume the rollout or ship a fix') },
};

export type NextActionInput = {
  platform: Platform;
  /** The normalized state, or null when the store's state has no mapping. */
  status: ReleaseState | null;
  rawState?: string | null;
  /** True when the store has no such version yet and only a plan exists. */
  planned?: boolean;
  blocked?: Blocked | null;
  readiness?: Pick<Readiness, 'required' | 'notes'> | null;
};

const PREPARING: readonly ReleaseState[] = ['draft', 'build_chosen', 'ready'];

/**
 * One sentence for what happens next. A manual block comes first, then (while the release is still
 * being prepared) the open checklist and missing release notes, then the lifecycle step. It tells
 * a person what to do; it never does it.
 */
export function nextAction(input: NextActionInput): NextAction {
  const { blocked, readiness } = input;
  // A rejection is the lifecycle's own "rejected" step, which already says what to do.
  if (blocked && blocked.kind !== 'rejection') {
    return { kind: 'blocked', text: `Resolve the block: ${blocked.reason}` };
  }
  if (input.planned) {
    const where = input.platform === 'ios' ? 'App Store Connect' : 'Google Play Console';
    const prepare = prepareText(readiness);
    return prepare ?? { kind: 'act', text: `Add the version in ${where} and choose a build` };
  }
  if (input.status === null) {
    const raw = input.rawState?.trim();
    return { kind: 'act', text: raw ? `Check the store: it reports “${raw}”, which has no status here` : 'Sync the app to read its state from the store' };
  }
  if (PREPARING.includes(input.status)) {
    const prepare = prepareText(readiness);
    if (prepare) return prepare;
  }
  const step = STEPS[input.status];
  return { kind: step.kind, text: step[input.platform] };
}

function prepareText(readiness: NextActionInput['readiness']): NextAction | null {
  if (!readiness) return null;
  const open = readiness.required.open;
  if (open > 0) {
    return { kind: 'act', text: `Finish the checklist: ${open} required ${open === 1 ? 'item' : 'items'} left` };
  }
  const { notes } = readiness;
  if (notes.locales === 0) return { kind: 'act', text: 'Write the release notes' };
  if (notes.missing.length > 0) return { kind: 'act', text: `Write the release notes for ${notes.missing.join(', ')}` };
  if (notes.tooLong.length > 0) return { kind: 'act', text: `Shorten the release notes for ${notes.tooLong.join(', ')}` };
  return null;
}

// ---------------------------------------------------------------------------------------------
// The board

export type BoardCard = {
  /** Unique: an app (one platform) and a version. */
  key: string;
  appId: string;
  appName: string;
  platform: Platform;
  identifier: string;
  version: string;
  track: string | null;
  build: string | null;
  status: ReleaseState | null;
  rawState: string | null;
  rolloutFraction: number | null;
  /** Only a plan exists; the store has no such version yet. */
  planned: boolean;
  blocked: Blocked | null;
  due: DueFlags | null;
  /** The staged rollout plan in short (planning data); null when the plan has none. */
  rollout: RolloutSummary | null;
  planId: string | null;
  readiness: Readiness | null;
  lastSyncedAt: number | null;
  syncError: string | null;
  next: NextAction;
  /** The release page for this version. */
  href: string;
};

export type BoardColumn = {
  bucket: DashboardBucket;
  label: string;
  description: string;
  cards: BoardCard[];
};

export type UnplacedReason = 'loading' | 'error' | 'no_releases' | 'unmapped';

/** An app with no card yet, and why: its releases are loading, failed, absent, or in a state with no mapping. */
export type Unplaced = {
  app: AppSummary;
  reason: UnplacedReason;
  rawState: string | null;
  href: string;
};

export type Board = { columns: BoardColumn[]; unplaced: Unplaced[] };

const REJECTED_BLOCK: Blocked = { kind: 'rejection', reason: 'The store rejected this version.' };

function blockOf(plan: PlanSummary | undefined, status: ReleaseState | null): Blocked | null {
  if (plan?.blocked) return { kind: 'other', reason: plan.blockedReason?.trim() || 'No reason was given.' };
  return status === 'rejected' ? REJECTED_BLOCK : null;
}

/** Blocked first, then overdue, then due soon, then by name (iOS before Android), then id. */
export function compareCards(a: BoardCard, b: BoardCard): number {
  const rank = (c: BoardCard) => (c.blocked ? 0 : c.due?.overdue ? 1 : c.due?.dueSoon ? 2 : 3);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const byName = a.appName.localeCompare(b.appName, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  if (a.platform !== b.platform) return a.platform === 'ios' ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Groups every app by where its newest version is in the lifecycle: one card per app and platform
 * (iOS and Android of one identifier are two apps, so two cards), in the four dashboard buckets.
 * A plan for a version the store does not have yet shows as a card of its own in Preparing. Plans
 * are optional: with `plans` null the board shows the stores' state only.
 */
export function buildBoard(input: {
  apps: readonly AppSummary[];
  releases: Record<string, ReleaseLoad | undefined>;
  plans: readonly PlanSummary[] | null;
}): Board {
  const columns: BoardColumn[] = DASHBOARD_BUCKETS.map((bucket) => ({ bucket, ...BUCKET_INFO[bucket], cards: [] }));
  const unplaced: Unplaced[] = [];
  const place = (card: BoardCard, bucket: DashboardBucket) => {
    columns.find((c) => c.bucket === bucket)?.cards.push(card);
  };

  for (const app of input.apps) {
    const load = input.releases[app.id];
    const unplace = (reason: UnplacedReason, rawState: string | null = null) =>
      unplaced.push({ app, reason, rawState, href: appHref(app.id) });
    if (!load || load.state === 'loading') {
      unplace('loading');
      continue;
    }
    if (load.state === 'error') {
      unplace('error');
      continue;
    }
    const plans = (input.plans ?? []).filter((p) => p.appId === app.id);
    const latest = latestRelease(load.releases, app.platform);
    const known = new Set(load.releases.map((r) => r.version));
    const planned = plans
      .filter((p) => !known.has(p.version) && !p.released && (latest === null || compareVersions(p.version, latest.version) > 0))
      .sort((a, b) => compareVersions(b.version, a.version))[0];

    const common = {
      appId: app.id,
      appName: app.name,
      platform: app.platform,
      identifier: app.identifier,
      lastSyncedAt: app.lastSyncedAt,
      syncError: app.lastSyncError?.trim() || null,
    };

    if (planned) {
      const blocked = blockOf(planned, null);
      place(
        {
          ...common,
          key: `${app.id}:${planned.version}`,
          version: planned.version,
          track: null,
          build: null,
          status: null,
          rawState: null,
          rolloutFraction: null,
          planned: true,
          blocked,
          due: planned.due,
          rollout: planned.rollout,
          planId: planned.id,
          readiness: planned.readiness,
          next: nextAction({ platform: app.platform, status: null, planned: true, blocked, readiness: planned.readiness }),
          href: releaseHref(app.id, planned.version),
        },
        'preparing',
      );
      continue;
    }
    if (!latest) {
      unplace('no_releases');
      continue;
    }
    if (latest.status === null) {
      unplace('unmapped', latest.rawState);
      continue;
    }
    const plan = plans.find((p) => p.version === latest.version);
    const blocked = blockOf(plan, latest.status);
    place(
      {
        ...common,
        key: `${app.id}:${latest.version}`,
        version: latest.version,
        track: latest.track,
        build: latest.build,
        status: latest.status,
        rawState: latest.rawState,
        rolloutFraction: latest.rolloutFraction,
        planned: false,
        blocked,
        // A release that is out has no deadline worth showing.
        due: plan && !plan.released ? plan.due : null,
        rollout: plan && !plan.released ? plan.rollout : null,
        planId: plan?.id ?? null,
        readiness: plan?.readiness ?? null,
        next: nextAction({ platform: app.platform, status: latest.status, rawState: latest.rawState, blocked, readiness: plan?.readiness ?? null }),
        href: releaseHref(app.id, latest.version),
      },
      dashboardBucket(latest.status),
    );
  }
  for (const column of columns) column.cards.sort(compareCards);
  return { columns, unplaced };
}

/** How many cards carry a block, for the summary line above the board. */
export const blockedCount = (board: Board): number => board.columns.reduce((n, c) => n + c.cards.filter((card) => card.blocked).length, 0);

// ---------------------------------------------------------------------------------------------
// Due soon and overdue

export type AttentionKind = 'overdue' | 'rollout_due' | 'due_soon';

export type Attention = {
  /** One row per plan. */
  key: string;
  planId: string;
  appId: string;
  appName: string;
  platform: Platform;
  version: string;
  /** The most urgent reason. */
  kind: AttentionKind;
  /** Every reason, most urgent first, as plain sentences. */
  reasons: string[];
  /** Days to the target date (negative when passed); null without one. Only for ordering. */
  daysLeft: number | null;
  href: string;
};

const ATTENTION_RANK: Record<AttentionKind, number> = { overdue: 0, rollout_due: 1, due_soon: 2 };

type AttentionPlan = Pick<
  PlanSummary,
  'id' | 'appId' | 'appName' | 'appPlatform' | 'version' | 'released' | 'due' | 'rollout' | 'targetDate'
>;

/**
 * What needs a look on one plan: a deadline that has passed, a rollout step whose planned time has
 * passed while it is still open, a deadline that is close. A release that is already out has none.
 * Pure: the flags come from the server's clock, so a list never disagrees with the plan page.
 */
export function attentionOf(plan: AttentionPlan): Attention | null {
  if (plan.released) return null;
  const reasons: { kind: AttentionKind; text: string }[] = [];
  const due = dueText(plan.due, plan.released);
  if (plan.due.overdue && due) reasons.push({ kind: 'overdue', text: due.text });
  const rollout = plan.rollout;
  if (rollout && rollout.kind === 'steps' && rollout.dueSteps > 0) {
    const next = rollout.next ? ` Next: ${formatPercent(rollout.next.percent)}.` : '';
    reasons.push({
      kind: 'rollout_due',
      text: `${rollout.dueSteps} rollout ${rollout.dueSteps === 1 ? 'step is' : 'steps are'} past the planned time.${next}`,
    });
  }
  if (plan.due.dueSoon && !plan.due.overdue && due) reasons.push({ kind: 'due_soon', text: due.text });
  const first = reasons.sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind])[0];
  if (!first) return null;
  return {
    key: plan.id,
    planId: plan.id,
    appId: plan.appId,
    appName: plan.appName,
    platform: plan.appPlatform,
    version: plan.version,
    kind: first.kind,
    reasons: reasons.map((r) => r.text),
    daysLeft: plan.due.daysLeft,
    href: releaseHref(plan.appId, plan.version),
  };
}

/** The plans that need a look, most urgent first: overdue (longest first), rollout steps due, due soon (soonest first). */
export function attentionItems(plans: readonly AttentionPlan[]): Attention[] {
  return plans
    .map(attentionOf)
    .filter((a): a is Attention => a !== null)
    .sort(
      (a, b) =>
        ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] ||
        (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
        a.appName.localeCompare(b.appName, undefined, { sensitivity: 'base' }) ||
        (a.platform === b.platform ? 0 : a.platform === 'ios' ? -1 : 1) ||
        (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
    );
}

/** "2 overdue, 1 with a rollout step due, 3 due soon." Empty when there is nothing. */
export function attentionSummary(items: readonly Attention[]): string {
  const count = (kind: AttentionKind) => items.filter((i) => i.kind === kind).length;
  const counts: [number, string][] = [
    [count('overdue'), 'overdue'],
    [count('rollout_due'), 'with a rollout step due'],
    [count('due_soon'), 'due soon'],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length === 0 ? '' : `${parts.join(', ')}.`;
}
