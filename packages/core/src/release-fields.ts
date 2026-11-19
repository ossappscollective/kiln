import { isApplePlatform, type Platform } from './platform.ts';
import type { StagedProblem } from './staged-changes.ts';

/**
 * Release fields (docs/api/releases-write.md, docs/adr/0014-release-management.md): what a person edits about a
 * DRAFT release before it is released, collected like a listing text (staged, pushed to the store as a draft) and
 * never sent to a store by staging. Pure: the field catalogue, how a value is normalized and checked, and the shapes
 * the API and the web app share. Nothing here talks to a store or to a database.
 *
 * ES2017 only: the web app imports this file.
 *
 * The per-locale "what's new" of an App Store version is NOT a field here: it is the existing listing field
 * `release_notes` (`APPLE_VERSION_LOCALIZATION_ATTRIBUTES`: `whatsNew`) and is staged with `PUT .../staged/text`.
 * Google Play's per-language release notes belong to the release (`Release.releaseNotes`), not to the listing, so
 * they are the field `release_notes` of this file (platform Android only).
 *
 * What is VERIFIED and what is not (Apple's and Google's pages, read 2026-11-19):
 * - Google (VERIFIED, https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks): a `Release` has
 *   `name`, `versionCodes[]`, `releaseNotes[]` (`LocalizedText`: `language`, `text`), `status` (`draft` "APKs are not
 *   served to users", `inProgress`, `halted`, `completed`) and `userFraction` ("0 < fraction < 1 ... can only be set
 *   when status is inProgress or halted"). So the intended share of a draft release cannot be stored in Play: it is
 *   kept here (`user_fraction`) and is only a suggestion for the release step, which needs an explicit share.
 * - Apple: the pages for the version resources are nearly empty. The names `releaseType` (MANUAL, AFTER_APPROVAL,
 *   SCHEDULED), `earliestReleaseDate`, `copyright`, `versionString`, the relationship `build` and the phased release
 *   resource are UNVERIFIED (they follow the read connector and Apple's articles). See docs/api/releases-write.md.
 * - Length limits that no official page states (Play release notes 500 characters a language, release name 50,
 *   copyright, version string) are WARNINGS, never errors: a wrong limit must not block a person.
 */

export const RELEASE_FIELD_IDS = [
  // App Store and Mac App Store (the editable version)
  'build',
  'version_string',
  'release_type',
  'earliest_release_date',
  'copyright',
  'phased_release',
  // Google Play (a draft release in one track)
  'track',
  'release_name',
  'version_codes',
  'user_fraction',
  'release_notes',
] as const;
export type ReleaseFieldId = (typeof RELEASE_FIELD_IDS)[number];

export const isReleaseFieldId = (value: string): value is ReleaseFieldId =>
  (RELEASE_FIELD_IDS as readonly string[]).indexOf(value) !== -1;

/** `releaseType` of an App Store version (names UNVERIFIED, see above). */
export const APPLE_RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] as const;
export type AppleReleaseType = (typeof APPLE_RELEASE_TYPES)[number];

export type ReleaseFieldSpec = {
  id: ReleaseFieldId;
  label: string;
  /** `apple` (iOS and macOS) or `google`. */
  family: 'apple' | 'google';
  /** One value per locale (per language): only Play release notes. */
  perLocale: boolean;
  /** The longest value, when a limit is known or assumed. */
  maxLength: number | null;
  /** True when no official page confirms the limit (a longer value is a warning). */
  limitUnverified: boolean;
  help: string;
};

export const RELEASE_FIELD_SPECS: Readonly<Record<ReleaseFieldId, ReleaseFieldSpec>> = {
  build: {
    id: 'build',
    label: 'Build',
    family: 'apple',
    perLocale: false,
    maxLength: 100,
    limitUnverified: false,
    help: 'The id of a processed build of this app (from the builds list). It is attached to the editable version.',
  },
  version_string: {
    id: 'version_string',
    label: 'Version',
    family: 'apple',
    perLocale: false,
    maxLength: 18,
    limitUnverified: true,
    help: 'The marketing version, for example 2.4.0: digits separated by dots.',
  },
  release_type: {
    id: 'release_type',
    label: 'Release',
    family: 'apple',
    perLocale: false,
    maxLength: null,
    limitUnverified: false,
    help: 'MANUAL (you release it after approval), AFTER_APPROVAL (released automatically) or SCHEDULED (needs an earliest release date).',
  },
  earliest_release_date: {
    id: 'earliest_release_date',
    label: 'Earliest release date',
    family: 'apple',
    perLocale: false,
    maxLength: null,
    limitUnverified: false,
    help: 'A date and time in the future (ISO 8601, UTC). It applies to a SCHEDULED release.',
  },
  copyright: {
    id: 'copyright',
    label: 'Copyright',
    family: 'apple',
    perLocale: false,
    maxLength: 200,
    limitUnverified: true,
    help: 'For example "2026 Acme Inc.".',
  },
  phased_release: {
    id: 'phased_release',
    label: 'Phased release',
    family: 'apple',
    perLocale: false,
    maxLength: null,
    limitUnverified: false,
    help: 'on: release to automatic updates over seven days. off: release to everyone at once.',
  },
  track: {
    id: 'track',
    label: 'Track',
    family: 'google',
    perLocale: false,
    maxLength: 100,
    limitUnverified: false,
    help: 'The track the draft release belongs to, for example production, beta or internal.',
  },
  release_name: {
    id: 'release_name',
    label: 'Release name',
    family: 'google',
    perLocale: false,
    maxLength: 50,
    limitUnverified: true,
    help: 'A name only you see (Play Console shows it next to the release).',
  },
  version_codes: {
    id: 'version_codes',
    label: 'Version codes',
    family: 'google',
    perLocale: false,
    maxLength: null,
    limitUnverified: false,
    help: 'The uploaded version codes of the release (comma separated), including codes you keep from earlier releases.',
  },
  user_fraction: {
    id: 'user_fraction',
    label: 'Intended rollout share',
    family: 'google',
    perLocale: false,
    maxLength: null,
    limitUnverified: false,
    help: 'The share of users you plan to start with (more than 0, at most 1). Google cannot hold it in a draft: it is only a suggestion for the release step.',
  },
  release_notes: {
    id: 'release_notes',
    label: 'Release notes',
    family: 'google',
    perLocale: true,
    maxLength: 500,
    limitUnverified: true,
    help: 'What is new, per language (Play Console shows 500 characters a language).',
  },
};

/** The fields each platform can stage. The App Store "what's new" is the listing field `release_notes` (staged as text). */
export const STAGEABLE_RELEASE_FIELDS: Readonly<Record<Platform, readonly ReleaseFieldId[]>> = {
  ios: [
    'build',
    'version_string',
    'release_type',
    'earliest_release_date',
    'copyright',
    'phased_release',
  ],
  macos: [
    'build',
    'version_string',
    'release_type',
    'earliest_release_date',
    'copyright',
    'phased_release',
  ],
  android: ['track', 'release_name', 'version_codes', 'user_fraction', 'release_notes'],
};

export const isStageableReleaseField = (platform: Platform, field: string): boolean =>
  (STAGEABLE_RELEASE_FIELDS[platform] as readonly string[]).indexOf(field) !== -1;

/** Fields that are kept only here and never sent to the store by a push (Play cannot hold a share in a draft). */
export const LOCAL_ONLY_RELEASE_FIELDS: readonly ReleaseFieldId[] = ['user_fraction'];

export const RELEASE_LIMITS = {
  /** Version codes in one release. */
  maxVersionCodes: 20,
  /** Languages of release notes in one release. */
  maxNoteLanguages: 80,
  /** A version code: Google caps it at 2100000000. */
  maxVersionCode: 2100000000,
} as const;

// ---------------------------------------------------------------------------------------------
// Normalizing

export type ReleaseValueInput = string | number | boolean | readonly string[];

/**
 * The canonical text of a value: what is stored, hashed and compared with the store's own value.
 * - `version_codes`: unique, ascending, comma separated (`240,241`);
 * - `user_fraction`: a plain decimal without trailing zeros (`0.1`);
 * - `earliest_release_date`: ISO 8601 in UTC without milliseconds (`2026-12-01T10:00:00Z`), or the input when it is not a date;
 * - `phased_release`: `on` or `off`; `release_type`: upper case;
 * - the rest: trimmed (line breaks of notes are normalized, trailing white space dropped).
 */
export function normalizeReleaseValue(field: ReleaseFieldId, raw: ReleaseValueInput): string {
  if (field === 'version_codes') {
    const parts =
      typeof raw === 'string'
        ? raw.split(/[\s,;]+/)
        : Array.isArray(raw)
          ? (raw as readonly string[]).map(String)
          : [String(raw)];
    const seen: Record<string, true> = {};
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const code = (parts[i] as string).trim();
      if (code === '' || seen[code]) continue;
      seen[code] = true;
      out.push(code);
    }
    out.sort((a, b) =>
      a.length !== b.length && /^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)
        ? a.length - b.length
        : a < b
          ? -1
          : a > b
            ? 1
            : 0,
    );
    return out.join(',');
  }
  const text = Array.isArray(raw) ? (raw as readonly string[]).join(',') : String(raw);
  if (field === 'user_fraction') {
    const n = Number(text.trim().replace(/%$/, ''));
    if (text.trim() === '' || !isFinite(n)) return text.trim();
    return String(text.trim().endsWith('%') ? Math.round(n * 100) / 10000 : n);
  }
  if (field === 'earliest_release_date') {
    const t = text.trim();
    const ms = Date.parse(t);
    if (
      t === '' ||
      isNaN(ms) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)
    )
      return t;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (field === 'phased_release') {
    const t = text.trim().toLowerCase();
    return t === 'true' || t === 'enabled' ? 'on' : t === 'false' || t === 'disabled' ? 'off' : t;
  }
  if (field === 'release_type') return text.trim().toUpperCase();
  if (field === 'release_notes')
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\n+|\n+$/g, '');
  return text.trim();
}

/** The version codes of a canonical `version_codes` value. */
export const versionCodesOf = (value: string): string[] => (value === '' ? [] : value.split(','));

// ---------------------------------------------------------------------------------------------
// Checking

const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
const VERSION_STRING = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const BUILD_ID = /^[A-Za-z0-9._-]{1,100}$/;
const TRACK = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;

const problem = (
  severity: StagedProblem['severity'],
  code: string,
  message: string,
  extra: Partial<StagedProblem> = {},
): StagedProblem => ({ severity, code, message, ...extra });

export type ReleaseFieldItem = { field: ReleaseFieldId; locale: string; value: string };

/**
 * The problems of ONE staged value (already normalized), from what is known without a store. Errors block a push,
 * warnings do not. `now` is epoch milliseconds (the date of a release must lie after it).
 */
export function checkReleaseField(
  platform: Platform,
  field: ReleaseFieldId,
  locale: string,
  value: string,
  now: number,
): StagedProblem[] {
  const out: StagedProblem[] = [];
  const spec = RELEASE_FIELD_SPECS[field];
  if (!isStageableReleaseField(platform, field)) {
    out.push(
      problem(
        'error',
        'field_not_stageable',
        `${spec.label} cannot be staged for ${isApplePlatform(platform) ? 'an App Store' : 'a Google Play'} app.`,
      ),
    );
    return out;
  }
  if (spec.perLocale) {
    if (!LANGUAGE.test(locale))
      out.push(problem('error', 'invalid_locale', 'The language must be a code such as en-US.'));
  } else if (locale !== '') {
    out.push(problem('error', 'invalid_locale', `${spec.label} has no language.`));
  }
  if (spec.maxLength !== null && value.length > spec.maxLength) {
    out.push(
      problem(
        spec.limitUnverified ? 'warning' : 'error',
        'too_long',
        `${spec.label} is ${value.length} characters; the limit is ${spec.maxLength}${spec.limitUnverified ? ' (UNVERIFIED: no official page states it, so this is only a warning)' : ''}.`,
        { limit: spec.maxLength, actual: value.length, unit: 'characters' },
      ),
    );
  }
  switch (field) {
    case 'build':
      if (!BUILD_ID.test(value))
        out.push(
          problem('error', 'invalid_build', 'A build is chosen by its id from the builds list.'),
        );
      break;
    case 'version_string':
      if (!VERSION_STRING.test(value))
        out.push(
          problem(
            'error',
            'invalid_version_string',
            'The version must be numbers separated by dots, up to three parts (for example 2.4.0).',
          ),
        );
      break;
    case 'release_type':
      if ((APPLE_RELEASE_TYPES as readonly string[]).indexOf(value) === -1)
        out.push(
          problem(
            'error',
            'invalid_release_type',
            'The release type is MANUAL, AFTER_APPROVAL or SCHEDULED.',
          ),
        );
      else if (value !== 'MANUAL') {
        out.push(
          problem(
            'warning',
            'submit_needs_manual',
            value === 'AFTER_APPROVAL'
              ? 'AFTER_APPROVAL releases the version to users by itself once Apple approves it. Submitting for review from this server stays blocked unless the release type is MANUAL (docs/adr/0010-store-submit.md).'
              : 'SCHEDULED releases the version by itself at the earliest release date after approval. Submitting for review from this server stays blocked unless the release type is MANUAL (docs/adr/0010-store-submit.md).',
          ),
        );
      }
      break;
    case 'earliest_release_date': {
      const ms = Date.parse(value);
      if (isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
        out.push(
          problem(
            'error',
            'invalid_date',
            'The date must be an ISO 8601 date and time, for example 2026-12-01T10:00:00Z.',
          ),
        );
      else if (ms <= now)
        out.push(
          problem('error', 'date_in_past', 'The earliest release date must lie in the future.'),
        );
      break;
    }
    case 'copyright':
      if (value === '')
        out.push(
          problem(
            'error',
            'empty_value',
            'The copyright cannot be empty: this server does not clear a store field.',
          ),
        );
      break;
    case 'phased_release':
      if (value !== 'on' && value !== 'off')
        out.push(problem('error', 'invalid_phased_release', 'Phased release is on or off.'));
      break;
    case 'track':
      if (!TRACK.test(value))
        out.push(
          problem(
            'error',
            'invalid_track',
            'A track name is letters, digits and _ : . - (for example production).',
          ),
        );
      break;
    case 'release_name':
      break;
    case 'version_codes': {
      const codes = versionCodesOf(value);
      if (codes.length === 0)
        out.push(problem('error', 'invalid_version_codes', 'Name at least one version code.'));
      if (codes.length > RELEASE_LIMITS.maxVersionCodes)
        out.push(
          problem(
            'error',
            'too_many_version_codes',
            `A release holds at most ${RELEASE_LIMITS.maxVersionCodes} version codes here.`,
            { limit: RELEASE_LIMITS.maxVersionCodes, actual: codes.length },
          ),
        );
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i] as string;
        if (
          !/^[0-9]{1,10}$/.test(code) ||
          Number(code) < 1 ||
          Number(code) > RELEASE_LIMITS.maxVersionCode
        ) {
          out.push(
            problem(
              'error',
              'invalid_version_codes',
              `${code.slice(0, 20)} is not a version code (a whole number from 1 to ${RELEASE_LIMITS.maxVersionCode}).`,
            ),
          );
          break;
        }
      }
      break;
    }
    case 'user_fraction': {
      const n = Number(value);
      if (value === '' || !isFinite(n) || n <= 0 || n > 1)
        out.push(
          problem(
            'error',
            'invalid_user_fraction',
            'The share must be more than 0 and at most 1 (for example 0.1 for 10%).',
          ),
        );
      else if (Math.round(n * 10000) / 10000 !== n)
        out.push(problem('error', 'invalid_user_fraction', 'The share has at most 4 decimals.'));
      break;
    }
    case 'release_notes':
      if (value === '')
        out.push(
          problem(
            'error',
            'empty_value',
            'Release notes cannot be empty: remove the item instead.',
          ),
        );
      break;
  }
  return out;
}

export const releaseItemKey = (field: string, locale: string): string => `${field}\u0000${locale}`;

/**
 * Problems that depend on other staged fields of the same app. Keys are `releaseItemKey`. What the store already holds
 * is NOT known here (the push preview checks it): these only say what is certainly incomplete among the staged items.
 */
export function checkReleaseSet(
  platform: Platform,
  items: readonly ReleaseFieldItem[],
): { [key: string]: StagedProblem[] } {
  const out: { [key: string]: StagedProblem[] } = {};
  const add = (key: string, p: StagedProblem) => {
    (out[key] = out[key] || []).push(p);
  };
  const find = (field: ReleaseFieldId): ReleaseFieldItem | undefined => {
    for (let i = 0; i < items.length; i++)
      if ((items[i] as ReleaseFieldItem).field === field) return items[i];
    return undefined;
  };
  if (isApplePlatform(platform)) {
    const type = find('release_type');
    const date = find('earliest_release_date');
    if (type && type.value === 'SCHEDULED' && !date) {
      add(
        releaseItemKey('release_type', ''),
        problem(
          'warning',
          'scheduled_needs_date',
          'SCHEDULED needs an earliest release date. Stage one, or the push is refused when the version has none.',
        ),
      );
    }
    if (date && type && type.value !== 'SCHEDULED') {
      add(
        releaseItemKey('earliest_release_date', ''),
        problem(
          'warning',
          'date_without_schedule',
          `The release type is staged as ${type.value}: the earliest release date has no effect unless it is SCHEDULED.`,
        ),
      );
    }
    return out;
  }
  const track = find('track');
  const others = items.filter((i) => i.field !== 'track');
  if (others.length > 0 && !track) {
    const first = others[0] as ReleaseFieldItem;
    add(
      releaseItemKey(first.field, first.locale),
      problem(
        'error',
        'track_required',
        'Stage the track this draft release belongs to (for example production).',
      ),
    );
  }
  let languages = 0;
  for (let i = 0; i < items.length; i++)
    if ((items[i] as ReleaseFieldItem).field === 'release_notes') languages++;
  if (languages > RELEASE_LIMITS.maxNoteLanguages) {
    add(
      releaseItemKey('release_notes', ''),
      problem(
        'error',
        'too_many_languages',
        `A release holds notes in at most ${RELEASE_LIMITS.maxNoteLanguages} languages.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the API shows

export type StagedReleaseFieldView = {
  id: string;
  kind: 'release_field';
  field: ReleaseFieldId;
  label: string;
  /** The language of a per-language field (Play release notes); empty otherwise. */
  locale: string;
  /** The canonical staged value. */
  value: string;
  valueHash: string;
  /** Kept only here, never sent to the store by a push (`user_fraction`). */
  localOnly: boolean;
  maxLength: number | null;
  status: 'changed' | 'invalid';
  problems: StagedProblem[];
  pushedAt: number | null;
  /** Pushed, and the staged value is still the one that was pushed. */
  pushed: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};
