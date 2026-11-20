import { mapOrNull, type Row, type Sql } from '@mrm/db';

/**
 * The app_icons table (migration 18): at most one row per app, holding the resolved icon as base64
 * text, where it came from, and the state of the looks (when, how many failed, when the next one
 * is allowed). The rules about WHEN to look and WHERE are in app-icons.ts; this file only reads
 * and writes rows. A row without `data` records a look that found nothing or failed.
 */

export type IconSource = 'repository' | 'app_store' | 'google_play';
export type IconMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export type IconRow = {
  appId: string;
  workspaceId: string;
  source: IconSource | null;
  /** The git blob id of the file, or the host of the image URL. */
  sourceId: string | null;
  mediaType: IconMediaType | null;
  data: Uint8Array | null;
  size: number | null;
  width: number | null;
  height: number | null;
  /** A hash of the bytes: the HTTP ETag of the icon route and the `v` of its URL. */
  etag: string | null;
  fetchedAt: number | null;
  checkedAt: number;
  failures: number;
  backoffUntil: number | null;
  lastError: string | null;
};

const toRow = (r: Row): IconRow => ({
  appId: String(r.app_id),
  workspaceId: String(r.workspace_id),
  source: mapOrNull(r.source, String) as IconSource | null,
  sourceId: mapOrNull(r.source_id, String),
  mediaType: mapOrNull(r.media_type, String) as IconMediaType | null,
  data: typeof r.data === 'string' ? new Uint8Array(Buffer.from(r.data, 'base64')) : null,
  size: mapOrNull(r.size, Number),
  width: mapOrNull(r.width, Number),
  height: mapOrNull(r.height, Number),
  etag: mapOrNull(r.etag, String),
  fetchedAt: mapOrNull(r.fetched_at, Number),
  checkedAt: Number(r.checked_at),
  failures: Number(r.failures ?? 0),
  backoffUntil: mapOrNull(r.backoff_until, Number),
  lastError: mapOrNull(r.last_error, String),
});

const COLUMNS =
  'app_id, workspace_id, source, source_id, media_type, data, size, width, height, etag, fetched_at, checked_at, failures, backoff_until, last_error';

export async function getAppIcon(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<IconRow | undefined> {
  const [row] = await sql.query(
    `SELECT ${COLUMNS} FROM app_icons WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  return row ? toRow(row) : undefined;
}

/** Inserts or replaces the row of an app. */
export async function putAppIcon(sql: Sql, row: IconRow): Promise<void> {
  await sql.execute(
    `INSERT INTO app_icons (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET
       workspace_id = excluded.workspace_id, source = excluded.source, source_id = excluded.source_id,
       media_type = excluded.media_type, data = excluded.data, size = excluded.size,
       width = excluded.width, height = excluded.height, etag = excluded.etag,
       fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, failures = excluded.failures,
       backoff_until = excluded.backoff_until, last_error = excluded.last_error`,
    [
      row.appId,
      row.workspaceId,
      row.source,
      row.sourceId,
      row.mediaType,
      row.data ? Buffer.from(row.data).toString('base64') : null,
      row.size,
      row.width,
      row.height,
      row.etag,
      row.fetchedAt,
      row.checkedAt,
      row.failures,
      row.backoffUntil,
      row.lastError,
    ],
  );
}

/** Removes the icon row of an app. Called when the app is deleted (services/apps.ts deleteApp). */
export async function deleteAppIcon(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  await sql.execute('DELETE FROM app_icons WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
}
