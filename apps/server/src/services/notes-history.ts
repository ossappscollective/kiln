import type { NotesHistoryRead } from '@kiln/connectors';
import type { StoreId } from '@kiln/core';
import { localeKey, NOTES_HISTORY_TTL_MS as TTL, storeOf } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { readNotesHistoryOf, type StoreConnectContext } from '../modules/publish/store-draft.ts';
import type { ManagedApp } from './apps.ts';
import { timedCache } from './timed-cache.ts';

/**
 * The texts earlier releases used for "what is new", to reuse in the next one (docs/api/releases-write.md, "Notes history").
 * Read only. The sources are (1) the store (App Store: the newest versions; Google Play: the releases the tracks hold now, so a
 * short history) read with the credential of the app, kept in memory for NOTES_HISTORY_TTL_MS, and (2) the release notes of this
 * app's release plans. The same text from several places is ONE entry with every place it was used in `uses`, newest first.
 * The texts are the answer and nothing else: they are never written to a log or to the audit trail.
 */

/** `NOTES_HISTORY_TTL_MS` of `@kiln/core`'s timings. */
export const NOTES_HISTORY_TTL_MS = TTL;
export const DEFAULT_NOTES_HISTORY_LIMIT = 30;
export const MAX_NOTES_HISTORY_LIMIT = 100;
/** The most places listed per text. */
export const MAX_USES_PER_NOTE = 10;

export type NoteUse = {
  source: StoreId | 'plan';
  locale: string;
  /** The marketing version, the Google Play release name, or the version of the plan. */
  version: string | null;
  /** Google Play: the track. */
  track: string | null;
  /** Google Play: the version codes of the release (present when the store read gave them). */
  versionCodes?: string[];
  /** The store's state of the version or release; null for a plan. */
  state: string | null;
  /** When the place was created or last changed (epoch ms); null when the store does not say (Google Play). */
  at: number | null;
};

export type HistoryNote = {
  text: string;
  /** The store text was cut at the connector's limit. */
  truncated: boolean;
  /** Every language this text was used in. */
  locales: string[];
  /** The newest `at` of its uses; null when none has a date. */
  lastUsedAt: number | null;
  uses: NoteUse[];
};

export type NotesHistory = {
  app: { id: string; platform: string; store: StoreId };
  locale: string | null;
  notes: HistoryNote[];
  /** More notes exist than `limit`. */
  truncated: boolean;
  limit: number;
  /** What the store read did: `read` false and an `error` code when it failed (the plans are still listed). */
  store: {
    read: boolean;
    error: string | null;
    cached: boolean;
    versionsRead: number;
    failed: number;
    truncated: boolean;
  };
  generatedAt: number;
};

const cache = timedCache<NotesHistoryRead>(NOTES_HISTORY_TTL_MS, 200, {
  name: 'notes.history',
  owner: 'services/notes-history.ts',
  // The store's last notes change with a publish, a sync or a version; "Read again" asks the store afresh.
  invalidatedBy: ['store_read', 'sync', 'publish', 'release_changed'],
  keys: 'workspace_app',
  separator: '\u0000',
});
export const clearNotesHistoryCache = () => cache.clear();

/** Texts are the same when they differ only in line ends and the space around them. */
const keyOf = (text: string) => text.replace(/\r\n?/g, '\n').trim();

export async function notesHistory(
  ctx: StoreConnectContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: { type: 'user' | 'token' | 'system'; id: string };
    locale?: string | undefined;
    limit?: number | undefined;
    /**
     * Google Play: only the release(s) of this track, and when `codes` is given only those that hold one of these version codes
     * ("the notes of the release being promoted"). The notes of the release plans are left out then.
     */
    track?: string | undefined;
    codes?: readonly string[] | undefined;
    /** Called before a store read that the cache could not answer; a refusal (rate limit) is returned as the store error. */
    beforeStoreRead?: () => { error: string } | undefined;
  },
): Promise<NotesHistory> {
  const { app } = input;
  const at = ctx.now();
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? DEFAULT_NOTES_HISTORY_LIMIT), 1),
    MAX_NOTES_HISTORY_LIMIT,
  );
  const store = storeOf(app.platform);
  const wantedLocale =
    input.locale === undefined || input.locale === '' ? undefined : localeKey(input.locale);

  const wantedTrack =
    input.track === undefined || input.track === '' ? undefined : input.track.toLowerCase();
  const wantedCodes = input.codes !== undefined && input.codes.length > 0 ? input.codes : undefined;

  const cacheKey = `${input.workspaceId}\u0000${app.id}\u0000${wantedLocale ?? ''}`;
  let read = cache.get(cacheKey, at);
  let cached = read !== undefined;
  let error: string | null = null;
  if (read === undefined) {
    const refused = input.beforeStoreRead?.();
    if (refused) {
      error = refused.error;
    } else {
      const done = await readNotesHistoryOf(ctx, {
        workspaceId: input.workspaceId,
        app,
        actor: input.actor,
        ...(input.locale ? { locale: input.locale } : {}),
      });
      if (done.ok) {
        read = done.read;
        cache.set(cacheKey, read, at);
      } else {
        error = done.body.error;
      }
    }
  }
  cached = cached && read !== undefined;

  const merged = new Map<string, HistoryNote>();
  const add = (text: string, truncated: boolean, use: NoteUse) => {
    if (text.trim() === '') return;
    const key = keyOf(text);
    const found = merged.get(key);
    if (!found) {
      merged.set(key, {
        text: key === text ? text : text.trim(),
        truncated,
        locales: [use.locale],
        lastUsedAt: use.at,
        uses: [use],
      });
      return;
    }
    if (!found.locales.includes(use.locale)) found.locales.push(use.locale);
    found.truncated = found.truncated || truncated;
    if (use.at !== null && (found.lastUsedAt === null || use.at > found.lastUsedAt))
      found.lastUsedAt = use.at;
    found.uses.push(use);
  };
  for (const e of read?.entries ?? []) {
    // The connector narrows by language already; a store that did not is narrowed here too.
    if (wantedLocale !== undefined && localeKey(e.locale) !== wantedLocale) continue;
    if (wantedTrack !== undefined) {
      if ((e.track ?? '').toLowerCase() !== wantedTrack) continue;
      if (wantedCodes !== undefined && !(e.versionCodes ?? []).some((c) => wantedCodes.includes(c)))
        continue;
    }
    add(e.text, e.truncated, {
      source: e.source,
      locale: e.locale,
      version: e.version,
      track: e.track,
      ...(e.versionCodes ? { versionCodes: [...e.versionCodes] } : {}),
      state: e.state,
      at: e.at,
    });
  }
  const plans =
    wantedTrack !== undefined
      ? []
      : await planNotes(ctx.db, input.workspaceId, app.id, wantedLocale);
  for (const p of plans) {
    add(p.text, false, {
      source: 'plan',
      locale: p.locale,
      version: p.version,
      track: null,
      state: null,
      at: p.at,
    });
  }

  const order = [...merged.values()];
  // Newest first. A text with no date at all (Google Play) follows the dated ones, in the order the store listed it.
  const sorted = order
    .map((n, i) => ({ n, i }))
    .sort(
      (a, b) =>
        (b.n.lastUsedAt ?? Number.NEGATIVE_INFINITY) -
          (a.n.lastUsedAt ?? Number.NEGATIVE_INFINITY) || a.i - b.i,
    )
    .map((x) => x.n);
  for (const n of sorted) {
    n.uses.sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY));
    n.uses = n.uses.slice(0, MAX_USES_PER_NOTE);
  }
  return {
    app: { id: app.id, platform: app.platform, store },
    locale: wantedLocale === undefined ? null : (input.locale as string),
    notes: sorted.slice(0, limit),
    truncated: sorted.length > limit,
    limit,
    store: {
      read: read !== undefined,
      error,
      cached,
      versionsRead: read?.versionsRead ?? 0,
      failed: read?.failed ?? 0,
      truncated: read?.truncated ?? false,
    },
    generatedAt: at,
  };
}

async function planNotes(sql: Sql, workspaceId: string, appId: string, locale: string | undefined) {
  const rows = await sql.query(
    `SELECT n.locale, n.text, n.updated_at, p.version
       FROM release_notes n JOIN release_plans p ON p.id = n.plan_id AND p.workspace_id = n.workspace_id
      WHERE p.workspace_id = ? AND p.app_id = ?
      ORDER BY n.updated_at DESC, n.id LIMIT 500`,
    [workspaceId, appId],
  );
  return rows
    .filter((r) => locale === undefined || localeKey(String(r.locale)) === locale)
    .map((r) => ({
      locale: String(r.locale),
      text: String(r.text),
      version: String(r.version),
      at: Number(r.updated_at),
    }));
}
