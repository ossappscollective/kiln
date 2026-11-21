import { createHash } from 'node:crypto';
import { type AssetKind, readImageHeader } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { AssetIndexView } from '../modules/listing/asset-index.ts';
import { openAssets } from '../modules/listing/asset-repo.ts';
import {
  getAppIcon,
  type IconMediaType,
  type IconRow,
  type IconSource,
  putAppIcon,
} from './app-icon-store.ts';
import type { ManagedApp } from './apps.ts';
import { createTestLimiter, type TestLimiter } from './credential-tests.ts';
import type { RepoContext } from './repositories.ts';
import { type Exchange, type SafeGetResult, safeGet } from './safe-fetch.ts';
import type { Resolver } from './webhook-transport.ts';

/**
 * The icon of an app, resolved on the server, kept in the database and served from there
 * (`GET .../apps/:id/icon`).
 *
 * Sources, in this order (the first one that has an image wins):
 *  1. the repository: a store icon of the listing target (`metadata/android/<locale>/images/icon.png`),
 *     then the icon of the project (an Expo `icon`, an Xcode `AppIcon*.appiconset`, an Android
 *     `ic_launcher`), from the asset index (asset-index.ts, local clone first);
 *  2. iOS only: the public iTunes Lookup API (`https://itunes.apple.com/lookup?id=<trackId>`), then the
 *     artwork URL it answers with (an `mzstatic.com` host). Fetched by safe-fetch.ts: https only,
 *     host allowlist on every redirect, addresses checked, 1 MB / 256 KB caps, timeout, content
 *     sniffing, and a rate limit per workspace and one for the whole server.
 *  3. Google Play: the connectors expose no icon (and the Play Console API has none for an
 *     existing listing), so the icon of an Android app comes from the repository. Nothing is
 *     scraped from play.google.com.
 *
 * What is kept: the image (at most 256 KB; png, jpeg or webp by its bytes, never by its name or
 * the header of the server), the source and its id, the time and an ETag.
 *
 * When it is looked at again:
 *  - a repository icon: when the repository is read again at least `REPO_RECHECK_MS` after the last
 *    look and the git blob of the icon file is not the same one (the commit changed the icon);
 *  - a remote icon: after `REMOTE_REFRESH_MS` (7 days); the repository is looked at daily meanwhile,
 *    in case an icon was added there;
 *  - nothing found: again after `EMPTY_BACKOFF_MS`;
 *  - a failure: after a back-off that doubles with every failure in a row (`failureBackoffMs`).
 *    A failed look never removes the icon that is already held.
 */

export const ICON_MAX_BYTES = 256 * 1024;
export const LOOKUP_MAX_BYTES = 1024 * 1024;
export const MIN_ICON_SIDE = 64;
export const REPO_RECHECK_MS = 30 * 60 * 1000;
export const REMOTE_RECHECK_REPO_MS = 24 * 60 * 60 * 1000;
export const REMOTE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const EMPTY_BACKOFF_MS = 60 * 60 * 1000;
/** The first request for an icon waits at most this long for the look; it goes on in the background. */
export const FIRST_LOOK_WAIT_MS = 8000;

export const ITUNES_HOST = 'itunes.apple.com';
const MZSTATIC = /^(?:[a-z0-9-]+\.)+mzstatic\.com$/;
const TRACK_ID = /^[0-9]{1,15}$/;

export const failureBackoffMs = (failures: number): number =>
  Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.max(0, Math.min(failures, 10) - 1));

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type IconsContext = {
  db: Database;
  now: () => number;
  /** For the repository reads (asset-repo.ts). */
  repo: RepoContext;
  /** Looks at the App Store per workspace. Default: 6 a minute. */
  limiter?: TestLimiter;
  /** Seams of the outbound GET, for tests and for KILN_WEBHOOKS_ALLOW_PRIVATE-style development. */
  net?: { resolve?: Resolver; exchange?: Exchange; allowPrivate?: boolean; timeoutMs?: number };
};

// ---------------------------------------------------------------------------------------------
// Choosing and checking images

const ALLOWED: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp']);
const MEDIA: Record<string, IconMediaType> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const KIND_RANK: Partial<Record<AssetKind, number>> = { icon: 0, app_icon: 1 };

/** The best icon file of an asset index, or undefined. Pure. */
export function pickRepositoryIcon(
  view: Pick<AssetIndexView, 'assets'>,
): { path: string; oid: string } | undefined {
  const candidates = view.assets.filter(
    (a) =>
      (a.kind === 'icon' || a.kind === 'app_icon') &&
      a.read === 'read' &&
      a.oid !== null &&
      a.width !== null &&
      a.width === a.height &&
      a.width >= MIN_ICON_SIDE &&
      a.format !== null &&
      ALLOWED.has(a.format) &&
      a.bytes !== null &&
      a.bytes <= ICON_MAX_BYTES,
  );
  candidates.sort(
    (a, b) =>
      (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
      Number(b.locale === 'en-US') - Number(a.locale === 'en-US') ||
      (b.width ?? 0) - (a.width ?? 0) ||
      a.path.localeCompare(b.path),
  );
  const best = candidates[0];
  return best?.oid ? { path: best.path, oid: best.oid } : undefined;
}

export type CheckedImage = { mediaType: IconMediaType; width: number; height: number };

/** Whether bytes are an icon we keep: png, jpeg or webp by their content, square, big enough, small enough. */
export function checkIconBytes(
  bytes: Uint8Array,
): { ok: true; image: CheckedImage } | { ok: false; message: string } {
  if (bytes.length === 0) return { ok: false, message: 'The image is empty.' };
  if (bytes.length > ICON_MAX_BYTES)
    return { ok: false, message: 'The image is larger than 256 KB.' };
  const header = readImageHeader(bytes);
  if (!header.ok) return { ok: false, message: 'The file is not a readable image.' };
  if (!ALLOWED.has(header.format))
    return {
      ok: false,
      message: `A ${header.format} image is not used as an icon (png, jpeg or webp only).`,
    };
  if (header.width !== header.height) return { ok: false, message: 'The image is not square.' };
  if (header.width < MIN_ICON_SIDE)
    return { ok: false, message: `The image is smaller than ${MIN_ICON_SIDE} pixels.` };
  return {
    ok: true,
    image: {
      mediaType: MEDIA[header.format] as IconMediaType,
      width: header.width,
      height: header.height,
    },
  };
}

const etagOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32);

// ---------------------------------------------------------------------------------------------
// When to look

/** What a row says about looking again. Pure. */
export function lookDue(row: IconRow | undefined, now: number): boolean {
  if (!row) return true;
  if (row.backoffUntil !== null && row.backoffUntil > now) return false;
  if (!row.data) return true;
  if (row.source === 'repository') return now - row.checkedAt >= REPO_RECHECK_MS;
  return (
    now - row.checkedAt >= REMOTE_RECHECK_REPO_MS ||
    (row.fetchedAt !== null && now - row.fetchedAt >= REMOTE_REFRESH_MS)
  );
}

// ---------------------------------------------------------------------------------------------
// The service

type Found = { source: IconSource; sourceId: string; bytes: Uint8Array; image: CheckedImage };
type Step = { found?: Found; unchanged?: true; error?: string; deferred?: true };

export type AppIcons = {
  /**
   * The row to serve for an app, looking first when a look is due. With no icon held yet it waits
   * for the look (up to `FIRST_LOOK_WAIT_MS`); with one it answers at once and refreshes in the
   * background. Never throws.
   */
  serve(workspaceId: string, app: ManagedApp, actor: Actor): Promise<IconRow | undefined>;
  /** Looks now if due, or `force`. Resolves with the row. */
  refresh(
    workspaceId: string,
    app: ManagedApp,
    actor: Actor,
    options?: { force?: boolean },
  ): Promise<IconRow | undefined>;
  /** Resolves when no look is running (tests). */
  idle(): Promise<void>;
};

export function createAppIcons(ctx: IconsContext): AppIcons {
  const limiter = ctx.limiter ?? createTestLimiter({ limit: 6, now: ctx.now });
  const everyone = createTestLimiter({ limit: 15, now: ctx.now });
  const inflight = new Map<string, Promise<IconRow | undefined>>();

  const get = (
    url: string,
    allowHost: (host: string) => boolean,
    maxBytes: number,
    accept: string,
  ): Promise<SafeGetResult> =>
    safeGet(url, {
      allowHost,
      maxBytes,
      accept,
      ...(ctx.net?.allowPrivate ? { allowPrivate: true } : {}),
      ...(ctx.net?.resolve ? { resolve: ctx.net.resolve } : {}),
      ...(ctx.net?.exchange ? { exchange: ctx.net.exchange } : {}),
      ...(ctx.net?.timeoutMs ? { timeoutMs: ctx.net.timeoutMs } : {}),
    });

  /** The repository step. */
  async function fromRepository(
    workspaceId: string,
    app: ManagedApp,
    actor: Actor,
    existing: IconRow | undefined,
  ): Promise<Step> {
    if (!app.repositoryId) return {};
    const opened = await openAssets(
      { repo: ctx.repo },
      { workspaceId, app, scope: 'icons' },
      actor,
    );
    if (!opened.ok)
      return {
        error: String(
          opened.body.message ?? opened.body.error ?? 'The repository could not be read.',
        ),
      };
    const { handle } = opened;
    if (handle.view.status !== 'ok') return {};
    const pick = pickRepositoryIcon(handle.view);
    if (!pick) return {};
    if (existing?.data && existing.source === 'repository' && existing.sourceId === pick.oid)
      return { unchanged: true };
    const file = await handle.readFile(pick.path);
    if (!file.ok) return { error: file.message };
    const checked = checkIconBytes(file.bytes);
    if (!checked.ok) return { error: `${pick.path}: ${checked.message}` };
    return {
      found: { source: 'repository', sourceId: pick.oid, bytes: file.bytes, image: checked.image },
    };
  }

  /** The App Store step (iOS apps with their numeric App Store id). */
  async function fromAppStore(
    workspaceId: string,
    app: ManagedApp,
    existing: IconRow | undefined,
    now: number,
  ): Promise<Step> {
    if (app.platform !== 'ios' || !app.storeAppId || !TRACK_ID.test(app.storeAppId)) return {};
    if (
      existing?.data &&
      existing.source === 'app_store' &&
      existing.fetchedAt !== null &&
      now - existing.fetchedAt < REMOTE_REFRESH_MS
    ) {
      return { unchanged: true };
    }
    if (limiter.take(workspaceId) > 0 || everyone.take('itunes') > 0) return { deferred: true };
    const lookup = await get(
      `https://${ITUNES_HOST}/lookup?id=${app.storeAppId}`,
      (host) => host === ITUNES_HOST,
      LOOKUP_MAX_BYTES,
      'application/json',
    );
    if (!lookup.ok) return { error: `The App Store lookup failed: ${lookup.message}` };
    let artwork: string | undefined;
    try {
      const body = JSON.parse(new TextDecoder().decode(lookup.body)) as { results?: unknown };
      const results = Array.isArray(body.results) ? body.results : [];
      const item = results.find(
        (r): r is Record<string, unknown> =>
          typeof r === 'object' &&
          r !== null &&
          String((r as Record<string, unknown>).trackId) === app.storeAppId,
      );
      // artworkUrl512 is what the lookup returns in practice; the official page documents artworkUrl100 and artworkUrl60.
      const candidate = item?.artworkUrl512 ?? item?.artworkUrl100;
      if (typeof candidate === 'string') artwork = candidate;
    } catch {
      return { error: 'The App Store lookup answered something that is not JSON.' };
    }
    if (!artwork) return {};
    const image = await get(
      artwork,
      (host) => MZSTATIC.test(host),
      ICON_MAX_BYTES,
      'image/png,image/jpeg,image/webp',
    );
    if (!image.ok) return { error: `The App Store artwork could not be fetched: ${image.message}` };
    const checked = checkIconBytes(image.body);
    if (!checked.ok) return { error: `The App Store artwork: ${checked.message}` };
    return {
      found: {
        source: 'app_store',
        sourceId: new URL(image.finalUrl).hostname,
        bytes: image.body,
        image: checked.image,
      },
    };
  }

  async function look(
    workspaceId: string,
    app: ManagedApp,
    actor: Actor,
  ): Promise<IconRow | undefined> {
    const now = ctx.now();
    const existing = await getAppIcon(ctx.db, workspaceId, app.id);
    const row = (patch: Partial<IconRow>): IconRow => ({
      appId: app.id,
      workspaceId,
      source: null,
      sourceId: null,
      mediaType: null,
      data: null,
      size: null,
      width: null,
      height: null,
      etag: null,
      fetchedAt: null,
      checkedAt: now,
      failures: 0,
      backoffUntil: null,
      lastError: null,
      ...patch,
    });
    const keep = (): Partial<IconRow> =>
      existing?.data
        ? {
            source: existing.source,
            sourceId: existing.sourceId,
            mediaType: existing.mediaType,
            data: existing.data,
            size: existing.size,
            width: existing.width,
            height: existing.height,
            etag: existing.etag,
            fetchedAt: existing.fetchedAt,
          }
        : {};
    try {
      const repoStep = await fromRepository(workspaceId, app, actor, existing);
      let step: Step = repoStep;
      let error = repoStep.error;
      // A remote source is a fallback: used when the repository has no icon. A repository that could
      // not be read does not replace an icon that is held.
      if (!step.found && !step.unchanged && !(repoStep.error && existing?.data)) {
        const remote = await fromAppStore(workspaceId, app, existing, now);
        if (remote.found || remote.unchanged) step = remote;
        else if (remote.error) error = remote.error;
        else if (remote.deferred) step = { ...step, deferred: true };
      }
      let next: IconRow;
      if (step.found) {
        const { bytes, image, source, sourceId } = step.found;
        next = row({
          source,
          sourceId,
          mediaType: image.mediaType,
          data: bytes,
          size: bytes.length,
          width: image.width,
          height: image.height,
          etag: etagOf(bytes),
          fetchedAt: now,
        });
      } else if (step.unchanged) {
        next = row(keep());
      } else if (step.deferred && !error) {
        // Not looked at because of the rate limit: nothing changes, and the next request tries again.
        return existing;
      } else if (error) {
        const failures = (existing?.failures ?? 0) + 1;
        next = row({
          ...keep(),
          failures,
          backoffUntil: now + failureBackoffMs(failures),
          lastError: error.slice(0, 300),
        });
      } else {
        // Nothing anywhere: no icon (an icon that was held and is not there any more goes too).
        next = row({ backoffUntil: now + EMPTY_BACKOFF_MS });
      }
      await putAppIcon(ctx.db, next);
      return next;
    } catch (cause) {
      // The database or something unexpected: remember a failure when we can, and never throw.
      const failures = (existing?.failures ?? 0) + 1;
      const message = cause instanceof Error ? cause.message.slice(0, 200) : 'unexpected';
      const next = row({
        ...keep(),
        failures,
        backoffUntil: now + failureBackoffMs(failures),
        lastError: message,
      });
      await putAppIcon(ctx.db, next).catch(() => undefined);
      return next;
    }
  }

  const run = (
    workspaceId: string,
    app: ManagedApp,
    actor: Actor,
  ): Promise<IconRow | undefined> => {
    const key = `${workspaceId}/${app.id}`;
    const running = inflight.get(key);
    if (running) return running;
    const promise = look(workspaceId, app, actor).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };

  return {
    async refresh(workspaceId, app, actor, options = {}) {
      const existing = await getAppIcon(ctx.db, workspaceId, app.id);
      if (!options.force && !lookDue(existing, ctx.now())) return existing;
      return run(workspaceId, app, actor);
    },
    async serve(workspaceId, app, actor) {
      const existing = await getAppIcon(ctx.db, workspaceId, app.id);
      if (!lookDue(existing, ctx.now())) return existing;
      const pending = run(workspaceId, app, actor);
      if (existing?.data) {
        pending.catch(() => undefined);
        return existing;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        pending,
        new Promise<'wait'>((resolve) => {
          timer = setTimeout(() => resolve('wait'), FIRST_LOOK_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      return waited === 'wait' ? existing : waited;
    },
    async idle() {
      await Promise.allSettled([...inflight.values()]);
    },
  };
}
