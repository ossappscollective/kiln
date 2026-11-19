import { serveStatic } from '@hono/node-server/serve-static';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { type BearerOptions, requireAuth } from './bearer.ts';
import { type AppEnv, type Services, sameOrigin } from './http.ts';
import { createLoginLimiter } from './limiter.ts';
import { authRoutes, meRoute, requireUser } from './routes/auth.ts';
import { appRoutes } from './routes/apps.ts';
import { asoRoutes } from './routes/aso.ts';
import { ciRoutes } from './routes/ci.ts';
import { type CredentialTestDeps, credentialTestRoutes } from './routes/credential-tests.ts';
import { publicInvitationRoutes, workspaceInvitationRoutes } from './routes/invitations.ts';
import { assetRoutes } from './routes/assets.ts';
import { type AssetSyncRoutesContext, assetSyncRoutes } from './routes/asset-sync.ts';
import { changeSetFixupRoutes } from './routes/change-set-fixup.ts';
import { listingRoutes } from './routes/listing.ts';
import { type EventStreamHub, createEventStreamHub, eventRoutes } from './routes/events.ts';
import { memberRoutes } from './routes/members.ts';
import { planRoutes } from './routes/plans.ts';
import { type ReviewRoutesContext, reviewRoutes } from './routes/reviews.ts';
import { reviewTranslationRoutes } from './routes/review-translation.ts';
import { type RolloutRoutesContext, rolloutRoutes } from './routes/rollout.ts';
import { type StagedRoutesContext, stagedRoutes } from './routes/staged-changes.ts';
import { type ReleaseRoutesContext, storeReleaseRoutes } from './routes/store-release.ts';
import { type SubmitRoutesContext, storeSubmitRoutes } from './routes/store-submit.ts';
import { settingsRoutes } from './routes/settings.ts';
import { repositoryRoutes } from './routes/repositories.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { type WebhookRoutesContext, webhookRoutes } from './routes/webhooks.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  type StoreConnectorFactory,
  defaultStoreConnectorFactory,
} from './services/apps.ts';
import { type CiContext, createCiContext } from './services/ci.ts';
import {
  type CloneUpkeep,
  DEFAULT_CLONE_IDLE_DAYS,
  DEFAULT_CLONE_MAX_BYTES,
  createCloneUpkeep,
} from './services/clone-upkeep.ts';
import { operations } from './services/api-operations.ts';
import { type AsoLimits, DEFAULT_ASO_LIMITS } from './services/aso.ts';
import { type AsoSources, createAsoSources } from './services/aso-net.ts';
import { createAppIcons, type IconsContext } from './services/app-icons.ts';
import { createTestLimiter, type TestLimiter } from './services/credential-tests.ts';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  type RatingFetcher,
  type ReviewConnectorFactory,
  defaultReviewConnectorFactory,
} from './services/review-sync.ts';
import { buildOpenApiDocument } from './services/openapi.ts';
import { type TranslationContext, createTranslateDraft } from './services/translation.ts';
import { DEFAULT_REPO_TIMEOUT_MS, defaultConnectorFactory } from './services/repositories.ts';
import type { LocalWriteConfig } from './services/local-reads.ts';
import type { CloneReads, ConnectorFactory } from './services/repositories.ts';
import { createLaunchGate, hostGuard } from './single-user.ts';

/** Largest request body of any API route. Listings are text; the biggest legitimate one is far below. */
export const BODY_LIMIT = 1024 * 1024;
/** Largest body on the routes that need no session (sign-in, setup, invitations). */
export const PUBLIC_BODY_LIMIT = 256 * 1024;
/** Failed logins allowed per client address in one window. Per email the limit is 5. */
export const IP_LOGIN_MAX_ATTEMPTS = 30;

/**
 * The web UI is a Vite/Svelte bundle served from this origin: module scripts and CSS files from
 * 'self', icons as data: URIs. Inline styles are allowed because Svelte transitions add <style>
 * elements at run time. Nothing may frame the app, and the API is the only connect target.
 */
export const SECURE_HEADERS: NonNullable<Parameters<typeof secureHeaders>[0]> = {
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  xFrameOptions: 'DENY',
  xContentTypeOptions: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  // HSTS belongs to the TLS-terminating proxy; over plain HTTP a browser ignores it anyway.
  strictTransportSecurity: false,
  overwrite: false,
};

export type AppDeps = {
  db: Database;
  masterKey: Buffer;
  version: string;
  /** Origins besides this server that may send state-changing requests, e.g. a dev server. */
  trustedOrigins?: string[];
  /** Overridable for tests. */
  now?: () => number;
  cost?: Services['cost'];
  limiter?: Services['limiter'];
  /** Failed logins per client address. Default: 30 per 15 minutes, looser than the per-email limit. */
  ipLimiter?: Services['ipLimiter'];
  /** Bad attempts per invitation link. Its own instance, never the login limiter. */
  inviteLimiter?: Services['inviteLimiter'];
  /** Believe X-Forwarded-For for the client address (MRM_TRUST_PROXY=1). Default: no. */
  trustProxy?: boolean;
  /** Folder with the built web UI, relative to the working directory. Omit to serve the API only. */
  webDist?: string;
  /**
   * Turns on single-user mode (desktop). `port` is the port the server listens on, for the Host
   * check. `extraHosts` are further exact Host values (loopback with a port), for a dev server.
   * Omit `singleUser` for the normal multi-user server.
   */
  singleUser?: { launchSecret: string; port: number; extraHosts?: string[] };
  /** Overridable for tests: the verifiers, their fetch, the timeout and the rate limit of "test connection". */
  credentialTests?: CredentialTestDeps;
  /**
   * Builds the repository connector from a stored credential: `(kind, secret, { owner, repo })`.
   * Overridable for tests; the default is the real GitHub connector.
   */
  connectorFactory?: ConnectorFactory;
  /** Longest a synchronous repository job (scan, listing, apply) may run. Default 90 seconds. */
  repositoryTimeoutMs?: number;
  /**
   * Local clones for scan and listing reads (MRM_READS, docs/adr/0005-local-clone-reads.md).
   * Built at start by `setUpReads`. Omitted: reads go through the GitHub API.
   */
  reads?: CloneReads;
  /**
   * Upkeep of the clone folder (limits, pruning, the clones route): built in index.ts, which also
   * hands it to the scheduler's sweep. Omitted: one with the defaults (2 GiB, 30 days) is made when
   * `reads` is set, so the routes work; it sweeps nothing until something calls `sweep`.
   */
  cloneUpkeep?: CloneUpkeep;
  /** Writing to local clones: MRM_LOCAL_REPO_WRITE, the commit author, and (tests) where a push goes. Omitted: off. */
  localWrite?: LocalWriteConfig;
  /**
   * Store sync of apps. `connectorFactory` builds the read-only App Store Connect / Google Play
   * connector from a stored credential (overridable for tests), `timeoutMs` is the longest one
   * sync may run (default 60 seconds), `limiter` defaults to 10 syncs per workspace per minute.
   */
  appSync?: { connectorFactory?: StoreConnectorFactory; timeoutMs?: number; limiter?: TestLimiter };
  /** API token requests: the per-token rate limit (default 300 a minute) and the bad-token limit. Overridable for tests. */
  tokens?: BearerOptions;
  /**
   * The open event streams. index.ts makes one so it can end them at shutdown (`closeAll`); omitted,
   * the app has a private one. Streams are capped per person.
   */
  eventStreams?: EventStreamHub;
  /**
   * Outbound webhooks. `allowPrivate` is MRM_WEBHOOKS_ALLOW_PRIVATE=1 (loopback and private
   * addresses, and http to localhost); `resolve` and `send` are for tests. The delivery job itself
   * is registered in index.ts with the same options.
   */
  webhooks?: Pick<WebhookRoutesContext, 'allowPrivate' | 'resolve' | 'send' | 'limiter'>;
  /**
   * CI runs and build linking (docs/api/ci.md). Uses `connectorFactory` and `repositoryTimeoutMs`.
   * `limiter` is the per workspace limit of dispatches (default 10 per minute), `matchers` the
   * build number conventions, `pollMaxMs` how long `ci.poll` follows a run. All optional.
   */
  ci?: Partial<Pick<CiContext, 'limiter' | 'activeLimiter' | 'matchers' | 'pollMaxMs'>>;
  /**
   * The scheduled listing read (MRM_LISTING_INTERVAL_MINUTES) in milliseconds, 0 or absent for off.
   * Only used to tell the Listing tab when the next read is due; the scheduler is built in index.ts.
   */
  listing?: { intervalMs?: number };
  /**
   * Media files of the repositories and app icons (docs/api/assets.md). `limiter` is the per
   * workspace limit of index reads that miss the cache (default 30 a minute); `icons` holds the
   * seams of the App Store icon lookup (`limiter`: lookups per workspace, `net`: resolver,
   * exchange and allowPrivate, for tests and development). All optional.
   */
  assets?: { limiter?: TestLimiter; icons?: Pick<IconsContext, 'limiter' | 'net'> };
  /**
   * Two way sync of graphics (docs/api/assets.md): `net` is the exchange and address check of the downloads from a store's CDN
   * (fakes in tests), the limiters are per workspace (store reads, CDN fetches, uploads). All optional.
   */
  assetSync?: Pick<AssetSyncRoutesContext, 'net' | 'storeLimiter' | 'fetchLimiter' | 'uploadLimiter'>;
  /**
   * Customer reviews (docs/api/reviews.md), read-only. `connectorFactory` builds the App Store
   * Connect / Google Play reviews connector (overridable for tests), `ratingFetcher` the store-wide
   * rating (null turns it off), `timeoutMs` the longest one sync may run (default 90 seconds).
   * `limiter` defaults to the one of the app syncs. `retentionDays` (MRM_REVIEW_RETENTION_DAYS) is
   * only shown to people; the pruning is the scheduler's.
   */
  reviews?: {
    connectorFactory?: ReviewConnectorFactory;
    ratingFetcher?: RatingFetcher | null;
    timeoutMs?: number;
    limiter?: TestLimiter;
    lowRatingThreshold?: number;
    retentionDays?: number;
    /**
     * Replying to reviews, a store write that is OFF unless `enabled` (MRM_REVIEW_REPLY_ENABLED).
     * `connectorFactory` builds the connector that can reply (fakes in tests), `translateDraft` is
     * the optional seam for translating a draft (wired to services/translation.ts by the lead).
     */
    reply?: NonNullable<ReviewRoutesContext['reply']>;
  };
  /**
   * Changing a live rollout in a store (docs/api/rollout.md), a store write that is OFF unless `enabled`
   * (MRM_STORE_ROLLOUT_ENABLED). `connectorFactory` builds the connector that can read and change a
   * rollout (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  rollout?: RolloutRoutesContext['rollout'];
  /**
   * Staged listing text and graphics, and writing them to the store as a DRAFT (docs/api/staged-changes.md):
   * a store write that is OFF unless `enabled` (MRM_STORE_DRAFT_WRITE_ENABLED). `connectorFactory` builds the
   * connector that can read and write a draft (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  storeDraft?: StagedRoutesContext['draft'];
  /**
   * Submitting the store's draft for review (docs/api/submit.md, docs/adr/0010-store-submit.md): a store write that
   * is OFF unless `enabled` (MRM_STORE_SUBMIT_ENABLED). `connectorFactory` builds the connector that can read and
   * submit (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  storeSubmit?: SubmitRoutesContext['submit'];
  /**
   * Releasing (docs/api/releases-write.md, docs/adr/0014-release-management.md): releasing an approved App Store version or
   * starting a Google Play draft release is a store write that is OFF unless `enabled` (MRM_STORE_RELEASE_ENABLED).
   * `connectorFactory` builds the connector that can read and release (fakes in tests); `timeoutMs` and `claimTtlMs` are for
   * tests. The reads of builds and version codes use the draft connector (`storeDraft.connectorFactory`) and no switch.
   */
  storeRelease?: ReleaseRoutesContext['release'];
  /**
   * ASO, keyword ranks and competitors from public store data (docs/api/aso.md). `sources` reads the stores (a fake in
   * tests; index.ts builds one and shares it with the worker, so the cache and the rate limits are shared);
   * `limits` are the MRM_ASO_* values; `limiter` is the per workspace budget of refreshes and lookups (default 10 a minute).
   */
  aso?: { sources?: AsoSources; limits?: Partial<AsoLimits>; limiter?: TestLimiter; maxRunMs?: number };
  /**
   * Translation of reviews and the workspace settings (docs/api/settings.md, docs/api/reviews.md).
   * `allowPrivateUrls` is MRM_TRANSLATE_ALLOW_PRIVATE_URLS (a private or loopback LibreTranslate
   * address); `fetch`, `resolve`, `exchange` and `timeoutMs` replace the network in tests;
   * `limiter` is the per workspace budget of translation requests (default 20 a minute).
   */
  translation?: Pick<TranslationContext, 'allowPrivateUrls' | 'fetch' | 'resolve' | 'exchange' | 'timeoutMs'> & {
    limiter?: TestLimiter;
  };
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const services: Services = {
    db: deps.db,
    masterKey: deps.masterKey,
    now: deps.now ?? Date.now,
    limiter: deps.limiter ?? createLoginLimiter(),
    ipLimiter: deps.ipLimiter ?? createLoginLimiter({ max: IP_LOGIN_MAX_ATTEMPTS }),
    inviteLimiter: deps.inviteLimiter ?? createLoginLimiter(),
    trustProxy: deps.trustProxy ?? false,
    cost: deps.cost,
    singleUser: deps.singleUser && { gate: createLaunchGate(deps.singleUser.launchSecret) },
  };

  // First, and on every path including the static UI: a rebound DNS name must get nothing.
  if (deps.singleUser) app.use('*', hostGuard(deps.singleUser.port, deps.singleUser.extraHosts));

  // Headers for every response, the static UI included. A handler that sets one itself (for
  // example Referrer-Policy: no-referrer on the invitation and launch routes) keeps its value.
  app.use('*', secureHeaders(SECURE_HEADERS));

  // Body size limits, before anything reads a body. The unauthenticated routes get the small one.
  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);
  app.use('/api/auth/*', bodyLimit({ maxSize: PUBLIC_BODY_LIMIT, onError: tooLarge }));
  app.use('/api/invitations/*', bodyLimit({ maxSize: PUBLIC_BODY_LIMIT, onError: tooLarge }));
  app.use('/api/*', bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge }));

  app.use('/api/*', sameOrigin(deps.trustedOrigins));

  app.get('/api/health', async (c) => {
    const base = { version: deps.version, database: { dialect: deps.db.dialect } };
    try {
      await deps.db.ping();
      return c.json({ status: 'ok', ...base, database: { ...base.database, ok: true } });
    } catch {
      return c.json(
        { status: 'degraded', ...base, database: { ...base.database, ok: false } },
        503,
      );
    }
  });

  app.route('/api/auth', authRoutes(services));
  app.use('/api/me', requireUser(services));
  app.route('/api/me', meRoute(services));
  // The session cookie, or an API token (bearer.ts). Cookie requests are handled exactly as before.
  const auth = requireAuth(services, deps.tokens);
  app.use('/api/workspaces/*', auth);
  app.use('/api/openapi.json', auth);
  // Before the other workspace routes, so /credentials/test is never read as a credential id.
  const translationSeams = {
    ...(deps.translation?.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
    ...(deps.translation?.fetch ? { fetch: deps.translation.fetch } : {}),
    ...(deps.translation?.resolve ? { resolve: deps.translation.resolve } : {}),
    ...(deps.translation?.exchange ? { exchange: deps.translation.exchange } : {}),
    ...(deps.translation?.timeoutMs !== undefined ? { timeoutMs: deps.translation.timeoutMs } : {}),
  };
  app.route('/api/workspaces', credentialTestRoutes(services, { ...deps.credentialTests, translate: translationSeams }));
  app.route('/api/workspaces', workspaceRoutes(services));
  app.route('/api/workspaces', memberRoutes(services));
  app.route('/api/workspaces', workspaceInvitationRoutes(services));
  app.route('/api/workspaces', tokenRoutes(services));
  app.route('/api/workspaces', eventRoutes(services, deps.eventStreams ?? createEventStreamHub()));
  app.route(
    '/api/workspaces',
    webhookRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      ...deps.webhooks,
    }),
  );
  const cloneUpkeep =
    deps.cloneUpkeep ??
    (deps.reads
      ? createCloneUpkeep({
          reads: deps.reads,
          db: services.db,
          config: { maxBytes: DEFAULT_CLONE_MAX_BYTES, idleDays: DEFAULT_CLONE_IDLE_DAYS },
          now: services.now,
        })
      : undefined);
  app.route(
    '/api/workspaces',
    repositoryRoutes(
      {
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
        timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
        reads: deps.reads,
        localWrite: deps.localWrite,
      },
      cloneUpkeep,
    ),
  );
  // One context and one budget for the sync routes and for the optional store read of a listing pull.
  const appsContext = {
    db: services.db,
    masterKey: services.masterKey,
    now: services.now,
    connectorFactory: deps.appSync?.connectorFactory ?? defaultStoreConnectorFactory,
    timeoutMs: deps.appSync?.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
  };
  const appSyncLimiter = deps.appSync?.limiter ?? createTestLimiter({ now: services.now });
  app.route('/api/workspaces', appRoutes({ ...appsContext, limiter: appSyncLimiter }));
  // Workspace settings (any member reads, admins write) and the translation of stored reviews.
  app.route(
    '/api/workspaces',
    settingsRoutes({
      db: services.db,
      now: services.now,
      ...(translationSeams.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
      ...(translationSeams.resolve ? { resolve: translationSeams.resolve } : {}),
    }),
  );
  app.route(
    '/api/workspaces',
    reviewTranslationRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      ...translationSeams,
      limiter: deps.translation?.limiter ?? createTestLimiter({ now: services.now, limit: 20 }),
    }),
  );
  // ASO: keyword ranks and competitors from public store data. Google Play only when MRM_ASO_PLAY_UNOFFICIAL_ENABLED.
  const asoLimits: AsoLimits = { ...DEFAULT_ASO_LIMITS, ...(deps.aso?.limits ?? {}) };
  app.route(
    '/api/workspaces',
    asoRoutes({
      db: services.db,
      now: services.now,
      sources:
        deps.aso?.sources ??
        createAsoSources({
          playEnabled: false,
          now: services.now,
          cacheMs: 60 * 60_000,
          appleCallsPerMinute: 10,
          playCallsPerMinute: 4,
        }),
      limits: asoLimits,
      ...(deps.aso?.maxRunMs !== undefined ? { maxRunMs: deps.aso.maxRunMs } : {}),
      limiter: deps.aso?.limiter ?? createTestLimiter({ now: services.now }),
    }),
  );
  // Customer reviews: an inbox with internal triage. Replying (a store write) is off unless MRM_REVIEW_REPLY_ENABLED.
  app.route(
    '/api/workspaces',
    reviewRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      connectorFactory: deps.reviews?.connectorFactory ?? defaultReviewConnectorFactory,
      ...(deps.reviews?.ratingFetcher !== undefined ? { ratingFetcher: deps.reviews.ratingFetcher } : {}),
      timeoutMs: deps.reviews?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      ...(deps.reviews?.lowRatingThreshold !== undefined ? { lowRatingThreshold: deps.reviews.lowRatingThreshold } : {}),
      ...(deps.reviews?.retentionDays !== undefined ? { retentionDays: deps.reviews.retentionDays } : {}),
      // Reply drafts can be translated with the workspace's translation provider, unless a test supplies its own.
      ...(deps.reviews?.reply
        ? {
            reply: {
              ...deps.reviews.reply,
              translateDraft:
                deps.reviews.reply.translateDraft ??
                createTranslateDraft({ db: services.db, masterKey: services.masterKey, now: services.now, ...translationSeams }),
            },
          }
        : {}),
      translation: translationSeams,
      limiter: deps.reviews?.limiter ?? appSyncLimiter,
    }),
  );
  // Changing a live rollout in a store: off unless MRM_STORE_ROLLOUT_ENABLED. Gated like review replies.
  app.route(
    '/api/workspaces',
    rolloutRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      ...(deps.rollout ? { rollout: deps.rollout } : {}),
    }),
  );
  // Release planning: our own checklists, notes and deadlines. No store is read or written.
  app.route('/api/workspaces', planRoutes({ db: services.db, now: services.now }));
  // Live store listing, drift and history. Read-only: nothing here writes to a store. Only
  // `repo-refresh` sends traffic (to GitHub), with its own per-workspace rate limit.
  app.route(
    '/api/workspaces',
    listingRoutes({
      db: services.db,
      now: services.now,
      repo: {
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
        timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
        reads: deps.reads,
      },
      limiter: createTestLimiter({ now: services.now }),
      sync: { apps: appsContext, limiter: appSyncLimiter },
      ...(deps.listing?.intervalMs ? { listingIntervalMs: deps.listing.intervalMs } : {}),
    }),
  );
  // Fix up the branch of a change set (one more commit on top of it) and recompute a store pull.
  // They share the context of the repository routes (clones, the local write switch) and the store
  // read of a pull (the app sync's context and per workspace budget).
  app.route(
    '/api/workspaces',
    changeSetFixupRoutes({
      db: services.db,
      now: services.now,
      repo: {
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
        timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
        reads: deps.reads,
        localWrite: deps.localWrite,
      },
      limiter: createTestLimiter({ now: services.now }),
      sync: { apps: appsContext, limiter: appSyncLimiter },
    }),
  );
  // Media files of the repositories (screenshots, graphics) and the icon of an app. Read-only:
  // nothing is written to a repository or sent to a store. Reads of the repository use the same
  // connector factory and clones as the listing reads; the icon lookup also asks the public
  // iTunes Lookup API for iOS apps whose repository has no icon.
  const assetsRepo = {
    db: services.db,
    masterKey: services.masterKey,
    now: services.now,
    connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
    timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
    reads: deps.reads,
  };
  const assetsLimiter = deps.assets?.limiter ?? createTestLimiter({ limit: 30, now: services.now });
  app.route(
    '/api/workspaces',
    assetRoutes({
      db: services.db,
      now: services.now,
      repo: assetsRepo,
      limiter: assetsLimiter,
      icons: createAppIcons({
        db: services.db,
        now: services.now,
        repo: assetsRepo,
        ...(deps.assets?.icons?.limiter ? { limiter: deps.assets.icons.limiter } : {}),
        ...(deps.assets?.icons?.net ? { net: deps.assets.icons.net } : {}),
      }),
    }),
  );
  // Staged listing text and graphics of an app, and writing them to the store as a draft. Staging touches the
  // database only (files are read through the asset index, with the budget of the Assets tab); the push is
  // off unless MRM_STORE_DRAFT_WRITE_ENABLED and never submits anything.
  app.route(
    '/api/workspaces',
    stagedRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      repo: assetsRepo,
      limiter: assetsLimiter,
      ...(deps.storeDraft ? { draft: deps.storeDraft } : {}),
    }),
  );
  // Two way sync of graphics: the store's images and their comparison with the repository, pulling them into a change set,
  // and uploading, replacing, removing and fixing the files of a staged set. Store reads change nothing in the store.
  app.route(
    '/api/workspaces',
    assetSyncRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      repo: assetsRepo,
      limiter: assetsLimiter,
      ...(deps.storeDraft ? { draft: deps.storeDraft } : {}),
      ...(deps.assetSync ?? {}),
    }),
  );
  // Submitting the pushed draft for store review: reads the store and writes only to its review queue; off unless
  // MRM_STORE_SUBMIT_ENABLED. Never releases and never changes a rollout.
  app.route(
    '/api/workspaces',
    storeSubmitRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      ...(deps.storeSubmit ? { submit: deps.storeSubmit } : {}),
    }),
  );
  // Releasing: reads of builds and version codes (no switch), and the irreversible step (off unless MRM_STORE_RELEASE_ENABLED).
  app.route(
    '/api/workspaces',
    storeReleaseRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      ...(deps.storeDraft ? { draft: { ...(deps.storeDraft.connectorFactory ? { connectorFactory: deps.storeDraft.connectorFactory } : {}), ...(deps.storeDraft.timeoutMs !== undefined ? { timeoutMs: deps.storeDraft.timeoutMs } : {}) } } : {}),
      ...(deps.storeRelease ? { release: deps.storeRelease } : {}),
    }),
  );
  // CI: workflows, dispatch and runs of a repository, and the builds of an app linked to them.
  app.route(
    '/api/workspaces',
    ciRoutes(
      createCiContext(
        {
          db: services.db,
          masterKey: services.masterKey,
          now: services.now,
          connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
          timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
        },
        deps.ci,
      ),
    ),
  );
  // Public: the person with the link is not signed in yet.
  app.route('/api/invitations', publicInvitationRoutes(services));

  const openApiDocument = buildOpenApiDocument(operations, { version: deps.version });
  app.get('/api/openapi.json', (c) => c.json(openApiDocument));

  // Anything else under /api is an unknown route, not a page.
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  if (deps.webDist) {
    const root = deps.webDist.startsWith('.') || deps.webDist.startsWith('/')
      ? deps.webDist
      : `./${deps.webDist}`;
    app.use('/*', serveStatic({ root }));
    // Single-page app: unknown paths load the shell and the client router takes over.
    app.get('*', serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
