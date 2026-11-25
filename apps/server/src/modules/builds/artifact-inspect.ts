import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { coded } from '../../i18n/problem.ts';
import type { Failure } from '../../services/repositories.ts';
import { loadOneArtifactMeta, saveArtifactMeta } from './artifact-meta-store.ts';
import { inspectBuildArtifact } from './artifact-meta/inspect.ts';
import {
  type ArtifactItem,
  artifactItem,
  type BuildsContext,
  type BuildsFailure,
  fail,
  findArtifact,
  openArtifactDownload,
} from './service.ts';

/**
 * Reading the real build number of a CI artifact (docs/api/builds.md). The zip is downloaded
 * through the same guarded path as a download (switch, rate limit, size limit, time limit, the
 * GitHub credential never leaves the server) into a temporary file in the scratch folder, opened by
 * position, and deleted before this returns. The answer is kept in `ci_artifact_meta`, `unreadable`
 * included, so a file is downloaded once. One read at a time per app. Nothing is written to GitHub,
 * a store or the audit log.
 */

type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

const TEMP_PREFIX = 'kiln-inspect-';
const STALE_TEMP_MS = 60 * 60_000;
const swept = new WeakSet<BuildsContext>();

/** A crash can leave a temporary file behind: the first read of a process removes the old ones. */
async function sweepOldFiles(ctx: BuildsContext): Promise<void> {
  if (swept.has(ctx)) return;
  swept.add(ctx);
  try {
    for (const name of await readdir(ctx.builds.scratchDir)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(ctx.builds.scratchDir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs > STALE_TEMP_MS)
        await rm(path, { force: true });
    }
  } catch {
    // no folder yet, or not readable: nothing to sweep
  }
}

/**
 * Runs `work` after the reads already queued for the app, so only one artifact of an app is
 * downloaded at a time.
 */
function serialised<T>(ctx: BuildsContext, appId: string, work: () => Promise<T>): Promise<T> {
  const before = ctx.inspecting.get(appId) ?? Promise.resolve();
  const mine = before.then(
    () => work(),
    () => work(),
  );
  const tail = mine.then(
    () => undefined,
    () => undefined,
  );
  ctx.inspecting.set(appId, tail);
  void tail.then(() => {
    if (ctx.inspecting.get(appId) === tail) ctx.inspecting.delete(appId);
  });
  return mine;
}

const downloadFailed = (error: unknown): BuildsFailure =>
  error instanceof Error && /larger than the download limit/.test(error.message)
    ? fail(413, 'artifact_too_large', 'This artifact is larger than the download limit.', {
        ...coded('builds.artifactTooLarge'),
      })
    : fail(
        502,
        'download_failed',
        'The artifact could not be downloaded from GitHub.',
        coded('builds.githubDownloadFailed'),
      );

/**
 * Reads the build number inside an artifact of an app and keeps the answer. An artifact already
 * read answers from the store without a download. A download that fails is NOT kept (it may work
 * next time); a file that was read and held nothing is kept as `unreadable`.
 */
export async function inspectArtifact(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string; artifactId: string },
  actor: Actor,
): Promise<{ ok: true; artifact: ArtifactItem } | BuildsFailure | Failure> {
  if (!ctx.builds.downloadEnabled) {
    return fail(
      409,
      'builds_download_disabled',
      'Downloading builds is switched off on this server (KILN_BUILDS_DOWNLOAD_ENABLED).',
    );
  }
  return serialised(ctx, input.appId, async () => {
    const found = await findArtifact(ctx, input, actor);
    if (!found.ok) return found;
    const { app, artifact, run } = found;
    const item = (meta: Awaited<ReturnType<typeof loadOneArtifactMeta>>) => ({
      ok: true as const,
      artifact: artifactItem(artifact, run, app, ctx.builds.maxDownloadBytes, meta),
    });
    const known = await loadOneArtifactMeta(ctx.db, input.workspaceId, app.id, artifact.id);
    if (known) return item(known);

    const opened = await openArtifactDownload(ctx, { ...input, via: 'inspect' }, actor);
    if (!opened.ok) return opened;
    await sweepOldFiles(ctx);
    const path = join(ctx.builds.scratchDir, `${TEMP_PREFIX}${randomUUID()}.zip`);
    try {
      await mkdir(ctx.builds.scratchDir, { recursive: true });
      try {
        await pipeline(
          Readable.fromWeb(opened.body as WebReadableStream<Uint8Array>),
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        );
      } catch (error) {
        return downloadFailed(error);
      }
      const meta = await inspectBuildArtifact(path, {
        tempDir: ctx.builds.scratchDir,
        maxFileBytes: ctx.builds.maxDownloadBytes,
      });
      const saved = await saveArtifactMeta(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        artifactId: artifact.id,
        meta,
        at: ctx.now(),
      });
      return item(saved);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  });
}
