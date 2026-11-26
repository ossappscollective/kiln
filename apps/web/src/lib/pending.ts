import {
  can,
  fractionRefusalNotice,
  type Platform,
  type Role,
  type StoreId,
  supports,
} from '@kiln/core';
import { ApiError } from './api.ts';
import { type AppSection, appAddress, type PlatformScope } from './app-scope.ts';
import { formatList, formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { Publishing } from './publishing.ts';
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
 * never widens what the server allows. Results are worded here from fixed vocabulary; the store's own words (cleaned by the server)
 * are shown beside it, as a quotation, by `publish-failure.ts`.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const PUBLISH_ENV = 'KILN_STORE_PUBLISH_BATCH_ENABLED';

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
export type PublishStepType = 'push_draft' | 'push_and_submit' | 'submit' | 'release' | 'rollout';
export const PUBLISH_STEPS: readonly PublishStepType[] = [
  'push_draft',
  'push_and_submit',
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
export type PendingStore = StoreId;
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
  /** A publish of this app runs now (an older server sends none). The screens read it from `publishing-store`, which polls it. */
  publishing?: Publishing | null | undefined;
  /** The latest publish of this app when it did not complete, kept on the server (an older server sends none). See `publish-failure.ts`. */
  lastPublish?: LastPublish | null | undefined;
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
  publishing?: Publishing | null | undefined;
  lastPublish?: LastPublish | null | undefined;
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
  /**
   * Google Play, on `push_and_submit` only: replace the review that is in progress with everything together. Only the person's explicit
   * choice after a `changes_in_review` refusal (the plan asks for the same confirmation and step-up as any irreversible step).
   */
  replaceReview?: boolean;
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
  /**
   * Google Play: `push_and_submit` and `release` are ONE step with ONE commit (the push carries the texts, the graphics and the release;
   * the release row runs nothing of its own). Absent from an older server.
   */
  oneCommit?: boolean;
  /** The commit replaces the review in progress (the person chose it). Absent from an older server. */
  replacesReview?: boolean;
  /** The last run of this app was refused because changes were in review (a hint from the kept runs). Absent from an older server. */
  changesInReview?: boolean;
  /**
   * Google Play: the push and the submit as ONE step (`push_and_submit`). `offered`: the plan lists it beside the pair; `draftRefused`:
   * Google refused to keep a draft for this app on the last run (no draft push went through since); `defaulted`: the plan was made with
   * it instead of the pair because of that. Absent from an older server.
   */
  combined?: { offered: boolean; draftRefused: boolean; defaulted: boolean };
  /** Google Play: where the staged build comes from (another track that holds its codes) and its version, as the last sync saw them. Absent from an older server. */
  promotion?: { from: string | null; version: string | null } | null;
  /**
   * The step (or steps) the plan recommends, so the dialog never leaves a person with an empty plan while a valid step exists.
   * `steps` are the requests to send back; a release in them still needs the share from the person (`needsShare`). Absent from an older server.
   */
  recommended?: PlanRecommendation | null;
  readAt: number;
};

export type RecommendedWhy =
  | 'promotion'
  | 'direct_release'
  | 'draft_refused'
  | 'one_commit'
  | 'draft'
  | 'default';

export type PlanRecommendation = {
  types: PublishStepType[];
  steps: StepRequest[];
  why: RecommendedWhy;
  needsShare: boolean;
  /** The recommended push replaces the review in progress (`replaceReview`). Absent from an older server. */
  replacesReview?: boolean;
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

/** What the store answered when it refused (the server cleaned it: no credential, no token, cut to 600 characters). */
export type StoreFacts = {
  kind: string;
  httpStatus?: number;
  details?: { code?: string; title?: string; detail?: string }[];
};

/** One step of a kept run: its status and, for a failure, the code, the HTTP status and what the store said. */
export type RunStep = {
  type: PublishStepType;
  status: 'applied' | 'skipped' | 'failed';
  startedAt: number;
  finishedAt: number;
  error?: string;
  httpStatus?: number;
  outcome?: 'refused' | 'not_applied' | 'unknown' | 'partial';
  reason?: string;
  message?: string;
  /** The catalogue code of the sentence or of the store's cause (`store.google.draftApp`), with its parameters. */
  code?: string;
  params?: Record<string, string | number | boolean | null>;
  store?: StoreFacts;
};

/** A batch publish the server kept (migration 72): the newest five per app; `lastPublish` is the latest when it did not complete. */
export type LastPublish = {
  id: string;
  platform: Platform;
  startedAt: number;
  finishedAt: number;
  outcome: 'completed' | 'partial' | 'failed';
  completed: boolean;
  steps: PublishStepType[];
  results: RunStep[];
  by: { id: string; name: string | null } | null;
  /** A person hid this failure (it stays hidden until a newer run). */
  dismissed: boolean;
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
  /** This run as the server keeps it, with the reason each failed step gave (an older server sends none). */
  lastPublish?: LastPublish | null | undefined;
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

/**
 * A table of message keys as an object whose values are read in the active language each time (the exported label tables below are
 * used as `KIND_LABEL[kind]` by screens, so they must follow the language, not freeze it when the module loads).
 */
function translated<K extends string>(
  keys: Readonly<Record<K, string>>,
): Readonly<Record<K, string>> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(keys) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => t(keys[key]) });
  }
  return out;
}

/** Whole sentences, one after the other (empty ones dropped). */
const sentences = (...parts: readonly string[]): string => parts.filter((p) => p !== '').join(' ');

export const KIND_LABEL: Readonly<Record<PendingKind, string>> = translated({
  listing_text: k('app:pending.kind.listingText'),
  asset_set: k('app:pending.kind.assetSet'),
  release_field: k('app:pending.kind.releaseField'),
  pushed_draft: k('app:pending.kind.pushedDraft'),
  draft_release: k('app:pending.kind.draftRelease'),
  approved: k('app:pending.kind.approved'),
  rollout_step: k('app:pending.kind.rolloutStep'),
  in_review: k('app:pending.kind.inReview'),
});

export const STEP_NAME: Readonly<Record<PublishStepType, string>> = translated({
  push_draft: k('app:pending.step.pushDraft'),
  push_and_submit: k('app:pending.step.pushAndSubmit'),
  submit: k('app:pending.step.submit'),
  release: k('app:pending.step.release'),
  rollout: k('app:pending.step.rollout'),
});

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export function stateBadge(state: PendingState): { label: string; tone: Tone } {
  switch (state) {
    case 'staged':
      return { label: t('app:pending.state.staged'), tone: 'info' };
    case 'invalid':
      return { label: t('app:pending.state.invalid'), tone: 'bad' };
    case 'pushed':
      return { label: t('app:pending.state.pushed'), tone: 'info' };
    case 'in_review':
      return { label: t('portfolio:status.inReview.label'), tone: 'neutral' };
    case 'approved':
      return { label: t('portfolio:status.approved.label'), tone: 'ok' };
    default:
      return { label: t('app:pending.state.due'), tone: 'warn' };
  }
}

/** What happens to an item next, in a sentence. Nothing here says it happens by itself: every step is confirmed. */
export function nextStepText(item: Pick<PendingItem, 'kind' | 'nextStep' | 'state'>): string {
  if (item.nextStep === null) return t('app:pending.next.none');
  if (item.state === 'invalid') return t('app:pending.next.invalid');
  switch (item.nextStep) {
    case 'push_draft':
      return t('app:pending.next.push');
    case 'submit':
      return t('app:pending.next.submit');
    case 'release':
      return item.kind === 'draft_release'
        ? t('app:pending.next.releaseDraft')
        : t('app:pending.next.releaseApproved');
    default:
      return t('app:pending.next.rollout');
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
      return { href: at('listing'), label: t('app:pending.edit.listing') };
    case 'asset_set':
      return { href: at('assets'), label: t('app:pending.edit.graphics') };
    case 'release_field':
      return {
        href: releaseStepHref(appId, platform, 'build'),
        label: t('app:pending.edit.release'),
      };
    default:
      return { href: at('releases'), label: t('app:pending.edit.releases') };
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
export function totalsLine(totals: PendingTotals): string {
  if (totals.items === 0) return t('app:pending.totals.nothing');
  const waiting = totals.items - totals.actionable;
  const parts: string[] = [];
  if (totals.actionable > 0)
    parts.push(t('app:pending.totals.forYou', { count: totals.actionable }));
  if (totals.blocking > 0) parts.push(t('app:pending.totals.errors', { count: totals.blocking }));
  if (waiting > 0) parts.push(t('app:pending.totals.forStore', { count: waiting }));
  return formatList(parts, { type: 'unit' });
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
  const text = t('app:pending.chip.text', { shown: n > 99 ? '99+' : String(n) });
  if (line.blocking > 0)
    return {
      text,
      tone: 'warn',
      label: t('app:pending.chip.label', { text, count: line.blocking }),
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

/** Why the role cannot publish everything at once, in the active language. */
export const publishRoleReason = (): string => t('app:pending.avail.role');

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
  if (!canPublishBatch(input.role)) return { state: 'role', message: publishRoleReason() };
  if (input.configFailed)
    return {
      state: 'unknown',
      message: t('app:pending.avail.unknown'),
    };
  const config = input.config;
  if (!config) return { state: 'loading', message: t('app:pending.avail.loadingConfig') };
  if (!config.enabled) {
    return {
      state: 'off',
      message: t('app:pending.avail.off', { env: config.envName || PUBLISH_ENV }),
    };
  }
  if (input.totals === null)
    return { state: 'loading', message: t('app:pending.avail.loadingTotals') };
  if (input.totals.actionable === 0)
    return { state: 'nothing', message: t('app:pending.avail.nothing') };
  const off = input.nextSteps.filter((s) => config.steps?.[s] && config.steps[s].enabled === false);
  if (input.nextSteps.length > 0 && off.length === input.nextSteps.length) {
    return {
      state: 'steps_off',
      message: t('app:pending.avail.stepsOff', {
        names: off.map((s) => config.steps[s].envName).join(', '),
      }),
    };
  }
  if (input.totals.blocking > 0) {
    const n = input.totals.blocking;
    return {
      state: 'blocked',
      message: t('app:pending.avail.blocked', { count: n }),
    };
  }
  return { state: 'ready' };
}

// ---------------------------------------------------------------------------------------------
// The plan as the dialog shows it

export const AVAILABILITY_WORD: Readonly<Record<Availability, string>> = translated({
  available: k('app:pending.word.available'),
  feature_disabled: k('app:pending.word.featureDisabled'),
  forbidden: k('app:pending.word.forbidden'),
  nothing_to_do: k('app:pending.word.nothingToDo'),
  blocked: k('app:pending.word.blocked'),
  needs_input: k('app:pending.word.needsInput'),
  not_requested: k('app:pending.word.notRequested'),
});

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
  /** Why an idle step is left out, so the line that names it is accurate: it does not apply to this app, there is nothing to do, or it is only an option. */
  hiddenWhy: HiddenWhy | null;
};

export type HiddenWhy = 'unsupported' | 'nothing' | 'optional';

/** The row of one step of the plan, from the plan alone. The rollout always names a change, so it stays a single step. */
export function stepRow(step: PlanStep, platform: Platform): StepRow {
  const needsInput =
    step.type === 'release' &&
    supports(platform, 'releaseTracks') &&
    step.availability === 'needs_input';
  let toggleable = step.availability === 'available' || step.availability === 'not_requested';
  let reason = step.reason;
  if (step.type === 'rollout') {
    toggleable = false;
    if (step.availability !== 'nothing_to_do') reason = t('app:pending.row.rolloutSingle');
  } else if (step.availability === 'needs_input') {
    // A Google Play release is ticked after the dialog asked for the track and the share; any other step that needs details stays single.
    toggleable = needsInput;
    if (!needsInput) reason = t('app:pending.row.needsDetails');
  } else if (step.availability === 'feature_disabled') {
    reason = t('app:pending.row.switchedOff', { env: step.requires.envName });
  } else if (step.availability === 'forbidden') {
    reason = t('app:pending.row.forbidden', { action: step.requires.action });
  } else if (step.availability === 'available') {
    reason = null;
  } else if (step.availability === 'not_requested') {
    reason = t('app:pending.row.notRequested');
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
    // A step the person asked for is never left out: it shows why it cannot run.
    idle: hiddenWhyOf(step, platform) !== null,
    hiddenWhy: hiddenWhyOf(step, platform),
  };
}

function hiddenWhyOf(step: PlanStep, platform: Platform): HiddenWhy | null {
  if (step.availability === 'nothing_to_do' && !step.requested) return 'nothing';
  if (
    supports(platform, 'releaseTracks') &&
    step.type === 'submit' &&
    step.availability === 'not_requested'
  )
    return 'unsupported';
  return null;
}

/**
 * The rows the dialog shows: the steps that have something to do, numbered one after the other, and the names of the steps left out
 * (for one quiet line). When no step has anything to do, every row stays so the dialog can say why.
 */
export function visibleRows(rows: readonly StepRow[]): {
  shown: StepRow[];
  left: string[];
  /** The same names, by why they are left out (each group is one accurate line). */
  leftBy: Record<HiddenWhy, string[]>;
} {
  const leftBy: Record<HiddenWhy, string[]> = { unsupported: [], nothing: [], optional: [] };
  const active = rows.filter((r) => !r.idle);
  if (active.length === 0) return { shown: [...rows], left: [], leftBy };
  for (const r of rows) if (r.idle) leftBy[r.hiddenWhy ?? 'nothing'].push(r.label);
  return {
    shown: active.map((r, i) => ({ ...r, order: i + 1 })),
    left: rows.filter((r) => r.idle).map((r) => r.label),
    leftBy,
  };
}

export const stepRows = (plan: PublishPlan): StepRow[] => {
  // The combined step (Google Play: push and send for review in one commit) is offered only beside a submit that is part of the plan, or
  // when it is itself part of it: "Google Play may refuse to keep a draft" is a question for a person who wants a review.
  const wantsReview = plan.steps.some(
    (s) => s.included && (s.type === 'submit' || s.type === 'push_and_submit'),
  );
  return [...plan.steps]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const row = stepRow(s, plan.app.platform);
      if (s.type !== 'push_and_submit') return row;
      // Named in the person's language (the server's label is English), and left out unless a review is wanted.
      const optional = !s.included && !wantsReview && row.hiddenWhy === null;
      return {
        ...row,
        label: STEP_NAME.push_and_submit,
        idle: row.idle || optional,
        hiddenWhy: row.hiddenWhy ?? (optional ? 'optional' : null),
      };
    });
};

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
  // Google Play: a push and a release are ONE edit and ONE commit, never two that each send for review.
  const types = oneCommitTypes(plan, wanted);
  for (const type of PUBLISH_STEPS) {
    if (types.indexOf(type) < 0) continue;
    const given = extra[type];
    const step = plan.steps.filter((s) => s.type === type)[0];
    out.push(given ?? (step?.included && step.request ? step.request : { type }));
  }
  return out;
}

/**
 * Google Play: the types to ask for when a release is ticked next to a push. A push (a draft) and a release would be two commits, and
 * Google refuses the second while the first one's changes are in review; the push that sends for review carries the release in its own
 * edit instead (docs/adr/0069-one-play-commit.md). Only when a release can be made from the staged fields, and never with a separate
 * submit (the server says why that cannot be). Anything else is as it was.
 */
export function oneCommitTypes(
  plan: PublishPlan,
  types: readonly PublishStepType[],
): PublishStepType[] {
  const has = (t: PublishStepType): boolean => types.indexOf(t) >= 0;
  if (
    !supports(plan.app.platform, 'transactionalEdits') ||
    (plan.direct ?? null) === null ||
    !has('release') ||
    !(has('push_draft') || has('push_and_submit')) ||
    has('submit')
  )
    return [...types];
  return PUBLISH_STEPS.filter((t) =>
    t === 'push_and_submit' ? true : t === 'push_draft' ? false : has(t),
  );
}

/** The types the person has in the plan: the included ones, and a step asked for that only waits for its input (the release's share). */
export const planTypes = (plan: PublishPlan): PublishStepType[] =>
  plan.steps
    .filter((s) => s.included || (s.requested && s.availability === 'needs_input'))
    .map((s) => s.type);

/** `types` plus the steps the plan waits on (never twice). */
export const withWaiting = (
  plan: PublishPlan,
  types: readonly PublishStepType[],
): PublishStepType[] =>
  PUBLISH_STEPS.filter((t) => types.indexOf(t) >= 0 || planTypes(plan).indexOf(t) >= 0);

/** The requests with `replaceReview` set (or taken off) on the push that sends for review. Nothing else changes. */
export function withReplaceReview(requests: readonly StepRequest[], on: boolean): StepRequest[] {
  return requests.map((r) => {
    if (r.type !== 'push_and_submit') return r;
    const { replaceReview: _was, ...rest } = r;
    return on ? { ...rest, replaceReview: true } : rest;
  });
}

/**
 * "Replace the review in progress with everything together": the push that sends for review with `replaceReview`, and the release
 * from the staged fields (its share comes from the person in the dialog; the server never implies one). Only a plan that the person
 * confirms runs it.
 */
export const replaceReviewSteps = (): StepRequest[] => [
  { type: 'push_and_submit', replaceReview: true },
  { type: 'release' },
];

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

/**
 * The release step the person adds is DIRECT (made from the staged build and sent in one step) whenever a build is staged and no draft
 * push is part of the plan: with no draft in the store a plain release would have nothing to start. It follows the plan, never only
 * the way the dialog first opened. With a draft push in the plan, the release rolls out that draft after it.
 */
export const releaseIsDirect = (
  plan: PublishPlan | null,
  wanted: readonly PublishStepType[],
  wasDirect: boolean,
): boolean =>
  wasDirect ||
  (plan !== null &&
    (plan.direct ?? null) !== null &&
    wanted.indexOf('push_draft') < 0 &&
    wanted.indexOf('push_and_submit') < 0);

/**
 * The requests of the plan's recommended step(s), with the person's share added to a release. Null: the plan recommends nothing, or
 * the recommended release still needs a share the person has not given (the dialog then asks for it; nothing is implied).
 */
export function recommendedRequests(
  plan: PublishPlan | null,
  input: { fraction: number | null },
): StepRequest[] | null {
  const rec = plan?.recommended ?? null;
  if (rec === null || rec.steps.length === 0) return null;
  const out: StepRequest[] = [];
  for (const step of rec.steps) {
    if (step.type !== 'release') {
      out.push({ ...step });
      continue;
    }
    if (input.fraction === null) return null;
    out.push({ ...step, userFraction: input.fraction });
  }
  return out;
}

/** The ticked steps are exactly the recommended ones. */
export const isRecommended = (
  plan: PublishPlan | null,
  wanted: readonly PublishStepType[],
): boolean => {
  const rec = plan?.recommended ?? null;
  return (
    rec !== null &&
    wanted.length === rec.types.length &&
    rec.types.every((type) => wanted.indexOf(type) >= 0)
  );
};

/**
 * What to say when nothing is ticked: the recommended step (with a button that uses it), or, when the plan recommends nothing, that
 * there is nothing to publish. Never an error: an empty selection is a choice, not a failure. Null: something is ticked.
 */
export type EmptySelectionHint =
  | { kind: 'recommend'; why: RecommendedWhy; needsShare: boolean; types: PublishStepType[] }
  | { kind: 'nothing' };

export function emptySelectionHint(
  plan: PublishPlan | null,
  wanted: readonly PublishStepType[],
): EmptySelectionHint | null {
  if (plan === null || wanted.length > 0) return null;
  const rec = plan.recommended ?? null;
  if (rec === null || rec.types.length === 0) return { kind: 'nothing' };
  return { kind: 'recommend', why: rec.why, needsShare: rec.needsShare, types: rec.types };
}

/**
 * Whether the dialog should use the recommended step by itself: the first plan it got holds nothing, and a step is recommended. The
 * person never starts on an empty plan while a valid step exists. A plan that already holds steps is left as it is.
 */
export const shouldAutoRecommend = (plan: PublishPlan): boolean =>
  plan.included === 0 && (plan.recommended ?? null) !== null;

/**
 * The sentence that says what is recommended and why, in the person's language. `shareMissing`: the recommended release still waits
 * for the share of users, and the sentence says so.
 */
export function recommendedSentence(
  plan: PublishPlan | null,
  input: { shareMissing: boolean },
): string {
  const rec = plan?.recommended ?? null;
  if (plan === null || rec === null) return '';
  const first = rec.steps[0];
  const track = (first?.track ?? plan.direct?.track ?? 'production').trim();
  let text: string;
  if (rec.why === 'promotion') text = t('publish:dialog.recommendedPromotion', { track });
  else if (rec.why === 'direct_release') text = t('publish:dialog.recommendedDirect', { track });
  else if (rec.why === 'draft_refused') text = t('publish:dialog.recommendedDraftRefused');
  else if (rec.why === 'one_commit')
    text = t(
      rec.replacesReview === true
        ? k('publish:dialog.recommendedReplace')
        : k('publish:dialog.recommendedOneCommit'),
    );
  else if (rec.why === 'draft') text = t('publish:dialog.recommendedDraft');
  else text = t('publish:dialog.recommendedDefault');
  return rec.needsShare && input.shareMissing
    ? `${text} ${t('publish:dialog.recommendedNeedsShare')}`
    : text;
}

/** The types that are part of the plan. */
export const includedTypes = (plan: PublishPlan): PublishStepType[] =>
  plan.steps.filter((s) => s.included).map((s) => s.type);

export const toggled = (
  current: readonly PublishStepType[],
  type: PublishStepType,
  on: boolean,
): PublishStepType[] => {
  const keep = (t: PublishStepType): boolean => (t === type ? on : current.indexOf(t) >= 0);
  // The combined step IS the push and the submit: ticking one side unticks the other, and unticking the combined step goes back to
  // the pair (what it replaced), never to nothing.
  if (type === 'push_and_submit')
    return PUBLISH_STEPS.filter((t) => {
      if (t === 'push_and_submit') return on;
      if (t === 'push_draft' || t === 'submit') return !on;
      return keep(t);
    });
  return PUBLISH_STEPS.filter((t) => {
    if (t === 'push_and_submit')
      return !(on && (type === 'push_draft' || type === 'submit')) && keep(t);
    return keep(t);
  });
};

/** "Push and submit for review in one step": the combined step alone (Google Play). The person still confirms the plan it makes. */
export const pushAndSubmitSteps = (): StepRequest[] => [{ type: 'push_and_submit' }];

/** The plan holds the combined step. */
export const isCombinedPlan = (plan: PublishPlan | null): boolean =>
  plan !== null && plan.steps.some((s) => s.type === 'push_and_submit' && s.included);

/** A failed step Google Play refused to keep as a draft: the way forward is the combined step, or Play Console. */
export const isDraftRefused = (step: { type: string; error?: string | undefined }): boolean =>
  step.type === 'push_draft' && step.error === 'draft_not_allowed';

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
  // `t` is the name of a count below; the message function is `translate` here.
  const translate = t;
  const s = step.summary ?? {};
  const num = (key: string): number | null =>
    typeof s[key] === 'number' ? (s[key] as number) : null;
  const str = (key: string): string | null =>
    typeof s[key] === 'string' && s[key] !== '' ? (s[key] as string) : null;
  const parts: string[] = [];
  if (step.type === 'push_draft' || step.type === 'push_and_submit') {
    const t = num('textChanged');
    const a = num('assetSetsChanged');
    const f = num('fieldsChanged');
    if (t !== null) parts.push(translate(k('app:pending.summary.textChanges'), { count: t }));
    if (a !== null) parts.push(translate(k('app:pending.summary.graphicsSets'), { count: a }));
    if (f !== null && f > 0)
      parts.push(translate(k('app:pending.summary.releaseFields'), { count: f }));
    // ONE commit: the same step also releases (the release it carries, in numbers and names).
    const made = s.release;
    if (typeof made === 'object' && made !== null) {
      const r = made as Record<string, unknown>;
      if (typeof r.track === 'string' && r.track !== '')
        parts.push(translate(k('app:pending.summary.track'), { track: r.track }));
      if (typeof r.userFraction === 'number')
        parts.push(
          translate(k('app:pending.summary.share'), {
            share: formatPercent(r.userFraction, { maximumFractionDigits: 2 }),
          }),
        );
    }
  } else if (step.type === 'submit') {
    const v = str('versionString');
    const t = num('texts');
    const a = num('assetSets');
    if (v) parts.push(translate(k('app:pending.summary.version'), { version: v }));
    if (t !== null) parts.push(translate(k('app:pending.summary.texts'), { count: t }));
    if (a !== null) parts.push(translate(k('app:pending.summary.graphicsSets'), { count: a }));
  } else if (step.type === 'release') {
    const v = str('version');
    const track = str('track');
    const share = num('userFraction');
    const audience = str('audience');
    if (v) parts.push(translate(k('app:pending.summary.version'), { version: v }));
    if (track) parts.push(translate(k('app:pending.summary.track'), { track }));
    if (share !== null)
      parts.push(
        translate(k('app:pending.summary.share'), {
          share: formatPercent(share, { maximumFractionDigits: 2 }),
        }),
      );
    if (audience)
      parts.push(
        audience === 'all'
          ? translate(k('app:pending.summary.allUsers'))
          : audience === 'phased'
            ? translate(k('app:pending.summary.phased'))
            : translate(k('app:pending.summary.someUsers')),
      );
  }
  return parts;
}

/** The promise of a step that is checked again after the earlier ones ran, in words. Numbers and names only. */
export function promiseText(step: Pick<PlanStep, 'type' | 'summary'>): string {
  const parts = summaryParts(step);
  return parts.length === 0
    ? t('app:pending.promise.none')
    : t('app:pending.promise.parts', { parts: formatList(parts, { type: 'unit' }) });
}

// ---------------------------------------------------------------------------------------------
// The result of a publish, in fixed words

/** The note under a stopped publish, in the active language. */
export const stopNote = (): string => t('app:pending.stopNote');

const FAILED_TEXT: Readonly<Record<string, string>> = {
  state_changed: k('app:pending.failed.stateChanged'),
  blocked: k('app:pending.failed.blocked'),
  outcome_unknown: k('app:pending.failed.outcomeUnknown'),
  write_in_progress: k('app:pending.failed.writeInProgress'),
  draft_partial: k('app:pending.failed.draftPartial'),
  changes_in_review: k('app:pending.failed.changesInReview'),
  confirmation_mismatch: k('app:pending.failed.confirmationMismatch'),
  rate_limited: k('app:pending.failed.rateLimited'),
  store_unavailable: k('app:pending.failed.storeUnavailable'),
  timeout: k('app:pending.failed.timeout'),
  write_failed: k('app:pending.failed.writeFailed'),
  store_auth: k('app:pending.failed.storeAuth'),
  store_forbidden: k('app:pending.failed.storeForbidden'),
  store_not_found: k('app:pending.failed.storeNotFound'),
  store_rejected: k('app:pending.failed.storeRejected'),
  step_error: k('app:pending.failed.stepError'),
  asset_changed: k('app:pending.failed.assetChanged'),
  asset_unreadable: k('app:pending.failed.assetUnreadable'),
  staged_invalid: k('app:pending.failed.stagedInvalid'),
  nothing_staged: k('app:pending.failed.nothingStaged'),
  nothing_pushed: k('app:pending.failed.nothingPushed'),
  no_editable_version: k('app:pending.failed.noEditableVersion'),
  draft_not_allowed: k('app:pending.failed.draftNotAllowed'),
};

/** The sentence for a failed step's error code, or '' when the code has none here. */
export const failedSentence = (error: string): string => said(FAILED_TEXT, error, '');

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  refused: k('app:pending.outcome.refused'),
  not_applied: k('app:pending.outcome.notApplied'),
  unknown: k('app:pending.outcome.unknown'),
  partial: k('app:pending.outcome.partial'),
};

const SKIPPED_TEXT: Readonly<Record<string, string>> = {
  previous_step_not_applied: k('app:pending.skipped.previousStepNotApplied'),
  plan_drifted: k('app:pending.skipped.planDrifted'),
  blocked: k('app:pending.skipped.blocked'),
  preview_failed: k('app:pending.skipped.previewFailed'),
};

/** The text of a code in one of the tables above, or the fallback; '' when there is no code. */
const said = (
  table: Readonly<Record<string, string>>,
  code: string | undefined,
  fallback = '',
): string => {
  const key = code === undefined ? undefined : table[code];
  return key === undefined ? fallback : t(key);
};

/** The sentence for the outcome of a failed step (`refused`, `not_applied`, `unknown`, `partial`), or ''. */
export const outcomeSentence = (outcome: string | undefined): string => said(OUTCOME_TEXT, outcome);

/** The sentence for why a step was not run, or ''. */
export const skippedSentence = (reason: string | undefined): string =>
  said(SKIPPED_TEXT, reason, t('app:pending.skipped.default'));

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
  return t('app:pending.result.storeSaid', { said: cut });
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
      word: t('app:pending.result.done'),
      tone: 'ok',
      text: step.confirmedByReread
        ? t('app:pending.result.doneConfirmed')
        : t('app:pending.result.doneText'),
      review: false,
    };
  }
  if (step.status === 'skipped') {
    return {
      type: step.type,
      label,
      status: 'skipped',
      word: t('app:pending.result.notRun'),
      tone: 'neutral',
      text: said(SKIPPED_TEXT, step.reason, t('app:pending.skipped.default')),
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
        word: t('app:pending.result.failed'),
        tone: 'bad',
        text: sentences(t('core:play.fractionRefused'), said(OUTCOME_TEXT, step.outcome)),
        review: true,
      };
  }
  const text = sentences(
    said(
      FAILED_TEXT,
      step.error,
      t('app:pending.failed.unknownCode', { code: safeCode(step.error) }),
    ),
    storeSaid(step),
    said(OUTCOME_TEXT, step.outcome),
  );
  return {
    type: step.type,
    label,
    status: 'failed',
    word: t('app:pending.result.failed'),
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
      title: t('app:pending.result.allDone'),
      text: t('app:pending.result.stepsDone', { count: result.applied }),
      rows,
      review: false,
      stoppedAt: null,
    };
  }
  return {
    tone: result.failed > 0 ? 'error' : 'warn',
    title: stoppedAt
      ? t('app:pending.result.stoppedAt', { step: stoppedAt })
      : t('app:pending.result.notAll'),
    text: t('app:pending.result.counts', {
      applied: result.applied,
      failed: result.failed,
      skipped: result.skipped,
    }),
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
      message: t('app:pending.fail.network'),
    };
  switch (error.code) {
    case 'publish_batch_disabled':
      return {
        kind: 'disabled',
        message: t('app:pending.fail.disabled', { env: config?.envName || PUBLISH_ENV }),
      };
    case 'step_disabled':
      return {
        kind: 'step_disabled',
        message: t('app:pending.fail.stepDisabled'),
      };
    case 'forbidden':
      return {
        kind: 'forbidden',
        message: t('app:pending.fail.forbidden'),
      };
    case 'confirmation_mismatch':
      return {
        kind: 'mismatch',
        message: t('app:pending.fail.mismatch'),
      };
    case 'publish_in_progress':
      return {
        kind: 'in_progress',
        message: t('app:pending.fail.inProgress'),
      };
    case 'plan_changed':
    case 'plan_blocked':
      return {
        kind: 'plan_changed',
        message: t('app:pending.fail.planChanged'),
      };
    case 'invalid_steps':
    case 'invalid_request':
      return { kind: 'invalid', message: t('app:pending.fail.invalid') };
    case 'not_found':
      return { kind: 'not_found', message: t('app:pending.fail.notFound') };
    default:
      return {
        kind: 'other',
        message:
          error.status === 429
            ? t('app:pending.fail.tooMany')
            : error.status >= 500 || error.status === 0
              ? t('app:pending.fail.server')
              : t('app:pending.fail.refused', { status: error.status }),
      };
  }
}

/** A failure after which the person's only way forward is to review the plan again. */
export const needsReview = (failure: PublishFailure): boolean =>
  failure.kind === 'plan_changed' ||
  failure.kind === 'step_disabled' ||
  failure.kind === 'in_progress';
