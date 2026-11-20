import type { Platform, ReleaseState } from '@mrm/core';
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
  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
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
          headline: `Version ${v} is planned, not in the store yet`,
          hint: 'Add the version in the store console and choose a build.',
          tone: 'neutral',
          action: { label: 'Open the release steps', appId: input.appId, step: 'build' },
        }
      : {
          headline: `Version ${v} is not in the store yet`,
          hint: 'Sync the app to read its state, or start a plan below.',
          tone: 'neutral',
          action: null,
        };
  } else {
    const on = platforms.length > 1 ? ` on ${platformLabel(lead.platform)}` : '';
    const share = formatRollout(lead.rolloutFraction);
    const go = (label: string, step: StepId): LeadAction => ({ label, appId: lead.appId, step });
    switch (kindOf(lead.status)) {
      case 'rejected':
        out = {
          headline: `Version ${v}${on} was rejected by the store`,
          hint: 'Fix what the store names, then send it again.',
          tone: 'bad',
          action: go('See what to fix', 'review'),
        };
        break;
      case 'approved':
        out = {
          headline: `Version ${v}${on} is approved: waiting for you to release it`,
          hint: 'Nothing goes out to people until you release it.',
          tone: 'warn',
          action: go('Release it', 'confirm'),
        };
        break;
      case 'preparing':
        out = {
          headline: `Version ${v}${on} is being prepared, not sent to review yet`,
          hint: 'Finish the steps, then send it to the store.',
          tone: 'info',
          action: go('Finish the release', 'confirm'),
        };
        break;
      case 'halted':
        out = {
          headline: `The rollout of ${v}${on} is halted${share ? ` at ${share} of users` : ''}`,
          hint: 'The store is not sending it to more people. Resume or finish it when you are ready.',
          tone: 'warn',
          action: go('Open the release steps', 'confirm'),
        };
        break;
      case 'in_review': {
        const elapsed = elapsedText(lead.since, input.now);
        out = {
          headline: `Version ${v}${on} is in store review${elapsed ? ` for ${elapsed}` : ''}`,
          hint: 'Waiting on the store. Nobody here can speed it up.',
          tone: 'info',
          action: go('Follow the review', 'confirm'),
        };
        break;
      }
      case 'rolling_out':
        out = {
          headline: `Version ${v}${on} is rolling out${share ? `: ${share} of users` : ''}`,
          hint: 'It is going out in stages. Nothing is waiting for you.',
          tone: 'info',
          action: go('Open the release steps', 'confirm'),
        };
        break;
      case 'propagating':
        out = {
          headline: `Version ${v}${on} was released and is reaching the store`,
          hint: 'The store is still making it visible. Nothing is waiting for you.',
          tone: 'info',
          action: null,
        };
        break;
      case 'live':
        out = {
          headline: `Version ${v}${on} is live`,
          hint: 'Available to users. Nothing is waiting for you.',
          tone: 'ok',
          action: null,
        };
        break;
      default:
        out = {
          headline: `Version ${v}${on} is in a store state this tool does not know`,
          hint: 'Sync the app to read it again.',
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
      hint: 'The plan is blocked: read the reason below before you go on.',
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
  const headline = items.length === 0 ? 'No items yet' : `${done.length} of ${items.length} done`;
  let hint = '';
  if (items.length > 0) {
    if (openRequired.length > 0)
      hint = `${openRequired.length} required ${openRequired.length === 1 ? 'item is' : 'items are'} still open.`;
    else hint = open.length > 0 ? 'Every required item is done.' : 'Everything is done.';
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
    parts.push(`Target ${formatTargetDate(plan.targetDate)}${due ? ` (${due.text})` : ''}`);
  } else parts.push('No target date');
  const { notes } = plan.readiness;
  if (notes.locales > 0)
    parts.push(
      `Release notes in ${notes.filled} of ${notes.locales} ${notes.locales === 1 ? 'locale' : 'locales'}`,
    );
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
        return share ? `Rolling out: ${share} of users` : 'Rolling out';
      case 'halted':
        return share ? `Halted at ${share} of users` : 'Halted';
      case 'completed':
        return 'Released to 100% of users';
      case 'draft':
        return 'Not started yet';
      default:
        return `Store state: ${state.status}`;
    }
  }
  const day = state.currentDayNumber;
  switch (state.phasedReleaseState) {
    case null:
      return 'No phased release';
    case 'ACTIVE':
      return day !== null ? `Rolling out: day ${day} of 7` : 'Rolling out';
    case 'PAUSED':
      return day !== null ? `Paused on day ${day} of 7` : 'Paused';
    case 'COMPLETE':
      return 'Released to all users';
    default:
      return `Phased release ${state.phasedReleaseState.toLowerCase()}`;
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
  const list =
    names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} cannot be undone.`;
}
