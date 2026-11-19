import type { Platform } from '@mrm/core';
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
  exportCompliance?: 'answered' | 'missing' | 'unknown';
  testNotes?: TestNotes;
};

export type CodeCandidate = {
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

export type PlayCandidates = { store: 'googleplay'; platform: 'android'; track: string; codes: CodeCandidate[] };

export type ReleaseCandidates = AppleCandidates | PlayCandidates;

export type ReleaseNoteRead = { locale: string; text: string };
export type PlayReleaseRead = { name: string | null; status: string; userFraction: number | null; versionCodes: string[]; notes: ReleaseNoteRead[] };

export type EditableRelease =
  | {
      store: 'appstoreconnect';
      platform: Platform;
      version: { id: string; versionString: string | null; state: string; editable: true };
      releaseType: string | null;
      earliestReleaseDate: string | null;
      copyright: string | null;
      build: { id: string; buildNumber: string | null; processingState: string | null; expired: boolean | null } | null;
      phasedRelease: { id: string; state: string | null } | null;
      releaseNotes: ReleaseNoteRead[];
    }
  | { store: 'googleplay'; platform: 'android'; track: string; draft: PlayReleaseRead | null; others: PlayReleaseRead[] };

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

/** What a machine code says when the server sent no sentence (an older server). */
const CODE_SENTENCES: Record<string, string> = {
  ok: 'This build can be chosen.',
  processing: 'Apple is still processing this build. Try again in a few minutes.',
  failed: 'Apple could not process this build. Upload a new build.',
  invalid: 'Apple marked this build invalid. Upload a new build.',
  state_unknown: 'Apple did not say whether this build is processed, so it cannot be chosen.',
  expired: 'This build has expired. Upload a new build.',
  wrong_version: 'This build belongs to another version than the one being prepared.',
  no_editable_version: 'No version is in Prepare for Submission, so no build can be attached yet. Create the version in App Store Connect first.',
  already_attached: 'This is the build of the version already.',
  export_compliance_missing: 'Apple has no export compliance answer for this build. It can be chosen; App Store Connect may ask for it later.',
  already_in_draft: 'The draft release of this track holds this version code already.',
  already_live: 'A release of this track that is live or rolling out holds this version code.',
};

/** The eligibility of one build or code as a person sees it. Never an empty sentence, never just "not eligible". */
export function eligibilityView(item: { eligibility?: Eligibility; selectable?: boolean; reason?: string | null }): EligibilityView {
  const e = item.eligibility;
  if (e) {
    const sentence = e.message.trim() !== '' ? e.message.trim() : (CODE_SENTENCES[e.code] ?? (e.eligible ? 'This can be chosen.' : 'This cannot be chosen now.'));
    if (e.eligible) {
      return e.severity === 'warning'
        ? { selectable: true, tone: 'warn', sentence, label: 'Read first' }
        : { selectable: true, tone: 'ok', sentence, label: 'Can be chosen' };
    }
    // Not eligible and not blocked: it is the build or code the draft has already.
    if (e.severity !== 'blocked') return { selectable: false, tone: 'ok', sentence, label: 'Already chosen' };
    return { selectable: false, tone: 'bad', sentence, label: 'Cannot be chosen' };
  }
  if (item.selectable === true) return { selectable: true, tone: 'ok', sentence: CODE_SENTENCES.ok as string, label: 'Can be chosen' };
  const reason = (item.reason ?? '').trim();
  return { selectable: false, tone: 'bad', sentence: reason !== '' ? reason : 'This build cannot be chosen now.', label: 'Cannot be chosen' };
}

// ---------------------------------------------------------------------------------------------
// Builds (App Store, macOS)

export type SourceRun = { text: string; url: string | null };

/** The CI run that made a build (from the builds of the app), or a sentence that says why there is none. */
export function sourceRunOf(buildNumber: string | null, builds: readonly Pick<AppBuild, 'buildNumber' | 'link' | 'linkState'>[]): SourceRun {
  if (buildNumber === null) return { text: 'No CI run linked', url: null };
  const found = builds.filter((b) => b.buildNumber === buildNumber)[0];
  if (!found) return { text: 'No CI run linked (this build is not in the builds of the app yet)', url: null };
  const run = found.link?.run ?? null;
  if (run === null) {
    return { text: found.linkState === 'tag' ? 'A tag carries this number, but no CI run was found' : 'No CI run linked', url: null };
  }
  const title = run.title && run.title !== run.workflow ? ` ${run.title}` : '';
  return { text: `${run.workflow}${title}`, url: run.url };
}

/** "2026-11-19 10:30" in UTC, or "date unknown". Pure: no locale, so the text is the same everywhere. */
export function uploadedText(iso: string | null): string {
  if (iso === null) return 'date unknown';
  const ms = Date.parse(iso);
  if (isNaN(ms)) return 'date unknown';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** What the TestFlight notes of a build are, in one sentence: read or not, how many languages, why not. */
export function testNotesLine(notes: TestNotes | undefined): string {
  if (!notes) return 'TestFlight notes: this server did not say.';
  if (!notes.read) {
    if (notes.error === 'forbidden') return 'TestFlight notes: not read. The credential of this app may not read them.';
    if (notes.error === 'rate_limited') return 'TestFlight notes: not read. Apple is limiting requests; try again in a minute.';
    if (notes.error === 'not_found') return 'TestFlight notes: not read. Apple has no test details for this build.';
    if (notes.error) return 'TestFlight notes: not read. Apple could not be reached.';
    return 'TestFlight notes: not read. Only the newest eight processed builds are read.';
  }
  const n = notes.locales.length;
  if (n === 0) return 'TestFlight notes: read, and this build has none.';
  return `TestFlight notes: ${n} ${n === 1 ? 'language' : 'languages'}.`;
}

/** The notes can be used: they were read and hold at least one text. */
export const hasTestNotes = (notes: TestNotes | undefined): boolean => !!notes && notes.read && notes.locales.length > 0;

export type BuildRow = {
  id: string;
  title: string;
  version: string | null;
  uploaded: string;
  run: SourceRun;
  eligibility: EligibilityView;
  attached: boolean;
  testNotes: string;
  hasTestNotes: boolean;
};

export function buildRows(builds: readonly BuildCandidate[], appBuilds: readonly Pick<AppBuild, 'buildNumber' | 'link' | 'linkState'>[]): BuildRow[] {
  return builds.map((b) => ({
    id: b.id,
    title: b.buildNumber !== null ? `Build ${b.buildNumber}` : 'Build (number unknown)',
    version: b.version,
    uploaded: uploadedText(b.uploadedDate),
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
export function noBuildSentence(builds: readonly BuildCandidate[], versionString: string | null): string | null {
  if (builds.some((b) => eligibilityView(b).selectable)) return null;
  if (builds.length === 0) {
    return 'App Store Connect lists no builds for this app yet. Start the release workflow, or upload a build, then read this list again.';
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
  const word = (key: string, n: number): string => {
    const one = n === 1;
    switch (key) {
      case 'processing':
        return `${n} ${one ? 'is' : 'are'} still processing`;
      case 'failed':
      case 'invalid':
        return `${n} could not be processed`;
      case 'expired':
        return `${n} ${one ? 'has' : 'have'} expired`;
      case 'wrong_version':
        return `${n} ${one ? 'is' : 'are'} for another version${versionString ? ` than ${versionString}` : ''}`;
      case 'no_editable_version':
        return `${n} ${one ? 'is' : 'are'} processed, but no version is in Prepare for Submission`;
      case 'attached':
        return `${n} ${one ? 'is' : 'are'} chosen already`;
      default:
        return `${n} cannot be chosen`;
    }
  };
  const reasons = order.map((k) => word(k, counts[k] as number));
  return `${builds.length} ${builds.length === 1 ? 'build is' : 'builds are'} listed and none can be chosen now: ${reasons.join('; ')}.`;
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
};

const sameTrack = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The codes of one read as rows, newest first. `from` is the track a release is promoted from: its codes come first, so
 * "promote from beta" reads as the codes beta holds. `inFrom` are the codes found in a read of that track.
 */
export function codeRows(codes: readonly CodeCandidate[], inFrom: readonly string[] = []): CodeRow[] {
  const rows = codes.map((c) => ({
    versionCode: c.versionCode,
    source: c.source === 'bundle' ? 'App bundle' : 'APK',
    eligibility: eligibilityView(c),
    where: c.inTrack.map((t) => `${t.name ?? 'unnamed release'} (${t.status})`).join(', '),
    inSource: inFrom.indexOf(c.versionCode) >= 0,
  }));
  const num = (r: CodeRow) => Number(r.versionCode) || 0;
  return rows.sort((a, b) => Number(b.inSource) - Number(a.inSource) || num(b) - num(a));
}

/** The codes that hold a release of `track` in a read made for that track (a code whose release carries a name or status is "in" it). */
export function codesInTrack(codes: readonly CodeCandidate[]): string[] {
  return codes.filter((c) => c.inTrack.length > 0).map((c) => c.versionCode);
}

export function noCodeSentence(rows: readonly CodeRow[], track: string): string | null {
  if (rows.some((r) => r.eligibility.selectable)) return null;
  if (rows.length === 0) return `Google Play lists no uploaded version codes for this app. Upload a bundle (the release workflow does) and read this list again for ${track}.`;
  const live = rows.filter((r) => r.eligibility.tone === 'bad').length;
  const chosen = rows.length - live;
  const parts: string[] = [];
  if (live > 0) parts.push(`${live} ${live === 1 ? 'is' : 'are'} in a release of ${track} that is live or rolling out`);
  if (chosen > 0) parts.push(`${chosen} ${chosen === 1 ? 'is' : 'are'} in the draft already`);
  return `${rows.length} version ${rows.length === 1 ? 'code is' : 'codes are'} listed and none can be added: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------------------------
// Track names

export const SUGGESTED_TRACKS = ['production', 'beta', 'alpha', 'internal'] as const;

export const isSameTrack = sameTrack;

/** A track name Google Play accepts (the same rule as the server): letters, digits and `_ : . -`. */
export const isTrackName = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/.test(value.trim());
