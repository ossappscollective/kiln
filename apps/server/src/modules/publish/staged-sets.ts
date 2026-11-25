import { randomUUID } from 'node:crypto';
import {
  ASSET_KINDS,
  ASSET_SYNC_LIMITS,
  type AssetFacts,
  type AssetKind,
  type AssetProblem,
  type AssetSlot,
  assetSlotSupport,
  assetStoreOf,
  type FixAdvice,
  fixAdvice,
  type Platform,
  readImageHeader,
  STAGED_LIMITS,
  type StagedChangesView,
  slotKey,
  slotMaxFiles,
  sniffImageFormat,
  validateAssets,
} from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import type { ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { type AssetHandle, isCommitSha, openAssets } from '../listing/asset-repo.ts';
import { metadataLockedFailure } from './metadata-lock.ts';
import {
  type BlobMediaType,
  deleteUnreferencedBlobs,
  gitBlobOid,
  putBlob,
} from './staged-asset-blobs.ts';
import {
  buildStagedView,
  isStageableLocale,
  loadStagedRows,
  type StagedContext,
  type StagedRow,
} from './staged-changes.ts';

/**
 * Staged sets of graphics that are composed here: an image uploaded or fixed in the app is added to a set, replaces a file of
 * it, or a file is taken out (docs/adr/0012-assets-two-way-sync.md, docs/api/staged-changes.md). A staged set is what a push
 * makes the store's set (the whole set is replaced), so every operation works on the WHOLE effective set: the staged rows
 * when the slot is staged, else the files the repository's asset index lists for it.
 *
 * Nothing here sends anything to a store or a repository. Bytes of uploads go to `staged_asset_blobs`
 * (staged-asset-blobs.ts); a row of an uploaded file is `source = 'local'`, `asset_path = uploads/<id>/<name>`,
 * `asset_commit = null` and `value_hash` = the git blob id of the bytes.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

/** One file of a set, wherever it comes from. */
export type SetEntry = {
  source: 'repo' | 'local';
  /** The git blob id. */
  valueHash: string;
  /** A path of the repository (`repo`) or `uploads/<id>/<name>` (`local`). */
  assetPath: string;
  assetCommit: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  format: string | null;
  alpha: boolean | null;
  /** The bytes to keep, for a file that is new here (an upload or the result of a fix). */
  blob?: { bytes: Uint8Array; mediaType: BlobMediaType };
};

export const entryOfRow = (r: StagedRow): SetEntry => ({
  source: r.source === 'local' ? 'local' : 'repo',
  valueHash: r.valueHash,
  assetPath: r.assetPath ?? '',
  assetCommit: r.assetCommit,
  bytes: r.assetBytes,
  width: r.assetWidth,
  height: r.assetHeight,
  format: r.assetFormat,
  alpha: r.assetAlpha,
});

const invalid = (code: string, message: string, extra: Record<string, unknown> = {}): Failure =>
  failure(422, code, message, extra);

/** A file name as it is kept: a base name without odd characters, never a path. */
export function safeUploadName(name: string | undefined, format: 'png' | 'jpeg'): string {
  const ext = format === 'png' ? 'png' : 'jpg';
  const raw = (name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = raw.lastIndexOf('.');
  const stem = (dot > 0 ? raw.slice(0, dot) : raw)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return `${stem === '' ? 'image' : stem}.${ext}`;
}

export const uploadPathOf = (oid: string, name: string): string =>
  `uploads/${oid.slice(0, 8)}/${name}`;
export const isUploadPath = (path: string): boolean => /^uploads\/[0-9a-f]{8}\/[^/]+$/.test(path);

/** The slot a request names, checked. */
export function slotOf(
  app: ManagedApp,
  locale: string,
  kind: string,
  device: string | null,
): { ok: true; slot: AssetSlot } | Failure {
  if (!isStageableLocale(locale))
    return invalid('invalid_locale', 'locale must be a store locale code such as en-US.', {
      field: 'locale',
      ...coded('staged.badLocale'),
    });
  if (!(ASSET_KINDS as readonly string[]).includes(kind))
    return invalid('invalid_staged', 'Not a kind of graphic.', { field: 'kind' });
  const slot: AssetSlot = { kind: kind as AssetKind, device };
  if (slot.kind === 'screenshot' && (device === null || device === ''))
    return invalid('invalid_staged', 'device is required for screenshots.', { field: 'device' });
  if (slot.kind !== 'screenshot' && device !== null)
    return invalid('invalid_staged', 'device applies to screenshots only.', { field: 'device' });
  const support = assetSlotSupport(app.platform, slot);
  if (!support.ok) return invalid('slot_not_pushable', support.reason, { field: 'kind' });
  return { ok: true, slot };
}

// ---------------------------------------------------------------------------------------------
// Looking at a file

export type Inspected = {
  ok: true;
  format: 'png' | 'jpeg';
  name: string;
  width: number;
  height: number;
  hasAlpha: boolean | null;
  bytes: number;
  facts: AssetFacts;
  /** The problems of THIS file against the documented specs (the set-level ones are in the staged view). */
  problems: AssetProblem[];
  advice: FixAdvice;
};
export type InspectFailure = { ok: false; status: 413 | 415 | 422; code: string; message: string };

/**
 * What an image is and what is wrong with it for a slot, from its bytes only (never its name or its declared type): PNG or
 * JPEG, a readable header, within the size cap. The same facts the Assets tab and a push use.
 */
export function inspectImage(
  platform: Platform,
  slot: AssetSlot,
  input: { locale: string; name?: string | undefined; bytes: Uint8Array; position: number },
): Inspected | InspectFailure {
  const { bytes } = input;
  if (bytes.length === 0)
    return { ok: false, status: 422, code: 'empty_file', message: 'The file is empty.' };
  if (bytes.length > ASSET_SYNC_LIMITS.maxUploadBytes) {
    return {
      ok: false,
      status: 413,
      code: 'too_large',
      message: `An image is at most ${Math.floor(ASSET_SYNC_LIMITS.maxUploadBytes / (1024 * 1024))} MB; this one is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB.`,
    };
  }
  const format = sniffImageFormat(bytes);
  if (format !== 'png' && format !== 'jpeg') {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_media',
      message:
        format === null
          ? 'The file is not an image this server reads. Use a PNG or JPEG.'
          : `${format.toUpperCase()} is not accepted by the stores. Export a PNG or JPEG.`,
    };
  }
  const header = readImageHeader(bytes);
  if (!header.ok)
    return {
      ok: false,
      status: 422,
      code: 'unreadable_image',
      message: 'The image header could not be read: the file may be damaged.',
    };
  const name = safeUploadName(input.name, format);
  const claimed = ((input.name ?? '').split('.').pop() ?? '').toLowerCase();
  const facts: AssetFacts = {
    path: uploadPathOf(gitBlobOid(bytes), name),
    store: assetStoreOf(platform),
    locale: input.locale,
    kind: slot.kind,
    device: slot.device,
    order: input.position + 1,
    bytes: bytes.length,
    width: header.width,
    height: header.height,
    format,
    // The name that was sent (it may disagree with the content): the specs warn about that.
    extension:
      claimed === '' ? (format === 'png' ? 'png' : 'jpg') : claimed === 'jpeg' ? 'jpg' : claimed,
    hasAlpha: header.hasAlpha,
    read: 'read',
  };
  const problems = validateAssets(assetStoreOf(platform), [facts]).filter(
    (p) => p.path === facts.path,
  );
  const advice = fixAdvice(
    platform,
    {
      format,
      width: header.width,
      height: header.height,
      hasAlpha: header.hasAlpha,
      extension: facts.extension,
      kind: slot.kind,
      device: slot.device,
    },
    problems.map((p) => p.rule),
  );
  return {
    ok: true,
    format,
    name,
    width: header.width,
    height: header.height,
    hasAlpha: header.hasAlpha,
    bytes: bytes.length,
    facts,
    problems,
    advice,
  };
}

/** The entry for new bytes (already inspected). */
export function entryOfInspected(bytes: Uint8Array, i: Inspected): SetEntry {
  const oid = gitBlobOid(bytes);
  return {
    source: 'local',
    valueHash: oid,
    assetPath: uploadPathOf(oid, i.name),
    assetCommit: null,
    bytes: bytes.length,
    width: i.width,
    height: i.height,
    format: i.format,
    alpha: i.hasAlpha,
    blob: { bytes, mediaType: i.format === 'png' ? 'image/png' : 'image/jpeg' },
  };
}

// ---------------------------------------------------------------------------------------------
// The effective set

export type EffectiveSet = {
  ok: true;
  entries: SetEntry[];
  /** The set is not staged: its files are those of the repository. */
  fromRepo: boolean;
  /** The set is not staged: its files are those the store holds (seeded through `seed`). */
  fromStore?: boolean;
  handle?: AssetHandle;
};

/**
 * Where an unstaged set starts when it is edited from the store's side (the Graphics tab shows the store's images): the files the
 * store holds, taken as staged uploads, so that a push which replaces the store's set keeps the images that were not touched.
 */
export type SetSeed = () => Promise<SetEntry[] | Failure>;

/** The files of a set as a push would now write them: the staged rows, else the repository's files for the slot. */
export async function loadEffectiveSet(
  ctx: StagedContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    locale: string;
    slot: AssetSlot;
    actor: Actor;
    commit?: string | undefined;
    gate?: (() => Failure | undefined) | undefined;
    seed?: SetSeed | undefined;
  },
): Promise<EffectiveSet | Failure> {
  const key = slotKey(input.slot);
  const rows = (await loadStagedRows(ctx.db, input.workspaceId, input.app.id)).filter(
    (r) => r.kind === 'asset' && r.locale === input.locale && r.target === key,
  );
  if (rows.length > 0)
    return {
      ok: true,
      entries: rows.sort((a, b) => a.ordinal - b.ordinal).map(entryOfRow),
      fromRepo: false,
    };
  if (input.seed) {
    const seeded = await input.seed();
    if (!Array.isArray(seeded)) return seeded;
    return { ok: true, entries: seeded, fromRepo: false, fromStore: true };
  }
  if (input.commit !== undefined && !isCommitSha(input.commit))
    return invalid('invalid_staged', 'commit must be a full commit hash.', { field: 'commit' });
  const opened = await openAssets(
    ctx.assets,
    {
      workspaceId: input.workspaceId,
      app: input.app,
      ...(input.commit ? { commit: input.commit } : {}),
    },
    input.actor,
    {
      ...(input.gate ? { onCompute: input.gate } : {}),
    },
  );
  if (!opened.ok) return opened;
  const view = opened.handle.view;
  if (view.status === 'no_repository' || view.commit === null)
    return { ok: true, entries: [], fromRepo: true, handle: opened.handle };
  const files = view.assets
    .filter(
      (a) =>
        a.origin === 'store' &&
        a.locale === input.locale &&
        a.kind === input.slot.kind &&
        a.device === input.slot.device &&
        a.format !== 'video',
    )
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  const commit = view.commit;
  const entries: SetEntry[] = [];
  for (const a of files) {
    if (
      a.oid === null ||
      a.read !== 'read' ||
      (a.format !== 'png' && a.format !== 'jpeg') ||
      a.bytes === null
    ) {
      return invalid(
        'asset_not_pushable',
        `${a.path.split('/').pop() ?? a.path} was not read by the asset index, or is not a PNG or JPEG, so the set cannot be staged as it is.`,
        {
          path: a.path,
          ...coded('staged.notReadByIndex', { name: a.path.split('/').pop() ?? a.path }),
        },
      );
    }
    entries.push({
      source: 'repo',
      valueHash: a.oid,
      assetPath: a.path,
      assetCommit: commit,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      format: a.format,
      alpha: a.hasAlpha,
    });
  }
  return { ok: true, entries, fromRepo: true, handle: opened.handle };
}

// ---------------------------------------------------------------------------------------------
// Writing the set

/**
 * Makes `entries` the staged set of the slot (replacing the rows it had), keeps the bytes of the new files, drops the bytes
 * nothing refers to any more, and audits with ids and hashes only. Holds the caps of a staged set and of a push.
 */
export async function replaceAssetSet(
  ctx: StagedContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    locale: string;
    slot: AssetSlot;
    entries: SetEntry[];
    actor: Actor;
    action: string;
    detail: Record<string, unknown>;
  },
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { app, entries } = input;
  const locked = await metadataLockedFailure(ctx.db, input.workspaceId, app);
  if (locked) return locked;
  if (entries.length === 0) {
    return invalid(
      'empty_set',
      'A set cannot be emptied here: a push replaces a store set with the files it holds and cannot clear it. Stage at least one file, or remove the images in the store console.',
      coded('staged.setEmpty'),
    );
  }
  const max = slotMaxFiles(app.platform, input.slot);
  if (entries.length > max)
    return invalid('set_too_large', `A set holds at most ${max} file${max === 1 ? '' : 's'}.`, {
      limit: max,
      actual: entries.length,
    });
  const key = slotKey(input.slot);
  const at = ctx.now();
  const refused = await ctx.db.transaction(async (tx) => {
    const all = await loadStagedRows(tx, input.workspaceId, app.id);
    const others = all.filter(
      (r) => r.kind === 'asset' && !(r.locale === input.locale && r.target === key),
    );
    const files = others.length + entries.length;
    const bytes =
      others.reduce((n, r) => n + (r.assetBytes ?? 0), 0) +
      entries.reduce((n, e) => n + (e.bytes ?? 0), 0);
    if (files > STAGED_LIMITS.maxAssetFilesPerPush)
      return invalid(
        'too_many_files',
        `A push uploads at most ${STAGED_LIMITS.maxAssetFilesPerPush} files; this would stage ${files}.`,
        {
          limit: STAGED_LIMITS.maxAssetFilesPerPush,
          actual: files,
          ...coded('staged.tooManyFiles', { max: STAGED_LIMITS.maxAssetFilesPerPush, files }),
        },
      );
    if (bytes > STAGED_LIMITS.maxAssetBytesPerPush)
      return invalid(
        'too_many_bytes',
        `A push uploads at most ${STAGED_LIMITS.maxAssetBytesPerPush / (1024 * 1024)} MB; this would stage ${Math.ceil(bytes / (1024 * 1024))} MB.`,
        {
          limit: STAGED_LIMITS.maxAssetBytesPerPush,
          actual: bytes,
          ...coded('staged.tooManyBytes', {
            mb: STAGED_LIMITS.maxAssetBytesPerPush / (1024 * 1024),
            staged: Math.ceil(bytes / (1024 * 1024)),
          }),
        },
      );
    const mine = all.filter(
      (r) => r.kind === 'asset' && r.locale === input.locale && r.target === key,
    ).length;
    if (all.length - mine + entries.length > STAGED_LIMITS.maxItems)
      return invalid(
        'too_many_items',
        `At most ${STAGED_LIMITS.maxItems} items can be staged for an app.`,
        {
          limit: STAGED_LIMITS.maxItems,
          ...coded('staged.tooManyItems', { max: STAGED_LIMITS.maxItems }),
        },
      );
    for (const e of entries) {
      if (e.blob === undefined) continue;
      const put = await putBlob(tx, {
        workspaceId: input.workspaceId,
        appId: app.id,
        bytes: e.blob.bytes,
        mediaType: e.blob.mediaType,
        actorId: input.actor.id,
        now: at,
      });
      if (!put.ok)
        return invalid(
          put.code === 'too_large' ? 'file_too_large' : 'too_many_uploads',
          put.message,
          { limit: put.limit },
        );
    }
    const first = all.find(
      (r) => r.kind === 'asset' && r.locale === input.locale && r.target === key,
    );
    await tx.execute(
      "DELETE FROM staged_changes WHERE app_id = ? AND kind = 'asset' AND locale = ? AND target = ?",
      [app.id, input.locale, key],
    );
    let ordinal = 0;
    for (const e of entries) {
      await tx.execute(
        `INSERT INTO staged_changes
           (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit, asset_bytes, asset_width, asset_height, asset_format, asset_alpha, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'asset', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          app.id,
          app.platform,
          input.locale,
          key,
          ordinal++,
          e.source,
          e.valueHash,
          e.assetPath,
          e.assetCommit,
          e.bytes,
          e.width,
          e.height,
          e.format,
          e.alpha === null ? null : e.alpha ? 1 : 0,
          first ? first.createdBy : input.actor.id,
          first ? first.createdAt : at,
          at,
        ],
      );
    }
    await deleteUnreferencedBlobs(tx, input.workspaceId, app.id);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      target: { type: 'app', id: app.id },
      // Ids and blob hashes only: never the bytes, never a file name.
      detail: {
        appId: app.id,
        platform: app.platform,
        locale: input.locale,
        slot: key,
        files: entries.length,
        oids: entries.map((e) => e.valueHash),
        ...input.detail,
      },
      at,
    });
    return undefined;
  });
  if (refused) return refused;
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}
