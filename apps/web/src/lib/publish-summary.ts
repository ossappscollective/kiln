import { type Platform, platformMeta, supports } from '@kiln/core';
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
import type { DraftPreview } from './staged.ts';
import { percentText } from './store-release.ts';

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
};

export type NotesDetail = {
  /** The first language with a text, as a short preview (null when no text is known). */
  first: NotesPreview | null;
  /** The other languages, by name. */
  others: { locale: string; empty: boolean }[];
};

export type PublishSummary = {
  rows: SummaryRow[];
  notes: NotesDetail | null;
  /** "Nothing else is changed.", or why the staged changes are not part of this publish. */
  footnote: string | null;
  /** One plain sentence on what pressing Publish does, following the ticked steps. */
  outcome: string;
  /** No step is ticked: the outcome says so and the rows are kept to where it would go. */
  nothing: boolean;
};

/** What the Track and Share fields hold while the release step is not part of the plan yet. */
export type TypedRelease = { track: string; fraction: number | null };

export type SummaryInput = {
  plan: PublishPlan;
  wanted: readonly PublishStepType[];
  /** The bundle id (iOS, macOS) or package name (Android) of the app record; '' when not known. */
  identifier: string;
  typed?: TypedRelease | null | undefined;
};

export const NOTE_LINES = 3;
export const NOTE_LINE_CHARS = 140;

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
  return { locale, lines, truncated: cut, empty: all.length === 0 };
}

type Note = { locale: string; text: string };

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
      inputTouched ||
      step.availability !== 'needs_input' ||
      INPUT_PROMPT_CODES.indexOf(p.code) < 0,
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

  const pushStep = stepOf(plan, 'push_draft');
  const submitStep = stepOf(plan, 'submit');
  const releaseStep = stepOf(plan, 'release');
  const push = asPushPreview(pushStep?.preview);
  const submit = asSubmitPreview(submitStep?.preview);
  const release = asReleasePreview(releaseStep?.preview);
  const pushed = has('push_draft') ? push : null;
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
    } else if (has('push_draft')) {
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
    if (name !== null && codes.length > 0)
      value = t('publish:summary.release.nameCodes', { name, codes: codes.join(', ') });
    else if (codes.length > 0)
      value = t('publish:summary.release.codes', { count: codes.length, codes: codes.join(', ') });
    else if (name !== null) value = name;
    else value = t('publish:summary.release.inDraft');
    rows.push({ id: 'release', label: t('publish:summary.row.release'), value });
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

  if (has('submit')) {
    rows.push({
      id: 'review',
      label: t('publish:summary.row.review'),
      value: play
        ? t('publish:summary.review.play')
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
  const detail: NotesDetail | null = (() => {
    if (notes.length === 0) return null;
    const filled = notes.filter((n) => n.text.trim() !== '');
    const first = filled[0];
    return {
      first: first ? notesPreview(first.locale, first.text) : null,
      others: notes
        .filter((n) => !first || n.locale !== first.locale)
        .map((n) => ({ locale: n.locale, empty: n.text.trim() === '' })),
    };
  })();
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
    footnote,
    outcome: outcomeText({ plan, wanted, play, direct, track, fraction, kind, appleVersion }),
    nothing: wanted.length === 0,
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
  if (has('push_draft')) {
    if (play) clauses.push(t('publish:summary.outcome.pushPlay'));
    else clauses.push(t('publish:summary.outcome.pushApple'));
  }
  if (has('submit')) {
    if (play) clauses.push(t('publish:summary.outcome.submitPlay'));
    else if (appleVersion !== null)
      clauses.push(t('publish:summary.outcome.submitApple', { version: appleVersion }));
    else clauses.push(t('publish:summary.outcome.submitAppleNoVersion'));
  }
  if (has('release')) {
    if (play && direct) {
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
  const sendsToReview = has('submit') || (has('release') && play && direct);
  const tail = sendsToReview
    ? t('publish:summary.outcome.review')
    : wanted.length === 1 && has('push_draft')
      ? t('publish:summary.outcome.draftOnly')
      : '';
  return tail === '' ? sentence : `${sentence} ${tail}`;
}
