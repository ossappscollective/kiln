import type { Platform } from '@kiln/core';
import type {
  EasBuildView,
  EasStatusView,
  EasSubmissionView,
  EasUpdateView,
} from './eas-status.ts';

/**
 * The Expo card of the app Overview (docs/ux-ia.md): per platform of the app, the latest EAS build and the latest EAS submission, from the
 * STORED snapshot only (`GET .../eas/status`, no call to Expo). Pure logic; written for the ES2017 web build.
 */

export type ExpoRowState = 'loading' | 'unavailable' | 'not_linked' | 'no_builds' | 'ready';

/** The current update of one channel, from the stored read. */
export type OtaChannel = { channel: string; update: EasUpdateView };

export type OtaSummary = {
  /** `ready`: at least one channel has a stored update; `none`: the read found none (or nothing was read yet: `readAt` is null). */
  state: 'ready' | 'none';
  channels: OtaChannel[];
  /** When the updates were last read (epoch ms), null before the first successful read. */
  readAt: number | null;
  /** The last read of the updates failed: what is shown is older than that. */
  failed: boolean;
};

export type ExpoOverviewRow = {
  appId: string;
  platform: Platform;
  state: ExpoRowState;
  build: EasBuildView | null;
  submission: EasSubmissionView | null;
  /** When the snapshot was last read from Expo (epoch ms), null before the first read. */
  readAt: number | null;
  /** The current update per channel, from the stored read; null when the row has no snapshot to show. */
  ota: OtaSummary | null;
};

/** The current update per channel: channels sorted by name, only those with a stored current update. A status from before the updates were stored reads as none. */
export function otaSummary(view: EasStatusView): OtaSummary {
  const updates = view.updates;
  const channels: OtaChannel[] = [];
  for (const c of updates?.channels ?? []) {
    if (c.current !== null) channels.push({ channel: c.channel, update: c.current });
  }
  channels.sort((a, b) => a.channel.localeCompare(b.channel));
  return {
    state: channels.length > 0 ? 'ready' : 'none',
    channels,
    readAt: updates?.readAt ?? null,
    failed: (updates?.lastError ?? null) !== null,
  };
}

/** EAS builds iOS and Android only: a macOS (or any other) record has no card row. */
export const expoSupported = (platform: Platform): boolean =>
  platform === 'ios' || platform === 'android';

const byNewest = <T extends { createdAt: number | null }>(list: readonly T[]): T[] =>
  list.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

/** The newest build of the platform (the snapshot is newest first, but this does not rely on it). */
export function latestBuild(
  builds: readonly EasBuildView[],
  platform: Platform,
): EasBuildView | null {
  return byNewest(builds.filter((b) => b.platform === platform))[0] ?? null;
}

export function latestSubmission(
  submissions: readonly EasSubmissionView[],
  platform: Platform,
): EasSubmissionView | null {
  return byNewest(submissions.filter((s) => s.platform === platform))[0] ?? null;
}

/**
 * One row. `view` is the stored snapshot, `undefined` while it loads, `null` when it could not be read (not allowed, or an error).
 */
export function expoRow(
  app: { id: string; platform: Platform },
  view: EasStatusView | null | undefined,
): ExpoOverviewRow {
  const row = {
    appId: app.id,
    platform: app.platform,
    build: null,
    submission: null,
    readAt: null,
    ota: null,
  };
  if (view === undefined) return { ...row, state: 'loading' };
  if (view === null) return { ...row, state: 'unavailable' };
  if (view.project === null) return { ...row, state: 'not_linked' };
  const build = latestBuild(view.builds, app.platform);
  const submission = latestSubmission(view.submissions, app.platform);
  const readAt = view.sync.readAt;
  const ota = otaSummary(view);
  if (build === null && submission === null) return { ...row, readAt, ota, state: 'no_builds' };
  return { ...row, build, submission, readAt, ota, state: 'ready' };
}

/** The rows of the card: one per iOS or Android record, in the order given. Nothing at all (hidden) when the app has none. */
export function expoRows(
  apps: readonly { id: string; platform: Platform }[],
  views: Record<string, EasStatusView | null | undefined>,
): ExpoOverviewRow[] {
  return apps.filter((a) => expoSupported(a.platform)).map((a) => expoRow(a, views[a.id]));
}

/** Drawn when there is a row, and not only for rows that could not be read (a person who may not read builds, or a failed read, sees nothing). */
export const expoCardVisible = (rows: readonly ExpoOverviewRow[]): boolean =>
  rows.length > 0 && rows.some((r) => r.state !== 'unavailable');
