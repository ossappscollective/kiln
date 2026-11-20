import type { Platform } from '@mrm/core';
import { supports } from '@mrm/core';
import type { PendingItem, PublishStepType } from './pending.ts';
import type { BuildRow } from './release-candidates.ts';
import type { Chosen, Level, StagedFacts, StepId } from './release-stepper.ts';
import { STEP_LABELS } from './release-stepper.ts';
import { storeName } from './staged.ts';

/**
 * Pure parts of the stepper's layout (docs/design/readability.md, "Release stepper"): what the step rail draws, the footer's
 * labels, the one heading and sentence of each step, the compact build rows and the numbered list of the Confirm step.
 * Nothing here reads or writes anything. Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// The rail

export type RailMark = 'current' | 'done' | 'attention' | 'blocked' | 'optional' | 'todo';

/** The mark of a step in the rail: the current step is filled, a ready one is a check, a problem keeps its own mark. */
export function railMark(level: Level, current: boolean): RailMark {
  if (current) return 'current';
  switch (level) {
    case 'ready':
      return 'done';
    case 'attention':
      return 'attention';
    case 'blocked':
      return 'blocked';
    case 'optional':
      return 'optional';
    default:
      return 'todo';
  }
}

// ---------------------------------------------------------------------------------------------
// The footer

export type FooterPrimary =
  | { kind: 'step'; to: StepId; label: string }
  | { kind: 'publish'; label: string }
  | { kind: 'close'; label: string };

export type Footer = { position: string; back: StepId | null; primary: FooterPrimary };

/**
 * Back, "Step N of M" and the one primary: "Next: <name of the next step>", on the last step "Review and publish" (Confirm) or
 * "Close" (when Confirm is not shown to this person).
 */
export function footerFor(current: StepId, visible: readonly StepId[]): Footer {
  const i = visible.indexOf(current);
  const next = i >= 0 ? visible[i + 1] : undefined;
  const back = i > 0 ? (visible[i - 1] ?? null) : null;
  const position = `Step ${i < 0 ? 1 : i + 1} of ${visible.length}`;
  if (next !== undefined)
    return {
      position,
      back,
      primary: { kind: 'step', to: next, label: `Next: ${STEP_LABELS[next]}` },
    };
  return {
    position,
    back,
    primary:
      current === 'confirm'
        ? { kind: 'publish', label: 'Review and publish' }
        : { kind: 'close', label: 'Close' },
  };
}

// ---------------------------------------------------------------------------------------------
// The numbered list of the Confirm step

export type ConfirmStep = {
  type: PublishStepType;
  title: string;
  detail: string;
  /** "Can be changed again", "Cannot be undone from here" or null. */
  note: string | null;
  irreversible: boolean;
};

const ORDER: readonly PublishStepType[] = ['push_draft', 'submit', 'release', 'rollout'];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What waits to be written, in the order the steps run, from the pending items of the app. The server still makes the real plan when
 * the person presses "Review and publish"; this is the same order in plain words, so the last step shows what the button will do.
 */
export function confirmSteps(items: readonly PendingItem[], platform: Platform): ConfirmStep[] {
  const out: ConfirmStep[] = [];
  for (const type of ORDER) {
    const mine = items.filter((i) => i.nextStep === type);
    if (mine.length === 0) continue;
    if (type === 'push_draft') {
      const texts = mine
        .filter((i) => i.kind === 'listing_text')
        .reduce((n, i) => n + (i.counts.changes ?? i.refs.length), 0);
      const sets = mine.filter((i) => i.kind === 'asset_set').length;
      const fields = mine.filter((i) => i.kind === 'release_field').length;
      const parts: string[] = [];
      if (texts > 0) parts.push(plural(texts, 'text change', 'text changes'));
      if (sets > 0) parts.push(plural(sets, 'graphics set', 'graphics sets'));
      if (fields > 0) parts.push(plural(fields, 'release field', 'release fields'));
      out.push({
        type,
        title: 'Push the staged changes to the store draft',
        detail: parts.join(', '),
        note: 'Can be changed again',
        irreversible: false,
      });
    } else if (type === 'submit') {
      out.push({
        type,
        title: 'Submit the draft for review',
        detail: mine.map((i) => i.label).join(', '),
        note: null,
        irreversible: false,
      });
    } else if (type === 'release') {
      out.push({
        type,
        title: supports(platform, 'releaseTracks')
          ? 'Release to users'
          : 'Release the approved version',
        detail: mine.map((i) => i.label).join(', '),
        note: 'Cannot be undone from here',
        irreversible: true,
      });
    } else {
      out.push({
        type,
        title: 'Change the rollout',
        detail: mine.map((i) => i.label).join(', '),
        note: null,
        irreversible: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One heading and one sentence per step

export type IntroFacts = {
  platform: Platform;
  version: string | null;
  chosen: Chosen | null;
  notes: { withText: number };
  staged: StagedFacts;
  /** The steps the Confirm list holds (null: not read yet). */
  confirm: readonly ConfirmStep[] | null;
  /** The version is in store review: nothing to publish, the store has the next move. */
  inReview?: boolean;
};

export function stepIntro(step: StepId, f: IntroFacts): { title: string; sentence: string } {
  const apple = !supports(f.platform, 'releaseTracks');
  if (step === 'build') {
    const title = apple
      ? `Choose the build for ${f.version ?? 'this version'}`
      : 'Choose the version codes';
    if (f.chosen !== null) {
      const where =
        f.chosen.where === 'staged' ? 'is chosen' : apple ? 'is attached' : 'is in the draft';
      return {
        title,
        sentence: `${f.chosen.label} ${where}, so you can go straight to the next step.`,
      };
    }
    return {
      title,
      sentence: apple
        ? 'Pick the build App Store Connect should use for this version.'
        : 'Pick what to promote and where to release it.',
    };
  }
  if (step === 'notes') {
    const title = f.version !== null ? `Write what is new in ${f.version}` : 'Write what is new';
    return {
      title,
      sentence:
        f.notes.withText > 0
          ? `${plural(f.notes.withText, 'language has', 'languages have')} notes. Check them, or go on.`
          : 'Add the text people read in the store, one language at a time.',
    };
  }
  if (step === 'assets') {
    return {
      title: 'Check the screenshots',
      sentence: 'This step is optional. Nothing here changes anything.',
    };
  }
  if (step === 'review') {
    return {
      title: 'Check what will be sent',
      sentence:
        f.staged.total === 0
          ? 'Nothing is staged, so there is nothing to check.'
          : `${plural(f.staged.total, 'change is', 'changes are')} staged. Remove what you do not want. Nothing is sent yet.`,
    };
  }
  const n = f.confirm === null ? null : f.confirm.length;
  if (n === null) return { title: 'Publish', sentence: 'Reading what waits to be published.' };
  if (n === 0 && f.inReview === true)
    return {
      title: `${f.version !== null ? `Version ${f.version} is` : 'This version is'} in store review`,
      sentence:
        'Waiting on the store. Nothing is waiting to be published, and nobody here can speed up the review.',
    };
  if (n === 0)
    return {
      title: 'Nothing waits to be published',
      sentence: 'Stage a change in an earlier step, or come back when a draft is ready.',
    };
  return {
    title: `Publish ${plural(n, 'step', 'steps')} to ${storeName(f.platform)}`,
    sentence: 'They run in this order and stop at the first one that fails.',
  };
}

// ---------------------------------------------------------------------------------------------
// The Build step

export type ChipTone = 'ok' | 'info' | 'warn' | 'bad' | 'neutral';

/** The ONE state chip of a build row. */
export function buildChip(
  row: Pick<BuildRow, 'eligibility'>,
  flags: { attached: boolean; staged: boolean },
): { text: string; tone: ChipTone } {
  if (row.eligibility.tone === 'bad') return { text: 'Cannot be chosen', tone: 'bad' };
  if (flags.staged) return { text: 'Chosen', tone: 'info' };
  if (flags.attached) return { text: 'Attached', tone: 'ok' };
  if (row.eligibility.tone === 'warn') return { text: 'Read first', tone: 'warn' };
  return { text: 'Can be chosen', tone: 'neutral' };
}

/**
 * The rows with the one to start from first: the chosen (staged) build, else the attached one, else the newest that can be chosen.
 * The others keep their order (newest first, as the server lists them).
 */
export function orderBuilds<T extends { id: string; eligibility: { selectable: boolean } }>(
  rows: readonly T[],
  chosenId: string | null,
): { rows: T[]; firstId: string | null } {
  const hit =
    (chosenId !== null ? rows.filter((r) => r.id === chosenId)[0] : undefined) ??
    rows.filter((r) => r.eligibility.selectable)[0];
  if (hit === undefined) return { rows: [...rows], firstId: null };
  return { rows: [hit, ...rows.filter((r) => r.id !== hit.id)], firstId: hit.id };
}

/** The newest `limit` rows, and always the row that is picked (it may be an older one). The rest is counted for "Show all". */
export function visibleBuilds<T extends { id: string }>(
  rows: readonly T[],
  opts: { limit?: number; showAll: boolean; pickedId: string },
): { shown: T[]; hidden: number } {
  const limit = opts.limit ?? 3;
  if (opts.showAll || rows.length <= limit) return { shown: [...rows], hidden: 0 };
  const shown = rows.slice(0, limit);
  const picked = rows.filter((r) => r.id === opts.pickedId)[0];
  if (picked !== undefined && shown.indexOf(picked) < 0) shown[limit - 1] = picked;
  return { shown, hidden: rows.length - shown.length };
}

/** The selected build has a real problem (a warning to read, or it cannot be chosen): the details open by themselves. */
export const buildHasProblem = (row: Pick<BuildRow, 'eligibility'> | undefined): boolean =>
  row !== undefined && (row.eligibility.tone === 'bad' || row.eligibility.tone === 'warn');
