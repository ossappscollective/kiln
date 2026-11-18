import {
  type DueFlags,
  type Platform,
  type PlanPlatform,
  isPlanLocale,
  releaseNotesLength,
  releaseNotesLimit,
} from '@mrm/core';
import { ApiError } from './api.ts';
import { compareVersions, platformLabel } from './portfolio.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Routing: `#/portfolio/<appId>/release/<version>`. The release page is a screen of the portfolio
// view, next to the app page, because it can show two apps (iOS and Android) of one product.

export type ReleaseRoute = { appId: string; version: string };

export const releaseHref = (appId: string, version: string) =>
  `#/portfolio/${encodeURIComponent(appId)}/release/${encodeURIComponent(version)}`;

/** Reads a location hash such as `#/portfolio/6f1c/release/2.1.0`. Anything else is `null`. */
export function parseReleaseRoute(hash: string): ReleaseRoute | null {
  const match = /^#?\/?portfolio\/([^/?#]+)\/release\/([^/?#]+)\/?(?:[?#].*)?$/.exec(hash);
  if (!match) return null;
  try {
    const appId = decodeURIComponent(match[1] ?? '');
    const version = decodeURIComponent(match[2] ?? '');
    return appId && version ? { appId, version } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The two platforms of one product

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The app of the other platform that is the same product: the same identifier, else the same name.
 * `null` when there is none (or several names match, which is not a safe guess).
 */
export function findSibling(apps: readonly AppSummary[], app: Pick<AppSummary, 'id' | 'platform' | 'identifier' | 'name'>): AppSummary | null {
  const others = apps.filter((a) => a.platform !== app.platform && a.id !== app.id);
  const byIdentifier = others.filter((a) => sameText(a.identifier, app.identifier));
  if (byIdentifier.length === 1) return byIdentifier[0] as AppSummary;
  if (byIdentifier.length > 1) return null;
  const byName = others.filter((a) => sameText(a.name, app.name));
  return byName.length === 1 ? (byName[0] as AppSummary) : null;
}

/** The releases of one version, most public track first. */
export function releasesOfVersion(releases: readonly ReleaseSummary[], version: string): ReleaseSummary[] {
  return releases
    .filter((r) => r.version === version)
    .sort((a, b) => (a.track ?? '').localeCompare(b.track ?? '') || compareVersions(b.build ?? '', a.build ?? ''));
}

/** Versions of an app that the store reports, newest first, with no repeats. */
export function knownVersions(releases: readonly ReleaseSummary[], planVersions: readonly string[] = []): string[] {
  return [...new Set([...releases.map((r) => r.version), ...planVersions])].sort((a, b) => compareVersions(b, a));
}

// ---------------------------------------------------------------------------------------------
// What the store reports about a rollout. Read only: there is no control for it anywhere.

export type RolloutView = {
  /** "Staged rollout" (Google Play) or "Phased release" (Apple). */
  title: string;
  /** 0 to 1 when the store reported a share; otherwise null. */
  fraction: number | null;
  /** One sentence for a person. */
  text: string;
};

/**
 * What to say about a release's rollout. Apple's phased release is not read yet (see
 * docs/phase-2.md), so an iOS release that is rolling out has no share to show and says so.
 */
export function rolloutView(release: Pick<ReleaseSummary, 'platform' | 'status' | 'rolloutFraction'>): RolloutView {
  const ios = release.platform === 'ios';
  const title = ios ? 'Phased release' : 'Staged rollout';
  const fraction =
    release.rolloutFraction === null || !Number.isFinite(release.rolloutFraction)
      ? null
      : Math.min(1, Math.max(0, release.rolloutFraction));
  if (fraction !== null) {
    return { title, fraction, text: `${percent(fraction)} of eligible users, as the store reports it.` };
  }
  if (release.status === 'rolling_out' || release.status === 'halted') {
    return {
      title,
      fraction: null,
      text: ios
        ? 'The store has this version going out in phases. The share is not read from Apple yet.'
        : 'The store reports no rollout share for this version.',
    };
  }
  if (release.status === 'live') {
    return { title, fraction: null, text: ios ? 'Live for everyone. No phased release is reported.' : 'Live for everyone. No staged rollout is reported.' };
  }
  return { title, fraction: null, text: 'Not rolling out yet.' };
}

function percent(fraction: number): string {
  const value = Math.round(fraction * 1000) / 10;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------------------------
// Dates

/** "Tue, 1 Dec 2026" for a `YYYY-MM-DD` date, read as that calendar day in UTC. */
export function formatTargetDate(date: string, locale?: string): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) return date;
  return new Date(time).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export type DueText = { text: string; tone: 'neutral' | 'warn' | 'bad' | 'ok' };

/** "Due in 3 days", "Due today", "Overdue by 2 days". Neutral when there is nothing to warn about. */
export function dueText(due: Pick<DueFlags, 'dueSoon' | 'overdue' | 'daysLeft'>, released = false): DueText | null {
  if (due.daysLeft === null) return null;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  // Flags are cleared for a release that is out, which leaves a date in the past and no overdue flag.
  if (released || (due.daysLeft < 0 && !due.overdue)) return { text: 'Released', tone: 'ok' };
  if (due.overdue) return { text: `Overdue by ${days(-due.daysLeft)}`, tone: 'bad' };
  if (due.daysLeft === 0) return { text: 'Due today', tone: 'warn' };
  return { text: `Due in ${days(due.daysLeft)}`, tone: due.dueSoon ? 'warn' : 'neutral' };
}

// ---------------------------------------------------------------------------------------------
// Release notes

export type NoteCounter = {
  count: number;
  limit: number;
  over: boolean;
  remaining: number;
  /** "123 of 500 characters", or "12 characters over the limit of 500". */
  label: string;
};

/** The live character count of a locale's release notes against the limit of the plan. */
export function noteCounter(text: string, platform: PlanPlatform): NoteCounter {
  const limit = releaseNotesLimit(platform);
  const count = releaseNotesLength(text);
  const over = count > limit;
  return {
    count,
    limit,
    over,
    remaining: limit - count,
    label: over ? `${count - limit} ${count - limit === 1 ? 'character' : 'characters'} over the limit of ${limit}` : `${count} of ${limit} characters`,
  };
}

/** Who sets the limit, in words: "Google Play allows 500 characters." */
export function limitNote(platform: PlanPlatform): string {
  const limit = releaseNotesLimit(platform);
  if (platform === 'ios') return `The App Store allows ${limit} characters of “What’s new”.`;
  if (platform === 'android') return `Google Play allows ${limit} characters of release notes.`;
  return `This plan covers both platforms, so the stricter limit applies: ${limit} characters (Google Play). The App Store allows ${releaseNotesLimit('ios')}.`;
}

/** Locales worth offering before a person types one. */
export const SUGGESTED_LOCALES: readonly string[] = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'es-MX',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'zh-Hans',
  'ru-RU',
  'default',
];

/** A locale as typed: trimmed, `_` is fine. Returns the code or a problem sentence. */
export function checkLocale(input: string, existing: readonly string[]): { ok: true; locale: string } | { ok: false; message: string } {
  const locale = input.trim();
  if (locale === '') return { ok: false, message: 'Enter a locale code such as en-US or de.' };
  if (!isPlanLocale(locale)) return { ok: false, message: 'Use a locale code such as en-US, de or pt_BR, or default.' };
  if (existing.some((e) => e.toLowerCase() === locale.toLowerCase())) return { ok: false, message: `${locale} is already on this plan.` };
  return { ok: true, locale };
}

// ---------------------------------------------------------------------------------------------
// Checklist

/** The ids with the one at `index` moved by `delta` places. Out of range returns the same order. */
export function moveId(order: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved as string);
  return next;
}

/** "Done by Ada" with the time, or an empty string when the item is open. */
export function doneBy(item: { done: boolean; doneBy: { name: string | null } | null }): string {
  if (!item.done) return '';
  return item.doneBy?.name ? `Done by ${item.doneBy.name}` : 'Done';
}

// ---------------------------------------------------------------------------------------------
// Platform of a plan

export function planPlatformLabel(platform: PlanPlatform): string {
  return platform === null ? 'Both platforms' : platformLabel(platform);
}

/** The plan platforms a new plan for this app can have: its own, or both. */
export function planPlatformChoices(app: { platform: Platform }): { value: PlanPlatform; label: string }[] {
  return [
    { value: null, label: 'Both platforms (shared checklist)' },
    { value: app.platform, label: `${platformLabel(app.platform)} only` },
  ];
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for each thing the plans API can say. */
export function planErrorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  switch (error.code) {
    case 'already_exists':
      return message || 'That already exists.';
    case 'platform_mismatch':
    case 'notes_too_long':
    case 'reason_required':
    case 'order_mismatch':
    case 'too_many_items':
    case 'too_many_locales':
    case 'too_many_templates':
    case 'builtin_template':
      return message || fallback;
    case 'template_not_found':
      return 'That checklist template no longer exists. Reload and pick another.';
    case 'not_found':
      return 'That no longer exists. It may have been deleted. Reload to see the current state.';
    case 'payload_too_large':
      return 'That is too large to save.';
    default:
      return error.message || fallback;
  }
}
