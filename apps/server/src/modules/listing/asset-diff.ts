import { createHash } from 'node:crypto';
import {
  ASSET_SYNC_LIMITS,
  type AssetDiffSet,
  type AssetDiffView,
  type AssetKind,
  type AssetPlatform,
  assetStoreOf,
  compareSet,
  compareTotals,
  deviceLabel,
  IMESSAGE_PREFIX,
  type RepoSideFile,
  type StoreImageFile,
  type StoreImageSet,
  storeSetKey,
} from '@kiln/core';
import type { ManagedApp } from '../../services/apps.ts';
import type { Failure } from '../../services/repositories.ts';
import type { AssetView } from './asset-index.ts';
import type { AssetHandle, AssetsContext } from './asset-repo.ts';
import { openAssets } from './asset-repo.ts';
import { getStoreImages, type StoreImagesContext, storeSideOf } from './store-images.ts';

/**
 * The repository's graphics set against the store's (docs/adr/0012-assets-two-way-sync.md): per file, identical, probably the
 * same, differs, only in the repository or only in the store. Pairing is by position within a set (locale, kind, device); the
 * store's display order is its position, the repository's is the order of the asset index.
 *
 * A checksum is compared only when the store gives one (Google Play always, the App Store only for images this server
 * uploaded: it marks them with the first 32 hex of the SHA-256). The repository file is read for that, within a budget; a
 * file that was not read is compared by pixel size and byte size and the answer says so (`likely_same`).
 */

export type AssetSyncContext = { assets: AssetsContext; store: StoreImagesContext };

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type RepoSet = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  files: AssetView[];
};

const isPlaced = (a: AssetView): boolean =>
  a.origin === 'store' &&
  a.format !== 'video' &&
  a.kind !== 'app_icon' &&
  a.kind !== 'preview' &&
  !(a.device ?? '').startsWith(IMESSAGE_PREFIX) &&
  (a.kind !== 'screenshot' || a.device !== null);

/** The files of the asset index that belong to a store set, by (locale, kind, device), in order. */
export function repoSetsOf(assets: readonly AssetView[]): {
  sets: Map<string, RepoSet>;
  unplaced: number;
} {
  const sets = new Map<string, RepoSet>();
  let unplaced = 0;
  for (const a of assets) {
    if (
      a.origin !== 'store' ||
      a.format === 'video' ||
      a.kind === 'app_icon' ||
      a.kind === 'preview'
    )
      continue;
    if ((a.device ?? '').startsWith(IMESSAGE_PREFIX)) continue;
    if (!isPlaced(a)) {
      unplaced++;
      continue;
    }
    const key = `${a.locale}\0${a.kind}\0${a.device ?? ''}`;
    const set = sets.get(key) ?? { locale: a.locale, kind: a.kind, device: a.device, files: [] };
    set.files.push(a);
    sets.set(key, set);
  }
  for (const set of sets.values())
    set.files.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  return { sets, unplaced };
}

const sideOf = (a: AssetView): RepoSideFile => ({
  path: a.path,
  oid: a.oid,
  sha256: null,
  md5: null,
  bytes: a.bytes,
  width: a.width,
  height: a.height,
});

export type DiffOutcome = { ok: true; diff: AssetDiffView; cachedStore: boolean } | Failure;

export async function buildAssetDiff(
  ctx: AssetSyncContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    fresh?: boolean;
    gate?: () => Failure | undefined;
    /** Compare the repository at this commit (a full sha) instead of the branch tip (the release asset proposal). */
    commit?: string;
  },
): Promise<DiffOutcome> {
  const { app } = input;
  const platform: AssetPlatform = app.platform;
  const store = await getStoreImages(ctx.store, {
    workspaceId: input.workspaceId,
    app,
    actor: input.actor,
    ...(input.fresh ? { fresh: true } : {}),
  });
  if (!store.ok) return store;
  const opened = await openAssets(
    ctx.assets,
    { workspaceId: input.workspaceId, app, ...(input.commit ? { commit: input.commit } : {}) },
    input.actor,
    { ...(input.gate ? { onCompute: input.gate } : {}) },
  );
  if (!opened.ok) return opened;
  const handle = opened.handle;
  const view = handle.view;
  const notes: string[] = [...store.view.notes];
  if (view.status === 'no_repository')
    notes.push(
      'This app has no linked repository, so every store image is shown as only in the store.',
    );
  if (view.partial.partial)
    notes.push(
      'The repository could not be read completely (a read budget ran out), so some of its files are missing here.',
    );
  const repo = repoSetsOf(view.status === 'ok' ? view.assets : []);

  const keyOf = (locale: string, kind: AssetKind, device: string | null) =>
    storeSetKey(platform, locale, { kind, device });
  const storeSets = new Map<string, StoreImageSet>();
  for (const s of store.view.sets) {
    if ((s.device ?? '').startsWith(IMESSAGE_PREFIX)) continue;
    storeSets.set(keyOf(s.locale, s.kind, s.device), s);
  }
  const repoByKey = new Map<string, RepoSet>();
  for (const r of repo.sets.values()) repoByKey.set(keyOf(r.locale, r.kind, r.device), r);
  const keys = [...new Set([...storeSets.keys(), ...repoByKey.keys()])].sort();

  // Reading repository files for their checksums: only where the store has one to compare with, within a budget.
  let budget = ASSET_SYNC_LIMITS.maxPullBytes;
  let reads = 0;
  let skipped = 0;
  const sets: AssetDiffSet[] = [];
  for (const key of keys) {
    const s = storeSets.get(key);
    const r = repoByKey.get(key);
    const files = (r?.files ?? []).map(sideOf);
    const storeFiles: StoreImageFile[] = s?.files ?? [];
    for (let i = 0; i < Math.min(files.length, storeFiles.length); i++) {
      const sf = storeFiles[i] as StoreImageFile;
      const rf = files[i] as RepoSideFile;
      if (sf.checksum === null || rf.bytes === null) continue;
      if (reads >= 60 || rf.bytes > budget) {
        skipped++;
        continue;
      }
      const read = await readSums(handle, rf.path);
      if (!read) continue;
      reads++;
      budget -= read.bytes;
      rf.sha256 = read.sha256;
      rf.md5 = read.md5;
    }
    const rows = compareSet(files, storeFiles);
    const totals = compareTotals(rows);
    const locale = (s ?? r)?.locale ?? '';
    const kind = (s ?? r)?.kind as AssetKind;
    const device = (s ?? r)?.device ?? null;
    sets.push({
      platform,
      locale,
      kind,
      device,
      deviceLabel: deviceLabel(assetStoreOf(app.platform), device),
      target: s?.target ?? null,
      rows,
      totals,
      inSync: totals.differs === 0 && totals.only_repo === 0 && totals.only_store === 0,
    });
  }
  if (skipped > 0)
    notes.push(
      `${skipped} repository file${skipped === 1 ? ' was' : 's were'} not read for a checksum (a read budget ran out), so they are compared by size only.`,
    );
  const totals = compareTotals(sets.flatMap((s) => s.rows));
  const diff: AssetDiffView = {
    appId: app.id,
    platform,
    readAt: store.view.readAt,
    commit: view.commit,
    version: store.view.version,
    sets,
    totals,
    unplaced: store.view.unplaced + repo.unplaced,
    notes,
  };
  return { ok: true, diff, cachedStore: store.cached };
}

async function readSums(
  handle: AssetHandle,
  path: string,
): Promise<{ sha256: string; md5: string; bytes: number } | undefined> {
  const file = await handle.readFile(path);
  if (!file.ok) return undefined;
  return {
    sha256: createHash('sha256').update(file.bytes).digest('hex'),
    md5: createHash('md5').update(file.bytes).digest('hex'),
    bytes: file.bytes.length,
  };
}

/** The store counts for `GET .../assets`: from the cached store read only, never a store request. */
export { storeSideOf };
