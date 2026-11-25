import type { Platform } from '@kiln/core';
import {
  type CheckCode,
  type Fix,
  type ListingFixKind,
  stageableFixesOf,
  type UnfixableIssue,
} from '@kiln/core';
import { k, t } from '../i18n/t.ts';
import { notStageableReason } from './edit.ts';

/**
 * One-click fixes of the listing checks, pure parts of the web (docs/adr/0059-listing-fixes-via-cart.md). The SERVER computes every fix
 * (`GET .../listing/fixes`) and stages it again from its own values (`POST .../listing/fixes/stage`); nothing here makes text. What is here
 * only chooses which fix belongs to which finding, words the labels and the review, and hashes the text the person reviewed so a changed text is
 * refused as stale. Written for the ES2017 web build.
 */

export type LocaleFixes = {
  locale: string;
  fixes: Fix[];
  cannot: UnfixableIssue[];
  staged: { field: string; id: string }[];
};

export type ListingFixesView = {
  appId: string;
  store: 'app_store' | 'google_play';
  afterPending: {
    score: number;
    issueCount: number;
    counts: { problems: number; warnings: number; tips: number };
    resolved: string[];
  } | null;
  locales: LocaleFixes[];
};

const LABEL: Record<Fix['id'], string> = {
  keywords_tidy: k('listing:fix.keywordsTidy'),
  keywords_drop_in_title: k('listing:fix.keywordsDropInTitle'),
  keywords_fit: k('listing:fix.keywordsFit'),
  text_tidy: k('listing:fix.textTidy'),
  shorten_ai: k('listing:fix.shortenAi'),
  edit_field: k('listing:fix.editField'),
};

export const fixLabel = (fix: Pick<Fix, 'id'>): string => t(LABEL[fix.id]);

/** What a fix does to the field, in one sentence for the review ("Drops 3 whole terms"). */
export function fixSummary(fix: Fix): string {
  if (fix.removed.length > 0) return t('listing:fix.drops', { count: fix.removed.length });
  return fix.risk === 'safe' ? t('listing:fix.noMeaning') : t('listing:fix.whiteSpace');
}

const ORDER: Record<Fix['id'], number> = {
  keywords_tidy: 1,
  text_tidy: 1,
  keywords_drop_in_title: 2,
  keywords_fit: 3,
  shorten_ai: 4,
  edit_field: 5,
};

/** The fix a finding row offers: the gentlest fix that settles that finding (so a spaces finding offers the tidy, not the drops). Null: none. */
export function fixForIssue(
  locale: LocaleFixes | undefined,
  issue: { field: string | null; code: CheckCode },
  kind?: ListingFixKind,
): Fix | null {
  if (!locale || issue.field === null) return null;
  let best: Fix | null = null;
  for (const fix of locale.fixes) {
    if (fix.field !== issue.field || fix.resolves.indexOf(issue.code) < 0) continue;
    if (kind !== undefined && fix.kind !== kind) continue;
    if (best === null || ORDER[fix.id] < ORDER[best.id]) best = fix;
  }
  return best;
}

/** The finding is one the checks found but no automatic fix can settle ("cannot be fixed automatically"). */
export const cannotFix = (
  locale: LocaleFixes | undefined,
  issue: { field: string | null; code: CheckCode },
): boolean =>
  !!locale && locale.cannot.some((c) => c.field === issue.field && c.code === issue.code);

/** The fixes "Fix all" stages for a locale: one per field, the strongest, only those a push can write. */
export const fixAllOf = (locale: LocaleFixes | undefined): Fix[] =>
  locale ? stageableFixesOf(locale.fixes) : [];

/** The staged item of a field of a locale (to discard a staged fix), or null. */
export const stagedItemOf = (
  locale: LocaleFixes | undefined,
  field: string | null,
): string | null => locale?.staged.find((s) => s.field === field)?.id ?? null;

export type TermMark = { term: string; removed: boolean };

/** The terms of a keyword field before the fix, each marked when the fix removes it (each removed term once, by position of the first match). */
export function termMarks(before: string, removed: readonly string[]): TermMark[] {
  const pending = removed.map((r) => r.toLowerCase());
  const out: TermMark[] = [];
  for (const raw of before.split(',')) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (term === '') continue;
    const at = pending.indexOf(term.toLowerCase());
    if (at >= 0) pending.splice(at, 1);
    out.push({ term, removed: at >= 0 });
  }
  return out;
}

/** SHA-256 of the text as the server hashes it (line breaks as `\n`, no trailing white space), so the server can tell the text changed. */
export async function hashText(value: string): Promise<string> {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let out = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i += 1) out += (view[i] as number).toString(16).padStart(2, '0');
  return out;
}

/** Why a fix button is off, or null: a locked version, no right to stage, or a field a draft push cannot write. */
export function fixBlockedReason(input: {
  canStage: boolean;
  locked: boolean;
  stageable: boolean;
  platform: Platform;
  field: string;
}): string | null {
  if (input.locked) return t('listing:fix.locked');
  if (!input.canStage) return t('listing:fix.noRight');
  if (!input.stageable) return notStageableReason(input.platform, input.field);
  return null;
}
