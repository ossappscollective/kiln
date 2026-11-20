/**
 * Staged rollout as planning data: an ordered list of steps ("1%, then 5%, then 20%...") kept on a
 * release plan, templates for it, the rules that check it, and the comparison with what the store
 * last reported. Pure functions only, so the API and the web UI agree.
 *
 * It is PLANNING DATA ONLY. Nothing here reads a store with a credential or writes to one: a
 * step marked done does not change a rollout, and a store that moved on does not mark a step done
 * (a person confirms it, see `compareRollout`).
 */
import type { ReleaseState } from './lifecycle.ts';
import { type Platform, storeFamilyOf, supports } from '../platform.ts';

// ---------------------------------------------------------------------------------------------
// Limits and shapes

export const MAX_ROLLOUT_STEPS = 12;
export const MAX_ROLLOUT_NOTE_LENGTH = 200;

/**
 * `steps`: our own list of percentages (Google Play lets you choose any share, so the plan is
 * editable). `apple_phased`: Apple's phased release, whose schedule is fixed by Apple: the plan
 * only records that it is used and when day 1 is expected. It has no editable percentages.
 */
export const ROLLOUT_KINDS = ['steps', 'apple_phased'] as const;
export type RolloutKind = (typeof ROLLOUT_KINDS)[number];

export const ROLLOUT_STEP_STATUSES = ['planned', 'done', 'skipped'] as const;
export type RolloutStepStatus = (typeof ROLLOUT_STEP_STATUSES)[number];

/** `manual`: a person said so. `store`: a person confirmed it against the share the store reported. */
export type RolloutDoneSource = 'manual' | 'store';

/** A step as a client sends it. Without an `id` it is a new step. */
export type RolloutStepInput = {
  id?: string | undefined;
  /** An integer from 1 to 100. */
  percent: number;
  /** Epoch milliseconds. */
  plannedAt?: number | null | undefined;
  note?: string | null | undefined;
};

/** A step as stored. */
export type RolloutStepState = {
  id: string;
  percent: number;
  plannedAt: number | null;
  note: string | null;
  status: RolloutStepStatus;
  doneAt: number | null;
};

export type RolloutIssue = { path: string; message: string };

// ---------------------------------------------------------------------------------------------
// Apple's phased release

/**
 * Apple's phased release for automatic updates: seven days, a share of users each day. The
 * schedule is Apple's and cannot be changed. Source: App Store Connect Help, "Release a version
 * update in phases" (checked when this was written). Our connector does not read the phased
 * release (see docs/phase-2.md), so this is Apple's published schedule, not something observed.
 */
export const APPLE_PHASED_SCHEDULE: readonly { day: number; percent: number }[] = [
  { day: 1, percent: 1 },
  { day: 2, percent: 2 },
  { day: 3, percent: 5 },
  { day: 4, percent: 10 },
  { day: 5, percent: 20 },
  { day: 6, percent: 50 },
  { day: 7, percent: 100 },
];

// ---------------------------------------------------------------------------------------------
// Templates

export type RolloutTemplate = {
  /** `builtin:<key>`. */
  id: string;
  name: string;
  description: string;
  /** A platform of the store family it fits (iOS and macOS share Apple's phased release); `null` fits any. */
  platform: Platform | null;
  kind: RolloutKind;
  /** The steps of a `steps` template. Empty for `apple_phased`. */
  steps: { percent: number; note?: string }[];
};

export const ROLLOUT_TEMPLATES: readonly RolloutTemplate[] = [
  {
    id: 'builtin:play-default',
    name: 'Staged rollout: 1, 5, 20, 50, 100%',
    description:
      'A cautious ramp for Google Play. Play lets you choose any share; these numbers are our suggestion, not a Play default.',
    platform: 'android',
    kind: 'steps',
    steps: [{ percent: 1 }, { percent: 5 }, { percent: 20 }, { percent: 50 }, { percent: 100 }] },
  {
    id: 'builtin:apple-phased',
    name: 'App Store phased release (7 days)',
    description:
      'Apple releases to automatic updates over 7 days: 1, 2, 5, 10, 20, 50 and 100% on days 1 to 7. The schedule is fixed by Apple, so it is shown for information and the percentages cannot be edited.',
    platform: 'ios',
    kind: 'apple_phased',
    steps: [] },
  {
    id: 'builtin:immediate',
    name: 'Immediate release to 100%',
    description: 'No staging: everyone gets the version at once.',
    platform: null,
    kind: 'steps',
    steps: [{ percent: 100 }] },
];

export const rolloutTemplate = (id: string): RolloutTemplate | undefined =>
  ROLLOUT_TEMPLATES.find((t) => t.id === id);

/** The templates that make sense for an app of this platform. */
export const rolloutTemplatesFor = (platform: Platform): RolloutTemplate[] =>
  ROLLOUT_TEMPLATES.filter(
    (t) => t.platform === null || storeFamilyOf(t.platform) === storeFamilyOf(platform),
  );

// ---------------------------------------------------------------------------------------------
// Validation

const validDate = (value: number) =>
  Number.isInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());

/**
 * Checks a rollout plan before it is stored. Rules: 1 to 12 steps; each percent a whole number from
 * 1 to 100, strictly increasing (so only the last can be 100); planned times that do not go
 * backwards and are not before the plan was created (a step already done keeps its time); an id
 * that is known; a step that is done keeps its percent and cannot be left out; no open step before
 * a done one. `existing` is what is stored now (empty for a first rollout plan).
 */
export function validateRolloutSteps(
  input: readonly RolloutStepInput[],
  options: { planCreatedAt: number; existing?: readonly RolloutStepState[] },
): { ok: true } | { ok: false; issues: RolloutIssue[] } {
  const issues: RolloutIssue[] = [];
  const existing = new Map((options.existing ?? []).map((s) => [s.id, s]));
  if (input.length < 1)
    issues.push({ path: 'steps', message: 'A rollout plan needs at least one step.' });
  if (input.length > MAX_ROLLOUT_STEPS) {
    issues.push({
      path: 'steps',
      message: `A rollout plan can have ${MAX_ROLLOUT_STEPS} steps at most.` });
  }
  const seen = new Set<string>();
  let previousPercent = 0;
  let previousPlannedAt: number | null = null;
  const statuses: RolloutStepStatus[] = [];
  input.forEach((step, i) => {
    const at = `steps.${i}`;
    const stored = step.id === undefined ? undefined : existing.get(step.id);
    if (step.id !== undefined) {
      if (!stored)
        issues.push({
          path: `${at}.id`,
          message: 'This step does not exist. Reload and try again.' });
      else if (seen.has(step.id))
        issues.push({ path: `${at}.id`, message: 'A step is listed twice.' });
      seen.add(step.id);
    }
    statuses.push(stored?.status ?? 'planned');
    if (!Number.isInteger(step.percent) || step.percent < 1 || step.percent > 100) {
      issues.push({ path: `${at}.percent`, message: 'A whole number from 1 to 100.' });
    } else {
      if (step.percent <= previousPercent) {
        issues.push({
          path: `${at}.percent`,
          message: `Each step must be higher than the one before (${previousPercent}%).` });
      }
      previousPercent = Math.max(previousPercent, step.percent);
      if (stored?.status === 'done' && stored.percent !== step.percent) {
        issues.push({
          path: `${at}.percent`,
          message: 'A step that is done keeps its percentage. Reopen it first.' });
      }
    }
    const plannedAt = step.plannedAt ?? null;
    if (plannedAt !== null) {
      if (!validDate(plannedAt)) {
        issues.push({ path: `${at}.plannedAt`, message: 'A date and time.' });
      } else {
        if (stored?.status !== 'done' && plannedAt < options.planCreatedAt) {
          issues.push({
            path: `${at}.plannedAt`,
            message: 'Plan a step after the plan was created.' });
        }
        if (previousPlannedAt !== null && plannedAt < previousPlannedAt) {
          issues.push({
            path: `${at}.plannedAt`,
            message: 'A step cannot be planned before the step above it.' });
        }
        previousPlannedAt = plannedAt;
      }
    }
    const note = step.note ?? null;
    if (note !== null && (note.length > MAX_ROLLOUT_NOTE_LENGTH || /[\r\n]/.test(note))) {
      issues.push({
        path: `${at}.note`,
        message: `One line of at most ${MAX_ROLLOUT_NOTE_LENGTH} characters.` });
    }
  });
  for (const stored of existing.values()) {
    if (stored.status === 'done' && !seen.has(stored.id)) {
      issues.push({
        path: 'steps',
        message: `The step at ${stored.percent}% is done and cannot be removed. Reopen it first.` });
    }
  }
  const lastDone = statuses.lastIndexOf('done');
  if (lastDone > 0 && statuses.slice(0, lastDone).includes('planned')) {
    issues.push({
      path: 'steps',
      message: 'A step before a completed step must be done or skipped.' });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ---------------------------------------------------------------------------------------------
// Moving one step

export type RolloutAction = 'complete' | 'skip' | 'reopen';

export type TransitionCheck =
  | {
      ok: true;
      /** Already in the wanted state: nothing to write. */
      noop: boolean;
      to: RolloutStepStatus;
    }
  | {
      ok: false;
      code: 'step_not_found' | 'earlier_steps_open' | 'later_steps_done' | 'invalid_transition';
      message: string;
    };

/**
 * Whether a step may move. Complete: earlier steps must be done or skipped (a rollout goes in
 * order). Skip: only an open step. Reopen: only when no later step is done. Asking for the state a
 * step is in is accepted and changes nothing.
 */
export function checkRolloutAction(
  steps: readonly Pick<RolloutStepState, 'id' | 'status' | 'percent'>[],
  stepId: string,
  action: RolloutAction,
): TransitionCheck {
  const index = steps.findIndex((s) => s.id === stepId);
  const step = steps[index];
  if (!step) return { ok: false, code: 'step_not_found', message: 'That step does not exist.' };
  const target: RolloutStepStatus =
    action === 'complete' ? 'done' : action === 'skip' ? 'skipped' : 'planned';
  if (step.status === target) return { ok: true, noop: true, to: target };
  if (action === 'complete') {
    if (steps.slice(0, index).some((s) => s.status === 'planned')) {
      return {
        ok: false,
        code: 'earlier_steps_open',
        message: 'Complete or skip the earlier steps first.' };
    }
    return { ok: true, noop: false, to: target };
  }
  if (action === 'skip') {
    if (step.status === 'done') {
      return {
        ok: false,
        code: 'invalid_transition',
        message: 'A step that is done cannot be skipped. Reopen it first.' };
    }
    return { ok: true, noop: false, to: target };
  }
  if (steps.slice(index + 1).some((s) => s.status === 'done')) {
    return {
      ok: false,
      code: 'later_steps_done',
      message: 'Reopen the later steps that are done first.' };
  }
  return { ok: true, noop: false, to: target };
}

// ---------------------------------------------------------------------------------------------
// Summary

export type RolloutSummary = {
  kind: RolloutKind;
  total: number;
  done: number;
  skipped: number;
  /** Steps still open. */
  planned: number;
  /** Percent of the last step that is done (0 when none is). */
  planPercent: number;
  /** The last step that is done, 1-based. */
  current: { index: number; percent: number } | null;
  /** The first open step. */
  next: { id: string; index: number; percent: number; plannedAt: number | null } | null;
  /** Open steps whose planned time has passed. */
  dueSteps: number;
  /** Planned time of the first open step that has one, for sorting. */
  nextPlannedAt: number | null;
};

export function summarizeRollout(
  kind: RolloutKind,
  steps: readonly RolloutStepState[],
  now: number,
): RolloutSummary {
  const lastDone = steps.map((s) => s.status).lastIndexOf('done');
  const nextIndex = steps.findIndex((s) => s.status === 'planned');
  const next = nextIndex < 0 ? undefined : steps[nextIndex];
  return {
    kind,
    total: steps.length,
    done: steps.filter((s) => s.status === 'done').length,
    skipped: steps.filter((s) => s.status === 'skipped').length,
    planned: steps.filter((s) => s.status === 'planned').length,
    planPercent: lastDone < 0 ? 0 : (steps[lastDone]?.percent ?? 0),
    current: lastDone < 0 ? null : { index: lastDone + 1, percent: steps[lastDone]?.percent ?? 0 },
    next: next
      ? { id: next.id, index: nextIndex + 1, percent: next.percent, plannedAt: next.plannedAt }
      : null,
    dueSteps: steps.filter(
      (s) => s.status === 'planned' && s.plannedAt !== null && s.plannedAt <= now,
    ).length,
    nextPlannedAt:
      steps.find((s) => s.status === 'planned' && s.plannedAt !== null)?.plannedAt ?? null };
}

// ---------------------------------------------------------------------------------------------
// The plan against the store

/** What the last sync saw of one release. Read only: we never ask a store again for this. */
export type StoreRolloutObservation = {
  platform: Platform;
  /** The normalized state, or null when the store's state is not mapped. */
  status: ReleaseState | null;
  rawState: string | null;
  /** The share the store reported, 0 to 1 (Google Play's `userFraction`). Null when none was. */
  fraction: number | null;
  syncedAt: number | null;
};

export type StoreRollout = StoreRolloutObservation & {
  /** `fraction` as a percent with at most one decimal; or 100 for a Play release that is `live`. Null when unknown. */
  percent: number | null;
  /** True when `percent` was concluded from the status, not reported as a share. */
  inferred: boolean;
};

/**
 * The share of users the store says has the release. Only Google Play reports one. A Play release
 * in state `live` (its `completed` status) with no share is at 100% (marked `inferred`). Apple's
 * phased release is not read, so an iOS or macOS release never has a percent.
 */
export function storeRollout(observation: StoreRolloutObservation): StoreRollout {
  const { fraction } = observation;
  if (fraction !== null && Number.isFinite(fraction) && fraction > 0 && fraction <= 1) {
    return { ...observation, percent: Math.round(fraction * 1000) / 10, inferred: false };
  }
  if (!supports(observation.platform, 'phasedRelease') && observation.status === 'live') {
    return { ...observation, percent: 100, inferred: true };
  }
  return { ...observation, percent: null, inferred: false };
}

export type RolloutVerdict = 'unknown' | 'match' | 'store_ahead' | 'store_behind';

export type RolloutComparison = {
  verdict: RolloutVerdict;
  /** The store and the plan disagree (ahead or behind). `unknown` is not a mismatch. */
  mismatch: boolean;
  planPercent: number;
  planStep: { index: number; total: number; percent: number } | null;
  storePercent: number | null;
  /** The store has the release halted. */
  halted: boolean;
  /**
   * The open step a person may confirm from the store: the first open step, when the store's share
   * has reached it. Null otherwise. Nothing is confirmed unless a person asks.
   */
  confirmStepId: string | null;
  /** One or two sentences for a person. */
  message: string;
};

export const formatPercent = (value: number): string =>
  Number.isInteger(value) ? `${value}%` : `${(Math.round(value * 10) / 10).toFixed(1)}%`;

const SAME = 0.05;

/**
 * Plan against store: "store says 20%, plan says step 3 of 5 = 20%". The plan's position is its
 * last step that is done. The store's share is `storeRollout(...).percent`. A mismatch is flagged,
 * never fixed: a step is marked done only when a person asks, and only while the store's share has
 * reached the step (`confirmStepId`).
 */
export function compareRollout(
  steps: readonly RolloutStepState[],
  store: StoreRollout | null,
): RolloutComparison {
  const summary = summarizeRollout('steps', steps, 0);
  const planStep = summary.current
    ? { index: summary.current.index, total: steps.length, percent: summary.current.percent }
    : null;
  const planText = planStep
    ? `the plan has step ${planStep.index} of ${planStep.total} (${formatPercent(planStep.percent)}) done`
    : 'the plan has no step done yet';
  const base = {
    planPercent: summary.planPercent,
    planStep,
    storePercent: store?.percent ?? null,
    halted: store?.status === 'halted' };
  const halted = base.halted ? ' The store has the rollout halted.' : '';
  if (!store || store.percent === null) {
    const apple = store !== null && supports(store.platform, 'phasedRelease');
    return {
      ...base,
      verdict: 'unknown',
      mismatch: false,
      confirmStepId: null,
      message: store
        ? `${
            apple
              ? 'The share of an Apple phased release is not read from the store, so the plan cannot be compared.'
              : 'The store reports no rollout share for this version.'
          }${halted}`
        : 'The store has not reported this version yet.' };
  }
  const firstOpen = steps.find((s) => s.status === 'planned');
  const confirmStepId = firstOpen && store.percent >= firstOpen.percent ? firstOpen.id : null;
  const said = `Store says ${formatPercent(store.percent)}${store.inferred ? ' (live for everyone)' : ''}`;
  if (Math.abs(store.percent - summary.planPercent) < SAME) {
    return {
      ...base,
      verdict: 'match',
      mismatch: false,
      confirmStepId,
      message: `${said}, ${planText}: they agree.${halted}` };
  }
  if (store.percent > summary.planPercent) {
    return {
      ...base,
      verdict: 'store_ahead',
      mismatch: true,
      confirmStepId,
      message: `${said}, ahead of the plan: ${planText}.${confirmStepId ? ' You can confirm the next step from the store.' : ''}${halted}` };
  }
  return {
    ...base,
    verdict: 'store_behind',
    mismatch: true,
    confirmStepId: null,
    message: `${said}, behind the plan: ${planText}. Check the console, or reopen the steps that are not true.${halted}` };
}

// ---------------------------------------------------------------------------------------------
// Reminders

/** Hours before the end of the target day from which a deadline is "due soon". */
export const DEFAULT_REMINDER_LEAD_HOURS = 24;
export const MAX_REMINDER_LEAD_HOURS = 14 * 24;
/** A deadline or step that passed longer ago than this is not reminded about: it is stale, not news. */
export const REMINDER_STALE_DAYS = 30;

export type DeadlineReminderKind = 'due_soon' | 'overdue';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Which deadline reminder a target date calls for at `now`, or null. The target day ends at the
 * start of the next UTC day (the same moment `dueFlags` calls overdue). "Due soon" starts
 * `leadHours` before that moment; "overdue" starts at it and stops being sent after
 * `REMINDER_STALE_DAYS`. A release that is out has no reminders.
 */
export function deadlineReminder(
  targetDate: string | null,
  now: number,
  options: { leadHours?: number; released?: boolean } = {},
): { kind: DeadlineReminderKind | null; dueKey: string; hoursLeft: number; daysOverdue: number } {
  const none = { kind: null, dueKey: targetDate ?? '', hoursLeft: 0, daysOverdue: 0 };
  if (targetDate === null || options.released) return none;
  const start = Date.parse(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(start)) return none;
  const end = start + DAY_MS;
  const lead =
    Math.min(
      Math.max(options.leadHours ?? DEFAULT_REMINDER_LEAD_HOURS, 1),
      MAX_REMINDER_LEAD_HOURS,
    ) * HOUR_MS;
  if (now >= end) {
    const late = now - end;
    return late > REMINDER_STALE_DAYS * DAY_MS
      ? none
      : {
          kind: 'overdue',
          dueKey: targetDate,
          hoursLeft: 0,
          daysOverdue: Math.floor(late / DAY_MS) + 1 };
  }
  if (now >= end - lead) {
    return {
      kind: 'due_soon',
      dueKey: targetDate,
      hoursLeft: Math.max(0, Math.ceil((end - now) / HOUR_MS)),
      daysOverdue: 0 };
  }
  return none;
}

/** Whether an open step's planned time has passed (and is not stale), so a reminder is due. */
export function rolloutStepReminderDue(
  step: Pick<RolloutStepState, 'status' | 'plannedAt'>,
  now: number,
): boolean {
  return (
    step.status === 'planned' &&
    step.plannedAt !== null &&
    step.plannedAt <= now &&
    now - step.plannedAt <= REMINDER_STALE_DAYS * DAY_MS
  );
}
