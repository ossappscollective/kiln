import { buildNumberOfBuild, compareBuildNumbers, type Platform } from '@kiln/core';
import {
  latestOf,
  type OriginFields,
  type OriginOptions,
  type OriginView,
  originView,
  sameVersion,
  versionMismatch,
} from './build-origin.ts';
import { formatDateTime, formatList, formatRelativeTime } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { AppBuild } from './types.ts';

/**
 * The reads behind "Prepare release" (docs/api/releases-write.md): the builds an App Store version can use, the version codes
 * Google Play holds, and the release fields the store has now. Pure types and wording only. A read changes nothing in a store.
 * The server judges eligibility (`eligibility.message` is a plain sentence); this file only decides how it is shown.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

// ---------------------------------------------------------------------------------------------
// API shapes (`GET /apps/{id}/release/candidates` and `.../release/editable`)

export type EligibilitySeverity = 'ok' | 'warning' | 'blocked';
export type Eligibility = {
  eligible: boolean;
  severity: EligibilitySeverity;
  /** A machine reason. New ones may be added: a client falls back to `severity`. */
  code: string;
  /** A plain sentence for a person. */
  message: string;
};

/**
 * Whether a version named like the build may be CREATED now: the server's answer (`createReleaseRules` of @kiln/core, from the versions
 * it synced), so no screen offers a create that the store refuses. Absent from an older server: nothing is claimed.
 */
export type CreateVerdict = {
  version: string;
  creatable: boolean;
  refusal: 'invalid_version' | 'editable_version_exists' | 'version_exists' | 'not_higher' | null;
  reasons: string[];
  editableVersion: string | null;
  newestFixed: string | null;
};

/** The refusal of a create in words (never empty for a refusal). Null when it can be created. */
export function createRefusalText(v: CreateVerdict | null | undefined): string | null {
  if (v === null || v === undefined || v.creatable) return null;
  switch (v.refusal) {
    case 'editable_version_exists':
      return t('release-stepper:cv.refused.editable', { editable: v.editableVersion ?? '' });
    case 'version_exists':
      return t('release-stepper:cv.refused.exists', { version: v.version });
    case 'not_higher':
      return t('release-stepper:cv.refused.notHigher', { version: v.version, newest: v.newestFixed ?? '' });
    default:
      return t('release-stepper:cv.refused.invalid', { version: v.version });
  }
}

/** The verdict for the version the person typed: the build of that version in the read says whether the store would take it. */
export function createVerdictFor(
  builds: readonly { create?: CreateVerdict | null | undefined }[],
  version: string,
): CreateVerdict | null {
  const wanted = version.trim();
  if (wanted === '') return null;
  for (const b of builds) if (b.create && sameVersion(b.create.version, wanted)) return b.create;
  return null;
}

export type TestNote = { locale: string; text: string; truncated: boolean };
export type TestNotes = {
  /** False: not asked for this build, or the read failed (`error`). */
  read: boolean;
  locales: TestNote[];
  error?: 'forbidden' | 'rate_limited' | 'not_found' | 'unavailable' | string;
};

export type BuildCandidate = {
  id: string;
  buildNumber: string | null;
  version: string | null;
  /** ISO 8601. */
  uploadedDate: string | null;
  processingState: string | null;
  expired: boolean | null;
  selectable: boolean;
  reason: string | null;
  attached: boolean;
  /** Missing on an older server: the fallbacks read `selectable` and `reason`. */
  eligibility?: Eligibility;
  /** Whether a version named like this build can be created (App Store; absent from an older server). */
  create?: CreateVerdict | null;
  exportCompliance?: 'answered' | 'missing' | 'unknown';
  testNotes?: TestNotes;
};

export type CodeCandidate = OriginFields & {
  versionCode: string;
  source: 'bundle' | 'apk';
  sha256: string | null;
  inTrack: { name: string | null; status: string }[];
  eligibility?: Eligibility;
};

export type AppleCandidates = {
  store: 'appstoreconnect';
  platform: Platform;
  version: { id: string; versionString: string | null; state: string } | null;
  builds: BuildCandidate[];
  attachedBuildId: string | null;
  truncatedAt: number | null;
};

export type PlayCandidates = {
  store: 'googleplay';
  platform: 'android';
  track: string;
  codes: CodeCandidate[];
};

export type ReleaseCandidates = AppleCandidates | PlayCandidates;

export type ReleaseNoteRead = { locale: string; text: string };
export type PlayReleaseRead = {
  name: string | null;
  status: string;
  userFraction: number | null;
  versionCodes: string[];
  notes: ReleaseNoteRead[];
};

export type EditableRelease =
  | {
      store: 'appstoreconnect';
      platform: Platform;
      version: { id: string; versionString: string | null; state: string; editable: true };
      releaseType: string | null;
      earliestReleaseDate: string | null;
      copyright: string | null;
      build: {
        id: string;
        buildNumber: string | null;
        processingState: string | null;
        expired: boolean | null;
      } | null;
      phasedRelease: { id: string; state: string | null } | null;
      releaseNotes: ReleaseNoteRead[];
    }
  | {
      store: 'googleplay';
      platform: 'android';
      track: string;
      draft: PlayReleaseRead | null;
      others: PlayReleaseRead[];
    };

// ---------------------------------------------------------------------------------------------
// Eligibility, as it is shown

export type EligibilityTone = 'ok' | 'warn' | 'bad' | 'neutral';
export type EligibilityView = {
  /** The person may choose it now. A disabled row is still listed, with the sentence. */
  selectable: boolean;
  tone: EligibilityTone;
  /** Always a sentence; never empty. */
  sentence: string;
  /** A few words for a chip: "Can be chosen", "Read first", "Cannot be chosen", "Already chosen". */
  label: string;
};

/** What a machine code says when the server sent no sentence (an older server): message keys. */
const CODE_SENTENCES: Record<string, string> = {
  ok: k('release-stepper:cand.code.ok'),
  processing: k('release-stepper:cand.code.processing'),
  failed: k('release-stepper:cand.code.failed'),
  invalid: k('release-stepper:cand.code.invalid'),
  state_unknown: k('release-stepper:cand.code.stateUnknown'),
  expired: k('release-stepper:cand.code.expired'),
  wrong_version: k('release-stepper:cand.code.wrongVersion'),
  no_editable_version: k('release-stepper:cand.code.noEditableVersion'),
  already_attached: k('release-stepper:cand.code.alreadyAttached'),
  export_compliance_missing: k('release-stepper:cand.code.exportMissing'),
  already_in_draft: k('release-stepper:cand.code.alreadyInDraft'),
  already_live: k('release-stepper:cand.code.alreadyLive'),
  in_flight: k('release-stepper:cand.code.inFlight'),
  older_than_live: k('release-stepper:cand.code.olderThanLive'),
};
const codeSentence = (code: string): string | null => {
  const key = CODE_SENTENCES[code];
  return key === undefined ? null : t(key);
};

/** The eligibility of one build or code as a person sees it. Never an empty sentence, never just "not eligible". */
export function eligibilityView(item: {
  eligibility?: Eligibility;
  selectable?: boolean;
  reason?: string | null;
}): EligibilityView {
  const e = item.eligibility;
  if (e) {
    const sentence =
      e.message.trim() !== ''
        ? e.message.trim()
        : (codeSentence(e.code) ??
          (e.eligible
            ? t('release-stepper:cand.eligible')
            : t('release-stepper:cand.notEligible')));
    if (e.eligible) {
      return e.severity === 'warning'
        ? {
            selectable: true,
            tone: 'warn',
            sentence,
            label: t('release-stepper:cand.label.readFirst'),
          }
        : {
            selectable: true,
            tone: 'ok',
            sentence,
            label: t('release-stepper:cand.label.canChoose'),
          };
    }
    // Not eligible and not blocked: it is the build or code the draft has already.
    if (e.severity !== 'blocked')
      return {
        selectable: false,
        tone: 'ok',
        sentence,
        label: t('release-stepper:cand.label.alreadyChosen'),
      };
    return {
      selectable: false,
      tone: 'bad',
      sentence,
      label: t('release-stepper:cand.label.cannotChoose'),
    };
  }
  if (item.selectable === true)
    return {
      selectable: true,
      tone: 'ok',
      sentence: t('release-stepper:cand.code.ok'),
      label: t('release-stepper:cand.label.canChoose'),
    };
  const reason = (item.reason ?? '').trim();
  return {
    selectable: false,
    tone: 'bad',
    sentence: reason !== '' ? reason : t('release-stepper:cand.buildNotEligible'),
    label: t('release-stepper:cand.label.cannotChoose'),
  };
}

// ---------------------------------------------------------------------------------------------
// Builds (App Store, macOS)

export type SourceRun = { text: string; url: string | null };

/** The CI run that made a build (from the builds of the app), or a sentence that says why there is none. */
export function sourceRunOf(
  buildNumber: string | null,
  builds: readonly Pick<AppBuild, 'buildNumber' | 'link' | 'linkState'>[],
): SourceRun {
  if (buildNumber === null) return { text: t('release-stepper:cand.run.none'), url: null };
  const found = builds.filter((b) => b.buildNumber === buildNumber)[0];
  if (!found) return { text: t('release-stepper:cand.run.notInBuilds'), url: null };
  const run = found.link?.run ?? null;
  if (run === null) {
    return {
      text:
        found.linkState === 'tag'
          ? t('release-stepper:cand.run.tag')
          : t('release-stepper:cand.run.none'),
      url: null,
    };
  }
  const title = run.title && run.title !== run.workflow ? ` ${run.title}` : '';
  return { text: `${run.workflow}${title}`, url: run.url };
}

/** "Nov 19, 2026, 10:30 AM UTC" (the store's time, in UTC), or "date unknown". */
export function uploadedText(iso: string | null): string {
  if (iso === null) return t('release-stepper:cand.uploaded.unknown');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return t('release-stepper:cand.uploaded.unknown');
  return formatDateTime(ms, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/** What the TestFlight notes of a build are, in one sentence: read or not, how many languages, why not. */
export function testNotesLine(notes: TestNotes | undefined): string {
  if (!notes) return t('release-stepper:cand.testNotes.unsaid');
  if (!notes.read) {
    if (notes.error === 'forbidden') return t('release-stepper:cand.testNotes.forbidden');
    if (notes.error === 'rate_limited') return t('release-stepper:cand.testNotes.rateLimited');
    if (notes.error === 'not_found') return t('release-stepper:cand.testNotes.notFound');
    if (notes.error) return t('release-stepper:cand.testNotes.unreachable');
    return t('release-stepper:cand.testNotes.notAsked');
  }
  const n = notes.locales.length;
  if (n === 0) return t('release-stepper:cand.testNotes.none');
  return t('release-stepper:cand.testNotes.languages', { count: n });
}

/** The notes can be used: they were read and hold at least one text. */
export const hasTestNotes = (notes: TestNotes | undefined): boolean =>
  !!notes && notes.read && notes.locales.length > 0;

export type CandidateBuildRow = {
  id: string;
  title: string;
  /** The build number as the server sent it (structured): never parsed out of the translated `title`. Null: not known. */
  buildNumber: string | null;
  version: string | null;
  uploaded: string;
  /** "yesterday", "3 days ago"; null when the date is not known. */
  uploadedAge: string | null;
  /** The newest build by upload date (and no undated build above it by number). */
  latest: boolean;
  run: SourceRun;
  eligibility: EligibilityView;
  attached: boolean;
  testNotes: string;
  hasTestNotes: boolean;
};

const uploadedMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

const ageOf = (iso: string | null, now: number): string | null => {
  const ms = uploadedMs(iso);
  return ms === null ? null : formatRelativeTime(ms, { now });
};

export function buildRows(
  builds: readonly BuildCandidate[],
  appBuilds: readonly Pick<AppBuild, 'buildNumber' | 'link' | 'linkState'>[],
  now: number = Date.now(),
): CandidateBuildRow[] {
  const latest = latestOf(
    builds.map((b) => ({
      id: b.id,
      buildNumber: b.buildNumber,
      builtAt: uploadedMs(b.uploadedDate),
    })),
  );
  return builds.map((b) => ({
    id: b.id,
    title:
      b.buildNumber !== null
        ? t('release-stepper:cand.build.title', { number: b.buildNumber })
        : t('release-stepper:cand.build.titleUnknown'),
    buildNumber: buildNumberOfBuild(b),
    version: b.version,
    uploaded: uploadedText(b.uploadedDate),
    uploadedAge: ageOf(b.uploadedDate, now),
    latest: latest === b.id,
    run: sourceRunOf(b.buildNumber, appBuilds),
    eligibility: eligibilityView(b),
    attached: b.attached,
    testNotes: testNotesLine(b.testNotes),
    hasTestNotes: hasTestNotes(b.testNotes),
  }));
}

/**
 * The sentence above the list when there is nothing to choose. It says why: no builds at all, or each reason in numbers
 * ("2 are for another version, 1 is still processing"). Null when at least one build can be chosen.
 */
export function noBuildSentence(
  builds: readonly BuildCandidate[],
  versionString: string | null,
): string | null {
  if (builds.some((b) => eligibilityView(b).selectable)) return null;
  if (builds.length === 0) {
    return t('release-stepper:cand.noBuild.empty');
  }
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const b of builds) {
    const v = eligibilityView(b);
    const code = b.eligibility?.code ?? (b.selectable ? 'ok' : 'blocked');
    const key = v.tone === 'ok' ? 'attached' : code;
    if (counts[key] === undefined) order.push(key);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const word = (key: string, count: number): string => {
    switch (key) {
      case 'processing':
        return t('release-stepper:cand.noBuild.processing', { count });
      case 'failed':
      case 'invalid':
        return t('release-stepper:cand.noBuild.failed', { count });
      case 'expired':
        return t('release-stepper:cand.noBuild.expired', { count });
      case 'wrong_version':
        return versionString
          ? t('release-stepper:cand.noBuild.wrongVersionThan', { count, version: versionString })
          : t('release-stepper:cand.noBuild.wrongVersion', { count });
      case 'no_editable_version':
        return t('release-stepper:cand.noBuild.noEditable', { count });
      case 'attached':
        return t('release-stepper:cand.noBuild.attached', { count });
      default:
        return t('release-stepper:cand.noBuild.other', { count });
    }
  };
  const reasons = order.map((key) => word(key, counts[key] as number));
  // Each reason is a whole clause with its own count; they are listed with semicolons in every language.
  return t('release-stepper:cand.noBuild.summary', {
    count: builds.length,
    reasons: reasons.join('; '),
  });
}

// ---------------------------------------------------------------------------------------------
// Version codes (Google Play)

export type CodeRow = {
  versionCode: string;
  source: string;
  eligibility: EligibilityView;
  /** "In beta (completed), production (draft)". Empty when no release of the track holds it. */
  where: string;
  /** The code is in a release of the "from" track. */
  inSource: boolean;
  /** Which version it is and when it was built, as far as Kiln knows (never a guess). */
  origin: OriginView;
  /** The version read from a file or the store (not a release name); null when not known. */
  version: string | null;
  /** The newest code by build date, when dates are known (see `latestOf`). */
  latest: boolean;
};

const sameTrack = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The codes of one read as rows, newest first. `from` is the track a release is promoted from: its codes come first, so
 * "promote from beta" reads as the codes beta holds. `inFrom` are the codes found in a read of that track.
 */
export function codeRows(
  codes: readonly CodeCandidate[],
  inFrom: readonly string[] = [],
  now: number = Date.now(),
  options: OriginOptions = {},
): CodeRow[] {
  const latest = latestOf(
    codes.map((c) => ({
      id: c.versionCode,
      buildNumber: c.versionCode,
      builtAt: c.builtAt ?? null,
    })),
  );
  const rows = codes.map((c) => {
    const origin = originView(c, now, options);
    return {
      versionCode: c.versionCode,
      source:
        c.source === 'bundle'
          ? t('release-stepper:cand.code.sourceBundle')
          : t('release-stepper:cand.code.sourceApk'),
      eligibility: eligibilityView(c),
      where: formatList(
        c.inTrack.map((entry) =>
          t('release-stepper:cand.code.inTrackItem', {
            name: entry.name ?? t('release-stepper:cand.code.unnamedRelease'),
            status: entry.status,
          }),
        ),
        { type: 'unit' },
      ),
      inSource: inFrom.indexOf(c.versionCode) >= 0,
      origin,
      version: origin.version,
      latest: latest === c.versionCode,
    };
  });
  return rows.sort(
    (a, b) =>
      Number(b.inSource) - Number(a.inSource) || compareBuildNumbers(b.versionCode, a.versionCode),
  );
}

/** Whether reading the recent CI builds could still tell a version or a date of one of these rows ("Read build info from CI" is offered). */
export function anyReadableFromCi(rows: readonly Pick<CodeRow, 'origin'>[]): boolean {
  return rows.some((r) => r.origin.reason?.readable === true);
}

/** The codes that hold a release of `track` in a read made for that track (a code whose release carries a name or status is "in" it). */
export function codesInTrack(codes: readonly CodeCandidate[]): string[] {
  return codes.filter((c) => c.inTrack.length > 0).map((c) => c.versionCode);
}

export function noCodeSentence(rows: readonly CodeRow[], track: string): string | null {
  if (rows.some((r) => r.eligibility.selectable)) return null;
  if (rows.length === 0) return t('release-stepper:cand.noCode.empty', { track });
  const live = rows.filter((r) => r.eligibility.tone === 'bad').length;
  const chosen = rows.length - live;
  const parts: string[] = [];
  if (live > 0) parts.push(t('release-stepper:cand.noCode.live', { count: live, track }));
  if (chosen > 0) parts.push(t('release-stepper:cand.noCode.draft', { count: chosen }));
  return t('release-stepper:cand.noCode.summary', {
    count: rows.length,
    reasons: parts.join('; '),
  });
}

// ---------------------------------------------------------------------------------------------
// Track names

export const SUGGESTED_TRACKS = ['production', 'beta', 'alpha', 'internal'] as const;

export const isSameTrack = sameTrack;

/** A track name Google Play accepts (the same rule as the server): letters, digits and `_ : . -`. */
export const isTrackName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/.test(value.trim());

// ---------------------------------------------------------------------------------------------
// The build(s) chosen for this release, for the Confirm step

export type ChosenBuildLine = {
  id: string;
  title: string;
  origin: OriginView;
  /**
   * Say the version and the date even when they are not known (Google Play: "Version not known"). Apple always gives both for a processed
   * build, so there a missing one is left out rather than blamed on a file nobody read.
   */
  sayUnknown: boolean;
  /** "This build is version 2.00.0, but you are releasing 2.00.1": non-blocking; null when there is nothing to warn about. */
  mismatch: string | null;
};

/**
 * The chosen Google Play codes with their version and build date. `releasing` is the name of the release being made (a staged name
 * or the draft's): only a version it says, set against a version READ from a file or the store, can warn.
 */
export function chosenCodeLines(
  chosen: readonly string[],
  known: readonly CodeCandidate[],
  releasing: string | null,
  now: number = Date.now(),
): ChosenBuildLine[] {
  return chosen.map((code) => {
    const hit = known.filter((c) => c.versionCode === code)[0];
    const origin = originView(hit ?? {}, now);
    return {
      id: code,
      title: t('release-stepper:sb.versionCode', { code }),
      origin,
      sayUnknown: true,
      mismatch: versionMismatch({ version: origin.version }, releasing),
    };
  });
}

/** The chosen App Store build: its version and upload time come from Apple (`store`). `releasing` is the version of the editable version. */
export function chosenBuildLine(
  build: BuildCandidate | undefined,
  releasing: string | null,
  now: number = Date.now(),
): ChosenBuildLine | null {
  if (build === undefined) return null;
  const origin = originView(
    {
      version: build.version,
      origin: build.version !== null ? 'store' : null,
      builtAt: uploadedMs(build.uploadedDate),
      builtFrom: 'store',
    },
    now,
  );
  return {
    id: build.id,
    title:
      build.buildNumber !== null
        ? t('release-stepper:cand.build.title', { number: build.buildNumber })
        : t('release-stepper:cand.build.titleUnknown'),
    origin,
    sayUnknown: false,
    mismatch: versionMismatch({ version: origin.version }, releasing),
  };
}
