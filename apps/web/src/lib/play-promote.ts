import { parseViewPath } from './app-scope.ts';
import { trackLabel } from './portfolio.ts';
import { releaseStepHref } from './release-stepper.ts';
import type { ReleaseSummary } from './types.ts';
import { supports } from '@mrm/core';

/**
 * "Promote to production" (docs/adr/0025-play-release-checks.md): a release that is in a Google Play track that is not production
 * (a workflow put it in internal testing, say) can be promoted from the app. Nothing new is written by this file: it finds the
 * releases that can be promoted and builds the address that opens "Prepare release" with the source track, the version codes and the
 * target track filled in. The steps that follow are the existing ones (stage, push the draft, release with a typed share).
 * Pure; written for the ES2017 web build.
 */

export const PRODUCTION = 'production';

export type Promote = {
  /** The track the release is in now. */
  from: string;
  /** The track to release in. */
  to: string;
  /** The version codes of the release. */
  codes: string[];
};

export type PromoteOption = Promote & {
  appId: string;
  /** The release name or version (what the table shows). */
  version: string;
  /** "Promote to production". */
  label: string;
  /** "internal testing" */
  fromLabel: string;
};

/**
 * Where a release from `track` goes by default. Production for every track: internal testing, closed testing (alpha or a custom
 * track) and open testing (beta) are all steps before it, and the person can choose another track in the first step.
 */
export const defaultTarget = (_from: string): string => PRODUCTION;

const sameTrack = (a: string | null, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

const SERVING = ['live', 'rolling_out'];
const isServing = (r: Pick<ReleaseSummary, 'status'>) =>
  r.status !== null && SERVING.indexOf(r.status) >= 0;

/**
 * Whether this release can be promoted: Android, a track that is not production, serving users (live or rolling out), with version
 * codes, and not already live in production with the same codes (`siblings` are the releases to look at, for example the same version).
 */
export function promoteOption(
  release: ReleaseSummary,
  siblings: readonly ReleaseSummary[] = [],
): PromoteOption | null {
  if (!supports(release.platform, 'releaseTracks') || release.track === null) return null;
  if (sameTrack(release.track, PRODUCTION)) return null;
  const codes = release.versionCodes ?? [];
  if (codes.length === 0 || !isServing(release)) return null;
  const done = siblings.some(
    (s) =>
      s.appId === release.appId &&
      sameTrack(s.track, PRODUCTION) &&
      isServing(s) &&
      codes.every((c) => (s.versionCodes ?? []).indexOf(c) >= 0),
  );
  if (done) return null;
  const to = defaultTarget(release.track);
  return {
    appId: release.appId,
    from: release.track,
    to,
    codes: [...codes],
    version: release.version,
    label: `Promote to ${trackLabel(to).toLowerCase()}`,
    fromLabel: trackLabel(release.track).toLowerCase(),
  };
}

/** The releases of an app that can be promoted, the newest version codes first. */
export function promoteOptions(releases: readonly ReleaseSummary[]): PromoteOption[] {
  const out: PromoteOption[] = [];
  for (const r of releases) {
    const option = promoteOption(r, releases);
    if (option !== null) out.push(option);
  }
  const top = (o: PromoteOption) => Math.max(0, ...o.codes.map((c) => Number(c) || 0));
  return out.sort((a, b) => top(b) - top(a));
}

/** The address of "Prepare release" for the Android record, with the track, the codes and the target filled in. */
export function promoteHref(option: PromoteOption): string {
  const base = releaseStepHref(option.appId, 'android', 'build');
  const at = base.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : base.slice(at + 1));
  params.set('from', option.from);
  params.set('to', option.to);
  params.set('codes', option.codes.join(','));
  return `${at < 0 ? base : base.slice(0, at)}?${params.toString()}`;
}

const TRACK = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;

/** What the address asks to promote, or null (no `from` and `codes`, or something that is not a track or a version code). */
export function promoteFromHash(hash: string): Promote | null {
  const query = parseViewPath(hash).query;
  const from = query.get('from');
  const codes = (query.get('codes') ?? '').split(',').filter((c) => c !== '');
  if (from === null || !TRACK.test(from) || codes.length === 0) return null;
  if (codes.length > 20 || codes.some((c) => !/^[0-9]{1,10}$/.test(c))) return null;
  const to = query.get('to');
  return { from, to: to !== null && TRACK.test(to) ? to : defaultTarget(from), codes };
}

/** The sentence under the first step that says what was filled in. */
export const promoteNote = (p: Promote): string =>
  `Promoting from ${trackLabel(p.from).toLowerCase()} to ${trackLabel(p.to).toLowerCase()}: version code${p.codes.length === 1 ? '' : 's'} ${p.codes.join(', ')} ${p.codes.length === 1 ? 'is' : 'are'} selected. Check the choice, then use it. Nothing is sent to Google Play until the last step.`;

/** The same address without the promotion (`from`, `to`, `codes`), so closing the steps does not leave a stale choice behind. */
export function withoutPromote(hash: string): string {
  const at = hash.indexOf('?');
  if (at < 0) return hash;
  const params = new URLSearchParams(hash.slice(at + 1));
  params.delete('from');
  params.delete('to');
  params.delete('codes');
  const search = params.toString();
  return search === '' ? hash.slice(0, at) : `${hash.slice(0, at)}?${search}`;
}
