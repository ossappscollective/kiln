import {
  type Action,
  type ActorType,
  type Role,
  type TranslationMode,
  type TranslationProvider,
  can,
  isTranslationMode,
  isTranslationProvider,
  normalizeLanguageTag,
  translationModes,
  translationProviders,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { recordAudit } from './audit.ts';
import { checkTranslateUrl } from './translate-net.ts';
import { type Resolver, checkWebhookUrl, resolveAllowed } from './webhook-transport.ts';

/**
 * Workspace settings: a small typed registry of the keys a workspace can change, and their storage
 * (`workspace_settings`, one JSON value per key). Only keys in `settingDefinitions` exist: an unknown
 * key is refused, so nothing arbitrary is ever stored. Every key has a validator, a default and a
 * sentence of documentation, and says which action may change it.
 *
 * Secrets NEVER live here: a translation API key is a vault credential. The values here are all
 * plain configuration, so an update is audited with the key names and the old and new VALUES.
 */

export type SettingsContext = {
  /** MRM_TRANSLATE_ALLOW_PRIVATE_URLS: the LibreTranslate address may be private or loopback. */
  allowPrivateUrls?: boolean;
  /** DNS lookup for the address check on save (tests replace it). */
  resolve?: Resolver;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

type Definition<T> = {
  /** What it does, for the docs and the API. */
  doc: string;
  default: T;
  /** The action that may change it. */
  writeAction: Action;
  /**
   * Validates a value. `ctx` is given on a write (server policy such as private addresses applies
   * then); a stored value is read without it, so a policy change never hides what was saved.
   */
  parse(raw: unknown, ctx?: SettingsContext): Parsed<T>;
  /** An extra check that may use the network, on a write only. A sentence when the value is refused. */
  verify?(value: T, ctx: SettingsContext): Promise<string | undefined>;
};

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (message: string): Parsed<never> => ({ ok: false, message });

const integerIn =
  (min: number, max: number) =>
  (raw: unknown): Parsed<number> =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max
      ? ok(raw)
      : bad(`Use a whole number from ${min} to ${max}.`);

export const MAX_DAILY_CHAR_BUDGET = 100_000_000;

export const settingDefinitions = {
  'reviews.lowRatingThreshold': {
    doc: 'A review with this rating or lower raises `review.new_low_rating` (1 to 4). Changing it never re-sends events for reviews already read.',
    default: 2,
    writeAction: 'settings.write',
    parse: integerIn(1, 4),
  } satisfies Definition<number>,
  'translation.enabled': {
    doc: 'Turns review translation on. While off, nothing is sent to a translation provider.',
    default: false,
    writeAction: 'settings.write',
    parse: (raw: unknown): Parsed<boolean> => (typeof raw === 'boolean' ? ok(raw) : bad('Use true or false.')),
  } satisfies Definition<boolean>,
  'translation.provider': {
    doc: `The translation provider: ${translationProviders.join(', ')}. Each needs a credential of its own kind in the vault (LibreTranslate only when its server asks for a key).`,
    default: 'google' as TranslationProvider,
    writeAction: 'settings.write',
    parse: (raw: unknown): Parsed<TranslationProvider> =>
      isTranslationProvider(raw) ? ok(raw) : bad(`Use one of ${translationProviders.join(', ')}.`),
  } satisfies Definition<TranslationProvider>,
  'translation.targetLanguage': {
    doc: 'The language reviews are translated into, a BCP-47 tag such as en, de or pt-BR.',
    default: 'en',
    writeAction: 'settings.write',
    parse: (raw: unknown): Parsed<string> => {
      const tag = typeof raw === 'string' ? normalizeLanguageTag(raw) : undefined;
      return tag ? ok(tag) : bad('Use a language tag such as en, de or pt-BR.');
    },
  } satisfies Definition<string>,
  'translation.mode': {
    doc: 'off: nothing is translated. on_demand: a person asks for a translation. auto: new reviews in another language are translated after a sync, up to 20 per sync and within the daily budget.',
    default: 'on_demand' as TranslationMode,
    writeAction: 'settings.write',
    parse: (raw: unknown): Parsed<TranslationMode> =>
      isTranslationMode(raw) ? ok(raw) : bad(`Use one of ${translationModes.join(', ')}.`),
  } satisfies Definition<TranslationMode>,
  'translation.dailyCharBudget': {
    doc: 'The most characters this workspace sends to a translation provider per UTC day. 0 means no limit here (the provider may still have one).',
    default: 50_000,
    writeAction: 'settings.write',
    parse: integerIn(0, MAX_DAILY_CHAR_BUDGET),
  } satisfies Definition<number>,
  'translation.libretranslate.url': {
    doc: 'The address of the LibreTranslate server, https://host[/path]. Empty means none. A private or loopback address needs MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true on the server. The API key, if the server needs one, is a vault credential.',
    default: '',
    writeAction: 'settings.write',
    parse: (raw: unknown, ctx?: SettingsContext): Parsed<string> => {
      if (typeof raw !== 'string') return bad('Use an address as text.');
      const value = raw.trim();
      if (value === '' || ctx === undefined) return ok(value);
      const check = checkTranslateUrl(value, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
      return check.ok ? ok(check.url) : bad(check.message);
    },
    async verify(value: string, ctx: SettingsContext): Promise<string | undefined> {
      if (value === '') return undefined;
      const check = checkWebhookUrl(value, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
      if (!check.ok) return check.message;
      const resolved = await resolveAllowed(check, {
        ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
      });
      return resolved.ok ? undefined : resolved.message;
    },
  } satisfies Definition<string>,
};

export type SettingKey = keyof typeof settingDefinitions;
export const settingKeys = Object.keys(settingDefinitions) as SettingKey[];
export const isSettingKey = (value: string): value is SettingKey =>
  Object.prototype.hasOwnProperty.call(settingDefinitions, value);

export type SettingValue = number | boolean | string;
export type SettingValues = Record<SettingKey, SettingValue>;

const definition = (key: SettingKey): Definition<SettingValue> =>
  settingDefinitions[key] as unknown as Definition<SettingValue>;

export const defaultSettings = (): SettingValues => {
  const out = {} as SettingValues;
  for (const key of settingKeys) out[key] = definition(key).default;
  return out;
};

export type WorkspaceSettings = {
  /** Every key with its effective value: the stored one, else the default. */
  values: SettingValues;
  /** Keys that have a stored value. */
  overridden: SettingKey[];
};

/** Reads a workspace's settings. A stored value that no longer validates is ignored (the default applies). */
export async function getSettings(sql: Sql, workspaceId: string): Promise<WorkspaceSettings> {
  const rows = await sql.query('SELECT key, value_json FROM workspace_settings WHERE workspace_id = ?', [workspaceId]);
  const values = defaultSettings();
  const overridden: SettingKey[] = [];
  for (const row of rows) {
    const key = String(row.key);
    if (!isSettingKey(key)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(String(row.value_json));
    } catch {
      continue;
    }
    const parsed = definition(key).parse(raw);
    if (!parsed.ok) continue;
    values[key] = parsed.value;
    overridden.push(key);
  }
  return { values, overridden };
}

/**
 * The low rating threshold of a workspace. `fallback` is used when the workspace has not set one
 * (the server's own default, which tests can change).
 */
export async function lowRatingThresholdFor(sql: Sql, workspaceId: string, fallback?: number): Promise<number> {
  const settings = await getSettings(sql, workspaceId);
  if (settings.overridden.includes('reviews.lowRatingThreshold')) {
    return settings.values['reviews.lowRatingThreshold'] as number;
  }
  return fallback ?? (settings.values['reviews.lowRatingThreshold'] as number);
}

/** What `GET /settings` says: values, defaults, documentation and which keys this role may change. */
export function describeSettings(settings: WorkspaceSettings, role: Role) {
  const defaults = defaultSettings();
  const docs = {} as Record<SettingKey, string>;
  for (const key of settingKeys) docs[key] = definition(key).doc;
  return {
    values: settings.values,
    defaults,
    overridden: settings.overridden,
    writable: settingKeys.filter((key) => can(role, definition(key).writeAction)),
    docs,
  };
}

export type SettingChange = { key: SettingKey; from: SettingValue; to: SettingValue };

export type UpdateResult =
  | { ok: true; changes: SettingChange[]; settings: WorkspaceSettings }
  | { ok: false; status: 400 | 403; body: { error: string; message: string; issues?: { path: string; message: string }[] } };

/**
 * A partial update: each key to a new value, or null to go back to the default. All or nothing: one
 * invalid key changes nothing. Unknown keys are refused (`unknown_setting`). The change is audited as
 * `settings.update` with the key names and the old and new values (none of these is a secret).
 */
export async function updateSettings(
  db: Database,
  input: { workspaceId: string; role: Role; changes: Record<string, unknown> },
  actor: { type: ActorType; id: string },
  now: number,
  ctx: SettingsContext = {},
): Promise<UpdateResult> {
  const entries = Object.entries(input.changes);
  const unknown = entries.map(([key]) => key).filter((key) => !isSettingKey(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'unknown_setting',
        message: `Unknown setting: ${unknown.join(', ')}.`,
        issues: unknown.map((path) => ({ path, message: 'Not a setting.' })),
      },
    };
  }
  const forbidden = entries.map(([key]) => key as SettingKey).filter((key) => !can(input.role, definition(key).writeAction));
  if (forbidden.length > 0) {
    return { ok: false, status: 403, body: { error: 'forbidden', message: `You may not change: ${forbidden.join(', ')}.` } };
  }
  const issues: { path: string; message: string }[] = [];
  const next = new Map<SettingKey, SettingValue | null>();
  for (const [rawKey, raw] of entries) {
    const key = rawKey as SettingKey;
    if (raw === null) {
      next.set(key, null);
      continue;
    }
    const parsed = definition(key).parse(raw, ctx);
    if (!parsed.ok) {
      issues.push({ path: key, message: parsed.message });
      continue;
    }
    const refusal = await definition(key).verify?.(parsed.value, ctx);
    if (refusal) issues.push({ path: key, message: refusal });
    else next.set(key, parsed.value);
  }
  if (issues.length > 0) {
    return { ok: false, status: 400, body: { error: 'invalid_setting', message: 'A setting is not valid.', issues } };
  }

  return db.transaction(async (tx): Promise<UpdateResult> => {
    const before = await getSettings(tx, input.workspaceId);
    const changes: SettingChange[] = [];
    for (const [key, value] of next) {
      const has = before.overridden.includes(key);
      const from = before.values[key];
      if (value === null) {
        if (!has) continue;
        await tx.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [input.workspaceId, key]);
        changes.push({ key, from, to: definition(key).default });
        continue;
      }
      if (from === value && (has || value === definition(key).default)) continue;
      await tx.execute(
        `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [input.workspaceId, key, JSON.stringify(value), now, actor.id],
      );
      changes.push({ key, from, to: value });
    }
    if (changes.length > 0) {
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'settings.update',
        target: { type: 'workspace', id: input.workspaceId },
        // Configuration only, never a secret: the old and new values are recorded.
        detail: { keys: changes.map((c) => c.key), changes },
        at: now,
      });
    }
    return { ok: true, changes, settings: await getSettings(tx, input.workspaceId) };
  });
}
