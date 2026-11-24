import { timeAgo } from './format.ts';
import { formatDate, formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';
import { PLAY_CONSOLE_URL } from './store-links.ts';

/**
 * Store experiments and custom product pages of an app (docs/api/experiments.md, docs/adr/0048-store-experiments.md): the types of the API
 * answers, and the words, tones and addresses of the Experiments view, as pure functions. The server decides every rule; nothing here sends
 * anything. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const EXPERIMENT_STATES = [
  'draft',
  'in_review',
  'approved',
  'rejected',
  'completed',
  'stopped',
  'replaced',
  'unknown',
] as const;
export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

export type AssetCounts = {
  screenshots: number;
  previews: number;
  other: number;
  screenshotSets: number;
};

export type ExperimentLocale = {
  locale: string;
  ref: string;
  assets: AssetCounts;
  hasPromotionalText: boolean | null;
};

export type ExperimentTreatment = {
  id: string;
  name: string;
  iconName: string | null;
  promotedAt: number | null;
  locales: ExperimentLocale[];
};

export type StoreExperiment = {
  id: string;
  name: string;
  platform: string | null;
  state: ExperimentState;
  rawState: string | null;
  trafficProportion: number | null;
  reviewRequired: boolean | null;
  startsAt: number | null;
  endsAt: number | null;
  treatments: ExperimentTreatment[];
  syncedAt: number;
};

export type CustomPage = {
  id: string;
  name: string;
  state: ExperimentState;
  rawState: string | null;
  url: string | null;
  visible: boolean | null;
  deepLink: string | null;
  versions: {
    id: string;
    version: string | null;
    state: ExperimentState;
    rawState: string | null;
    deepLink: string | null;
  }[];
  locales: ExperimentLocale[];
  syncedAt: number;
};

export type ExperimentsSync = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  failures: number;
  experimentCount: number;
  pageCount: number;
  complete: boolean;
  warnings: string[];
};

export const NOTE_KINDS = ['experiment', 'custom_page'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_STATUSES = ['planned', 'running', 'finished', 'stopped'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export type ExperimentNote = {
  id: string;
  kind: NoteKind;
  name: string;
  status: NoteStatus;
  startedOn: string | null;
  endedOn: string | null;
  url: string | null;
  listing: string | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};

export type ExperimentsView = {
  app: { id: string; name: string; platform: string; store: string };
  api: boolean;
  experiments: StoreExperiment[];
  customPages: CustomPage[];
  sync: ExperimentsSync | null;
  notes: ExperimentNote[];
  limits: { notes: number };
};

export type ExperimentsSyncResult = {
  sync: {
    experiments: number;
    customPages: number;
    complete: boolean;
    warnings: string[];
    syncedAt: number;
  };
};

export type NoteInput = {
  kind: NoteKind;
  name: string;
  status: NoteStatus;
  startedOn: string | null;
  endedOn: string | null;
  url: string | null;
  listing: string | null;
  note: string;
};

export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info';

/** Where an experiment or a page version stands, as a word and a tone (never the tone alone). */
export function stateBadge(state: ExperimentState): { label: string; tone: Tone } {
  switch (state) {
    case 'approved':
      return { label: t('experiments:state.approved'), tone: 'ok' };
    case 'in_review':
      return { label: t('experiments:state.inReview'), tone: 'info' };
    case 'rejected':
      return { label: t('experiments:state.rejected'), tone: 'bad' };
    case 'draft':
      return { label: t('experiments:state.draft'), tone: 'neutral' };
    case 'completed':
      return { label: t('experiments:state.completed'), tone: 'neutral' };
    case 'stopped':
      return { label: t('experiments:state.stopped'), tone: 'warn' };
    case 'replaced':
      return { label: t('experiments:state.replaced'), tone: 'neutral' };
    default:
      return { label: t('experiments:state.unknown'), tone: 'neutral' };
  }
}

export const noteStatusBadge = (status: NoteStatus): { label: string; tone: Tone } => {
  switch (status) {
    case 'running':
      return { label: t('experiments:noteStatus.running'), tone: 'ok' };
    case 'finished':
      return { label: t('experiments:noteStatus.finished'), tone: 'neutral' };
    case 'stopped':
      return { label: t('experiments:noteStatus.stopped'), tone: 'warn' };
    default:
      return { label: t('experiments:noteStatus.planned'), tone: 'info' };
  }
};

export const noteKindLabel = (kind: NoteKind): string =>
  kind === 'custom_page'
    ? t('experiments:noteKind.customPage')
    : t('experiments:noteKind.experiment');

/** Whether an approved experiment is inside its dates (a hint: Apple's reference lists no running state). */
export const runningByDates = (
  e: Pick<StoreExperiment, 'state' | 'startsAt' | 'endsAt'>,
  now: number,
): boolean =>
  e.state === 'approved' &&
  e.startsAt !== null &&
  e.startsAt <= now &&
  (e.endsAt === null || e.endsAt > now);

/** "Started Oct 1, 2026", "Oct 1, 2026 to Dec 30, 2026", or "Not started". */
export function dateRangeText(e: Pick<StoreExperiment, 'startsAt' | 'endsAt'>): string {
  if (e.startsAt === null) return t('experiments:dates.notStarted');
  if (e.endsAt === null) return t('experiments:dates.since', { date: formatDate(e.startsAt) });
  return t('experiments:dates.range', { from: formatDate(e.startsAt), to: formatDate(e.endsAt) });
}

export const trafficText = (pct: number | null): string =>
  pct === null
    ? t('experiments:traffic.unknown')
    : t('experiments:traffic.percent', { percent: pct });

/** The media of a locale or of several, in words. */
export function assetsText(assets: AssetCounts): string {
  const parts: string[] = [];
  if (assets.screenshots > 0)
    parts.push(t('experiments:assets.screenshots', { count: assets.screenshots }));
  if (assets.previews > 0) parts.push(t('experiments:assets.previews', { count: assets.previews }));
  if (parts.length === 0 && assets.other > 0)
    parts.push(t('experiments:assets.other', { count: assets.other }));
  if (parts.length === 0 && assets.screenshotSets > 0)
    parts.push(t('experiments:assets.sets', { count: assets.screenshotSets }));
  return parts.length === 0 ? t('experiments:assets.none') : formatList(parts, { type: 'unit' });
}

export function sumAssets(locales: readonly ExperimentLocale[]): AssetCounts {
  const total: AssetCounts = { screenshots: 0, previews: 0, other: 0, screenshotSets: 0 };
  for (const l of locales) {
    total.screenshots += l.assets.screenshots;
    total.previews += l.assets.previews;
    total.other += l.assets.other;
    total.screenshotSets += l.assets.screenshotSets;
  }
  return total;
}

/** One line for a treatment: its icon name, its languages and its media. */
export function treatmentLine(treatment: ExperimentTreatment): string {
  const parts: string[] = [];
  if (treatment.iconName) parts.push(t('experiments:treatment.icon', { name: treatment.iconName }));
  parts.push(t('experiments:treatment.languages', { count: treatment.locales.length }));
  if (treatment.locales.length > 0) parts.push(assetsText(sumAssets(treatment.locales)));
  return parts.join(' · ');
}

/** The languages of a page: up to three by code, then a count. */
export function localesText(locales: readonly { locale: string }[]): string {
  if (locales.length === 0) return t('experiments:table.none');
  const codes = locales.map((l) => l.locale);
  if (codes.length <= 3) return formatList(codes, { type: 'unit' });
  return t('experiments:table.localesMore', {
    list: formatList(codes.slice(0, 3), { type: 'unit' }),
    count: codes.length - 3,
  });
}

/** The state of the last sync as one line and a tone. */
export function syncLine(
  sync: ExperimentsSync | null,
  now: number,
): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: t('experiments:sync.never'), tone: 'neutral' };
  if (sync.lastError !== null) {
    const error = sync.lastError;
    if (sync.lastSyncedAt === null)
      return { text: t('experiments:sync.failedNothing', { error }), tone: 'bad' };
    return {
      text: t('experiments:sync.failedKept', { ago: timeAgo(sync.lastSyncedAt, now), error }),
      tone: 'bad',
    };
  }
  const ago = timeAgo(sync.lastSyncedAt ?? now, now);
  if (!sync.complete) return { text: t('experiments:sync.partial', { ago }), tone: 'warn' };
  return { text: t('experiments:sync.read', { ago }), tone: 'neutral' };
}

const APP_STORE_CONNECT = 'https://appstoreconnect.apple.com';

/** The app's page in App Store Connect (its Product Page Optimization and custom product pages are one click away), or null without the Apple id. */
export function appStoreConnectUrl(storeAppId: string | null): string | null {
  const id = (storeAppId ?? '').trim();
  return /^\d+$/.test(id) ? `${APP_STORE_CONNECT}/apps/${id}` : null;
}

/** The public address of a Google Play custom store listing (Google's documented format), or null for a missing or invalid parameter. */
export function playListingUrl(packageName: string, listing: string | null): string | null {
  if (!listing || !/^[a-z0-9._~-]{1,100}$/.test(listing) || packageName.trim() === '') return null;
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&listing=${encodeURIComponent(listing)}`;
}

export { PLAY_CONSOLE_URL };

/** A date `YYYY-MM-DD` of a note, in the person's format. Built from its parts so the time zone never moves the day. */
export function noteDateText(value: string | null): string | null {
  if (value === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export type NoteProblems = Partial<
  Record<'name' | 'startedOn' | 'endedOn' | 'url' | 'listing' | 'note', string>
>;

/** The same checks the server makes, so a person is told before a round trip. */
export function validateNote(input: NoteInput): NoteProblems {
  const out: NoteProblems = {};
  const name = input.name.trim();
  if (name === '') out.name = t('experiments:validation.nameRequired');
  else if (name.length > 120) out.name = t('experiments:validation.nameLong');
  if (input.startedOn !== null && input.endedOn !== null && input.endedOn < input.startedOn) {
    out.endedOn = t('experiments:validation.datesOrder');
  }
  if (input.url !== null) {
    let ok = false;
    try {
      const u = new URL(input.url);
      ok = u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      ok = false;
    }
    if (!ok || input.url.length > 500) out.url = t('experiments:validation.url');
  }
  if (input.listing !== null && !/^[a-z0-9._~-]{1,100}$/.test(input.listing))
    out.listing = t('experiments:validation.listing');
  if (input.note.length > 2000) out.note = t('experiments:validation.noteLong');
  return out;
}
