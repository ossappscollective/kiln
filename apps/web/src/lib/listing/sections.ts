import {
  LEGACY_AGE_ANSWER,
  type ListingAgeRating,
  type ListingCategories,
  type ListingDetails,
  type ListingMedia,
  type ListingPrivacy,
  type ListingReleaseNotes,
  type ListingSectionName,
  type ListingSections,
  type MediaSet,
  normalizeCategory,
  type Platform,
  type SectionStatus,
  supports,
} from '@kiln/core';
import { timeAgo } from '../format.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { BadgeTone } from '../portfolio.ts';
import type { ListingSchedule, SectionDrift } from '../types.ts';

/**
 * The listing sections beyond the texts (categories, age rating, privacy choices URL, app details,
 * screenshots and previews, release notes), as the Listing tab shows them. Pure: the server sends
 * the values and the compare status; this turns them into rows and words. Everything here is
 * read-only: nothing is pulled into the repository, nothing is written to a store.
 */

/** Message keys: translate them where they are drawn (`t(READ_ONLY_NOTE)`). */
export const READ_ONLY_NOTE = k('listing:sections.note.readOnly');

export const PLAY_LIMITS_NOTE = k('listing:sections.note.playLimits');

// ---------------------------------------------------------------------------------------------
// Status

type StatusInfo = { label: string; tone: BadgeTone; explain: string };

/** Keys, translated by the accessors below. */
const STATUS: Record<SectionStatus, StatusInfo> = {
  identical: {
    label: k('listing:sections.status.identical'),
    tone: 'ok',
    explain: k('listing:sections.statusExplain.identical'),
  },
  differs: {
    label: k('listing:sections.status.differs'),
    tone: 'warn',
    explain: k('listing:sections.statusExplain.differs'),
  },
  'missing-in-repo': {
    label: k('listing:sections.status.missingInRepo'),
    tone: 'neutral',
    explain: k('listing:sections.statusExplain.missingInRepo'),
  },
  'missing-in-store': {
    label: k('listing:sections.status.missingInStore'),
    tone: 'neutral',
    explain: k('listing:sections.statusExplain.missingInStore'),
  },
  'not-comparable': {
    label: k('listing:sections.status.notComparable'),
    tone: 'neutral',
    explain: k('listing:sections.statusExplain.notComparable'),
  },
  'not-read': {
    label: k('listing:sections.status.notRead'),
    tone: 'neutral',
    explain: k('listing:sections.statusExplain.notRead'),
  },
};

export const sectionStatusLabel = (status: SectionStatus): string =>
  STATUS[status] ? t(STATUS[status].label) : status;
export const sectionStatusTone = (status: SectionStatus): BadgeTone =>
  STATUS[status]?.tone ?? 'neutral';
export const sectionStatusExplanation = (status: SectionStatus): string =>
  STATUS[status] ? t(STATUS[status].explain) : '';

/** Message keys by section; `sectionTitle` translates. */
export const SECTION_TITLES: Record<ListingSectionName, string> = {
  categories: k('listing:sections.title.categories'),
  ageRating: k('listing:sections.title.ageRating'),
  privacy: k('listing:sections.title.privacy'),
  details: k('listing:sections.title.details'),
  media: k('listing:sections.title.media'),
  releaseNotes: k('listing:sections.title.releaseNotes'),
  locales: k('listing:sections.title.locales'),
};

export const sectionTitle = (name: ListingSectionName): string =>
  SECTION_TITLES[name] ? t(SECTION_TITLES[name]) : name;

/** The sections in the order the tab shows them; a name this client does not know is kept last. */
export function orderedSections(sections: readonly SectionDrift[] | undefined): SectionDrift[] {
  const order = Object.keys(SECTION_TITLES);
  return [...(sections ?? [])].sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** How many sections have a store value, and how many of those differ: for a one-line summary. */
export function sectionsSummary(sections: readonly SectionDrift[] | undefined): string {
  const list = sections ?? [];
  if (list.length === 0) return t('listing:sections.summary.none');
  const read = list.filter((s) => s.compare.status !== 'not-read').length;
  const differ = list.filter((s) => s.compare.status === 'differs').length;
  if (read === 0) return t('listing:sections.summary.notRead');
  const base = t('listing:sections.summary.read', { read, total: list.length });
  return differ > 0
    ? formatList([base, t('listing:sections.summary.differ', { count: differ })], { type: 'unit' })
    : base;
}

// ---------------------------------------------------------------------------------------------
// Words

/** `FOOD_AND_DRINK` as "Food and drink"; the store's own id stays available as a tooltip. */
export function humanize(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase();
  return words === '' ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

const AGE_LABELS: Record<string, string> = {
  FOUR_PLUS: '4+',
  NINE_PLUS: '9+',
  TWELVE_PLUS: '12+',
  SEVENTEEN_PLUS: '17+',
  EIGHTEEN_PLUS: '18+',
};

/** The age rating label of the store ("4+"); a value this client does not know is humanized. */
export function ageRatingLabel(rating: string | undefined): string | null {
  if (rating === undefined || rating === '') return null;
  return AGE_LABELS[rating] ?? humanize(rating);
}

const answerText = (value: string | boolean | undefined): string | null => {
  if (value === undefined) return null;
  if (typeof value === 'boolean')
    return value ? t('listing:sections.answer.yes') : t('listing:sections.answer.no');
  return humanize(value);
};

/** Locale and device type labels. Unknown types are humanized, never dropped. */
export function deviceLabel(type: string): string {
  const phone = /^(?:APP_)?IPHONE_(\d)(\d)$/.exec(type);
  if (phone) return `iPhone ${phone[1]}.${phone[2]}"`;
  const pad =
    /^(?:APP_)?IPAD_(?:PRO_)?(?:\d?GEN_)?(\d{2,3})$/.exec(type) ??
    /^(?:APP_)?IPAD_PRO(?:_\dGEN)?_(\d{2,3})$/.exec(type);
  if (pad) {
    const size =
      (pad[1] ?? '').length === 3
        ? `${(pad[1] ?? '').slice(0, 2)}.${(pad[1] ?? '').slice(2)}`
        : (pad[1] ?? '');
    return `iPad Pro ${size}"`;
  }
  const play: Record<string, string> = {
    phoneScreenshots: k('listing:sections.device.phone'),
    sevenInchScreenshots: k('listing:sections.device.tablet7'),
    tenInchScreenshots: k('listing:sections.device.tablet10'),
    tvScreenshots: k('listing:sections.device.tv'),
    wearScreenshots: k('listing:sections.device.wear'),
    icon: k('listing:sections.device.icon'),
    featureGraphic: k('listing:sections.device.featureGraphic'),
    tvBanner: k('listing:sections.device.tvBanner'),
    promoGraphic: k('listing:sections.device.promoGraphic'),
    all: k('listing:sections.device.all'),
  };
  if (type === 'APP_DESKTOP') return 'Mac';
  const playKey = play[type];
  if (playKey) return t(playKey);
  return humanize(type.replace(/^APP_/, ''));
}

// ---------------------------------------------------------------------------------------------
// Rows: what the store has beside what the repository says

export type ValueRow = {
  label: string;
  /** The store's value; null: the store has none. */
  store: string | null;
  /** The repository's value; null: it has none, or cannot say. */
  repo: string | null;
  /** Both have a value and they disagree (by the same rule the server compares by). */
  differs: boolean;
  /** The store's own id or spelling, for a tooltip. */
  raw?: string;
};

const row = (
  label: string,
  store: string | null,
  repo: string | null,
  differs = false,
  raw?: string,
): ValueRow => ({
  label,
  store,
  repo,
  differs,
  ...(raw === undefined ? {} : { raw }),
});

const sameCategory = (a: string | undefined, b: string | undefined): boolean =>
  (a === undefined ? '' : normalizeCategory(a)) === (b === undefined ? '' : normalizeCategory(b));

export function categoryRows(
  store: ListingCategories | undefined,
  repo: ListingCategories | undefined,
): ValueRow[] {
  const get = (c: ListingCategories | undefined) =>
    [
      [t('listing:sections.row.primaryCategory'), c?.primary],
      [t('listing:sections.row.secondaryCategory'), c?.secondary],
      [t('listing:sections.row.primarySub', { n: 1 }), c?.primarySubcategories?.[0]],
      [t('listing:sections.row.primarySub', { n: 2 }), c?.primarySubcategories?.[1]],
      [t('listing:sections.row.secondarySub', { n: 1 }), c?.secondarySubcategories?.[0]],
      [t('listing:sections.row.secondarySub', { n: 2 }), c?.secondarySubcategories?.[1]],
    ] as const;
  const a = get(store);
  const b = get(repo);
  const rows: ValueRow[] = [];
  for (let i = 0; i < a.length; i++) {
    const [label, s] = a[i] as readonly [string, string | undefined];
    const r = (b[i] as readonly [string, string | undefined])[1];
    if (s === undefined && r === undefined) continue;
    rows.push(
      row(
        label,
        s === undefined ? null : humanize(s),
        r === undefined ? null : humanize(r),
        repo !== undefined && s !== undefined && r !== undefined && !sameCategory(s, r),
        s,
      ),
    );
  }
  return rows;
}

const legacy = (value: string | boolean | undefined): string | boolean | undefined =>
  typeof value === 'string' ? (LEGACY_AGE_ANSWER[value] ?? value) : value;

export function ageRatingRows(
  store: ListingAgeRating | undefined,
  repo: ListingAgeRating | undefined,
): ValueRow[] {
  const rows: ValueRow[] = [];
  const label = ageRatingLabel(store?.rating);
  if (label !== null)
    rows.push(row(t('listing:sections.row.rating'), label, null, false, store?.rating));
  const keys = [
    ...new Set([...Object.keys(store?.answers ?? {}), ...Object.keys(repo?.answers ?? {})]),
  ].sort();
  for (const key of keys) {
    const s = store?.answers[key];
    const r = repo?.answers[key];
    const differs = s !== undefined && r !== undefined && s !== legacy(r);
    rows.push(row(humanize(key), answerText(s), answerText(legacy(r)), differs, key));
  }
  return rows;
}

export function privacyRows(
  store: ListingPrivacy | undefined,
  repo: ListingPrivacy | undefined,
): ValueRow[] {
  const locales = [
    ...new Set([...Object.keys(store?.choicesUrls ?? {}), ...Object.keys(repo?.choicesUrls ?? {})]),
  ].sort();
  return locales.map((locale) => {
    const s = store?.choicesUrls[locale];
    const r = repo?.choicesUrls[locale];
    return row(
      locale,
      s ?? null,
      r ?? null,
      s !== undefined && r !== undefined && s.trim() !== r.trim(),
    );
  });
}

export function detailRows(
  store: ListingDetails | undefined,
  repo: ListingDetails | undefined,
): ValueRow[] {
  const fields = [
    ['copyright', t('listing:sections.row.copyright')],
    ['defaultLanguage', t('listing:sections.row.defaultLanguage')],
    ['contactEmail', t('listing:sections.row.contactEmail')],
    ['contactWebsite', t('listing:sections.row.contactWebsite')],
  ] as const;
  const rows: ValueRow[] = [];
  for (const [key, label] of fields) {
    const s = store?.[key];
    const r = repo?.[key];
    if (s === undefined && r === undefined) continue;
    rows.push(
      row(label, s ?? null, r ?? null, s !== undefined && r !== undefined && s.trim() !== r.trim()),
    );
  }
  return rows;
}

/** Rows for the sections that are a list of values. `media` and `releaseNotes` have their own shapes. */
export function valueRows(
  sectionName: ListingSectionName,
  store: unknown,
  repo: unknown,
): ValueRow[] {
  const s = (store ?? undefined) as ListingSections[ListingSectionName] | undefined;
  const r = (repo ?? undefined) as ListingSections[ListingSectionName] | undefined;
  switch (sectionName) {
    case 'categories':
      return categoryRows(s as ListingCategories | undefined, r as ListingCategories | undefined);
    case 'ageRating':
      return ageRatingRows(s as ListingAgeRating | undefined, r as ListingAgeRating | undefined);
    case 'privacy':
      return privacyRows(s as ListingPrivacy | undefined, r as ListingPrivacy | undefined);
    case 'details':
      return detailRows(s as ListingDetails | undefined, r as ListingDetails | undefined);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Media: counts per locale and device type

/** The kind of a media row: an identifier; `mediaKindLabel` says it in the reader's language. */
export type MediaKind = 'Screenshots' | 'Previews' | 'Graphics';

export const mediaKindLabel = (kind: MediaKind): string =>
  kind === 'Screenshots'
    ? t('listing:sections.media.kindScreenshots')
    : kind === 'Previews'
      ? t('listing:sections.media.kindPreviews')
      : t('listing:sections.media.kindGraphics');

export type MediaRow = {
  locale: string;
  kind: MediaKind;
  /** "iPhone 6.7"", "Phone", or "All device types" for a total. */
  device: string;
  /** The store's own id, for a tooltip. */
  type: string;
  store: number | null;
  repo: number | null;
  /** True for the row that is compared (an App Store locale total, or a Google Play image type). */
  compared: boolean;
  differs: boolean;
};

const setsOf = (map: Record<string, MediaSet[]> | undefined, locale: string): MediaSet[] =>
  map?.[locale] ?? [];
const total = (sets: readonly MediaSet[]) => sets.reduce((sum, set) => sum + set.count, 0);

/**
 * The counts per locale and device type. Counts only: the server never reads an image. App Store
 * folders of a repository do not say which device a file is for, so for an iOS app the compared
 * number is the total of the locale; an Android repository names the image type, so each type is
 * compared (the same rule as the server's `compareMedia`). `repo` null: the repository cannot say.
 */
export function mediaRows(
  store: ListingMedia | undefined,
  repo: ListingMedia | undefined,
  platform: Platform,
): MediaRow[] {
  if (store === undefined && repo === undefined) return [];
  const rows: MediaRow[] = [];
  const locales = [
    ...new Set([
      ...Object.keys(store?.screenshots ?? {}),
      ...Object.keys(store?.previews ?? {}),
      ...Object.keys(store?.graphics ?? {}),
      ...Object.keys(repo?.screenshots ?? {}),
      ...Object.keys(repo?.graphics ?? {}),
    ]),
  ].sort();
  const repoKnown = repo !== undefined;
  // The server calls a side with no media at all "not in the repository / not in the store", not a
  // difference: a count is only marked as different when both sides have some media.
  const everything = (m: ListingMedia | undefined) =>
    Object.values(m?.screenshots ?? {}).reduce((n, sets) => n + total(sets), 0) +
    (!supports(platform, 'screenshotsByDevice')
      ? Object.values(m?.graphics ?? {}).reduce((n, sets) => n + total(sets), 0)
      : 0);
  const bothHave = everything(store) > 0 && everything(repo) > 0;
  for (const locale of locales) {
    if (supports(platform, 'screenshotsByDevice')) {
      for (const set of setsOf(store?.screenshots, locale)) {
        rows.push({
          locale,
          kind: 'Screenshots',
          device: deviceLabel(set.type),
          type: set.type,
          store: set.count,
          repo: null,
          compared: false,
          differs: false,
        });
      }
      const s = total(setsOf(store?.screenshots, locale));
      const r = repoKnown ? total(setsOf(repo?.screenshots, locale)) : null;
      const storeHas = store !== undefined;
      if (storeHas || r !== null) {
        rows.push({
          locale,
          kind: 'Screenshots',
          device: t('listing:sections.device.all'),
          type: 'all',
          store: storeHas ? s : null,
          repo: r,
          compared: r !== null && storeHas,
          differs: r !== null && storeHas && bothHave && r !== s,
        });
      }
      for (const set of setsOf(store?.previews, locale)) {
        rows.push({
          locale,
          kind: 'Previews',
          device: deviceLabel(set.type),
          type: set.type,
          store: set.count,
          repo: null,
          compared: false,
          differs: false,
        });
      }
    } else {
      const types = new Map<
        string,
        { kind: 'Screenshots' | 'Graphics'; s: number | null; r: number | null }
      >();
      for (const set of setsOf(store?.screenshots, locale))
        types.set(`S:${set.type}`, { kind: 'Screenshots', s: set.count, r: repoKnown ? 0 : null });
      for (const set of setsOf(store?.graphics, locale))
        types.set(`G:${set.type}`, { kind: 'Graphics', s: set.count, r: repoKnown ? 0 : null });
      for (const set of setsOf(repo?.screenshots, locale)) {
        const cur = types.get(`S:${set.type}`) ?? {
          kind: 'Screenshots' as const,
          s: store === undefined ? null : 0,
          r: 0,
        };
        cur.r = set.count;
        types.set(`S:${set.type}`, cur);
      }
      for (const set of setsOf(repo?.graphics, locale)) {
        const cur = types.get(`G:${set.type}`) ?? {
          kind: 'Graphics' as const,
          s: store === undefined ? null : 0,
          r: 0,
        };
        cur.r = set.count;
        types.set(`G:${set.type}`, cur);
      }
      for (const [key, v] of [...types].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const type = key.slice(2);
        rows.push({
          locale,
          kind: v.kind,
          device: deviceLabel(type),
          type,
          store: v.s,
          repo: v.r,
          compared: v.s !== null && v.r !== null,
          differs: bothHave && v.s !== null && v.r !== null && v.s !== v.r,
        });
      }
    }
  }
  return rows;
}

/** "12 screenshots and 3 previews in 4 locales", for the header of the media block. */
export function mediaSummary(store: ListingMedia | undefined): string {
  if (store === undefined) return t('listing:sections.summary.notRead');
  const sum = (map: Record<string, MediaSet[]> | undefined) =>
    Object.values(map ?? {}).reduce((n, sets) => n + total(sets), 0);
  const screenshots = sum(store.screenshots);
  const previews = sum(store.previews);
  const graphics = sum(store.graphics);
  const locales = new Set([
    ...Object.keys(store.screenshots),
    ...Object.keys(store.previews ?? {}),
    ...Object.keys(store.graphics ?? {}),
  ]);
  const parts = [t('listing:sections.media.screenshots', { count: screenshots })];
  if (store.previews !== undefined)
    parts.push(t('listing:sections.media.previews', { count: previews }));
  if (store.graphics !== undefined)
    parts.push(t('listing:sections.media.graphics', { count: graphics }));
  const text = t('listing:sections.media.summary', {
    parts: formatList(parts, { type: 'unit' }),
    count: locales.size,
  });
  return store.truncated === true ? t('listing:sections.media.truncated', { text }) : text;
}

// ---------------------------------------------------------------------------------------------
// Release notes (Google Play)

export type ReleaseNoteRow = {
  track: string;
  meta: string;
  notes: { language: string; text: string }[];
};

const NOTE_CAP = 400;

export function releaseNoteRows(releaseNotes: ListingReleaseNotes | undefined): ReleaseNoteRow[] {
  if (!releaseNotes) return [];
  return Object.keys(releaseNotes.tracks)
    .sort()
    .map((track) => {
      const entry = releaseNotes.tracks[track] as ListingReleaseNotes['tracks'][string];
      const meta = [
        entry.name !== undefined && entry.name !== track ? entry.name : null,
        entry.status ? humanize(entry.status) : null,
        entry.versionCodes.length > 0
          ? t('listing:sections.notes.version', {
              codes: formatList(entry.versionCodes, { type: 'unit' }),
            })
          : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' · ');
      const notes = Object.keys(entry.notes)
        .sort()
        .map((language) => {
          const text = entry.notes[language] as string;
          return { language, text: text.length > NOTE_CAP ? `${text.slice(0, NOTE_CAP)}…` : text };
        });
      return { track, meta, notes };
    });
}

// ---------------------------------------------------------------------------------------------
// The scheduled read and the connector's warnings

export type ScheduleView = {
  state: 'unknown' | 'off' | 'on' | 'backing-off';
  headline: string;
  detail: string;
};

/** "Read automatically every hour", "... every 90 minutes", "... every 2 days": the interval as a person says it. */
export function intervalText(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1
      ? t('listing:sections.schedule.everyDay')
      : t('listing:sections.schedule.everyDays', { count: d });
  }
  if (minutes > 0 && minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1
      ? t('listing:sections.schedule.everyHour')
      : t('listing:sections.schedule.everyHours', { count: h });
  }
  return t('listing:sections.schedule.everyMinutes', { count: minutes });
}

export function scheduleView(schedule: ListingSchedule | undefined, now: number): ScheduleView {
  if (schedule === undefined) {
    return {
      state: 'unknown',
      headline: t('listing:sections.schedule.unknownHeadline'),
      detail: t('listing:sections.schedule.unknownDetail'),
    };
  }
  if (!schedule.enabled) {
    return {
      state: 'off',
      headline: t('listing:sections.schedule.offHeadline'),
      detail: t('listing:sections.schedule.offDetail'),
    };
  }
  const every = intervalText(schedule.intervalMinutes);
  const next =
    schedule.nextReadAt === null
      ? t('listing:sections.schedule.nextPass')
      : schedule.nextReadAt <= now
        ? t('listing:sections.schedule.nextPass')
        : timeAhead(schedule.nextReadAt, now);
  if (schedule.failures > 0) {
    return {
      state: 'backing-off',
      headline: every,
      detail: t('listing:sections.schedule.backoff', { count: schedule.failures, next }),
    };
  }
  return { state: 'on', headline: every, detail: t('listing:sections.schedule.next', { next }) };
}

/** "in 12 minutes", "in 3 hours": a future time, for the next scheduled read. */
export function timeAhead(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  if (seconds < 60) return t('listing:sections.ahead.underMinute');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('listing:sections.ahead.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('listing:sections.ahead.hours', { count: hours });
  const days = Math.round(hours / 24);
  return t('listing:sections.ahead.days', { count: days });
}

/** When the store listing was last attempted, for the status strip. */
export function lastAttemptText(schedule: ListingSchedule | undefined, now: number): string | null {
  const at = schedule?.lastAttemptAt;
  return at === null || at === undefined ? null : timeAgo(at, now);
}

const MAX_WARNINGS = 20;

/** The connector's warnings, without blanks and repeats, at most twenty. */
export function cleanWarnings(warnings: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of warnings ?? []) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_WARNINGS) break;
  }
  return out;
}
