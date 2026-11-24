import { type ExpoClient, expoUpdateChannels, type StoredUpdate, storedUpdatesOf } from '@kiln/connectors';
import { nullableNumber, nullableString, type Sql } from '@kiln/db';
import { emitEvent } from '../../services/events.ts';
import { alertDef, resolveParams } from '../alerts/catalog.ts';
import { loadRules } from '../alerts/prefs.ts';
import type { ExpoLinkView } from './link.ts';

/**
 * The OTA (EAS Update) state kept by the status sync (docs/adr/0060-eas-update-state.md): per channel the current update, and the updates
 * that are mid-rollout, in `eas_updates`. Read by the same sync as the builds (one more request); the views read the database only.
 * The `eas.update_rollout_stuck` event is raised here, once per update, when a rollout has stayed at one percentage below 100 for longer than
 * the threshold of the alert rule (hours, default 48). The event holds ids, platform, channel and percentage: never the update message.
 */

export const STUCK_ALERT_ID = 'eas.update_rollout_stuck';
const HOUR = 3_600_000;
const EXPO_WEB_ORIGIN = 'https://expo.dev';

export type EasUpdateView = {
  id: string;
  group: string;
  platform: string;
  channel: string;
  branch: string | null;
  runtimeVersion: string | null;
  /** The publisher's text, first line. Shown on screen only. */
  message: string | null;
  createdAt: number | null;
  /** 1 to 99 while a per-update rollout is going, else null. */
  rolloutPercentage: number | null;
  /** When this server first read this percentage; null when not mid-rollout. */
  rolloutSince: number | null;
  /** The page of the update group at expo.dev (address shape assumed, see the ADR). */
  expoUrl: string | null;
};

export type EasChannelUpdates = {
  channel: string;
  /** The newest update of the branches the channel serves, null when none is stored for the platform. */
  current: EasUpdateView | null;
  /** Other updates of the channel that are mid-rollout. */
  rollouts: EasUpdateView[];
};

export type EasUpdatesView = {
  /** Last successful read of the updates; null before the first. */
  readAt: number | null;
  /** A short code when the last read of the updates failed (the builds may have been read fine), else null. */
  lastError: string | null;
  channels: EasChannelUpdates[];
};

export const NO_UPDATES: EasUpdatesView = { readAt: null, lastError: null, channels: [] };

const groupUrl = (link: Pick<ExpoLinkView, 'accountName' | 'slug'>, group: string) =>
  `${EXPO_WEB_ORIGIN}/accounts/${encodeURIComponent(link.accountName)}/projects/${encodeURIComponent(link.slug)}/updates/${encodeURIComponent(group)}`;

function viewOf(row: Record<string, unknown>, link: ExpoLinkView | null): EasUpdateView {
  const group = String(row.group_id);
  return {
    id: String(row.update_id),
    group,
    platform: String(row.platform),
    channel: String(row.channel),
    branch: nullableString(row.branch),
    runtimeVersion: nullableString(row.runtime_version),
    message: nullableString(row.message),
    createdAt: nullableNumber(row.created_at),
    rolloutPercentage: nullableNumber(row.rollout_percentage),
    rolloutSince: nullableNumber(row.rollout_since),
    expoUrl: link ? groupUrl(link, group) : null,
  };
}

/** The stored updates of an app record. Database only: Expo is not called. */
export async function getEasUpdates(
  sql: Sql,
  workspaceId: string,
  appId: string,
  link: ExpoLinkView | null,
): Promise<EasUpdatesView> {
  const rows = await sql.query(
    'SELECT * FROM eas_updates WHERE app_id = ? AND workspace_id = ? ORDER BY channel, COALESCE(created_at, 0) DESC, update_id',
    [appId, workspaceId],
  );
  const [state] = await sql.query(
    'SELECT updates_read_at, updates_error FROM eas_status_sync WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  const channels = new Map<string, EasChannelUpdates>();
  for (const r of rows) {
    const name = String(r.channel);
    const entry = channels.get(name) ?? { channel: name, current: null, rollouts: [] };
    const view = viewOf(r, link);
    if (Number(r.is_current) === 1) entry.current = view;
    else entry.rollouts.push(view);
    channels.set(name, entry);
  }
  return {
    readAt: state ? nullableNumber(state.updates_read_at) : null,
    lastError: state ? nullableString(state.updates_error) : null,
    channels: [...channels.values()],
  };
}

export type UpdatesRead = { ok: true; rows: StoredUpdate[] } | { ok: false; error: string };

/** One request to Expo: the channels with their newest groups, reduced to what is stored. Never throws: a failure is a short code. */
export async function readUpdatesFromExpo(
  client: ExpoClient,
  projectId: string,
  platform: string,
  failureCode: (error: unknown) => string,
): Promise<UpdatesRead> {
  try {
    const read = await expoUpdateChannels(client, projectId);
    return { ok: true, rows: storedUpdatesOf(read.channels, platform) };
  } catch (error) {
    return { ok: false, error: failureCode(error) };
  }
}

/**
 * Replaces the stored updates of the app record with `rows`, keeping what the clock of a rollout needs: `rollout_since` stays while the
 * percentage is the one stored before (a changed percentage, or a first sight, starts again at `at`), `stuck_event_at` stays once set.
 * Then raises `eas.update_rollout_stuck` for each rollout past the threshold that has not raised it. Call inside the sync transaction.
 */
export async function storeUpdates(
  tx: Sql,
  workspaceId: string,
  appId: string,
  rows: readonly StoredUpdate[],
  at: number,
): Promise<void> {
  const before = new Map<string, { percentage: number | null; since: number | null; stuck: number | null }>();
  for (const r of await tx.query(
    'SELECT channel, update_id, rollout_percentage, rollout_since, stuck_event_at FROM eas_updates WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  )) {
    before.set(`${String(r.channel)}\u0000${String(r.update_id)}`, {
      percentage: nullableNumber(r.rollout_percentage),
      since: nullableNumber(r.rollout_since),
      stuck: nullableNumber(r.stuck_event_at),
    });
  }
  const def = alertDef(STUCK_ALERT_ID);
  const hours = def ? (resolveParams(def, (await loadRules(tx, workspaceId)).get(STUCK_ALERT_ID)?.params).hours ?? 48) : 48;
  await tx.execute('DELETE FROM eas_updates WHERE app_id = ? AND workspace_id = ?', [appId, workspaceId]);
  for (const u of rows) {
    const prev = before.get(`${u.channel}\u0000${u.updateId}`);
    const mid = u.rolloutPercentage !== null;
    const since = mid ? (prev && prev.percentage === u.rolloutPercentage && prev.since !== null ? prev.since : at) : null;
    let stuck = prev?.stuck ?? null;
    if (mid && stuck === null && since !== null && at - since >= hours * HOUR) {
      stuck = at;
      await emitEvent(tx, {
        workspaceId,
        type: 'eas.update_rollout_stuck',
        subject: { appId },
        payload: {
          appId,
          updateId: u.updateId,
          group: u.group,
          platform: u.platform,
          channel: u.channel,
          percentage: u.rolloutPercentage,
          hours: Math.floor((at - since) / HOUR),
        },
        at,
      });
    }
    await tx.execute(
      `INSERT INTO eas_updates
         (app_id, update_id, workspace_id, platform, channel, branch, group_id, runtime_version, message, created_at,
          rollout_percentage, rollout_since, stuck_event_at, is_current, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appId,
        u.updateId,
        workspaceId,
        u.platform,
        u.channel,
        u.branch,
        u.group,
        u.runtimeVersion,
        u.message,
        u.createdAt,
        u.rolloutPercentage,
        since,
        stuck,
        u.isCurrent ? 1 : 0,
        at,
      ],
    );
  }
}
