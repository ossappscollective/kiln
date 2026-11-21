/**
 * The managed git clones on the server (docs/adr/0005-local-clone-reads.md, "Clone upkeep"): the
 * shapes the API returns and the words for them. Pure functions; CloneCard.svelte draws them.
 */

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

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `1.5 MB`: binary multiples, one decimal under 10, none above. `at least` is for a lower bound. */
export function formatBytes(bytes: number, lowerBound = false): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text =
    unit === 0
      ? String(Math.round(value))
      : value < 10
        ? value.toFixed(1)
        : String(Math.round(value));
  return `${lowerBound ? 'at least ' : ''}${text} ${UNITS[unit]}`;
}

/** What the server does with idle clones, in a sentence (the limits come from the server's settings). */
export function limitsSentence(limits: CloneLimits): string {
  const parts: string[] = [];
  if (limits.idleDays > 0)
    parts.push(
      `removed after ${limits.idleDays} ${limits.idleDays === 1 ? 'day' : 'days'} without use`,
    );
  if (limits.maxBytes > 0)
    parts.push(
      `the least recently used are removed above ${formatBytes(limits.maxBytes)} in total`,
    );
  if (parts.length === 0) return 'Clones are kept until the repository is disconnected.';
  return `Clones are ${parts.join('; ')}. A removed clone is fetched again by the next read.`;
}

/** The card's line about the clone, or the reason there is none. */
export function cloneSummary(state: Pick<RepositoryClone, 'enabled' | 'clone'>): string {
  if (!state.enabled)
    return 'Reads use the GitHub API (KILN_READS=api), so nothing is kept on disk.';
  if (!state.clone) return 'No clone on disk yet. The next scan or listing makes one.';
  return `${formatBytes(state.clone.bytes, state.clone.sizeIsLowerBound)} on the server.`;
}

/** What "Free space" reported. */
export function purgeMessage(result: PurgeResult): string {
  return result.removed === 0
    ? 'There was no clone to remove.'
    : `Removed the clone and freed ${formatBytes(result.freedBytes)}. The next read fetches it again.`;
}
