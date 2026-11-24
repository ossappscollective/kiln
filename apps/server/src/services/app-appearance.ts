import type { ActorType } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../i18n/problem.ts';
import { getApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { type Failure, failure } from './repositories.ts';

/**
 * Per-app appearance (docs/adr/0068-app-tint.md, docs/api/apps.md "Appearance"): how the web app tints its interface for one app.
 * `auto` (the default: the colours of the app icon), `off` (no tint for this app) or `custom` (a colour a person picked, `#rrggbb`).
 * Plain configuration, never a secret. The web app derives accessible tokens from the colour (contrast is the client's rule, so any
 * colour is safe to store).
 *
 * Stored like the listing settings (services/app-listing-settings.ts): one JSON value in `workspace_settings` under
 * `app.<appId>.appearance`, so there is no migration, an app that never set it (every app) reads `auto`, and `auto` is stored as
 * no row at all. Deleted with the app.
 */

export type AppAppearance = { tint: 'auto' | 'off' | 'custom'; color?: string };
export const DEFAULT_APP_APPEARANCE: AppAppearance = { tint: 'auto' };

export const appearanceKeyOf = (appId: string): string => `app.${appId}.appearance`;

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** A stored or submitted value, or null when it is not valid. A colour is only kept for `custom`, lower case. */
export function parseAppearance(raw: unknown): AppAppearance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.tint === 'auto' || r.tint === 'off') return { tint: r.tint };
  if (r.tint === 'custom' && typeof r.color === 'string' && COLOR.test(r.color))
    return { tint: 'custom', color: r.color.toLowerCase() };
  return null;
}

/** Every stored appearance of a workspace (apps with the default are absent). An invalid stored value is ignored. */
export async function readAppearances(
  sql: Sql,
  workspaceId: string,
): Promise<Record<string, AppAppearance>> {
  const rows = await sql.query(
    "SELECT key, value_json FROM workspace_settings WHERE workspace_id = ? AND key LIKE 'app.%.appearance'",
    [workspaceId],
  );
  const out: Record<string, AppAppearance> = {};
  for (const row of rows) {
    const key = String(row.key);
    const appId = key.slice('app.'.length, key.length - '.appearance'.length);
    try {
      const parsed = parseAppearance(JSON.parse(String(row.value_json)));
      if (parsed && parsed.tint !== 'auto') out[appId] = parsed;
    } catch {
      // Ignored: the default applies.
    }
  }
  return out;
}

export async function readAppAppearance(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppAppearance> {
  const [row] = await sql.query(
    'SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?',
    [workspaceId, appearanceKeyOf(appId)],
  );
  if (!row) return { ...DEFAULT_APP_APPEARANCE };
  try {
    return parseAppearance(JSON.parse(String(row.value_json))) ?? { ...DEFAULT_APP_APPEARANCE };
  } catch {
    return { ...DEFAULT_APP_APPEARANCE };
  }
}

export const deleteAppAppearance = (sql: Sql, workspaceId: string, appId: string) =>
  sql.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [
    workspaceId,
    appearanceKeyOf(appId),
  ]);

/**
 * `PUT /apps/{id}/appearance`: replaces the value. `auto` removes the row. 404 for an app of another workspace. Audited as
 * `app.appearance_update` (the app id and the old and new values).
 */
export async function updateAppAppearance(
  db: Database,
  input: {
    workspaceId: string;
    appId: string;
    value: unknown;
    actor: { type: ActorType; id: string };
  },
  now: number,
): Promise<{ ok: true; appearance: AppAppearance; changed: boolean } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const next = parseAppearance(input.value);
  if (!next)
    return failure(422, 'invalid_setting', 'The appearance is not valid.', {
      issues: [{ path: 'tint', message: 'Use auto, off, or custom with a color such as #3b82f6.' }],
      ...coded('app.appearanceInvalid'),
    });
  return db.transaction(async (tx) => {
    const before = await readAppAppearance(tx, input.workspaceId, input.appId);
    if (before.tint === next.tint && before.color === next.color)
      return { ok: true as const, appearance: next, changed: false };
    if (next.tint === 'auto') await deleteAppAppearance(tx, input.workspaceId, input.appId);
    else
      await tx.execute(
        `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [
          input.workspaceId,
          appearanceKeyOf(input.appId),
          JSON.stringify(next),
          now,
          input.actor.id,
        ],
      );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'app.appearance_update',
      target: { type: 'app', id: input.appId },
      detail: { appId: input.appId, from: before, to: next },
      at: now,
    });
    return { ok: true as const, appearance: next, changed: true };
  });
}
