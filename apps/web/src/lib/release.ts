import {
  byFamily,
  type DueFlags,
  isPlanLocale,
  MAX_ROLLOUT_STEPS,
  type PlanPlatform,
  type Platform,
  platformMeta,
  type RolloutComparison,
  type RolloutStepInput,
  type RolloutStepStatus,
  type RolloutSummary,
  type RolloutTemplate,
  releaseNotesLength,
  releaseNotesLimit,
  supports,
  validateRolloutSteps,
} from '@kiln/core';
import { ApiError } from './api.ts';
import { rolloutIssueMessage } from './core-text.ts';
import { formatDate, formatDateTime, formatPercent as formatShare } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { compareTracks } from './play-tracks.ts';
import { compareVersions, platformLabel } from './portfolio.ts';
import type { AppSummary, ReleaseSummary, RolloutStep } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Routing: `#/portfolio/<appId>/release/<version>`. The release page is a screen of the portfolio
// view, next to the app page, because it can show two apps (iOS and Android) of one product.

export type ReleaseRoute = { appId: string; version: string };

export const releaseHref = (appId: string, version: string) =>
  `#/portfolio/${encodeURIComponent(appId)}/release/${encodeURIComponent(version)}`;

/** Reads a location hash such as `#/portfolio/6f1c/release/2.1.0`. Anything else is `null`. */
export function parseReleaseRoute(hash: string): ReleaseRoute | null {
  const match = /^#?\/?portfolio\/([^/?#]+)\/release\/([^/?#]+)\/?(?:[?#].*)?$/.exec(hash);
  if (!match) return null;
  try {
    const appId = decodeURIComponent(match[1] ?? '');
    const version = decodeURIComponent(match[2] ?? '');
    return appId && version ? { appId, version } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The two platforms of one product

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The app of the other platform that is the same product: the same identifier, else the same name.
 * `null` when there is none (or several names match, which is not a safe guess).
 */
export function findSibling(
  apps: readonly AppSummary[],
  app: Pick<AppSummary, 'id' | 'platform' | 'identifier' | 'name'>,
): AppSummary | null {
  const others = apps.filter((a) => a.platform !== app.platform && a.id !== app.id);
  const byIdentifier = others.filter((a) => sameText(a.identifier, app.identifier));
  if (byIdentifier.length === 1) return byIdentifier[0] as AppSummary;
  if (byIdentifier.length > 1) return null;
  const byName = others.filter((a) => sameText(a.name, app.name));
  return byName.length === 1 ? (byName[0] as AppSummary) : null;
}

/**
 * The records of the other platforms that are the same product, at most one per platform: on each
 * platform the same identifier, else the same name, and only when that match is unique. An iOS and a
 * macOS record can share a bundle id (universal purchase), so the match is made platform by platform.
 */
export function findSiblings(
  apps: readonly AppSummary[],
  app: Pick<AppSummary, 'id' | 'platform' | 'identifier' | 'name'>,
): AppSummary[] {
  const found: AppSummary[] = [];
  for (const platform of [...new Set(apps.map((a) => a.platform))]) {
    if (platform === app.platform) continue;
    const others = apps.filter((a) => a.platform === platform && a.id !== app.id);
    const byIdentifier = others.filter((a) => sameText(a.identifier, app.identifier));
    if (byIdentifier.length === 1) found.push(byIdentifier[0] as AppSummary);
    else if (byIdentifier.length === 0) {
      const byName = others.filter((a) => sameText(a.name, app.name));
      if (byName.length === 1) found.push(byName[0] as AppSummary);
    }
  }
  return found;
}

/** The releases of one version, most public track first. */
export function releasesOfVersion(
  releases: readonly ReleaseSummary[],
  version: string,
): ReleaseSummary[] {
  return releases
    .filter((r) => r.version === version)
    .sort(
      (a, b) => compareTracks(a.track, b.track) || compareVersions(b.build ?? '', a.build ?? ''),
    );
}

/** Versions of an app that the store reports, newest first, with no repeats. */
export function knownVersions(
  releases: readonly ReleaseSummary[],
  planVersions: readonly string[] = [],
): string[] {
  return [...new Set([...releases.map((r) => r.version), ...planVersions])].sort((a, b) =>
    compareVersions(b, a),
  );
}

// ---------------------------------------------------------------------------------------------
// What the store reports about a rollout. Read only: there is no control for it anywhere.

export type RolloutView = {
  /** "Staged rollout" (Google Play) or "Phased release" (Apple). */
  title: string;
  /** 0 to 1 when the store reported a share; otherwise null. */
  fraction: number | null;
  /** One sentence for a person. */
  text: string;
};

/**
 * What to say about a release's rollout. Apple's phased release is not read yet (see
 * docs/phase-2.md), so an iOS release that is rolling out has no share to show and says so.
 */
export function rolloutView(
  release: Pick<ReleaseSummary, 'platform' | 'status' | 'rolloutFraction'>,
): RolloutView {
  const ios = !supports(release.platform, 'releaseTracks');
  const title = ios ? t('release:rolloutView.titlePhased') : t('release:rolloutView.titleStaged');
  const fraction =
    release.rolloutFraction === null || !Number.isFinite(release.rolloutFraction)
      ? null
      : Math.min(1, Math.max(0, release.rolloutFraction));
  if (fraction !== null) {
    return {
      title,
      fraction,
      text: t('release:rolloutView.share', {
        percent: formatShare(fraction, { maximumFractionDigits: 1 }),
      }),
    };
  }
  if (release.status === 'rolling_out' || release.status === 'halted') {
    return {
      title,
      fraction: null,
      text: ios
        ? t('release:rolloutView.phasedShareUnknown')
        : t('release:rolloutView.stagedShareUnknown'),
    };
  }
  if (release.status === 'live') {
    return {
      title,
      fraction: null,
      text: ios ? t('release:rolloutView.livePhased') : t('release:rolloutView.liveStaged'),
    };
  }
  return { title, fraction: null, text: t('release:rolloutView.notYet') };
}

// ---------------------------------------------------------------------------------------------
// Dates

/** "Tue, 1 Dec 2026" for a `YYYY-MM-DD` date, read as that calendar day in UTC. */
export function formatTargetDate(date: string): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) return date;
  return formatDate(time, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export type DueText = { text: string; tone: 'neutral' | 'warn' | 'bad' | 'ok' };

/** "Due in 3 days", "Due today", "Overdue by 2 days". Neutral when there is nothing to warn about. */
export function dueText(
  due: Pick<DueFlags, 'dueSoon' | 'overdue' | 'daysLeft'>,
  released = false,
): DueText | null {
  if (due.daysLeft === null) return null;
  // Flags are cleared for a release that is out, which leaves a date in the past and no overdue flag.
  if (released || (due.daysLeft < 0 && !due.overdue))
    return { text: t('release:due.released'), tone: 'ok' };
  if (due.overdue) return { text: t('release:due.overdue', { count: -due.daysLeft }), tone: 'bad' };
  if (due.daysLeft === 0) return { text: t('release:due.today'), tone: 'warn' };
  return {
    text: t('release:due.in', { count: due.daysLeft }),
    tone: due.dueSoon ? 'warn' : 'neutral',
  };
}

// ---------------------------------------------------------------------------------------------
// Release notes

export type NoteCounter = {
  count: number;
  limit: number;
  over: boolean;
  remaining: number;
  /** "123 of 500 characters", or "12 characters over the limit of 500". */
  label: string;
};

/** The live character count of a locale's release notes against the limit of the plan. */
export function noteCounter(text: string, platform: PlanPlatform): NoteCounter {
  const limit = releaseNotesLimit(platform);
  const count = releaseNotesLength(text);
  const over = count > limit;
  return {
    count,
    limit,
    over,
    remaining: limit - count,
    label: over
      ? t('release:notes.counter.over', { count: count - limit, limit })
      : t('release:notes.counter.within', { count: limit, used: count }),
  };
}

/** Who sets the limit, in words: "Google Play allows 500 characters." */
export function limitNote(platform: PlanPlatform): string {
  const limit = releaseNotesLimit(platform);
  if (platform !== null) {
    const store = platformMeta(platform).storeName;
    const key = byFamily(platform, {
      apple: k('release:notes.limit.apple'),
      google: k('release:notes.limit.google'),
    });
    return t(key, { store, count: limit });
  }
  return t('release:notes.limit.both', { google: limit, apple: releaseNotesLimit('ios') });
}

/** Locales worth offering before a person types one. */
export const SUGGESTED_LOCALES: readonly string[] = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'es-MX',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'zh-Hans',
  'ru-RU',
  'default',
];

/** A locale as typed: trimmed, `_` is fine. Returns the code or a problem sentence. */
export function checkLocale(
  input: string,
  existing: readonly string[],
): { ok: true; locale: string } | { ok: false; message: string } {
  const locale = input.trim();
  if (locale === '') return { ok: false, message: t('release:locale.enter') };
  if (!isPlanLocale(locale)) return { ok: false, message: t('release:locale.invalid') };
  if (existing.some((e) => e.toLowerCase() === locale.toLowerCase()))
    return { ok: false, message: t('release:locale.exists', { locale }) };
  return { ok: true, locale };
}

// ---------------------------------------------------------------------------------------------
// Checklist

/** The ids with the one at `index` moved by `delta` places. Out of range returns the same order. */
export function moveId(order: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved as string);
  return next;
}

/** "Done by Ada" with the time, or an empty string when the item is open. */
export function doneBy(item: { done: boolean; doneBy: { name: string | null } | null }): string {
  if (!item.done) return '';
  return item.doneBy?.name
    ? t('release:checklist.doneBy', { name: item.doneBy.name })
    : t('release:checklist.done');
}

// ---------------------------------------------------------------------------------------------
// Staged rollout steps (planning data only: nothing here starts or changes a rollout in a store)

export type Chip = { label: string; tone: 'ok' | 'warn' | 'neutral' | 'info' | 'bad' };

/** The status chip of a step. It says the state in words; color is only a hint. */
export function stepChip(step: Pick<RolloutStep, 'status' | 'due'>): Chip {
  if (step.status === 'done') return { label: t('release:stepChip.done'), tone: 'ok' };
  if (step.status === 'skipped') return { label: t('release:stepChip.skipped'), tone: 'neutral' };
  return step.due
    ? { label: t('release:stepChip.overdue'), tone: 'warn' }
    : { label: t('release:stepChip.planned'), tone: 'info' };
}

/** "Tue, 12 Jan 2027, 09:00" in the viewer's time zone; "No time set" without one. */
export function formatPlannedAt(at: number | null): string {
  if (at === null) return t('release:plannedAt.none');
  return formatDateTime(at, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Step 2 of 5 done (20%). Next: 50%." or "Not started: 5 steps planned." */
export function rolloutHeadline(
  summary: Pick<
    RolloutSummary,
    'kind' | 'total' | 'planned' | 'current' | 'next' | 'dueSteps'
  > | null,
): string {
  if (summary === null) return t('release:headline.none');
  if (summary.kind === 'apple_phased') return t('release:headline.applePhased');
  if (summary.planned === 0)
    return summary.current
      ? t('release:headline.allDone', { count: summary.total })
      : t('release:headline.noneOpen', { count: summary.total });
  const head = summary.current
    ? t('release:headline.stepOf', {
        index: summary.current.index,
        total: summary.total,
        percent: stepShare(summary.current.percent),
      })
    : t('release:headline.notStarted', { count: summary.total });
  const next = summary.next
    ? t('release:headline.nextPercent', { percent: stepShare(summary.next.percent) })
    : t('release:headline.nextNone');
  // Each part is a whole sentence of its own, so they can be joined with a space.
  const parts = [head, next];
  if (summary.dueSteps > 0) parts.push(t('release:headline.pastDue', { count: summary.dueSteps }));
  return parts.join(' ');
}

/** A rollout step's percent (0 to 100) as text in the active language. */
const stepShare = (percent: number): string =>
  formatShare(percent / 100, { maximumFractionDigits: 1 });

/** A short badge for boards and headers: "Rollout 2 of 5" or "Rollout step due". Null when there is nothing to say. */
export function rolloutBadge(summary: RolloutSummary | null): Chip | null {
  if (summary === null || summary.kind === 'apple_phased')
    return summary ? { label: t('release:badge.phasedPlanned'), tone: 'info' } : null;
  if (summary.dueSteps > 0) return { label: t('release:badge.stepDue'), tone: 'warn' };
  if (summary.planned === 0) return { label: t('release:badge.planComplete'), tone: 'ok' };
  return {
    label: t('release:badge.progress', { done: summary.done, total: summary.total }),
    tone: 'neutral',
  };
}

/** How loud the comparison of the plan with the store should be. */
export function comparisonTone(
  comparison: Pick<RolloutComparison, 'verdict' | 'mismatch' | 'halted'>,
): 'ok' | 'warn' | 'neutral' {
  if (comparison.mismatch || comparison.halted) return 'warn';
  return comparison.verdict === 'match' ? 'ok' : 'neutral';
}

const COMPARISON_LABELS = {
  match: k('release:comparison.match'),
  store_ahead: k('release:comparison.storeAhead'),
  store_behind: k('release:comparison.storeBehind'),
  unknown: k('release:comparison.unknown'),
} as const;

export const comparisonLabel = (comparison: Pick<RolloutComparison, 'verdict'>): string =>
  t(COMPARISON_LABELS[comparison.verdict]);

// A step as it is edited: text fields, so a half typed value is not lost.

export type DraftStep = {
  /** A stable key for the list, whatever the percent says now. */
  key: string;
  /** The stored step this row is, or null for a new one. */
  id: string | null;
  percent: string;
  /** The value of a `datetime-local` input, in the viewer's time zone. */
  plannedAt: string;
  note: string;
  status: RolloutStepStatus;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An epoch time as the value of a `datetime-local` input (local time, minutes). */
export function localInputValue(at: number | null): string {
  if (at === null) return '';
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The value of a `datetime-local` input as an epoch time: `null` for empty, `NaN` for nonsense. */
export function parseLocalInput(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  const real =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h;
  return real ? date.getTime() : Number.NaN;
}

let draftCounter = 0;
const draftKey = () => `d${++draftCounter}`;

export const draftFromSteps = (steps: readonly RolloutStep[]): DraftStep[] =>
  steps.map((s) => ({
    key: draftKey(),
    id: s.id,
    percent: String(s.percent),
    plannedAt: localInputValue(s.plannedAt),
    note: s.note ?? '',
    status: s.status,
  }));

export const draftFromTemplate = (template: Pick<RolloutTemplate, 'steps'>): DraftStep[] =>
  template.steps.map((s) => ({
    key: draftKey(),
    id: null,
    percent: String(s.percent),
    plannedAt: '',
    note: s.note ?? '',
    status: 'planned',
  }));

/** A percent to offer for a new step: 10 for the first, then about halfway to 100 above the last one, at most 100. */
export function suggestNextPercent(percents: readonly number[]): number {
  if (percents.length === 0) return 10;
  const last = Math.max(...percents);
  if (last >= 100) return 100;
  return Math.min(100, Math.max(last + 1, Math.round(last + (100 - last) / 2)));
}

export function addDraftStep(draft: readonly DraftStep[]): DraftStep[] {
  if (draft.length >= MAX_ROLLOUT_STEPS) return [...draft];
  const percents = draft.map((d) => Number(d.percent)).filter((n) => Number.isInteger(n));
  return [
    ...draft,
    {
      key: draftKey(),
      id: null,
      percent: String(suggestNextPercent(percents)),
      plannedAt: '',
      note: '',
      status: 'planned',
    },
  ];
}

export type DraftResult =
  | {
      ok: true;
      steps: { id?: string; percent: number; plannedAt: number | null; note: string | null }[];
    }
  | {
      ok: false /** A message per row key. */;
      rows: Record<string, string> /** Problems about the list as a whole. */;
      general: string[];
    };

/**
 * The steps to send for an edited list, or the problems to show. The list is put in order of
 * percentage (they must increase, so the order is not a choice). The rules are the server's own
 * (`validateRolloutSteps`), so a saved list is rarely refused.
 */
export function draftToBody(
  draft: readonly DraftStep[],
  options: { planCreatedAt: number; existing: readonly RolloutStep[] },
): DraftResult {
  const rows: Record<string, string> = {};
  const parsed: { row: DraftStep; input: RolloutStepInput }[] = [];
  for (const row of draft) {
    const percentText = row.percent.trim();
    const percent = /^\d{1,3}$/.test(percentText) ? Number(percentText) : Number.NaN;
    const plannedAt = parseLocalInput(row.plannedAt);
    if (Number.isNaN(percent)) rows[row.key] = t('release:draft.wholeNumber');
    else if (plannedAt !== null && Number.isNaN(plannedAt))
      rows[row.key] = t('release:draft.dateTime');
    else {
      const note = row.note.trim();
      parsed.push({
        row,
        input: {
          ...(row.id ? { id: row.id } : {}),
          percent,
          plannedAt,
          note: note === '' ? null : note,
        },
      });
    }
  }
  if (Object.keys(rows).length > 0) return { ok: false, rows, general: [] };
  parsed.sort((a, b) => (a.input.percent as number) - (b.input.percent as number));
  const checked = validateRolloutSteps(
    parsed.map((p) => p.input),
    { planCreatedAt: options.planCreatedAt, existing: options.existing },
  );
  if (!checked.ok) {
    const general: string[] = [];
    for (const issue of checked.issues) {
      const match = /^steps\.(\d+)\./.exec(issue.path);
      const row = match ? parsed[Number(match[1])]?.row : undefined;
      if (row && !(row.key in rows)) rows[row.key] = rolloutIssueMessage(issue);
      else if (!row) general.push(rolloutIssueMessage(issue));
    }
    return { ok: false, rows, general };
  }
  return {
    ok: true,
    steps: parsed.map((p) => ({
      ...(p.input.id ? { id: p.input.id } : {}),
      percent: p.input.percent,
      plannedAt: p.input.plannedAt ?? null,
      note: p.input.note ?? null,
    })),
  };
}

/** Width of the percent bar of a step, 0 to 100. */
export const barWidth = (percent: number): number => Math.min(100, Math.max(0, percent));

// ---------------------------------------------------------------------------------------------
// Platform of a plan

export function planPlatformLabel(platform: PlanPlatform): string {
  return platform === null ? t('release:platform.both') : platformLabel(platform);
}

/** The plan platforms a new plan for this app can have: its own, or both. */
export function planPlatformChoices(app: {
  platform: Platform;
}): { value: PlanPlatform; label: string }[] {
  return [
    { value: null, label: t('release:platform.bothShared') },
    {
      value: app.platform,
      label: t('release:platform.only', { platform: platformLabel(app.platform) }),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for each thing the plans API can say. */
export function planErrorMessage(
  error: unknown,
  fallback = t('common:error.genericRetry'),
): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  switch (error.code) {
    case 'already_exists':
      return message || t('release:error.exists');
    case 'platform_mismatch':
    case 'notes_too_long':
    case 'reason_required':
    case 'order_mismatch':
    case 'too_many_items':
    case 'too_many_locales':
    case 'too_many_templates':
    case 'builtin_template':
      return message || fallback;
    case 'invalid_rollout':
    case 'rollout_platform_mismatch':
    case 'rollout_has_done_steps':
    case 'earlier_steps_open':
    case 'later_steps_done':
    case 'invalid_transition':
    case 'no_rollout_steps':
    case 'store_share_unknown':
    case 'store_not_at_step':
    case 'step_changed':
      return message || fallback;
    case 'template_not_found':
      return /rollout/i.test(message) ? message : t('release:error.templateGone');
    case 'not_found':
      return t('release:error.notFound');
    case 'payload_too_large':
      return t('release:error.tooLarge');
    default:
      return error.message || fallback;
  }
}
