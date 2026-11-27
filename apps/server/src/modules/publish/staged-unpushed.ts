import type { Sql } from '@kiln/db';

/**
 * "Staged and not pushed" in SQL: the ONE twin of `isUnpushed` of `@kiln/core` (images/staged.ts): a row has to be pushed when it was never
 * pushed or was changed after its push. Everything that asks it from SQL (the pending facts, the cart's holders, the alert `pending.stale`)
 * takes the predicate from here; `pushed_at IS NULL` is not the question (a text edited after its push has a `pushed_at`).
 */
export const UNPUSHED_SQL = '(pushed_hash IS NULL OR pushed_hash <> value_hash)';

export type StagedItemsOfApp = { appId: string; count: number; oldest: number };

/**
 * The staged ITEMS that still have to be pushed, per app, counted as the cart counts them: one per text, one per graphics SET (a set is a
 * row per file and is ONE item; a set that is emptied counts), one per release field; the Google Play share that is only kept here
 * (`user_fraction`) is not an item. `olderThan` keeps the items whose OLDEST row was made before that time (the alert).
 * (Texts that equal what the store holds are dropped by the cart after a read of the listing; a count from SQL alone cannot see that.)
 */
export async function unpushedStagedItems(
  sql: Sql,
  input: { workspaceId: string; appId?: string; olderThan?: number },
): Promise<StagedItemsOfApp[]> {
  const args: (string | number)[] = [input.workspaceId];
  if (input.appId !== undefined) args.push(input.appId);
  if (input.olderThan !== undefined) args.push(input.olderThan);
  const rows = await sql.query(
    `SELECT app_id, COUNT(*) AS n, MIN(oldest) AS oldest FROM (
       SELECT app_id, kind, locale, target, MIN(created_at) AS oldest FROM staged_changes
        WHERE workspace_id = ?${input.appId === undefined ? '' : ' AND app_id = ?'}
          AND NOT (kind = 'release_field' AND target = 'user_fraction')
        GROUP BY app_id, kind, locale, target
       HAVING SUM(CASE WHEN ${UNPUSHED_SQL} THEN 1 ELSE 0 END) > 0${input.olderThan === undefined ? '' : ' AND MIN(created_at) < ?'}
     ) items GROUP BY app_id`,
    args,
  );
  return rows.map((r) => ({
    appId: String(r.app_id),
    count: Number(r.n),
    oldest: Number(r.oldest),
  }));
}
