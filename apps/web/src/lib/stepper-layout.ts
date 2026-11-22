import type { Platform } from '@kiln/core';
import { supports } from '@kiln/core';
import type { PendingItem, PublishStepType } from './pending.ts';
import type { BuildRow } from './release-candidates.ts';
import type { Chosen, Level, StagedFacts, StepId } from './release-stepper.ts';
import { STEP_LABELS } from './release-stepper.ts';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';
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
  const position = t('common:stepper.position', { n: i < 0 ? 1 : i + 1, total: visible.length });
  if (next !== undefined)
    return {
      position,
      back,
      primary: { kind: 'step', to: next, label: t('common:stepper.next', { step: STEP_LABELS[next] }) },
    };
  return {
    position,
    back,
    primary:
      current === 'confirm'
        ? { kind: 'publish', label: t('common:stepper.reviewPublish') }
        : { kind: 'close', label: t('common:action.close') },
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
      if (texts > 0) parts.push(t('common:stepper.detail.texts', { count: texts }));
      if (sets > 0) parts.push(t('common:stepper.detail.sets', { count: sets }));
      if (fields > 0) parts.push(t('common:stepper.detail.fields', { count: fields }));
      out.push({
        type,
        title: t('common:stepper.confirm.push'),
        detail: formatList(parts),
        note: t('common:stepper.confirm.pushNote'),
        irreversible: false,
      });
    } else if (type === 'submit') {
      out.push({
        type,
        title: t('common:stepper.confirm.submit'),
        detail: formatList(mine.map((i) => i.label)),
        note: null,
        irreversible: false,
      });
    } else if (type === 'release') {
      out.push({
        type,
        title: supports(platform, 'releaseTracks')
          ? t('common:stepper.confirm.releaseUsers')
          : t('common:stepper.confirm.releaseApproved'),
        detail: formatList(mine.map((i) => i.label)),
        note: t('common:stepper.confirm.releaseNote'),
        irreversible: true,
      });
    } else {
      out.push({
        type,
        title: t('common:stepper.confirm.rollout'),
        detail: formatList(mine.map((i) => i.label)),
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
      ? f.version !== null
        ? t('common:stepper.build.titleVersion', { version: f.version })
        : t('common:stepper.build.titleThisVersion')
      : t('common:stepper.build.titleCodes');
    if (f.chosen !== null) {
      const label = f.chosen.label;
      return {
        title,
        sentence:
          f.chosen.where === 'staged'
            ? t('common:stepper.build.chosen', { label })
            : apple
              ? t('common:stepper.build.attached', { label })
              : t('common:stepper.build.inDraft', { label }),
      };
    }
    return {
      title,
      sentence: apple ? t('common:stepper.build.pickApple') : t('common:stepper.build.pickGoogle'),
    };
  }
  if (step === 'notes') {
    const title =
      f.version !== null
        ? t('common:stepper.notes.titleVersion', { version: f.version })
        : t('common:stepper.notes.title');
    return {
      title,
      sentence:
        f.notes.withText > 0
          ? t('common:stepper.notes.have', { count: f.notes.withText })
          : t('common:stepper.notes.add'),
    };
  }
  if (step === 'assets') {
    return {
      title: t('common:stepper.assets.title'),
      sentence: t('common:stepper.assets.sentence'),
    };
  }
  if (step === 'review') {
    return {
      title: t('common:stepper.review.title'),
      sentence:
        f.staged.total === 0
          ? t('common:stepper.review.nothing')
          : t('common:stepper.review.staged', { count: f.staged.total }),
    };
  }
  const n = f.confirm === null ? null : f.confirm.length;
  if (n === null)
    return { title: t('common:stepper.publish.title'), sentence: t('common:stepper.publish.reading') };
  if (n === 0 && f.inReview === true)
    return {
      title:
        f.version !== null
          ? t('common:stepper.publish.inReviewVersion', { version: f.version })
          : t('common:stepper.publish.inReview'),
      sentence: t('common:stepper.publish.inReviewSentence'),
    };
  if (n === 0)
    return {
      title: t('common:stepper.publish.nothingTitle'),
      sentence: t('common:stepper.publish.nothingSentence'),
    };
  return {
    title: t('common:stepper.publish.steps', { count: n, store: storeName(f.platform) }),
    sentence: t('common:stepper.publish.order'),
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
  if (row.eligibility.tone === 'bad') return { text: t('common:stepper.chip.cannot'), tone: 'bad' };
  if (flags.staged) return { text: t('common:stepper.chip.chosen'), tone: 'info' };
  if (flags.attached) return { text: t('common:stepper.chip.attached'), tone: 'ok' };
  if (row.eligibility.tone === 'warn') return { text: t('common:stepper.chip.readFirst'), tone: 'warn' };
  return { text: t('common:stepper.chip.can'), tone: 'neutral' };
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
