import { createHash, randomUUID } from 'node:crypto';
import { ASSET_SYNC_LIMITS } from '@mrm/core';
import type { Sql } from '@mrm/db';

/**
 * The bytes of the images a person uploaded (or fixed in the app) to a staged set of graphics, kept in the database
 * (docs/adr/0012-assets-two-way-sync.md): table `staged_asset_blobs`, one row per image per app, keyed by the git blob id of
 * the bytes. A staged row of `source = 'local'` refers to its blob by that id (its `value_hash`).
 *
 * Caps: `ASSET_SYNC_LIMITS.maxUploadBytes` per image, `maxStagedUploadBytes` and `maxStagedUploadFiles` per app. The base64
 * text is what the database layer can store (it has no binary parameter, like app_icons). Nothing here is ever logged,
 * audited or put in an event: only the blob id and the hash.
 */

type Row = Record<string, unknown>;

export type BlobMediaType = 'image/png' | 'image/jpeg';

export type StoredBlob = {
  oid: string;
  sha256: string;
  size: number;
  mediaType: BlobMediaType;
  bytes: Uint8Array;
};

/** The git blob id of bytes (the id the repository would give the file). */
export function gitBlobOid(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export type BlobUsage = { files: number; bytes: number };

/** What the app already keeps. */
export async function blobUsage(sql: Sql, workspaceId: string, appId: string): Promise<BlobUsage> {
  const [row] = await sql.query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM staged_asset_blobs WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  return { files: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Keeps the bytes (once per blob id). Refuses what would pass a cap, with the reason in words. Call it inside the
 * transaction that writes the staged rows.
 */
export async function putBlob(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    bytes: Uint8Array;
    mediaType: BlobMediaType;
    actorId: string;
    now: number;
  },
): Promise<
  | { ok: true; oid: string; sha256: string; size: number }
  | { ok: false; code: 'too_large' | 'too_many'; message: string; limit: number }
> {
  const size = input.bytes.length;
  const max = ASSET_SYNC_LIMITS.maxUploadBytes;
  if (size > max)
    return {
      ok: false,
      code: 'too_large',
      message: `An image is at most ${Math.floor(max / (1024 * 1024))} MB; this one is ${(size / (1024 * 1024)).toFixed(1)} MB.`,
      limit: max,
    };
  const oid = gitBlobOid(input.bytes);
  const [have] = await sql.query(
    'SELECT sha256 FROM staged_asset_blobs WHERE app_id = ? AND oid = ?',
    [input.appId, oid],
  );
  if (have) return { ok: true, oid, sha256: String(have.sha256), size };
  const usage = await blobUsage(sql, input.workspaceId, input.appId);
  if (usage.files + 1 > ASSET_SYNC_LIMITS.maxStagedUploadFiles) {
    return {
      ok: false,
      code: 'too_many',
      message: `At most ${ASSET_SYNC_LIMITS.maxStagedUploadFiles} uploaded images are kept for an app. Remove staged sets that are not needed.`,
      limit: ASSET_SYNC_LIMITS.maxStagedUploadFiles,
    };
  }
  if (usage.bytes + size > ASSET_SYNC_LIMITS.maxStagedUploadBytes) {
    return {
      ok: false,
      code: 'too_many',
      message: `At most ${Math.floor(ASSET_SYNC_LIMITS.maxStagedUploadBytes / (1024 * 1024))} MB of uploaded images are kept for an app. Remove staged sets that are not needed.`,
      limit: ASSET_SYNC_LIMITS.maxStagedUploadBytes,
    };
  }
  const sha256 = sha256Of(input.bytes);
  await sql.execute(
    `INSERT INTO staged_asset_blobs (id, workspace_id, app_id, oid, sha256, size, media_type, data, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (app_id, oid) DO NOTHING`,
    [
      randomUUID(),
      input.workspaceId,
      input.appId,
      oid,
      sha256,
      size,
      input.mediaType,
      Buffer.from(input.bytes).toString('base64'),
      input.actorId,
      input.now,
    ],
  );
  return { ok: true, oid, sha256, size };
}

export async function getBlob(
  sql: Sql,
  workspaceId: string,
  appId: string,
  oid: string,
): Promise<StoredBlob | undefined> {
  const [row] = await sql.query(
    'SELECT oid, sha256, size, media_type, data FROM staged_asset_blobs WHERE workspace_id = ? AND app_id = ? AND oid = ?',
    [workspaceId, appId, oid],
  );
  return row ? toBlob(row) : undefined;
}

const toBlob = (row: Row): StoredBlob => ({
  oid: String(row.oid),
  sha256: String(row.sha256),
  size: Number(row.size),
  mediaType: String(row.media_type) as BlobMediaType,
  bytes: new Uint8Array(Buffer.from(String(row.data), 'base64')),
});

/** Deletes the blobs of the app that no staged row refers to any more. Returns how many. */
export async function deleteUnreferencedBlobs(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<number> {
  return sql.execute(
    `DELETE FROM staged_asset_blobs
      WHERE workspace_id = ? AND app_id = ?
        AND oid NOT IN (SELECT value_hash FROM staged_changes WHERE app_id = ? AND kind = 'asset' AND source = 'local')`,
    [workspaceId, appId, appId],
  );
}
