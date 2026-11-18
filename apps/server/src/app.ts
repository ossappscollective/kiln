import { serveStatic } from '@hono/node-server/serve-static';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import { type AppEnv, type Services, sameOrigin } from './http.ts';
import { createLoginLimiter } from './limiter.ts';
import { authRoutes, meRoute, requireUser } from './routes/auth.ts';
import { type CredentialTestDeps, credentialTestRoutes } from './routes/credential-tests.ts';
import { publicInvitationRoutes, workspaceInvitationRoutes } from './routes/invitations.ts';
import { memberRoutes } from './routes/members.ts';
import { repositoryRoutes } from './routes/repositories.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { DEFAULT_REPO_TIMEOUT_MS, defaultConnectorFactory } from './services/repositories.ts';
import type { ConnectorFactory } from './services/repositories.ts';
import { createLaunchGate, hostGuard } from './single-user.ts';

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
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const services: Services = {
    db: deps.db,
    masterKey: deps.masterKey,
    now: deps.now ?? Date.now,
    limiter: deps.limiter ?? createLoginLimiter(),
    cost: deps.cost,
    singleUser: deps.singleUser && { gate: createLaunchGate(deps.singleUser.launchSecret) },
  };

  // First, and on every path including the static UI: a rebound DNS name must get nothing.
  if (deps.singleUser) app.use('*', hostGuard(deps.singleUser.port, deps.singleUser.extraHosts));

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
  app.use('/api/workspaces/*', requireUser(services));
  // Before the other workspace routes, so /credentials/test is never read as a credential id.
  app.route('/api/workspaces', credentialTestRoutes(services, deps.credentialTests));
  app.route('/api/workspaces', workspaceRoutes(services));
  app.route('/api/workspaces', memberRoutes(services));
  app.route('/api/workspaces', workspaceInvitationRoutes(services));
  app.route(
    '/api/workspaces',
    repositoryRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      connectorFactory: deps.connectorFactory ?? defaultConnectorFactory,
      timeoutMs: deps.repositoryTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS,
    }),
  );
  // Public: the person with the link is not signed in yet.
  app.route('/api/invitations', publicInvitationRoutes(services));

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
