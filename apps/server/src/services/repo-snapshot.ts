import type { RepoConnector } from '@kiln/connectors';
import { REPO_SNAPSHOT_TTL_MS as SNAPSHOT_TTL_MS } from '@kiln/core';
import { registerMapCache } from './cache-registry.ts';

export { SNAPSHOT_TTL_MS };

/**
 * One consistent view of a repository for one request, shared between requests for a short time.
 *
 * The file list and the text of the files are asked of GitHub once per commit: the commit is
 * resolved first (one small call), and everything else is cached by `repository id + commit sha`,
 * which never goes stale. So a scan, a listing and the change set made from it do not each list
 * the whole tree and read the same files again. A connector that cannot name the commit is read
 * as it is, with only a per request memo of the file texts.
 */

/** A connector that can pin reads to a commit (the GitHub one can). */
export type CommitResolver = { resolveCommit(ref?: string, signal?: AbortSignal): Promise<string> };

export type RepoSnapshot = {
  /** The commit sha when it could be resolved, else the branch that was read. */
  ref: string;
  files: string[];
  /** Reads a file at the snapshot, once: a second ask returns the first answer. */
  read: (path: string) => Promise<string | undefined>;
  /** The file list came from the cache, not from GitHub. */
  cachedTree: boolean;
};

export const SNAPSHOT_MAX_ENTRIES = 16;
/** File texts kept per commit. More than this is read again rather than held in memory. */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

type Entry = {
  at: number;
  files: string[];
  texts: Map<string, Promise<string | undefined>>;
  bytes: number;
};

const cache = new Map<string, Entry>();
registerMapCache(cache, {
  name: 'repo.snapshot',
  owner: 'services/repo-snapshot.ts',
  ttlMs: SNAPSHOT_TTL_MS,
  invalidatedBy: [],
  why: 'The file listing and texts of one repository branch at the time it was opened (keyed by repository and branch): an app event does not change the repository; a commit is seen after the TTL.',
  keys: 'all',
});

/** For tests. */
export function clearRepoSnapshots(): void {
  cache.clear();
}

const canResolve = (c: RepoConnector): c is RepoConnector & CommitResolver =>
  typeof (c as Partial<CommitResolver>).resolveCommit === 'function';

export async function openRepoSnapshot(input: {
  repositoryId: string;
  connector: RepoConnector;
  branch: string;
  now: () => number;
  /** Once aborted, no further request is sent. */
  signal?: AbortSignal;
}): Promise<RepoSnapshot> {
  const { connector, branch, signal } = input;
  const guard = () => {
    if (signal?.aborted) throw new Error('aborted');
  };
  guard();
  const sha = canResolve(connector) ? await connector.resolveCommit(branch, signal) : undefined;
  const ref = sha ?? branch;
  const key = sha ? `${input.repositoryId}@${sha}` : undefined;

  let entry = key ? cache.get(key) : undefined;
  if (entry && input.now() - entry.at > SNAPSHOT_TTL_MS) {
    cache.delete(key as string);
    entry = undefined;
  }
  const cachedTree = entry !== undefined;
  if (!entry) {
    guard();
    entry = { at: input.now(), files: await connector.listFiles(ref), texts: new Map(), bytes: 0 };
    if (key) {
      cache.set(key, entry);
      while (cache.size > SNAPSHOT_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
  }
  const held = entry;
  const read = async (path: string): Promise<string | undefined> => {
    let hit = held.texts.get(path);
    if (!hit) {
      guard();
      hit = connector.readFile(path, ref);
      held.texts.set(path, hit);
      hit.then(
        (text) => {
          held.bytes += text?.length ?? 0;
          // Over the budget: keep the answer for this request only if it is still being awaited.
          if (held.bytes > SNAPSHOT_MAX_BYTES) held.texts.delete(path);
        },
        () => held.texts.delete(path),
      );
    }
    return hit;
  };
  return { ref, files: held.files, read, cachedTree };
}
