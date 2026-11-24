import { computeMetadataLock, type MetadataLock } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import type { ManagedApp } from '../../services/apps.ts';
import { type Failure, failure } from '../../services/repositories.ts';

/**
 * ONE answer to "may the listing of this app still be changed?", from STORED state only (`app_releases` as of the last sync).
 * Apple locks the metadata of a version once it is released, in review or approved; with no editable version the listing is
 * locked until a new version is prepared. Google Play never locks: a listing edit is a draft that is always editable. An app
 * that was never synced is open. See docs/api/staged-changes.md ("Locked versions").
 */
export async function metadataLock(
  sql: Sql,
  workspaceId: string,
  app: Pick<ManagedApp, 'id' | 'platform'>,
): Promise<MetadataLock> {
  const rows = await sql.query(
    'SELECT version, status FROM app_releases WHERE app_id = ? AND workspace_id = ?',
    [app.id, workspaceId],
  );
  return computeMetadataLock(
    app.platform,
    rows.map((r) => ({
      version: String(r.version),
      status: r.status === null || r.status === undefined ? null : String(r.status),
    })),
  );
}

/** The refusal for staging or pushing a listing on a locked app (409 `metadata_locked`), or undefined when it is open. */
export async function metadataLockedFailure(
  sql: Sql,
  workspaceId: string,
  app: Pick<ManagedApp, 'id' | 'platform'>,
): Promise<Failure | undefined> {
  const lock = await metadataLock(sql, workspaceId, app);
  if (!lock.locked) return undefined;
  return failure(
    409,
    'metadata_locked',
    `Version ${lock.liveVersion ?? ''} is ${lock.reason === 'in_review' || lock.reason === 'approved' ? 'waiting in App Review' : 'live'} and its listing can no longer be changed. Prepare a new version first, then stage the change.`,
    {
      reason: lock.reason,
      liveVersion: lock.liveVersion,
      ...coded('staged.metadataLocked', { version: lock.liveVersion ?? '' }),
    },
  );
}
