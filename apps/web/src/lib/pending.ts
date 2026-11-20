import { can, fractionRefusalNotice, type Platform, type Role } from '@mrm/core';
import { ApiError } from './api.ts';
import { type AppSection, appAddress, type PlatformScope } from './app-scope.ts';
import { releaseStepHref } from './release-stepper.ts';
import type { DraftPreview } from './staged.ts';
import type { ReleasePreview } from './store-release.ts';
import type { RolloutPreview } from './store-rollout.ts';
import type { SubmitPreview } from './store-submit.ts';

/**
 * Everything an app has pending in one place, and publishing it in one go (docs/api/pending.md,
 * docs/adr/0015-pending-and-batch-publish.md): the types of the API that the web app owns and the pure logic of the
 * pending view, the readiness of the "Review and publish all" button, the plan as the dialog shows it, the typed
 * phrase and the result of a publish. The server decides every rule; what is checked here only explains things and
 * never widens what the server allows. Results are worded here from fixed vocabulary: a store's own text is never shown.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const PUBLISH_ENV = 'MRM_STORE_PUBLISH_BATCH_ENABLED';

// ---------------------------------------------------------------------------------------------
// API shapes

export type PendingKind =
  | 'listing_text'
  | 'asset_set'
  | 'release_field'
  | 'pushed_draft'
  | 'draft_release'
  | 'in_review'
  | 'approved'
  | 'rollout_step';
export type PublishStepType = 'push_draft' | 'submit' | 'release' | 'rollout';
export const PUBLISH_STEPS: readonly PublishStepType[] = [
  'push_draft',
  'submit',
  'release',
  'rollout',
];

export type PendingProblem = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  item?: string;
};
export type PendingState = 'staged' | 'invalid' | 'pushed' | 'in_review' | 'approved' | 'due';

export type PendingItem = {
  kind: PendingKind;
  platform: Platform;
  id: string;
  label: string;
  state: PendingState;
  problems: PendingProblem[];
  nextStep: PublishStepType | null;
  counts: Record<string, number>;
  refs: { id: string; locale?: string; field?: string }[];
  truncated: boolean;
  since: number | null;
};

export type PendingTotals = { items: number; actionable: number; blocking: number };
export type PendingStore = 'appstoreconnect' | 'googleplay';
export type PendingPlatform = {
  platform: Platform;
  store: PendingStore;
  items: PendingItem[];
  totals: PendingTotals;
};

export type PendingView = {
  app: { id: string; name: string; platform: Platform; store: PendingStore };
  platforms: PendingPlatform[];
  totals: PendingTotals & { platforms: Platform[]; nextSteps: PublishStepType[] };
  lastSyncedAt: number | null;
  generatedAt: number;
};

export type PendingSummaryApp = {
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: PendingStore };
  count: number;
  blocking: number;
  waiting: number;
  kinds: PendingKind[];
  nextSteps: PublishStepType[];
};

export type PendingSummary = {
  apps: PendingSummaryApp[];
  totals: { apps: number; count: number; blocking: number };
  generatedAt: number;
};

export type PublishConfig = {
  enabled: boolean;
  envName: string;
  action: string;
  minimumRole: string;
  steps: Record<
    PublishStepType,
    { action: string; envName: string; enabled: boolean; irreversible: boolean }
  >;
  phrase: string;
  note: string;
};

export type StepRequest = {
  type: PublishStepType;
  action?: string;
  version?: string;
  track?: string;
  versionCodes?: string[];
  userFraction?: number;
  /** Google Play release: release the staged fields in one step, no draft first (docs/adr/0029-direct-play-release.md). */
  direct?: boolean;
};

export type Availability =
  | 'available'
  | 'feature_disabled'
  | 'forbidden'
  | 'nothing_to_do'
  | 'blocked'
  | 'needs_input'
  | 'not_requested';

export type PlanProblem = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  item?: string;
};

export type PlanStep = {
  type: PublishStepType;
  platform: Platform;
  order: number;
  label: string;
  requested: boolean;
  included: boolean;
  availability: Availability;
  reason: string | null;
  requires: { action: string; envName: string; enabled: boolean; allowed: boolean };
  irreversible: boolean;
  deferred: boolean;
  summary: Record<string, unknown> | null;
  request: StepRequest | null;
  preview: unknown;
  confirmHash: string | null;
  stepPhrase: string | null;
  problems: PlanProblem[];
};

export type PublishPlan = {
  app: { id: string; name: string; platform: Platform; store: string };
  steps: PlanStep[];
  publishSteps: StepRequest[];
  included: number;
  irreversible: boolean;
  irreversibleSteps: PublishStepType[];
  warnings: string[];
  confirmable: boolean;
  planHash: string | null;
  confirmationRequired: boolean;
  confirmation: { phrase: string; instruction: string } | null;
  /** Google Play: the staged track, version codes and intended share, when a release can be made from them (absent from an older server). */
  direct?: { track: string; versionCodes: string[]; stagedFraction: number | null } | null;
  /** Google Play: only release fields are staged, so the plan is one direct release step (absent from an older server). */
  defaultedToDirect?: boolean;
  readAt: number;
};

export type StepResult =
  | { type: PublishStepType; status: 'applied'; confirmedByReread: boolean; result?: unknown }
  | {
      type: PublishStepType;
      status: 'skipped';
      reason: 'previous_step_not_applied' | 'plan_drifted' | 'blocked' | 'preview_failed';
      code?: string;
      message?: string;
      checks?: string[];
    }
  | {
      type: PublishStepType;
      status: 'failed';
      error: string;
      httpStatus: number;
      outcome: 'refused' | 'not_applied' | 'unknown' | 'partial';
      message?: string;
      detail?: Record<string, unknown>;
    };

export type PublishResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  planHash: string;
  completed: boolean;
  applied: number;
  skipped: number;
  failed: number;
  stoppedAt: PublishStepType | null;
  steps: StepResult[];
  pending: { items: number; actionable: number; blocking: number };
  publishedAt: number;
};

// ---------------------------------------------------------------------------------------------
// The pending view: groups, words, links

/** The order the kinds are listed in: what a person edits first, what only waits for the store last. */
export const KIND_ORDER: readonly PendingKind[] = [
  'listing_text',
  'asset_set',
  'release_field',
  'pushed_draft',
  'draft_release',
  'approved',
  'rollout_step',
  'in_review',
];

export const KIND_LABEL: Readonly<Record<PendingKind, string>> = {
  listing_text: 'Listing text',
  asset_set: 'Screenshots and graphics',
  release_field: 'Release (build, notes, release type)',
  pushed_draft: 'Drafts pushed, not yet submitted',
  draft_release: 'Draft releases, not released yet',
  approved: 'Approved, waiting for release',
  rollout_step: 'Rollout',
  in_review: 'In review',
};

export const STEP_NAME: Readonly<Record<PublishStepType, string>> = {
  push_draft: 'Push the draft',
  submit: 'Submit for review',
  release: 'Release',
  rollout: 'Change the rollout',
};

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export function stateBadge(state: PendingState): { label: string; tone: Tone } {
  switch (state) {
    case 'staged':
      return { label: 'Staged', tone: 'info' };
    case 'invalid':
      return { label: 'Has an error', tone: 'bad' };
    case 'pushed':
      return { label: 'Pushed as a draft', tone: 'info' };
    case 'in_review':
      return { label: 'In review', tone: 'neutral' };
    case 'approved':
      return { label: 'Approved', tone: 'ok' };
    default:
      return { label: 'Due', tone: 'warn' };
  }
}

/** What happens to an item next, in a sentence. Nothing here says it happens by itself: every step is confirmed. */
export function nextStepText(item: Pick<PendingItem, 'kind' | 'nextStep' | 'state'>): string {
  if (item.nextStep === null) return 'Nothing to do here. The store is reviewing it.';
  if (item.state === 'invalid') return 'Cannot be pushed until the error is fixed.';
  switch (item.nextStep) {
    case 'push_draft':
      return 'Next: push it to the store as a draft. A push does not submit anything.';
    case 'submit':
      return 'Next: submit the draft for the store review.';
    case 'release':
      return item.kind === 'draft_release'
        ? 'Next: release the draft to users. You name the share of users and confirm it first.'
        : 'Next: release the approved version to users.';
    default:
      return 'Next: make the rollout change that is due.';
  }
}

export type KindGroup = { kind: PendingKind; label: string; items: PendingItem[] };

/** The items of a platform grouped by kind, in `KIND_ORDER`; a kind with no item is left out. */
export function groupItems(items: readonly PendingItem[]): KindGroup[] {
  const out: KindGroup[] = [];
  for (const kind of KIND_ORDER) {
    const of = items.filter((i) => i.kind === kind);
    if (of.length > 0) out.push({ kind, label: KIND_LABEL[kind], items: of });
  }
  return out;
}

export const errorsOf = (item: Pick<PendingItem, 'problems'>): PendingProblem[] =>
  item.problems.filter((p) => p.severity === 'error');
export const warningsOf = (item: Pick<PendingItem, 'problems'>): PendingProblem[] =>
  item.problems.filter((p) => p.severity === 'warning');

/** Staged items can be removed here (this only changes our own database); the rest is changed in the store. */
export const isDiscardable = (item: Pick<PendingItem, 'kind' | 'refs'>): boolean =>
  (item.kind === 'listing_text' || item.kind === 'asset_set' || item.kind === 'release_field') &&
  item.refs.length > 0;

/** The ids to unstage for an item (a text item holds every staged text change of the app). */
export const discardIds = (item: Pick<PendingItem, 'refs'>): string[] => item.refs.map((r) => r.id);

/** Where to change an item: the screen that stages it, or the releases tab for what is already in the store. */
export function editHref(
  item: Pick<PendingItem, 'kind' | 'platform'>,
  appId: string,
  scope: PlatformScope | null,
): { href: string; label: string } {
  const platform: PlatformScope = scope ?? item.platform;
  const at = (section: AppSection) => appAddress(appId, section, platform);
  switch (item.kind) {
    case 'listing_text':
      return { href: at('listing'), label: 'Edit in the listing' };
    case 'asset_set':
      return { href: at('assets'), label: 'Edit the graphics' };
    case 'release_field':
      return { href: releaseStepHref(appId, platform, 'build'), label: 'Edit the release' };
    default:
      return { href: at('releases'), label: 'Open the releases' };
  }
}

export function platformTotals(p: Pick<PendingPlatform, 'items'>): PendingTotals {
  const actionable = p.items.filter((i) => i.nextStep !== null).length;
  return {
    items: p.items.length,
    actionable,
    blocking: p.items.filter((i) => errorsOf(i).length > 0).length,
  };
}

/** The one line at the top of the view: what waits, what is blocked, what only waits for the store. */
export function totalsLine(t: PendingTotals): string {
  if (t.items === 0) return 'Nothing pending';
  const waiting = t.items - t.actionable;
  const parts: string[] = [];
  if (t.actionable > 0) parts.push(`${t.actionable} waiting for you`);
  if (t.blocking > 0) parts.push(`${t.blocking} with ${t.blocking === 1 ? 'an error' : 'errors'}`);
  if (waiting > 0) parts.push(`${waiting} waiting for the store`);
  return parts.join(', ');
}

/** A platform of an app record that has something pending, with the id of the record (discard and edit act on that record). */
export type PlatformGroup = { appId: string; platform: PendingPlatform };

/** The platform groups of several platform records (a platform with nothing pending is left out). */
export function platformGroups(
  views: readonly (PendingView | null | undefined)[],
): PlatformGroup[] {
  const out: PlatformGroup[] = [];
  for (const view of views) {
    if (!view) continue;
    for (const p of view.platforms)
      if (p.items.length > 0) out.push({ appId: view.app.id, platform: p });
  }
  return out;
}

/** An item that has an error: what blocks publishing everything (the server plans per step, so a blocked item cannot be left out). */
export type BlockingItem = {
  appId: string;
  platform: Platform;
  itemId: string;
  label: string;
  messages: string[];
  anchor: string;
};

/** The DOM id of an item row, so "Show it" can scroll to it and focus it. */
export const itemAnchor = (appId: string, itemId: string): string =>
  `pending-item-${appId}-${itemId}`.replace(/[^A-Za-z0-9_-]/g, '-');

/** The items with an error, in page order. */
export function blockingItems(groups: readonly PlatformGroup[]): BlockingItem[] {
  const out: BlockingItem[] = [];
  for (const g of groups) {
    for (const i of g.platform.items) {
      const errors = errorsOf(i);
      if (errors.length > 0)
        out.push({
          appId: g.appId,
          platform: g.platform.platform,
          itemId: i.id,
          label: i.label,
          messages: errors.map((e) => e.message),
          anchor: itemAnchor(g.appId, i.id),
        });
    }
  }
  return out;
}

/** The totals of several platform groups added up. */
export function combineTotals(groups: readonly { totals: PendingTotals }[]): PendingTotals {
  return groups.reduce<PendingTotals>(
    (sum, g) => ({
      items: sum.items + g.totals.items,
      actionable: sum.actionable + g.totals.actionable,
      blocking: sum.blocking + g.totals.blocking,
    }),
    { items: 0, actionable: 0, blocking: 0 },
  );
}

// ---------------------------------------------------------------------------------------------
// The summary: the chip beside an app

export type PendingLine = { count: number; blocking: number; waiting: number };

/** What the screens know about the app records, by id: the last read of the pending view of each. */
export type ViewsById = Readonly<Record<string, PendingView | null | undefined>>;

/**
 * The line of ONE pending view, by the rule the server's summary uses (`count` = items that wait for a step, `waiting` = the rest,
 * `blocking` = items with an error), so a view and a summary of the same data give the same line.
 */
export function lineOfView(view: PendingView | null | undefined): PendingLine | null {
  if (!view) return null;
  let count = 0;
  let waiting = 0;
  let blocking = 0;
  for (const p of view.platforms) {
    const t = platformTotals(p);
    count += t.actionable;
    waiting += t.items - t.actionable;
    blocking += t.blocking;
  }
  return count + blocking + waiting === 0 ? null : { count, blocking, waiting };
}

/**
 * The summary line of an app made of these records (several platforms add up); null when it is not known or nothing is pending.
 * ONE rule for the banner, the chips and the detail: for each record the NEWER of the two reads wins (the summary and the record's own
 * pending view carry `generatedAt`), so a page that just read the detail never disagrees with the banner, and a view that was read
 * before a push never hides what the summary read after it.
 */
export function lineFor(
  summary: PendingSummary | null | undefined,
  appIds: readonly string[],
  views: ViewsById = {},
): PendingLine | null {
  const known = summary && Array.isArray(summary.apps) ? summary : null;
  let count = 0;
  let blocking = 0;
  let waiting = 0;
  const add = (line: PendingLine | null) => {
    if (!line) return;
    count += line.count;
    blocking += line.blocking;
    waiting += line.waiting;
  };
  for (const id of appIds) {
    const view = views[id];
    if (view && (known === null || Number(view.generatedAt) >= Number(known.generatedAt))) {
      add(lineOfView(view));
      continue;
    }
    if (known === null) continue;
    const a = known.apps.find((x) => (x.appId ?? x.id) === id);
    if (a)
      add({
        count: Number(a.count) || 0,
        blocking: Number(a.blocking) || 0,
        waiting: Number(a.waiting) || 0,
      });
  }
  return count + blocking + waiting === 0 ? null : { count, blocking, waiting };
}

/**
 * The records whose pending view is OLDER than the summary and says something else about them: the detail has to read again before it
 * says "Nothing pending" while the banner counts changes. Compares only the number of items (the one fact both reads carry).
 */
export function staleViewIds(
  summary: PendingSummary | null | undefined,
  appIds: readonly string[],
  views: ViewsById,
): string[] {
  if (!summary || !Array.isArray(summary.apps)) return [];
  return appIds.filter((id) => {
    const view = views[id];
    if (!view || Number(view.generatedAt) >= Number(summary.generatedAt)) return false;
    const a = summary.apps.find((x) => (x.appId ?? x.id) === id);
    const inSummary = a ? (Number(a.count) || 0) + (Number(a.waiting) || 0) : 0;
    const inView = view.platforms.reduce((n, p) => n + p.items.length, 0);
    return inSummary !== inView;
  });
}

export type Chip = { text: string; tone: 'warn' | 'accent'; label: string };

/** The chip: "3 pending", warning tone when an error blocks something; nothing when only the store has to act (in review). */
export function chipFor(line: PendingLine | null | undefined): Chip | null {
  if (!line || (line.count <= 0 && line.blocking <= 0)) return null;
  const n = line.count > 0 ? line.count : line.blocking;
  const text = n > 99 ? '99+ pending' : `${n} pending`;
  if (line.blocking > 0)
    return {
      text,
      tone: 'warn',
      label: `${text}, ${line.blocking} with ${line.blocking === 1 ? 'an error' : 'errors'}`,
    };
  return { text, tone: 'accent', label: text };
}

// ---------------------------------------------------------------------------------------------
// May the button be pressed

export type PublishAvailability =
  | { state: 'ready' }
  | { state: 'loading'; message: string }
  | { state: 'role'; message: string }
  | { state: 'unknown'; message: string }
  | { state: 'off'; message: string }
  | { state: 'steps_off'; message: string }
  | { state: 'nothing'; message: string }
  | { state: 'blocked'; message: string };

export const PUBLISH_ROLE_REASON =
  'Publishing everything at once needs the admin or owner role. You can still look at what is pending.';

export const canPublishBatch = (role: Role): boolean => can(role, 'store.publish');

/**
 * Whether "Review and publish all" can be pressed, and the reason when it cannot. In this order: the role, whether the switch is known,
 * the batch switch, whether something waits, the switches of the steps that what is pending waits for, whether an error blocks it.
 * It never turns anything on: how to enable it is part of the message.
 */
export function publishAvailability(input: {
  role: Role;
  config: PublishConfig | null;
  configFailed: boolean;
  totals: PendingTotals | null;
  nextSteps: readonly PublishStepType[];
}): PublishAvailability {
  if (!canPublishBatch(input.role)) return { state: 'role', message: PUBLISH_ROLE_REASON };
  if (input.configFailed)
    return {
      state: 'unknown',
      message:
        'Could not find out whether publishing in one go is switched on. Reload the page to try again.',
    };
  const config = input.config;
  if (!config)
    return { state: 'loading', message: 'Checking whether publishing in one go is switched on.' };
  if (!config.enabled) {
    return {
      state: 'off',
      message: `Publishing several steps at once is switched off on this server. Someone who runs it sets ${config.envName || PUBLISH_ENV}=true and restarts it (see docs/api/pending.md). The single steps keep their own switches and still work meanwhile.`,
    };
  }
  if (input.totals === null) return { state: 'loading', message: 'Reading what is pending.' };
  if (input.totals.actionable === 0)
    return { state: 'nothing', message: 'Nothing is waiting to be published.' };
  const off = input.nextSteps.filter(
    (s) => config.steps && config.steps[s] && config.steps[s].enabled === false,
  );
  if (input.nextSteps.length > 0 && off.length === input.nextSteps.length) {
    return {
      state: 'steps_off',
      message: `The steps that what is pending waits for are switched off on this server (${off.map((s) => config.steps[s].envName).join(', ')}). Each step needs its own switch, even in a batch.`,
    };
  }
  if (input.totals.blocking > 0) {
    const n = input.totals.blocking;
    return {
      state: 'blocked',
      message: `${n} ${n === 1 ? 'item has an error' : 'items have errors'}. Fix or remove ${n === 1 ? 'it' : 'them'} first.`,
    };
  }
  return { state: 'ready' };
}

// ---------------------------------------------------------------------------------------------
// The plan as the dialog shows it

export const AVAILABILITY_WORD: Readonly<Record<Availability, string>> = {
  available: 'Ready',
  feature_disabled: 'Switched off',
  forbidden: 'Not allowed',
  nothing_to_do: 'Nothing to do',
  blocked: 'Blocked',
  needs_input: 'Needs details',
  not_requested: 'Not included',
};

export function availabilityTone(a: Availability): Tone {
  switch (a) {
    case 'available':
      return 'ok';
    case 'blocked':
    case 'forbidden':
      return 'bad';
    case 'feature_disabled':
    case 'needs_input':
      return 'warn';
    default:
      return 'neutral';
  }
}

export type StepRow = {
  type: PublishStepType;
  order: number;
  label: string;
  checked: boolean;
  /** The person can tick or untick it here. */
  toggleable: boolean;
  /** Why it cannot be ticked, or a short note when it can (checked again later, not part of the publish). */
  reason: string | null;
  word: string;
  tone: Tone;
  irreversible: boolean;
  deferred: boolean;
  /** Google Play release only: it needs the track and the share, which the dialog asks for. */
  needsInput: boolean;
  /** There is nothing for this step to do now (the dialog leaves it out instead of showing a step that cannot be ticked). */
  idle: boolean;
};

export const SINGLE_STEP_HINT = 'Use the single step under "Do just one step (advanced)".';

/** The row of one step of the plan, from the plan alone. The rollout always names a change, so it stays a single step. */
export function stepRow(step: PlanStep, platform: Platform): StepRow {
  const needsInput =
    step.type === 'release' && platform === 'android' && step.availability === 'needs_input';
  let toggleable = step.availability === 'available' || step.availability === 'not_requested';
  let reason = step.reason;
  if (step.type === 'rollout') {
    toggleable = false;
    if (step.availability !== 'nothing_to_do')
      reason = `A rollout change names the release and the share. ${SINGLE_STEP_HINT}`;
  } else if (step.availability === 'needs_input') {
    // A Google Play release is ticked after the dialog asked for the track and the share; any other step that needs details stays single.
    toggleable = needsInput;
    if (!needsInput) reason = `This step needs details. ${SINGLE_STEP_HINT}`;
  } else if (step.availability === 'feature_disabled') {
    reason = `Switched off on this server (${step.requires.envName}). Each step needs its own switch, even in a batch.`;
  } else if (step.availability === 'forbidden') {
    reason = `Your role, or this token, does not allow ${step.requires.action}.`;
  } else if (step.availability === 'available') {
    reason = null;
  } else if (step.availability === 'not_requested') {
    reason = 'Not part of this publish. Tick it to include it.';
  }
  return {
    type: step.type,
    order: step.order,
    label: step.label,
    checked: step.included,
    toggleable,
    reason,
    word: AVAILABILITY_WORD[step.availability],
    tone: availabilityTone(step.availability),
    irreversible: step.irreversible,
    deferred: step.deferred,
    needsInput,
    // Google Play has no review step of its own: the release is what Google reviews, so "submit" is not offered next to it.
    idle:
      step.availability === 'nothing_to_do' ||
      (platform === 'android' && step.type === 'submit' && step.availability === 'not_requested'),
  };
}

/**
 * The rows the dialog shows: the steps that have something to do, numbered one after the other, and the names of the steps left out
 * (for one quiet line). When no step has anything to do, every row stays so the dialog can say why.
 */
export function visibleRows(rows: readonly StepRow[]): { shown: StepRow[]; left: string[] } {
  const active = rows.filter((r) => !r.idle);
  if (active.length === 0) return { shown: [...rows], left: [] };
  return {
    shown: active.map((r, i) => ({ ...r, order: i + 1 })),
    left: rows.filter((r) => r.idle).map((r) => r.label),
  };
}

export const stepRows = (plan: PublishPlan): StepRow[] =>
  [...plan.steps].sort((a, b) => a.order - b.order).map((s) => stepRow(s, plan.app.platform));

/**
 * The requests to preview after the person ticked or unticked a step: the steps that are ticked, in the plan's own form (a step
 * that is part of the plan keeps its fields), and `{ type }` for one that is newly ticked, with the details the dialog asked for.
 */
export function requestsFor(
  plan: PublishPlan,
  wanted: readonly PublishStepType[],
  extra: Partial<Record<PublishStepType, StepRequest>> = {},
): StepRequest[] {
  const out: StepRequest[] = [];
  for (const type of PUBLISH_STEPS) {
    if (wanted.indexOf(type) < 0) continue;
    const given = extra[type];
    const step = plan.steps.filter((s) => s.type === type)[0];
    out.push(given ?? (step && step.included && step.request ? step.request : { type }));
  }
  return out;
}

/** What the release inputs of the dialog start with: the staged track, and the share staged as an intention (a reminder, never sent by itself). */
export function releaseInputDefaults(plan: PublishPlan | null): {
  track: string;
  sharePercent: string;
  direct: boolean;
} {
  const staged = plan?.direct ?? null;
  const fraction = staged?.stagedFraction ?? null;
  return {
    track: staged?.track ?? 'production',
    sharePercent:
      fraction !== null && fraction > 0 && fraction <= 1
        ? String(Math.round(fraction * 10000) / 100)
        : '',
    direct: plan?.defaultedToDirect === true,
  };
}

/** The release step the person adds in the dialog: direct when the plan was made as a direct release. */
export const releaseStepRequest = (input: {
  track: string;
  fraction: number;
  direct: boolean;
}): StepRequest => ({
  type: 'release',
  track: input.track.trim(),
  userFraction: input.fraction,
  ...(input.direct ? { direct: true } : {}),
});

/** "Save as a draft only": the push alone (nothing is submitted or released). Offered when the plan is a direct release. */
export const draftOnlySteps = (): StepRequest[] => [{ type: 'push_draft' }];

/** The plan is a direct release (made so by the server, or because its release step is one). */
export const isDirectPlan = (plan: PublishPlan | null): boolean =>
  plan !== null &&
  (plan.defaultedToDirect === true ||
    plan.steps.some((s) => s.type === 'release' && s.request?.direct === true));

/** The types that are part of the plan. */
export const includedTypes = (plan: PublishPlan): PublishStepType[] =>
  plan.steps.filter((s) => s.included).map((s) => s.type);

export const toggled = (
  current: readonly PublishStepType[],
  type: PublishStepType,
  on: boolean,
): PublishStepType[] => PUBLISH_STEPS.filter((t) => (t === type ? on : current.indexOf(t) >= 0));

/** The plan can be published as it is: confirmable, with its hash, and the ticks are exactly the plan's own steps. */
export function planReady(plan: PublishPlan | null, wanted: readonly PublishStepType[]): boolean {
  if (plan === null || !plan.confirmable || plan.planHash === null || wanted.length === 0)
    return false;
  const own = includedTypes(plan);
  return wanted.length === own.length && wanted.every((t) => own.indexOf(t) >= 0);
}

// ---------------------------------------------------------------------------------------------
// The typed phrase

/** Equal ignoring surrounding spaces, never ignoring case (the server compares the same way). */
export const phraseMatches = (typed: string, phrase: string): boolean =>
  typed.trim() !== '' && typed.trim() === phrase.trim();

/**
 * May the button publish: the plan is ready, and when the plan has a confirmation the typed text equals its phrase exactly as the
 * server gave it. A plan with no confirmation (a push alone) is published after the person ticked "I have read this plan".
 */
export function canPublish(
  plan: PublishPlan | null,
  wanted: readonly PublishStepType[],
  typed: string,
  acknowledged: boolean,
): boolean {
  if (plan === null || !planReady(plan, wanted)) return false;
  if (plan.confirmationRequired)
    return plan.confirmation !== null && phraseMatches(typed, plan.confirmation.phrase);
  return acknowledged;
}

/** The body of `POST .../publish`. The phrase is sent only when the plan asks for one. */
export function publishBody(
  plan: PublishPlan,
  typed: string,
): { planHash: string; steps: StepRequest[]; phrase?: string } {
  const body: { planHash: string; steps: StepRequest[]; phrase?: string } = {
    planHash: plan.planHash ?? '',
    steps: plan.publishSteps,
  };
  if (plan.confirmationRequired) body.phrase = typed.trim();
  return body;
}

/** The body of `POST .../publish/preview`: the steps when the person chose them, else nothing (the server includes what has work). */
export const previewBody = (steps: readonly StepRequest[] | null): { steps?: StepRequest[] } =>
  steps === null ? {} : { steps: [...steps] };

// ---------------------------------------------------------------------------------------------
// What a step's preview holds (the plan carries each step's own preview)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const asPushPreview = (v: unknown): DraftPreview | null =>
  isObject(v) &&
  Array.isArray(v.text) &&
  Array.isArray(v.assets) &&
  isObject(v.summary) &&
  isObject(v.app)
    ? (v as unknown as DraftPreview)
    : null;

export const asSubmitPreview = (v: unknown): SubmitPreview | null =>
  isObject(v) &&
  isObject(v.contents) &&
  isObject(v.checks) &&
  Array.isArray(v.irreversible) &&
  isObject(v.app)
    ? (v as unknown as SubmitPreview)
    : null;

export const asReleasePreview = (v: unknown): ReleasePreview | null =>
  isObject(v) &&
  isObject(v.audience) &&
  isObject(v.checks) &&
  Array.isArray(v.irreversible) &&
  isObject(v.app)
    ? (v as unknown as ReleasePreview)
    : null;

export const asRolloutPreview = (v: unknown): RolloutPreview | null =>
  isObject(v) &&
  isObject(v.current) &&
  isObject(v.proposed) &&
  typeof v.summary === 'string' &&
  isObject(v.app)
    ? (v as unknown as RolloutPreview)
    : null;

/** What a step is about to do, in numbers and names only ("3 text changes, 1 graphics set"); empty when the plan carries none. */
export function summaryParts(step: Pick<PlanStep, 'type' | 'summary'>): string[] {
  const s = step.summary ?? {};
  const num = (key: string): number | null =>
    typeof s[key] === 'number' ? (s[key] as number) : null;
  const str = (key: string): string | null =>
    typeof s[key] === 'string' && s[key] !== '' ? (s[key] as string) : null;
  const parts: string[] = [];
  if (step.type === 'push_draft') {
    const t = num('textChanged');
    const a = num('assetSetsChanged');
    const f = num('fieldsChanged');
    if (t !== null) parts.push(`${t} text ${t === 1 ? 'change' : 'changes'}`);
    if (a !== null) parts.push(`${a} graphics ${a === 1 ? 'set' : 'sets'}`);
    if (f !== null && f > 0) parts.push(`${f} release ${f === 1 ? 'field' : 'fields'}`);
  } else if (step.type === 'submit') {
    const v = str('versionString');
    const t = num('texts');
    const a = num('assetSets');
    if (v) parts.push(`version ${v}`);
    if (t !== null) parts.push(`${t} ${t === 1 ? 'text' : 'texts'}`);
    if (a !== null) parts.push(`${a} graphics ${a === 1 ? 'set' : 'sets'}`);
  } else if (step.type === 'release') {
    const v = str('version');
    const track = str('track');
    const share = num('userFraction');
    const audience = str('audience');
    if (v) parts.push(`version ${v}`);
    if (track) parts.push(`track ${track}`);
    if (share !== null) parts.push(`${Math.round(share * 10000) / 100}% of users`);
    if (audience)
      parts.push(
        audience === 'all'
          ? 'all users'
          : audience === 'phased'
            ? 'a phased release'
            : 'a share of users',
      );
  }
  return parts;
}

/** The promise of a step that is checked again after the earlier ones ran, in words. Numbers and names only. */
export function promiseText(step: Pick<PlanStep, 'type' | 'summary'>): string {
  const parts = summaryParts(step);
  return parts.length === 0
    ? 'The details are checked again when this step runs.'
    : `Promised: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------------------------
// The result of a publish, in fixed words

export const STOP_NOTE =
  'The steps run in order and stop at the first one that is not done. The steps after it were not run, and nothing is retried automatically.';

const FAILED_TEXT: Readonly<Record<string, string>> = {
  state_changed:
    'Nothing was written: the store or the staged changes changed after the preview. Review again.',
  blocked: 'Nothing was written: a check blocks this step now. Review again.',
  outcome_unknown:
    'It is not known whether this reached the store. Look at the app in the store console, then review again.',
  write_in_progress:
    'Another write for this app was running, so nothing was written. Wait for it, then review again.',
  draft_partial:
    'Only part of it reached the draft. What was written stays there. Review again to finish: items that already match are skipped.',
  changes_in_review: 'The store refuses this while changes are in review. Nothing was sent.',
  confirmation_mismatch: 'The confirmation did not match. Nothing was written.',
  rate_limited:
    'The store asked for a pause. Nothing was retried. Wait a moment, then review again.',
  store_unavailable: 'The store could not be reached. Review again to check where things stand.',
  timeout: 'The store did not answer in time. Review again to check where things stand.',
  write_failed: 'The store did not accept the write.',
  store_auth: 'The store did not accept the credential. Check it in Credentials.',
  store_forbidden: 'The store credential is not allowed to do this. Check its role in the store.',
  store_not_found:
    'The store could not find what this step acts on. Sync the app and review again.',
  store_rejected: 'The store rejected this step.',
  step_error: 'The step stopped unexpectedly. Look at the app in the store, then review again.',
  asset_changed: 'A staged file changed. Stage it again, then review.',
  asset_unreadable: 'A staged file cannot be read. Stage it again, then review.',
  staged_invalid: 'A staged item has an error. Fix it, then review.',
  nothing_staged: 'Nothing is staged any more.',
  nothing_pushed: 'No pushed draft is waiting to be submitted.',
  no_editable_version:
    'The store has no version that can be edited. Create one in the store console.',
};

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  refused: 'Nothing was changed.',
  not_applied: 'Nothing was changed (read back from the store).',
  unknown: 'The outcome is not known.',
  partial: 'Part of it was applied.',
};

const SKIPPED_TEXT: Readonly<Record<string, string>> = {
  previous_step_not_applied: 'Not run, because an earlier step did not finish.',
  plan_drifted: 'Not run: it no longer matched what you reviewed. Review again.',
  blocked: 'Not run: something now stands in the way of this step. Review again.',
  preview_failed: 'Not run: the store could not be read for this step. Review again.',
};

export type ResultRow = {
  type: PublishStepType;
  label: string;
  status: 'applied' | 'skipped' | 'failed';
  word: string;
  tone: Tone;
  text: string;
  /** The person should review the plan again (nothing is retried for them). */
  review: boolean;
};

/** A code from the server, reduced to what is safe to print: lower-case letters, digits and underscores. */
const safeCode = (code: string): string => code.replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'error';

const SAYS_STORE = ['store_rejected', 'store_forbidden', 'store_not_found', 'draft_not_allowed'];

/**
 * What the store (or this server) said about a failed step, as one short plain line: the server already removed secrets from it.
 * Empty when it adds nothing (no message, or just the code again).
 */
export function storeSaid(step: { error: string; message?: string | undefined }): string {
  // Only for a refusal by the store: the reason (what to fix) is what the person needs. Other codes keep their fixed words.
  if (SAYS_STORE.indexOf(step.error) < 0) return '';
  const raw = (step.message ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw === '' || raw === step.error) return '';
  const cut = raw.length > 1200 ? `${raw.slice(0, 1197)}...` : raw;
  return `The store said: ${cut}`;
}

/** The share (a fraction) the plan's release step asks for, or null when there is no release step or it has none. */
export const askedFractionOf = (plan: PublishPlan | null): number | null => {
  const r = plan?.steps.find((s) => s.type === 'release' && s.included)?.request ?? null;
  return r && typeof r.userFraction === 'number' ? r.userFraction : null;
};

export function resultRow(step: StepResult, askedFraction: number | null = null): ResultRow {
  const label = STEP_NAME[step.type];
  if (step.status === 'applied') {
    return {
      type: step.type,
      label,
      status: 'applied',
      word: 'Done',
      tone: 'ok',
      text: step.confirmedByReread ? 'Done, confirmed by reading the store back.' : 'Done.',
      review: false,
    };
  }
  if (step.status === 'skipped') {
    return {
      type: step.type,
      label,
      status: 'skipped',
      word: 'Not run',
      tone: 'neutral',
      text: SKIPPED_TEXT[step.reason] ?? 'Not run.',
      review: step.reason !== 'previous_step_not_applied',
    };
  }
  // A refusal that is about a staged rollout (a share below 100%) gets one plain message. Never retried by itself.
  if (step.type === 'release' && step.outcome !== 'unknown' && step.outcome !== 'partial') {
    const notice = fractionRefusalNotice(step.message ?? '', askedFraction);
    if (notice !== null && SAYS_STORE.indexOf(step.error) >= 0)
      return {
        type: step.type,
        label,
        status: 'failed',
        word: 'Failed',
        tone: 'bad',
        text: `${notice} ${OUTCOME_TEXT[step.outcome] ?? ''}`.trim(),
        review: true,
      };
  }
  const known = FAILED_TEXT[step.error];
  const said = storeSaid(step);
  const text =
    `${known ?? `The step did not finish (${safeCode(step.error)}).`}${said === '' ? '' : ` ${said}`} ${OUTCOME_TEXT[step.outcome] ?? ''}`.trim();
  return {
    type: step.type,
    label,
    status: 'failed',
    word: 'Failed',
    tone: 'bad',
    text,
    review: true,
  };
}

export type ResultSummary = {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  text: string;
  rows: ResultRow[];
  /** Offer "Review again". */
  review: boolean;
  stoppedAt: string | null;
};

export function resultSummary(
  result: PublishResult,
  askedFraction: number | null = null,
): ResultSummary {
  const rows = result.steps.map((s) => resultRow(s, askedFraction));
  const stoppedAt = result.stoppedAt === null ? null : STEP_NAME[result.stoppedAt];
  if (result.completed) {
    return {
      tone: 'ok',
      title: 'Everything in the plan was done',
      text: `${result.applied} ${result.applied === 1 ? 'step' : 'steps'} done.`,
      rows,
      review: false,
      stoppedAt: null,
    };
  }
  return {
    tone: result.failed > 0 ? 'error' : 'warn',
    title: stoppedAt ? `Stopped at: ${stoppedAt}` : 'Not everything was done',
    text: `${result.applied} done, ${result.failed} failed, ${result.skipped} not run.`,
    rows,
    review: rows.some((r) => r.review),
    stoppedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors of the preview and the publish call

export type PublishFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'step_disabled'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'mismatch'; message: string }
  | { kind: 'in_progress'; message: string }
  /** The plan is not the one that was reviewed (or is blocked): nothing was published, review again. */
  | { kind: 'plan_changed'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'other'; message: string };

/** Sorts an error of preview or publish into fixed words. Nothing here retries; the server's own text is not shown. */
export function classifyPublishFailure(
  error: unknown,
  config: PublishConfig | null = null,
): PublishFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      message: 'The request failed. Check your connection, then review again.',
    };
  switch (error.code) {
    case 'publish_batch_disabled':
      return {
        kind: 'disabled',
        message: `Publishing several steps at once is switched off on this server. Someone who runs it sets ${config?.envName || PUBLISH_ENV}=true and restarts it. Nothing was done.`,
      };
    case 'step_disabled':
      return {
        kind: 'step_disabled',
        message:
          'A step in this plan is switched off on this server. Each step needs its own switch. Nothing was done. Review again.',
      };
    case 'forbidden':
      return {
        kind: 'forbidden',
        message:
          'Your role, or this token, does not allow every step in this plan. Nothing was done.',
      };
    case 'confirmation_mismatch':
      return {
        kind: 'mismatch',
        message: 'The text you typed does not match. Nothing was published.',
      };
    case 'publish_in_progress':
      return {
        kind: 'in_progress',
        message:
          'Another publish for this app is running. Nothing was started. Wait for it to finish, then review again.',
      };
    case 'plan_changed':
    case 'plan_blocked':
      return {
        kind: 'plan_changed',
        message:
          'The staged changes or the store changed since you reviewed the plan, so nothing was published. Review the new plan.',
      };
    case 'invalid_steps':
    case 'invalid_request':
      return { kind: 'invalid', message: 'Those steps cannot be combined. Nothing was done.' };
    case 'not_found':
      return { kind: 'not_found', message: 'That app is not here any more. Reload the page.' };
    default:
      return {
        kind: 'other',
        message:
          error.status === 429
            ? 'Too many requests. Wait a moment, then review again.'
            : error.status >= 500 || error.status === 0
              ? 'The server had a problem. Nothing was retried. Review again to see where things stand.'
              : `The request was refused (${error.status}). Nothing was done.`,
      };
  }
}

/** A failure after which the person's only way forward is to review the plan again. */
export const needsReview = (failure: PublishFailure): boolean =>
  failure.kind === 'plan_changed' ||
  failure.kind === 'step_disabled' ||
  failure.kind === 'in_progress';
