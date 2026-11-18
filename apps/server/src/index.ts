import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createDatabase, migrate } from '@mrm/db';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createWorker } from './jobs.ts';
import { createEventStreamHub } from './routes/events.ts';
import { createScheduler, syncIntervalMs } from './scheduler.ts';
import {
  APP_SYNC_QUEUE,
  DEFAULT_SYNC_TIMEOUT_MS,
  createAppSyncHandler,
  defaultStoreConnectorFactory,
} from './services/apps.ts';
import { pruneSessions } from './services/accounts.ts';
import { CI_POLL_QUEUE, createCiContext, createCiPollHandler } from './services/ci.ts';
import { setUpReads } from './services/clone-reads.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { pruneEvents } from './services/events.ts';
import { WEBHOOK_QUEUE, createWebhookHandler, pruneDeliveries } from './services/webhooks.ts';
import { DEFAULT_REPO_TIMEOUT_MS, defaultConnectorFactory } from './services/repositories.ts';
import { VERSION } from './version.ts';

const config = loadConfig();

await mkdir(config.dataDir, { recursive: true });
const database = await createDatabase(config.databaseUrl);
let applied: number[];
try {
  applied = await migrate(database);
} catch (error) {
  const where = config.databaseUrl.replace(/\/\/[^@/]*@/, '//***@');
  const code = (error as { code?: string }).code;
  console.error(`Cannot use the database at ${where}${code ? ` (${code})` : ''}.`);
  console.error(
    code === 'ECONNREFUSED'
      ? 'Nothing is listening there. Start Postgres, or remove DATABASE_URL from .env to use SQLite.'
      : String(error),
  );
  process.exit(1);
}
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);
await pruneSessions(database, Date.now());
await pruneEvents(database, Date.now());
await pruneDeliveries(database, Date.now());

const webDist = existsSync(config.webDist) ? config.webDist : undefined;
if (!webDist) {
  console.warn(`No web UI at ${config.webDist}. Serving the API only. Run: pnpm build`);
}

const reads = await setUpReads({
  mode: config.reads,
  cloneDir: config.cloneDir,
  ttlMs: config.cloneTtlMs,
  gitPath: config.gitPath,
  // Local clones (docs/adr/0005-local-clone-reads.md): off unless MRM_LOCAL_REPO_ROOTS names folders.
  local: { roots: config.localRepoRoots, excluded: [config.dataDir, config.cloneDir] },
});
if (config.localRepoRoots.length > 0) {
  console.log(`Local clones: allowed in ${config.localRepoRoots.join(', ')}`);
}

// One budget for manual and scheduled syncs (10 per workspace per minute).
const syncLimiter = createTestLimiter();

// Open event streams, so shutdown can end them (they would keep the server from closing).
const eventStreams = createEventStreamHub();

const app = createApp({
  db: database,
  eventStreams,
  webhooks: { allowPrivate: config.webhooksAllowPrivate },
  appSync: { limiter: syncLimiter },
  reads,
  masterKey: config.masterKey,
  version: VERSION,
  webDist,
  trustedOrigins: config.trustedOrigins,
  trustProxy: config.trustProxy,
  singleUser: config.mode === 'single_user' && config.launchSecret
    ? { launchSecret: config.launchSecret, port: config.port, extraHosts: config.allowedHosts }
    : undefined,
});

// Job handlers register here as features add them (repo scans).
const worker = createWorker({
  sql: database,
  handlers: {
    [APP_SYNC_QUEUE]: createAppSyncHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      connectorFactory: defaultStoreConnectorFactory,
      timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
    }),
    [WEBHOOK_QUEUE]: createWebhookHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      allowPrivate: config.webhooksAllowPrivate,
    }),
    [CI_POLL_QUEUE]: createCiPollHandler(
      createCiContext({
        db: database,
        masterKey: config.masterKey,
        now: Date.now,
        connectorFactory: defaultConnectorFactory,
        timeoutMs: DEFAULT_REPO_TIMEOUT_MS,
      }),
    ),
  },
});
if (config.worker === 'inline') worker.start();

// Queues scheduled app syncs (when MRM_SYNC_INTERVAL_MINUTES is set) and ci.poll for runs still
// going. It only queues jobs, so it runs where the worker does.
const scheduler = createScheduler({
  db: database,
  syncIntervalMs: syncIntervalMs(config.syncIntervalMinutes),
  limiter: syncLimiter,
});
if (config.worker === 'inline') {
  scheduler.start();
  if (config.syncIntervalMinutes > 0) {
    console.log(`Scheduled sync every ${config.syncIntervalMinutes} minutes`);
  }
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const where = config.host ?? 'localhost';
  console.log(`Mobile Release Manager ${VERSION} on http://${where}:${info.port} (${database.dialect}, ${config.mode})`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  eventStreams.closeAll();
  await scheduler.stop();
  await worker.stop();
  await database.close();
  process.exit(0);
}

// The desktop shell keeps our stdin open. When the shell dies, even by a crash, the pipe closes
// and we stop, so a server never outlives its window. Off unless the shell asks for it.
if (process.env.MRM_EXIT_WITH_PARENT === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => void shutdown('parent exit'));
  process.stdin.on('close', () => void shutdown('parent exit'));
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
