import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createDatabase, migrate } from '@mrm/db';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createWorker } from './jobs.ts';
import { pruneSessions } from './services/accounts.ts';
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

const webDist = existsSync(config.webDist) ? config.webDist : undefined;
if (!webDist) {
  console.warn(`No web UI at ${config.webDist}. Serving the API only. Run: pnpm build`);
}

const app = createApp({
  db: database,
  masterKey: config.masterKey,
  version: VERSION,
  webDist,
  trustedOrigins: config.trustedOrigins,
  singleUser: config.mode === 'single_user' && config.launchSecret
    ? { launchSecret: config.launchSecret, port: config.port, extraHosts: config.allowedHosts }
    : undefined,
});

// Job handlers register here as features add them (store syncs, repo scans).
const worker = createWorker({ sql: database, handlers: {} });
if (config.worker === 'inline') worker.start();

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
