import { STORE_BUILDS_READ_TTL_MS } from '@kiln/core';
import type { Api } from '../api.ts';
import { readCache } from '../read-cache.ts';
import type { StoreBuildFact } from './candidates.ts';
import { storeBuildFactOf } from './facts.ts';

/**
 * The store builds of each record (the TestFlight rows of the Builds page, `app_builds`), read once and kept for the model: the source of
 * the release candidates (candidates.ts). One read per record, shared with the Builds page's own read through the read cache; a failed read
 * leaves what there was (the model then falls back to the newest build of the release pipeline). Reads the server's stored rows plus the
 * artifact list it keeps for 30 seconds: nothing here writes.
 */
let byApp = $state<Record<string, readonly StoreBuildFact[] | undefined>>({});
const generation: Record<string, number> = {};
const TTL_MS = STORE_BUILDS_READ_TTL_MS;

export const storeBuildsStore = {
  /** The builds of a record, or null until they are read. */
  of(appId: string): readonly StoreBuildFact[] | null {
    return byApp[appId] ?? null;
  },
  /** Reads one record's store builds (`force`: a finished sync). Never throws. */
  async load(api: Api, workspaceId: string, appId: string, force = false): Promise<void> {
    const mine = (generation[appId] = (generation[appId] ?? 0) + 1);
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'builds',
        key: `store-builds/${appId}`,
        force,
        ttlMs: TTL_MS,
        load: () => api.buildArtifacts(workspaceId, appId),
      });
      if (mine === generation[appId]) byApp[appId] = out.store.map(storeBuildFactOf);
    } catch {
      // Not read: the model knows the pipeline's newest build instead.
    }
  },
};
