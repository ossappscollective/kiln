import type { ActorType } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../i18n/problem.ts';
import { getApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { type Failure, failure } from './repositories.ts';

/**
 * Per-app settings of the store listing (docs/api/store-listing.md, "Listing settings"): whether the repository is compared with the store
 * (`compareRepo`) and whether the repository's graphics are compared with the store's (`compareMedia`). Both default to OFF: many apps keep
 * no fastlane files, and for them "only one side has a value" is noise. With a flag off, the store page is still checked on its own
 * (limits, required fields), and nothing of the repository is shown as a difference.
 *
 * Stored like the release settings (services/app-release-settings.ts): one JSON value in `workspace_settings` under `app.<appId>.listing`,
 * so there is no migration, and an app that never had it (every existing app) reads as both OFF. Deleted with the app.
 */

export type AppListingSettings = { compareRepo: boolean; compareMedia: boolean };
export const DEFAULT_APP_LISTING_SETTINGS: AppListingSettings = {
  compareRepo: false,
  compareMedia: false,
};
export const LISTING_SETTING_KEYS = ['compareRepo', 'compareMedia'] as const;

export const listingSettingsKeyOf = (appId: string): string => `app.${appId}.listing`;

function fromStored(raw: unknown): AppListingSettings {
  const out = { ...DEFAULT_APP_LISTING_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.compareRepo === 'boolean') out.compareRepo = r.compareRepo;
  if (typeof r.compareMedia === 'boolean') out.compareMedia = r.compareMedia;
  return out;
}

export async function readAppListingSettings(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppListingSettings> {
  const [row] = await sql.query(
    'SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?',
    [workspaceId, listingSettingsKeyOf(appId)],
  );
  if (!row) return { ...DEFAULT_APP_LISTING_SETTINGS };
  try {
    return fromStored(JSON.parse(String(row.value_json)));
  } catch {
    return { ...DEFAULT_APP_LISTING_SETTINGS };
  }
}

export const deleteAppListingSettings = (sql: Sql, workspaceId: string, appId: string) =>
  sql.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [
    workspaceId,
    listingSettingsKeyOf(appId),
  ]);

/** `GET /apps/{id}/listing-settings`: stored values only. */
export async function getAppListingSettings(
  db: Database,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; settings: AppListingSettings } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  return { ok: true, settings: await readAppListingSettings(db, input.workspaceId, input.appId) };
}

/** `PUT /apps/{id}/listing-settings`: a partial update, all or nothing. Audited as `app.listing_settings_update` (the app id, old and new values). */
export async function updateAppListingSettings(
  db: Database,
  input: {
    workspaceId: string;
    appId: string;
    changes: Record<string, unknown>;
    actor: { type: ActorType; id: string };
  },
  now: number,
): Promise<{ ok: true; settings: AppListingSettings; changed: string[] } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const issues: { path: string; message: string }[] = [];
  const next: Partial<AppListingSettings> = {};
  for (const [key, raw] of Object.entries(input.changes)) {
    if ((LISTING_SETTING_KEYS as readonly string[]).includes(key)) {
      if (typeof raw === 'boolean') next[key as keyof AppListingSettings] = raw;
      else issues.push({ path: key, message: 'Use true or false.' });
    } else issues.push({ path: key, message: 'Not a listing setting of an app.' });
  }
  if (issues.length > 0)
    return failure(422, 'invalid_setting', 'A listing setting is not valid.', {
      issues,
      ...coded('app.listingSettingInvalid'),
    });
  return db.transaction(async (tx) => {
    const before = await readAppListingSettings(tx, input.workspaceId, input.appId);
    const after: AppListingSettings = { ...before, ...next };
    const changed = LISTING_SETTING_KEYS.filter((k) => before[k] !== after[k]);
    if (changed.length === 0)
      return { ok: true as const, settings: after, changed: [] as string[] };
    await tx.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [
        input.workspaceId,
        listingSettingsKeyOf(input.appId),
        JSON.stringify(after),
        now,
        input.actor.id,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'app.listing_settings_update',
      target: { type: 'app', id: input.appId },
      detail: {
        appId: input.appId,
        changes: changed.map((k) => ({ key: k, from: before[k], to: after[k] })),
      },
      at: now,
    });
    return { ok: true as const, settings: after, changed: [...changed] };
  });
}
