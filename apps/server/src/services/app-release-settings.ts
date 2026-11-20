import {
  type ActorType,
  DEFAULT_PLAY_RELEASE_SETTINGS,
  hasEarlierProductionRelease,
  isGooglePlatform,
  isStagedRolloutMode,
  type PlayReleaseSettings,
  STAGED_ROLLOUT_MODES,
  type StagedRolloutMode,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { getApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { type Failure, failure } from './repositories.ts';

/**
 * Per-app settings of a Google Play release (docs/adr/0029-direct-play-release.md, docs/api/releases-write.md): the default share the
 * release steps start from, and whether a staged rollout is offered at all. Plain configuration, never a secret.
 *
 * Stored like the AI settings (services/ai-config.ts): one JSON value in `workspace_settings` under `app.<appId>.release`, outside the
 * generic registry (it is per app), so there is no migration. A stored value that no longer validates is ignored (the defaults apply).
 * Deleted with the app. Nothing here writes to a store, and a default share is only a PRE-FILL: the release step still needs the
 * person to confirm the share in the typed phrase.
 */

export type AppReleaseSettings = PlayReleaseSettings;
export const DEFAULT_APP_RELEASE_SETTINGS: AppReleaseSettings = DEFAULT_PLAY_RELEASE_SETTINGS;

export const settingsKeyOf = (appId: string): string => `app.${appId}.release`;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseSharePercent(raw: unknown): Parsed<number | null> {
  if (raw === null) return { ok: true, value: null };
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < 1 ||
    raw > 100 ||
    Math.round(raw * 100) / 100 !== raw
  )
    return { ok: false, message: 'Use a percent from 1 to 100 (at most 2 decimals), or null for none.' };
  return { ok: true, value: raw };
}

export function parseStagedRollout(raw: unknown): Parsed<StagedRolloutMode> {
  return isStagedRolloutMode(raw)
    ? { ok: true, value: raw }
    : { ok: false, message: `Use one of ${STAGED_ROLLOUT_MODES.join(', ')}.` };
}

/** A stored value read back: what validates is kept, the rest is the default. */
function fromStored(raw: unknown): AppReleaseSettings {
  const out = { ...DEFAULT_APP_RELEASE_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  const share = parseSharePercent(r.defaultSharePercent);
  if (share.ok) out.defaultSharePercent = share.value;
  const mode = parseStagedRollout(r.stagedRollout);
  if (mode.ok) out.stagedRollout = mode.value;
  return out;
}

export async function readAppReleaseSettings(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppReleaseSettings> {
  const [row] = await sql.query(
    'SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?',
    [workspaceId, settingsKeyOf(appId)],
  );
  if (!row) return { ...DEFAULT_APP_RELEASE_SETTINGS };
  try {
    return fromStored(JSON.parse(String(row.value_json)));
  } catch {
    return { ...DEFAULT_APP_RELEASE_SETTINGS };
  }
}

export const deleteAppReleaseSettings = (sql: Sql, workspaceId: string, appId: string) =>
  sql.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [
    workspaceId,
    settingsKeyOf(appId),
  ]);

/**
 * `GET /apps/{id}/release-settings`: stored values only, no store is contacted. `earlierProductionRelease` is read from the stored
 * releases (as of the last sync): a production release that is live, rolling out or halted. It is what `auto` goes by.
 */
export async function getAppReleaseSettings(
  db: Database,
  input: { workspaceId: string; appId: string },
): Promise<
  { ok: true; settings: AppReleaseSettings; earlierProductionRelease: boolean } | Failure
> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const rows = await db.query(
    "SELECT track, status FROM app_releases WHERE workspace_id = ? AND app_id = ? AND track = 'production'",
    [input.workspaceId, input.appId],
  );
  return {
    ok: true,
    settings: await readAppReleaseSettings(db, input.workspaceId, input.appId),
    earlierProductionRelease: hasEarlierProductionRelease(
      rows.map((r) => ({
        track: r.track === null || r.track === undefined ? null : String(r.track),
        status: r.status === null || r.status === undefined ? null : String(r.status),
      })),
    ),
  };
}

/**
 * `PUT /apps/{id}/release-settings`: a partial update (a key to a value, or `defaultSharePercent` to null for none; `stagedRollout`
 * cannot be null, it is changed to `auto` to go back). All or nothing. Google Play apps only. Audited as `app.release_settings_update`
 * with the app id and the old and new values (configuration, no secret).
 */
export async function updateAppReleaseSettings(
  db: Database,
  input: { workspaceId: string; appId: string; changes: Record<string, unknown>; actor: { type: ActorType; id: string } },
  now: number,
): Promise<{ ok: true; settings: AppReleaseSettings; changed: string[] } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!isGooglePlatform(app.platform))
    return failure(
      422,
      'not_applicable',
      'These settings are for Google Play releases. An App Store release has no share.',
    );
  const issues: { path: string; message: string }[] = [];
  const next: Partial<AppReleaseSettings> = {};
  for (const [key, raw] of Object.entries(input.changes)) {
    if (key === 'defaultSharePercent') {
      const p = parseSharePercent(raw);
      if (p.ok) next.defaultSharePercent = p.value;
      else issues.push({ path: key, message: p.message });
    } else if (key === 'stagedRollout') {
      const p = parseStagedRollout(raw);
      if (p.ok) next.stagedRollout = p.value;
      else issues.push({ path: key, message: p.message });
    } else issues.push({ path: key, message: 'Not a release setting of an app.' });
  }
  if (issues.length > 0)
    return failure(422, 'invalid_setting', 'A release setting is not valid.', { issues });
  return db.transaction(async (tx) => {
    const before = await readAppReleaseSettings(tx, input.workspaceId, input.appId);
    const after: AppReleaseSettings = { ...before, ...next };
    const changed = (Object.keys(next) as (keyof AppReleaseSettings)[]).filter(
      (k) => before[k] !== after[k],
    );
    if (changed.length === 0) return { ok: true as const, settings: after, changed };
    await tx.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.workspaceId, settingsKeyOf(input.appId), JSON.stringify(after), now, input.actor.id],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'app.release_settings_update',
      target: { type: 'app', id: input.appId },
      detail: {
        appId: input.appId,
        changes: changed.map((k) => ({ key: k, from: before[k], to: after[k] })),
      },
      at: now,
    });
    return { ok: true as const, settings: after, changed };
  });
}
