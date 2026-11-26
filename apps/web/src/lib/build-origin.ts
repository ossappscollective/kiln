import { formatDateTime, formatRelativeTime } from './i18n/format.ts';
import { t } from './i18n/t.ts';

/**
 * Which version a build is and when it was built, as the Prepare release dialog shows it (docs/api/releases-write.md, "Origin of a
 * Google Play code"). The server joins what Kiln knows (the CI files it read, the synced store builds, the name of the release that
 * holds a code); this file only words it. It never invents: a field the server left null is said to be unknown, and the name of a
 * release is shown as a name (never as the version of the file, and never as a build date). Pure; written for the ES2017 web build.
 */

export type OriginCiRun = {
  runNumber: number | null;
  branch: string | null;
  commit: string | null;
  url: string | null;
};

/** The fields the server adds to a Google Play code (all optional: an older server sends none of them). */
export type OriginFields = {
  version?: string | null | undefined;
  /** Epoch milliseconds. */
  builtAt?: number | null | undefined;
  /** Where `version` came from (else where `builtAt` came from). */
  origin?: 'ci' | 'store' | 'release' | null | undefined;
  /** Where `builtAt` came from. */
  builtFrom?: 'ci' | 'store' | null | undefined;
  ci?: OriginCiRun | undefined;
  /** Why `builtAt` is null (the server says; absent from an older server). */
  builtGap?: BuiltGap | null | undefined;
  /** When the CI file is gone: when GitHub deleted (or deletes) it, if known. Epoch milliseconds. */
  ciExpiredAt?: number | null | undefined;
  /** `build_number_only`: the CI file was matched on the build number alone (its package is not the app's). */
  matchedBy?: 'package' | 'build_number_only' | null | undefined;
  /** When Kiln's store sync first saw the code (epoch milliseconds). NOT a build date. */
  firstSeenAt?: number | null | undefined;
};

/** Why a build date is not known, as the server says it. */
export type BuiltGap =
  | 'not_read'
  | 'file_gone'
  | 'github_unreachable'
  | 'github_no_access'
  | 'no_repository';

/** The reason model of a missing build date: which sentence, and whether reading the CI files could still help. */
export type BuiltReasonKey =
  | 'not_read'
  | 'file_gone'
  | 'github_unreachable'
  | 'github_no_access'
  | 'no_repository'
  | 'not_in_ci'
  | 'play_none';

export type BuiltReason = {
  key: BuiltReasonKey;
  /** The short reason, said after "Build date not known:". */
  text: string;
  /** The longer sentence behind it (hover and screen reader text). */
  title: string;
  /** Reading the recent CI builds could fill it in ("Read build info from CI" is worth offering). */
  readable: boolean;
};

export type OriginRun = { text: string; title: string; url: string | null };

export type OriginView = {
  /** The text of the version chip: "Version 2.00.1", "Release name 1.15.2", or the sentence that says it is not known. */
  versionText: string;
  /** A version that was read from a file or the store: a mismatch with the release can be claimed on it. */
  version: string | null;
  /** Nothing says which version the file is (not even a release name): the row offers to find it in CI builds. */
  versionUnknown: boolean;
  versionTitle: string;
  /** "Built Nov 24, 2026, 11:38 PM · yesterday", "Uploaded ...", or "Build date not known". */
  builtText: string;
  builtKnown: boolean;
  builtTitle: string;
  /** Why the date is not known; null when it is known. */
  reason: BuiltReason | null;
  /** "Matched by build number only" when the CI file's package is not the app's; else null. */
  matchNote: string | null;
  matchTitle: string;
  /** "First seen by Kiln Nov 24, 2026" when the date is not known but the sync saw the code; else null. NOT a build date. */
  firstSeenText: string | null;
  firstSeenTitle: string;
  run: OriginRun | null;
};

export type OriginOptions = {
  /** "Read build info from CI" was run in this view and this code is still without a date: no recent CI build holds it. */
  ciTried?: boolean;
};

const nonEmpty = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && value.trim() !== '' ? value.trim() : null;

/** The version of a candidate when it was READ (a CI file or the store); null for a release name or when nothing is known. */
export function readVersionOf(o: OriginFields): string | null {
  const version = nonEmpty(o.version);
  return version !== null && (o.origin === 'ci' || o.origin === 'store') ? version : null;
}

/** The CI run of a cache hit as a short link text ("CI run #41") with its branch and commit as the title. */
export function originRun(ci: OriginCiRun | undefined): OriginRun | null {
  if (ci === undefined) return null;
  const detail = [nonEmpty(ci.branch), nonEmpty(ci.commit)].filter((p): p is string => p !== null);
  const text =
    ci.runNumber !== null
      ? t('release-stepper:og.run', { number: ci.runNumber })
      : t('release-stepper:og.runUnnumbered');
  return {
    text,
    title: detail.length > 0 ? detail.join(' · ') : text,
    url: nonEmpty(ci.url),
  };
}

/**
 * Why the build date of a code is not known, in one of a fixed set of sentences (never "not known" alone). Null when it is known.
 * Null too when the server sent no reason (older server, App Store build): nothing is claimed then; the plain sentence is used.
 * `ciTried`: the recent CI builds were just read and none holds this code, so it was built elsewhere or long ago.
 */
export function builtReason(o: OriginFields, options: OriginOptions = {}): BuiltReason | null {
  if (typeof o.builtAt === 'number' && Number.isFinite(o.builtAt)) return null;
  // No reason sent at all (an older server, or an App Store build): nothing is claimed about why.
  if (o.builtGap === undefined) return null;
  const gap = o.builtGap;
  const notInCi = (): BuiltReason => ({
    key: 'not_in_ci',
    text: t('release-stepper:og.gap.notInCi'),
    title: t('release-stepper:og.gapTitle.notInCi'),
    readable: false,
  });
  const playNone = (): BuiltReason => ({
    key: 'play_none',
    text: t('release-stepper:og.gap.playNone'),
    title: t('release-stepper:og.gapTitle.playNone'),
    readable: false,
  });
  switch (gap) {
    case 'not_read':
      return options.ciTried === true
        ? notInCi()
        : {
            key: 'not_read',
            text: t('release-stepper:og.gap.notRead'),
            title: t('release-stepper:og.gapTitle.notRead'),
            readable: true,
          };
    case 'file_gone': {
      const on =
        typeof o.ciExpiredAt === 'number' && Number.isFinite(o.ciExpiredAt) ? o.ciExpiredAt : null;
      return {
        key: 'file_gone',
        text:
          on !== null
            ? t('release-stepper:og.gap.fileGoneOn', { date: formatDateTime(on) })
            : t('release-stepper:og.gap.fileGone'),
        title: t('release-stepper:og.gapTitle.fileGone'),
        readable: false,
      };
    }
    case 'github_unreachable':
      return {
        key: 'github_unreachable',
        text: t('release-stepper:og.gap.unreachable'),
        title: t('release-stepper:og.gapTitle.unreachable'),
        readable: false,
      };
    case 'github_no_access':
      return {
        key: 'github_no_access',
        text: t('release-stepper:og.gap.noAccess'),
        title: t('release-stepper:og.gapTitle.noAccess'),
        readable: false,
      };
    case 'no_repository':
      return {
        key: 'no_repository',
        text: t('release-stepper:og.gap.noRepository'),
        title: t('release-stepper:og.gapTitle.noRepository'),
        readable: false,
      };
    default:
      return playNone();
  }
}

/** One candidate's origin as text. `now` is the clock of the caller (a test passes its own). */
export function originView(
  o: OriginFields,
  now: number = Date.now(),
  options: OriginOptions = {},
): OriginView {
  const version = nonEmpty(o.version);
  const read = readVersionOf(o) !== null;
  const run = originRun(o.ci);
  let versionText: string;
  let versionTitle: string;
  if (read) {
    versionText = t('release-stepper:og.version', { version });
    versionTitle =
      o.origin === 'ci'
        ? t('release-stepper:og.versionFromCi')
        : t('release-stepper:og.versionFromStore');
  } else if (version !== null) {
    versionText = t('release-stepper:og.releaseName', { name: version });
    versionTitle = t('release-stepper:og.versionFromRelease');
  } else {
    versionText = t('release-stepper:og.versionUnknown');
    versionTitle = t('release-stepper:og.versionUnknownTitle');
  }
  const at = o.builtAt === null || o.builtAt === undefined ? null : o.builtAt;
  let builtText: string;
  let builtTitle: string;
  if (at !== null && Number.isFinite(at)) {
    const params = {
      when: formatDateTime(at),
      age: formatRelativeTime(at, { now }),
    };
    if (o.builtFrom === 'store') {
      builtText = t('release-stepper:og.uploadedAge', params);
      builtTitle = t('release-stepper:og.uploadedFromStore');
    } else {
      builtText = t('release-stepper:og.builtAge', params);
      builtTitle =
        run !== null
          ? t('release-stepper:og.builtFromCiRun', { run: run.text, detail: run.title })
          : t('release-stepper:og.builtFromCi');
    }
  } else {
    const why = builtReason(o, options);
    builtText = why
      ? t('release-stepper:og.builtUnknownWhy', { why: why.text })
      : t('release-stepper:og.builtUnknown');
    builtTitle = why ? why.title : t('release-stepper:og.builtUnknownTitle');
  }
  const seen =
    o.firstSeenAt !== null &&
    o.firstSeenAt !== undefined &&
    Number.isFinite(o.firstSeenAt) &&
    at === null
      ? o.firstSeenAt
      : null;
  return {
    versionText,
    version: read ? version : null,
    versionUnknown: version === null,
    versionTitle,
    builtText,
    builtKnown: at !== null && Number.isFinite(at),
    builtTitle,
    reason: at !== null && Number.isFinite(at) ? null : builtReason(o, options),
    matchNote: o.matchedBy === 'build_number_only' ? t('release-stepper:og.matchedByNumber') : null,
    matchTitle: t('release-stepper:og.matchedByNumberTitle'),
    firstSeenText:
      seen !== null ? t('release-stepper:og.firstSeen', { when: formatDateTime(seen) }) : null,
    firstSeenTitle: t('release-stepper:og.firstSeenTitle'),
    run,
  };
}

/**
 * The code (or build) to mark "Latest": the one with the newest known build date, only when no candidate without a date has a higher
 * number (a higher version code is built later, so an undated one above it could be the newer). Ties go to the higher number.
 * Null when no date is known, or when it cannot be said.
 */
export function latestOf(
  items: readonly { id: string; number: number; builtAt: number | null }[],
): string | null {
  let best: { id: string; number: number; builtAt: number } | null = null;
  for (const i of items) {
    if (i.builtAt === null) continue;
    if (
      best === null ||
      i.builtAt > best.builtAt ||
      (i.builtAt === best.builtAt && i.number > best.number)
    )
      best = { id: i.id, number: i.number, builtAt: i.builtAt };
  }
  if (best === null) return null;
  const top = best.number;
  if (items.some((i) => i.builtAt === null && i.number > top)) return null;
  return best.id;
}

// ---------------------------------------------------------------------------------------------
// The version being released against the version of the build

const DOTTED = /\d+(?:\.\d+)+/;

/**
 * The version a release name says, or null when it names none ("Spring release" says none). A name such as "2.00.1 (hotfix)" says
 * 2.00.1. Google Play release names are free text, so nothing else is read from one.
 */
export function versionInName(name: string | null | undefined): string | null {
  const text = nonEmpty(name);
  if (text === null) return null;
  const hit = DOTTED.exec(text);
  return hit ? hit[0] : null;
}

const parts = (version: string): number[] | null => {
  const p = version.trim().split('.');
  const out: number[] = [];
  for (const x of p) {
    if (!/^\d+$/.test(x)) return null;
    out.push(Number(x));
  }
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return out;
};

/** The same version, written alike or not ("2.00.1" and "2.0.1" are the same one; "2.1" and "2.1.0" too). */
export function sameVersion(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (x === null || y === null) return a.trim() === b.trim();
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

/**
 * "This build is version 2.00.0, but you are releasing 2.00.1": only when the version of the build was READ (a file or the store;
 * never a release name) and the release says a version. Non-blocking: it is a sentence to show, not a reason to refuse.
 */
export function versionMismatch(
  build: { version: string | null },
  releasing: string | null | undefined,
): string | null {
  const wanted = versionInName(releasing);
  if (build.version === null || wanted === null) return null;
  if (sameVersion(build.version, wanted)) return null;
  return t('release-stepper:og.mismatch', { build: build.version, releasing: wanted });
}
