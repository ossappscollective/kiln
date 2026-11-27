import { type AssetDiffView, IMAGE_REF_TTL_MS, type Role, type StagedChangesView, type StoreImagesView } from '@kiln/core';
import type { Api } from '../api.ts';
import type { ProposalSummary } from '../asset-proposal-hint.ts';
import { assetFileUrl } from '../assets/assets.ts';
import { planFor, storeCacheKey, storeMediaCache } from '../assets/store-cache.ts';
import { stagedBlobUrl, storeFileUrl, storeThumbUrl } from '../assets/sync.ts';
import { settle } from '../bounded-read.ts';
import { t } from '../i18n/t.ts';
import { invalidate, onInvalidated, readFact, readKeys } from '../facts/invalidate.ts';
import { navSignals } from '../nav-signals.svelte.ts';
import { stagedStore } from '../staged-store.svelte.ts';
import type { AppSummary, AssetIndex } from '../types.ts';
import { appStateStore } from './app-state-store.svelte.ts';
import { type DerivedImages, deriveImagesFacts, type ImagesChannel, type ImagesFacts } from './store-images.ts';

/**
 * THE web store of the store's images (docs/state-model.md, "Store images"). Every surface that shows what the store holds (the Graphics
 * tab, the Assets tab, the comparison and pull dialogs, the Assets step of Prepare release, the staged tray, the attention list) reads it
 * HERE and nowhere else, and nothing else reads the endpoints behind it (`appStoreImages`, `appAssets`, `appAssetDiff`):
 *
 *  - `view`: the last read of the store (the server's `StoreImagesView`), kept per workspace, app and channel (`storeMediaCache`, the plain
 *    cache that `invalidate()` forgets on `sync`, `publish`, `release_created` and `store_read`);
 *  - `displays`, `problems` (the store as it IS: `checkStoreImages`), `predicted` and `problemsAfter` (the store AFTER the staged changes:
 *    `predictedImagesOf`, the same rule as the server's readiness), `side` (`storeSideOf`: the counts next to the repository's) and
 *    `graphicSets` (what the Graphics tab draws) are all DERIVED here from that one view and the staged view, with the core owners;
 *  - `readAt`: THE read clock, the server's time of the read (`view.readAt`). The comparison's `readAt`, the cache entry's age, the
 *    readiness' `storeReadAt` and the cart's `beforeReadAt` are not a second answer to "when was the store read";
 *  - `channel` (draft or live, App Store only): chosen here, so every surface asks the same version;
 *  - `checking`: a read is on its way.
 *
 * The thumbnails of a view are served by refs that the server forgets after `IMAGE_REF_TTL_MS`: a view older than that is dropped before
 * a read is started (a re-read is on its way) so no picture of it comes back as `ref_expired`.
 *
 * Driven by `invalidate()` events (`onInvalidated`): `invalidate` forgets the kept views itself, this file makes the screens read what
 * they show again. `.svelte.ts` because the derived facts are reactive.
 */

export type { ImagesChannel, ImagesFacts, PullChoice } from './store-images.ts';
export { stagedImageSetsOf } from './store-images.ts';
type AppRef = Pick<AppSummary, 'id' | 'platform'>;

const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;
const viewKey = (workspaceId: string, app: AppRef, channel: ImagesChannel) =>
  storeCacheKey(workspaceId, app.id, channel === 'live' ? `${app.platform}:live` : app.platform);

type ViewEntry = { checking: number; problem: string; generation: number };
const entries = new Map<string, ViewEntry>();
let tick = $state(0);
const bump = () => {
  tick += 1;
};
const channels = $state<Record<string, ImagesChannel | undefined>>({});

// `invalidate` has dropped the kept views: the facts read the cache again.
onInvalidated(bump);

/** The same view and staged view give the same answer, so a component that asks twice pays once. */
const memos = new Map<string, { view: StoreImagesView | null; staged: StagedChangesView | null; facts: DerivedImages }>();

function derive(workspaceId: string, app: AppRef, channel: ImagesChannel, view: StoreImagesView | null, staged: StagedChangesView | null): DerivedImages {
  const k = `${keyOf(workspaceId, app.id)}|${channel}`;
  const hit = memos.get(k);
  if (hit && hit.view === view && hit.staged === staged) return hit.facts;
  const facts = deriveImagesFacts({
    platform: app.platform,
    channel,
    view,
    staged,
    urls: {
      thumb: (ref) => storeThumbUrl(workspaceId, app.id, ref, 160),
      file: (ref) => storeFileUrl(workspaceId, app.id, ref),
      blob: (oid) => stagedBlobUrl(workspaceId, app.id, oid),
      repo: (path, commit) => assetFileUrl(workspaceId, app.id, path, commit),
    },
  });
  memos.set(k, { view, staged, facts });
  while (memos.size > 24) {
    const oldest = memos.keys().next().value;
    if (oldest === undefined) break;
    memos.delete(oldest);
  }
  return facts;
}

// The repository's side of the Assets tab and the comparison read, kept here too: no component reads `appAssets` or `appAssetDiff`.
type RepoEntry = { index: AssetIndex | null; loading: boolean; reloading: boolean; problem: string; generation: number };
type DiffEntry = { diff: AssetDiffView | null; loading: boolean; problem: string; generation: number };
const repos = $state<Record<string, RepoEntry | undefined>>({});
// The count of store asset changes the repository proposes for a release (the Releases list's line), per app.
const proposalSummaries = $state<Record<string, ProposalSummary | undefined>>({});
const proposalTokens: Record<string, number> = {};
const diffs = $state<Record<string, DiffEntry | undefined>>({});

/** What makes a kept comparison stale: the store was read, a push or a sync changed it, a version was created (`invalidate` forgets the read cache itself). */
const DIFF_EVENTS: readonly string[] = ['store_read', 'publish', 'sync', 'release_created'];
onInvalidated((i) => {
  if (DIFF_EVENTS.indexOf(i.event) === -1) return;
  if (i.appIds.length === 0) {
    for (const key of Object.keys(diffs)) if (key.indexOf(`${i.workspaceId}|`) === 0) diffs[key] = undefined;
    return;
  }
  for (const appId of i.appIds) diffs[keyOf(i.workspaceId, appId)] = undefined;
});

const describe = (e: unknown): string => (e instanceof Error && e.message ? e.message : t('assets:store.readFailedText'));

export const storeImagesStore = {
  // ---- The store's images -------------------------------------------------------------------

  /** The version on screen for an app (App Store: the draft Kiln edits, or the live one). Google Play always reads `editable`. */
  channel(workspaceId: string, appId: string): ImagesChannel {
    return channels[keyOf(workspaceId, appId)] ?? 'editable';
  },

  /** Everything the screens show about the store's images, derived from one view. Reactive. */
  of(workspaceId: string, app: AppRef, channel?: ImagesChannel): ImagesFacts {
    void tick;
    const ch = channel ?? storeImagesStore.channel(workspaceId, app.id);
    const key = viewKey(workspaceId, app, ch);
    const hit = storeMediaCache.get(key);
    const entry = entries.get(key);
    return {
      channel: ch,
      ...derive(workspaceId, app, ch, hit ? hit.view : null, stagedStore.view(app.id)),
      checking: entry !== undefined && entry.checking > 0,
      problem: entry === undefined ? '' : entry.problem,
    };
  },

  /**
   * Reads the store's images for an app unless a read younger than the freshness window is kept (`fresh` always asks). Stale while
   * revalidate: a kept view is shown at once and read again in the background; a view older than the life of its picture refs is dropped
   * first. `fresh` ("Read again") also judges what blocks a blocked submit against the same read (`recheck`). Never throws.
   */
  async load(
    api: Api,
    workspaceId: string,
    app: AppSummary,
    options: { fresh?: boolean; recheck?: boolean; role?: Role; channel?: ImagesChannel; now?: number } = {},
  ): Promise<void> {
    const channel = options.channel ?? storeImagesStore.channel(workspaceId, app.id);
    const key = viewKey(workspaceId, app, channel);
    const entry = entries.get(key) ?? { checking: 0, problem: '', generation: 0 };
    entries.set(key, entry);
    const mine = ++entry.generation;
    const now = options.now ?? Date.now();
    const kept = storeMediaCache.get(key);
    // Refs live `IMAGE_REF_TTL_MS` from the read: a view older than that would draw pictures that come back `ref_expired`.
    if (kept && Math.max(0, now - kept.view.readAt) >= IMAGE_REF_TTL_MS) {
      storeMediaCache.forgetApp(workspaceId, app.id);
      bump();
    }
    const current = storeMediaCache.get(key);
    if (options.fresh !== true && current !== undefined && planFor({ view: current.view, at: Math.min(now, current.view.readAt) }, now) === 'show') return;
    entry.checking += 1;
    entry.problem = '';
    bump();
    try {
      const done = await api.appStoreImages(workspaceId, app.id, options.fresh === true, channel);
      if (mine !== entry.generation) return;
      storeMediaCache.set(key, done.store);
      if (options.fresh === true) {
        // "Read again" asked the store: every number kept of its images is stale (the comparison is forgotten, the view just stored is
        // kept), and what blocks a blocked submit is judged against the same fresh read.
        void invalidate('store_read', { workspaceId, appId: app.id, keepGraphics: true, origin: 'graphics' });
        if (options.recheck !== false)
          void appStateStore.storeRead(api, workspaceId, app, options.role === undefined ? {} : { role: options.role });
      }
    } catch (e) {
      // What was shown stays shown (the page says that the read failed); only a first read has nothing to fall back on.
      if (mine === entry.generation) entry.problem = describe(e);
    } finally {
      entry.checking = Math.max(0, entry.checking - 1);
      bump();
    }
  },

  /** Picks the version on screen (the App Store's draft or live) and reads it. */
  pickChannel(api: Api, workspaceId: string, app: AppSummary, channel: ImagesChannel): void {
    if (storeImagesStore.channel(workspaceId, app.id) === channel) return;
    channels[keyOf(workspaceId, app.id)] = channel;
    bump();
    void storeImagesStore.load(api, workspaceId, app, { channel });
  },

  /** A different app starts on the draft again. */
  resetChannel(workspaceId: string, appId: string): void {
    channels[keyOf(workspaceId, appId)] = 'editable';
  },

  // ---- The repository's graphics (the Assets tab's index) ---------------------------------------

  repo(workspaceId: string, appId: string): { index: AssetIndex | null; loading: boolean; reloading: boolean; problem: string } {
    const e = repos[keyOf(workspaceId, appId)];
    return e === undefined
      ? { index: null, loading: true, reloading: false, problem: '' }
      : { index: e.index, loading: e.loading, reloading: e.reloading, problem: e.problem };
  },

  /** Reads the index of the repository's media. Resolves with the index (null on failure: `repo()` then holds the reason). */
  async loadRepo(api: Api, workspaceId: string, appId: string, describeError: (e: unknown) => string): Promise<AssetIndex | null> {
    const key = keyOf(workspaceId, appId);
    const prev = repos[key];
    const mine = (prev?.generation ?? 0) + 1;
    const had = prev?.index != null;
    repos[key] = { index: prev?.index ?? null, loading: !had, reloading: had, problem: '', generation: mine };
    try {
      const next = await api.appAssets(workspaceId, appId);
      if (repos[key]?.generation !== mine) return null;
      repos[key] = { index: next, loading: false, reloading: false, problem: '', generation: mine };
      return next;
    } catch (e) {
      if (repos[key]?.generation !== mine) return null;
      repos[key] = { index: prev?.index ?? null, loading: false, reloading: false, problem: describeError(e), generation: mine };
      return null;
    }
  },

  /** A different app or workspace starts clean. */
  forgetRepo(workspaceId: string, appId: string): void {
    repos[keyOf(workspaceId, appId)] = undefined;
  },

  /** The navigation's locale picker offers the locales found in the repository. */
  publishLocales(workspaceId: string, appId: string, locales: string[]): void {
    navSignals.setLocales(workspaceId, appId, locales);
  },

  // ---- The comparison of the repository with the store --------------------------------------

  /** The last comparison (its `readAt` is the store view's: the one read clock). Reactive. */
  diff(workspaceId: string, appId: string): { diff: AssetDiffView | null; loading: boolean; problem: string } {
    const e = diffs[keyOf(workspaceId, appId)];
    return e === undefined ? { diff: null, loading: false, problem: '' } : { diff: e.diff, loading: e.loading, problem: e.problem };
  },

  /**
   * Reads the comparison (one request at a time, kept for the read cache's time, forgotten by `invalidate`: `assetdiff/<app>`). A read
   * always ends (`settle`): as a comparison, or as a sentence in `diff().problem`.
   */
  async loadDiff(
    api: Api,
    workspaceId: string,
    appId: string,
    options: { fresh?: boolean; timeoutMessage: string; describeError: (e: unknown) => string },
  ): Promise<void> {
    const key = keyOf(workspaceId, appId);
    const prev = diffs[key];
    const mine = (prev?.generation ?? 0) + 1;
    diffs[key] = { diff: prev?.diff ?? null, loading: true, problem: '', generation: mine };
    const fresh = options.fresh === true;
    try {
      const out = await readFact('assetDiff', {
        workspaceId,
        key: readKeys.assetDiff(appId),
        ...(fresh ? { force: true } : {}),
        load: async () => {
          const got = await settle((signal) => api.appAssetDiff(workspaceId, appId, fresh, signal), { timeoutMessage: options.timeoutMessage });
          if (!got.ok) throw got.error;
          return got.value;
        },
      });
      if (diffs[key]?.generation === mine) diffs[key] = { diff: out.diff, loading: false, problem: '', generation: mine };
    } catch (e) {
      if (diffs[key]?.generation === mine)
        diffs[key] = { diff: prev?.diff ?? null, loading: false, problem: options.describeError(e), generation: mine };
    }
  },

  /**
   * Reads the comparison again whenever the store changed under it (`DIFF_EVENTS`: a "Read again", a push, a sync, a new version), for a
   * screen that shows it. Returns what stops the watching.
   */
  watchDiff(
    api: Api,
    workspaceId: string,
    appId: string,
    options: { timeoutMessage: string; describeError: (e: unknown) => string },
  ): () => void {
    return onInvalidated((i) => {
      if (i.workspaceId !== workspaceId || DIFF_EVENTS.indexOf(i.event) === -1) return;
      if (i.appIds.length > 0 && i.appIds.indexOf(appId) === -1) return;
      void storeImagesStore.loadDiff(api, workspaceId, appId, options);
    });
  },

  // ---- The repository's proposal for a release (what changed in the repository since the previous release) ------------------

  /** The count of proposed store asset changes of an app, or null (not read, no repository, nothing proposed). Reactive. */
  proposalSummary(workspaceId: string, appId: string): ProposalSummary | null {
    return proposalSummaries[keyOf(workspaceId, appId)] ?? null;
  },

  /** Reads that count (the server caches it); the last read of an app wins, a failure draws nothing. */
  async loadProposalSummary(api: Api, workspaceId: string, appId: string, hasRepository: boolean): Promise<void> {
    const key = keyOf(workspaceId, appId);
    const mine = (proposalTokens[key] ?? 0) + 1;
    proposalTokens[key] = mine;
    if (!hasRepository) {
      proposalSummaries[key] = undefined;
      return;
    }
    try {
      const r = await api.releaseAssetProposalSummary(workspaceId, appId);
      if (proposalTokens[key] === mine) proposalSummaries[key] = r.summary;
    } catch {
      if (proposalTokens[key] === mine) proposalSummaries[key] = undefined;
    }
  },

  /** Reads the full proposal for a release (bounded: it ends as a value or as an error, never hangs). Reads; stages nothing. */
  readProposal(
    api: Api,
    workspaceId: string,
    appId: string,
    release: Parameters<Api['releaseAssetProposal']>[2],
    options: { timeoutMessage: string },
  ) {
    return settle((signal) => api.releaseAssetProposal(workspaceId, appId, release, signal), { timeoutMessage: options.timeoutMessage });
  },

  // ---- The staged sets the images surfaces edit (the one door to the staged store for them) ------------

  stagedView(appId: string): StagedChangesView | null {
    return stagedStore.view(appId);
  },
  applyStaged(view: StagedChangesView): void {
    stagedStore.set(view);
  },
};
