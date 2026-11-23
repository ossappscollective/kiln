// What the listing locales matrix says about staged values: a marker on the CELL that has one (with the before and after in words),
// and a count per locale row. Pure: the screens give it the staged views the shared store holds (lib/staged-store.svelte.ts), so a
// discard or a publish (lib/staged-sync.ts) removes the marker with the staged row. Wording comes from i18n.
import type { StagedChangesView } from '@kiln/core';
import { t } from './i18n/t.ts';
import { findStagedText } from './staged.ts';

const LIMIT = 60;

/** A text shortened for a tooltip: one line, at most 60 characters. */
export function clipText(text: string, max = LIMIT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…` : line;
}

/** `Staged: <before> → <after>`; an unknown or empty before reads as "nothing". */
export function stagedChangeText(before: string | null, after: string): string {
  const b = before === null || before.trim() === '' ? t('listing:matrixView.stagedNothing') : clipText(before);
  const a = after.trim() === '' ? t('listing:matrixView.stagedNothing') : clipText(after);
  return t('listing:matrixView.stagedChange', { before: b, after: a });
}

export type StagedCellInput = { platform: string; platformName: string; view: StagedChangesView | null; locale: string; field: string };

/**
 * The staged text behind ONE grid cell (one field of one locale on the platforms of the column). `count` is how many platforms have one;
 * `text` is the tooltip and aria text: one `Staged: before → after` per platform, the platform named when there are several.
 */
export function stagedCellMark(inputs: readonly StagedCellInput[]): { count: number; text: string } {
  const parts: string[] = [];
  for (const i of inputs) {
    const staged = findStagedText(i.view, i.locale, i.field);
    if (staged === null) continue;
    const text = stagedChangeText(staged.before, staged.value);
    parts.push(inputs.length > 1 ? `${i.platformName}: ${text}` : text);
  }
  return { count: parts.length, text: parts.join(' · ') };
}

/** How many staged items (listing texts and graphics sets) the given views hold for one locale. */
export function stagedCountForLocale(views: readonly (StagedChangesView | null)[], locale: string): number {
  let n = 0;
  for (const v of views) {
    if (v === null) continue;
    n += v.text.filter((x) => x.locale === locale).length;
    n += v.assets.filter((x) => x.locale === locale).length;
  }
  return n;
}
