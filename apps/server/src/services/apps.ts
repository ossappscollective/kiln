import { randomUUID } from 'node:crypto';
import {
  type ActorType,
  type Platform,
  type ReleaseState,
  isApplePlatform,
  isGooglePlatform,
  platformLabel,
} from '@mrm/core';
import {
  AppStoreConnectConnector,
  GooglePlayConnector,
  isPlayPackageName,
  redactSecrets,
  secretStrings,
  StoreError,
  StoreRateLimitError,
  type StoreBuild,
  type StoreConnector,
  type StoreVersion,
} from '@mrm/connectors';
import type { Database, Sql } from '@mrm/db';
import { deleteAsoData } from './aso-data.ts';
import { deleteAiData } from './ai-suggestions.ts';
import { recordAudit } from './audit.ts';
import { recordSyncEvents, releaseStatusChanges } from './events.ts';
import { useCredentialSecret } from './credentials.ts';
import { recordAppliedChangeSets } from './listing-repo.ts';
import { deleteListingData, syncListing } from './listing-live.ts';
import { deleteAppIcon } from './app-icon-store.ts';
import { deleteReviewData } from './reviews.ts';
import { type Failure, type Outcome, failure } from './repositories.ts';
import { enqueue, type JobHandler } from '../jobs.ts';

type Actor = { type: ActorType; id: string };
type Row = Record<string, unknown>;

export const APP_SYNC_QUEUE = 'app.sync';
export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;
const MAX_ERROR_LENGTH = 500;

/** The credential kind each platform needs. */
export const credentialKindFor = {
  ios: 'app_store_connect',
  macos: 'app_store_connect',
  android: 'google_play',
} as const satisfies Record<Platform, string>;

// ---------------------------------------------------------------------------------------------
// Connectors

export type StoreConnectorInput = {
  kind: 'app_store_connect' | 'google_play';
  /** The decrypted credential. Never log it or put it in a message. */
  secret: string;
  /** The bundle id or package name. */
  identifier: string;
  /** The platform of the app record: macOS reads the macOS versions and builds of the App Store Connect app. */
  platform?: Platform;
  /** Aborted when the sync times out. Pass it to the connector as its `fetch`. */
  fetch: typeof fetch;
};

/** Builds the read-only store connector for one app. Replaced by a fake in tests. */
export type StoreConnectorFactory = (input: StoreConnectorInput) => StoreConnector;

export const defaultStoreConnectorFactory: StoreConnectorFactory = (input) =>
  input.kind === 'app_store_connect'
    ? AppStoreConnectConnector.fromSecret(input.secret, { fetch: input.fetch, platform: input.platform === 'macos' ? 'macos' : 'ios' })
    : new GooglePlayConnector({
        serviceAccount: input.secret,
        packages: [input.identifier],
        fetch: input.fetch,
      });

/** What the sync services need. Built once in createApp (and in index.ts for the worker). */
export type AppsContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  connectorFactory: StoreConnectorFactory;
  /** Longest one sync may take. Default 60 seconds. */
  timeoutMs: number;
};

// ---------------------------------------------------------------------------------------------
// Rows

export type ManagedApp = {
  id: string;
  name: string;
  platform: Platform;
  identifier: string;
  storeAppId: string | null;
  credentialId: string;
  repositoryId: string | null;
  createdAt: number;
  lastSyncedAt: number | null;
  lastSyncAttemptAt: number | null;
  lastSyncError: string | null;
  /**
   * Whether the tool holds an icon for the app right now (app-icons.ts). A hint for the UI, not a
   * promise: `GET .../icon` is the truth.
   */
  hasIcon: boolean;
  /**
   * The URL to show the icon from, or null when the last look found none and the next look is
   * not due (so the UI does not ask for nothing). Ends in `?v=<etag>` when an icon is held.
   */
  iconUrl: string | null;
};

export type AppRelease = {
  id: string;
  appId: string;
  platform: Platform;
  version: string;
  track: string | null;
  build: string | null;
  status: ReleaseState | null;
  rawState: string;
  rolloutFraction: number | null;
  versionCodes: string[] | null;
  storeUpdatedAt: number | null;
  syncedAt: number;
};

const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null =>
  v === null || v === undefined ? null : f(v);

const toApp = (r: Row): ManagedApp => ({
  id: String(r.id),
  name: String(r.name),
  platform: String(r.platform) as Platform,
  identifier: String(r.identifier),
  storeAppId: orNull(r.store_app_id, String),
  credentialId: String(r.credential_id),
  repositoryId: orNull(r.repository_id, String),
  createdAt: Number(r.created_at),
  lastSyncedAt: orNull(r.last_synced_at, Number),
  lastSyncAttemptAt: orNull(r.last_sync_attempt_at, Number),
  lastSyncError: orNull(r.last_sync_error, String),
  ...iconHint(r),
});

/** The icon hint of an app row joined with its app_icons row (the columns of APP_COLUMNS). */
function iconHint(r: Row): { hasIcon: boolean; iconUrl: string | null } {
  const base = `/api/workspaces/${String(r.workspace_id)}/apps/${String(r.id)}/icon`;
  if (r.icon_has !== null && r.icon_has !== undefined && Number(r.icon_has) === 1) {
    return { hasIcon: true, iconUrl: r.icon_etag ? `${base}?v=${encodeURIComponent(String(r.icon_etag))}` : base };
  }
  // No row: a look has not happened yet. A row without an image: look again only when its backoff is over.
  const waiting = r.icon_backoff !== null && r.icon_backoff !== undefined && Number(r.icon_backoff) > Date.now();
  return { hasIcon: false, iconUrl: r.icon_checked === null || r.icon_checked === undefined || !waiting ? base : null };
}

type Details = { versionCodes?: string[]; rolloutFraction?: number };

const parseDetails = (raw: unknown): Details => {
  if (typeof raw !== 'string') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Details) : {};
  } catch {
    return {};
  }
};

const toRelease = (r: Row): AppRelease => {
  const details = parseDetails(r.details_json);
  return {
    id: String(r.id),
    appId: String(r.app_id),
    platform: String(r.platform) as Platform,
    version: String(r.version),
    track: String(r.track ?? '') === '' ? null : String(r.track),
    build: orNull(r.build, String),
    status: orNull(r.status, String) as ReleaseState | null,
    rawState: String(r.raw_state),
    rolloutFraction: typeof details.rolloutFraction === 'number' ? details.rolloutFraction : null,
    versionCodes: Array.isArray(details.versionCodes) ? details.versionCodes.map(String) : null,
    storeUpdatedAt: orNull(r.store_updated_at, Number),
    syncedAt: Number(r.synced_at),
  };
};

// The repository id reads null when that repository has been disconnected since.
const APP_COLUMNS = `a.id, a.name, a.platform, a.identifier, a.store_app_id, a.credential_id,
  (SELECT r.id FROM repositories r WHERE r.id = a.repository_id AND r.workspace_id = a.workspace_id)
    AS repository_id,
  a.created_at, a.last_synced_at, a.last_sync_attempt_at, a.last_sync_error, a.workspace_id,
  CASE WHEN i.data IS NULL THEN 0 ELSE 1 END AS icon_has, i.etag AS icon_etag,
  i.backoff_until AS icon_backoff, i.checked_at AS icon_checked`;
const APP_FROM = `apps a LEFT JOIN app_icons i ON i.app_id = a.id AND i.workspace_id = a.workspace_id`;

export async function listApps(sql: Sql, workspaceId: string): Promise<ManagedApp[]> {
  const rows = await sql.query(
    `SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.workspace_id = ? ORDER BY a.created_at, a.id`,
    [workspaceId],
  );
  return rows.map(toApp);
}

export async function getApp(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<ManagedApp | undefined> {
  const [row] = await sql.query(
    `SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.id = ? AND a.workspace_id = ?`,
    [id, workspaceId],
  );
  return row ? toApp(row) : undefined;
}

export async function listAppReleases(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppRelease[]> {
  const rows = await sql.query(
    `SELECT id, app_id, platform, version, track, build, status, raw_state, details_json,
            store_updated_at, synced_at
       FROM app_releases WHERE app_id = ? AND workspace_id = ? ORDER BY track, version, id`,
    [appId, workspaceId],
  );
  return rows.map(toRelease);
}

// ---------------------------------------------------------------------------------------------
// Add and remove

export type RegisterInput = {
  workspaceId: string;
  platform: Platform;
  identifier: string;
  credentialId: string;
  name?: string | undefined;
  repositoryId?: string | undefined;
};

/** Rules for the identifier, shared with the route. Returns a message, or undefined when fine. */
export function checkIdentifier(platform: Platform, identifier: string): string | undefined {
  if (isGooglePlatform(platform)) {
    return isPlayPackageName(identifier)
      ? undefined
      : 'Not an Android package name. Use the application id, for example com.acme.app.';
  }
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/.test(identifier)
    ? undefined
    : 'Not a bundle id. Use letters, digits, dots and hyphens, for example com.acme.app.';
}

export async function registerApp(
  ctx: AppsContext,
  input: RegisterInput,
  actor: Actor,
): Promise<Outcome<{ app: ManagedApp }>> {
  const { db } = ctx;
  const [credential] = await db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [input.credentialId, input.workspaceId],
  );
  if (!credential) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist in this workspace (it may have been deleted).',
    );
  }
  const needed = credentialKindFor[input.platform];
  if (String(credential.kind) !== needed) {
    return failure(
      422,
      'credential_kind',
      isApplePlatform(input.platform)
        ? `${platformLabel(input.platform)} apps need an App Store Connect API key credential.`
        : 'An Android app needs a Google Play service account credential.',
    );
  }
  if (input.repositoryId !== undefined) {
    const [repository] = await db.query(
      'SELECT id FROM repositories WHERE id = ? AND workspace_id = ?',
      [input.repositoryId, input.workspaceId],
    );
    if (!repository) {
      return failure(422, 'repository_not_found', 'That repository is not connected in this workspace.');
    }
  }

  // Apple bundle ids are not case sensitive; Play package names are.
  const taken = async () => {
    const rows =
      isApplePlatform(input.platform)
        ? await db.query(
            'SELECT id FROM apps WHERE workspace_id = ? AND platform = ? AND lower(identifier) = ?',
            [input.workspaceId, input.platform, input.identifier.toLowerCase()],
          )
        : await db.query(
            'SELECT id FROM apps WHERE workspace_id = ? AND platform = ? AND identifier = ?',
            [input.workspaceId, input.platform, input.identifier],
          );
    return rows.length > 0;
  };
  const duplicate = () =>
    failure(409, 'already_exists', `${input.identifier} is already added for ${input.platform}.`);
  if (await taken()) return duplicate();

  const id = randomUUID();
  const now = ctx.now();
  const name = input.name ?? input.identifier;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO apps
           (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.workspaceId,
          name,
          input.platform,
          input.identifier,
          input.credentialId,
          input.repositoryId ?? null,
          now,
        ],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'app.create',
        target: { type: 'app', id },
        detail: {
          platform: input.platform,
          identifier: input.identifier,
          credentialId: input.credentialId,
        },
        at: now,
      });
    });
  } catch (error) {
    // Two requests at once: the unique index decides.
    if (await taken()) return duplicate();
    throw error;
  }
  return { ok: true, app: (await getApp(db, input.workspaceId, id)) as ManagedApp };
}

export async function deleteApp(
  ctx: AppsContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const app = await getApp(tx, input.workspaceId, input.id);
    if (!app) return false;
    await tx.execute('DELETE FROM app_releases WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await deleteListingData(tx, input.workspaceId, input.id);
    await deleteReviewData(tx, input.workspaceId, input.id);
    await deleteAsoData(tx, input.workspaceId, input.id);
    await deleteAiData(tx, input.workspaceId, input.id);
    await deleteAppIcon(tx, input.workspaceId, input.id);
    await tx.execute('DELETE FROM store_rollout_claims WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM staged_changes WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM staged_asset_blobs WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM store_draft_claims WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM store_draft_pushes WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM store_submit_claims WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM store_release_claims WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM store_publish_claims WHERE app_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    // The release pipeline's own rows: the builds seen, the stall reminder, and the app's share of CI runs.
    await tx.execute('DELETE FROM app_builds WHERE app_id = ? AND workspace_id = ?', [input.id, input.workspaceId]);
    await tx.execute('DELETE FROM release_stall_reminders WHERE app_id = ? AND workspace_id = ?', [input.id, input.workspaceId]);
    await tx.execute('DELETE FROM ci_run_apps WHERE app_id = ? AND workspace_id = ?', [input.id, input.workspaceId]);
    await tx.execute('DELETE FROM apps WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'app.delete',
      target: { type: 'app', id: input.id },
      detail: { platform: app.platform, identifier: app.identifier },
      at: ctx.now(),
    });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Sync

class SyncTimeout extends Error {}

/** A failure as the response, the safe text to store on the app, and whether a retry may help. */
type Classified = { failure: Failure; message: string; transient: boolean };

function classify(error: unknown, secret: string): Classified {
  const clean = (text: string) =>
    redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, MAX_ERROR_LENGTH);
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    transient: boolean,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Classified => {
    const safe = clean(message);
    return {
      failure: { ok: false, status, body: { error: code, message: safe, ...extra }, ...(headers ? { headers } : {}) },
      message: safe,
      transient,
    };
  };
  if (error instanceof SyncTimeout) {
    return make(504, 'timeout', 'The store did not answer in time. Try again.', true);
  }
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return make(429, 'rate_limited', error.message, true, { retryAfterSeconds: wait }, {
      'Retry-After': String(wait),
    });
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
      case 'invalid_input':
        return make(422, 'store_auth', error.message, false);
      case 'forbidden':
      case 'api_disabled':
        return make(422, 'store_forbidden', error.message, false);
      case 'not_found':
        return make(422, 'store_not_found', error.message, false);
      case 'server':
      case 'network':
      case 'edit_invalid':
        return make(502, 'store_unavailable', error.message, true);
      default:
        return make(502, 'store_unavailable', error.message, false);
    }
  }
  // Not ours to explain, and the text may echo what was sent. Nothing of it is kept.
  return make(502, 'sync_failed', 'The sync could not be completed. Try again in a moment.', false);
}

/** Apps being synced right now, in this process. A second sync of the same app is refused. */
const running = new Set<string>();

type Read = { appStoreId: string; releases: ReleaseInput[]; builds: BuildSeen[] };

/** A build the store showed (App Store Connect build, or a Google Play version code of a track release): `app_builds`. */
export type BuildSeen = {
  buildNumber: string;
  storeId: string | null;
  version: string | null;
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  rawState: string | null;
  expired: boolean | null;
  uploadedAt: number | null;
};

/** Builds kept per app: the newest. A store with more is cut (the oldest are not a release in flight). */
export const MAX_BUILDS_SEEN = 200;

function seenFromAppleBuilds(builds: readonly StoreBuild[]): BuildSeen[] {
  return [...builds]
    .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0) || Number(b.buildNumber) - Number(a.buildNumber))
    .slice(0, MAX_BUILDS_SEEN)
    .map((b) => ({
      buildNumber: b.buildNumber,
      storeId: b.storeId,
      version: b.versionString ?? null,
      state: b.processing,
      rawState: b.rawProcessingState ?? null,
      expired: b.expired ?? null,
      uploadedAt: b.uploadedAt ?? null,
    }));
}

function seenFromPlayVersions(versions: readonly StoreVersion[]): BuildSeen[] {
  const out = new Map<string, BuildSeen>();
  for (const v of versions) {
    for (const code of v.versionCodes ?? []) {
      // The newest-looking release that holds the code names it; Google does not say when a code was uploaded.
      if (!out.has(code)) {
        out.set(code, { buildNumber: code, storeId: null, version: v.versionString, state: 'processed', rawState: v.rawState, expired: null, uploadedAt: null });
      }
    }
  }
  return [...out.values()].sort((a, b) => Number(b.buildNumber) - Number(a.buildNumber)).slice(0, MAX_BUILDS_SEEN);
}

type ReleaseInput = {
  version: string;
  track: string;
  build: string | null;
  status: ReleaseState | null;
  rawState: string;
  details: Details;
  storeUpdatedAt: number | null;
};

/**
 * The newest build of the same version string. A heuristic: Apple's link from a version to its
 * build is a separate resource that is not read. Prefers builds the store has processed.
 */
function pickBuild(version: StoreVersion, builds: StoreBuild[]): StoreBuild | undefined {
  const candidates = builds.filter((b) => b.versionString === version.versionString);
  const usable = candidates.filter((b) => b.processing === 'processed' && b.expired !== true);
  const pool = usable.length > 0 ? usable : candidates;
  return [...pool].sort(
    (a, b) =>
      (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0) ||
      Number(b.buildNumber) - Number(a.buildNumber) ||
      b.buildNumber.localeCompare(a.buildNumber),
  )[0];
}

async function readStore(connector: StoreConnector, app: ManagedApp): Promise<Read> {
  if (isApplePlatform(app.platform)) {
    let appStoreId = app.storeAppId;
    if (!appStoreId) {
      const apps = await connector.listApps();
      const hit = apps.find((a) => a.bundleId.toLowerCase() === app.identifier.toLowerCase());
      if (!hit) {
        throw new StoreError(
          'appstoreconnect',
          'not_found',
          `No app with the bundle id ${app.identifier} is visible to this App Store Connect key. Check the bundle id, and that the key's team owns the app.`,
        );
      }
      appStoreId = hit.storeId;
    }
    const versions = await connector.listVersions(appStoreId);
    if (app.platform === 'macos' && versions.length === 0) {
      throw new StoreError(
        'appstoreconnect',
        'not_found',
        `App Store Connect has no macOS version for app ${appStoreId}. Add the macOS platform to the app in App Store Connect first (a macOS app that is its own app record is added with its own bundle id).`,
      );
    }
    const builds = await connector.listBuilds(appStoreId);
    return {
      appStoreId,
      builds: seenFromAppleBuilds(builds),
      releases: versions.map((v) => {
        const build = pickBuild(v, builds);
        return {
          version: v.versionString,
          track: '',
          build: build?.buildNumber ?? null,
          status: v.lifecycleState ?? null,
          rawState: v.rawState,
          details: {},
          storeUpdatedAt: build?.uploadedAt ?? null,
        };
      }),
    };
  }
  const versions = await connector.listVersions(app.identifier);
  return {
    appStoreId: app.identifier,
    builds: seenFromPlayVersions(versions),
    releases: versions.map((v) => {
      const codes = v.versionCodes ?? [];
      return {
        version: v.versionString,
        track: v.track ?? '',
        build: codes.length > 0 ? codes.join(',') : null,
        status: v.lifecycleState ?? null,
        rawState: v.rawState,
        details: {
          versionCodes: codes,
          ...(v.rolloutFraction !== undefined ? { rolloutFraction: v.rolloutFraction } : {}),
        },
        storeUpdatedAt: null,
      };
    }),
  };
}

/** Replaces the builds of an app with what the store showed; a build seen before keeps its `first_seen_at`. */
async function writeBuildsSeen(
  tx: Sql,
  input: { appId: string; workspaceId: string; platform: Platform; builds: readonly BuildSeen[]; at: number },
): Promise<void> {
  const keep = new Set<string>();
  for (const b of input.builds) {
    if (keep.has(b.buildNumber)) continue;
    keep.add(b.buildNumber);
    await tx.execute(
      `INSERT INTO app_builds
         (app_id, platform, build_number, workspace_id, store_id, version, processing_state, raw_state, expired,
          uploaded_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, platform, build_number) DO UPDATE SET
         store_id = excluded.store_id, version = excluded.version, processing_state = excluded.processing_state,
         raw_state = excluded.raw_state, expired = excluded.expired, uploaded_at = excluded.uploaded_at,
         last_seen_at = excluded.last_seen_at`,
      [
        input.appId,
        input.platform,
        b.buildNumber,
        input.workspaceId,
        b.storeId,
        b.version,
        b.state,
        b.rawState,
        b.expired === null ? null : b.expired ? 1 : 0,
        b.uploadedAt,
        input.at,
        input.at,
      ],
    );
  }
  const stored = await tx.query('SELECT build_number FROM app_builds WHERE app_id = ? AND platform = ?', [input.appId, input.platform]);
  for (const row of stored) {
    if (!keep.has(String(row.build_number))) {
      await tx.execute('DELETE FROM app_builds WHERE app_id = ? AND platform = ? AND build_number = ?', [input.appId, input.platform, String(row.build_number)]);
    }
  }
}

export type SyncSummary = {
  at: number;
  found: number;
  added: number;
  updated: number;
  removed: number;
  unmapped: number;
};

export type SyncTrigger = { trigger: 'request' } | { trigger: 'job'; requestedBy: string };

async function recordSyncFailure(
  ctx: AppsContext,
  app: ManagedApp,
  workspaceId: string,
  c: Classified,
  actor: Actor,
  trigger: SyncTrigger,
): Promise<void> {
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const changed = await tx.execute(
      `UPDATE apps SET last_sync_attempt_at = ?, last_sync_error = ? WHERE id = ? AND workspace_id = ?`,
      [at, c.message, app.id, workspaceId],
    );
    if (changed === 0) return;
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'app.sync',
      target: { type: 'app', id: app.id },
      detail: { ok: false, code: String(c.failure.body.error), ...trigger },
      at,
    });
  });
}

/** What `syncApp` returns on failure: the response plus whether a retry may help. */
export type SyncFailure = Failure & { transient: boolean };

const withApp = async (ctx: AppsContext, workspaceId: string, id: string, f: Failure) => {
  const app = await getApp(ctx.db, workspaceId, id);
  return app ? { ...f, body: { ...f.body, app } } : f;
};

/**
 * Reads the app from its store (read-only) and replaces the stored snapshot of its releases.
 * The credential's secret is decrypted for this call only (audited as `credential.use`), and
 * every message that leaves this function is redacted against it. A failure is remembered on the
 * app (`last_sync_error`) and audited.
 */
export async function syncApp(
  ctx: AppsContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
  trigger: SyncTrigger = { trigger: 'request' },
): Promise<
  | { ok: true; app: ManagedApp; releases: AppRelease[]; sync: SyncSummary }
  | SyncFailure
> {
  const { db } = ctx;
  const { workspaceId } = input;
  const app = await getApp(db, workspaceId, input.id);
  if (!app) return { ...failure(404, 'not_found'), transient: false };
  if (running.has(app.id)) {
    return {
      ...failure(409, 'sync_in_progress', 'A sync of this app is already running.'),
      transient: false,
    };
  }
  running.add(app.id);
  try {
    return await runSync(ctx, app, workspaceId, actor, trigger);
  } finally {
    running.delete(app.id);
  }
}

async function runSync(
  ctx: AppsContext,
  app: ManagedApp,
  workspaceId: string,
  actor: Actor,
  trigger: SyncTrigger,
) {
  const { db } = ctx;
  const stop = async (c: Classified): Promise<SyncFailure> => {
    await recordSyncFailure(ctx, app, workspaceId, c, actor, trigger);
    return { ...(await withApp(ctx, workspaceId, app.id, c.failure)), transient: c.transient };
  };
  const plain = (status: Failure['status'], code: string, message: string) =>
    stop({ failure: failure(status, code, message), message, transient: false });

  const [credential] = await db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential) {
    return plain(
      422,
      'credential_not_found',
      'The credential of this app no longer exists. Add the app again with a new credential.',
    );
  }
  const kind = String(credential.kind);
  if (kind !== credentialKindFor[app.platform]) {
    return plain(422, 'credential_kind', 'This app\'s credential is not the kind its platform needs.');
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: APP_SYNC_QUEUE },
      actor,
      ctx.now(),
    );
  } catch {
    return plain(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined) {
    return plain(422, 'credential_not_found', 'The credential of this app no longer exists.');
  }

  // Aborting also cancels the request the connector has in flight.
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (input, init) =>
    baseFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncTimeout('timeout'));
    }, ctx.timeoutMs);
  });
  let read: Read;
  let connector: StoreConnector | undefined;
  try {
    connector = ctx.connectorFactory({
      kind: kind as StoreConnectorInput['kind'],
      secret,
      identifier: app.identifier,
      platform: app.platform,
      fetch: guardedFetch,
    });
    const work = readStore(connector, app);
    // The race may lose to the timeout; the abandoned read must not become an unhandled rejection.
    work.catch(() => undefined);
    read = await Promise.race([work, timedOut]);
  } catch (error) {
    return stop(classify(error, secret));
  } finally {
    clearTimeout(timer);
  }

  const at = ctx.now();
  const outcome = await db.transaction(async (tx) => {
    // The app may have been deleted while the store was being read.
    const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      app.id,
      workspaceId,
    ]);
    if (!still) return undefined;
    // One row per version and track: if the store repeats one, the last wins.
    const wanted = new Map<string, ReleaseInput>();
    for (const release of read.releases) wanted.set(`${release.track}\u0000${release.version}`, release);
    const existing = new Map<string, Row>();
    const rows = await tx.query(
      'SELECT id, version, track, build, status, raw_state, details_json, store_updated_at, status_since, synced_at FROM app_releases WHERE app_id = ?',
      [app.id],
    );
    for (const row of rows) existing.set(`${String(row.track)}\u0000${String(row.version)}`, row);

    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const [key, release] of wanted) {
      const detailsJson = JSON.stringify(release.details);
      const old = existing.get(key);
      if (!old) {
        await tx.execute(
          `INSERT INTO app_releases
             (id, app_id, workspace_id, platform, version, track, build, status, raw_state,
              details_json, store_updated_at, synced_at, status_since)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            app.id,
            workspaceId,
            app.platform,
            release.version,
            release.track,
            release.build,
            release.status,
            release.rawState,
            detailsJson,
            release.storeUpdatedAt,
            at,
            at,
          ],
        );
        added++;
        continue;
      }
      const same =
        (old.build ?? null) === release.build &&
        (old.status ?? null) === release.status &&
        String(old.raw_state) === release.rawState &&
        String(old.details_json ?? '') === detailsJson &&
        (old.store_updated_at === null || old.store_updated_at === undefined
          ? null
          : Number(old.store_updated_at)) === release.storeUpdatedAt;
      if (!same) updated++;
      // The time of the last move (state, state name or build): what the release pipeline measures "nothing moved" from.
      const moved =
        (old.build ?? null) !== release.build ||
        (old.status ?? null) !== release.status ||
        String(old.raw_state) !== release.rawState;
      const since = moved ? at : Number(old.status_since ?? old.synced_at);
      await tx.execute(
        `UPDATE app_releases SET build = ?, status = ?, raw_state = ?, details_json = ?,
                store_updated_at = ?, synced_at = ?, status_since = ?
          WHERE id = ? AND app_id = ?`,
        [
          release.build,
          release.status,
          release.rawState,
          detailsJson,
          release.storeUpdatedAt,
          at,
          since,
          String(old.id),
          app.id,
        ],
      );
    }
    for (const [key, old] of existing) {
      if (wanted.has(key)) continue;
      await tx.execute('DELETE FROM app_releases WHERE id = ? AND app_id = ?', [String(old.id), app.id]);
      removed++;
    }
    await writeBuildsSeen(tx, { appId: app.id, workspaceId, platform: app.platform, builds: read.builds, at });
    await tx.execute(
      `UPDATE apps SET store_app_id = ?, last_synced_at = ?, last_sync_attempt_at = ?,
              last_sync_error = NULL
        WHERE id = ? AND workspace_id = ?`,
      [read.appStoreId, at, at, app.id, workspaceId],
    );
    const unmapped = [...wanted.values()].filter((r) => r.status === null).length;
    const sync: SyncSummary = { at, found: wanted.size, added, updated, removed, unmapped };
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'app.sync',
      target: { type: 'app', id: app.id },
      detail: { ok: true, found: sync.found, added, updated, removed, unmapped, ...trigger },
      at,
    });
    // `app.release.status_changed` per release whose status moved, then `app.synced`. The first
    // sync of an app is a quiet baseline (see releaseStatusChanges).
    await recordSyncEvents(tx, {
      workspaceId,
      appId: app.id,
      at,
      summary: sync,
      changes: releaseStatusChanges(existing, wanted, app.lastSyncedAt !== null),
      trigger: trigger.trigger,
    });
    return sync;
  });
  if (!outcome) return { ...failure(404, 'not_found'), transient: false } as SyncFailure;
  // Best effort and read-only: the live listing (name, description, ...) is read and recorded as
  // snapshots. It never fails the sync; a failure is kept as the app's `listing_error`.
  if (connector) {
    await syncListing(ctx, {
      workspaceId,
      app,
      appStoreId: read.appStoreId,
      connector,
      abort: () => controller.abort(),
      secret,
      actor,
    });
  }
  await recordAppliedChangeSets(db, workspaceId, app, ctx.now()).catch(() => 0);
  return {
    ok: true as const,
    app: (await getApp(db, workspaceId, app.id)) as ManagedApp,
    releases: await listAppReleases(db, workspaceId, app.id),
    sync: outcome,
  };
}

// ---------------------------------------------------------------------------------------------
// As a job

export type AppSyncPayload = { workspaceId: string; appId: string; requestedBy: string };

/** Queues a sync for the worker. The caller has already checked the app and the rate limit. */
export function enqueueAppSync(
  ctx: Pick<AppsContext, 'db' | 'now'>,
  payload: AppSyncPayload,
): Promise<string> {
  return enqueue(ctx.db, APP_SYNC_QUEUE, payload, { now: ctx.now() });
}

const isPayload = (value: unknown): value is AppSyncPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AppSyncPayload).workspaceId === 'string' &&
  typeof (value as AppSyncPayload).appId === 'string' &&
  typeof (value as AppSyncPayload).requestedBy === 'string';

/**
 * The worker's handler for `app.sync`. A temporary failure (store down, rate limit, timeout)
 * throws, so the queue retries it with backoff; a permanent one (bad key, no access) is recorded
 * on the app and the job ends. An app that was deleted meanwhile ends the job quietly.
 */
export function createAppSyncHandler(ctx: AppsContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    const done = await syncApp(
      ctx,
      { workspaceId: payload.workspaceId, id: payload.appId },
      { type: 'system', id: APP_SYNC_QUEUE },
      { trigger: 'job', requestedBy: payload.requestedBy },
    );
    if (done.ok) return;
    if (done.transient) throw new Error(String(done.body.message ?? done.body.error));
  };
}

// ---------------------------------------------------------------------------------------------
// Discover and import

export const APP_DISCOVER_PURPOSE = 'app.discover';
/** Most apps one import may carry, and most package names one Google Play check may carry. */
export const MAX_IMPORT_ITEMS = 50;
const MAX_CANDIDATES = 1_000;

/** The platforms a credential kind can have apps on. An App Store Connect app can have an iOS and a macOS version. */
const DISCOVERABLE = {
  app_store_connect: ['ios', 'macos'],
  google_play: ['android'],
} as const satisfies Record<string, readonly Platform[]>;

type DiscoverKind = keyof typeof DISCOVERABLE;

const isDiscoverKind = (kind: string): kind is DiscoverKind => kind in DISCOVERABLE;

export type DiscoverCandidate = {
  platform: Platform;
  /** The store's own id: Apple's numeric app id, or the package name. */
  storeId: string;
  /** The bundle id (iOS) or the package name (Android). */
  identifier: string;
  name: string;
  alreadyAdded: boolean;
  /** The id of the app in this workspace, when `alreadyAdded`. */
  appId?: string;
};

/** A package that could not be verified. `error` is one of the documented codes. */
export type DiscoverFailure = { identifier: string; error: string; message: string };

export type Discovery = {
  credentialId: string;
  kind: DiscoverKind;
  candidates: DiscoverCandidate[];
  failures: DiscoverFailure[];
};

const identityKey = (platform: string, identifier: string) =>
  `${platform}\u0000${platform !== 'android' ? identifier.toLowerCase() : identifier}`;

/** The apps of the workspace by platform and identifier (bundle ids compared without case). */
async function existingApps(sql: Sql, workspaceId: string): Promise<Map<string, string>> {
  const rows = await sql.query('SELECT id, platform, identifier FROM apps WHERE workspace_id = ?', [
    workspaceId,
  ]);
  return new Map(rows.map((r) => [identityKey(String(r.platform), String(r.identifier)), String(r.id)]));
}

/** Looks up the credential's kind. Not found, and another workspace's, are the same. */
async function discoverableCredential(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<{ ok: true; kind: DiscoverKind } | Failure> {
  const [credential] = await db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [credentialId, workspaceId],
  );
  if (!credential) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist in this workspace (it may have been deleted).',
    );
  }
  const kind = String(credential.kind);
  if (!isDiscoverKind(kind)) {
    return failure(
      422,
      'credential_kind',
      'Apps can be found with an App Store Connect API key or a Google Play service account credential.',
    );
  }
  return { ok: true, kind };
}

/** A clean one-line name of at most 100 characters, or the identifier. */
const cleanName = (name: string, identifier: string): string =>
  name.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || identifier;

/**
 * Finds the apps behind a credential, read-only, and marks the ones the workspace already has.
 *
 * - App Store Connect: every app the key can see.
 * - Google Play: the API cannot list a developer account's apps, so `packages` is required.
 *   Each package is verified on its own with a read-only edit (never committed), and one that
 *   fails is reported in `failures` with a code, without failing the call. A problem of the
 *   credential itself (rejected key, API disabled, rate limit) or the time limit ends the checks;
 *   the packages not reached carry that code.
 *
 * The secret is decrypted for this call only (audited as `credential.use`, purpose
 * `app.discover`); every message is redacted against it. `take` is the per-workspace rate limit,
 * asked only once the credential is known to be usable.
 */
export async function discoverApps(
  ctx: AppsContext,
  input: { workspaceId: string; credentialId: string; packages?: string[] | undefined },
  actor: Actor,
  take: (workspaceId: string) => number = () => 0,
): Promise<Outcome<{ discovery: Discovery }>> {
  const { db } = ctx;
  const { workspaceId } = input;
  const found = await discoverableCredential(db, workspaceId, input.credentialId);
  if (!found.ok) return found;
  const { kind } = found;
  const packages = [...new Set(input.packages ?? [])];
  if (kind === 'google_play' && packages.length === 0) {
    return failure(
      422,
      'packages_required',
      'Google Play cannot list the apps of an account. Enter the package names to check.',
    );
  }
  const wait = take(workspaceId);
  if (wait > 0) {
    return {
      ...failure(429, 'rate_limited', `Too many store reads. Try again in ${wait} seconds.`, {
        retryAfterSeconds: wait,
      }),
      headers: { 'Retry-After': String(wait) },
    };
  }

  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      db,
      ctx.masterKey,
      { workspaceId, id: input.credentialId, purpose: APP_DISCOVER_PURPOSE },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined) {
    return failure(422, 'credential_not_found', 'That credential no longer exists.');
  }

  // Aborting also cancels the request the connector has in flight.
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (url, init) =>
    baseFetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncTimeout('timeout'));
    }, ctx.timeoutMs);
  });
  timedOut.catch(() => undefined);
  const read = async (identifier: string) => {
    const connector = ctx.connectorFactory({ kind, secret: secret as string, identifier, fetch: guardedFetch });
    const work = connector.listApps(kind === 'app_store_connect' ? { withPlatforms: true } : {});
    // The race may lose to the timeout; the abandoned read must not become an unhandled rejection.
    work.catch(() => undefined);
    return Promise.race([work, timedOut]);
  };
  // The text a person sees for a failure: the classified message, with a discovery-specific
  // wording for the one generic case.
  const describe = (error: unknown) => {
    const c = classify(error, secret as string);
    if (c.failure.body.error === 'sync_failed') {
      return {
        c,
        code: 'discover_failed',
        message: 'The apps could not be read. Try again in a moment.',
      };
    }
    return { c, code: c.failure.body.error, message: c.message };
  };

  const taken = await existingApps(db, workspaceId);
  const candidates: DiscoverCandidate[] = [];
  const failures: DiscoverFailure[] = [];
  const add = (platform: Platform, storeId: string, identifier: string, name: string) => {
    const appId = taken.get(identityKey(platform, identifier));
    candidates.push({
      platform,
      storeId,
      identifier,
      name: cleanName(name, identifier),
      alreadyAdded: appId !== undefined,
      ...(appId !== undefined ? { appId } : {}),
    });
  };

  try {
    if (kind === 'app_store_connect') {
      let apps: Awaited<ReturnType<StoreConnector['listApps']>>;
      try {
        apps = await read('');
      } catch (error) {
        const { c, code, message } = describe(error);
        if (code === 'discover_failed') return failure(502, code, message);
        return c.failure;
      }
      const seen = new Set<string>();
      for (const a of apps) {
        if (a.platform === 'android' || checkIdentifier('ios', a.bundleId)) continue;
        // `platforms` is known only when the store answered the platform read: then one candidate per Apple platform
        // the app has (a universal purchase app has both, with the same store id and bundle id). Unknown: iOS, as before.
        const platforms = (a.platforms ?? []).filter((p) => p === 'ios' || p === 'macos');
        for (const platform of platforms.length > 0 ? platforms : (['ios'] as const)) {
          const key = identityKey(platform, a.bundleId);
          if (seen.has(key)) continue;
          seen.add(key);
          add(platform, a.storeId, a.bundleId, a.name);
        }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      candidates.sort((a, b) => a.name.localeCompare(b.name) || a.identifier.localeCompare(b.identifier));
    } else {
      let stop: { error: string; message: string } | undefined;
      for (const name of packages) {
        if (stop) {
          failures.push({ identifier: name, ...stop });
          continue;
        }
        try {
          const apps = await read(name);
          const hit = apps.find((a) => a.bundleId === name || a.storeId === name);
          if (!hit) {
            failures.push({
              identifier: name,
              error: 'store_not_found',
              message: `Google Play returned no app named ${name}.`,
            });
            continue;
          }
          add('android', hit.storeId, name, hit.name);
        } catch (error) {
          const { code, message } = describe(error);
          failures.push({ identifier: name, error: code, message });
          // These say something about the key or the time left, not about this package.
          const global =
            error instanceof SyncTimeout ||
            error instanceof StoreRateLimitError ||
            (error instanceof StoreError &&
              (error.kind === 'auth' || error.kind === 'clock_skew' || error.kind === 'api_disabled'));
          if (global) stop = { error: code, message };
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, discovery: { credentialId: input.credentialId, kind, candidates, failures } };
}

export type ImportItem = {
  platform: Platform;
  identifier: string;
  storeAppId?: string | undefined;
  name?: string | undefined;
  repositoryId?: string | undefined;
};

export type ImportResult = {
  platform: Platform;
  identifier: string;
  status: 'created' | 'skipped' | 'failed';
  /** The new app, or (skipped) the one that already exists. */
  app?: ManagedApp;
  error?: string;
  message?: string;
};

export type ImportSummary = { created: number; skipped: number; failed: number };

/**
 * Adds the selected apps in one transaction: apps the workspace already has are skipped, an item
 * that cannot be added (wrong credential kind for its platform, unknown repository) fails alone,
 * and the rest are created and audited as `app.create` (with `source: 'import'`). Nothing contacts
 * a store. Importing the same items again creates nothing.
 */
export async function importApps(
  ctx: AppsContext,
  input: { workspaceId: string; credentialId: string; items: ImportItem[] },
  actor: Actor,
): Promise<Outcome<{ results: ImportResult[]; summary: ImportSummary }>> {
  const { db } = ctx;
  const { workspaceId } = input;
  const found = await discoverableCredential(db, workspaceId, input.credentialId);
  if (!found.ok) return found;
  const kindPlatforms: readonly Platform[] = DISCOVERABLE[found.kind];

  const repositoryIds = [...new Set(input.items.flatMap((i) => (i.repositoryId ? [i.repositoryId] : [])))];
  const knownRepositories = new Set<string>();
  for (const id of repositoryIds) {
    const [row] = await db.query('SELECT id FROM repositories WHERE id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ]);
    if (row) knownRepositories.add(id);
  }

  const run = () =>
    db.transaction(async (tx) => {
      const taken = await existingApps(tx, workspaceId);
      const results: ImportResult[] = [];
      for (const item of input.items) {
        const base = { platform: item.platform, identifier: item.identifier };
        const key = identityKey(item.platform, item.identifier);
        if (!kindPlatforms.includes(item.platform)) {
          results.push({
            ...base,
            status: 'failed',
            error: 'credential_kind',
            message:
              isApplePlatform(item.platform)
                ? `${platformLabel(item.platform)} apps need an App Store Connect API key credential.`
                : 'An Android app needs a Google Play service account credential.',
          });
          continue;
        }
        if (item.repositoryId !== undefined && !knownRepositories.has(item.repositoryId)) {
          results.push({
            ...base,
            status: 'failed',
            error: 'repository_not_found',
            message: 'That repository is not connected in this workspace.',
          });
          continue;
        }
        const existingId = taken.get(key);
        if (existingId !== undefined) {
          const app = await getApp(tx, workspaceId, existingId);
          results.push({
            ...base,
            status: 'skipped',
            error: 'already_exists',
            message: `${item.identifier} is already added for ${item.platform}.`,
            ...(app ? { app } : {}),
          });
          continue;
        }
        const id = randomUUID();
        const now = ctx.now();
        await tx.execute(
          `INSERT INTO apps
             (id, workspace_id, name, platform, identifier, store_app_id, credential_id,
              repository_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            cleanName(item.name ?? '', item.identifier),
            item.platform,
            item.identifier,
            item.storeAppId ?? (isGooglePlatform(item.platform) ? item.identifier : null),
            input.credentialId,
            item.repositoryId ?? null,
            now,
          ],
        );
        await recordAudit(tx, {
          workspaceId,
          actor,
          action: 'app.create',
          target: { type: 'app', id },
          detail: {
            platform: item.platform,
            identifier: item.identifier,
            credentialId: input.credentialId,
            source: 'import',
          },
          at: now,
        });
        taken.set(key, id);
        results.push({
          ...base,
          status: 'created',
          app: (await getApp(tx, workspaceId, id)) as ManagedApp,
        });
      }
      return results;
    });

  let results: ImportResult[];
  try {
    results = await run();
  } catch {
    // Another request may have added one of these meanwhile (the unique index refused it and the
    // whole transaction was rolled back). Once more: that app is now seen as existing.
    results = await run();
  }
  const count = (status: ImportResult['status']) => results.filter((r) => r.status === status).length;
  return {
    ok: true,
    results,
    summary: { created: count('created'), skipped: count('skipped'), failed: count('failed') },
  };
}
