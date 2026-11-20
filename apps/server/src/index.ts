import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createDatabase, migrate } from '@mrm/db';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { demoRequested } from './demo/config.ts';
import { createWorker } from './jobs.ts';
import { createAsoSources } from './modules/aso/net.ts';
import { asoIntervalMs } from './modules/aso/schedule.ts';
import {
  ASO_REFRESH_QUEUE,
  type AsoLimits,
  createAsoRefreshHandler,
} from './modules/aso/service.ts';
import { createEventStreamHub } from './routes/events.ts';
import {
  createScheduler,
  releaseWatchIntervalMs,
  reminderIntervalMs,
  syncIntervalMs,
} from './scheduler.ts';
import { pruneSessions } from './services/accounts.ts';
import { createAlertDeliveryHandler } from './services/alert-delivery.ts';
import { ALERT_PASS_INTERVAL_MS, createAlertRunner } from './services/alert-runner.ts';
import { ALERT_QUEUE } from './services/alerts.ts';
import { analyticsIntervalMs } from './modules/analytics/schedule.ts';
import {
  ANALYTICS_SYNC_QUEUE,
  createAnalyticsSyncHandler,
  DEFAULT_ANALYTICS_TIMEOUT_MS,
  defaultAnalyticsConnectors,
} from './modules/analytics/sync.ts';
import {
  APP_SYNC_QUEUE,
  createAppSyncHandler,
  DEFAULT_SYNC_TIMEOUT_MS,
  defaultStoreConnectorFactory,
} from './services/apps.ts';
import { CI_POLL_QUEUE, createCiContext, createCiPollHandler } from './services/ci.ts';
import { checkGit, setUpReads } from './services/clone-reads.ts';
import { createCloneUpkeep } from './services/clone-upkeep.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { pruneEvents } from './services/events.ts';
import {
  createListingReadHandler,
  DEFAULT_LISTING_TIMEOUT_MS,
  LISTING_READ_QUEUE,
  listingIntervalMs,
} from './services/listing-schedule.ts';
import { gitSupportsSshSigning, sshKeyFingerprint } from './services/local-git.ts';
import { parseSmtpEnv } from './services/mail-config.ts';
import { DEFAULT_REPO_TIMEOUT_MS, defaultConnectorFactory } from './services/repositories.ts';
import { reviewSyncIntervalMs } from './modules/reviews/schedule.ts';
import {
  createReviewSyncHandler,
  DEFAULT_REVIEW_TIMEOUT_MS,
  defaultReviewConnectorFactory,
  REVIEW_SYNC_QUEUE,
} from './modules/reviews/sync.ts';
import { createWebhookHandler, pruneDeliveries, WEBHOOK_QUEUE } from './services/webhooks.ts';
import { VERSION } from './version.ts';

// Demo mode (MRM_DEMO=true) is a separate, self-contained server: it never reads the real configuration, database or master key.
if (demoRequested(process.env)) {
  const { runDemo } = await import('./demo/main.ts');
  await runDemo(process.env);
  await new Promise<never>(() => {}); // the demo server keeps running; the normal start-up below is never reached
}

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
if (config.localRepoWrite) {
  console.log(
    config.localRepoRoots.length > 0
      ? 'Local clones: writing is ON (MRM_LOCAL_REPO_WRITE): change sets may be committed to a new branch of a clone.'
      : 'MRM_LOCAL_REPO_WRITE=true has no effect until MRM_LOCAL_REPO_ROOTS names the folders that may hold clones.',
  );
}
// Signing of those commits (MRM_GIT_SIGN). The log says the format and, for ssh, the public
// fingerprint: never the key's path or anything from the key.
if (config.gitSigning) {
  const signing = config.gitSigning;
  const fingerprint =
    signing.format === 'ssh' ? await sshKeyFingerprint(signing.program, signing.key) : undefined;
  console.log(
    `Local clones: signing: ${signing.format}${fingerprint ? ` (key ${fingerprint})` : ''}${config.localRepoWrite ? '' : ' (no effect until MRM_LOCAL_REPO_WRITE=true)'}`,
  );
  if (signing.format === 'ssh') {
    const git = await checkGit(config.gitPath);
    if (git.ok && !gitSupportsSshSigning(git.version)) {
      console.warn(
        `Local clones: git ${git.version} cannot sign with ssh keys (2.34 or later is needed). Signing will fail until git is updated.`,
      );
    }
    if (signing.key.endsWith('.pub') && !signing.sshAuthSock) {
      console.warn(
        'Local clones: the signing key is a .pub file but SSH_AUTH_SOCK is not set for the server, so ssh-agent cannot be used. Signing works only if the private key next to it has no passphrase.',
      );
    }
  }
} else if (process.env.MRM_GIT_SIGNING_KEY?.trim()) {
  console.warn('MRM_GIT_SIGNING_KEY is set but MRM_GIT_SIGN is off: commits are not signed.');
}

// Pruning of the clone folder: idle clones, then the least recently used above the byte limit.
const cloneUpkeep = createCloneUpkeep({
  reads,
  db: database,
  config: { maxBytes: config.cloneMaxBytes, idleDays: config.cloneIdleDays },
});

// One budget for manual and scheduled syncs (10 per workspace per minute).
const syncLimiter = createTestLimiter();

// ASO reads public store data only. One set of sources for the routes and the worker: they share the cache and the rate limits.
const asoLimits: AsoLimits = {
  maxKeywordsPerApp: config.asoMaxKeywordsPerApp,
  maxCompetitorsPerApp: config.asoMaxCompetitorsPerApp,
  maxChecksPerRun: config.asoMaxChecksPerRun,
  rankDepth: config.asoRankDepth,
  heartbeatMs: config.asoHeartbeatMs,
  retentionDays: config.asoRetentionDays,
  intervalMs: asoIntervalMs(config.asoIntervalMinutes),
};
const asoSources = createAsoSources({
  playEnabled: config.asoPlayUnofficialEnabled,
  now: Date.now,
  cacheMs: config.asoCacheMs,
  appleCallsPerMinute: config.asoAppleCallsPerMinute,
  playCallsPerMinute: config.asoPlayCallsPerMinute,
});

// Open event streams, so shutdown can end them (they would keep the server from closing).
const eventStreams = createEventStreamHub();

const app = createApp({
  db: database,
  eventStreams,
  webhooks: { allowPrivate: config.webhooksAllowPrivate },
  appSync: { limiter: syncLimiter, intervalMinutes: config.syncIntervalMinutes },
  listing: { intervalMs: listingIntervalMs(config.listingIntervalMinutes) },
  reviews: {
    limiter: syncLimiter,
    retentionDays: config.reviewRetentionDays,
    reply: { enabled: config.reviewReplyEnabled },
  },
  aso: { sources: asoSources, limits: asoLimits },
  analytics: { intervalMinutes: config.analyticsIntervalMinutes },
  rollout: { enabled: config.storeRolloutEnabled },
  storeDraft: { enabled: config.storeDraftWriteEnabled },
  storeSubmit: { enabled: config.storeSubmitEnabled },
  storeRelease: { enabled: config.storeReleaseEnabled },
  builds: {
    downloadEnabled: config.buildsDownloadEnabled,
    maxDownloadBytes: config.buildsDownloadMaxBytes,
    internalSharingEnabled: config.playInternalSharingEnabled,
  },
  storePublish: { enabled: config.storePublishBatchEnabled },
  translation: { allowPrivateUrls: config.translateAllowPrivateUrls },
  ai: { enabled: config.aiEnabled, allowPrivateUrls: config.aiAllowPrivateUrls },
  mail: { env: parseSmtpEnv(process.env) },
  mcp: { enabled: config.mcpEnabled },
  reads,
  cloneUpkeep,
  localWrite: {
    enabled: config.localRepoWrite,
    ...(config.gitAuthorName ? { authorName: config.gitAuthorName } : {}),
    ...(config.gitAuthorEmail ? { authorEmail: config.gitAuthorEmail } : {}),
    ...(config.gitSigning ? { signing: config.gitSigning } : {}),
  },
  masterKey: config.masterKey,
  version: VERSION,
  webDist,
  trustedOrigins: config.trustedOrigins,
  ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
  trustProxy: config.trustProxy,
  singleUser:
    config.mode === 'single_user' && config.launchSecret
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
    // Scheduled reads of the store listing (queued by the scheduler when MRM_LISTING_INTERVAL_MINUTES is set).
    [LISTING_READ_QUEUE]: createListingReadHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      connectorFactory: defaultStoreConnectorFactory,
      timeoutMs: DEFAULT_LISTING_TIMEOUT_MS,
      intervalMs: listingIntervalMs(config.listingIntervalMinutes),
    }),
    // Scheduled and background reads of customer reviews (read-only; docs/api/reviews.md).
    [REVIEW_SYNC_QUEUE]: createReviewSyncHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      connectorFactory: defaultReviewConnectorFactory,
      timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
      translation: { allowPrivateUrls: config.translateAllowPrivateUrls },
    }),
    // Scheduled and background ASO refreshes (public store data only; docs/api/aso.md).
    [ASO_REFRESH_QUEUE]: createAsoRefreshHandler({
      db: database,
      now: Date.now,
      sources: asoSources,
      limits: asoLimits,
    }),
    // Scheduled and background analytics syncs (read-only toward the stores; docs/api/analytics.md).
    [ANALYTICS_SYNC_QUEUE]: createAnalyticsSyncHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      connectors: defaultAnalyticsConnectors,
      timeoutMs: DEFAULT_ANALYTICS_TIMEOUT_MS,
    }),
    [WEBHOOK_QUEUE]: createWebhookHandler({
      db: database,
      masterKey: config.masterKey,
      now: Date.now,
      allowPrivate: config.webhooksAllowPrivate,
    }),
    // Alert emails (docs/alerts.md): one job per delivery row; the mailer is services/mailer.ts.
    [ALERT_QUEUE]: createAlertDeliveryHandler({ db: database, now: Date.now }),
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
  reminderIntervalMs: reminderIntervalMs(config.reminderIntervalMinutes),
  releaseWatchIntervalMs: releaseWatchIntervalMs(config.releaseWatchIntervalMinutes),
  listingIntervalMs: listingIntervalMs(config.listingIntervalMinutes),
  reviewSyncIntervalMs: reviewSyncIntervalMs(config.reviewSyncIntervalMinutes),
  reviewRetentionDays: config.reviewRetentionDays,
  analyticsIntervalMs: analyticsIntervalMs(config.analyticsIntervalMinutes),
  asoIntervalMs: asoLimits.intervalMs,
  asoPlayEnabled: config.asoPlayUnofficialEnabled,
  asoRetentionDays: config.asoRetentionDays,
  limiter: syncLimiter,
  // State alerts, digests and alert upkeep (services/alert-runner.ts).
  alerts: {
    intervalMs: ALERT_PASS_INTERVAL_MS,
    run: createAlertRunner({
      db: database,
      onError: (message, error) => console.error(message, error),
    }).run,
  },
  ...(config.cloneSweepIntervalMinutes > 0 && reads.active
    ? {
        cloneSweep: {
          intervalMs: config.cloneSweepIntervalMinutes * 60_000,
          run: () => cloneUpkeep.sweep(),
        },
      }
    : {}),
});
if (config.worker === 'inline') {
  scheduler.start();
  if (config.syncIntervalMinutes > 0) {
    console.log(`Scheduled sync every ${config.syncIntervalMinutes} minutes`);
  }
  if (reads.active && config.cloneSweepIntervalMinutes > 0) {
    console.log(
      `Clones: swept every ${config.cloneSweepIntervalMinutes} minutes (idle over ${config.cloneIdleDays === 0 ? 'never' : `${config.cloneIdleDays} days`}, limit ${config.cloneMaxBytes === 0 ? 'none' : `${config.cloneMaxBytes} bytes`})`,
    );
  }
  if (config.listingIntervalMinutes > 0) {
    console.log(
      `Scheduled listing reads every ${config.listingIntervalMinutes} minutes (read-only)`,
    );
  }
  if (config.reviewSyncIntervalMinutes > 0) {
    console.log(
      `Scheduled review reads every ${config.reviewSyncIntervalMinutes} minutes (read-only; reviews kept ${config.reviewRetentionDays === 0 ? 'forever' : `${config.reviewRetentionDays} days`})`,
    );
  }
  if (config.analyticsIntervalMinutes > 0) {
    console.log(
      `Scheduled analytics syncs every ${config.analyticsIntervalMinutes} minutes (read-only; only for workspaces that turn on the setting analytics.enabled)`,
    );
  }
  if (config.asoIntervalMinutes > 0) {
    console.log(
      `Scheduled ASO refreshes every ${config.asoIntervalMinutes} minutes (public store data, read-only; kept ${config.asoRetentionDays === 0 ? 'forever' : `${config.asoRetentionDays} days`})`,
    );
  }
  if (config.asoPlayUnofficialEnabled) {
    console.warn(
      'ASO for Google Play is ON (MRM_ASO_PLAY_UNOFFICIAL_ENABLED): the public pages of play.google.com are read. This is unofficial and may be against the Google Play Terms of Service; read docs/api/aso.md.',
    );
  }
  if (config.aiEnabled) {
    console.log(
      'AI assistance is ON (MRM_AI_ENABLED): workspaces that turn it on send the data listed for a task to their chosen AI provider; it only makes suggestions a person accepts',
    );
  }
  if (config.reviewReplyEnabled) {
    console.log(
      'Replying to customer reviews is ON (MRM_REVIEW_REPLY_ENABLED): owners and admins can publish replies in the stores',
    );
  }
  if (config.storeRolloutEnabled) {
    console.log(
      'Changing store rollouts is ON (MRM_STORE_ROLLOUT_ENABLED): owners and admins can change a live rollout in the stores',
    );
  }
  if (config.storeDraftWriteEnabled) {
    console.log(
      'Writing store drafts is ON (MRM_STORE_DRAFT_WRITE_ENABLED): owners and admins can push staged listing text and graphics to the stores as a draft (never submitted)',
    );
  }
  if (config.storeSubmitEnabled) {
    console.log(
      'Submitting for store review is ON (MRM_STORE_SUBMIT_ENABLED): owners and admins can submit a pushed draft to App Review or send it to Google Play review (not recallable from here; never releases)',
    );
  }
  if (config.storeReleaseEnabled) {
    console.log(
      'Releasing is ON (MRM_STORE_RELEASE_ENABLED): owners and admins can release an approved App Store version or start a Google Play draft release at a share of users (not recallable from here)',
    );
  }
  if (config.buildsDownloadEnabled) {
    console.log(
      'Build downloads are ON (MRM_BUILDS_DOWNLOAD_ENABLED): members can download CI artifacts through this server and hand one to a phone with a 10 minute single use link',
    );
  }
  if (config.playInternalSharingEnabled) {
    console.log(
      'Google Play internal app sharing is ON (MRM_PLAY_INTERNAL_SHARING_ENABLED): owners and admins can upload a build from a CI artifact to Google and get an install link (the upload cannot be deleted from here; nothing is published to users)',
    );
  }
  if (config.storePublishBatchEnabled) {
    console.log(
      'The batch publish is ON (MRM_STORE_PUBLISH_BATCH_ENABLED): owners and admins can run several gated store steps with one confirmation; every step still needs its own switch and right',
    );
  }
  if (config.reminderIntervalMinutes > 0) {
    console.log(`Plan reminders every ${config.reminderIntervalMinutes} minutes (events only)`);
  }
  if (config.releaseWatchIntervalMinutes > 0) {
    console.log(
      `Release watch every ${config.releaseWatchIntervalMinutes} minutes (stalled releases, unanswered reviews; events only)`,
    );
  }
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const where = config.host ?? 'localhost';
  console.log(
    `Mobile Release Manager ${VERSION} on http://${where}:${info.port} (${database.dialect}, ${config.mode})`,
  );
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
