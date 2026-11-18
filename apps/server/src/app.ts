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
import { ciRoutes } from './routes/ci.ts';
import { type CredentialTestDeps, credentialTestRoutes } from './routes/credential-tests.ts';
import { publicInvitationRoutes, workspaceInvitationRoutes } from './routes/invitations.ts';
import { listingRoutes } from './routes/listing.ts';
import { type EventStreamHub, createEventStreamHub, eventRoutes } from './routes/events.ts';
import { memberRoutes } from './routes/members.ts';
import { planRoutes } from './routes/plans.ts';
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
import { operations } from './services/api-operations.ts';
import { createTestLimiter, type TestLimiter } from './services/credential-tests.ts';
import { buildOpenApiDocument } from './services/openapi.ts';
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
  ci?: Partial<Pick<CiContext, 'limiter' | 'matchers' | 'pollMaxMs'>>;
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
  app.route('/api/workspaces', credentialTestRoutes(services, deps.credentialTests));
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
  app.route(
    '/api/workspaces',
    repositoryRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
      timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
      reads: deps.reads,
      localWrite: deps.localWrite,
    }),
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
