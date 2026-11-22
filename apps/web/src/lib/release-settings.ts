/**
 * The per-app release settings of Google Play (docs/adr/0029-direct-play-release.md): a default share and whether a staged rollout is
 * offered. The rules are in @kiln/core (pure, tested); this file turns them into what a release input starts as. Reads only.
 */
import {
  type PlayReleaseSettings,
  type RolloutOffer,
  rolloutOffer,
  type StagedRolloutMode,
  sharePrefill,
} from '@kiln/core';
import { t } from './i18n/t.ts';

export type ReleaseSettingsView = {
  settings: PlayReleaseSettings;
  /** From the stored releases: a production release that is live, rolling out or halted. */
  earlierProductionRelease: boolean;
};

/** The label of each mode in the active language (read when used, so a change of language shows). */
export const STAGED_ROLLOUT_LABEL: Readonly<Record<StagedRolloutMode, string>> = {
  get auto() {
    return t('release:settings.staged.auto');
  },
  get always_ask() {
    return t('release:settings.staged.alwaysAsk');
  },
  get never() {
    return t('release:settings.staged.never');
  },
};

export type ReleaseInputs = {
  offer: RolloutOffer;
  /** What the share input starts as, in percent as text. A start only: the typed phrase still confirms it. */
  share: string;
};

/**
 * What the share of a Google Play release starts as and whether it is asked at all. `settings` null (not read yet, or a role that may
 * not read it): the rollout is offered and the input starts from what was staged, so nothing is hidden by a failed read.
 */
export function releaseInputsFor(input: {
  view: ReleaseSettingsView | null;
  track: string;
  /** The staged `user_fraction` as a percent text ('' when none). It wins over the default. */
  stagedPercent: string;
}): ReleaseInputs {
  const offer = rolloutOffer({
    mode: input.view?.settings.stagedRollout ?? 'always_ask',
    track: input.track,
    earlierProductionRelease: input.view?.earlierProductionRelease ?? true,
  });
  return {
    offer,
    share: sharePrefill({
      offer,
      stagedPercent: input.stagedPercent,
      defaultPercent: input.view?.settings.defaultSharePercent ?? null,
    }),
  };
}

/** The fraction sent when no staged rollout is offered: everyone. */
export const EVERYONE = 1;

/** The text of a typed default share ('' clears it) as a percent 1 to 100, or null when it is not valid. */
export function parseDefaultShare(
  text: string,
): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim().replace(/%$/, '').trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= 1 && n <= 100 ? { ok: true, value: n } : { ok: false };
}
