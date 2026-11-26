import type { Sql } from '@kiln/db';
import type { BuildFormat, BuildMeta } from './artifact-meta/inspect.ts';

/**
 * What was read from inside a CI artifact, kept in `ci_artifact_meta` (migration 70) per app and
 * GitHub artifact id, so a file is downloaded and opened once. `unreadable` is kept too, so a file
 * with no build number is not downloaded again.
 */

export type ArtifactBuild = {
  /** The Android versionCode or the iOS CFBundleVersion, as text. */
  number: string;
  /** versionName or CFBundleShortVersionString. */
  version: string | null;
  /** The Android package or the iOS CFBundleIdentifier. */
  packageId: string | null;
  format: BuildFormat;
};

/**
 * When GitHub made the artifact and the run it came from (migration 73), kept with what was read so the date outlives the artifact.
 * Every field is null when it was never seen (a row read before migration 73, until the artifact shows up in the list again).
 */
export type ArtifactOrigin = {
  name: string | null;
  /** Epoch milliseconds GitHub created the artifact (the build). */
  createdAt: number | null;
  /** Epoch milliseconds GitHub deletes it (or deleted it). */
  expiresAt: number | null;
  runId: string | null;
  runNumber: number | null;
  branch: string | null;
  /** The short commit of the run. */
  headSha: string | null;
  runUrl: string | null;
};

export const NO_ARTIFACT_ORIGIN: ArtifactOrigin = {
  name: null,
  createdAt: null,
  expiresAt: null,
  runId: null,
  runNumber: null,
  branch: null,
  headSha: null,
  runUrl: null,
};

export type ArtifactMeta =
  | { status: 'read'; build: ArtifactBuild; origin: ArtifactOrigin }
  | { status: 'unreadable'; build: null; origin: ArtifactOrigin };

const COLUMNS = `artifact_id, status, build_number, version, package_id, format, artifact_name, artifact_created_at,
       artifact_expires_at, run_id, run_number, branch, head_sha, run_url`;

const num = (v: unknown): number | null =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

/**
 * Rows older than this are dropped when a new one is written (GitHub keeps an artifact 90 days at
 * most).
 */
export const META_KEEP_MS = 120 * 24 * 60 * 60_000;

const FORMATS: readonly string[] = ['apk', 'aab', 'ipa'];

/** The cached results of an app, by artifact id. */
export async function loadArtifactMeta(
  db: Sql,
  workspaceId: string,
  appId: string,
): Promise<Map<string, ArtifactMeta>> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM ci_artifact_meta
      WHERE workspace_id = ? AND app_id = ?`,
    [workspaceId, appId],
  );
  const out = new Map<string, ArtifactMeta>();
  for (const r of rows) out.set(String(r.artifact_id), metaOf(r));
  return out;
}

export async function loadOneArtifactMeta(
  db: Sql,
  workspaceId: string,
  appId: string,
  artifactId: string,
): Promise<ArtifactMeta | undefined> {
  const [row] = await db.query(
    `SELECT ${COLUMNS} FROM ci_artifact_meta
      WHERE workspace_id = ? AND app_id = ? AND artifact_id = ?`,
    [workspaceId, appId, artifactId],
  );
  return row ? metaOf(row) : undefined;
}

function originOf(r: Record<string, unknown>): ArtifactOrigin {
  return {
    name: str(r.artifact_name),
    createdAt: num(r.artifact_created_at),
    expiresAt: num(r.artifact_expires_at),
    runId: str(r.run_id),
    runNumber: num(r.run_number),
    branch: str(r.branch),
    headSha: str(r.head_sha),
    runUrl: str(r.run_url),
  };
}

function metaOf(r: Record<string, unknown>): ArtifactMeta {
  const format = String(r.format ?? '');
  const origin = originOf(r);
  if (String(r.status) === 'read' && r.build_number && FORMATS.includes(format))
    return {
      status: 'read',
      origin,
      build: {
        number: String(r.build_number),
        version: r.version ? String(r.version) : null,
        packageId: r.package_id ? String(r.package_id) : null,
        format: format as BuildFormat,
      },
    };
  return { status: 'unreadable', build: null, origin };
}

/**
 * Stores a result (a null `meta` is `unreadable`). The same artifact read twice keeps the later
 * answer. `origin` (when GitHub made the artifact, its run) is written with it when the caller has it at hand; a field it
 * does not have keeps what the row had.
 */
export async function saveArtifactMeta(
  db: Sql,
  input: {
    workspaceId: string;
    appId: string;
    artifactId: string;
    meta: BuildMeta | null;
    at: number;
    origin?: Partial<ArtifactOrigin> | undefined;
  },
): Promise<ArtifactMeta> {
  const { meta } = input;
  const o = { ...NO_ARTIFACT_ORIGIN, ...input.origin };
  await db.execute(
    `INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, build_number, version, package_id, format, read_at,
       artifact_name, artifact_created_at, artifact_expires_at, run_id, run_number, branch, head_sha, run_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, artifact_id) DO UPDATE SET status = excluded.status, build_number = excluded.build_number,
       version = excluded.version, package_id = excluded.package_id, format = excluded.format, read_at = excluded.read_at,
       artifact_name = COALESCE(excluded.artifact_name, ci_artifact_meta.artifact_name),
       artifact_created_at = COALESCE(excluded.artifact_created_at, ci_artifact_meta.artifact_created_at),
       artifact_expires_at = COALESCE(excluded.artifact_expires_at, ci_artifact_meta.artifact_expires_at),
       run_id = COALESCE(excluded.run_id, ci_artifact_meta.run_id),
       run_number = COALESCE(excluded.run_number, ci_artifact_meta.run_number),
       branch = COALESCE(excluded.branch, ci_artifact_meta.branch),
       head_sha = COALESCE(excluded.head_sha, ci_artifact_meta.head_sha),
       run_url = COALESCE(excluded.run_url, ci_artifact_meta.run_url)`,
    [
      input.appId,
      input.artifactId,
      input.workspaceId,
      meta ? 'read' : 'unreadable',
      meta?.buildNumber ?? null,
      meta?.version ?? null,
      meta?.packageId ?? null,
      meta?.format ?? null,
      input.at,
      o.name,
      o.createdAt,
      o.expiresAt,
      o.runId,
      o.runNumber,
      o.branch,
      o.headSha,
      o.runUrl,
    ],
  );
  await db.execute(
    'DELETE FROM ci_artifact_meta WHERE app_id = ? AND workspace_id = ? AND read_at < ?',
    [input.appId, input.workspaceId, input.at - META_KEEP_MS],
  );
  const saved = await loadOneArtifactMeta(db, input.workspaceId, input.appId, input.artifactId);
  return (
    saved ??
    (meta
      ? {
          status: 'read',
          build: {
            number: meta.buildNumber,
            version: meta.version,
            packageId: meta.packageId,
            format: meta.format,
          },
          origin: o,
        }
      : { status: 'unreadable', build: null, origin: o })
  );
}

/**
 * Fills in the date and the run of a row that lacks them, from the artifact list GitHub still shows (a lazy backfill: a row
 * read before migration 73, or whose artifact was not at hand). Only fills what is empty and never touches a row that is not there.
 * Returns whether a row changed.
 */
export async function rememberArtifactOrigin(
  db: Sql,
  input: {
    workspaceId: string;
    appId: string;
    artifactId: string;
    origin: Partial<ArtifactOrigin>;
  },
): Promise<boolean> {
  const o = { ...NO_ARTIFACT_ORIGIN, ...input.origin };
  const before = await loadOneArtifactMeta(db, input.workspaceId, input.appId, input.artifactId);
  if (!before) return false;
  const b = before.origin;
  const missing =
    (b.createdAt === null && o.createdAt !== null) ||
    (b.runNumber === null && o.runNumber !== null) ||
    (b.branch === null && o.branch !== null) ||
    (b.expiresAt === null && o.expiresAt !== null) ||
    (b.name === null && o.name !== null) ||
    (b.runUrl === null && o.runUrl !== null);
  if (!missing) return false;
  await db.execute(
    `UPDATE ci_artifact_meta SET artifact_name = COALESCE(artifact_name, ?), artifact_created_at = COALESCE(artifact_created_at, ?),
       artifact_expires_at = COALESCE(artifact_expires_at, ?), run_id = COALESCE(run_id, ?), run_number = COALESCE(run_number, ?),
       branch = COALESCE(branch, ?), head_sha = COALESCE(head_sha, ?), run_url = COALESCE(run_url, ?)
      WHERE workspace_id = ? AND app_id = ? AND artifact_id = ?`,
    [
      o.name,
      o.createdAt,
      o.expiresAt,
      o.runId,
      o.runNumber,
      o.branch,
      o.headSha,
      o.runUrl,
      input.workspaceId,
      input.appId,
      input.artifactId,
    ],
  );
  return true;
}
