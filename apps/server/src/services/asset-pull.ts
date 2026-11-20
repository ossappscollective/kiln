import { ASSET_SYNC_LIMITS, type AssetPlatform, type AssetSlot, type FileChange, IMESSAGE_PREFIX, storeImageKey, storeSetKey, supports } from '@mrm/core';
import type { ManagedApp } from './apps.ts';
import { type AssetSyncContext, repoSetsOf } from './asset-diff.ts';
import { openAssets } from './asset-repo.ts';
import { layoutFor, planSet, type Wanted } from './asset-repo-plan.ts';
import { stepsToChanges } from './asset-repo-write.ts';
import { recordAudit } from './audit.ts';
import { type ChangeSetView, createFileChangeSet } from './change-sets.ts';
import { emitEvent } from './events.ts';
import { type Failure, failure } from './repositories.ts';
import { gitBlobOid } from './staged-asset-blobs.ts';
import { getStoreImages, storeImageBytes } from './store-images.ts';

/**
 * Pull from the store (docs/adr/0012-assets-two-way-sync.md): the store's current images become a change set for the app's
 * repository, through the usual review, approval and apply flow. Never a write to the repository's default branch, never a
 * write to a store.
 *
 * Every image is fetched from the address the store itself gave (an allowlist of the stores' CDN hosts, https, no redirect off the
 * list, a size cap per file and a budget for the pull: store-image-net.ts). Checksums:
 * - Google Play gives a SHA-256 of each image: a file whose bytes do not match is NOT taken.
 * - The App Store gives none (only the mark of this server's own uploads): a file that does not match that mark is taken and
 *   reported as `unverified`, because the CDN may serve a re-encoded rendition (UNVERIFIED: whether the template URL serves
 *   the original bytes).
 *
 * Which files: everything (default), whole sets (`sets`: `ios/en-US/screenshot:iphone_6_9`), or single images (`files`:
 * the set key and `#position`). A file that is already in the repository with the same bytes is not touched. Files of the
 * repository the store does not have stay unless `prune` is set. Paths follow the repository's own layout (asset-repo-plan.ts).
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type PullInput = {
  workspaceId: string;
  app: ManagedApp;
  actor: Actor;
  sets?: readonly string[] | undefined;
  files?: readonly string[] | undefined;
  prune?: boolean | undefined;
  gate?: (() => Failure | undefined) | undefined;
};

export type PullSkip = {
  key: string;
  reason:
    | 'checksum_mismatch'
    | 'budget'
    | 'format'
    | 'download_failed'
    | 'no_address'
    | 'repo_unreadable'
    | 'layout'
    | 'gap'
    | 'timeout';
  message: string;
};

export type PullReport = {
  /** Null when nothing had to change. */
  changeSet: ChangeSetView | null;
  written: number;
  deleted: number;
  unchanged: number;
  /** Bytes downloaded. */
  bytes: number;
  skipped: PullSkip[];
  /** Files that were taken although the store gave no checksum to hold them to. */
  unverified: string[];
  /** Files of the repository the store does not have, left alone. */
  left: string[];
  notes: string[];
};

const MAX_PULL_MS = 120_000;

const sums = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length === y.length
    ? x === y
    : x.length < y.length
      ? x.length >= 16 && y.startsWith(x)
      : y.length >= 16 && x.startsWith(y);
};

export async function pullStoreImages(
  ctx: AssetSyncContext,
  input: PullInput,
): Promise<{ ok: true; report: PullReport } | Failure> {
  const { app } = input;
  const repoCtx = ctx.assets.repo;
  if (!app.repositoryId)
    return failure(
      422,
      'no_repository',
      'This app has no linked repository to pull the images into.',
    );
  const platform: AssetPlatform = app.platform;
  const store = await getStoreImages(ctx.store, {
    workspaceId: input.workspaceId,
    app,
    actor: input.actor });
  if (!store.ok) return store;
  const opened = await openAssets(
    ctx.assets,
    { workspaceId: input.workspaceId, app },
    input.actor,
    { ...(input.gate ? { onCompute: input.gate } : {}) },
  );
  if (!opened.ok) return opened;
  const { handle } = opened;
  const view = handle.view;
  if (view.status === 'no_repository' || view.commit === null || view.target === null)
    return failure(
      422,
      'no_repository',
      'This app has no linked repository to pull the images into.',
    );

  // Selection.
  const setKeys = new Map<string, (typeof store.view.sets)[number]>();
  const imageKeys = new Map<
    string,
    { set: (typeof store.view.sets)[number]; position: number; ref: string }
  >();
  for (const s of store.view.sets) {
    if ((s.device ?? '').startsWith(IMESSAGE_PREFIX)) continue;
    if (supports(platform, 'screenshotsByDevice') && s.kind !== 'screenshot') continue;
    if (s.kind === 'preview' || s.kind === 'app_icon') continue;
    const slot: AssetSlot = { kind: s.kind, device: s.device };
    setKeys.set(storeSetKey(platform, s.locale, slot), s);
    for (const f of s.files)
      imageKeys.set(storeImageKey(platform, s.locale, slot, f.position), {
        set: s,
        position: f.position,
        ref: f.ref });
  }
  const wantSets = new Set(input.sets ?? []);
  const wantFiles = new Set(input.files ?? []);
  for (const k of wantSets)
    if (!setKeys.has(k))
      return failure(
        422,
        'unknown_selection',
        'A set is not one the store holds. Read the comparison again.',
        { set: k },
      );
  for (const k of wantFiles)
    if (!imageKeys.has(k))
      return failure(
        422,
        'unknown_selection',
        'An image is not one the store holds. Read the comparison again.',
        { file: k },
      );
  const everything = wantSets.size === 0 && wantFiles.size === 0;

  const skipped: PullSkip[] = [];
  const unverified: string[] = [];
  const notes: string[] = [];
  let downloadedBytes = 0;
  let readBytes = 0;
  let count = 0;
  const started = repoCtx.now();
  const repoSets = repoSetsOf(view.assets);
  const existing = view.assets
    .filter((a) => a.origin === 'store')
    .map((a) => ({ path: a.path, locale: a.locale, kind: a.kind, device: a.device }));
  const changes: FileChange[] = [];
  let written = 0;
  let deleted = 0;
  let unchanged = 0;
  const left: string[] = [];

  for (const [setKey, set] of setKeys) {
    const slot: AssetSlot = { kind: set.kind, device: set.device };
    const positionsWanted = set.files.filter(
      (f) =>
        everything ||
        wantSets.has(setKey) ||
        wantFiles.has(storeImageKey(platform, set.locale, slot, f.position)),
    );
    if (positionsWanted.length === 0) continue;
    const whole = everything || wantSets.has(setKey) || positionsWanted.length === set.files.length;
    const repoSet = repoSets.sets.get(`${set.locale}\0${set.kind}\0${set.device ?? ''}`);
    const current = (repoSet?.files ?? []).map((a) => ({ path: a.path, oid: a.oid }));
    const laid = layoutFor({
      platform: app.platform,
      locale: set.locale,
      slot,
      roots: view.target.roots,
      existing });
    if (!laid.ok) {
      for (const f of positionsWanted)
        skipped.push({
          key: storeImageKey(platform, set.locale, slot, f.position),
          reason: 'layout',
          message: laid.message });
      continue;
    }
    // The bytes of each wanted store image.
    const fetched = new Map<number, { bytes: Uint8Array; format: 'png' | 'jpeg'; oid: string }>();
    for (const f of positionsWanted) {
      const key = storeImageKey(platform, set.locale, slot, f.position);
      const fail = (reason: PullSkip['reason'], message: string) =>
        skipped.push({ key, reason, message });
      if (repoCtx.now() - started > MAX_PULL_MS) {
        fail('timeout', 'The pull ran out of time before this image.');
        continue;
      }
      if (
        count >= ASSET_SYNC_LIMITS.maxPullFiles ||
        downloadedBytes + readBytes >= ASSET_SYNC_LIMITS.maxPullBytes
      ) {
        fail(
          'budget',
          `A pull takes at most ${ASSET_SYNC_LIMITS.maxPullFiles} files and ${Math.floor(ASSET_SYNC_LIMITS.maxPullBytes / (1024 * 1024))} MB. Pull the rest in another run.`,
        );
        continue;
      }
      if (!f.downloadable) {
        fail('no_address', 'The store gave no image address for this file.');
        continue;
      }
      const got = await storeImageBytes(ctx.store, {
        workspaceId: input.workspaceId,
        appId: app.id,
        ref: f.ref,
        maxBytes: Math.min(
          ASSET_SYNC_LIMITS.maxDownloadBytes,
          ASSET_SYNC_LIMITS.maxPullBytes - downloadedBytes - readBytes,
        ) });
      if (!got.ok) {
        // A rate limit of the host ends the pull for this run: the rest would only fail the same way.
        fail('download_failed', String(got.body.message ?? 'The image could not be fetched.'));
        continue;
      }
      const { image, entry } = got;
      downloadedBytes += image.bytes.length;
      count++;
      if (image.format !== 'png' && image.format !== 'jpeg') {
        fail(
          'format',
          `The store serves this image as ${image.format.toUpperCase()}; only PNG and JPEG are put in a repository from here.`,
        );
        continue;
      }
      if (entry.checksum !== null) {
        const mine = entry.checksumKind === 'md5' ? null : image.sha256;
        const ok = mine === null ? true : sums(entry.checksum, mine);
        if (!ok) {
          if (!supports(platform, 'screenshotsByDevice')) {
            fail(
              'checksum_mismatch',
              'The bytes did not match the SHA-256 Google Play gave, so the file was not taken.',
            );
            continue;
          }
          unverified.push(key);
        }
      } else if (supports(platform, 'screenshotsByDevice')) {
        unverified.push(key);
      }
      fetched.set(f.position, {
        bytes: image.bytes,
        format: image.format,
        oid: gitBlobOid(image.bytes) });
    }

    // The wanted set.
    let wanted: Wanted[];
    if (whole) {
      wanted = [];
      for (const f of set.files) {
        const got = fetched.get(f.position);
        if (!got) {
          // Not taken (or not asked for): keep what the repository has at this position, if anything.
          const keep = current[f.position - 1];
          if (keep && keep.oid !== null)
            wanted.push({ kind: 'existing', path: keep.path, oid: keep.oid });
          continue;
        }
        const here = current[wanted.length];
        wanted.push(
          here && here.oid === got.oid
            ? { kind: 'existing', path: here.path, oid: got.oid }
            : { kind: 'new', oid: got.oid, format: got.format },
        );
      }
    } else {
      wanted = current
        .filter((c) => c.oid !== null)
        .map((c) => ({ kind: 'existing' as const, path: c.path, oid: c.oid as string }));
      for (const f of positionsWanted) {
        const got = fetched.get(f.position);
        if (!got) continue;
        const index = f.position - 1;
        if (index < wanted.length) {
          const here = wanted[index] as Wanted;
          if (here.kind === 'existing' && here.oid === got.oid) continue;
          wanted[index] = { kind: 'new', oid: got.oid, format: got.format };
        } else if (index === wanted.length) {
          wanted.push({ kind: 'new', oid: got.oid, format: got.format });
        } else {
          skipped.push({
            key: storeImageKey(platform, set.locale, slot, f.position),
            reason: 'gap',
            message:
              'The repository has fewer images before this one; pull the images before it too.' });
          fetched.delete(f.position);
        }
      }
    }
    if (wanted.length === 0) continue;
    const plan = planSet({ layout: laid.layout, current, wanted, prune: input.prune === true });
    unchanged += plan.unchanged;
    left.push(...plan.left);
    if (plan.renamed)
      notes.push(
        `${setKey}: the files were renamed (${laid.layout.stem}-01, -02, ...) so that their names sort in the store's order.`,
      );

    // From steps to file changes. The bytes of the new files are what was fetched.
    const newBytes = (index: number): Uint8Array | undefined => {
      const w = wanted[index];
      if (w?.kind !== 'new') return undefined;
      for (const f of fetched.values()) if (f.oid === w.oid) return f.bytes;
      return undefined;
    };
    const done = await stepsToChanges({ handle, steps: plan.steps, newBytes });
    readBytes += done.readBytes;
    changes.push(...done.changes);
    written += done.written;
    deleted += done.deleted;
    for (const message of done.failures)
      skipped.push({ key: setKey, reason: 'repo_unreadable', message });
  }
  if (readBytes + downloadedBytes > ASSET_SYNC_LIMITS.maxPullBytes * 2)
    notes.push('The pull read more of the repository than usual.');

  const report: PullReport = {
    changeSet: null,
    written,
    deleted,
    unchanged,
    bytes: downloadedBytes,
    skipped,
    unverified,
    left,
    notes };
  if (changes.length === 0) {
    if (unchanged > 0 && skipped.length === 0)
      notes.push('Everything the store has is already in the repository.');
    return { ok: true, report };
  }
  const summary = `Pull ${written + deleted === 1 ? '1 store image' : `${written + deleted} store image changes`} into the repository (${app.name})`;
  const made = await createFileChangeSet(
    repoCtx,
    {
      workspaceId: input.workspaceId,
      repositoryId: app.repositoryId,
      summary,
      files: changes,
      origin: { v: 1, source: 'store_assets_pull', appId: app.id },
      auditDetail: {
        appId: app.id,
        platform: app.platform,
        source: 'store_assets_pull',
        written,
        deleted } },
    input.actor,
  );
  if (!made.ok) return made;
  report.changeSet = made.changeSet;
  const at = repoCtx.now();
  await recordAudit(repoCtx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'assets.pulled',
    target: { type: 'app', id: app.id },
    // Ids and counts only: never a file name, an address or bytes.
    detail: {
      appId: app.id,
      platform: app.platform,
      changeSetId: made.changeSet.id,
      written,
      deleted,
      unchanged,
      skipped: skipped.length,
      unverified: unverified.length,
      bytes: downloadedBytes },
    at });
  await emitEvent(repoCtx.db, {
    workspaceId: input.workspaceId,
    type: 'assets.pulled',
    subject: { appId: app.id, repositoryId: app.repositoryId },
    payload: {
      appId: app.id,
      store: store.view.store,
      platform: app.platform,
      changeSetId: made.changeSet.id,
      written,
      deleted,
      skipped: skipped.length,
      unverified: unverified.length,
      actor: { type: input.actor.type, id: input.actor.id } },
    at });
  return { ok: true, report };
}
