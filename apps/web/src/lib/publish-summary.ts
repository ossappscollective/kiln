import {
  type AssetKind,
  kindHasDevice,
  localesMatch,
  type Platform,
  platformMeta,
  deviceLabel as storeDeviceLabel,
  supports,
} from '@kiln/core';
import { kindLabel } from './assets/assets.ts';
import { type BuiltReason, builtReason, type OriginFields, sameVersion } from './build-origin.ts';
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import {
  asPushPreview,
  asReleasePreview,
  asSubmitPreview,
  errorsOf,
  isDirectPlan,
  type PlanProblem,
  type PlanStep,
  type PublishPlan,
  type PublishStepType,
} from './pending.ts';
import { isReadinessProblem, type ReadinessView, readinessView } from './publish-readiness.ts';
import type { DraftPreview } from './staged.ts';
import { PLAY_CONSOLE_URL } from './store-links.ts';
import { percentText } from './store-release.ts';
import { testflightConsoleUrl } from './testflight.ts';

/**
 * "What will be published": the block at the top of the publish dialog that says WHAT goes out and WHERE, in plain words, before the
 * steps. A pure function of the plan the server already made (each step's own preview and summary), the steps that are ticked and, on
 * Google Play, the Track and Share fields while the release step is not added yet. It reads nothing and sends nothing, so it can
 * only say what the plan holds: a piece the plan does not carry is worded as such ("The build already in the draft"), never invented.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export type SummaryRow = {
  id: string;
  label: string;
  value: string;
  /** A quiet line under the value. */
  hint?: string | undefined;
  /** A short tag next to the value (for example "Not added yet"). */
  chip?: string | undefined;
  /** An identifier: shown in the monospace face. */
  mono?: boolean | undefined;
};

export type NotesPreview = {
  locale: string;
  /** The first lines of the text, each cut at `NOTE_LINE_CHARS`. */
  lines: string[];
  /** There is more than the lines show. */
  truncated: boolean;
  /** The text is empty. */
  empty: boolean;
  /** The whole text. */
  text: string;
};

/** The release notes of one language, as the push writes them. */
export type NoteEntry = { locale: string; text: string };

export type NotesDetail = {
  /** The text shown as a preview: the app's default language when the push has a text for it, else the first language with a text (null when there is none). */
  shown: NotesPreview | null;
  /** `shown` is the default language of the app. */
  shownIsDefault: boolean;
  /** The label of the preview: "Release notes (en-US, default)", or without "default" when it is not known to be one. */
  title: string;
  /** Why the shown language may not be the default one (a tooltip); null when there is nothing to say. */
  hint: string | null;
  /** The other languages, by name, each with its whole text (the chips open it). */
  others: { locale: string; empty: boolean; text: string }[];
};

/** Which kind of build the summary names, and which numbers (build number on Apple, version codes on Google Play). */
export type BuildFacts = {
  kind: 'apple' | 'play';
  platform: Platform;
  version: string | null;
  numbers: string[];
};

/** One changed listing text, as the push would write it (never the release notes, never a text that is unchanged). */
export type TextItem = {
  id: string;
  field: string;
  label: string;
  locale: string;
  /** The text the push writes. */
  after: string;
  excerpt: string;
  truncated: boolean;
  /** What the store holds now; null when the plan does not carry it (or the language is new). */
  before: string | null;
  beforeExcerpt: string | null;
  beforeTruncated: boolean;
  isNew: boolean;
};

export type TextDetail = { items: TextItem[]; more: number; total: number };

export type GraphicsFile = {
  key: string;
  name: string;
  oid: string;
  path: string;
  width: number | null;
  height: number | null;
  bytes: number;
};

/** One changed graphics set: a language, a kind and a device, with its files (as many as `GRAPHICS_FILES_SHOWN`). */
export type GraphicsItem = {
  id: string;
  locale: string;
  kind: AssetKind;
  title: string;
  files: GraphicsFile[];
  fileCount: number;
  moreFiles: number;
  willUpload: number;
  willRemove: number;
};

export type GraphicsDetail = { items: GraphicsItem[]; more: number; total: number };

export type PublishSummary = {
  rows: SummaryRow[];
  /** The release notes with the default language as the plan alone can tell it (nothing: the first language). */
  notes: NotesDetail | null;
  /** The notes of every language, to choose the preview again once the default language is known (`notesDetail`). */
  noteEntries: NoteEntry[];
  /** The build named by the summary, for its link and its date; null when no build is named. */
  build: BuildFacts | null;
  /** The staged texts and graphics of this push, for the two disclosures. */
  texts: TextDetail | null;
  graphics: GraphicsDetail | null;
  /** The app of the plan. */
  appId: string;
  /** "Nothing else is changed.", or why the staged changes are not part of this publish. */
  footnote: string | null;
  /** One plain sentence on what pressing Publish does, following the ticked steps. */
  outcome: string;
  /** No step is ticked: the outcome says so and the rows are kept to where it would go. */
  nothing: boolean;
  /**
   * Whether the draft could be submitted once the staged push is made: "Ready to submit for review", or "Submit would not run yet: N things to
   * fix" with the list, known before anything is sent. Null when the plan carries no readiness.
   */
  readiness: ReadinessView | null;
};

/** What the Track and Share fields hold while the release step is not part of the plan yet. */
export type TypedRelease = { track: string; fraction: number | null };

export type SummaryInput = {
  plan: PublishPlan;
  wanted: readonly PublishStepType[];
  /** The bundle id (iOS, macOS) or package name (Android) of the app record; '' when not known. */
  identifier: string;
  typed?: TypedRelease | null | undefined;
  /** The default language of the app (en-US); null or missing when it is not known (the preview then shows the first language). */
  defaultLocale?: string | null | undefined;
};

export const NOTE_LINES = 3;
export const NOTE_LINE_CHARS = 140;
/** Texts and graphics sets drawn in the disclosures; the rest is "and N more". */
export const DETAIL_ITEMS = 12;
/** Characters of a text before "Show full". */
export const TEXT_EXCERPT_CHARS = 200;
/** Thumbnails of one set. */
export const GRAPHICS_FILES_SHOWN = 6;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    const text = str(item);
    if (text !== null) out.push(text);
  }
  return out;
};
const codesOf = (text: string | null): string[] =>
  text === null
    ? []
    : text
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '');
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const summaryOf = (step: PlanStep | undefined): Record<string, unknown> =>
  step !== undefined && isObject(step.summary) ? step.summary : {};

const stepOf = (plan: PublishPlan, type: PublishStepType): PlanStep | undefined =>
  plan.steps.filter((s) => s.type === type)[0];

/** The first line of the texts of a step: the cut text of one language (first lines, each cut). */
export function notesPreview(locale: string, text: string): NotesPreview {
  const all = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  let cut = all.length > NOTE_LINES;
  const lines = all.slice(0, NOTE_LINES).map((line) => {
    if (line.length <= NOTE_LINE_CHARS) return line;
    cut = true;
    return `${line.slice(0, NOTE_LINE_CHARS).trimEnd()}…`;
  });
  return { locale, lines, truncated: cut, empty: all.length === 0, text };
}

type Note = NoteEntry;

/**
 * The release notes the push writes, per language: Play release
 * fields, or the App Store "What's new" listing text.
 */
function notesOf(push: DraftPreview | null, platform: Platform): Note[] {
  const out: Note[] = [];
  if (push === null) return out;
  const add = (locale: string, text: string): void => {
    const at = out.map((n) => n.locale).indexOf(locale);
    if (at >= 0) out[at] = { locale, text };
    else out.push({ locale, text });
  };
  if (supports(platform, 'releaseTracks')) {
    for (const r of push.release ?? []) if (r.field === 'release_notes') add(r.locale, r.after);
  } else {
    for (const x of push.text) if (x.field === 'release_notes') add(x.locale, x.after);
  }
  return out;
}

/** Languages that have other staged content in the push (text, graphics, release fields). */
function localesOf(push: DraftPreview | null): string[] {
  const out: string[] = [];
  if (push === null) return out;
  const add = (locale: string): void => {
    if (locale !== '' && out.indexOf(locale) < 0) out.push(locale);
  };
  for (const x of push.text) add(x.locale);
  for (const a of push.assets) add(a.locale);
  for (const r of push.release ?? []) add(r.locale);
  return out;
}

const fieldAfter = (push: DraftPreview | null, field: string): string | null => {
  if (push === null) return null;
  const hit = (push.release ?? []).filter((r) => r.field === field && r.locale === '')[0];
  return hit ? str(hit.after) : null;
};

const TEXT_LABEL: Readonly<Record<string, string>> = {
  name: k('listing:edit.label.name'),
  subtitle: k('listing:edit.label.subtitle'),
  description: k('listing:edit.label.description'),
  keywords: k('listing:edit.label.keywords'),
  promotional_text: k('listing:edit.label.promotionalText'),
  title: k('listing:edit.label.title'),
  short_description: k('listing:edit.label.shortDescription'),
  full_description: k('listing:edit.label.fullDescription'),
};

const textLabel = (field: string): string => {
  const key = TEXT_LABEL[field];
  return key === undefined ? field.replace(/_/g, ' ') : t(key);
};

/**
 * The text fields the push changes (never the release notes,
 * which have their own row), without repeats.
 */
function changedTextFields(push: DraftPreview): { count: number; labels: string[] } {
  const labels: string[] = [];
  let count = 0;
  for (const x of push.text) {
    if (x.field === 'release_notes' || x.status === 'unchanged') continue;
    count++;
    const label = textLabel(x.field);
    if (labels.indexOf(label) < 0) labels.push(label);
  }
  return { count, labels };
}

/** The graphics sets the push changes, counted by kind in words. */
function graphicsParts(push: DraftPreview): string[] {
  const counts = { screenshot: 0, icon: 0, feature: 0, other: 0 };
  for (const set of push.assets) {
    if (set.status === 'unchanged') continue;
    const kind = set.slot.kind;
    if (kind === 'screenshot') counts.screenshot++;
    else if (kind === 'icon' || kind === 'app_icon') counts.icon++;
    else if (kind === 'feature_graphic') counts.feature++;
    else counts.other++;
  }
  const parts: string[] = [];
  if (counts.screenshot > 0)
    parts.push(t('publish:summary.graphics.screenshot', { count: counts.screenshot }));
  if (counts.icon > 0) parts.push(t('publish:summary.graphics.icon', { count: counts.icon }));
  if (counts.feature > 0)
    parts.push(t('publish:summary.graphics.feature', { count: counts.feature }));
  if (counts.other > 0) parts.push(t('publish:summary.graphics.other', { count: counts.other }));
  return parts;
}

/**
 * The release notes to show: the preview of the default language of the app when the push has a text for it, else the first language
 * with a text, said plainly ("the first language is shown") when the default language is not known or has no text here.
 * Pure: the same notes and default language always give the same words.
 */
export function notesDetail(
  entries: readonly NoteEntry[],
  defaultLocale: string | null | undefined,
): NotesDetail | null {
  if (entries.length === 0) return null;
  const wanted = defaultLocale === undefined || defaultLocale === null ? '' : defaultLocale.trim();
  const filled = entries.filter((n) => n.text.trim() !== '');
  const ofDefault =
    wanted === '' ? undefined : filled.filter((n) => localesMatch(n.locale, wanted))[0];
  const picked = ofDefault ?? filled[0];
  let hint: string | null = null;
  if (picked !== undefined && ofDefault === undefined) {
    if (wanted !== '')
      hint = t('publish:summary.notes.hintNoDefault', { default: wanted, locale: picked.locale });
    else if (entries.length > 1) hint = t('publish:summary.notes.hintUnknown');
  }
  const title =
    picked === undefined
      ? t('publish:summary.row.notes')
      : ofDefault !== undefined
        ? t('publish:summary.notes.titleDefault', { locale: picked.locale })
        : t('publish:summary.notes.titleLocale', { locale: picked.locale });
  return {
    shown: picked ? notesPreview(picked.locale, picked.text) : null,
    shownIsDefault: ofDefault !== undefined,
    title,
    hint,
    others: entries
      .filter((n) => !picked || n.locale !== picked.locale)
      .map((n) => ({ locale: n.locale, empty: n.text.trim() === '', text: n.text })),
  };
}

/** A text cut at `max` characters (on a word when it can), with "..." when something was cut. */
export function cutText(
  text: string,
  max: number = TEXT_EXCERPT_CHARS,
): { excerpt: string; cut: boolean } {
  const clean = text.trim();
  if (clean.length <= max) return { excerpt: clean, cut: false };
  const head = clean.slice(0, max);
  const space = head.lastIndexOf(' ');
  const base = space > max * 0.6 ? head.slice(0, space) : head;
  return { excerpt: `${base.trimEnd()}…`, cut: true };
}

/**
 * The listing texts the push changes, one item per field and language (never the release notes, which have their own row, and never a
 * text that is the same as in the store), at most `limit` of them; the rest is counted in `more`. null when there is no push.
 */
export function textDetail(
  push: DraftPreview | null,
  limit: number = DETAIL_ITEMS,
): TextDetail | null {
  if (push === null) return null;
  const all: TextItem[] = [];
  for (const x of push.text) {
    if (x.field === 'release_notes' || x.status === 'unchanged') continue;
    const after = cutText(x.after);
    const before = x.before === null || x.before === undefined ? null : cutText(x.before);
    all.push({
      id: x.id,
      field: x.field,
      label: textLabel(x.field),
      locale: x.locale,
      after: x.after,
      excerpt: after.excerpt,
      truncated: after.cut,
      before: before === null ? null : x.before,
      beforeExcerpt: before === null ? null : before.excerpt,
      beforeTruncated: before === null ? false : before.cut,
      isNew: x.status === 'new_locale',
    });
  }
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit), total: all.length };
}

/**
 * The graphics sets the push changes, one item per language, kind and device with its files (as many as `GRAPHICS_FILES_SHOWN`), at most
 * `limit` sets; the rest is counted in `more`. null when there is no push. A set the plan carries without its files has none listed.
 */
export function graphicsDetail(
  push: DraftPreview | null,
  limit: number = DETAIL_ITEMS,
): GraphicsDetail | null {
  if (push === null) return null;
  const store = supports(push.app.platform, 'releaseTracks') ? 'google_play' : 'app_store';
  const all: GraphicsItem[] = [];
  for (const set of push.assets) {
    if (set.status === 'unchanged') continue;
    const kind = set.slot.kind;
    const device = kindHasDevice(kind) ? storeDeviceLabel(store, set.slot.device) : '';
    const files = (set.after?.files ?? []).map((f, i) => ({
      key: `${set.id}#${i}`,
      name: f.name,
      oid: f.oid,
      path: f.path,
      width: f.width ?? null,
      height: f.height ?? null,
      bytes: f.bytes ?? 0,
    }));
    all.push({
      id: set.id,
      locale: set.locale,
      kind,
      title:
        device === ''
          ? kindLabel(kind)
          : t('publish:summary.graphics.setTitle', { kind: kindLabel(kind), device }),
      files: files.slice(0, GRAPHICS_FILES_SHOWN),
      fileCount: files.length,
      moreFiles: Math.max(0, files.length - GRAPHICS_FILES_SHOWN),
      willUpload: set.willUpload ?? 0,
      willRemove: set.willRemove ?? 0,
    });
  }
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit), total: all.length };
}

export type BuildLink = {
  href: string;
  /** The visible words. */
  text: string;
  /** The accessible name. */
  label: string;
  /** What the link really opens (a tooltip), so a generic page is never passed off as the page of the build. */
  title: string;
};

const APP_STORE_CONNECT_APPS = 'https://appstoreconnect.apple.com/apps';

/**
 * Where to look at the build in the store's console. Google Play: the Console itself, because its pages need the developer account id
 * and the numeric app id, which Google Play's API does not give (the app bundle explorer is one click away). App Store Connect: the
 * app's TestFlight page when the Apple app id is known (its builds are listed there), else the list of the apps. Pure.
 */
export function buildLink(facts: BuildFacts, storeAppId: string | null | undefined): BuildLink {
  const builds = facts.numbers.join(', ');
  if (facts.kind === 'play') {
    return {
      href: PLAY_CONSOLE_URL,
      text: t('publish:summary.build.link.play'),
      label:
        builds === ''
          ? t('publish:summary.build.link.playLabelPlain')
          : t('publish:summary.build.link.playLabel', { builds }),
      title: t('publish:summary.build.link.playTitle'),
    };
  }
  const direct = testflightConsoleUrl(storeAppId ?? null);
  return {
    href: direct ?? APP_STORE_CONNECT_APPS,
    text: t('publish:summary.build.link.apple'),
    label:
      builds === ''
        ? t('publish:summary.build.link.appleLabelPlain')
        : t('publish:summary.build.link.appleLabel', { builds }),
    title:
      direct === null
        ? t('publish:summary.build.link.appleTitleApps')
        : t('publish:summary.build.link.appleTitle'),
  };
}

/** When the build was made, as far as the ONE read of the builds says (`origin` of each store row: server join of store, CI and release facts). */
export type BuildDate =
  | { state: 'known'; at: number }
  /** Google Play with nothing that dates the code (no CI file, no reason sent): its API lists version codes and tracks only. */
  | { state: 'notProvided' }
  /** No date for the build; `reason` is the server's reason (reads disabled, file gone, not read ...), null when it sent none. */
  | { state: 'notRead'; reason: BuiltReason | null };

/**
 * The date of the build of the summary. `stored` is the list of the store builds of the app as the builds read returns them with their
 * `origin` (`GET builds/artifacts`, the same rows the Test builds page and the release candidates show), or null when it was not read
 * (then nothing is known and null is returned, so nothing is shown). The date is the origin's (`builtAt`: the CI file's or the store's
 * own), so a Google Play code built by a CI run gets its date here like everywhere else. Pure.
 */
export function buildDate(
  facts: BuildFacts | null,
  stored:
    | readonly {
        platform: Platform;
        buildNumber: string;
        version?: string | null | undefined;
        uploadedAt: number | null;
        origin?: OriginFields | undefined;
      }[]
    | null,
): BuildDate | null {
  if (facts === null) return null;
  if (stored === null || facts.numbers.length === 0) return null;
  const mine = stored.filter(
    (b) => b.platform === facts.platform && facts.numbers.indexOf(b.buildNumber) >= 0,
  );
  const same = mine.filter(
    (b) => facts.version === null || b.version == null || sameVersion(b.version, facts.version),
  );
  const rows = same.length > 0 ? same : mine;
  const atOf = (b: (typeof rows)[number]): number | null => {
    const at = b.origin?.builtAt ?? b.uploadedAt;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  };
  let newest: number | null = null;
  for (const b of rows) {
    const at = atOf(b);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  if (newest !== null) return { state: 'known', at: newest };
  const withReason = rows.filter((b) => b.origin !== undefined)[0];
  const reason = withReason?.origin ? builtReason(withReason.origin) : null;
  if (reason !== null) return { state: 'notRead', reason };
  return facts.kind === 'play' ? { state: 'notProvided' } : { state: 'notRead', reason: null };
}

/**
 * Who gets it, in words ("100% of users", "Phased over seven
 * days"); null when the plan does not say.
 */
function audienceText(
  platform: Platform,
  kind: string | null,
  fraction: number | null,
): string | null {
  if (supports(platform, 'releaseTracks')) {
    const share = fraction ?? (kind === 'all' ? 1 : null);
    return share === null
      ? null
      : t('publish:summary.audience.percent', { share: percentText(share) });
  }
  if (kind === 'phased') return t('publish:summary.audience.phased');
  if (kind === 'all') return t('publish:summary.audience.everyone');
  return null;
}

/**
 * The problems of a step that are shown now: the prompt for a track or
 * a share waits until the person touched those fields.
 */
export const INPUT_PROMPT_CODES: readonly string[] = ['track_required', 'user_fraction_required'];

export function shownErrors(
  step: Pick<PlanStep, 'availability' | 'problems'>,
  inputTouched: boolean,
): PlanProblem[] {
  return errorsOf(step).filter(
    (p) =>
      // The blockers of a submit that cannot run are listed once, in the readiness section, not again under the step.
      !isReadinessProblem(p.code) &&
      (inputTouched || step.availability !== 'needs_input' || INPUT_PROMPT_CODES.indexOf(p.code) < 0),
  );
}

const joinThen = (parts: readonly string[]): string =>
  parts
    .slice(1)
    .reduce((before, next) => t('publish:summary.outcome.then', { before, next }), parts[0] ?? '');

/**
 * The summary of a plan for the ticked steps. Pure: the same
 * plan, ticks and fields always give the same words.
 */
export function publishSummary(input: SummaryInput): PublishSummary {
  const { plan, identifier } = input;
  const wanted = input.wanted;
  const platform = plan.app.platform;
  const meta = platformMeta(platform);
  const play = supports(platform, 'releaseTracks');
  const has = (type: PublishStepType): boolean => wanted.indexOf(type) >= 0;
  const direct = isDirectPlan(plan);

  // The combined step (Google Play: push and send for review in one commit) writes what a push writes, so it is read like the push.
  const combined = has('push_and_submit');
  const hasPush = has('push_draft') || combined;
  const pushStep = stepOf(plan, combined ? 'push_and_submit' : 'push_draft');
  const submitStep = stepOf(plan, 'submit');
  const releaseStep = stepOf(plan, 'release');
  const push = asPushPreview(pushStep?.preview);
  const submit = asSubmitPreview(submitStep?.preview);
  const release = asReleasePreview(releaseStep?.preview);
  const pushed = hasPush ? push : null;
  const releaseSummary = summaryOf(releaseStep);
  const submitSummary = summaryOf(submitStep);
  const releaseOn = has('release') && releaseStep?.included === true;

  const rows: SummaryRow[] = [];
  rows.push({
    id: 'app',
    label: t('publish:summary.row.app'),
    value: plan.app.name,
  });
  rows.push({
    id: 'destination',
    label: t('publish:summary.row.destination'),
    value: t('publish:summary.destination.value', { store: meta.storeName, platform: meta.label }),
  });
  if (identifier !== '')
    rows.push({
      id: 'identifier',
      label: play ? t('publish:summary.row.packageName') : t('publish:summary.row.bundleId'),
      value: identifier,
      mono: true,
    });

  // Where it goes: the Google Play track and the share of
  // users, or the App Store submission and phased release.
  let track: string | null = null;
  let fraction: number | null = null;
  let kind: string | null = null;
  let notAdded = false;
  if (play) {
    const staged = fieldAfter(pushed, 'track') ?? plan.direct?.track ?? null;
    if (releaseOn) {
      track = str(releaseSummary.track) ?? release?.track ?? staged;
      fraction = num(releaseSummary.userFraction);
      kind = str(releaseSummary.audience) ?? release?.audience.kind ?? null;
    } else if (input.typed) {
      track = str(input.typed.track) ?? staged;
      fraction = input.typed.fraction;
      kind = fraction === 1 ? 'all' : null;
      notAdded = true;
    } else if (hasPush) {
      track = staged;
    }
    if (track !== null) {
      const audience = audienceText(platform, kind, fraction);
      rows.push({
        id: 'track',
        label: t('publish:summary.row.track'),
        value:
          audience === null
            ? capitalized(track)
            : t('publish:summary.track.value', { track: capitalized(track), audience }),
        hint: notAdded
          ? t('publish:summary.track.notAddedHint')
          : audience === null && releaseOn
            ? t('publish:summary.track.noShareHint')
            : undefined,
        chip: notAdded ? t('publish:summary.notAdded') : undefined,
      });
    }
  }

  // Version and build, with the version code or the build number when the plan carries it.
  const appleVersion =
    str(submitSummary.versionString) ??
    str(releaseSummary.version) ??
    submit?.version?.versionString ??
    push?.version?.versionString ??
    release?.version?.versionString ??
    fieldAfter(pushed, 'version_string');
  let build: BuildFacts | null = null;
  if (play) {
    const name =
      (releaseOn ? (release?.direct?.name ?? release?.release?.name ?? null) : null) ??
      fieldAfter(pushed, 'release_name') ??
      str(release?.release?.name) ??
      null;
    const codes = (() => {
      const fromPlan = strings(releaseSummary.versionCodes);
      if (releaseOn && fromPlan.length > 0) return fromPlan;
      const fromRelease = release?.direct?.versionCodes ?? release?.release?.versionCodes ?? [];
      if (releaseOn && fromRelease.length > 0) return fromRelease;
      const staged = codesOf(fieldAfter(pushed, 'version_codes'));
      if (staged.length > 0) return staged;
      if (release?.release && release.release.versionCodes.length > 0)
        return release.release.versionCodes;
      return plan.direct?.versionCodes ?? [];
    })();
    let value: string;
    const from = str(plan.promotion?.from);
    const promotedVersion = str(plan.promotion?.version);
    if (
      releaseOn &&
      (direct || plan.oneCommit === true) &&
      from !== null &&
      track !== null &&
      codes.length > 0
    )
      // A build that is in another track and is released here: said as a promotion, with its version when the plan carries it.
      value =
        promotedVersion !== null
          ? t('publish:summary.release.promote', {
              count: codes.length,
              codes: codes.join(', '),
              version: promotedVersion,
              from,
              to: track,
            })
          : t('publish:summary.release.promoteNoVersion', {
              count: codes.length,
              codes: codes.join(', '),
              from,
              to: track,
            });
    else if (name !== null && codes.length > 0)
      value = t('publish:summary.release.nameCodes', { name, codes: codes.join(', ') });
    else if (codes.length > 0)
      value = t('publish:summary.release.codes', { count: codes.length, codes: codes.join(', ') });
    else if (name !== null) value = name;
    else value = t('publish:summary.release.inDraft');
    rows.push({ id: 'release', label: t('publish:summary.row.release'), value });
    build = { kind: 'play', platform, version: name, numbers: codes };
  } else {
    rows.push({
      id: 'version',
      label: t('publish:summary.row.version'),
      value: appleVersion ?? t('publish:summary.version.inDraft'),
    });
    const stagedBuild = fieldAfter(pushed, 'build');
    const number = str(submit?.build?.version) ?? str(release?.build?.buildNumber);
    const loadedWithoutBuild =
      (submit !== null && submit.build === null) || (release !== null && release.build === null);
    build = {
      kind: 'apple',
      platform,
      version: appleVersion,
      numbers: number === null ? [] : [number],
    };
    rows.push({
      id: 'build',
      label: t('publish:summary.row.build'),
      value:
        number !== null
          ? number
          : stagedBuild !== null
            ? t('publish:summary.build.staged')
            : loadedWithoutBuild && stagedBuild === null
              ? t('publish:summary.build.notChosen')
              : t('publish:summary.build.inDraft'),
    });
  }

  if (has('submit') || combined) {
    rows.push({
      id: 'review',
      label: t('publish:summary.row.review'),
      value: play
        ? combined
          ? plan.oneCommit === true
            ? t('publish:summary.review.playOneCommit')
            : t('publish:summary.review.playCombined')
          : t('publish:summary.review.play')
        : appleVersion !== null
          ? t('publish:summary.review.apple', { version: appleVersion })
          : t('publish:summary.review.appleNoVersion'),
    });
  } else if (play && releaseOn && direct) {
    rows.push({
      id: 'review',
      label: t('publish:summary.row.review'),
      value: t('publish:summary.review.playDirect'),
    });
  }

  if (!play) {
    const phasedField = fieldAfter(pushed, 'phased_release');
    const phased =
      phasedField !== null
        ? phasedField === 'on'
        : release?.phasedRelease
          ? true
          : release !== null && releaseOn
            ? release.audience.kind === 'phased'
            : null;
    if (phased !== null)
      rows.push({
        id: 'phased',
        label: t('publish:summary.row.phased'),
        value: phased ? t('publish:summary.phased.on') : t('publish:summary.phased.off'),
      });
  }

  // The release notes that go out.
  const notes = notesOf(pushed, platform);
  const detail = notesDetail(notes, input.defaultLocale ?? null);
  const missing: string[] = [];
  for (const n of notes) if (n.text.trim() === '') missing.push(n.locale);
  if (play && notes.some((n) => n.text.trim() !== '')) {
    for (const locale of localesOf(pushed))
      if (notes.map((n) => n.locale).indexOf(locale) < 0) missing.push(locale);
  }
  const known = notes.filter((n) => n.text.trim() !== '').length;
  const draftLanguages = release?.direct?.notesLanguages.length ?? release?.release?.notes ?? 0;
  const languages =
    pushed !== null ? known : strings(releaseSummary.notesLanguages).length || draftLanguages;
  let missingHint: string | undefined;
  if (missing.length > 0) {
    const shownLocales = missing.slice(0, 3);
    missingHint =
      missing.length > 3
        ? t('publish:summary.notes.missingMore', {
            locales: formatList(shownLocales),
            count: missing.length - 3,
          })
        : t('publish:summary.notes.missing', { locales: formatList(shownLocales) });
  }
  if (pushed !== null || languages > 0 || (releaseOn && play)) {
    rows.push({
      id: 'notes',
      label: t('publish:summary.row.notes'),
      value:
        languages > 0
          ? t('publish:summary.notes.languages', { count: languages })
          : t('publish:summary.notes.none'),
      hint:
        missingHint ??
        (pushed === null && languages > 0 ? t('publish:summary.notes.fromDraft') : undefined),
    });
  }

  // The assets and texts of the push, as step 1 counts them.
  let footnote: string | null = null;
  if (pushed !== null) {
    const text = changedTextFields(pushed);
    rows.push({
      id: 'text',
      label: t('publish:summary.row.text'),
      value:
        text.count === 0
          ? t('publish:summary.text.none')
          : t('publish:summary.text.changes', {
              count: text.count,
              fields: formatList(text.labels),
            }),
    });
    const graphics = graphicsParts(pushed);
    rows.push({
      id: 'graphics',
      label: t('publish:summary.row.graphics'),
      value:
        graphics.length === 0
          ? t('publish:summary.graphics.none')
          : formatList(graphics, { type: 'unit' }),
    });
    const fields = pushed.summary.fieldsChanged ?? 0;
    if (fields > 0)
      rows.push({
        id: 'fields',
        label: t('publish:summary.row.fields'),
        value: t(k('app:pending.summary.releaseFields'), { count: fields }),
      });
    footnote = t('publish:summary.nothingElse');
  } else if (pushStep?.included === true) {
    footnote = t('publish:summary.notPushed');
  }

  return {
    rows,
    notes: detail,
    noteEntries: notes,
    build,
    texts: textDetail(pushed),
    graphics: graphicsDetail(pushed),
    appId: plan.app.id,
    footnote,
    outcome: outcomeText({ plan, wanted, play, direct, track, fraction, kind, appleVersion }),
    nothing: wanted.length === 0,
    readiness: readinessView(plan),
  };
}

/** One sentence on what pressing Publish does, from the ticked steps only (never a step that is not ticked). */
function outcomeText(input: {
  plan: PublishPlan;
  wanted: readonly PublishStepType[];
  play: boolean;
  direct: boolean;
  track: string | null;
  fraction: number | null;
  kind: string | null;
  appleVersion: string | null;
}): string {
  const { wanted, play, direct, track, appleVersion } = input;
  if (wanted.length === 0) return t('publish:summary.outcome.nothing');
  const has = (type: PublishStepType): boolean => wanted.indexOf(type) >= 0;
  const releaseStep = stepOf(input.plan, 'release');
  const summary = summaryOf(releaseStep);
  const audience = audienceText(
    input.plan.app.platform,
    input.kind ?? str(summary.audience),
    input.fraction,
  );
  const where = track === null ? null : capitalized(track);
  const clauses: string[] = [];
  // ONE edit, ONE commit: the texts, the graphics and the release are one action, never "pushes ... then rolls out a draft".
  const oneCommit = input.plan.oneCommit === true && has('push_and_submit') && has('release');
  if (oneCommit) {
    clauses.push(
      where !== null && audience !== null
        ? t('publish:summary.outcome.oneCommit', { track: where, audience })
        : where !== null
          ? t('publish:summary.outcome.oneCommitTrack', { track: where })
          : t('publish:summary.outcome.oneCommitPlain'),
    );
  } else if (has('push_and_submit')) {
    // One commit: Google Play sends what is pushed for review as part of it. Said as it is, never as a draft.
    clauses.push(t('publish:summary.outcome.pushSubmitPlay'));
  } else if (has('push_draft')) {
    if (play) clauses.push(t('publish:summary.outcome.pushPlay'));
    else clauses.push(t('publish:summary.outcome.pushApple'));
  }
  if (has('submit')) {
    if (play) clauses.push(t('publish:summary.outcome.submitPlay'));
    else if (appleVersion !== null)
      clauses.push(t('publish:summary.outcome.submitApple', { version: appleVersion }));
    else clauses.push(t('publish:summary.outcome.submitAppleNoVersion'));
  }
  const promotedFrom = str(input.plan.promotion?.from);
  if (has('release') && !oneCommit) {
    if (play && direct && promotedFrom !== null && track !== null) {
      // One step: the build is made a release of the target track and committed, which sends it to Google for review.
      clauses.push(
        // Everybody is the plain sentence; only a staged share is named.
        audience !== null && input.kind !== 'all' && input.fraction !== 1
          ? t('publish:summary.outcome.promoteAudience', { track, audience })
          : t('publish:summary.outcome.promote', { track }),
      );
    } else if (play && direct) {
      if (where !== null && audience !== null)
        clauses.push(t('publish:summary.outcome.sendPlay', { track: where, audience }));
      else if (where !== null)
        clauses.push(t('publish:summary.outcome.sendPlayTrack', { track: where }));
      else clauses.push(t('publish:summary.outcome.sendPlayPlain'));
    } else if (play) {
      if (where !== null && audience !== null)
        clauses.push(t('publish:summary.outcome.releasePlay', { track: where, audience }));
      else if (where !== null)
        clauses.push(t('publish:summary.outcome.releasePlayTrack', { track: where }));
      else clauses.push(t('publish:summary.outcome.releasePlayPlain'));
    } else if (appleVersion !== null && audience !== null) {
      clauses.push(t('publish:summary.outcome.releaseApple', { version: appleVersion, audience }));
    } else if (appleVersion !== null) {
      clauses.push(t('publish:summary.outcome.releaseAppleVersion', { version: appleVersion }));
    } else {
      clauses.push(t('publish:summary.outcome.releaseApplePlain'));
    }
  }
  if (has('rollout')) clauses.push(t('publish:summary.outcome.rollout'));
  const sentence = t('publish:summary.outcome.sentence', { actions: joinThen(clauses) });
  const sendsToReview =
    has('submit') || has('push_and_submit') || (has('release') && play && direct);
  const tail = sendsToReview
    ? t('publish:summary.outcome.review')
    : wanted.length === 1 && has('push_draft')
      ? t('publish:summary.outcome.draftOnly')
      : '';
  // The person chose to replace the review in progress: said in plain words before anything is confirmed.
  const replaces = input.plan.replacesReview === true && has('push_and_submit');
  const full = tail === '' ? sentence : `${sentence} ${tail}`;
  return replaces ? `${full} ${t('publish:summary.outcome.replaceReview')}` : full;
}
