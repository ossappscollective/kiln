import { type Action, can, isPlatform } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { coded } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import {
  getAppReleaseSettings,
  updateAppReleaseSettings,
} from '../../services/app-release-settings.ts';
import { getApp, listAppReleases, type ManagedApp } from '../../services/apps.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { MAX_NOTES_HISTORY_LIMIT, notesHistory } from '../../services/notes-history.ts';
import { checkPlayReleaseOf } from '../../services/play-release-check.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { requireStepUp, stepUpCovers } from '../../services/step-up.ts';
import { NO_ORIGIN_SOURCES, type OriginSources, withOrigins } from './candidate-origin.ts';
import { withReleaseRules } from './candidate-rules.ts';
import { notWhilePublishing } from './publishing.ts';
import {
  type DraftConnectorFactory,
  defaultDraftConnectorFactory,
  readEditableReleaseOf,
  readReleaseCandidatesOf,
  type StoreConnectContext,
} from './store-draft.ts';
import {
  applyRelease,
  defaultReleaseConnectorFactory,
  getReleaseState,
  previewRelease,
  type ReleaseConnectorFactory,
  type ReleaseContext,
  releaseConfig,
  releaseDisabledFailure,
} from './store-release.ts';
/**
 * Releasing from the app (docs/api/releases-write.md, docs/adr/0014-release-management.md). Two kinds of route:
 *
 * - READS of what a draft release is made of (processed builds, uploaded version codes, the draft's release fields). They look at
 *   the store with the credential of the app and change nothing, so they are not behind a switch (like the store images).
 * - The IRREVERSIBLE step: releasing an approved App Store version, or starting a Google Play draft release at an explicit share of
 *   users. OFF unless KILN_STORE_RELEASE_ENABLED=true, needing the `store.release` action (owner and admin; a token only when its
 *   actions name it), a preview, its `confirmHash` and a typed phrase. One app per request: no bulk release.
 *
 * Mounted under /api/workspaces.
 */
export type ReleaseRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The time to live of a batch publish claim (tests): while one runs for the app, the writes that guard themselves refuse. */
  publishClaimTtlMs?: number | undefined;
  /** Reads of the store (the connector the draft push uses; fakes in tests). */
  draft?: { connectorFactory?: DraftConnectorFactory; timeoutMs?: number };
  release?: {
    /** KILN_STORE_RELEASE_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and release (fakes in tests). */
    connectorFactory?: ReleaseConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  /**
   * What Kiln knows about where a Google Play version code comes from (the CI files it read, the store builds it synced): the builds
   * module's reader in production (`modules/builds/origins.ts`), a fake in tests. Without it no version or date is known.
   */
  origins?: (input: {
    workspaceId: string;
    app: ManagedApp;
    actor: { type: 'user' | 'token' | 'assistant' | 'system'; id: string };
  }) => Promise<OriginSources>;
  /** Store reads per workspace per minute (the reads of builds and version codes). */
  readLimit?: number;
  /** "Check with Google Play" per workspace per minute (each check opens, validates and deletes an edit: four store calls). */
  checkLimit?: number;
};

/** The origins are a help, never a reason to wait: past this the codes are shown without them. */
const ORIGINS_TIMEOUT_MS = 8000;
const withinMs = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const hash64 = /^[0-9a-f]{64}$/;
const what = {
  version: z.string().min(1).max(40).optional(),
  track: z.string().min(1).max(100).optional(),
  versionCodes: z
    .array(z.string().regex(/^[0-9]{1,10}$/, 'A version code is a whole number.'))
    .min(1)
    .max(20)
    .optional(),
  userFraction: z.number().gt(0).lte(1).optional(),
  direct: z.boolean().optional(),
};
const previewBody = z.object(what).strict();
const playCheckBody = z
  .object({
    track: z.string().min(1).max(100),
    versionCodes: z
      .array(z.string().regex(/^[0-9]{1,10}$/, 'A version code is a whole number.'))
      .min(1)
      .max(20),
    releaseName: z.string().max(100).optional(),
    status: z.enum(['draft', 'inProgress', 'completed']).optional(),
    userFraction: z.number().gt(0).lte(1).optional(),
    notes: z
      .array(z.object({ locale: z.string().min(1).max(20), text: z.string().max(4000) }).strict())
      .max(80)
      .optional(),
  })
  .strict();
const releaseSettingsBody = z
  .object({
    defaultSharePercent: z.number().min(1).max(100).nullable().optional(),
    stagedRollout: z.enum(['auto', 'always_ask', 'never']).optional(),
  })
  .strict();
const applyBody = z
  .object({
    ...what,
    confirmHash: z
      .string()
      .regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
    /** Required unless the person's own confirmation (step-up) stands in for it; the service then ignores it. */
    confirmation: z.string().max(300).default(''),
  })
  .strict();

export function storeReleaseRoutes(ctx: ReleaseRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  /** Refused with `409 publish_in_progress` while a batch publish of the app runs (publishing.ts). */
  const notPublishing = notWhilePublishing({ db, now: ctx.now, claimTtlMs: ctx.publishClaimTtlMs });
  const release: ReleaseContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    releaseEnabled: ctx.release?.enabled ?? false,
    releaseConnectorFactory: ctx.release?.connectorFactory ?? defaultReleaseConnectorFactory,
    ...(ctx.release?.timeoutMs !== undefined ? { releaseTimeoutMs: ctx.release.timeoutMs } : {}),
    ...(ctx.release?.claimTtlMs !== undefined ? { claimTtlMs: ctx.release.claimTtlMs } : {}),
  };
  const reads: StoreConnectContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
  };
  const limiter = createTestLimiter({ limit: ctx.readLimit ?? 30, now: ctx.now });
  const checkLimiter = createTestLimiter({ limit: ctx.checkLimit ?? 10, now: ctx.now });

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const throttled = (c: Context<AppEnv>): Failure | undefined => {
    const wait = limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return {
      ...failure(
        429,
        'rate_limited',
        `Too many store reads. Try again in ${wait} seconds.`,
        coded('rate.storeReads', { count: wait }),
      ),
      headers: { 'Retry-After': String(wait) },
    };
  };

  // ----- reads: what a draft release is made of

  routes.get('/:workspaceId/apps/:id/release/candidates', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const wait = throttled(c);
    if (wait) return respond(c, wait);
    const done = await readReleaseCandidatesOf(reads, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      version: c.req.query('version') || undefined,
      track: c.req.query('track') || undefined,
    });
    c.header('Cache-Control', 'no-store');
    if (!done.ok) return respond(c, done);
    // One join on the server: the version and build date of every version code (never a request per code from the browser).
    let sources = NO_ORIGIN_SOURCES;
    if (done.read.store === 'googleplay' && ctx.origins) {
      sources = await withinMs(
        ctx.origins({ workspaceId: ws(c), app, actor: actor(c) }),
        ORIGINS_TIMEOUT_MS,
      ).catch(() => NO_ORIGIN_SOURCES);
    }
    // The same rules the web and the create call use (`createReleaseRules`, `analyzeCandidates` of @kiln/core), once, on the server.
    const releases = await listAppReleases(db, ws(c), app.id);
    const ruled = withReleaseRules(done.read, { appId: app.id, releases });
    return c.json({ candidates: withOrigins(ruled, sources, app.identifier) });
  });

  // The texts earlier releases used for "what is new": the store's (cached, one read per ten minutes) and this app's plans.
  routes.get('/:workspaceId/apps/:id/release/notes-history', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const issues: { path: string; message: string }[] = [];
    const platform = c.req.query('platform');
    if (platform !== undefined && platform !== '' && !isPlatform(platform)) {
      issues.push({ path: 'platform', message: 'Use ios, macos or android.' });
    }
    const locale = c.req.query('locale');
    if (
      locale !== undefined &&
      locale !== '' &&
      !/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,2}$/.test(locale)
    ) {
      issues.push({ path: 'locale', message: 'Not a language code, for example en-US.' });
    }
    const limitRaw = c.req.query('limit');
    const limit =
      limitRaw === undefined || limitRaw === ''
        ? undefined
        : /^[0-9]{1,4}$/.test(limitRaw)
          ? Number(limitRaw)
          : Number.NaN;
    if (limit !== undefined && !(limit >= 1 && limit <= MAX_NOTES_HISTORY_LIMIT)) {
      issues.push({
        path: 'limit',
        message: `A whole number from 1 to ${MAX_NOTES_HISTORY_LIMIT}.`,
      });
    }
    // Google Play: the notes of one release of a track (the source of a promotion), found by its version codes.
    const track = c.req.query('track');
    if (track !== undefined && track !== '' && !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/.test(track)) {
      issues.push({ path: 'track', message: 'A track name, for example internal.' });
    }
    const codesRaw = c.req.query('codes');
    const codes = codesRaw === undefined || codesRaw === '' ? [] : codesRaw.split(',');
    if (codes.length > 20 || codes.some((x) => !/^[0-9]{1,10}$/.test(x))) {
      issues.push({ path: 'codes', message: 'Up to 20 version codes, separated by commas.' });
    }
    if (codes.length > 0 && (track === undefined || track === '')) {
      issues.push({ path: 'track', message: 'Name the track the version codes are in.' });
    }
    if (issues.length > 0) return c.json({ error: 'invalid_request', issues }, 400);
    if (platform !== undefined && platform !== '' && platform !== app.platform) {
      return respond(
        c,
        failure(
          422,
          'platform_mismatch',
          `This app is on ${app.platform}; the notes of ${platform} are not read for it.`,
          coded('plan.notesPlatform', { appPlatform: app.platform, platform }),
        ),
      );
    }
    let retryAfter: number | undefined;
    const history = await notesHistory(reads, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      locale: locale || undefined,
      limit,
      track: track || undefined,
      codes,
      // Only a read that goes to the store counts against the limit: a cached answer costs the store nothing.
      beforeStoreRead: () => {
        const wait = limiter.take(ws(c));
        if (wait <= 0) return undefined;
        retryAfter = wait;
        return { error: 'rate_limited' };
      },
    });
    if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
    c.header('Cache-Control', 'no-store');
    return c.json({ history });
  });

  routes.get('/:workspaceId/apps/:id/release/editable', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const wait = throttled(c);
    if (wait) return respond(c, wait);
    const done = await readEditableReleaseOf(reads, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      track: c.req.query('track') || undefined,
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ editable: done.read }) : respond(c, done);
  });

  // "Check with Google Play": stages the proposed release in a throw-away edit, validates it and deletes the edit. Never commits,
  // so it is a read of this server's rules: `listing.read`, no switch, its own purpose in the credential audit, its own limit.
  routes.post('/:workspaceId/apps/:id/release/play-check', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, playCheckBody);
    if (!body.ok) return body.response;
    const wait = checkLimiter.take(ws(c));
    if (wait > 0)
      return respond(c, {
        ...failure(
          429,
          'rate_limited',
          `Too many checks. Try again in ${wait} seconds.`,
          coded('rate.checks', { count: wait }),
        ),
        headers: { 'Retry-After': String(wait) },
      });
    const done = await checkPlayReleaseOf(release, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      body: body.data,
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ check: done.check }) : respond(c, done);
  });

  // ----- the per-app settings of a Google Play release (a default share to pre-fill, whether a staged rollout is offered)

  routes.get('/:workspaceId/apps/:id/release-settings', needs('apps.read'), async (c) => {
    const done = await getAppReleaseSettings(db, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok
      ? c.json({ settings: done.settings, earlierProductionRelease: done.earlierProductionRelease })
      : respond(c, done);
  });

  routes.put('/:workspaceId/apps/:id/release-settings', needs('apps.write'), async (c) => {
    const body = await parseBody(c, releaseSettingsBody);
    if (!body.ok) return body.response;
    const done = await updateAppReleaseSettings(
      db,
      { workspaceId: ws(c), appId: param(c, 'id'), changes: body.data, actor: actor(c) },
      ctx.now(),
    );
    return done.ok ? c.json({ settings: done.settings, changed: done.changed }) : respond(c, done);
  });

  // ----- the irreversible step

  routes.get('/:workspaceId/store-release/config', needs('apps.read'), (c) =>
    c.json(releaseConfig(release)),
  );

  routes.get('/:workspaceId/apps/:id/store-release', needs('store.release'), async (c) => {
    const done = await getReleaseState(release, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ release: done.state }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/store-release/preview', needs('store.release'), async (c) => {
    if (!release.releaseEnabled) return respond(c, releaseDisabledFailure());
    const body = await parseBody(c, previewBody);
    if (!body.ok) return body.response;
    const done = await previewRelease(release, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      ...body.data,
      actor: actor(c),
      stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.release'),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that releases anything. One app per request: no bulk release.
  routes.post(
    '/:workspaceId/apps/:id/store-release',
    needs('store.release'),
    notPublishing,
    async (c) => {
      if (!release.releaseEnabled) return respond(c, releaseDisabledFailure());
      const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'store.release', {
        id: param(c, 'id'),
        hashField: 'confirmHash',
      });
      if (stepUpRefusal) return stepUpRefusal;
      const body = await parseBody(c, applyBody);
      if (!body.ok) return body.response;
      const done = await applyRelease(release, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        ...body.data,
        actor: actor(c),
        stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.release'),
      });
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  return routes;
}
