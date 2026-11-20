import type { AttentionItem } from './app-attention.ts';
import type { PlatformScope } from './app-scope.ts';
import { releaseStepHref } from './release-stepper.ts';
import type { Platform } from '@mrm/core';
import type { Train } from './release-trains.ts';

/**
 * "Next step": the one card at the top of the Overview and of Releases. From the releases on their way (the release trains) and the
 * attention items it picks ONE thing to do and one primary button for it. Pure; nothing is fetched here.
 *
 * Order: a train whose step failed (a rejection, a failed CI run), then a train that waits for the person, then the one that waits
 * for the store, then one that waits for CI; with no release on its way, the most serious attention item that has a link and is a
 * release left unfinished or a bad one; otherwise "Start release" (CI) or, without a linked repository, "Prepare release".
 */

export type NextAction =
  | { label: string; href: string }
  | { label: string; action: 'start-release' | 'prepare-release' };

/** One release with a next step of its own: a row of the card when several platforms have one. */
export type NextRow = {
  key: string;
  platforms: Platform[];
  tone: 'bad' | 'warn' | 'info';
  title: string;
  /** What is going on and what waits for whom. */
  text: string;
  waiting: { who: 'you' | 'store' | 'ci'; text: string } | null;
  href: string;
  label: string;
  /** Waits for the person (or failed): its button is the primary one; the rest are quiet. */
  urgent: boolean;
};

export type NextStepKind = 'train' | 'attention' | 'start' | 'prepare' | 'idle';

export type NextStep = {
  kind: NextStepKind;
  tone: 'bad' | 'warn' | 'info' | 'neutral';
  title: string;
  /** One or two plain sentences. */
  text: string;
  /** Who the step waits for: the person, the store, CI; null when nobody. */
  waiting: { who: 'you' | 'store' | 'ci'; text: string } | null;
  primary: NextAction | null;
  /** The release the card is about; its five steps are drawn in the card. */
  train: Train | null;
  /**
   * Every release on its way, one row each, when there are several (one per platform): each has its own next step and its own
   * button, none is chosen over the others. Empty when there is one (the card itself is that step).
   */
  rows: NextRow[];
  /** Other releases on their way: one quiet line each. */
  otherTrains: { title: string; text: string; href: string; label: string }[];
  /** The rest of "Needs attention": what the card does not already say. */
  items: AttentionItem[];
  /** A quiet "Start release" is offered beside the step (nothing waits for the person). */
  offerStart: boolean;
};

export type NextStepInput = {
  trains: readonly Train[];
  attention: readonly AttentionItem[];
  scope: PlatformScope | null;
  /** The role may dispatch and an app in scope has a linked repository. */
  canStart: boolean;
  /** The role may open the release steps. */
  canPrepare: boolean;
};

const isUnfinished = (item: AttentionItem): boolean => item.id.endsWith(':unfinished');

function rank(t: Train): number {
  if (t.steps.some((s) => s.status === 'failed')) return 0;
  if (t.waiting?.who === 'you') return 1;
  if (t.waiting?.who === 'store') return 2;
  if (t.waiting?.who === 'ci') return 3;
  return 4;
}

/** Trains in the order they matter: the most urgent first; equal ones keep their order. */
export function orderTrains(trains: readonly Train[]): Train[] {
  return trains
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
}

const trainHref = (t: Train, scope: PlatformScope | null): string =>
  releaseStepHref(t.button.appId, scope, t.button.step, t.version);

function rowOf(t: Train, scope: PlatformScope | null): NextRow {
  const r = rank(t);
  return {
    key: t.key,
    platforms: t.platforms,
    tone: r === 0 ? 'bad' : r === 1 ? 'warn' : 'info',
    title: t.title,
    text: t.lines.join(' '),
    waiting: t.waiting ? { who: t.waiting.who, text: t.waiting.text } : null,
    href: trainHref(t, scope),
    label: t.button.label,
    urgent: r <= 1,
  };
}

export function chooseNextStep(input: NextStepInput): NextStep {
  const trains = orderTrains(input.trains);
  // The release left unfinished is the release trains' business: one line, not two. It only stays when no train could be read.
  const unfinished = input.attention.filter(isUnfinished);
  const items =
    trains.length > 0 ? input.attention.filter((i) => !isUnfinished(i)) : [...input.attention];
  const base = {
    items: [] as AttentionItem[],
    otherTrains: [] as NextStep['otherTrains'],
    rows: [] as NextRow[],
    train: null as Train | null,
  };

  const lead = trains[0];
  if (lead) {
    const r = rank(lead);
    return {
      ...base,
      kind: 'train',
      tone: r === 0 ? 'bad' : r === 1 ? 'warn' : 'info',
      title: trains.length > 1 ? 'Your next steps' : lead.title,
      text: trains.length > 1 ? '' : lead.lines.join(' '),
      waiting: trains.length > 1 ? null : lead.waiting ? { who: lead.waiting.who, text: lead.waiting.text } : null,
      primary: trains.length > 1 ? null : { label: lead.button.label, href: trainHref(lead, input.scope) },
      train: trains.length > 1 ? null : lead,
      rows: trains.length > 1 ? trains.map((t) => rowOf(t, input.scope)) : [],
      otherTrains: trains.length > 1 ? [] : trains.slice(1).map((t) => ({
        title: t.title,
        text: t.lines[0] ?? '',
        href: trainHref(t, input.scope),
        label: t.button.label,
      })),
      items,
      offerStart: input.canStart && r >= 2,
    };
  }

  // No release on its way that could be read: a release left unfinished, or something that has gone wrong, leads.
  const lone =
    unfinished.find((i) => i.href !== null) ??
    items.find((i) => i.tone === 'bad' && i.href !== null && !i.submitAppId);
  if (lone && lone.href) {
    return {
      ...base,
      kind: 'attention',
      tone: lone.tone === 'bad' ? 'bad' : 'warn',
      title: lone.text,
      text: lone.detail ?? '',
      waiting: null,
      primary: { label: lone.action, href: lone.href },
      items: items.filter((i) => i !== lone),
      offerStart: input.canStart,
    };
  }

  const nothing = { ...base, tone: 'neutral' as const, waiting: null, items, offerStart: false };
  if (input.canStart) {
    return {
      ...nothing,
      kind: 'start',
      title: 'Nothing is waiting for you',
      text: 'Start the next release when you are ready. Nothing goes to the store until you confirm.',
      primary: { label: 'Start release', action: 'start-release' },
    };
  }
  if (input.canPrepare) {
    return {
      ...nothing,
      kind: 'prepare',
      title: 'Nothing is waiting for you',
      text: 'Choose a build, write the notes, check it and send it to the store, one step at a time.',
      primary: { label: 'Prepare release', action: 'prepare-release' },
    };
  }
  return {
    ...nothing,
    kind: 'idle',
    title: 'Nothing is waiting for you',
    text: 'A release you start will show here.',
    primary: null,
  };
}
