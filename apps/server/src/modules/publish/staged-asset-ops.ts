import {
  ASSET_SYNC_LIMITS,
  type AssetProblem,
  type FileChange,
  type FixAdvice,
  type FixKind,
  type StagedChangesView,
  slotKey,
} from '@mrm/core';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type ChangeSetView, createFileChangeSet } from '../../services/change-sets.ts';
import { type FixFailure, fixImage } from '../../services/image-fix.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { repoSetsOf } from '../listing/asset-diff.ts';
import { openAssets } from '../listing/asset-repo.ts';
import { layoutFor, planSet, type Wanted } from '../listing/asset-repo-plan.ts';
import { stepsToChanges } from '../listing/asset-repo-write.ts';
import { getBlob } from './staged-asset-blobs.ts';
import { assetSetsOf, loadStagedRows, type StagedContext } from './staged-changes.ts';
import {
  entryOfInspected,
  entryOfRow,
  type Inspected,
  inspectImage,
  loadEffectiveSet,
  replaceAssetSet,
  slotOf,
} from './staged-sets.ts';

/**
 * Add, replace, remove and fix a file of a staged set, and put staged sets in the repository
 * (docs/adr/0012-assets-two-way-sync.md). Everything here stages or drafts: the store is written only by a push
 * (store-draft.ts), the repository only by applying the change set this makes.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };
type Gate = (() => Failure | undefined) | undefined;

export type SlotRequest = {
  workspaceId: string;
  appId: string;
  locale: string;
  kind: string;
  device: string | null;
  actor: Actor;
  gate?: Gate;
};

/** A file the stores would refuse, with what to do about it. The set is not changed. */
const specFailure = (problems: AssetProblem[], advice: FixAdvice): Failure =>
  failure(
    422,
    'spec_errors',
    'This file does not meet the store specs, so it was not staged. Fix it first (see the options) or export a correct file.',
    {
      problems: problems.map((p) => ({ rule: p.rule, severity: p.severity, message: p.message })),
      fix: advice,
    },
  );

export type UploadInput = SlotRequest & {
  mode: 'add' | 'replace';
  /** 1-based. `replace`: the file to replace. `add`: where to put it (default: last). */
  position?: number | undefined;
  name?: string | undefined;
  bytes: Uint8Array;
  /** Correct the file first (a file that was refused with `spec_errors` is sent again with the fix the answer offered). */
  fix?: FixKind | undefined;
  background?: readonly [number, number, number] | undefined;
};

/** What a file is and what is wrong with it for a slot. Reads nothing and writes nothing. */
export async function inspectForSlot(
  ctx: StagedContext,
  input: SlotRequest & { name?: string | undefined; bytes: Uint8Array },
): Promise<{ ok: true; inspected: Omit<Inspected, 'facts'> } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const slot = slotOf(app, input.locale, input.kind, input.device);
  if (!slot.ok) return slot;
  const done = inspectImage(app.platform, slot.slot, {
    locale: input.locale,
    name: input.name,
    bytes: input.bytes,
    position: 0,
  });
  if (!done.ok) return failure(422, done.code, done.message);
  const { facts: _facts, ...rest } = done;
  return { ok: true, inspected: rest };
}

export async function stageUpload(
  ctx: StagedContext,
  input: UploadInput,
): Promise<{ ok: true; staged: StagedChangesView; position: number } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const slot = slotOf(app, input.locale, input.kind, input.device);
  if (!slot.ok) return slot;
  const base = await loadEffectiveSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    actor: input.actor,
    gate: input.gate,
  });
  if (!base.ok) return base;
  const entries = base.entries.slice();
  let position: number;
  if (input.mode === 'replace') {
    position = input.position ?? 0;
    if (!Number.isInteger(position) || position < 1 || position > entries.length)
      return failure(422, 'invalid_position', 'There is no file at that position to replace.', {
        field: 'position',
      });
  } else {
    position = input.position ?? entries.length + 1;
    if (!Number.isInteger(position) || position < 1 || position > entries.length + 1)
      return failure(422, 'invalid_position', 'The position is after the end of the set.', {
        field: 'position',
      });
  }
  let bytes = input.bytes;
  let name = input.name;
  if (input.fix !== undefined) {
    const fixed = fixImage({
      platform: app.platform,
      slot: slot.slot,
      name: name ?? 'image.png',
      bytes,
      kind: input.fix,
      background: input.background,
    });
    if (!fixed.ok) return fixFailure(fixed);
    bytes = fixed.bytes;
    name = fixed.name;
  }
  const inspected = inspectImage(app.platform, slot.slot, {
    locale: input.locale,
    name,
    bytes,
    position: position - 1,
  });
  if (!inspected.ok) return failure(422, inspected.code, inspected.message);
  const errors = inspected.problems.filter((p) => p.severity === 'error');
  if (errors.length > 0) return specFailure(errors, inspected.advice);
  const entry = entryOfInspected(bytes, inspected);
  if (input.mode === 'replace') entries[position - 1] = entry;
  else entries.splice(position - 1, 0, entry);
  const done = await replaceAssetSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    entries,
    actor: input.actor,
    action: input.mode === 'replace' ? 'staged.asset_replaced' : 'staged.asset_added',
    detail: {
      position,
      via: 'upload',
      fromRepo: base.fromRepo,
      ...(input.fix ? { fix: input.fix } : {}),
    },
  });
  return done.ok ? { ok: true, staged: done.staged, position } : done;
}

export async function removeFromSet(
  ctx: StagedContext,
  input: SlotRequest & { position: number },
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const slot = slotOf(app, input.locale, input.kind, input.device);
  if (!slot.ok) return slot;
  const base = await loadEffectiveSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    actor: input.actor,
    gate: input.gate,
  });
  if (!base.ok) return base;
  if (
    !Number.isInteger(input.position) ||
    input.position < 1 ||
    input.position > base.entries.length
  )
    return failure(422, 'invalid_position', 'There is no such file in this set.', {
      field: 'position',
    });
  const entries = base.entries.slice();
  const [gone] = entries.splice(input.position - 1, 1);
  return replaceAssetSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    entries,
    actor: input.actor,
    action: 'staged.asset_removed',
    detail: {
      position: input.position,
      removedOid: gone?.valueHash ?? null,
      fromRepo: base.fromRepo,
    },
  });
}

const fixFailure = (f: FixFailure): Failure => failure(422, `fix_${f.code}`, f.message);

export async function fixFile(
  ctx: StagedContext,
  input: SlotRequest & {
    position: number;
    fix: FixKind;
    background?: readonly [number, number, number] | undefined;
  },
): Promise<{ ok: true; staged: StagedChangesView; summary: string } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const slot = slotOf(app, input.locale, input.kind, input.device);
  if (!slot.ok) return slot;
  const base = await loadEffectiveSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    actor: input.actor,
    gate: input.gate,
  });
  if (!base.ok) return base;
  const entry = base.entries[input.position - 1];
  if (!Number.isInteger(input.position) || !entry)
    return failure(422, 'invalid_position', 'There is no such file in this set.', {
      field: 'position',
    });
  // The bytes: kept here (an upload), or the repository's at the staged commit, held to the blob id.
  let bytes: Uint8Array | undefined;
  if (entry.source === 'local') {
    bytes = (await getBlob(ctx.db, input.workspaceId, app.id, entry.valueHash))?.bytes;
  } else {
    const opened = base.handle
      ? { ok: true as const, handle: base.handle }
      : await openAssets(
          ctx.assets,
          {
            workspaceId: input.workspaceId,
            app,
            ...(entry.assetCommit ? { commit: entry.assetCommit } : {}),
          },
          input.actor,
          { ...(input.gate ? { onCompute: input.gate } : {}) },
        );
    if (!opened.ok) return opened;
    const file = await opened.handle.readFile(entry.assetPath);
    if (file.ok && file.oid === entry.valueHash) bytes = file.bytes;
    else if (!file.ok)
      return failure(file.status === 404 ? 422 : 502, 'asset_unreadable', file.message);
  }
  if (!bytes)
    return failure(422, 'asset_changed', 'The file is no longer what was staged. Stage it again.');
  const name = entry.assetPath.split('/').pop() ?? 'image.png';
  const fixed = fixImage({
    platform: app.platform,
    slot: slot.slot,
    name,
    bytes,
    kind: input.fix,
    background: input.background,
  });
  if (!fixed.ok) return fixFailure(fixed);
  const inspected = inspectImage(app.platform, slot.slot, {
    locale: input.locale,
    name: fixed.name,
    bytes: fixed.bytes,
    position: input.position - 1,
  });
  if (!inspected.ok) return failure(422, inspected.code, inspected.message);
  const entries = base.entries.slice();
  entries[input.position - 1] = entryOfInspected(fixed.bytes, inspected);
  const done = await replaceAssetSet(ctx, {
    workspaceId: input.workspaceId,
    app,
    locale: input.locale,
    slot: slot.slot,
    entries,
    actor: input.actor,
    action: 'staged.asset_fixed',
    detail: {
      position: input.position,
      fix: input.fix,
      fromOid: entry.valueHash,
      toOid: entries[input.position - 1]?.valueHash ?? null,
      fromRepo: base.fromRepo,
    },
  });
  return done.ok ? { ok: true, staged: done.staged, summary: fixed.summary } : done;
}

// ---------------------------------------------------------------------------------------------
// Staged sets into the repository

export type ToRepoResult = {
  changeSet: ChangeSetView | null;
  written: number;
  deleted: number;
  unchanged: number;
  skipped: string[];
  notes: string[];
};

/**
 * Makes a change set that puts the staged sets (all, or the ones named by their id `locale/slotKey`) into the repository:
 * each repository set becomes exactly the staged one (the files the staged set no longer holds are deleted). Files of the
 * repository that are already right are not touched. Nothing is applied: the change set is a draft to review and approve.
 */
export async function stagedSetsToRepo(
  ctx: StagedContext,
  input: {
    workspaceId: string;
    appId: string;
    sets?: readonly string[] | undefined;
    actor: Actor;
    gate?: Gate;
  },
): Promise<{ ok: true; result: ToRepoResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!app.repositoryId)
    return failure(422, 'no_repository', 'This app has no linked repository to put the images in.');
  const rows = await loadStagedRows(ctx.db, input.workspaceId, app.id);
  const all = assetSetsOf(rows);
  if (all.length === 0)
    return failure(422, 'nothing_staged', 'No graphics are staged for this app.');
  const chosen =
    input.sets === undefined || input.sets.length === 0
      ? all
      : all.filter((s) => input.sets?.includes(s.key));
  if (chosen.length === 0) return failure(404, 'not_found', 'None of these sets is staged.');
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
    return failure(422, 'no_repository', 'This app has no linked repository to put the images in.');
  const repoSets = repoSetsOf(view.assets);
  const existing = view.assets
    .filter((a) => a.origin === 'store')
    .map((a) => ({ path: a.path, locale: a.locale, kind: a.kind, device: a.device }));
  const changes: FileChange[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  let written = 0;
  let deleted = 0;
  let unchanged = 0;
  let total = 0;
  for (const set of chosen) {
    const laid = layoutFor({
      platform: app.platform,
      locale: set.locale,
      slot: set.slot,
      roots: view.target.roots,
      existing,
    });
    if (!laid.ok) {
      skipped.push(`${set.key}: ${laid.message}`);
      continue;
    }
    const current = (
      repoSets.sets.get(`${set.locale}\0${set.slot.kind}\0${set.slot.device ?? ''}`)?.files ?? []
    ).map((a) => ({ path: a.path, oid: a.oid }));
    const wanted: Wanted[] = [];
    const bytesOf = new Map<number, Uint8Array>();
    let failed = false;
    for (const row of set.rows.slice().sort((a, b) => a.ordinal - b.ordinal)) {
      const entry = entryOfRow(row);
      const format = entry.format === 'jpeg' ? 'jpeg' : 'png';
      const here = current.find((c) => c.oid === entry.valueHash);
      if (here) {
        wanted.push({ kind: 'existing', path: here.path, oid: entry.valueHash });
        continue;
      }
      let bytes: Uint8Array | undefined;
      if (entry.source === 'local') {
        bytes = (await getBlob(ctx.db, input.workspaceId, app.id, entry.valueHash))?.bytes;
      } else {
        const at = await openAssets(
          ctx.assets,
          {
            workspaceId: input.workspaceId,
            app,
            ...(entry.assetCommit ? { commit: entry.assetCommit } : {}),
          },
          input.actor,
          { ...(input.gate ? { onCompute: input.gate } : {}) },
        );
        if (!at.ok) return at;
        const file = await at.handle.readFile(entry.assetPath);
        if (file.ok && file.oid === entry.valueHash) bytes = file.bytes;
      }
      if (!bytes) {
        skipped.push(
          `${set.key}: ${entry.assetPath.split('/').pop() ?? 'a file'} is no longer available, so the set was not put in the repository.`,
        );
        failed = true;
        break;
      }
      total += bytes.length;
      if (total > ASSET_SYNC_LIMITS.maxPullBytes) {
        skipped.push(
          `${set.key}: a change set takes at most ${Math.floor(ASSET_SYNC_LIMITS.maxPullBytes / (1024 * 1024))} MB of images; put the remaining sets in another one.`,
        );
        failed = true;
        break;
      }
      bytesOf.set(wanted.length, bytes);
      wanted.push({ kind: 'new', oid: entry.valueHash, format });
    }
    if (failed) continue;
    const plan = planSet({ layout: laid.layout, current, wanted, prune: true });
    unchanged += plan.unchanged;
    if (plan.renamed)
      notes.push(
        `${set.key}: the files were renamed so that their names sort in the staged order.`,
      );
    const done = await stepsToChanges({
      handle,
      steps: plan.steps,
      newBytes: (i) => bytesOf.get(i),
    });
    changes.push(...done.changes);
    written += done.written;
    deleted += done.deleted;
    skipped.push(...done.failures.map((m) => `${set.key}: ${m}`));
  }
  if (changes.length === 0) {
    if (skipped.length === 0) notes.push('The repository already has these sets.');
    return { ok: true, result: { changeSet: null, written, deleted, unchanged, skipped, notes } };
  }
  const made = await createFileChangeSet(
    ctx.assets.repo,
    {
      workspaceId: input.workspaceId,
      repositoryId: app.repositoryId,
      summary: `Put ${chosen.length === 1 ? '1 staged graphics set' : `${chosen.length} staged graphics sets`} into the repository (${app.name})`,
      files: changes,
      origin: { v: 1, source: 'staged_assets', appId: app.id },
      auditDetail: {
        appId: app.id,
        platform: app.platform,
        source: 'staged_assets',
        sets: chosen.map((s) => `${s.locale}/${slotKey(s.slot)}`),
        written,
        deleted,
      },
    },
    input.actor,
  );
  if (!made.ok) return made;
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'staged.assets_to_repo',
    target: { type: 'app', id: app.id },
    detail: {
      appId: app.id,
      platform: app.platform,
      changeSetId: made.changeSet.id,
      written,
      deleted,
      unchanged,
    },
    at: ctx.now(),
  });
  return {
    ok: true,
    result: { changeSet: made.changeSet, written, deleted, unchanged, skipped, notes },
  };
}
