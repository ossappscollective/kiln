import { isBlobReads } from '@mrm/connectors';
import { type AssetKind, assetStoreOf } from '@mrm/core';
import type { ManagedApp } from './apps.ts';
import {
  type AssetIndexView,
  type AssetSourceKind,
  BUDGETS,
  HEAD_BYTES,
  indexAssets,
  MAX_READ_FILE_BYTES,
  SOURCE_LABELS,
  specsView,
  totalsOf,
  viewOfAsset,
} from './asset-index.ts';
import { isCloneBacked } from './clone-reads.ts';
import { readListings } from './listing-sources.ts';
import { listListingTargets, resolveSelection } from './listing-targets.ts';
import { openRepoSnapshot } from './repo-snapshot.ts';
import {
  type Failure,
  failure,
  getRepository,
  githubFailure,
  type Opened,
  type Outcome,
  openConnectorForRepository,
  type RepoClient,
  type RepoContext,
  withTimeout,
} from './repositories.ts';

/**
 * The asset index of an app, read from its linked repository (docs/api/assets.md), and the bytes
 * of one listed file for the thumbnail route.
 *
 * Which repository and which folders: the app's `repository_id`, and within it the listing target
 * that names the app (a saved target whose `appId` is this app, else a detected `metadata/<app
 * id>/<platform>` target whose app id is this app's identifier, else what the listing read chose
 * by default). The same roots as the text listing. Reads are audited like every repository read
 * (`credential.use`, purpose `repository.assets`), a local clone needs no credential.
 *
 * Indexes are cached per repository commit (a commit never changes), the same idea as
 * repo-snapshot.ts. The cache key also holds what else decides the answer: the app, the kind of
 * read (all media, or only the icons) and the stamp of the saved target.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const ASSETS_PURPOSE = 'repository.assets';
/** Largest file the file route serves, in bytes. Bigger files are listed and refused (413). */
export const MAX_SERVED_BYTES = 8 * 1024 * 1024;

export type AssetScope = 'all' | 'icons';
const SCOPE_KINDS: Record<AssetScope, readonly AssetKind[] | undefined> = {
  all: undefined,
  icons: ['icon', 'app_icon'],
};

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const isCommitSha = (value: string): boolean => SHA.test(value);

const CACHE_MAX = 48;
const cache = new Map<string, AssetIndexView>();

/** For tests. */
export function clearAssetIndexes(): void {
  cache.clear();
  openedCache.clear();
}

const remember = (key: string, view: AssetIndexView) => {
  cache.delete(key);
  cache.set(key, view);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

/**
 * Opened connectors that are safe to share (the plain API connector takes its abort signal per
 * call), kept for a few seconds so a page of thumbnails is one credential use and not sixty.
 */
const OPENED_TTL_MS = 30_000;
const openedCache = new Map<string, { at: number; opened: Opened }>();

export type AssetsContext = { repo: RepoContext };

export type ServedFile =
  | { ok: true; bytes: Uint8Array; oid: string; size: number }
  | {
      ok: false;
      status: 404 | 413 | 422 | 429 | 502 | 504;
      error: string;
      message: string;
      headers?: Record<string, string>;
    };

export type AssetHandle = {
  view: AssetIndexView;
  /** The whole file at the commit of the view, up to `MAX_SERVED_BYTES`. Opens the repository when it has to. */
  readFile(path: string): Promise<ServedFile>;
};

const sourceKindOf = (connector: RepoClient): AssetSourceKind => {
  if (!isCloneBacked(connector)) return 'github_api';
  if (connector.reads.fallbacks.length > 0) return 'github_api';
  return connector.reads.origin === 'local' ? 'local_clone' : 'github_clone';
};

const budgetKindOf = (connector: RepoClient): AssetSourceKind =>
  isCloneBacked(connector)
    ? connector.reads.origin === 'local'
      ? 'local_clone'
      : 'github_clone'
    : 'github_api';

const emptyView = (app: ManagedApp, status: 'no_repository', now: number): AssetIndexView => ({
  appId: app.id,
  platform: app.platform,
  store: assetStoreOf(app.platform),
  repository: null,
  status,
  source: null,
  commit: null,
  readAt: now,
  target: null,
  folders: { screenshots: [], previews: [], androidImages: null },
  limits: limitsOf('github_api'),
  partial: { partial: false, reasons: [], skipped: 0 },
  totals: { assets: 0, read: 0, bytes: 0, errors: 0, warnings: 0, infos: 0, locales: 0 },
  locales: [],
  devices: [],
  sets: [],
  assets: [],
  problems: [],
  notes: [],
  specs: specsView(),
  storeSide: null,
});

const limitsOf = (kind: AssetSourceKind): AssetIndexView['limits'] => ({
  maxFiles: BUDGETS[kind].maxFiles,
  maxTransferBytes: BUDGETS[kind].maxTransferBytes,
  headBytes: HEAD_BYTES,
  maxFileBytes: MAX_READ_FILE_BYTES,
  maxServedBytes: MAX_SERVED_BYTES,
});

export type OpenAssetsInput = {
  workspaceId: string;
  app: ManagedApp;
  /** Read this commit (a full sha), not the branch tip. The file route passes the commit it was given. */
  commit?: string;
  scope?: AssetScope;
};

/**
 * The index of the app's media, from the cache when this commit was indexed before. Never throws
 * for a repository problem: that is a failure with a message to show.
 */
export async function openAssets(
  ctx: AssetsContext,
  input: OpenAssetsInput,
  actor: Actor,
  options: { onCompute?: () => Failure | undefined } = {},
): Promise<Outcome<{ handle: AssetHandle; cached: boolean }>> {
  const { repo } = ctx;
  const { workspaceId, app } = input;
  const scope = input.scope ?? 'all';
  const nothing = async (): Promise<ServedFile> => ({
    ok: false,
    status: 404,
    error: 'not_found',
    message: 'No such file.',
  });
  if (!app.repositoryId) {
    return {
      ok: true,
      cached: false,
      handle: { view: emptyView(app, 'no_repository', repo.now()), readFile: nothing },
    };
  }
  const repository = await getRepository(repo.db, workspaceId, app.repositoryId);
  if (!repository) {
    return {
      ok: true,
      cached: false,
      handle: { view: emptyView(app, 'no_repository', repo.now()), readFile: nothing },
    };
  }
  const targets = await listListingTargets(repo.db, workspaceId, repository.id);
  const mine = targets.find((t) => t.appId === app.id);
  const stamp = `${mine ? `${mine.id}:${mine.updatedAt}` : '-'}|${app.identifier}|${app.name}`;
  const keyFor = (commit: string) => `${repository.id}@${commit}|${app.id}|${scope}|${stamp}`;

  // The connector is opened when it is first needed (a cache hit may never need it).
  let opened: Outcome<Opened> | undefined;
  let controller = new AbortController();
  const open = async (purpose: string): Promise<Outcome<Opened>> => {
    if (opened) return opened;
    const key = `${workspaceId}|${repository.id}|${purpose}`;
    const shared = openedCache.get(key);
    if (shared && repo.now() - shared.at < OPENED_TTL_MS) {
      opened = { ok: true, ...shared.opened };
      return opened;
    }
    opened = await openConnectorForRepository(repo, workspaceId, repository, actor, purpose);
    if (opened.ok && !isCloneBacked(opened.connector)) {
      openedCache.set(key, {
        at: repo.now(),
        opened: {
          connector: opened.connector,
          secret: opened.secret,
          ...(opened.kind ? { kind: opened.kind } : {}),
        },
      });
      while (openedCache.size > 16) {
        const oldest = openedCache.keys().next().value;
        if (oldest === undefined) break;
        openedCache.delete(oldest);
      }
    }
    return opened;
  };

  const readFile =
    (commit: string) =>
    async (path: string): Promise<ServedFile> => {
      const o = await open(`${ASSETS_PURPOSE}`);
      if (!o.ok)
        return {
          ok: false,
          status: o.status === 404 ? 404 : 502,
          error: o.body.error,
          message: String(o.body.message ?? o.body.error),
        };
      const { connector, secret } = o;
      if (!isBlobReads(connector)) {
        return {
          ok: false,
          status: 422,
          error: 'unreadable',
          message: 'This repository connection cannot read binary files.',
        };
      }
      const abort = new AbortController();
      if (isCloneBacked(connector)) connector.useSignal(abort.signal);
      try {
        const read = await withTimeout(
          connector.readBlobHeads([path], {
            ref: commit,
            headBytes: MAX_SERVED_BYTES,
            maxFileBytes: MAX_SERVED_BYTES,
            maxTransferBytes: MAX_SERVED_BYTES + 1,
            signal: abort.signal,
          }),
          repo.timeoutMs,
          () => abort.abort(),
        );
        const item = read.items.get(path);
        if (!item || (!item.ok && item.reason === 'missing'))
          return {
            ok: false,
            status: 404,
            error: 'not_found',
            message: 'No such file at that commit.',
          };
        if (!item.ok) {
          return item.reason === 'too_large'
            ? {
                ok: false,
                status: 413,
                error: 'too_large',
                message: `The file is larger than ${MAX_SERVED_BYTES / (1024 * 1024)} MB and is not served.`,
              }
            : {
                ok: false,
                status: 502,
                error: 'unavailable',
                message: 'The file could not be read.',
              };
        }
        return { ok: true, bytes: item.head, oid: item.oid, size: item.size };
      } catch (error) {
        const f = githubFailure(error, secret);
        return {
          ok: false,
          status: f.status === 504 ? 504 : f.status === 429 ? 429 : 502,
          error: f.body.error,
          message: String(f.body.message ?? f.body.error),
          ...(f.headers ? { headers: f.headers } : {}),
        };
      }
    };

  if (input.commit && isCommitSha(input.commit)) {
    const hit = cache.get(keyFor(input.commit));
    if (hit)
      return { ok: true, cached: true, handle: { view: hit, readFile: readFile(input.commit) } };
  }

  const o = await open(ASSETS_PURPOSE);
  if (!o.ok) return o;
  const { connector, secret } = o;
  controller = new AbortController();
  if (isCloneBacked(connector)) connector.useSignal(controller.signal);
  const blobs = isBlobReads(connector) ? connector : undefined;
  const budgetKind = budgetKindOf(connector);

  try {
    const result = await withTimeout(
      (async () => {
        const snapshot = await openRepoSnapshot({
          repositoryId: repository.id,
          connector,
          branch: input.commit ?? repository.defaultBranch,
          now: repo.now,
          signal: controller.signal,
        });
        const commit = snapshot.ref;
        const cacheable = isCommitSha(commit);
        if (cacheable) {
          const hit = cache.get(keyFor(commit));
          if (hit) return { view: hit, cached: true as const };
        }
        // A miss: this is the read that costs (file headers). Only it counts against the limit.
        const blocked = options.onCompute?.();
        if (blocked) return { blocked };
        // The same roots as the text listing: the saved target of the app, else the one the listing read chose.
        const chosen = await resolveSelection(
          repo.db,
          workspaceId,
          repository.id,
          mine ? { target: mine.id } : undefined,
        );
        if (!chosen.ok) throw new Error(chosen.message);
        const listings = await readListings(snapshot.files, snapshot.read, {
          ...(chosen.roots ? { roots: chosen.roots } : {}),
          ignoreExpoConfig: chosen.ignoreExpoConfig,
        });
        let roots = listings.fastlane.roots;
        let target: { id: string | null; label: string } = mine
          ? { id: mine.id, label: mine.name }
          : { id: null, label: 'Detected folders' };
        if (!mine) {
          const auto = listings.fastlane.targets.find(
            (t) => t.app?.toLowerCase() === app.identifier.toLowerCase(),
          );
          if (auto) {
            roots = {
              appStore: auto.roots.appStore ?? '',
              googlePlay: auto.roots.googlePlay ?? '',
            };
            target = { id: `auto:${auto.key}`, label: auto.label };
          }
        }
        const index = await indexAssets({
          app,
          files: snapshot.files,
          readText: snapshot.read,
          blobs,
          commit,
          roots,
          budget: BUDGETS[budgetKind],
          ...(SCOPE_KINDS[scope] ? { kinds: SCOPE_KINDS[scope] } : {}),
          signal: controller.signal,
        });
        const kind = sourceKindOf(connector);
        const view: AssetIndexView = {
          appId: app.id,
          platform: app.platform,
          store: assetStoreOf(app.platform),
          repository: { id: repository.id, name: repository.name },
          status: 'ok',
          source: { kind, label: SOURCE_LABELS[kind], fast: kind === 'local_clone' },
          commit,
          readAt: repo.now(),
          target: {
            ...target,
            roots: { appStore: roots.appStore || null, googlePlay: roots.googlePlay || null },
          },
          folders: index.folders,
          limits: limitsOf(budgetKind),
          partial: index.partial,
          totals: totalsOf(index),
          locales: [
            ...new Set(index.assets.filter((a) => a.origin === 'store').map((a) => a.locale)),
          ].sort(),
          devices: [
            ...new Map(
              index.assets
                .filter((a) => a.device !== null)
                .map((a) => [a.device as string, viewOfAsset(a).deviceLabel]),
            ).entries(),
          ].map(([id, label]) => ({ id, label })),
          sets: index.sets,
          assets: index.assets.map(viewOfAsset),
          problems: index.problems,
          notes: [...listingNotes(listings.fastlane.warnings), ...index.notes],
          specs: specsView(),
          storeSide: null,
        };
        if (cacheable) remember(keyFor(commit), view);
        return { view, cached: false as const };
      })(),
      repo.timeoutMs,
      () => controller.abort(),
    );
    if ('blocked' in result) return result.blocked as Failure;
    return {
      ok: true,
      cached: result.cached,
      handle: { view: result.view, readFile: readFile(result.view.commit ?? input.commit ?? '') },
    };
  } catch (error) {
    return githubFailure(error, secret);
  }
}

/** Warnings of the listing read that matter here: none yet (they are about text files). */
const listingNotes = (_warnings: readonly string[]): string[] => [];

export { failure };
