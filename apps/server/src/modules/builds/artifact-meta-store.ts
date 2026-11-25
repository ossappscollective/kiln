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

export type ArtifactMeta =
  | { status: 'read'; build: ArtifactBuild }
  | { status: 'unreadable'; build: null };

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
    `SELECT artifact_id, status, build_number, version, package_id, format FROM ci_artifact_meta
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
    `SELECT artifact_id, status, build_number, version, package_id, format FROM ci_artifact_meta
      WHERE workspace_id = ? AND app_id = ? AND artifact_id = ?`,
    [workspaceId, appId, artifactId],
  );
  return row ? metaOf(row) : undefined;
}

function metaOf(r: Record<string, unknown>): ArtifactMeta {
  const format = String(r.format ?? '');
  if (String(r.status) === 'read' && r.build_number && FORMATS.includes(format))
    return {
      status: 'read',
      build: {
        number: String(r.build_number),
        version: r.version ? String(r.version) : null,
        packageId: r.package_id ? String(r.package_id) : null,
        format: format as BuildFormat,
      },
    };
  return { status: 'unreadable', build: null };
}

/**
 * Stores a result (a null `meta` is `unreadable`). The same artifact read twice keeps the later
 * answer.
 */
export async function saveArtifactMeta(
  db: Sql,
  input: {
    workspaceId: string;
    appId: string;
    artifactId: string;
    meta: BuildMeta | null;
    at: number;
  },
): Promise<ArtifactMeta> {
  const { meta } = input;
  await db.execute(
    `INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, build_number, version, package_id, format, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, artifact_id) DO UPDATE SET status = excluded.status, build_number = excluded.build_number,
       version = excluded.version, package_id = excluded.package_id, format = excluded.format, read_at = excluded.read_at`,
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
    ],
  );
  await db.execute(
    'DELETE FROM ci_artifact_meta WHERE app_id = ? AND workspace_id = ? AND read_at < ?',
    [input.appId, input.workspaceId, input.at - META_KEEP_MS],
  );
  return meta
    ? {
        status: 'read',
        build: {
          number: meta.buildNumber,
          version: meta.version,
          packageId: meta.packageId,
          format: meta.format,
        },
      }
    : { status: 'unreadable', build: null };
}
