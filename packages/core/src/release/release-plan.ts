/**
 * Release planning: the rules shared by the API and the web UI. A plan is our own data (a
 * checklist, release notes per locale, a target date, a blocked flag); nothing here reads or
 * writes a store. Pure functions only, so both sides compute the same readiness and due flags.
 */

import { isLocaleOrDefault } from '../listing-facts/locale.ts';
import { APP_STORE_FIELD_SPECS, measureField, PLAY_CHANGELOG_SPEC } from '../listing/listing.ts';
import { byFamily, type Platform } from '../platform.ts';

/** `null` means the plan covers both platforms. */
export type PlanPlatform = Platform | null;

// ---------------------------------------------------------------------------------------------
// Limits

export const MAX_PLAN_VERSION_LENGTH = 64;
export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_CHECKLIST_TEXT_LENGTH = 300;
export const MAX_BLOCKED_REASON_LENGTH = 500;
/** App Store Connect offers about 40 locales and Play about 80; this is a sanity cap. */
export const MAX_NOTE_LOCALES = 80;
export const MAX_TEMPLATES = 50;
export const MAX_TEMPLATE_NAME_LENGTH = 100;

/** Release notes limit of the App Store ("What's new"), in characters. */
export const APP_STORE_RELEASE_NOTES_LIMIT: number = APP_STORE_FIELD_SPECS.release_notes
  .maxLength as number;
/** Release notes limit of a Play release, in characters. */
export const PLAY_RELEASE_NOTES_LIMIT: number = PLAY_CHANGELOG_SPEC.maxLength as number;

/** The most a plan's release notes of one locale may hold at the server: the App Store's limit, the larger of the two (the stricter store is judged by `releaseNotesLimit`). */
export const MAX_PLAN_NOTES_LENGTH: number = APP_STORE_RELEASE_NOTES_LIMIT;

/**
 * The most characters a locale's release notes may have. A plan for both platforms must fit the
 * stricter store, so it gets the smaller limit. Taken from the listing rules in `listing.ts`.
 */
export function releaseNotesLimit(platform: PlanPlatform): number {
  if (platform !== null)
    return byFamily(platform, {
      apple: APP_STORE_RELEASE_NOTES_LIMIT,
      google: PLAY_RELEASE_NOTES_LIMIT,
    });
  return Math.min(APP_STORE_RELEASE_NOTES_LIMIT, PLAY_RELEASE_NOTES_LIMIT);
}

/** Length as the listing rules count it: the one counting unit (`measureField`: code points, trimmed). */
export const releaseNotesLength = (value: string): number => measureField({ unit: 'characters' }, value);

// ---------------------------------------------------------------------------------------------
// Values

/** A version as people write it: `1.2.3`, `2.0.0-beta.1`, `2024.11`. */
export function isPlanVersion(value: string): boolean {
  return value.length <= MAX_PLAN_VERSION_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

/**
 * `default` (the fallback folder of fastlane) or a locale code such as `en-US`, `de`, `pt_BR`.
 * @deprecated Delegates to `isLocaleOrDefault` (listing-facts/locale.ts), the one locale validator.
 */
export function isPlanLocale(value: string): boolean {
  return isLocaleOrDefault(value);
}

const DAY = 24 * 60 * 60 * 1000;

/** A real calendar date written `YYYY-MM-DD`. */
export function isTargetDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------------------------
// Deadlines

/** A target date within this many days (today included) is "due soon". */
export const DUE_SOON_DAYS = 3;

export type DueFlags = {
  /** The target date is today or within `DUE_SOON_DAYS` days, and the release is not out yet. */
  dueSoon: boolean;
  /** The target date has passed (its day is over, in UTC) and the release is not out yet. */
  overdue: boolean;
  /** Whole days from today (UTC) to the target date: 0 on the day, negative after. Null without a date. */
  daysLeft: number | null;
};

/**
 * Deadline flags for a target date. The date is a calendar day compared in UTC: it is overdue once
 * that day is over. A release that is already out is neither due soon nor overdue. The clock is an
 * argument so tests and the server control it.
 */
export function dueFlags(
  targetDate: string | null,
  now: number,
  options: { released?: boolean; soonDays?: number } = {},
): DueFlags {
  if (targetDate === null || !isTargetDate(targetDate))
    return { dueSoon: false, overdue: false, daysLeft: null };
  const start = Date.parse(`${targetDate}T00:00:00Z`);
  const today = Math.floor(now / DAY) * DAY;
  const daysLeft = Math.round((start - today) / DAY);
  if (options.released) return { dueSoon: false, overdue: false, daysLeft };
  const overdue = now >= start + DAY;
  const dueSoon = !overdue && daysLeft <= (options.soonDays ?? DUE_SOON_DAYS);
  return { dueSoon, overdue, daysLeft };
}

// ---------------------------------------------------------------------------------------------
// Readiness

export type ReadinessItem = { required: boolean; done: boolean };
export type ReadinessNote = { locale: string; text: string };

export type Readiness = {
  /** Every required item is done and every locale has release notes within the limit. */
  ready: boolean;
  required: { total: number; done: number; open: number };
  notes: {
    /** Characters allowed per locale for this plan. */
    limit: number;
    /** Locales on the plan, written or not. */
    locales: number;
    /** Locales with text. */
    filled: number;
    /** Locales with no text yet. */
    missing: string[];
    /** Locales whose text is over the limit. */
    tooLong: string[];
    /** At least one locale, all written, none too long. */
    complete: boolean;
  };
  /** Plain sentences for what still stands in the way. Empty when ready. */
  reasons: string[];
};

export function computeReadiness(input: {
  items: readonly ReadinessItem[];
  notes: readonly ReadinessNote[];
  platform: PlanPlatform;
}): Readiness {
  const required = input.items.filter((i) => i.required);
  const done = required.filter((i) => i.done).length;
  const limit = releaseNotesLimit(input.platform);
  const missing = input.notes.filter((n) => n.text.trim() === '').map((n) => n.locale);
  const tooLong = input.notes.filter((n) => releaseNotesLength(n.text) > limit).map((n) => n.locale);
  const complete = input.notes.length > 0 && missing.length === 0 && tooLong.length === 0;
  const open = required.length - done;

  const reasons: string[] = [];
  if (open > 0) reasons.push(`${open} required ${open === 1 ? 'item is' : 'items are'} not done.`);
  if (input.notes.length === 0) reasons.push('No release notes yet. Add at least one locale.');
  if (missing.length > 0) reasons.push(`Release notes are missing for ${missing.join(', ')}.`);
  if (tooLong.length > 0)
    reasons.push(`Release notes are over ${limit} characters for ${tooLong.join(', ')}.`);

  return {
    ready: open === 0 && complete,
    required: { total: required.length, done, open },
    notes: {
      limit,
      locales: input.notes.length,
      filled: input.notes.length - missing.length,
      missing,
      tooLong,
      complete,
    },
    reasons,
  };
}

// ---------------------------------------------------------------------------------------------
// Checklist templates

export type ChecklistTemplateItem = { text: string; required: boolean };

export type DefaultChecklistTemplate = {
  /** `builtin:<key>`. Never a workspace's own template id. */
  id: string;
  name: string;
  description: string;
  items: ChecklistTemplateItem[];
};

export const BUILTIN_TEMPLATE_PREFIX = 'builtin:';

export const isBuiltinTemplateId = (id: string): boolean => id.startsWith(BUILTIN_TEMPLATE_PREFIX);

const req = (text: string): ChecklistTemplateItem => ({ text, required: true });
const opt = (text: string): ChecklistTemplateItem => ({ text, required: false });

/**
 * Starting points that ship with the product. They are not stored per workspace, so they cannot
 * be deleted and they improve with an upgrade; a team that wants its own wording saves a template.
 * The lists follow what each store asks for before a first release; the store's own console is the
 * authority, and a few of these answers are only checkable there.
 */
export const DEFAULT_CHECKLIST_TEMPLATES: readonly DefaultChecklistTemplate[] = [
  {
    id: 'builtin:first-ios',
    name: 'First iOS release',
    description: 'What App Store Connect asks for before the first App Review submission.',
    items: [
      req('Privacy policy URL is set and opens'),
      req('Screenshots are uploaded for every required device size'),
      req('Export compliance (encryption) questions are answered'),
      req('Age rating questionnaire is completed'),
      req('App privacy answers (data collection) are complete'),
      req('Test account and review notes are ready for App Review'),
      req('Release notes are written for every locale'),
      req('What’s new text is reviewed by a second person'),
      opt('Support URL and marketing URL open'),
      opt('Build tested on a real device from TestFlight'),
    ],
  },
  {
    id: 'builtin:first-android',
    name: 'First Android release',
    description: 'What Google Play Console asks for before the first production release.',
    items: [
      req('Privacy policy URL is set and opens'),
      req('Screenshots and the feature graphic are uploaded'),
      req('Content rating questionnaire is completed'),
      req('Data safety form is completed'),
      req('App access instructions and a test account are ready for review'),
      req('Target audience and ads declarations are answered'),
      req('Release notes are written for every locale'),
      req('What’s new text is reviewed by a second person'),
      opt('Tested on the internal testing track'),
      opt('Staged rollout steps are agreed'),
    ],
  },
  {
    id: 'builtin:routine-update',
    name: 'Routine update',
    description: 'A short checklist for a version after the first one.',
    items: [
      req('Release notes are written for every locale'),
      req('What’s new text is reviewed by a second person'),
      req('Build is tested and chosen'),
      opt('Screenshots still match the app'),
      opt('Support team knows what changed'),
    ],
  },
];

export function defaultTemplate(id: string): DefaultChecklistTemplate | undefined {
  return DEFAULT_CHECKLIST_TEMPLATES.find((t) => t.id === id);
}

// Staged rollout steps and reminders (planning data only).
export * from './rollout-plan.ts';
