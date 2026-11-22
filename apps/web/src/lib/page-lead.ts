/**
 * Pure parts of `ui/PageLead`: the headline of the top of a per-app page (docs/design/readability.md, "Applied globally"). Each says where
 * the page stands in a few words and which action comes first, so the component only draws.
 */

import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';

export type LeadTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

/**
 * "5 unanswered (3 stars or fewer), oldest 3 d" becomes "5 reviews need an answer (3 stars or fewer), oldest 3 d": the start of
 * the chip (its count and the word for "unanswered", in the active language) is replaced, the rest is kept as it is.
 */
export function needsAnswerText(chipText: string): string {
  const count = /^\d+/.exec(chipText);
  if (!count) return chipText;
  const start = t('reviews:tab.chip', { count: Number(count[0]) });
  if (!chipText.startsWith(start)) return chipText;
  return t('shell:lead.reviews.needAnswer', { count: Number(count[0]) }) + chipText.slice(start.length);
}

export interface ReviewsLead {
  headline: string;
  tone: LeadTone;
  /** What the one primary button does: show the unanswered reviews, read the store again, or none (the empty state has its own). */
  primary: 'show' | 'read' | 'none';
}

export function reviewsLead(input: {
  loaded: boolean;
  stored: number;
  chip: { text: string } | null;
}): ReviewsLead {
  if (!input.loaded)
    return { headline: t('shell:lead.reviews.title'), tone: 'neutral', primary: 'none' };
  if (input.stored === 0)
    return { headline: t('shell:lead.reviews.none'), tone: 'neutral', primary: 'none' };
  if (input.chip)
    return { headline: needsAnswerText(input.chip.text), tone: 'warn', primary: 'show' };
  return { headline: t('shell:lead.reviews.allAnswered'), tone: 'ok', primary: 'read' };
}

/** "12 builds, 3 without a CI run" for the Builds page; the tone is info, since an unlinked build is not an error. */
export function buildsLead(total: number, unlinked: number): { headline: string; tone: LeadTone } {
  if (total === 0) return { headline: t('shell:lead.builds.none'), tone: 'neutral' };
  if (unlinked === 0)
    return { headline: t('shell:lead.builds.allLinked', { count: total }), tone: 'ok' };
  return {
    headline: t('shell:lead.builds.someUnlinked', { count: total, unlinked }),
    tone: 'info',
  };
}

/** The top of Keywords: how many words are tracked and how many rank in the top 10; "not checked yet" is the one thing to do. */
export function keywordsLead(keywords: readonly { state: string | null; rank: number | null }[]): {
  headline: string;
  hint: string;
  tone: LeadTone;
} {
  const n = keywords.length;
  if (n === 0)
    return {
      headline: t('shell:lead.keywords.none'),
      hint: t('shell:lead.keywords.noneHint'),
      tone: 'neutral',
    };
  const top10 = keywords.filter(
    (k) => k.state === 'ranked' && k.rank !== null && k.rank <= 10,
  ).length;
  const unchecked = keywords.filter((k) => k.state === null).length;
  return {
    headline: t('shell:lead.keywords.tracked', { count: n, top: top10 }),
    hint:
      unchecked > 0
        ? t('shell:lead.keywords.unchecked', { count: unchecked })
        : t('shell:lead.keywords.ranks'),
    tone: unchecked > 0 ? 'info' : 'neutral',
  };
}

const PLATFORM_NAMES: Record<string, string> = { ios: 'iOS', macos: 'macOS', android: 'Android' };

/** The top of the app Settings: a failing sync first (with where to look), a record never synced second, otherwise that all is connected. */
export function settingsLead(
  records: readonly {
    platform: string;
    lastSyncError: string | null;
    lastSyncedAt: number | null;
  }[],
): { headline: string; hint: string; tone: LeadTone } {
  const name = (r: { platform: string }) => PLATFORM_NAMES[r.platform] ?? r.platform;
  const failed = records.filter((r) => r.lastSyncError !== null && r.lastSyncError !== '');
  if (failed.length > 0)
    return {
      headline: t('shell:lead.settings.failed', { platforms: formatList(failed.map(name)) }),
      hint: t('shell:lead.settings.failedHint'),
      tone: 'warn',
    };
  const never = records.filter((r) => r.lastSyncedAt === null);
  if (never.length > 0)
    return {
      headline: t('shell:lead.settings.never', {
        count: never.length,
        platforms: formatList(never.map(name)),
      }),
      hint: t('shell:lead.settings.neverHint'),
      tone: 'info',
    };
  return {
    headline: t('shell:lead.settings.connected'),
    hint: t('shell:lead.settings.connectedHint'),
    tone: 'ok',
  };
}
