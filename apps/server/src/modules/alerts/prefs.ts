import { randomUUID } from 'node:crypto';
import type { ActorType } from '@kiln/core';
import type { Database, Row, Sql } from '@kiln/db';
import { recordAudit } from '../../services/audit.ts';
import {
  type AlertChannel,
  type AlertDef,
  type AlertSeverity,
  type AlertTypeId,
  alertChannels,
  alertDef,
  configurableAlertTypes,
  isPersonalChannel,
  isSeverity,
  personalChannels,
  resolveParams,
} from './catalog.ts';
import { type DigestMode, digestModes, isValidTimeZone } from './time.ts';

import { type Coding, type ErrorParams, coded } from '../../i18n/problem.ts';
/**
 * What people and admins decided about alerts (docs/alerts.md): the workspace rule of each type (admins), a person's own settings,
 * channels per type and app, and mutes (everyone for themselves). Pure reads and writes of choices; nothing here sends anything.
 */

type Actor = { type: ActorType; id: string };
export type PrefsFailure = {
  ok: false;
  status: 400 | 404;
  error: string;
  message?: string;
  code?: string;
  params?: ErrorParams;
};
const bad = (error: string, message: string, coding?: Coding): PrefsFailure => ({
  ok: false,
  status: 400,
  error,
  message,
  ...coding,
});

const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

// ----- workspace rules ---------------------------------------------------------------------------------

export type StoredRule = {
  enabled: boolean;
  channels: AlertChannel[];
  maxPerHour: number | null;
  params: Record<string, unknown>;
};

export type RuleView = {
  alertType: AlertTypeId;
  enabled: boolean;
  /** What people get who made no choice of their own; `webhook` is the workspace channel itself. */
  channels: AlertChannel[];
  maxPerHour: number;
  params: Record<string, number>;
  /** False while the catalog defaults apply (no row). */
  custom: boolean;
};

/** Channels kept to the ones the type may use, once each, in the order of `alertChannels`. */
export const normalizeChannels = (
  def: Pick<AlertDef, 'allowedChannels'>,
  list: readonly unknown[],
): AlertChannel[] =>
  alertChannels.filter((c) => list.includes(c) && def.allowedChannels.includes(c));

export async function loadRules(sql: Sql, workspaceId: string): Promise<Map<string, StoredRule>> {
  const rows = await sql.query(
    'SELECT alert_type, enabled, channels, max_per_hour, params FROM alert_workspace_rules WHERE workspace_id = ?',
    [workspaceId],
  );
  const out = new Map<string, StoredRule>();
  for (const r of rows) {
    const def = alertDef(String(r.alert_type));
    if (!def) continue;
    out.set(def.id, {
      enabled: Number(r.enabled) === 1,
      channels: normalizeChannels(def, parseJson<unknown[]>(r.channels, [])),
      maxPerHour:
        r.max_per_hour === null || r.max_per_hour === undefined ? null : Number(r.max_per_hour),
      params: parseJson<Record<string, unknown>>(r.params, {}),
    });
  }
  return out;
}

export function ruleView(def: AlertDef<AlertTypeId>, stored: StoredRule | undefined): RuleView {
  return {
    alertType: def.id,
    enabled: stored ? stored.enabled : true,
    channels: stored ? stored.channels : normalizeChannels(def, def.defaultChannels),
    maxPerHour: stored?.maxPerHour ?? def.maxPerHour,
    params: resolveParams(def, stored?.params),
    custom: stored !== undefined,
  };
}

export async function listRuleViews(sql: Sql, workspaceId: string): Promise<RuleView[]> {
  const stored = await loadRules(sql, workspaceId);
  return configurableAlertTypes.map((def) => ruleView(def, stored.get(def.id)));
}

export type RuleInput = {
  enabled?: boolean | undefined;
  channels?: readonly string[] | undefined;
  maxPerHour?: number | null | undefined;
  params?: Record<string, number> | undefined;
};

export async function setRule(
  ctx: { db: Database; now: () => number },
  input: { workspaceId: string; alertType: string; rule: RuleInput },
  actor: Actor,
): Promise<{ ok: true; rule: RuleView } | PrefsFailure> {
  const def = alertDef(input.alertType);
  if (!def || def.source.kind === 'internal') return { ok: false, status: 404, error: 'not_found' };
  const { rule } = input;
  if (rule.channels) {
    const unknown = rule.channels.filter((c) => !def.allowedChannels.includes(c as AlertChannel));
    if (unknown.length > 0)
      return bad('channel_not_allowed', `This alert cannot use: ${unknown.join(', ')}.`);
  }
  const paramsIn: Record<string, number> = {};
  for (const [key, value] of Object.entries(rule.params ?? {})) {
    const p = def.params[key];
    if (!p) return bad('unknown_param', `This alert has no setting "${key}".`);
    if (!Number.isInteger(value) || value < p.min || value > p.max) {
      return bad(
        'param_out_of_range',
        `"${p.label}" must be a whole number from ${p.min} to ${p.max} ${p.unit}.`,
      );
    }
    paramsIn[key] = value;
  }
  if (
    rule.maxPerHour !== undefined &&
    rule.maxPerHour !== null &&
    (!Number.isInteger(rule.maxPerHour) || rule.maxPerHour < 1 || rule.maxPerHour > 1000)
  ) {
    return bad(
      'max_per_hour_out_of_range',
      'The hourly limit must be a whole number from 1 to 1000.',
    );
  }
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const before = (await loadRules(tx, input.workspaceId)).get(def.id);
    const next: StoredRule = {
      enabled: rule.enabled ?? before?.enabled ?? true,
      channels: rule.channels
        ? normalizeChannels(def, rule.channels)
        : (before?.channels ?? normalizeChannels(def, def.defaultChannels)),
      maxPerHour: rule.maxPerHour === undefined ? (before?.maxPerHour ?? null) : rule.maxPerHour,
      params: { ...(before?.params ?? {}), ...paramsIn },
    };
    await tx.execute(
      `INSERT INTO alert_workspace_rules (workspace_id, alert_type, enabled, channels, max_per_hour, params, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, alert_type) DO UPDATE SET
         enabled = excluded.enabled, channels = excluded.channels, max_per_hour = excluded.max_per_hour,
         params = excluded.params, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        input.workspaceId,
        def.id,
        next.enabled ? 1 : 0,
        JSON.stringify(next.channels),
        next.maxPerHour,
        JSON.stringify(next.params),
        actor.id,
        at,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'alert.rule_set',
      target: { type: 'alert_type', id: def.id },
      detail: {
        enabled: next.enabled,
        channels: next.channels,
        maxPerHour: next.maxPerHour,
        params: paramsIn,
      },
      at,
    });
    return { ok: true as const, rule: ruleView(def, next) };
  });
}

/** Back to the catalog defaults for one type. */
export async function resetRule(
  ctx: { db: Database; now: () => number },
  input: { workspaceId: string; alertType: string },
  actor: Actor,
): Promise<{ ok: true; rule: RuleView } | PrefsFailure> {
  const def = alertDef(input.alertType);
  if (!def || def.source.kind === 'internal') return { ok: false, status: 404, error: 'not_found' };
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      'DELETE FROM alert_workspace_rules WHERE workspace_id = ? AND alert_type = ?',
      [input.workspaceId, def.id],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'alert.rule_reset',
      target: { type: 'alert_type', id: def.id },
      at,
    });
  });
  return { ok: true, rule: ruleView(def, undefined) };
}

// ----- a person's settings -----------------------------------------------------------------------------

export type UserSettings = {
  minSeverity: AlertSeverity;
  /** Minutes after midnight in `timezone`; null for no quiet hours. */
  quietStart: number | null;
  quietEnd: number | null;
  timezone: string | null;
  digest: DigestMode;
  digestHour: number;
  lastDigestAt: number | null;
};

export const defaultUserSettings = (): UserSettings => ({
  minSeverity: 'info',
  quietStart: null,
  quietEnd: null,
  timezone: null,
  digest: 'off',
  digestHour: 8,
  lastDigestAt: null,
});

const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const toUserSettings = (r: Row): UserSettings => ({
  minSeverity: isSeverity(r.min_severity) ? r.min_severity : 'info',
  quietStart: optNum(r.quiet_start),
  quietEnd: optNum(r.quiet_end),
  timezone: r.timezone === null || r.timezone === undefined ? null : String(r.timezone),
  digest: (digestModes as readonly string[]).includes(String(r.digest))
    ? (String(r.digest) as DigestMode)
    : 'off',
  digestHour: Number(r.digest_hour ?? 8),
  lastDigestAt: optNum(r.last_digest_at),
});

export async function loadUserSettings(
  sql: Sql,
  workspaceId: string,
  userId: string,
): Promise<UserSettings> {
  const [row] = await sql.query(
    `SELECT min_severity, quiet_start, quiet_end, timezone, digest, digest_hour, last_digest_at
       FROM alert_user_settings WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, userId],
  );
  return row ? toUserSettings(row) : defaultUserSettings();
}

export type UserSettingsInput = Partial<Omit<UserSettings, 'lastDigestAt'>>;

export async function saveUserSettings(
  ctx: { db: Database; now: () => number },
  input: { workspaceId: string; userId: string; settings: UserSettingsInput },
): Promise<{ ok: true; settings: UserSettings } | PrefsFailure> {
  const s = input.settings;
  const minute = (v: number | null | undefined) =>
    v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v < 1440);
  if (s.minSeverity !== undefined && !isSeverity(s.minSeverity))
    return bad('invalid_severity', 'The lowest severity must be info, warning or critical.');
  if (!minute(s.quietStart) || !minute(s.quietEnd))
    return bad('invalid_quiet_hours', 'Quiet hours are minutes after midnight, from 0 to 1439.');
  if (s.timezone !== undefined && s.timezone !== null && !isValidTimeZone(s.timezone))
    return bad('invalid_timezone', 'That is not a timezone name such as Europe/Paris.');
  if (s.digest !== undefined && !digestModes.includes(s.digest))
    return bad('invalid_digest', 'The digest is off, daily or weekly.');
  if (
    s.digestHour !== undefined &&
    (!Number.isInteger(s.digestHour) || s.digestHour < 0 || s.digestHour > 23)
  )
    return bad('invalid_digest_hour', 'The digest hour is from 0 to 23.');
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const current = await loadUserSettings(tx, input.workspaceId, input.userId);
    const next: UserSettings = { ...current, ...s, lastDigestAt: current.lastDigestAt };
    // One end of the window without the other means no window; quiet hours need a timezone (UTC when none is set).
    if (next.quietStart === null || next.quietEnd === null) {
      next.quietStart = null;
      next.quietEnd = null;
    }
    // Turning the digest on starts counting now, so the first one is not a backlog of old alerts.
    if (current.digest === 'off' && next.digest !== 'off') next.lastDigestAt = at;
    await tx.execute(
      `INSERT INTO alert_user_settings
         (workspace_id, user_id, min_severity, quiet_start, quiet_end, timezone, digest, digest_hour, last_digest_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         min_severity = excluded.min_severity, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
         timezone = excluded.timezone, digest = excluded.digest, digest_hour = excluded.digest_hour,
         last_digest_at = excluded.last_digest_at, updated_at = excluded.updated_at`,
      [
        input.workspaceId,
        input.userId,
        next.minSeverity,
        next.quietStart,
        next.quietEnd,
        next.timezone,
        next.digest,
        next.digestHour,
        next.lastDigestAt,
        at,
      ],
    );
    return { ok: true as const, settings: next };
  });
}

// ----- a person's channels per type and app -------------------------------------------------------------

export type PreferenceView = {
  alertType: AlertTypeId;
  appId: string | null;
  channels: AlertChannel[];
};

export async function listPreferences(
  sql: Sql,
  workspaceId: string,
  userId: string,
): Promise<PreferenceView[]> {
  const rows = await sql.query(
    'SELECT alert_type, app_id, channels FROM alert_preferences WHERE workspace_id = ? AND user_id = ? ORDER BY alert_type, app_id',
    [workspaceId, userId],
  );
  const out: PreferenceView[] = [];
  for (const r of rows) {
    const def = alertDef(String(r.alert_type));
    if (!def) continue;
    out.push({
      alertType: def.id,
      appId: String(r.app_id) === '' ? null : String(r.app_id),
      channels: normalizeChannels(def, parseJson<unknown[]>(r.channels, [])).filter((c) =>
        isPersonalChannel(c),
      ),
    });
  }
  return out;
}

/** Sets a person's channels for one type (all apps, or one app); `channels: null` removes the choice, so the workspace rule applies. */
export async function setPreference(
  ctx: { db: Database; now: () => number },
  input: {
    workspaceId: string;
    userId: string;
    alertType: string;
    appId: string | null;
    channels: readonly string[] | null;
  },
): Promise<{ ok: true; preference: PreferenceView | null } | PrefsFailure> {
  const def = alertDef(input.alertType);
  if (!def || def.source.kind === 'internal') return { ok: false, status: 404, error: 'not_found' };
  if (input.appId !== null) {
    if (def.scope !== 'app')
      return bad(
        'not_app_scoped',
        'This alert is about the whole workspace, not one app.',
        coded('alerts.notAppScoped'),
      );
    const [app] = await ctx.db.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      input.appId,
      input.workspaceId,
    ]);
    if (!app) return { ok: false, status: 404, error: 'not_found' };
  }
  const appKey = input.appId ?? '';
  if (input.channels === null) {
    await ctx.db.execute(
      'DELETE FROM alert_preferences WHERE workspace_id = ? AND user_id = ? AND alert_type = ? AND app_id = ?',
      [input.workspaceId, input.userId, def.id, appKey],
    );
    return { ok: true, preference: null };
  }
  const wrong = input.channels.filter(
    (c) => !isPersonalChannel(c) || !def.allowedChannels.includes(c),
  );
  if (wrong.length > 0)
    return bad(
      'channel_not_allowed',
      `Your choices are in_app, email and desktop; this alert cannot use: ${wrong.join(', ')}.`,
    );
  // The desktop notification is shown from the inbox, so choosing it includes the inbox.
  const channels = normalizeChannels(
    def,
    input.channels.includes('desktop') ? [...input.channels, 'in_app'] : input.channels,
  ).filter((c) => personalChannels.includes(c as never));
  await ctx.db.execute(
    `INSERT INTO alert_preferences (workspace_id, user_id, alert_type, app_id, channels, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, user_id, alert_type, app_id) DO UPDATE SET channels = excluded.channels, updated_at = excluded.updated_at`,
    [input.workspaceId, input.userId, def.id, appKey, JSON.stringify(channels), ctx.now()],
  );
  return { ok: true, preference: { alertType: def.id, appId: input.appId, channels } };
}

// ----- mutes and snoozes --------------------------------------------------------------------------------

export type MuteView = {
  id: string;
  appId: string | null;
  alertType: AlertTypeId | null;
  until: number | null;
  createdAt: number;
};

export const MAX_MUTES_PER_USER = 100;

const toMute = (r: Row): MuteView => ({
  id: String(r.id),
  appId: r.app_id === null || r.app_id === undefined ? null : String(r.app_id),
  alertType:
    r.alert_type === null || r.alert_type === undefined
      ? null
      : (String(r.alert_type) as AlertTypeId),
  until: optNum(r.until),
  createdAt: Number(r.created_at),
});

/** The mutes of a person that still apply at `at` (a snooze that ended is not listed). */
export async function listMutes(
  sql: Sql,
  workspaceId: string,
  userId: string,
  at: number,
): Promise<MuteView[]> {
  const rows = await sql.query(
    `SELECT id, app_id, alert_type, until, created_at FROM alert_mutes
      WHERE workspace_id = ? AND user_id = ? AND (until IS NULL OR until > ?) ORDER BY created_at DESC`,
    [workspaceId, userId, at],
  );
  return rows.map(toMute);
}

export async function createMute(
  ctx: { db: Database; now: () => number },
  input: {
    workspaceId: string;
    userId: string;
    appId?: string | null;
    alertType?: string | null;
    until: number | null;
  },
): Promise<{ ok: true; mute: MuteView } | PrefsFailure> {
  const at = ctx.now();
  const appId = input.appId ?? null;
  const alertType = input.alertType ?? null;
  if (
    alertType !== null &&
    (!alertDef(alertType) || alertDef(alertType)?.source.kind === 'internal')
  )
    return bad(
      'unknown_alert_type',
      'That alert type does not exist.',
      coded('alerts.unknownType'),
    );
  if (
    input.until !== null &&
    (!Number.isInteger(input.until) || input.until <= at || input.until > at + 366 * 24 * 3_600_000)
  ) {
    return bad(
      'invalid_until',
      'A snooze ends in the future, within a year. Leave it out to mute until you turn it back on.',
      coded('alerts.snoozeInvalid'),
    );
  }
  if (appId !== null) {
    const [app] = await ctx.db.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      appId,
      input.workspaceId,
    ]);
    if (!app) return { ok: false, status: 404, error: 'not_found' };
  }
  const active = await listMutes(ctx.db, input.workspaceId, input.userId, at);
  if (active.length >= MAX_MUTES_PER_USER)
    return bad(
      'too_many_mutes',
      'There are too many mutes. Remove some you no longer need.',
      coded('alerts.tooManyMutes'),
    );
  const id = randomUUID();
  await ctx.db.execute(
    'INSERT INTO alert_mutes (id, workspace_id, user_id, app_id, alert_type, until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.workspaceId, input.userId, appId, alertType, input.until, at],
  );
  return {
    ok: true,
    mute: {
      id,
      appId,
      alertType: alertType as AlertTypeId | null,
      until: input.until,
      createdAt: at,
    },
  };
}

export async function deleteMute(
  sql: Sql,
  input: { workspaceId: string; userId: string; id: string },
): Promise<boolean> {
  return (
    (await sql.execute(
      'DELETE FROM alert_mutes WHERE id = ? AND workspace_id = ? AND user_id = ?',
      [input.id, input.workspaceId, input.userId],
    )) > 0
  );
}

/** Whether a mute list silences an alert of `type` about `appId` at `at`. */
export const isMuted = (
  mutes: readonly MuteView[],
  type: string,
  appId: string | null,
  at: number,
): boolean =>
  mutes.some(
    (m) =>
      (m.until === null || m.until > at) &&
      (m.alertType === null || m.alertType === type) &&
      (m.appId === null || m.appId === appId),
  );
