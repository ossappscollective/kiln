import {
  type PlanStep,
  type PublishPlan,
  STEP_NAME,
  type StepRow,
  summaryParts,
} from './pending.ts';

/**
 * Pure helpers of the readability pass (docs/design/readability.md): what comes first on a screen
 * (the steps and the one next action), and which warnings stay on the line and which are folded
 * behind "Details". A blocking problem is never folded.
 */

/** The longest warning that may stay on the line; a longer one goes behind "Details". */
export const INLINE_WARNING_CHARS = 140;

/**
 * Splits warnings into what stays visible (one short warning) and what is folded behind a single
 * "Details" line (two or more, or one long one). Never loses a warning.
 */
export function foldWarnings(
  warnings: readonly string[],
  maxChars: number = INLINE_WARNING_CHARS,
): { inline: string[]; folded: string[]; label: string } {
  const list = warnings.map((w) => w.trim()).filter((w) => w !== '');
  const only = list[0];
  if (list.length === 1 && only !== undefined && only.length <= maxChars)
    return { inline: [only], folded: [], label: '' };
  return {
    inline: [],
    folded: list,
    label:
      list.length === 0
        ? ''
        : `${list.length} ${list.length === 1 ? 'thing' : 'things'} to read before you confirm`,
  };
}

/** The headline of the publish plan: what will be written and in which order ("Push the draft, then Submit for review"). */
export function planHeadline(
  plan: Pick<PublishPlan, 'steps' | 'included'>,
  store: string,
): { title: string; sequence: string } {
  const names = [...plan.steps]
    .filter((s) => s.included)
    .sort((a, b) => a.order - b.order)
    .map((s) => STEP_NAME[s.type]);
  const n = plan.included;
  return {
    title:
      n === 0
        ? 'Nothing is included yet'
        : `${n} ${n === 1 ? 'step' : 'steps'} will be written to ${store}`,
    sequence: names.join(', then '),
  };
}

/** The status word of a step row, or null when it only repeats what the tick already says ("Ready" on a ticked step). */
export function shownStatusWord(row: Pick<StepRow, 'word' | 'tone' | 'checked'>): string | null {
  return row.tone === 'ok' && row.checked ? null : row.word;
}

/** One line of what a step does ("3 text changes, 1 graphics set"), from the plan's own numbers; empty when it carries none. */
export function stepGist(step: Pick<PlanStep, 'type' | 'summary'>): string {
  return summaryParts(step).join(', ');
}

/**
 * The first `limit` items stay visible, and every item with a bad tone does too (a blocking
 * problem is never hidden behind "Show more"). The rest is counted for the "Show N more" line.
 */
export function capItems<T extends { tone: string }>(
  items: readonly T[],
  limit: number,
): { shown: T[]; hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  items.forEach((item, i) => (i < limit || item.tone === 'bad' ? shown : hidden).push(item));
  return { shown, hidden };
}

// ---------------------------------------------------------------------------------------------
// The publish dialog

/** The most consequential step that is included: the one the dialog's title names. */
const TITLE_ORDER: readonly PlanStep['type'][] = ['release', 'submit', 'push_draft', 'rollout'];

/**
 * The title of the publish dialog says what happens ("Release 2.9.0 to the App Store"), from the included steps and the version the
 * plan carries. `store` is the store with its article ("the App Store", "Google Play").
 */
export function publishTitle(plan: Pick<PublishPlan, 'steps'>, store: string): string {
  const included = plan.steps.filter((s) => s.included);
  const top = TITLE_ORDER.map((t) => included.filter((s) => s.type === t)[0]).filter(
    (s): s is PlanStep => s !== undefined,
  )[0];
  if (top === undefined) return `Publish to ${store}`;
  const summary = top.summary ?? {};
  const pick = (key: string): string =>
    typeof summary[key] === 'string' ? (summary[key] as string).trim() : '';
  const version =
    top.type === 'release' ? pick('version') : top.type === 'submit' ? pick('versionString') : '';
  const v = version !== '' ? ` ${version}` : '';
  switch (top.type) {
    case 'release':
      return `Release${v} to ${store}`;
    case 'submit':
      return `Submit${v} for review on ${store}`;
    case 'push_draft':
      return `Update the draft on ${store}`;
    default:
      return `Change the rollout on ${store}`;
  }
}

/**
 * The one short line in the footer that says why Publish is disabled; empty when it can be pressed (or while it runs).
 * The typed phrase is named only when the plan asks for it.
 */
export function publishDisabledReason(input: {
  phase: string;
  stale: boolean;
  ready: boolean;
  wanted: number;
  plan: Pick<PublishPlan, 'confirmable' | 'confirmationRequired' | 'confirmation'> | null;
}): string {
  if (input.ready || input.phase === 'publishing' || input.phase === 'done') return '';
  if (input.phase === 'previewing') return 'Making the plan.';
  const plan = input.plan;
  if (plan === null) return '';
  if (input.stale) return 'The plan is out of date. Review again to publish.';
  if (!plan.confirmable)
    return input.wanted === 0
      ? 'Tick at least one step to publish.'
      : 'A step cannot run. Untick it or fix what blocks it.';
  if (plan.confirmationRequired && plan.confirmation)
    return `Type "${plan.confirmation.phrase}" to publish.`;
  return 'Tick the box above to publish.';
}
