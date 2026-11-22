/**
 * The managed git clones on the server (docs/adr/0005-local-clone-reads.md, "Clone upkeep"): the
 * shapes the API returns and the words for them. Pure functions; CloneCard.svelte draws them.
 */

import { formatBytes as formatBytesLocal } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

export type CloneView = {
  repositoryId: string;
  name: string | null;
  /** `local`: the managed copy of an attached local folder. */
  kind: 'github' | 'local';
  bytes: number;
  /** The size is a lower bound (the folder has more files than were counted). */
  sizeIsLowerBound: boolean;
  lastUsedAt: number;
  createdAt: number | null;
  inUse: boolean;
};

export type CloneLimits = { maxBytes: number; idleDays: number };

/** `GET /repositories/:id/clone`. */
export type RepositoryClone = { enabled: boolean; clone: CloneView | null; limits: CloneLimits };

/** `GET /clones`. */
export type CloneReport = {
  enabled: boolean;
  clones: CloneView[];
  totalBytes: number;
  limits: CloneLimits;
};

export type PurgeResult = { removed: number; freedBytes: number };

/** `1.5 MB` in the active language (binary multiples). */
export function formatBytes(bytes: number): string {
  return formatBytesLocal(bytes);
}

/** What the server does with idle clones, in a sentence (the limits come from the server's settings). */
export function limitsSentence(limits: CloneLimits): string {
  const size = formatBytes(limits.maxBytes);
  if (limits.idleDays > 0 && limits.maxBytes > 0)
    return t('builds:clone.limitsBoth', { count: limits.idleDays, size });
  if (limits.idleDays > 0) return t('builds:clone.limitsIdle', { count: limits.idleDays });
  if (limits.maxBytes > 0) return t('builds:clone.limitsSize', { size });
  return t('builds:clone.limitsNone');
}

/** The card's line about the clone, or the reason there is none. */
export function cloneSummary(state: Pick<RepositoryClone, 'enabled' | 'clone'>): string {
  if (!state.enabled) return t('builds:clone.summaryApi');
  if (!state.clone) return t('builds:clone.summaryNone');
  const key = state.clone.sizeIsLowerBound
    ? k('builds:clone.onServerAtLeast')
    : k('builds:clone.onServer');
  return t(key, { size: formatBytes(state.clone.bytes) });
}

/** What "Free space" reported. */
export function purgeMessage(result: PurgeResult): string {
  return result.removed === 0
    ? t('builds:clone.purgeNone')
    : t('builds:clone.purgeDone', { size: formatBytes(result.freedBytes) });
}
