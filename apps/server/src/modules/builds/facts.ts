import {
  BUILD_AUTO_READ_BATCH,
  BUILD_AUTO_READ_PAUSE_MS,
  type BuildOrigin,
  joinBuildOrigin,
} from '@kiln/core';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { inspectArtifact } from './artifact-inspect.ts';
import { loadOriginSources } from './origins.ts';
import type { ArtifactItem, BuildsContext, BuildsList, StoreBuildItem } from './service.ts';

/**
 * ONE read of the facts of the builds of an app (docs/state-model.md, "Single owners (core)"): the store rows of `GET builds/artifacts`
 * each joined with where it came from (`joinBuildOrigin` of @kiln/core), so the Test builds page, the Publish summary, the release
 * candidate (the next release's train) and the build picker read the same version name, build number, DATE and origin. Before, five
 * surfaces joined (or did not join) the store rows, the CI files and the release names on their own and answered "Build date not known"
 * from five different places.
 *
 * Nothing is guessed: a date is the date GitHub made the CI artifact (the build) or the store's own upload time. When there is none, the
 * `builtGap` says why in a fixed vocabulary (`not_read`, `reads_disabled`, `file_gone`, `github_unreachable`, `github_no_access`,
 * `no_repository`).
 *
 * LAZY FILL. A date needs a CI file to have been read (`ci_artifact_meta`), which used to happen only when somebody opened the Test
 * builds page and pressed "Read build info from CI". Now a list of the builds of an app also starts, in the background and after the
 * answer is built, the read of the newest unread artifacts (at most `BUILD_AUTO_READ_BATCH`, one batch per app every
 * `BUILD_AUTO_READ_PAUSE_MS`), through the same guarded path (size limit, rate limit, one at a time per app, nothing kept on a failed
 * download). It respects `KILN_BUILDS_DOWNLOAD_ENABLED`: with it off nothing is downloaded and the builds without a date say
 * `reads_disabled` (enable build reads) instead of a vaguer "not known".
 */

const SYSTEM = { type: 'system' as const, id: 'builds.auto_read' };

/** The origin of a store build as the list returns it (flat fields of `BuildOrigin` that a person reads; the number is the row's own). */
export type BuildOriginView = Pick<
  BuildOrigin,
  | 'version'
  | 'builtAt'
  | 'origin'
  | 'builtFrom'
  | 'builtGap'
  | 'ciExpiredAt'
  | 'matchedBy'
  | 'firstSeenAt'
> & { ci: BuildOrigin['ci'] | null };

export type StoreBuildFact = StoreBuildItem & { origin: BuildOriginView };

/** Something `inspectBuildArtifact` can open: an .ipa, .apk or .aab, or a zip whose name looks like a build of the app's platform. */
const KINDS: readonly string[] = ['ipa', 'apk', 'aab', 'zip'];

/** The newest artifacts nobody read yet that could be: not expired, within the size limit, of this app's platform. */
export function unreadArtifacts(
  artifacts: readonly ArtifactItem[],
  app: Pick<ManagedApp, 'platform'>,
  limit: number = BUILD_AUTO_READ_BATCH,
): ArtifactItem[] {
  return artifacts
    .filter(
      (a) =>
        a.buildRead === null &&
        a.downloadable &&
        KINDS.indexOf(a.kind) >= 0 &&
        a.platform === app.platform,
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, limit);
}

/**
 * Starts the background read of the newest unread artifacts of the app. Never waits, never throws. Returns the artifact ids it
 * started (for tests); `[]` when downloads are off, nothing is unread or a batch started within the pause.
 */
export function scheduleBuildReads(
  ctx: BuildsContext,
  input: { workspaceId: string; app: ManagedApp; artifacts: readonly ArtifactItem[] },
): string[] {
  if (!ctx.builds.downloadEnabled) return [];
  const wanted = unreadArtifacts(input.artifacts, input.app);
  if (wanted.length === 0) return [];
  const at = ctx.now();
  const last = ctx.autoReadAt.get(input.app.id);
  if (last !== undefined && at - last < BUILD_AUTO_READ_PAUSE_MS) return [];
  ctx.autoReadAt.set(input.app.id, at);
  void (async () => {
    for (const a of wanted) {
      try {
        await inspectArtifact(
          ctx,
          { workspaceId: input.workspaceId, appId: input.app.id, artifactId: a.id },
          SYSTEM,
        );
      } catch {
        // a failed read is tried again after the pause; it never fails the list
      }
    }
  })();
  return wanted.map((a) => a.id);
}

/** The list with the origin of every store build joined on, and the background read of what is unread started. */
export async function withBuildOrigins(
  ctx: BuildsContext,
  input: { workspaceId: string; list: BuildsList },
): Promise<Omit<BuildsList, 'store'> & { store: StoreBuildFact[] }> {
  const { list } = input;
  const app = await getApp(ctx.db, input.workspaceId, list.app.id);
  const bare = (store: StoreBuildItem[]): StoreBuildFact[] =>
    store.map((b) => ({
      ...b,
      origin: {
        version: b.version,
        builtAt: b.uploadedAt,
        origin: b.uploadedAt === null ? null : 'store',
        builtFrom: b.uploadedAt === null ? null : 'store',
        builtGap:
          b.uploadedAt === null
            ? ctx.builds.downloadEnabled
              ? 'not_read'
              : 'reads_disabled'
            : null,
        ciExpiredAt: null,
        matchedBy: null,
        firstSeenAt: null,
        ci: null,
      },
    }));
  if (!app) return { ...list, store: bare(list.store) };
  let store: StoreBuildFact[];
  try {
    const sources = await loadOriginSources(ctx, {
      workspaceId: input.workspaceId,
      app,
      actor: SYSTEM,
      store: list.store,
    });
    const joined = joinBuildOrigin(
      list.store.map((b) => ({
        buildNumber: b.buildNumber,
        version: b.version,
        uploadedAt: b.uploadedAt,
        firstSeenAt:
          sources.store.find((s) => s.buildNumber === b.buildNumber)?.firstSeenAt ?? null,
      })),
      {
        artifacts: sources.artifacts,
        listing: sources.listing,
        ciLinked: sources.ciLinked,
        readsEnabled: sources.readsEnabled,
        packageId: app.identifier,
      },
    );
    store = list.store.map((b, i) => {
      const o = joined[i] as BuildOrigin;
      return {
        ...b,
        origin: {
          version: o.version,
          builtAt: o.builtAt,
          origin: o.origin,
          builtFrom: o.builtFrom,
          builtGap: o.builtGap,
          ciExpiredAt: o.ciExpiredAt,
          matchedBy: o.matchedBy,
          firstSeenAt: o.firstSeenAt,
          ci: o.ci ?? null,
        },
      };
    });
  } catch {
    // The origin is a help, never a reason to fail the list.
    store = bare(list.store);
  }
  scheduleBuildReads(ctx, { workspaceId: input.workspaceId, app, artifacts: list.artifacts });
  return { ...list, store };
}
