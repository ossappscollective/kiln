import { randomUUID } from 'node:crypto';
import {
  type AiClient,
  AiError,
  aiErrorMessage,
  type CreateAiClientInput,
  createAiClient,
} from '@mrm/connectors';
import {
  type Action,
  type AiErrorKind,
  type AiProvider,
  aiLimits,
  aiProviderInfo,
  aiProviders,
  can,
  isAiProvider,
  type Role,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import {
  checkTranslateUrl,
  createGuardedFetch,
  type GuardedFetch,
  type PostExchange,
} from '../../services/translate-net.ts';
import { checkWebhookUrl, type Resolver, resolveAllowed } from '../../services/webhook-transport.ts';

/**
 * The AI configuration of a workspace and the failure vocabulary of the AI routes (docs/api/ai.md,
 * docs/adr/0016-ai-foundation.md).
 *
 * - The values live in `workspace_settings` under `ai.*` keys but are NOT in the generic settings registry:
 *   they have their own validation (the address policy is MRM_AI_ALLOW_PRIVATE_URLS, not the translation one),
 *   their own right (`ai.manage`) and their own audit entry. `PUT /settings` refuses them as unknown keys.
 * - The API key is a vault credential of kind `ai_anthropic`, `ai_openai` or `ai_openai_compatible`, found
 *   the way the translation credential is found (the oldest of its kind in the workspace). It is decrypted for the
 *   length of one call and never returned, logged or audited.
 * - Two switches must both be on: the server's (`MRM_AI_ENABLED`, default false) and the workspace's (`ai.enabled`,
 *   default false). Either off, nothing is sent to a provider and no client is built.
 */

export type AiActor = { type: 'user' | 'token' | 'system'; id: string };

export type AiFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 429 | 502 | 504;
  body: Record<string, unknown> & { error: string; message: string };
  headers?: Record<string, string>;
};

export const aiFail = (
  status: AiFailure['status'],
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
): AiFailure => ({
  ok: false,
  status,
  body: { error, message, ...extra },
  ...(headers ? { headers } : {}),
});

export const NOT_ENABLED = {
  server:
    'AI assistance is switched off on this server. The operator can turn it on with MRM_AI_ENABLED=true.',
  workspace:
    'AI assistance is turned off for this workspace. An admin can turn it on in the AI settings.',
} as const;

const NOT_CONFIGURED = {
  no_model: 'No model has been chosen. An admin can set it in the AI settings.',
  no_credential:
    'No key for the AI provider has been added yet. An admin can add one under Credentials.',
  no_url:
    'The address of the model server has not been set. An admin can set it in the AI settings.',
  credential_unreadable:
    'The key of the AI provider could not be decrypted. An admin must enter it again.',
  bad_url:
    'The address of the model server is not allowed by this server. An admin can change it in the AI settings.',
} as const;
export type AiNotConfiguredReason = keyof typeof NOT_CONFIGURED;

export const aiNotConfigured = (
  reason: AiNotConfiguredReason,
  provider?: AiProvider,
  extra: Record<string, unknown> = {},
): AiFailure =>
  aiFail(422, 'ai_not_configured', NOT_CONFIGURED[reason], {
    reason,
    ...(provider ? { provider } : {}),
    ...extra,
  });

/**
 * Why an address of a model server is refused, as a FIXED code a screen can explain (the policy itself is not weakened by naming it):
 * - `private_address_blocked`: the address is a loopback, private or LAN address (or a name that resolves to one) and this server only talks
 *   to public addresses. The operator allows it with MRM_AI_ALLOW_PRIVATE_URLS=true.
 * - `plain_http_not_allowed`: plain http is only accepted for localhost (and only with that switch on); every other address needs https.
 */
export type AddressHint = 'private_address_blocked' | 'plain_http_not_allowed';

export const ADDRESS_HINT_MESSAGES: Record<AddressHint, string> = {
  private_address_blocked:
    'This server only talks to public addresses. To use a model on this machine or your network, the person who runs this server sets MRM_AI_ALLOW_PRIVATE_URLS=true and restarts it.',
  plain_http_not_allowed:
    'Plain http is accepted only for localhost, and only when MRM_AI_ALLOW_PRIVATE_URLS=true. Use an https address for any other server.',
};

/**
 * Explains a refused address. Never loosens anything: it only asks "would this pass if private addresses were allowed?". Cheap checks first; the
 * name is resolved only when the text of the address passes both ways (a name can point at a private address).
 */
export async function addressHint(
  raw: string,
  ctx: { allowPrivateUrls?: boolean; resolve?: Resolver },
): Promise<AddressHint | undefined> {
  const text = raw.trim();
  const relaxed = checkWebhookUrl(text, { allowPrivate: true });
  if (!relaxed.ok)
    return /^Plain http/.test(relaxed.message) ? 'plain_http_not_allowed' : undefined;
  if (ctx.allowPrivateUrls) return undefined;
  const strict = checkWebhookUrl(text, {});
  if (!strict.ok) return 'private_address_blocked';
  const options = ctx.resolve ? { resolve: ctx.resolve } : {};
  const open = await resolveAllowed(relaxed, { allowPrivate: true, ...options });
  const closed = await resolveAllowed(strict, options);
  return open.ok && !closed.ok && !closed.transient ? 'private_address_blocked' : undefined;
}

export const aiNotEnabled = (which: 'server' | 'workspace'): AiFailure =>
  aiFail(409, 'ai_not_enabled', NOT_ENABLED[which], { reason: which });

/** The failure for a provider error. Fixed sentences only: never provider text, never the model's words. */
export function failureForAiError(error: AiError, provider: AiProvider): AiFailure {
  const kind: AiErrorKind = error.kind;
  const message = aiErrorMessage(kind);
  const hint = error.detail ? { reason: error.detail } : {};
  switch (kind) {
    case 'not_configured':
      return aiFail(422, 'ai_not_configured', message, { provider, ...hint });
    case 'auth':
      return aiFail(422, 'ai_auth', message, { provider });
    case 'rate_limited': {
      const wait = error.retryAfterSeconds ?? 30;
      return aiFail(
        429,
        'ai_rate_limited',
        message,
        { provider, retryAfterSeconds: wait, ...hint },
        { 'Retry-After': String(wait) },
      );
    }
    case 'too_large':
      return aiFail(422, 'ai_too_large', message, { provider });
    case 'invalid_output':
      return aiFail(502, 'ai_invalid_output', message, { provider, ...hint });
    case 'unavailable':
      return aiFail(error.detail === 'timeout' ? 504 : 502, 'ai_unavailable', message, {
        provider,
        ...hint,
      });
  }
}

// ---------------------------------------------------------------------------------------------
// The values

export type AiConfigValues = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  monthlyTokenBudget: number;
  maxOutputTokens: number;
  maxInputTokens: number;
  /** Warn (softly) when the month's usage reaches this share of the token budget or of the cost cap. 0: no warning. */
  softWarnPercent: number;
  /** What the provider charges per million tokens, in whole cents (0: free or unknown). Used only for the cost estimate. */
  priceInputCentsPerMTok: number;
  priceOutputCentsPerMTok: number;
  /** The most the estimated cost of a UTC month may reach, in whole cents. 0: no cost cap. Needs a price to mean anything. */
  monthlyCostCapCents: number;
};
export type AiConfigKey = keyof AiConfigValues;

export type AiSettingsContext = {
  /** MRM_AI_ALLOW_PRIVATE_URLS. */
  allowPrivateUrls?: boolean;
  /** DNS lookup for the address check on save (tests replace it). */
  resolve?: Resolver;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (message: string): Parsed<never> => ({ ok: false, message });
const integerIn =
  (min: number, max: number) =>
  (raw: unknown): Parsed<number> =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max
      ? ok(raw)
      : bad(`Use a whole number from ${min} to ${max}.`);

type Definition<T> = {
  doc: string;
  default: T;
  parse(raw: unknown, ctx?: AiSettingsContext): Parsed<T>;
  verify?(value: T, ctx: AiSettingsContext): Promise<string | undefined>;
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export const aiSettingDefinitions: { [K in AiConfigKey]: Definition<AiConfigValues[K]> } = {
  enabled: {
    doc: 'Turns AI assistance on for this workspace. Needs MRM_AI_ENABLED=true on the server as well. While off, nothing is sent to an AI provider.',
    default: false,
    parse: (raw) => (typeof raw === 'boolean' ? ok(raw) : bad('Use true or false.')),
  },
  provider: {
    doc: `The provider: ${aiProviders.join(', ')}. Each uses a credential of its own kind in the vault (an OpenAI compatible server only when it asks for a key).`,
    default: 'anthropic',
    parse: (raw) => (isAiProvider(raw) ? ok(raw) : bad(`Use one of ${aiProviders.join(', ')}.`)),
  },
  model: {
    doc: 'The model name exactly as the provider lists it. There is no default: a name chosen here would go stale. Empty means none.',
    default: '',
    parse: (raw) => {
      if (typeof raw !== 'string') return bad('Use a model name as text.');
      const value = raw.trim();
      if (value === '') return ok('');
      if (value.length > aiLimits.maxModelChars || !MODEL.test(value)) {
        return bad(
          `A model name has at most ${aiLimits.maxModelChars} characters: letters, digits and . _ : / @ + -`,
        );
      }
      return ok(value);
    },
  },
  baseUrl: {
    doc: 'OpenAI compatible server only: its address ending in /v1, such as http://localhost:11434/v1 (Ollama) or https://host/v1. A private or loopback address needs MRM_AI_ALLOW_PRIVATE_URLS=true on the server, and plain http only works to the same machine. Ignored for the other providers.',
    default: '',
    parse: (raw, ctx) => {
      if (typeof raw !== 'string') return bad('Use an address as text.');
      const value = raw.trim();
      if (value === '' || ctx === undefined) return ok(value);
      const check = checkTranslateUrl(value, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
      return check.ok ? ok(check.url) : bad(check.message);
    },
    async verify(value, ctx) {
      if (value === '') return undefined;
      const check = checkWebhookUrl(value, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
      if (!check.ok) return check.message;
      const resolved = await resolveAllowed(check, {
        ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
      });
      return resolved.ok ? undefined : resolved.message;
    },
  },
  monthlyTokenBudget: {
    doc: `The most tokens (input and output together) this workspace may use per UTC month. Default ${aiLimits.defaultMonthlyTokenBudget}. 0 means no limit here: the provider may still have one, and a local model costs nothing.`,
    default: aiLimits.defaultMonthlyTokenBudget,
    parse: integerIn(0, aiLimits.maxMonthlyTokenBudget),
  },
  maxOutputTokens: {
    doc: `The most tokens a model may write for one run (${aiLimits.minMaxOutputTokens} to ${aiLimits.maxMaxOutputTokens}). A task may ask for less.`,
    default: aiLimits.defaultMaxOutputTokens,
    parse: integerIn(aiLimits.minMaxOutputTokens, aiLimits.maxMaxOutputTokens),
  },
  maxInputTokens: {
    doc: `The largest input of one run, in estimated tokens (3 characters each, which over-counts) (${aiLimits.minMaxInputTokens} to ${aiLimits.maxMaxInputTokens}). A bigger input is refused before anything is sent.`,
    default: aiLimits.defaultMaxInputTokens,
    parse: integerIn(aiLimits.minMaxInputTokens, aiLimits.maxMaxInputTokens),
  },
  softWarnPercent: {
    doc: "A warning (never a stop) is shown when this month's usage reaches this percentage of the token budget or of the cost cap. 0 turns the warning off. Default 80.",
    default: 80,
    parse: integerIn(0, 100),
  },
  priceInputCentsPerMTok: {
    doc: 'What the provider charges for a million INPUT tokens, in whole cents (300 is 3.00). Only used for the cost estimate in the usage meter; 0 (default) means free or unknown, which is right for a model you run yourself.',
    default: 0,
    parse: integerIn(0, 1_000_000),
  },
  priceOutputCentsPerMTok: {
    doc: 'What the provider charges for a million OUTPUT tokens, in whole cents. Only used for the cost estimate; 0 (default) means free or unknown.',
    default: 0,
    parse: integerIn(0, 1_000_000),
  },
  monthlyCostCapCents: {
    doc: 'The most the ESTIMATED cost of a UTC month may reach, in whole cents (2000 is 20.00). A run that would pass it is refused before anything is sent. Needs a price above to mean anything. 0 (default) means no cost cap; the token budget still applies.',
    default: 0,
    parse: integerIn(0, 100_000_000),
  },
};

export const aiConfigKeys = Object.keys(aiSettingDefinitions) as AiConfigKey[];
export const isAiConfigKey = (value: string): value is AiConfigKey =>
  Object.hasOwn(aiSettingDefinitions, value);

const STORE_PREFIX = 'ai.';
const def = (key: AiConfigKey): Definition<unknown> =>
  aiSettingDefinitions[key] as unknown as Definition<unknown>;

export const defaultAiConfig = (): AiConfigValues => {
  const out: Record<string, unknown> = {};
  for (const key of aiConfigKeys) out[key] = aiSettingDefinitions[key].default;
  return out as AiConfigValues;
};

export type AiConfig = { values: AiConfigValues; overridden: AiConfigKey[] };

/** Reads the AI configuration. A stored value that no longer validates is ignored (the default applies). */
export async function readAiConfig(sql: Sql, workspaceId: string): Promise<AiConfig> {
  const rows = await sql.query(
    "SELECT key, value_json FROM workspace_settings WHERE workspace_id = ? AND key LIKE 'ai.%'",
    [workspaceId],
  );
  const values = defaultAiConfig() as unknown as Record<string, unknown>;
  const overridden: AiConfigKey[] = [];
  for (const row of rows) {
    const key = String(row.key).slice(STORE_PREFIX.length);
    if (!isAiConfigKey(key)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(String(row.value_json));
    } catch {
      continue;
    }
    const parsed = def(key).parse(raw);
    if (!parsed.ok) continue;
    values[key] = parsed.value;
    overridden.push(key);
  }
  return { values: values as unknown as AiConfigValues, overridden };
}

export type AiConfigChange = { key: AiConfigKey; from: unknown; to: unknown };

export type UpdateAiConfigResult =
  | { ok: true; changes: AiConfigChange[]; config: AiConfig }
  | {
      ok: false;
      status: 400 | 403;
      body: {
        error: string;
        message: string;
        issues?: { path: string; message: string; code?: AddressHint }[];
      };
    };

/**
 * A partial update: each key to a new value, or null to go back to the default. All or nothing. Unknown keys
 * are refused. Audited as `ai.config_update` with the key names and the old and new values (none is a secret).
 */
export async function updateAiConfig(
  db: Database,
  input: { workspaceId: string; role: Role; changes: Record<string, unknown> },
  actor: AiActor,
  now: number,
  ctx: AiSettingsContext = {},
): Promise<UpdateAiConfigResult> {
  const entries = Object.entries(input.changes);
  const unknown = entries.map(([key]) => key).filter((key) => !isAiConfigKey(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'unknown_setting',
        message: `Unknown AI setting: ${unknown.join(', ')}.`,
        issues: unknown.map((path) => ({ path, message: 'Not an AI setting.' })),
      },
    };
  }
  const manage: Action = 'ai.manage';
  if (!can(input.role, manage))
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'Only an admin may change the AI settings.' },
    };
  const issues: { path: string; message: string; code?: AddressHint }[] = [];
  const next = new Map<AiConfigKey, unknown>();
  for (const [rawKey, raw] of entries) {
    const key = rawKey as AiConfigKey;
    if (raw === null) {
      next.set(key, null);
      continue;
    }
    const parsed = def(key).parse(raw, ctx);
    const refusal = parsed.ok ? await def(key).verify?.(parsed.value, ctx) : parsed.message;
    if (!parsed.ok || refusal) {
      // A refused address gets a fixed code and a sentence that says what to do (the policy is not weakened by saying so).
      const hint =
        key === 'baseUrl' && typeof raw === 'string' ? await addressHint(raw, ctx) : undefined;
      issues.push({
        path: key,
        message: hint ? ADDRESS_HINT_MESSAGES[hint] : (refusal ?? ''),
        ...(hint ? { code: hint } : {}),
      });
    } else next.set(key, parsed.value);
  }
  if (issues.length > 0)
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_setting', message: 'An AI setting is not valid.', issues },
    };

  return db.transaction(async (tx): Promise<UpdateAiConfigResult> => {
    const before = await readAiConfig(tx, input.workspaceId);
    const changes: AiConfigChange[] = [];
    for (const [key, value] of next) {
      const has = before.overridden.includes(key);
      const from = before.values[key];
      const storeKey = `${STORE_PREFIX}${key}`;
      if (value === null) {
        if (!has) continue;
        await tx.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [
          input.workspaceId,
          storeKey,
        ]);
        changes.push({ key, from, to: aiSettingDefinitions[key].default });
        continue;
      }
      if (from === value && (has || value === aiSettingDefinitions[key].default)) continue;
      await tx.execute(
        `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [input.workspaceId, storeKey, JSON.stringify(value), now, actor.id],
      );
      changes.push({ key, from, to: value });
    }
    if (changes.length > 0) {
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'ai.config_update',
        target: { type: 'workspace', id: input.workspaceId },
        // Configuration only, never a secret: the old and new values are recorded.
        detail: { keys: changes.map((c) => c.key), changes },
        at: now,
      });
    }
    return { ok: true, changes, config: await readAiConfig(tx, input.workspaceId) };
  });
}

// ---------------------------------------------------------------------------------------------
// The context

/** What every AI service needs. The seams are for tests; index.ts and app.ts fill the real ones. */
export type AiContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_AI_ENABLED. */
  enabled: boolean;
  /** MRM_AI_ALLOW_PRIVATE_URLS. */
  allowPrivateUrls?: boolean;
  /** Replaces the global fetch for Anthropic and OpenAI (tests). */
  fetch?: typeof fetch;
  /** Replace the DNS lookup and the socket of calls to an OpenAI compatible server (tests). */
  resolve?: Resolver;
  exchange?: PostExchange;
  /** Per provider call. Default 60 seconds. */
  timeoutMs?: number;
  /** Replaces building the real client (tests hand in a fake). Called after the credential was read. */
  clientFactory?: (input: CreateAiClientInput) => AiClient;
};

/** The oldest credential of the provider's kind in the workspace: the one AI uses. */
export async function aiCredentialId(
  sql: Sql,
  workspaceId: string,
  provider: AiProvider,
): Promise<string | undefined> {
  const [row] = await sql.query(
    'SELECT id FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY created_at, id LIMIT 1',
    [workspaceId, aiProviderInfo[provider].credentialKind],
  );
  return row ? String(row.id) : undefined;
}

/** What is missing for the provider to be used, or undefined when nothing is. Reads no secret. */
export function configGap(
  config: AiConfigValues,
  credentialPresent: boolean,
): AiNotConfiguredReason | undefined {
  const info = aiProviderInfo[config.provider];
  if (config.model === '') return 'no_model';
  if (info.needsUrl && config.baseUrl === '') return 'no_url';
  if (info.credentialRequired && !credentialPresent) return 'no_credential';
  return undefined;
}

export type AiState = 'ready' | 'off_server' | 'off_workspace' | 'not_configured';

export type Availability = {
  state: AiState;
  reason?: AiNotConfiguredReason;
  config: AiConfig;
  credentialId: string | undefined;
};

/** Whether AI can be used right now in a workspace, and why not. The server switch is checked first, then the workspace's, then the set up. */
export async function aiAvailability(
  ctx: Pick<AiContext, 'db' | 'enabled'>,
  workspaceId: string,
): Promise<Availability> {
  const config = await readAiConfig(ctx.db, workspaceId);
  const credentialId = await aiCredentialId(ctx.db, workspaceId, config.values.provider);
  if (!ctx.enabled) return { state: 'off_server', config, credentialId };
  if (!config.values.enabled) return { state: 'off_workspace', config, credentialId };
  const gap = configGap(config.values, credentialId !== undefined);
  if (gap) return { state: 'not_configured', reason: gap, config, credentialId };
  return { state: 'ready', config, credentialId };
}

/** The failure for a state that is not `ready`. */
export function unavailableFailure(a: Availability): AiFailure {
  if (a.state === 'off_server') return aiNotEnabled('server');
  if (a.state === 'off_workspace') return aiNotEnabled('workspace');
  return aiNotConfigured(a.reason ?? 'no_model', a.config.values.provider);
}

export type BuiltClient = { client: AiClient; guard?: GuardedFetch };

/**
 * Builds the client of the workspace's provider: decrypts the credential for this one call (audited as
 * `credential.use`, purpose `ai`), applies the address rules to an OpenAI compatible server. Never throws:
 * a problem is a failure with a fixed sentence.
 */
export async function buildAiClient(
  ctx: AiContext,
  workspaceId: string,
  availability: Pick<Availability, 'config' | 'credentialId'>,
  actor: AiActor,
): Promise<BuiltClient | AiFailure> {
  const { provider, model, baseUrl } = availability.config.values;
  const info = aiProviderInfo[provider];
  let secret: string | undefined;
  if (availability.credentialId) {
    try {
      secret = await useCredentialSecret(
        ctx.db,
        ctx.masterKey,
        { workspaceId, id: availability.credentialId, purpose: 'ai' },
        actor,
        ctx.now(),
      );
    } catch {
      return aiNotConfigured('credential_unreadable', provider);
    }
    if (secret === undefined && info.credentialRequired)
      return aiNotConfigured('no_credential', provider);
  }
  try {
    const timeout = ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {};
    if (provider === 'openai_compatible') {
      // The address is checked again here: a policy change (or a row written around the API) never hides a bad address.
      const check = checkTranslateUrl(baseUrl, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
      if (!check.ok) {
        const hint = await addressHint(baseUrl, ctx);
        return aiNotConfigured('bad_url', provider, hint ? { hint } : {});
      }
      const guard = createGuardedFetch({
        ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
        ...(ctx.exchange ? { exchange: ctx.exchange } : {}),
        // The guarded fetch has its own time limit; give it the room the client has.
        timeoutMs: ctx.timeoutMs ?? 60_000,
        maxBytes: 4 * 1024 * 1024,
      });
      const input: CreateAiClientInput = {
        provider,
        model,
        secret,
        baseUrl: check.url,
        options: { fetch: guard.fetch, ...timeout },
      };
      return { client: (ctx.clientFactory ?? createAiClient)(input), guard };
    }
    const input: CreateAiClientInput = {
      provider,
      model,
      secret,
      options: { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...timeout },
    };
    return { client: (ctx.clientFactory ?? createAiClient)(input) };
  } catch (error) {
    return failureForAiError(
      error instanceof AiError ? error : new AiError('unavailable'),
      provider,
    );
  }
}

/**
 * The fixed `reason` of a call the guarded fetch refused before sending it: `private_address_blocked` or `plain_http_not_allowed` when
 * that is why, else `address_not_allowed`. Undefined when the guard refused nothing.
 */
export async function guardReason(
  ctx: Pick<AiContext, 'allowPrivateUrls' | 'resolve'>,
  baseUrl: string,
  guard: GuardedFetch | undefined,
): Promise<string | undefined> {
  if (!guard?.blocked()) return undefined;
  return (await addressHint(baseUrl, ctx)) ?? 'address_not_allowed';
}

/** Adds the fixed hint about a refused address to a failure, when the guard refused the request. */
export async function withGuardHint(
  failure: AiFailure,
  guard: GuardedFetch | undefined,
  ctx: Pick<AiContext, 'allowPrivateUrls' | 'resolve'>,
  baseUrl: string,
): Promise<AiFailure> {
  const reason = await guardReason(ctx, baseUrl, guard);
  return reason
    ? { ...failure, body: { ...failure.body, reason, detail: guard?.blocked() } }
    : failure;
}

export const newId = (): string => randomUUID();
