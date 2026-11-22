import { serveStatic } from '@hono/node-server/serve-static';
import type { Database } from '@kiln/db';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { type BearerOptions, requireAuth } from './bearer.ts';
import { type AppEnv, type Services, sameOrigin } from './http.ts';
import { createLoginLimiter } from './limiter.ts';
import { type McpDeps, mountMcp } from './mcp/routes.ts';
import { type AiSettings, aiModule } from './modules/ai/index.ts';
import { alertsModule } from './modules/alerts/index.ts';
import { type ChatDeps, chatModule } from './modules/chat/index.ts';
import { type AnalyticsDeps, analyticsModule } from './modules/analytics/index.ts';
import { analyticsImportPath } from './modules/analytics/routes.ts';
import { type AsoDeps, asoLimitsFor, asoModule } from './modules/aso/index.ts';
import { type BuildsDeps, buildsModule } from './modules/builds/index.ts';
import { ciModule } from './modules/ci/index.ts';
import { type CiContext, createCiContext } from './modules/ci/service.ts';
import { type EasDeps, easModule } from './modules/eas/index.ts';
import { type ListingDeps, listingModule } from './modules/listing/index.ts';
import { type ExperimentsDeps, experimentsModule } from './modules/experiments/index.ts';
import { type MonetizationDeps, monetizationModule } from './modules/monetization/index.ts';
import { type RevenueCatDeps, revenuecatModule } from './modules/revenuecat/index.ts';
import type { ModuleShared } from './modules/module.ts';
import { planningModule } from './modules/planning/index.ts';
import { type PublishDeps, publishModule } from './modules/publish/index.ts';
import { type ReviewsDeps, reviewsModule } from './modules/reviews/index.ts';
import { defaultReplyConnectorFactory } from './modules/reviews/replies.ts';
import { buildOpenApiDocument } from './operations/openapi.ts';
import { operations } from './operations/registry.ts';
import { appRoutes } from './routes/apps.ts';
import { authRoutes, meRoute, requireUser } from './routes/auth.ts';
import { meLocaleRoute } from './routes/me-locale.ts';
import { changeSetFixupRoutes } from './routes/change-set-fixup.ts';
import { type CredentialTestDeps, credentialTestRoutes } from './routes/credential-tests.ts';
import { createEventStreamHub, type EventStreamHub, eventRoutes } from './routes/events.ts';
import { publicInvitationRoutes, workspaceInvitationRoutes } from './routes/invitations.ts';
import {
  loginSecondFactorRoutes,
  type MailDeps,
  mailAndTwoFactorRoutes,
  setUpMail,
} from './routes/mail-mount.ts';
import { memberRoutes } from './routes/members.ts';
import { repositoryRoutes } from './routes/repositories.ts';
import { settingsRoutes } from './routes/settings.ts';
import { stepUpRoutes } from './routes/step-up.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { type WebhookRoutesContext, webhookRoutes } from './routes/webhooks.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  defaultStoreConnectorFactory,
  type StoreConnectorFactory,
} from './services/apps.ts';
import {
  type CloneUpkeep,
  createCloneUpkeep,
  DEFAULT_CLONE_IDLE_DAYS,
  DEFAULT_CLONE_MAX_BYTES,
} from './services/clone-upkeep.ts';
import { createTestLimiter, type TestLimiter } from './services/credential-tests.ts';
import type { LocalWriteConfig } from './services/local-reads.ts';
import { setMailLinkOrigin } from './services/mail-template.ts';
import type { CloneReads, ConnectorFactory } from './services/repositories.ts';
import { DEFAULT_REPO_TIMEOUT_MS, defaultConnectorFactory } from './services/repositories.ts';
import { enableStepUpAutoApprove } from './services/step-up.ts';
import type { TranslationContext } from './services/translation.ts';
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
  trustedOrigins?: string[] | undefined;
  /** KILN_PUBLIC_ORIGIN: the origin passkeys are bound to (step-up confirmation). Default: the origin of the request. */
  publicOrigin?: string | undefined;
  /** Demo mode only: hard actions pass the step-up check, because nobody is there to confirm them. */
  stepUpAutoApprove?: boolean | undefined;
  /** Email (SMTP) and two-factor codes (docs/api/mail.md). `env` is KILN_SMTP_*; tests pass `mailer`. All optional. */
  mail?: MailDeps | undefined;
  /** Overridable for tests. */
  now?: (() => number) | undefined;
  cost?: Services['cost'] | undefined;
  limiter?: Services['limiter'] | undefined;
  /** Failed logins per client address. Default: 30 per 15 minutes, looser than the per-email limit. */
  ipLimiter?: Services['ipLimiter'] | undefined;
  /** Bad attempts per invitation link. Its own instance, never the login limiter. */
  inviteLimiter?: Services['inviteLimiter'] | undefined;
  /** Believe X-Forwarded-For for the client address (KILN_TRUST_PROXY=1). Default: no. */
  trustProxy?: boolean | undefined;
  /** Folder with the built web UI, relative to the working directory. Omit to serve the API only. */
  webDist?: string | undefined;
  /**
   * Turns on single-user mode (desktop). `port` is the port the server listens on, for the Host
   * check. `extraHosts` are further exact Host values (loopback with a port), for a dev server.
   * Omit `singleUser` for the normal multi-user server.
   */
  singleUser?: { launchSecret: string; port: number; extraHosts?: string[] } | undefined;
  /** Overridable for tests: the verifiers, their fetch, the timeout and the rate limit of "test connection". */
  credentialTests?: CredentialTestDeps | undefined;
  /**
   * Builds the repository connector from a stored credential: `(kind, secret, { owner, repo })`.
   * Overridable for tests; the default is the real GitHub connector.
   */
  connectorFactory?: ConnectorFactory | undefined;
  /** Longest a synchronous repository job (scan, listing, apply) may run. Default 90 seconds. */
  repositoryTimeoutMs?: number | undefined;
  /**
   * Local clones for scan and listing reads (KILN_READS, docs/adr/0005-local-clone-reads.md).
   * Built at start by `setUpReads`. Omitted: reads go through the GitHub API.
   */
  reads?: CloneReads | undefined;
  /**
   * Upkeep of the clone folder (limits, pruning, the clones route): built in index.ts, which also
   * hands it to the scheduler's sweep. Omitted: one with the defaults (2 GiB, 30 days) is made when
   * `reads` is set, so the routes work; it sweeps nothing until something calls `sweep`.
   */
  cloneUpkeep?: CloneUpkeep | undefined;
  /** Writing to local clones: KILN_LOCAL_REPO_WRITE, the commit author, and (tests) where a push goes. Omitted: off. */
  localWrite?: LocalWriteConfig | undefined;
  /**
   * Store sync of apps. `connectorFactory` builds the read-only App Store Connect / Google Play
   * connector from a stored credential (overridable for tests), `timeoutMs` is the longest one
   * sync may run (default 60 seconds), `limiter` defaults to 10 syncs per workspace per minute.
   */
  appSync?: {
    connectorFactory?: StoreConnectorFactory;
    timeoutMs?: number;
    limiter?: TestLimiter;
    /** KILN_SYNC_INTERVAL_MINUTES (the scheduler is built in index.ts): only told to the Settings screen. 0 is off; default 30. */
    intervalMinutes?: number;
  };
  /** API token requests: the per-token rate limit (default 300 a minute) and the bad-token limit. Overridable for tests. */
  tokens?: BearerOptions | undefined;
  /**
   * The open event streams. index.ts makes one so it can end them at shutdown (`closeAll`); omitted,
   * the app has a private one. Streams are capped per person.
   */
  eventStreams?: EventStreamHub | undefined;
  /**
   * Outbound webhooks. `allowPrivate` is KILN_WEBHOOKS_ALLOW_PRIVATE=1 (loopback and private
   * addresses, and http to localhost); `resolve` and `send` are for tests. The delivery job itself
   * is registered in index.ts with the same options.
   */
  webhooks?:
    | Pick<WebhookRoutesContext, 'allowPrivate' | 'resolve' | 'send' | 'limiter'>
    | undefined;
  /**
   * Chat destinations (Slack, Teams; docs/api/chat-integrations.md). `allowPrivate` falls back to the webhooks' setting
   * (KILN_WEBHOOKS_ALLOW_PRIVATE); `resolve`, `send` and `limiter` are for tests. The delivery job is registered in index.ts.
   */
  chat?: ChatDeps | undefined;
  /**
   * CI runs and build linking (docs/api/ci.md). Uses `connectorFactory` and `repositoryTimeoutMs`.
   * `limiter` is the per workspace limit of dispatches (default 10 per minute), `matchers` the
   * build number conventions, `pollMaxMs` how long `ci.poll` follows a run. All optional.
   */
  ci?: Partial<Pick<CiContext, 'limiter' | 'activeLimiter' | 'matchers' | 'pollMaxMs'>> | undefined;
  /**
   * Builds to test (docs/api/builds.md): listing CI artifacts always works; downloading them, and the links that hand one to a phone,
   * answer `409 builds_download_disabled` unless `downloadEnabled` (KILN_BUILDS_DOWNLOAD_ENABLED, default false). Uploading an Android build
   * to Google Play internal app sharing (docs/api/internal-sharing.md) is off unless `internalSharingEnabled` (KILN_PLAY_INTERNAL_SHARING_ENABLED).
   */
  builds?: BuildsDeps | undefined;
  /**
   * The scheduled listing read (KILN_LISTING_INTERVAL_MINUTES) in milliseconds, 0 or absent for off.
   * Only used to tell the Listing tab when the next read is due; the scheduler is built in index.ts.
   */
  listing?: ListingDeps['listing'] | undefined;
  /**
   * Media files of the repositories and app icons (docs/api/assets.md). `limiter` is the per
   * workspace limit of index reads that miss the cache (default 30 a minute); `icons` holds the
   * seams of the App Store icon lookup (`limiter`: lookups per workspace, `net`: resolver,
   * exchange and allowPrivate, for tests and development). All optional.
   */
  assets?: ListingDeps['assets'] | undefined;
  /**
   * Two way sync of graphics (docs/api/assets.md): `net` is the exchange and address check of the downloads from a store's CDN
   * (fakes in tests), the limiters are per workspace (store reads, CDN fetches, uploads). All optional.
   */
  assetSync?: ListingDeps['assetSync'] | undefined;
  /** Customer reviews (docs/api/reviews.md): see `ReviewsDeps` in modules/reviews. */
  reviews?: ReviewsDeps | undefined;
  /** Expo Application Services (docs/adr/0033-eas-integration.md): see `EasDeps` in modules/eas. */
  eas?: EasDeps | undefined;
  /** In-app purchases and subscriptions (docs/adr/0034-in-app-products.md): see `MonetizationDeps` in modules/monetization. */
  monetization?: MonetizationDeps | undefined;
  /** Store experiments and custom product pages (docs/adr/0048-store-experiments.md): see `ExperimentsDeps` in modules/experiments. */
  experiments?: ExperimentsDeps | undefined;
  /** RevenueCat next to the store products (docs/adr/0039-revenuecat.md): see `RevenueCatDeps` in modules/revenuecat. */
  revenuecat?: RevenueCatDeps | undefined;
  /**
   * Changing a live rollout in a store (docs/api/rollout.md), a store write that is OFF unless `enabled`
   * (KILN_STORE_ROLLOUT_ENABLED). `connectorFactory` builds the connector that can read and change a
   * rollout (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  rollout?: PublishDeps['rollout'] | undefined;
  /**
   * Staged listing text and graphics, and writing them to the store as a DRAFT (docs/api/staged-changes.md):
   * a store write that is OFF unless `enabled` (KILN_STORE_DRAFT_WRITE_ENABLED). `connectorFactory` builds the
   * connector that can read and write a draft (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  storeDraft?: PublishDeps['draft'] | undefined;
  /**
   * Submitting the store's draft for review (docs/api/submit.md, docs/adr/0010-store-submit.md): a store write that
   * is OFF unless `enabled` (KILN_STORE_SUBMIT_ENABLED). `connectorFactory` builds the connector that can read and
   * submit (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  storeSubmit?: PublishDeps['submit'] | undefined;
  /**
   * Releasing (docs/api/releases-write.md, docs/adr/0014-release-management.md): releasing an approved App Store version or
   * starting a Google Play draft release is a store write that is OFF unless `enabled` (KILN_STORE_RELEASE_ENABLED).
   * `connectorFactory` builds the connector that can read and release (fakes in tests); `timeoutMs` and `claimTtlMs` are for
   * tests. The reads of builds and version codes use the draft connector (`storeDraft.connectorFactory`) and no switch.
   */
  storeRelease?: PublishDeps['release'] | undefined;
  /**
   * Creating the next App Store version (docs/api/store-version.md): a reversible store write behind the SAME switch as the draft
   * push (`storeDraft.enabled`, KILN_STORE_DRAFT_WRITE_ENABLED) and its timeouts. Only `connectorFactory` (fakes in tests) is set here.
   */
  storeVersion?: PublishDeps['version'] | undefined;
  /**
   * Publishing everything an app has pending in one go (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md): a store write
   * that is OFF unless `enabled` (KILN_STORE_PUBLISH_BATCH_ENABLED). It turns no step on: the steps keep the switches, the fakes and the
   * timeouts of `storeDraft`, `storeSubmit`, `storeRelease` and `rollout`. `claimTtlMs` is for tests.
   */
  storePublish?: PublishDeps['publish'] | undefined;
  /** ASO (docs/api/aso.md): see `AsoDeps` in modules/aso. */
  aso?: AsoDeps | undefined;
  /** Analytics (docs/api/analytics.md): see `AnalyticsDeps` in modules/analytics. */
  analytics?: AnalyticsDeps | undefined;
  /**
   * Translation of reviews and the workspace settings (docs/api/settings.md, docs/api/reviews.md).
   * `allowPrivateUrls` is KILN_TRANSLATE_ALLOW_PRIVATE_URLS (a private or loopback LibreTranslate
   * address); `fetch`, `resolve`, `exchange` and `timeoutMs` replace the network in tests;
   * `limiter` is the per workspace budget of translation requests (default 20 a minute).
   */
  translation?: Pick<
    TranslationContext,
    'allowPrivateUrls' | 'fetch' | 'resolve' | 'exchange' | 'timeoutMs'
  > & {
    limiter?: TestLimiter;
    /** Requests of "translate the release notes" per workspace per minute (default 10). It uses the translation seams above and `ai`. */
    notesLimiter?: TestLimiter;
  };
  /**
   * AI assistance (docs/api/ai.md). `enabled` is KILN_AI_ENABLED (default false: no provider is ever contacted), `allowPrivateUrls` is
   * KILN_AI_ALLOW_PRIVATE_URLS. `fetch` replaces the network for Anthropic and OpenAI, `resolve` and `exchange` for an OpenAI compatible
   * server, `clientFactory` hands in a whole client (tests use a fake). `limiter` is the per workspace budget of runs a minute.
   */
  ai?: AiSettings | undefined;
  /** The MCP endpoint for AI assistants (docs/mcp.md). `enabled` is KILN_MCP_ENABLED (default false: POST /mcp answers 404). */
  mcp?: McpDeps | undefined;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  // The address the buttons in emails open (KILN_PUBLIC_ORIGIN); without it emails name the screen and have no link.
  setMailLinkOrigin(deps.publicOrigin);
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

  if (deps.stepUpAutoApprove) enableStepUpAutoApprove(deps.db);

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
  // The analytics import takes a report file as the request body: its routes have their own limit (10 MiB), everything else keeps 1 MiB.
  const apiLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge });
  app.use('/api/*', (c, next) =>
    analyticsImportPath.test(c.req.path) ? next() : apiLimit(c, next),
  );

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
  const mail = setUpMail(services, deps.mail);
  if (!deps.singleUser) app.route('/api/auth', loginSecondFactorRoutes(mail, services));
  app.use('/api/me', requireUser(services));
  app.route('/api/me', meRoute(services));
  app.route('/api/me', meLocaleRoute(services));
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
  app.route(
    '/api/workspaces',
    credentialTestRoutes(services, { ...deps.credentialTests, translate: translationSeams }),
  );
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
  // CI: workflows, dispatch and runs of a repository, and the builds of an app linked to them.
  const ciContext = createCiContext(
    {
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
      timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
    },
    deps.ci,
  );
  const appSyncLimiter = deps.appSync?.limiter ?? createTestLimiter({ now: services.now });
  // The repository context of the media files and listing reads, and the budget of the Assets tab: shared by the listing module and the staged routes.
  const assetsRepo = {
    db: services.db,
    masterKey: services.masterKey,
    now: services.now,
    connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
    timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
    reads: deps.reads,
  };
  const assetsLimiter = deps.assets?.limiter ?? createTestLimiter({ limit: 30, now: services.now });
  const shared: ModuleShared = {
    repo: assetsRepo,
    apps: appsContext,
    assetsLimiter,
    ci: ciContext,
    translation: translationSeams,
    appSyncLimiter,
    translationLimiter: deps.translation?.limiter,
  };
  app.route('/api/workspaces', appRoutes({ ...appsContext, limiter: appSyncLimiter }));
  app.route('/api/workspaces', mailAndTwoFactorRoutes(mail, services));
  app.route(
    '/api/workspaces',
    stepUpRoutes({
      services,
      ...(deps.publicOrigin ? { publicOrigin: deps.publicOrigin } : {}),
      ...(deps.trustedOrigins ? { trustedOrigins: deps.trustedOrigins } : {}),
    }),
  );
  // Workspace settings (any member reads, admins write) and the translation of stored reviews.
  app.route(
    '/api/workspaces',
    settingsRoutes({
      db: services.db,
      now: services.now,
      ...(deps.appSync?.intervalMinutes !== undefined
        ? { syncIntervalMinutes: deps.appSync.intervalMinutes }
        : {}),
      ...(translationSeams.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
      ...(translationSeams.resolve ? { resolve: translationSeams.resolve } : {}),
    }),
  );
  alertsModule.mount(app, services, undefined, shared);
  chatModule.mount(
    app,
    services,
    { allowPrivate: deps.webhooks?.allowPrivate, ...deps.chat },
    shared,
  );
  listingModule.mount(
    app,
    services,
    {
      listing: deps.listing,
      assets: deps.assets,
      assetSync: deps.assetSync,
      draft: deps.storeDraft,
    },
    shared,
  );
  ciModule.mount(app, services, undefined, shared);
  buildsModule.mount(app, services, deps.builds, shared);
  asoModule.mount(app, services, deps.aso, shared);
  analyticsModule.mount(app, services, deps.analytics, shared);
  reviewsModule.mount(app, services, deps.reviews, shared);
  easModule.mount(app, services, deps.eas, shared);
  // The products sync runs the RevenueCat read as its second step, so the monetization module gets the RevenueCat seams too.
  monetizationModule.mount(
    app,
    services,
    { ...deps.monetization, revenueCat: deps.revenuecat },
    shared,
  );
  experimentsModule.mount(app, services, deps.experiments, shared);
  revenuecatModule.mount(app, services, deps.revenuecat, shared);
  publishModule.mount(
    app,
    services,
    {
      rollout: deps.rollout,
      draft: deps.storeDraft,
      submit: deps.storeSubmit,
      release: deps.storeRelease,
      version: deps.storeVersion,
      publish: deps.storePublish,
    },
    shared,
  );
  planningModule.mount(app, services, undefined, shared);
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
  aiModule.mount(
    app,
    services,
    {
      settings: deps.ai,
      notesLimiter: deps.translation?.notesLimiter,
      asoLimits: asoLimitsFor(deps.aso),
      reply: {
        enabled: deps.reviews?.reply?.enabled ?? false,
        connectorFactory: deps.reviews?.reply?.connectorFactory ?? defaultReplyConnectorFactory,
      },
    },
    shared,
  );
  // Public: the person with the link is not signed in yet.
  app.route('/api/invitations', publicInvitationRoutes(services));

  // MCP: POST /mcp for AI assistants (off unless KILN_MCP_ENABLED) and its status for Settings. Store writes are previewed, never applied. docs/adr/0023-mcp-server.md
  mountMcp(app, {
    services,
    deps: deps.mcp,
    version: deps.version,
    publicOrigin: deps.publicOrigin,
    trustedOrigins: deps.trustedOrigins,
    flags: {
      reviewReply: deps.reviews?.reply?.enabled === true,
      storeRollout: deps.rollout?.enabled === true,
      storeDraft: deps.storeDraft?.enabled === true,
      storeSubmit: deps.storeSubmit?.enabled === true,
      storeRelease: deps.storeRelease?.enabled === true,
      storePublish: deps.storePublish?.enabled === true,
      internalSharing: deps.builds?.internalSharingEnabled === true,
    },
  });

  const openApiDocument = buildOpenApiDocument(operations, { version: deps.version });
  app.get('/api/openapi.json', (c) => c.json(openApiDocument));

  // Anything else under /api is an unknown route, not a page.
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  if (deps.webDist) {
    const root =
      deps.webDist.startsWith('.') || deps.webDist.startsWith('/')
        ? deps.webDist
        : `./${deps.webDist}`;
    app.use('/*', serveStatic({ root }));
    // Single-page app: unknown paths load the shell and the client router takes over.
    app.get('*', serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
