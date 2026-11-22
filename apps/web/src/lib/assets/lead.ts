import type { AssetKind, AssetProblem } from '@kiln/core';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { LeadTone } from '../page-lead.ts';

/**
 * The top of the Graphics view (components/assets/AssetsTab): what the checks found in a few words, which sets are affected, and one line
 * per blocking problem with what to do about it (docs/design/readability.md, rule 4: a blocking problem is never folded).
 */

/** Blocking problems (errors) first and always shown; warnings and notes fold behind "Problems found". */
export function splitProblems(problems: readonly AssetProblem[]): {
  blocking: AssetProblem[];
  other: AssetProblem[];
} {
  return {
    blocking: problems.filter((p) => p.severity === 'error'),
    other: problems.filter((p) => p.severity !== 'error'),
  };
}

/** "2 warnings, 1 note" for the folded part. */
export function otherCountsText(other: readonly AssetProblem[]): string {
  const warnings = other.filter((p) => p.severity === 'warning').length;
  const notes = other.length - warnings;
  const parts: string[] = [];
  if (warnings > 0) parts.push(t('assets:problems.warnings', { count: warnings }));
  if (notes > 0) parts.push(t('assets:problems.notes', { count: notes }));
  return formatList(parts, { type: 'unit' });
}

const setKey = (p: Pick<AssetProblem, 'locale' | 'kind' | 'device'>): string | null =>
  p.locale === undefined || p.kind === undefined ? null : `${p.locale}|${p.kind}|${p.device ?? ''}`;

/** How many sets (locale, kind and device) the problems touch, and the one kind they share (or null). Problems with no set count as one each. */
export function affectedSets(problems: readonly AssetProblem[]): {
  count: number;
  kind: AssetKind | null;
} {
  const keys = new Set<string>();
  const kinds = new Set<AssetKind>();
  let loose = 0;
  for (const p of problems) {
    const key = setKey(p);
    if (key === null) loose += 1;
    else keys.add(key);
    if (p.kind !== undefined) kinds.add(p.kind);
  }
  const count = keys.size + loose;
  const only = kinds.size === 1 && loose === 0 ? ([...kinds][0] ?? null) : null;
  return { count, kind: only };
}

const SET_PHRASE: Record<AssetKind, string> = {
  screenshot: k('assets:lead.set.screenshot'),
  preview: k('assets:lead.set.preview'),
  feature_graphic: k('assets:lead.set.featureGraphic'),
  promo_graphic: k('assets:lead.set.promoGraphic'),
  tv_banner: k('assets:lead.set.tvBanner'),
  icon: k('assets:lead.set.icon'),
  app_icon: k('assets:lead.set.appIcon'),
};

/** "2 screenshot sets", or "2 sets" when the sets are of more than one kind. */
const setsText = (count: number, kind: AssetKind | null): string =>
  t(kind !== null && SET_PHRASE[kind] !== undefined ? SET_PHRASE[kind] : k('assets:lead.set'), { count });

export type AssetsLead = { headline: string; hint: string; tone: LeadTone; blocking: number };

/** "2 screenshot sets have problems" when something blocks, a warning line, or "All files pass the store checks". */
export function assetsLead(input: {
  problems: readonly AssetProblem[];
  /** The existing "12 files, 3 locales, 4.2 MB" text. */
  summary: string;
}): AssetsLead {
  const { blocking, other } = splitProblems(input.problems);
  if (blocking.length > 0) {
    const { count, kind } = affectedSets(blocking);
    return {
      headline: t('assets:lead.blocking.headline', { count, sets: setsText(count, kind) }),
      hint: t('assets:lead.blocking.hint', { summary: input.summary }),
      tone: 'bad',
      blocking: blocking.length,
    };
  }
  const warnings = other.filter((p) => p.severity === 'warning');
  if (warnings.length > 0) {
    const { count, kind } = affectedSets(warnings);
    return {
      headline: t('assets:lead.warning.headline', { count, sets: setsText(count, kind) }),
      hint: t('assets:lead.warning.hint', { summary: input.summary }),
      tone: 'warn',
      blocking: 0,
    };
  }
  return {
    headline: t('assets:lead.ok.headline'),
    hint: t('assets:lead.ok.hint', { summary: input.summary }),
    tone: 'ok',
    blocking: 0,
  };
}

/** One short sentence on what to do about a problem, from the end of its rule code. Empty when there is nothing general to say. */
export function problemAction(rule: string): string {
  const end = rule.split('.').at(-1) ?? '';
  switch (end) {
    case 'size':
    case 'dimension':
    case 'ratio':
      return t('assets:lead.action.size');
    case 'bytes':
      return t('assets:lead.action.bytes');
    case 'format':
      return t('assets:lead.action.format');
    case 'count':
      return t('assets:lead.action.count');
    case 'minimum':
      return t('assets:lead.action.minimum');
    case 'unread':
      return t('assets:lead.action.unread');
    default:
      return '';
  }
}
