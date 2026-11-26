import type { ManagedApp } from '../../services/apps.ts';
import { loadArtifactMeta } from './artifact-meta-store.ts';
import type { OriginArtifact, OriginSources } from '../publish/candidate-origin.ts';
import { type BuildsContext, listBuildArtifacts, storeBuilds } from './service.ts';

/**
 * What Kiln already knows about the builds of an app, for the "which version and when" of a version code in Prepare release
 * (modules/publish/candidate-origin.ts does the join). Reads only:
 *   - `ci_artifact_meta` (the files read from the Test builds page): version and version code. The database alone, so a file GitHub no
 *     longer lists still tells its version.
 *   - the artifact list (the same read as the Test builds page, kept 30 seconds): when each artifact was created and its run. Asked
 *     only when at least one file was read; a failure leaves the date empty and never fails the caller.
 *   - the store builds the sync recorded (`app_builds`).
 * Nothing is downloaded, written or guessed.
 */

type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

export async function loadOriginSources(
  ctx: BuildsContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<OriginSources> {
  const { app } = input;
  const metas = await loadArtifactMeta(ctx.db, input.workspaceId, app.id);
  const read = [...metas.entries()].filter(([, m]) => m.status === 'read' && m.build !== null);
  const store = (await storeBuilds(ctx, input.workspaceId, app)).map((b) => ({
    buildNumber: b.buildNumber,
    version: b.version,
    uploadedAt: b.uploadedAt,
  }));
  if (read.length === 0) return { artifacts: [], store };
  const listed = new Map<string, { createdAt: number | null; run: OriginArtifact['run'] }>();
  try {
    const out = await listBuildArtifacts(
      ctx,
      { workspaceId: input.workspaceId, appId: app.id },
      input.actor,
    );
    if (out.ok) {
      for (const a of out.list.artifacts)
        listed.set(a.id, {
          createdAt: a.createdAt,
          run: {
            runNumber: a.run.number,
            branch: a.run.branch,
            commit: a.run.shortSha,
            url: a.run.url,
          },
        });
    }
  } catch {
    // GitHub could not be read: the versions still come from the cache, the dates stay empty.
  }
  const artifacts: OriginArtifact[] = [];
  for (const [artifactId, m] of read) {
    if (m.status !== 'read') continue;
    const hit = listed.get(artifactId);
    artifacts.push({
      artifactId,
      number: m.build.number,
      version: m.build.version,
      packageId: m.build.packageId,
      createdAt: hit?.createdAt ?? null,
      run: hit?.run ?? null,
    });
  }
  return { artifacts, store };
}
