import type { Platform, ReleaseState } from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';
import { formatRollout, platformLabel, statusInfo } from './portfolio.ts';
import { dueText, formatTargetDate, planPlatformLabel } from './release.ts';
import type { StepId } from './release-stepper.ts';
import type { RolloutState } from './store-rollout.ts';
import type { PlanSummary } from './types.ts';

/**
 * Pure parts of the release detail screen (docs/design/readability.md): the one status lead for a version ("Version 2.9.0 is in store
 * review for 2 days") with its one primary action, the checklist as open items first with the done ones counted, the plan as one quiet
 * line, and the current store rollout as one line. Nothing is fetched here.
 */

export type LeadTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

/** One store release of the version, as the lead reads it. */
export type LeadRelease = {
  appId: string;
  platform: Platform;
  status: ReleaseState | null;
  track: string | null;
  rolloutFraction: number | null;
  /** Since when the release has been in this state (epoch ms), when known. */
  since: number | null;
};

/** The one primary action: the same labels as the train button of the Releases tab (`lib/release-trains.ts`). */
export type LeadAction = { label: string; appId: string; step: StepId };

export type ReleaseLead = {
  headline: string;
  hint: string;
  tone: LeadTone;
  /** One word per platform, in the order the platforms first appear. */
  words: { platform: Platform; word: string; tone: string }[];
  action: LeadAction | null;
};

/** "less than an hour", "5 hours", "1 day", "3 days"; empty when the time is unknown or in the future. */
export function elapsedText(since: number | null, now: number): string {
  if (since === null || !Number.isFinite(since) || since > now) return '';
  const hours = Math.floor((now - since) / 3_600_000);
  if (hours < 1) return t('release:elapsed.lessThanHour');
  if (hours < 24) return t('release:elapsed.hours', { count: hours });
  return t('release:elapsed.days', { count: Math.floor(hours / 24) });
}

type Kind =
  | 'rejected'
  | 'approved'
  | 'preparing'
  | 'halted'
  | 'in_review'
  | 'rolling_out'
  | 'propagating'
  | 'live'
  | 'unknown';

/** The release that matters most leads: a rejection, then what waits for the person, then the store, then what is out. */
const KIND_RANK: readonly Kind[] = [
  'rejected',
  'approved',
  'preparing',
  'halted',
  'in_review',
  'rolling_out',
  'propagating',
  'live',
  'unknown',
];

function kindOf(status: ReleaseState | null): Kind {
  switch (status) {
    case 'rejected':
    case 'approved':
    case 'halted':
    case 'in_review':
    case 'rolling_out':
    case 'propagating':
    case 'live':
      return status;
    case 'draft':
    case 'build_chosen':
    case 'ready':
      return 'preparing';
    default:
      return 'unknown';
  }
}

const rankOf = (r: LeadRelease): number => KIND_RANK.indexOf(kindOf(r.status));

/**
 * The lead of the release detail: where this version is, said for the release that matters most, the status of each platform as one
 * word, and the ONE primary action. `appId` is the app the page was opened for: a version that is not in a store yet is opened there.
 */
export function releaseLead(input: {
  version: string;
  appId: string;
  releases: readonly LeadRelease[];
  /** A plan exists for this version. */
  planned: boolean;
  /** The plan is marked blocked. */
  blocked: boolean;
  now: number;
}): ReleaseLead {
  const v = input.version;
  const platforms: Platform[] = [];
  for (const r of input.releases) if (platforms.indexOf(r.platform) < 0) platforms.push(r.platform);
  const sorted = input.releases
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rankOf(a.r) - rankOf(b.r) || a.i - b.i)
    .map((x) => x.r);

  const words = platforms.map((p) => {
    const best = sorted.filter((r) => r.platform === p)[0] as LeadRelease;
    const info = statusInfo(best.status);
    return { platform: p, word: info.label, tone: info.tone as string };
  });

  const lead = sorted[0];
  let out: Omit<ReleaseLead, 'words'>;
  if (!lead) {
    out = input.planned
      ? {
          headline: t('release:lead.plannedHeadline', { version: v }),
          hint: t('release:lead.plannedHint'),
          tone: 'neutral',
          action: { label: t('release:lead.openSteps'), appId: input.appId, step: 'build' },
        }
      : {
          headline: t('release:lead.notInStoreHeadline', { version: v }),
          hint: t('release:lead.notInStoreHint'),
          tone: 'neutral',
          action: null,
        };
  } else {
    // With two platforms the headline names the one it is about: a message of its own, never a spliced fragment.
    const on = platforms.length > 1;
    const params = { version: v, platform: platformLabel(lead.platform) };
    const share = formatRollout(lead.rolloutFraction);
    const go = (label: string, step: StepId): LeadAction => ({ label, appId: lead.appId, step });
    switch (kindOf(lead.status)) {
      case 'rejected':
        out = {
          headline: on ? t('release:lead.rejectedOn', params) : t('release:lead.rejected', params),
          hint: t('release:lead.rejectedHint'),
          tone: 'bad',
          action: go(t('release:lead.rejectedAction'), 'review'),
        };
        break;
      case 'approved':
        out = {
          headline: on ? t('release:lead.approvedOn', params) : t('release:lead.approved', params),
          hint: t('release:lead.approvedHint'),
          tone: 'warn',
          action: go(t('release:lead.approvedAction'), 'confirm'),
        };
        break;
      case 'preparing':
        out = {
          headline: on
            ? t('release:lead.preparingOn', params)
            : t('release:lead.preparing', params),
          hint: t('release:lead.preparingHint'),
          tone: 'info',
          action: go(t('release:lead.preparingAction'), 'confirm'),
        };
        break;
      case 'halted':
        out = {
          headline: share
            ? on
              ? t('release:lead.haltedOnAt', { ...params, share })
              : t('release:lead.haltedAt', { ...params, share })
            : on
              ? t('release:lead.haltedOn', params)
              : t('release:lead.halted', params),
          hint: t('release:lead.haltedHint'),
          tone: 'warn',
          action: go(t('release:lead.openSteps'), 'confirm'),
        };
        break;
      case 'in_review': {
        const elapsed = elapsedText(lead.since, input.now);
        out = {
          headline: elapsed
            ? on
              ? t('release:lead.inReviewOnFor', { ...params, elapsed })
              : t('release:lead.inReviewFor', { ...params, elapsed })
            : on
              ? t('release:lead.inReviewOn', params)
              : t('release:lead.inReview', params),
          hint: t('release:lead.inReviewHint'),
          tone: 'info',
          // This page is where the review is followed: there is nothing to open (Prepare release has no step for it).
          action: null,
        };
        break;
      }
      case 'rolling_out':
        out = {
          headline: share
            ? on
              ? t('release:lead.rollingOutOnShare', { ...params, share })
              : t('release:lead.rollingOutShare', { ...params, share })
            : on
              ? t('release:lead.rollingOutOn', params)
              : t('release:lead.rollingOut', params),
          hint: t('release:lead.rollingOutHint'),
          tone: 'info',
          action: go(t('release:lead.openSteps'), 'confirm'),
        };
        break;
      case 'propagating':
        out = {
          headline: on
            ? t('release:lead.propagatingOn', params)
            : t('release:lead.propagating', params),
          hint: t('release:lead.propagatingHint'),
          tone: 'info',
          action: null,
        };
        break;
      case 'live':
        out = {
          headline: on ? t('release:lead.liveOn', params) : t('release:lead.live', params),
          hint: t('release:lead.liveHint'),
          tone: 'ok',
          action: null,
        };
        break;
      default:
        out = {
          headline: on ? t('release:lead.unknownOn', params) : t('release:lead.unknown', params),
          hint: t('release:lead.unknownHint'),
          tone: 'neutral',
          action: null,
        };
    }
  }
  // A blocked plan warns on the lead; its reason itself stays visible below (a blocking problem is never folded).
  if (input.blocked && out.tone !== 'bad')
    out = {
      ...out,
      tone: 'warn',
      hint: t('release:lead.blockedHint'),
    };
  return { ...out, words };
}

// ---------------------------------------------------------------------------------------------
// Checklist

/**
 * The checklist as people use it: open items first (the required ones before the optional ones, each group in its stored order), the
 * done ones counted and kept apart ("4 of 6 done").
 */
export function checklistView<T extends { required: boolean; done: boolean }>(
  items: readonly T[],
): { open: T[]; done: T[]; headline: string; hint: string } {
  const openRequired = items.filter((i) => !i.done && i.required);
  const open = [...openRequired, ...items.filter((i) => !i.done && !i.required)];
  const done = items.filter((i) => i.done);
  const headline =
    items.length === 0
      ? t('release:checklist.none')
      : t('release:checklist.progress', { done: done.length, total: items.length });
  let hint = '';
  if (items.length > 0) {
    if (openRequired.length > 0)
      hint = t('release:checklist.requiredOpen', { count: openRequired.length });
    else
      hint = open.length > 0 ? t('release:checklist.requiredDone') : t('release:checklist.allDone');
  }
  return { open, done, headline, hint };
}

// ---------------------------------------------------------------------------------------------
// The plan

/** The plan as one quiet line: which platforms, the target date with its due word, and the release notes written. */
export function planLine(
  plan: Pick<PlanSummary, 'platform' | 'targetDate' | 'due' | 'released' | 'readiness'>,
): string {
  const parts: string[] = [planPlatformLabel(plan.platform)];
  if (plan.targetDate) {
    const due = dueText(plan.due, plan.released);
    const date = formatTargetDate(plan.targetDate);
    parts.push(
      due
        ? t('release:planLine.targetDue', { date, due: due.text })
        : t('release:planLine.target', { date }),
    );
  } else parts.push(t('release:planLine.noTarget'));
  const { notes } = plan.readiness;
  if (notes.locales > 0)
    parts.push(t('release:planLine.notes', { filled: notes.filled, count: notes.locales }));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The store rollout controls

/** The current store rollout as one line: "Rolling out: 20% of users", "Rolling out: day 3 of 7", "Halted at 20% of users". */
export function rolloutNowLine(state: RolloutState): string {
  if (state.store === 'googleplay') {
    const share = formatRollout(state.userFraction);
    switch (state.status) {
      case 'inProgress':
        return share
          ? t('release:rolloutNow.rollingShare', { share })
          : t('release:rolloutNow.rolling');
      case 'halted':
        return share
          ? t('release:rolloutNow.haltedShare', { share })
          : t('release:rolloutNow.halted');
      case 'completed':
        return t('release:rolloutNow.completed');
      case 'draft':
        return t('release:rolloutNow.draft');
      default:
        return t('release:rolloutNow.storeState', { status: state.status });
    }
  }
  const day = state.currentDayNumber;
  switch (state.phasedReleaseState) {
    case null:
      return t('release:rolloutNow.noPhased');
    case 'ACTIVE':
      return day !== null
        ? t('release:rolloutNow.activeDay', { day })
        : t('release:rolloutNow.rolling');
    case 'PAUSED':
      return day !== null
        ? t('release:rolloutNow.pausedDay', { day })
        : t('release:rolloutNow.paused');
    case 'COMPLETE':
      return t('release:rolloutNow.complete');
    default:
      return t('release:rolloutNow.phasedOther', { state: state.phasedReleaseState.toLowerCase() });
  }
}

/**
 * The one short line next to the buttons: which of the enabled changes cannot be undone. Null when none can be; the preview and the
 * confirmation say the rest.
 */
export function irreversibleLine(
  buttons: readonly { label: string; disabled: boolean; irreversible: boolean }[],
): string | null {
  const names = buttons.filter((b) => b.irreversible && !b.disabled).map((b) => b.label);
  if (names.length === 0) return null;
  return t('release:irreversible', { count: names.length, list: formatList(names) });
}
