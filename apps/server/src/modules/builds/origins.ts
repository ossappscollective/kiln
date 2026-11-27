import type { ManagedApp } from '../../services/apps.ts';
import { getRepository } from '../../services/repositories.ts';
import type { ListingState, OriginArtifact, OriginSources } from '../publish/candidate-origin.ts';
import {
  type ArtifactOrigin,
  loadArtifactMeta,
  rememberArtifactOrigin,
} from './artifact-meta-store.ts';
import {
  artifactOriginOf,
  type BuildsContext,
  guessArtifact,
  listRawArtifacts,
  type StoreBuildItem,
  storeBuilds,
} from './service.ts';

/**
 * What Kiln already knows about the builds of an app, for the "which version and when" of a version code in Prepare release
 * (modules/publish/candidate-origin.ts does the join). Reads only:
 *   - `ci_artifact_meta` (the files read from the Test builds page or "Read build info from CI"): version, version code, and since
 *     migration 73 the date GitHub made the artifact and its run. The database alone, so a file GitHub no longer lists still tells its
 *     version and date.
 *   - the artifact list (the same read as the Test builds page, kept 30 seconds), asked only when a file read lacks its date: it fills
 *     the date and run in (the row keeps them from then on) and tells the page why a date is missing when GitHub no longer has the
 *     file or cannot be reached. A failure never fails the caller.
 *   - the store builds the sync recorded (`app_builds`), with when the sync first saw each code.
 * Nothing is downloaded or guessed.
 */

type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

export async function loadOriginSources(
  ctx: BuildsContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    /** The store rows the caller already read (one read per request); read here when absent. */
    store?: readonly StoreBuildItem[] | undefined;
  },
): Promise<OriginSources> {
  const { app } = input;
  const readsEnabled = ctx.builds.downloadEnabled;
  const metas = await loadArtifactMeta(ctx.db, input.workspaceId, app.id);
  const read = [...metas.entries()].filter(([, m]) => m.status === 'read' && m.build !== null);
  const firstSeen: Record<string, number> = {};
  for (const r of await ctx.db.query(
    'SELECT build_number, first_seen_at FROM app_builds WHERE workspace_id = ? AND app_id = ? AND platform = ?',
    [input.workspaceId, app.id, app.platform],
  ))
    firstSeen[String(r.build_number)] = Number(r.first_seen_at);
  const rows = input.store ?? (await storeBuilds(ctx, input.workspaceId, app));
  const store = rows.map((b) => ({
    buildNumber: b.buildNumber,
    version: b.version,
    uploadedAt: b.uploadedAt,
    firstSeenAt: firstSeen[b.buildNumber] ?? null,
  }));
  const repository = app.repositoryId
    ? await getRepository(ctx.db, input.workspaceId, app.repositoryId)
    : undefined;
  let ciLinked = Boolean(repository && !repository.localOnly);
  // A build the CI linked to a run (build_links) has the date of the run's artifact even when its file was never opened.
  const readNumbers = new Set(read.map(([, m]) => (m.build === null ? '' : m.build.number)));
  const links = new Map<string, string>();
  for (const l of await ctx.db.query(
    "SELECT build_number, run_id FROM build_links WHERE workspace_id = ? AND app_id = ? AND platform = ? AND run_id <> ''",
    [input.workspaceId, app.id, app.platform],
  ))
    if (!readNumbers.has(String(l.build_number)))
      links.set(String(l.build_number), String(l.run_id));
  if (read.length === 0 && links.size === 0)
    return { artifacts: [], store, listing: 'not_asked', ciLinked, readsEnabled };

  // The persisted date and run first; the live list (kept 30 seconds, the one the Test builds page just read) only when a file read
  // lacks its date or a linked build has none, and it fills them in.
  const live = new Map<string, ArtifactOrigin>();
  const linkedArtifacts: { number: string; origin: ArtifactOrigin }[] = [];
  let listing: ListingState = 'ok';
  if (read.some(([, m]) => m.origin.createdAt === null) || (ciLinked && links.size > 0)) {
    listing = 'unreachable';
    try {
      const out = await listRawArtifacts(
        ctx,
        { workspaceId: input.workspaceId, appId: app.id },
        input.actor,
      );
      if (out.ok) {
        listing = 'ok';
        for (const a of out.artifacts)
          live.set(a.id, artifactOriginOf(a, a.runId ? out.runs.get(a.runId) : undefined));
        for (const [number, runId] of links) {
          const mine = out.artifacts
            .filter((a) => a.runId === runId)
            .filter((a) => {
              const guess = guessArtifact(a.name, app.platform).platform;
              return guess === null || guess === app.platform;
            })
            .sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0))[0];
          const origin = mine === undefined ? undefined : live.get(mine.id);
          if (origin !== undefined) linkedArtifacts.push({ number, origin });
        }
      } else if (out.reason === 'no_repository') {
        listing = 'no_repository';
        ciLinked = false;
      } else listing = out.reason === 'no_access' ? 'no_access' : 'unreachable';
    } catch {
      // GitHub could not be read: the versions still come from the cache, the dates say why they are missing.
    }
  }
  const artifacts: OriginArtifact[] = [];
  for (const [artifactId, m] of read) {
    if (m.status !== 'read') continue;
    const found = live.get(artifactId);
    if (found) {
      await rememberArtifactOrigin(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        artifactId,
        origin: found,
      }).catch(() => false);
    }
    const o = m.origin;
    const pick = <K extends keyof ArtifactOrigin>(key: K): ArtifactOrigin[K] =>
      (o[key] ?? found?.[key] ?? null) as ArtifactOrigin[K];
    const createdAt = pick('createdAt');
    const hasRun = pick('runNumber') !== null || pick('branch') !== null || pick('runUrl') !== null;
    artifacts.push({
      artifactId,
      number: m.build.number,
      version: m.build.version,
      packageId: m.build.packageId,
      createdAt,
      expiresAt: pick('expiresAt'),
      run: hasRun
        ? {
            runNumber: pick('runNumber'),
            branch: pick('branch'),
            commit: pick('headSha'),
            url: pick('runUrl'),
          }
        : null,
    });
  }
  // The run's artifact stands in for a file that was never opened: its DATE and run only (no version name, no package).
  for (const { number, origin } of linkedArtifacts) {
    artifacts.push({
      artifactId: `run:${origin.runId ?? number}`,
      number,
      version: null,
      packageId: null,
      createdAt: origin.createdAt,
      expiresAt: origin.expiresAt,
      run:
        origin.runNumber !== null || origin.branch !== null || origin.runUrl !== null
          ? {
              runNumber: origin.runNumber,
              branch: origin.branch,
              commit: origin.headSha,
              url: origin.runUrl,
            }
          : null,
    });
  }
  return { artifacts, store, listing, ciLinked, readsEnabled };
}
