import type { Sql } from '@kiln/db';

/**
 * Removes everything ASO holds for an app. Called by `deleteApp` (inside its transaction). Its own file so
 * `apps.ts` can use it without importing the refresh service, which imports `apps.ts`.
 */
export async function deleteAsoData(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  for (const table of [
    'aso_competitor_snapshots',
    'aso_rank_checks',
    'aso_competitors',
    'aso_keywords',
    'aso_app_state',
  ]) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [
      appId,
      workspaceId,
    ]);
  }
}
