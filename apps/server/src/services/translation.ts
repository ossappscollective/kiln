import { createHash, randomUUID } from 'node:crypto';
import {
  createTranslator,
  probeTranslator,
  TranslateError,
  type TranslateErrorKind,
  type Translator,
  translateErrorMessage,
} from '@kiln/connectors';
import {
  type ActorType,
  normalizeLanguageTag,
  sameLanguage,
  type TranslationProvider,
  translationLimits,
  translationProviderInfo,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { recordAudit } from './audit.ts';
import { useCredentialSecret } from './credentials.ts';
import { createGuardedFetch, type GuardedFetch, type PostExchange } from './translate-net.ts';
import { getUsage, refundChars, reserveChars } from './translation-usage.ts';
import type { Resolver } from './webhook-transport.ts';
import { getSettings } from './workspace-settings.ts';

/**
 * Translation of review text (and, for other features, any text) through the workspace's provider.
 *
 * `translateText` is the one stable entry point; the review functions below build on it.
 *
 * Privacy rules, all enforced here:
 * - Review and reply text is NEVER logged and NEVER put in an audit entry or an error. Provider error
 *   bodies are never passed on: failures carry a fixed sentence per code.
 * - The client never sends the text for a review: the server reads it from its own database, so the
 *   route cannot be used as a free translation proxy.
 * - Secrets stay in the vault: the credential is decrypted for the length of one call.
 *
 * Failures are values (`TranslationFailure`), never thrown, with a stable code and a status:
 * translation_not_configured (422), translation_auth (422), translation_quota (422),
 * translation_rate_limited (429 + Retry-After), translation_budget (429), translation_unsupported_language
 * (422; 400 for a malformed tag), translation_too_large (400 for our limits, 422 from the provider),
 * translation_unavailable (502; 504 for a timeout).
 */

export type TranslationContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_TRANSLATE_ALLOW_PRIVATE_URLS. */
  allowPrivateUrls?: boolean;
  /** Replaces the global fetch for Google, DeepL and Azure (tests). */
  fetch?: typeof fetch;
  /** Replaces the DNS lookup and the socket of LibreTranslate calls (tests). */
  resolve?: Resolver;
  exchange?: PostExchange;
  /** Per provider call. Default 15 seconds. */
  timeoutMs?: number;
};

export type TranslationActor = { type: ActorType; id: string };
const SYSTEM_ACTOR: TranslationActor = { type: 'system', id: 'translation' };

export type CacheKey = { appId: string; reviewId: string; field: 'title' | 'body' };

export type TranslateTextInput = {
  /** Up to 20 texts of up to 5000 characters, 20000 in all. Empty texts are returned as they are. */
  texts: string[];
  /** BCP-47. Default: the workspace's target language. */
  target?: string;
  /** BCP-47 of the text, or leave out for the provider to detect it. */
  source?: string;
  /** Per text, where to keep the translation (reviews). Same length as `texts` when given. */
  cache?: (CacheKey | undefined)[];
  actor?: TranslationActor;
};

export type TranslatedItem = { text: string; detectedSource?: string };

export type TranslateTextSuccess = {
  ok: true;
  provider: TranslationProvider;
  target: string;
  results: TranslatedItem[];
  /** True when nothing was sent to the provider and at least one result came from the cache. */
  cached: boolean;
  /** Characters sent to the provider by this call. */
  chars: number;
};

export type TranslationFailure = {
  ok: false;
  status: 400 | 422 | 429 | 502 | 504;
  body: Record<string, unknown> & { error: string; message: string };
  headers?: Record<string, string>;
};

const fail = (
  status: TranslationFailure['status'],
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
): TranslationFailure => ({
  ok: false,
  status,
  body: { error, message, ...extra },
  ...(headers ? { headers } : {}),
});

const NOT_CONFIGURED = {
  disabled: 'Translation is turned off for this workspace. An admin can turn it on in Settings.',
  no_credential:
    'No credential for the translation provider has been added yet. An admin can add one under Credentials.',
  no_url: 'The LibreTranslate address has not been set. An admin can set it in Settings.',
  credential_unreadable:
    'The translation credential could not be decrypted. An admin must enter its key again.',
  bad_url:
    'The LibreTranslate address is not allowed by this server. An admin can change it in Settings.',
} as const;
type NotConfiguredReason = keyof typeof NOT_CONFIGURED;

const notConfigured = (reason: NotConfiguredReason, provider?: TranslationProvider) =>
  fail(422, 'translation_not_configured', NOT_CONFIGURED[reason], {
    reason,
    ...(provider ? { provider } : {}),
  });

/** The failure for a provider error. Fixed sentences only. */
export function failureForKind(
  kind: TranslateErrorKind,
  provider: TranslationProvider,
  retryAfterSeconds?: number,
): TranslationFailure {
  const message = translateErrorMessage(kind);
  switch (kind) {
    case 'not_configured':
      return fail(422, 'translation_not_configured', message, { provider });
    case 'auth':
      return fail(422, 'translation_auth', message, { provider });
    case 'quota':
      return fail(422, 'translation_quota', message, { provider });
    case 'rate_limited': {
      const wait = retryAfterSeconds ?? 30;
      return fail(
        429,
        'translation_rate_limited',
        message,
        { provider, retryAfterSeconds: wait },
        { 'Retry-After': String(wait) },
      );
    }
    case 'unsupported_language':
      return fail(422, 'translation_unsupported_language', message, { provider });
    case 'too_large':
      return fail(422, 'translation_too_large', message, { provider });
    case 'timeout':
      return fail(504, 'translation_unavailable', message, { provider, reason: 'timeout' });
    case 'unavailable':
      return fail(502, 'translation_unavailable', message, { provider });
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------
// The provider of a workspace

type Resolved = {
  provider: TranslationProvider;
  target: string;
  budget: number;
  build: () => Promise<{ translator: Translator; guard?: GuardedFetch } | TranslationFailure>;
};

/** The oldest credential of a kind in the workspace: the one translation uses. */
export async function translationCredentialId(
  sql: Sql,
  workspaceId: string,
  provider: TranslationProvider,
): Promise<string | undefined> {
  const [row] = await sql.query(
    'SELECT id FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY created_at, id LIMIT 1',
    [workspaceId, translationProviderInfo[provider].credentialKind],
  );
  return row ? String(row.id) : undefined;
}

async function resolveProvider(
  ctx: TranslationContext,
  workspaceId: string,
  options: { target?: string | undefined; requireEnabled?: boolean; actor: TranslationActor },
): Promise<Resolved | TranslationFailure> {
  const settings = (await getSettings(ctx.db, workspaceId)).values;
  const provider = settings['translation.provider'] as TranslationProvider;
  if (
    options.requireEnabled !== false &&
    (settings['translation.enabled'] !== true || settings['translation.mode'] === 'off')
  ) {
    return notConfigured('disabled', provider);
  }
  const target = normalizeLanguageTag(
    options.target ?? String(settings['translation.targetLanguage']),
  );
  if (!target)
    return fail(
      400,
      'translation_unsupported_language',
      'The target language is not a language tag.',
    );
  const info = translationProviderInfo[provider];
  const url = String(settings['translation.libretranslate.url']);
  if (info.needsUrl && url === '') return notConfigured('no_url', provider);
  const credentialId = await translationCredentialId(ctx.db, workspaceId, provider);
  if (info.credentialRequired && !credentialId) return notConfigured('no_credential', provider);

  return {
    provider,
    target,
    budget: Number(settings['translation.dailyCharBudget']),
    build: async () => {
      let secret: string | undefined;
      if (credentialId) {
        try {
          secret = await useCredentialSecret(
            ctx.db,
            ctx.masterKey,
            { workspaceId, id: credentialId, purpose: 'translation' },
            options.actor,
            ctx.now(),
          );
        } catch {
          return notConfigured('credential_unreadable', provider);
        }
        if (secret === undefined && info.credentialRequired)
          return notConfigured('no_credential', provider);
      }
      try {
        if (provider === 'libretranslate') {
          const guard = createGuardedFetch({
            ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
            ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
            ...(ctx.exchange ? { exchange: ctx.exchange } : {}),
            ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
          });
          return {
            translator: createTranslator({
              provider,
              secret,
              baseUrl: url,
              options: {
                fetch: guard.fetch,
                ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
              },
            }),
            guard,
          };
        }
        return {
          translator: createTranslator({
            provider,
            secret,
            options: {
              ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
              ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
            },
          }),
        };
      } catch (error) {
        return failureForKind(
          error instanceof TranslateError ? error.kind : 'unavailable',
          provider,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// translateText

/**
 * Translates texts with the workspace's provider and credential. See the module comment for the
 * failure codes. Stable signature: other features (reply drafts) call it too.
 */
export async function translateText(
  ctx: TranslationContext,
  workspaceId: string,
  input: TranslateTextInput,
): Promise<TranslateTextSuccess | TranslationFailure> {
  const { texts } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;
  const limits = translationLimits;
  if (texts.length > limits.maxTexts) {
    return fail(400, 'translation_too_large', `At most ${limits.maxTexts} texts per call.`);
  }
  let total = 0;
  for (const text of texts) {
    if (typeof text !== 'string')
      return fail(400, 'invalid_request', 'Each text must be a string.');
    if (text.length > limits.maxTextChars) {
      return fail(
        400,
        'translation_too_large',
        `A text may have at most ${limits.maxTextChars} characters.`,
      );
    }
    total += text.length;
  }
  if (total > limits.maxRequestChars) {
    return fail(
      400,
      'translation_too_large',
      `At most ${limits.maxRequestChars} characters per call.`,
    );
  }
  if (input.cache && input.cache.length !== texts.length)
    return fail(400, 'invalid_request', 'The cache keys do not match the texts.');
  let source: string | undefined;
  if (input.source !== undefined && input.source !== '' && input.source.toLowerCase() !== 'auto') {
    source = normalizeLanguageTag(input.source);
    if (!source)
      return fail(
        400,
        'translation_unsupported_language',
        'The source language is not a language tag.',
      );
  }

  const resolved = await resolveProvider(ctx, workspaceId, { target: input.target, actor });
  if ('ok' in resolved) return resolved;
  const { provider, target } = resolved;

  const results: (TranslatedItem | undefined)[] = texts.map(() => undefined);
  const misses: number[] = [];
  let hits = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i] as string;
    if (text.trim() === '') {
      results[i] = { text };
    } else if (source !== undefined && sameLanguage(source, target)) {
      results[i] = { text, detectedSource: source };
    } else {
      const key = input.cache?.[i];
      const hit = key
        ? await readCache(ctx.db, workspaceId, key, target, provider, sha256(text))
        : undefined;
      if (hit) {
        results[i] = hit;
        hits += 1;
      } else {
        misses.push(i);
      }
    }
  }
  if (misses.length === 0) {
    return {
      ok: true,
      provider,
      target,
      results: results as TranslatedItem[],
      cached: hits > 0,
      chars: 0,
    };
  }

  const chars = misses.reduce((sum, i) => sum + (texts[i] as string).length, 0);
  const at = ctx.now();
  const reservation = await reserveChars(ctx.db, {
    workspaceId,
    at,
    chars,
    budget: resolved.budget,
  });
  if (!reservation.ok) {
    return fail(
      429,
      'translation_budget',
      'The daily translation budget of this workspace is used up. It resets at 00:00 UTC.',
      {
        budget: reservation.budget,
        used: reservation.used,
        provider,
      },
    );
  }
  const refund = () => refundChars(ctx.db, { workspaceId, at, chars }).catch(() => undefined);

  const built = await resolved.build();
  if ('ok' in built) {
    await refund();
    return built;
  }
  let translated: TranslatedItem[];
  try {
    const out = await built.translator.translate({
      texts: misses.map((i) => texts[i] as string),
      target,
      ...(source !== undefined ? { source } : {}),
    });
    translated = out.results;
    if (translated.length !== misses.length)
      throw new TranslateError('unavailable', { detail: 'count_mismatch' });
  } catch (error) {
    await refund();
    const kind: TranslateErrorKind = error instanceof TranslateError ? error.kind : 'unavailable';
    const blocked = built.guard?.blocked();
    const out = failureForKind(
      kind,
      provider,
      error instanceof TranslateError ? error.retryAfterSeconds : undefined,
    );
    // A refused address says so (a fixed sentence about the rule, never the address).
    if (blocked)
      return { ...out, body: { ...out.body, reason: 'address_not_allowed', detail: blocked } };
    // A fixed hint such as http_404 or connection, so a broken setup can be told apart (never provider text).
    const hint = error instanceof TranslateError ? error.detail : undefined;
    return hint ? { ...out, body: { ...out.body, reason: hint } } : out;
  }

  misses.forEach((index, n) => {
    results[index] = translated[n] as TranslatedItem;
  });
  if (input.cache) {
    const toStore = misses.filter((i) => input.cache?.[i]);
    if (toStore.length > 0) {
      await db_store(
        ctx,
        workspaceId,
        toStore.map((i) => ({
          key: input.cache?.[i] as CacheKey,
          text: texts[i] as string,
          item: results[i] as TranslatedItem,
        })),
        target,
        provider,
      ).catch(() => undefined);
    }
  }
  return { ok: true, provider, target, results: results as TranslatedItem[], cached: false, chars };
}

// ---------------------------------------------------------------------------------------------
// The cache

async function readCache(
  sql: Sql,
  workspaceId: string,
  key: CacheKey,
  target: string,
  provider: TranslationProvider,
  hash: string,
): Promise<TranslatedItem | undefined> {
  const [row] = await sql.query(
    `SELECT translated_text, detected_source FROM review_translations
      WHERE workspace_id = ? AND review_id = ? AND field = ? AND target_lang = ? AND provider = ? AND source_hash = ?`,
    [workspaceId, key.reviewId, key.field, target, provider, hash],
  );
  if (!row) return undefined;
  return {
    text: String(row.translated_text),
    ...(row.detected_source ? { detectedSource: String(row.detected_source) } : {}),
  };
}

async function db_store(
  ctx: TranslationContext,
  workspaceId: string,
  items: { key: CacheKey; text: string; item: TranslatedItem }[],
  target: string,
  provider: TranslationProvider,
): Promise<void> {
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    for (const { key, text, item } of items) {
      const hash = sha256(text);
      // The text changed: the old translation of this field is no longer wanted.
      await tx.execute(
        'DELETE FROM review_translations WHERE workspace_id = ? AND review_id = ? AND field = ? AND target_lang = ? AND provider = ? AND source_hash <> ?',
        [workspaceId, key.reviewId, key.field, target, provider, hash],
      );
      await tx.execute(
        `INSERT INTO review_translations
           (id, workspace_id, app_id, review_id, field, target_lang, provider, source_hash, translated_text, detected_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (review_id, field, target_lang, provider, source_hash) DO NOTHING`,
        [
          randomUUID(),
          workspaceId,
          key.appId,
          key.reviewId,
          key.field,
          target,
          provider,
          hash,
          item.text,
          item.detectedSource ?? null,
          at,
        ],
      );
    }
  });
}

/** Removes every stored translation of an app (called when the app is deleted). */
export async function deleteTranslationData(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<void> {
  await sql.execute('DELETE FROM review_translations WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
}

/** Translations whose review no longer exists (pruned by retention, or its app deleted). Bounded. */
export async function purgeOrphanTranslations(sql: Sql, limit = 1000): Promise<number> {
  return sql.execute(
    `DELETE FROM review_translations WHERE id IN (
       SELECT t.id FROM review_translations t
        WHERE NOT EXISTS (SELECT 1 FROM app_reviews r WHERE r.id = t.review_id) LIMIT ?)`,
    [limit],
  );
}

// ---------------------------------------------------------------------------------------------
// Reviews

export type ReviewTranslation = {
  reviewId: string;
  title?: string;
  body?: string;
  detectedSource?: string;
  provider: TranslationProvider;
  cached: boolean;
  /** The review's stored language is the target: nothing was translated. */
  sameLanguage?: boolean;
  /** The text was longer than 5000 characters and was cut before translating. */
  truncated?: boolean;
};

type ReviewRow = { id: string; title: string | null; body: string; language: string | null };

export type TranslateReviewsSuccess = {
  ok: true;
  provider: TranslationProvider;
  target: string;
  translations: ReviewTranslation[];
  notFound: string[];
  stats: { reviews: number; fromCache: number; chars: number };
};

async function loadReviews(
  sql: Sql,
  workspaceId: string,
  appId: string,
  ids: string[],
): Promise<ReviewRow[]> {
  const rows = await sql.query(
    `SELECT id, title, body, language FROM app_reviews
      WHERE workspace_id = ? AND app_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    [workspaceId, appId, ...ids],
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title === null ? null : String(r.title),
    body: String(r.body),
    language: r.language === null ? null : String(r.language),
  }));
}

type Piece = { reviewId: string; field: 'title' | 'body'; text: string };

/**
 * Translates stored reviews, reusing translations of text that has not changed. The text is read
 * from the database here; the caller only names the reviews. Reviews whose stored language is the
 * target are not sent. A failure part way keeps what was translated (it is cached) and returns the failure.
 */
export async function translateReviews(
  ctx: TranslationContext,
  workspaceId: string,
  appId: string,
  reviewIds: string[],
  options: { target?: string; actor?: TranslationActor; skipSameLanguage?: boolean } = {},
): Promise<TranslateReviewsSuccess | TranslationFailure> {
  const ids = [...new Set(reviewIds)];
  if (ids.length === 0 || ids.length > translationLimits.maxReviewIds) {
    return fail(400, 'invalid_request', `Send 1 to ${translationLimits.maxReviewIds} review ids.`);
  }
  const rows = await loadReviews(ctx.db, workspaceId, appId, ids);
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));

  // Resolve once up front, so the answer names the provider and target even if every review is skipped.
  const probe = await resolveProvider(ctx, workspaceId, {
    target: options.target,
    actor: options.actor ?? SYSTEM_ACTOR,
  });
  if ('ok' in probe) return probe;
  const { provider, target } = probe;

  const out = new Map<string, ReviewTranslation>();
  const pieces: Piece[] = [];
  for (const row of rows) {
    if (row.language && sameLanguage(row.language, target)) {
      out.set(row.id, { reviewId: row.id, provider, cached: false, sameLanguage: true });
      continue;
    }
    const entry: ReviewTranslation = { reviewId: row.id, provider, cached: true };
    out.set(row.id, entry);
    for (const field of ['title', 'body'] as const) {
      const raw = field === 'title' ? row.title : row.body;
      if (!raw || raw.trim() === '') continue;
      let text = raw;
      if (text.length > translationLimits.maxTextChars) {
        text = text.slice(0, translationLimits.maxTextChars);
        entry.truncated = true;
      }
      pieces.push({ reviewId: row.id, field, text });
    }
  }

  // Chunks of at most 20 texts and 20000 characters.
  const chunks: Piece[][] = [];
  let current: Piece[] = [];
  let size = 0;
  for (const piece of pieces) {
    if (
      current.length >= translationLimits.maxTexts ||
      size + piece.text.length > translationLimits.maxRequestChars
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += piece.text.length;
  }
  if (current.length > 0) chunks.push(current);

  let chars = 0;
  let fromCache = 0;
  for (const chunk of chunks) {
    const res = await translateText(ctx, workspaceId, {
      texts: chunk.map((p) => p.text),
      target,
      cache: chunk.map((p) => ({ appId, reviewId: p.reviewId, field: p.field })),
      ...(options.actor ? { actor: options.actor } : {}),
    });
    if (!res.ok) return res;
    chars += res.chars;
    chunk.forEach((piece, n) => {
      const entry = out.get(piece.reviewId) as ReviewTranslation;
      const item = res.results[n] as TranslatedItem;
      entry[piece.field] = item.text;
      if (item.detectedSource && piece.field === 'body') entry.detectedSource = item.detectedSource;
      else if (item.detectedSource && !entry.detectedSource)
        entry.detectedSource = item.detectedSource;
      if (res.chars > 0) entry.cached = false;
    });
  }
  for (const entry of out.values())
    if (entry.cached && !entry.title && !entry.body) entry.cached = false;
  fromCache = [...out.values()].filter((e) => e.cached).length;
  return {
    ok: true,
    provider,
    target,
    // In the order asked, whatever order the database answered in.
    translations: ids.filter((id) => found.has(id)).map((id) => out.get(id) as ReviewTranslation),
    notFound,
    stats: { reviews: rows.length, fromCache, chars },
  };
}

/** The audit entry of a review translation request: counts and the provider, never text. */
export async function auditReviewTranslation(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    actor: TranslationActor;
    at: number;
    trigger: 'request' | 'auto';
    ok: boolean;
    provider?: string;
    target?: string;
    reviews?: number;
    fromCache?: number;
    chars?: number;
    code?: string;
  },
): Promise<void> {
  await recordAudit(sql, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'review.translate',
    target: { type: 'app', id: input.appId },
    detail: {
      ok: input.ok,
      trigger: input.trigger,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.reviews !== undefined ? { reviews: input.reviews } : {}),
      ...(input.fromCache !== undefined ? { fromCache: input.fromCache } : {}),
      ...(input.chars !== undefined ? { chars: input.chars } : {}),
      ...(input.code ? { code: input.code } : {}),
    },
    at: input.at,
  });
}

// ---------------------------------------------------------------------------------------------
// Auto mode

export type AutoTranslateSummary = {
  mode: 'auto';
  /** Reviews considered (new, in another language), at most 20. */
  attempted: number;
  translated: number;
  fromCache: number;
  chars: number;
  /** The failure code when it stopped, else absent. A failure never fails the sync. */
  error?: string;
};

/**
 * After a review sync: translates the NEW reviews whose language differs from the target (an unknown
 * language counts as different), the newest 20 at most, within the daily budget. Never throws; a
 * failure is returned in the summary and audited as `review.translate` with `trigger: auto`.
 * Returns undefined when the mode is not `auto` (or translation is off): nothing is attempted.
 */
export async function autoTranslateNewReviews(
  ctx: TranslationContext,
  workspaceId: string,
  appId: string,
  newReviewIds: string[],
): Promise<AutoTranslateSummary | undefined> {
  try {
    if (newReviewIds.length === 0) return undefined;
    const settings = (await getSettings(ctx.db, workspaceId)).values;
    if (settings['translation.enabled'] !== true || settings['translation.mode'] !== 'auto')
      return undefined;
    const cap = translationLimits.maxAutoPerSync;
    const rows = (await loadReviewsByRecency(ctx.db, workspaceId, appId, newReviewIds))
      .filter(
        (r) =>
          !r.language || !sameLanguage(r.language, String(settings['translation.targetLanguage'])),
      )
      .slice(0, cap);
    const summary: AutoTranslateSummary = {
      mode: 'auto',
      attempted: rows.length,
      translated: 0,
      fromCache: 0,
      chars: 0,
    };
    if (rows.length === 0) return summary;
    const actor: TranslationActor = { type: 'system', id: 'review.sync' };
    const res = await translateReviews(
      ctx,
      workspaceId,
      appId,
      rows.map((r) => r.id),
      { actor },
    );
    const at = ctx.now();
    if (!res.ok) {
      summary.error = String(res.body.error);
      await auditReviewTranslation(ctx.db, {
        workspaceId,
        appId,
        actor,
        at,
        trigger: 'auto',
        ok: false,
        code: summary.error,
      }).catch(() => undefined);
      return summary;
    }
    summary.translated = res.translations.filter(
      (t) => t.title !== undefined || t.body !== undefined,
    ).length;
    summary.fromCache = res.stats.fromCache;
    summary.chars = res.stats.chars;
    await auditReviewTranslation(ctx.db, {
      workspaceId,
      appId,
      actor,
      at,
      trigger: 'auto',
      ok: true,
      provider: res.provider,
      target: res.target,
      reviews: res.stats.reviews,
      fromCache: res.stats.fromCache,
      chars: res.stats.chars,
    }).catch(() => undefined);
    return summary;
  } catch {
    return {
      mode: 'auto',
      attempted: 0,
      translated: 0,
      fromCache: 0,
      chars: 0,
      error: 'translation_unavailable',
    };
  }
}

async function loadReviewsByRecency(
  sql: Sql,
  workspaceId: string,
  appId: string,
  ids: string[],
): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    rows.push(...(await loadReviews(sql, workspaceId, appId, ids.slice(i, i + 200))));
  }
  // Newest first: the order of `ids` says nothing, so read the creation times.
  const order = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const dates = await sql.query(
      `SELECT id, created_at FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      [workspaceId, appId, ...chunk],
    );
    for (const d of dates) order.set(String(d.id), Number(d.created_at));
  }
  return rows.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
}

// ---------------------------------------------------------------------------------------------
// Tests of the configured provider

export type TranslationTestOutcome = {
  ok: boolean;
  message: string;
  provider?: TranslationProvider;
  reason?: string;
};

/** Translates one fixed word with the workspace's provider. Says ok or a fixed sentence; counts nothing against the budget. */
export async function testTranslation(
  ctx: TranslationContext,
  workspaceId: string,
  actor: TranslationActor,
): Promise<TranslationTestOutcome> {
  const resolved = await resolveProvider(ctx, workspaceId, { requireEnabled: false, actor });
  if ('ok' in resolved)
    return {
      ok: false,
      message: resolved.body.message,
      ...(typeof resolved.body.reason === 'string' ? { reason: resolved.body.reason } : {}),
    };
  const built = await resolved.build();
  const outcome =
    'ok' in built
      ? { ok: false as const, message: built.body.message }
      : await probe(built.translator, built.guard);
  await recordAudit(ctx.db, {
    workspaceId,
    actor,
    action: 'translation.test',
    detail: { provider: resolved.provider, ok: outcome.ok },
    at: ctx.now(),
  });
  return { ...outcome, provider: resolved.provider };
}

async function probe(
  translator: Translator,
  guard?: GuardedFetch,
): Promise<{ ok: boolean; message: string; reason?: string }> {
  const result = await probeTranslator(translator);
  if (result.ok) return { ok: true, message: 'The provider translated a test word.' };
  const blocked = guard?.blocked();
  return {
    ok: false,
    message: result.message,
    ...(blocked ? { reason: 'address_not_allowed', detail: blocked } : {}),
  } as { ok: boolean; message: string; reason?: string };
}

/**
 * The "test connection" of a LibreTranslate credential (or no credential: an empty secret): the key
 * is tried against the address saved in the workspace settings. Reports ok or a fixed sentence.
 */
export async function testLibreTranslateSecret(
  ctx: TranslationContext,
  workspaceId: string,
  secret: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const settings = (await getSettings(ctx.db, workspaceId)).values;
  const url = String(settings['translation.libretranslate.url']);
  if (url === '') {
    return {
      ok: false,
      message:
        'Set the LibreTranslate address under Settings, Translation first. The key is tested against that address.',
    };
  }
  const guard = createGuardedFetch({
    ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
    ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
    ...(ctx.exchange ? { exchange: ctx.exchange } : {}),
    timeoutMs: 8000,
  });
  let translator: Translator;
  try {
    translator = createTranslator({
      provider: 'libretranslate',
      secret,
      baseUrl: url,
      options: { fetch: guard.fetch, timeoutMs: 8000 },
    });
  } catch {
    return { ok: false, message: translateErrorMessage('not_configured') };
  }
  const result = await probe(translator, guard);
  return {
    ok: result.ok,
    message: result.ok
      ? 'The key works with the saved address: a test word was translated.'
      : result.message,
  };
}

/** Today's usage and the budget, for the Settings screen. */
export async function translationUsageToday(
  sql: Sql,
  workspaceId: string,
  now: number,
): Promise<{ used: number; budget: number; day: string }> {
  const settings = (await getSettings(sql, workspaceId)).values;
  return {
    used: await getUsage(sql, workspaceId, now),
    budget: Number(settings['translation.dailyCharBudget']),
    day: new Date(now).toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------------------------
// Seam for the reply drafts

/**
 * `translateDraft` of the review reply routes (services/review-replies.ts): translates one draft
 * into the review's language with the workspace's provider. Same limits, budget and failure codes as
 * `translateText`; the text is never logged or audited.
 */
export function createTranslateDraft(ctx: TranslationContext) {
  return async (input: {
    workspaceId: string;
    text: string;
    target: string;
    source?: string | undefined;
  }): Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }> => {
    const res = await translateText(ctx, input.workspaceId, {
      texts: [input.text],
      target: input.target,
      ...(input.source ? { source: input.source } : {}),
    });
    if (!res.ok) return { ok: false, code: String(res.body.error), message: res.body.message };
    return { ok: true, text: (res.results[0] as TranslatedItem).text };
  };
}
