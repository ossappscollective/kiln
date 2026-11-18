import type { Sql } from '@mrm/db';

/**
 * The daily character budget of translation, per workspace and UTC day, in `translation_usage`.
 * Characters are reserved before a provider is called and given back when the call fails, so a
 * burst of concurrent requests cannot all pass a check and then overspend together: the reserve is
 * one conditional UPDATE. A budget of 0 means no limit here (the count is still kept).
 */

/** `YYYY-MM-DD` of the UTC day that contains `at` (epoch milliseconds). */
export const usageDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function getUsage(sql: Sql, workspaceId: string, at: number): Promise<number> {
  const [row] = await sql.query('SELECT chars FROM translation_usage WHERE workspace_id = ? AND day = ?', [
    workspaceId,
    usageDay(at),
  ]);
  return Number(row?.chars ?? 0);
}

export type Reservation = { ok: true } | { ok: false; used: number; budget: number };

/** Takes `chars` from today's budget, or says how much is used. */
export async function reserveChars(
  sql: Sql,
  input: { workspaceId: string; at: number; chars: number; budget: number },
): Promise<Reservation> {
  const day = usageDay(input.at);
  await sql.execute('INSERT INTO translation_usage (workspace_id, day, chars) VALUES (?, ?, 0) ON CONFLICT (workspace_id, day) DO NOTHING', [
    input.workspaceId,
    day,
  ]);
  const changed =
    input.budget === 0
      ? await sql.execute('UPDATE translation_usage SET chars = chars + ? WHERE workspace_id = ? AND day = ?', [
          input.chars,
          input.workspaceId,
          day,
        ])
      : await sql.execute(
          'UPDATE translation_usage SET chars = chars + ? WHERE workspace_id = ? AND day = ? AND chars + ? <= ?',
          [input.chars, input.workspaceId, day, input.chars, input.budget],
        );
  if (changed > 0) return { ok: true };
  return { ok: false, used: await getUsage(sql, input.workspaceId, input.at), budget: input.budget };
}

/** Gives characters back (a provider call that failed). Never goes below zero. */
export async function refundChars(sql: Sql, input: { workspaceId: string; at: number; chars: number }): Promise<void> {
  await sql.execute(
    'UPDATE translation_usage SET chars = CASE WHEN chars >= ? THEN chars - ? ELSE 0 END WHERE workspace_id = ? AND day = ?',
    [input.chars, input.chars, input.workspaceId, usageDay(input.at)],
  );
}
