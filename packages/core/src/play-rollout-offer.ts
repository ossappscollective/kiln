/**
 * Whether a staged rollout is offered for a Google Play release, and what the share starts as (docs/adr/0029-direct-play-release.md).
 * Pure; ES2017 only (the web app imports this file). Nothing here writes anything and nothing here confirms a share: the person still
 * confirms it in the typed phrase of the release.
 *
 * VERIFIED (Google Play Console help, answer 6346149, read 2026-11-20): a staged rollout is for app UPDATES, not for the first
 * publication of an app. NOT documented by Google and not detectable through the API: small apps get no rollout option in Play Console
 * until they are bigger (a person reported it). So the rule is: when the stored releases show no earlier production release the
 * rollout is not offered (100%), a per-app mode lets the person switch it off (`never`) or always offer it (`always_ask`), and when
 * Google refuses a fraction anyway that is shown in plain words and never retried by itself.
 */

export const STAGED_ROLLOUT_MODES = ['auto', 'always_ask', 'never'] as const;
export type StagedRolloutMode = (typeof STAGED_ROLLOUT_MODES)[number];

export const isStagedRolloutMode = (value: unknown): value is StagedRolloutMode =>
  typeof value === 'string' && (STAGED_ROLLOUT_MODES as readonly string[]).indexOf(value) >= 0;

/** The per-app release settings (stored values only). */
export type PlayReleaseSettings = {
  /** A percent, 1 to 100. Null: no default, the person is asked. */
  defaultSharePercent: number | null;
  stagedRollout: StagedRolloutMode;
};

export const DEFAULT_PLAY_RELEASE_SETTINGS: PlayReleaseSettings = {
  defaultSharePercent: null,
  stagedRollout: 'auto',
};

/** The release states of a stored release that mean "this track served users": live, rolling out, halted. */
const SERVED = ['live', 'rolling_out', 'halted'];

/**
 * An earlier production release exists: a stored release (as of the last sync) in the production track that is live, rolling out or
 * halted. A draft, a release in review or a release in another track does not count.
 */
export function hasEarlierProductionRelease(
  releases: readonly { track: string | null; status: string | null }[],
): boolean {
  return releases.some(
    (r) => r.track === 'production' && r.status !== null && SERVED.indexOf(r.status) >= 0,
  );
}

export type RolloutOffer =
  | { offered: true; reason: null; message: null }
  | { offered: false; reason: 'first_release' | 'never'; message: string };

export const FIRST_RELEASE_MESSAGE =
  'This is the first release in production: Google Play does not offer a staged rollout for it. It goes to everyone (100%).';
export const NEVER_MESSAGE =
  'A staged rollout is switched off for this app (Staged rollout on Google Play in its settings). The release goes to everyone (100%).';

/**
 * `never`: not offered. `always_ask`: offered. `auto`: offered unless the release is for the production track and no earlier
 * production release exists (another track has no such rule here).
 */
export function rolloutOffer(input: {
  mode: StagedRolloutMode;
  track: string;
  earlierProductionRelease: boolean;
}): RolloutOffer {
  if (input.mode === 'never') return { offered: false, reason: 'never', message: NEVER_MESSAGE };
  if (input.mode === 'auto' && input.track.trim() === 'production' && !input.earlierProductionRelease)
    return { offered: false, reason: 'first_release', message: FIRST_RELEASE_MESSAGE };
  return { offered: true, reason: null, message: null };
}

/**
 * What the share input starts as, in percent as text: 100 when no rollout is offered; else a share that was staged as an intention
 * (it wins), else the default of the app, else nothing (the person is asked). A start only: it is never confirmed for the person.
 */
export function sharePrefill(input: {
  offer: RolloutOffer;
  stagedPercent: string;
  defaultPercent: number | null;
}): string {
  if (!input.offer.offered) return '100';
  if (input.stagedPercent.trim() !== '') return input.stagedPercent.trim();
  return input.defaultPercent === null ? '' : String(input.defaultPercent);
}

/** True when the words of a store refusal are about the share or the rollout. */
export const mentionsFractionRefusal = (message: string): boolean =>
  /user\s*fraction|fraction|staged\s*rollout|rollout/i.test(message);

export const FRACTION_REFUSED_MESSAGE =
  'Google Play did not accept a staged rollout for this app. Release to everyone (100%) instead, or change "Staged rollout on Google Play" in the settings of the app. Nothing was retried.';

/**
 * The plain message for a refusal that is about a staged rollout, or null when the words are about something else. Only when a share
 * below 100% was asked for (a refusal of a 100% release is not about the share).
 */
export function fractionRefusalNotice(message: string, askedFraction: number | null): string | null {
  if (askedFraction === null || !(askedFraction < 1)) return null;
  return mentionsFractionRefusal(message) ? FRACTION_REFUSED_MESSAGE : null;
}
