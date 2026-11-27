<!--
  AssetsTab: the store media found in the app's repository, in three groups (icon, Google Play graphics,
  screenshots), by locale and device, checked against the sizes and counts the stores document. Each
  file shows its status next to the store (in repo, in repo and store, differs) and its spec problems.
  Nothing is written to a store from here, and reading a store happens only when asked ("Compare with the store",
  "Pull from store"). "Stage for store" collects the files of a set (a locale, a kind, a device) of the repository in
  the staged-changes tray (our own database; the files are kept by reference and read at push time); the tray pushes
  them to the store's DRAFT. "Edit files" replaces, removes, fixes and adds the files of a set; those changes are staged
  the same way, and "Put into the repository" makes a draft change set of them. "Pull from store" downloads the store's
  current images into a draft change set. A set with a spec error, a file the stores' push cannot take, or a kind the
  stores' APIs cannot write is not stageable, with the reason. The images are served from the repository by the app's own
  file route, and the store's by a proxy of the server.
  Props: api, workspaceId, role, app, now (ms), refreshKey (changes when a sync finished, so this
  tab reads again), storeSide? (the seam for the store side: the counts the store has per locale,
  kind and device. Left out, the tab uses the one in the index, which is null today, so each set
  says "Not yet compared with the store"), locked? (the selected version is live or in review: no staging, no file
  editing and no tray; the images, the comparison with the store and the pull stay), locale? (the locale of the
  page header, which narrows the sets to it; the tab's own Locale select writes it back to the address).
  The locales found are handed to the header picker (lib/nav-signals.svelte.ts).
  States: loading, error (with retry), no repository linked, no media found (with the folders that
  were searched), partial (a limit was reached: it says what was left out), ready.
-->
<script lang="ts">
  import { type AssetDiffView, type AssetKind, type Role, type StoreImagesView, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { replaceHash } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { withHeaderParams } from '../../lib/app-header.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import {
    ALL,
    NO_FILTER,
    type AssetFilter,
    assetFileUrl,
    filterOptions,
    groupAssets,
    isFiltered,
    kindLabel,
    previewNote,
    previewState,
    problemCountsText,
    problemsByPath,
    sanitizeFilter,
    summaryText,
  } from '../../lib/assets/assets.ts';
  import {
    type AssetGroupId,
    asGroupId,
    defaultGroup,
    groupAvailability,
    groupDef,
    groupOfKind,
    groupSummaries,
    sliceIndex,
  } from '../../lib/assets/groups.ts';
  import { SYNC_ROLE_REASON, type EditorSet, canChangeAssets, setIdOf, storeKeyOf } from '../../lib/assets/sync.ts';
  import { assetsLead, otherCountsText, splitProblems } from '../../lib/assets/lead.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { planFor, storeCacheKey, storeMediaCache } from '../../lib/assets/store-cache.ts';
  import { invalidate, onInvalidated } from '../../lib/facts/invalidate.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { describeError } from '../../lib/portfolio.ts';
  import { reverseImageSyncNote, stageRoleReason, canStage, setStaging, stageAssetsBody, stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { DeviceGroup } from '../../lib/assets/assets.ts';
  import type { AppSummary, AssetIndex, AssetItem, AssetStoreSide } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import AssetCompareDialog from './AssetCompareDialog.svelte';
  import AssetGallery from './AssetGallery.svelte';
  import StoreGraphics from './StoreGraphics.svelte';
  import AssetLightbox from './AssetLightbox.svelte';
  import AssetProblemLines from './AssetProblemLines.svelte';
  import AssetProblems from './AssetProblems.svelte';
  import AssetPullDialog from './AssetPullDialog.svelte';
  import AssetSetEditor from './AssetSetEditor.svelte';
  import AssetSource from './AssetSource.svelte';
  import StagedTray from '../listing/StagedTray.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    now,
    refreshKey,
    storeSide = undefined,
    locked = false,
    locale = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    now: number;
    refreshKey: number;
    storeSide?: AssetStoreSide | null | undefined;
    locked?: boolean | undefined;
    locale?: string | null | undefined;
  } = $props();

  const allowed = $derived(can(role, 'listing.read'));

  /** "Screenshots iPhone (en-US)": the set a message is about. */
  const setLabel = (kind: string, device: string, locale: string) =>
    device ? t('assets:tab.setTitleDevice', { kind, device, locale }) : t('assets:tab.setTitle', { kind, locale });
  const NONE_FOUND: Record<AssetGroupId, string> = {
    icon: k('assets:tab.noneFound.icon'),
    play_graphics: k('assets:tab.noneFound.playGraphics'),
    screenshots: k('assets:tab.noneFound.screenshots'),
  };

  // What the store holds (read only, the cached read of the last minute) and whether the app compares the repository's graphics with it
  // (app listing settings, default off). Off: the store's graphics are the page; the repository's are not shown next to them.
  let storeView = $state<StoreImagesView | null>(null);
  let storeProblem = $state('');
  let storeReloading = $state(false);
  let compareMedia = $state(false);
  let storeGeneration = 0;
  /** App Store: the draft version (default, what Kiln edits) or the live version (read only). Google Play ignores it. */
  let storeChannel = $state<'editable' | 'live'>('editable');
  const channelKey = (platform: string) => (storeChannel === 'live' ? `${platform}:live` : platform);
  function pickChannel(next: 'editable' | 'live') {
    if (next === storeChannel) return;
    storeChannel = next;
    storeView = storeMediaCache.get(storeCacheKey(workspaceId, app.id, channelKey(app.platform)))?.view ?? null;
    void loadStore(false);
  }

  // Stale while revalidate: the last read of this app and platform is kept for the session (lib/assets/store-cache.ts), so coming back
  // shows it at once and asks again in the background; a failed read keeps what is shown. A publish drops it.
  async function loadStore(fresh: boolean, recheck = true) {
    if (!allowed) return;
    const mine = ++storeGeneration;
    const channel = storeChannel;
    const key = storeCacheKey(workspaceId, app.id, channelKey(app.platform));
    const hit = storeMediaCache.get(key);
    if (hit && storeView !== hit.view) storeView = hit.view;
    const recent = !fresh && planFor(hit, Date.now()) === 'show';
    storeReloading = !recent;
    storeProblem = '';
    try {
      const [done, settings] = await Promise.all([
        recent ? Promise.resolve(null) : api.appStoreImages(workspaceId, app.id, fresh, channel),
        api.appListingSettings(workspaceId, app.id).catch(() => null),
      ]);
      if (mine !== storeGeneration) return;
      if (done && channel === storeChannel) {
        storeView = done.store;
        storeMediaCache.set(key, done.store);
      }
      // "Read again" asked the store: every number that was kept of its images is stale. The comparison of the release step is forgotten and
      // the counts next to the repository's (`storeSide`, the same read on the server) are read again, so one read of the draft feeds them all.
      if (done && fresh) {
        void invalidate('store_read', { workspaceId, appId: app.id, keepGraphics: true, origin: 'graphics' });
        void api
          .appAssets(workspaceId, app.id)
          .then((next) => {
            if (index !== null && mine === storeGeneration) index = { ...index, storeSide: next.storeSide };
          })
          .catch(() => {});
      }
      // "Read again" asked the store: what blocks a blocked submit is judged against the same fresh read (the server dropped its caches too).
      if (done && fresh && recheck) void appStateStore.storeRead(api, workspaceId, app, { role });
      if (settings) compareMedia = settings.settings.compareMedia;
    } catch (e) {
      if (mine !== storeGeneration) return;
      // What was shown stays shown (the page says that the read failed); only a first read has nothing to fall back on.
      storeProblem = describeStoreRead(e);
      const settings = await api.appListingSettings(workspaceId, app.id).catch(() => null);
      if (mine === storeGeneration && settings) compareMedia = settings.settings.compareMedia;
    } finally {
      if (mine === storeGeneration) storeReloading = false;
    }
  }
  const describeStoreRead = (e: unknown): string => (e instanceof Error && e.message ? e.message : t('assets:store.readFailedText'));

  let index = $state<AssetIndex | null>(null);
  let loading = $state(true);
  let reloading = $state(false);
  let loadProblem = $state('');
  let filter = $state<AssetFilter>({ ...NO_FILTER });
  let group = $state<string>('screenshots');
  /** The group picked by the tab itself; a different `group` means the person chose one, which a re-read keeps. */
  let autoGroup: AssetGroupId | null = null;
  let announcement = $state('');
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);
  /** The id of the set being staged or unstaged (`locale/slotKey`), or ''. One at a time. */
  let stagingId = $state('');
  let stagingAll = $state(false);

  let generation = 0;

  async function load() {
    if (!allowed) return;
    const mine = ++generation;
    if (index === null) loading = true;
    else reloading = true;
    loadProblem = '';
    try {
      const next = await api.appAssets(workspaceId, app.id);
      if (mine !== generation) return;
      index = next;
      // The first read opens the group that has files; a later read keeps the person's choice.
      if (autoGroup === null || group === autoGroup) {
        autoGroup = defaultGroup(groupSummaries(next, app.platform));
        group = autoGroup;
      }
      filter = { ...NO_FILTER };
      announcement = t('assets:tab.announceRead', { count: next.totals.assets, problems: problemCountsText(next) });
    } catch (e) {
      if (mine !== generation) return;
      loadProblem = describeError(e, 'load');
    } finally {
      if (mine === generation) {
        loading = false;
        reloading = false;
      }
    }
  }

  let shownFor = '';
  // A different app or workspace starts clean; a different app, workspace or finished sync reads.
  $effect(() => {
    void refreshKey;
    const key = `${workspaceId}/${app.id}`;
    if (key !== shownFor) {
      shownFor = key;
      storeChannel = 'editable';
      storeView = storeMediaCache.get(storeCacheKey(workspaceId, app.id, app.platform))?.view ?? null;
      index = null;
      filter = { ...NO_FILTER };
      autoGroup = null;
      lightboxOpen = false;
    }
    untrack(() => {
      void load();
      void loadStore(false);
    });
  });

  // A publish, a sync, a new version or somebody else's store read changed what the store holds (`invalidate` dropped what was kept): read it again.
  $effect(() => {
    const appId = app.id;
    return onInvalidated((i) => {
      if (i.origin === 'graphics' || !i.appIds.includes(appId)) return;
      if (i.event !== 'publish' && i.event !== 'store_read' && i.event !== 'sync' && i.event !== 'release_created') return;
      // A sync or "Check again" already told the model about the new reading: only the pictures are read again here.
      void loadStore(true, i.event === 'publish');
    });
  });

  // The locales found are what the header picker offers; the header's locale narrows the sets (and back).
  $effect(() => {
    if (index) navSignals.setLocales(workspaceId, app.id, [...new Set(index.assets.map((a) => a.locale))]);
  });
  $effect(() => {
    const want = locale ?? ALL;
    const found = index;
    untrack(() => {
      const known = want === ALL || (found !== null && found.assets.some((a) => a.locale === want));
      if (found !== null && known && filter.locale !== want) filter = { ...filter, locale: want };
    });
  });
  const writeLocale = (value: string) => replaceHash(withHeaderParams(location.hash, { locale: value === ALL ? null : value }));

  const summaries = $derived(index ? groupSummaries(index, app.platform) : []);
  const slice = $derived(index ? sliceIndex(index, asGroupId(group)) : { assets: [], sets: [], problems: [] });
  const options = $derived(filterOptions(slice));
  // A choice the group does not offer (after switching group or reading again) counts as "all".
  const active = $derived(sanitizeFilter(filter, options));
  const groups = $derived(groupAssets(slice, active));
  /** The filters of the toolbar are drawn when the open group is on this store and has files. */
  const groupShown = $derived(groupAvailability(asGroupId(group), app.platform).available && (summaries.filter((g) => g.id === group)[0]?.files ?? 0) > 0);
  const problemMap = $derived(index ? problemsByPath(index.problems) : {});
  const shownAssets = $derived(groups.reduce((all: AssetItem[], locale) => {
    for (const group of locale.groups) for (const asset of group.assets) all.push(asset);
    return all;
  }, []));
  const maxServed = $derived(index?.limits.maxServedBytes ?? 0);
  const seam = $derived(storeSide !== undefined ? storeSide : (index?.storeSide ?? null));

  const urlFor = (asset: AssetItem) =>
    index && previewState(asset, maxServed) === 'image' ? assetFileUrl(workspaceId, app.id, asset.path, index.commit) : null;
  const stateFor = (asset: AssetItem) => previewState(asset, maxServed);
  const noteFor = (state: ReturnType<typeof previewState>) => previewNote(state, maxServed);

  function openAsset(asset: AssetItem) {
    const at = shownAssets.findIndex((a) => a.path === asset.path);
    if (at < 0) return;
    lightboxIndex = at;
    lightboxOpen = true;
  }

  function openPath(path: string) {
    const target = index?.assets.find((a) => a.path === path);
    if (!target) return;
    // The problem may be about a file in another group or one the filter hides: show it, then open it.
    group = groupOfKind(target.kind);
    filter = { ...NO_FILTER };
    queueMicrotask(() => openAsset(target));
  }

  const problemsOfFile = (asset: AssetItem) => problemMap[asset.path] ?? [];

  const stagedView = $derived(stagedStore.view(app.id));
  const stageFor = (locale: string, set: DeviceGroup) =>
    setStaging({
      role,
      platform: app.platform,
      locale,
      kind: set.kind,
      device: set.device,
      assets: set.assets,
      setProblems: set.setProblems,
      problemsByPath: problemMap,
      commit: index?.commit ?? null,
      view: stagedView,
    });
  /** The sets of the groups on screen (the filter applies) that "Stage all" would stage: stageable and not staged as they are. */
  const stageableShown = $derived(
    groups.reduce((all: { locale: string; set: DeviceGroup }[], locale) => {
      for (const set of locale.groups) {
        const st = stageFor(locale.locale, set);
        if (st.canStage && st.stagedState !== 'current') all.push({ locale: locale.locale, set });
      }
      return all;
    }, []),
  );

  /** Stages one set's repository files for the draft push. Returns '' on success, else the reason it failed. */
  async function stageOne(locale: string, set: DeviceGroup): Promise<string> {
    const st = stageFor(locale, set);
    if (!st.canStage) return st.reason ?? t('assets:tab.cannotStage');
    try {
      const done = await api.stageAssets(workspaceId, app.id, stageAssetsBody(locale, set.kind, set.device, st.paths, index?.commit ?? null));
      stagedStore.set(done.staged);
      return '';
    } catch (e) {
      return stagingError(e);
    }
  }

  async function stageSet(locale: string, set: DeviceGroup) {
    if (stagingId !== '' || stagingAll) return;
    stagingId = stageFor(locale, set).id;
    const problem = await stageOne(locale, set);
    stagingId = '';
    if (problem === '') {
      announcement = t('assets:tab.announceStaged', { set: setLabel(set.kindLabel, set.deviceLabel, locale) });
      toast.success(t('assets:tab.toastStaged', { set: setLabel(set.kindLabel, set.deviceLabel, locale) }));
    } else toast.error(problem);
  }

  async function unstageSet(id: string) {
    if (stagingId !== '' || stagingAll) return;
    stagingId = id;
    try {
      const done = await api.unstageItem(workspaceId, app.id, id);
      stagedStore.set(done.staged);
      announcement = t('assets:tab.announceUnstaged');
    } catch (e) {
      toast.error(stagingError(e));
    } finally {
      stagingId = '';
    }
  }

  async function stageAll() {
    if (stagingId !== '' || stagingAll || stageableShown.length === 0) return;
    stagingAll = true;
    let done = 0;
    let problem = '';
    for (const item of stageableShown) {
      problem = await stageOne(item.locale, item.set);
      if (problem !== '') break;
      done += 1;
    }
    stagingAll = false;
    if (problem === '') toast.success(t('assets:tab.toastStagedMany', { count: done }));
    else toast.error(t('assets:tab.toastStagedStopped', { count: stageableShown.length, done, problem }));
  }

  // ---- Two way sync: pull, compare, edit the files of a set, bulk actions ------------------------------
  type Picked = { id: string; locale: string; kind: AssetKind; device: string | null };
  let pullOpen = $state(false);
  let pullSets = $state<string[] | null>(null);
  let compareOpen = $state(false);
  let compareFocus = $state<{ locale: string; kind: AssetKind; device: string | null } | null>(null);
  let editorOpen = $state(false);
  let editorKey = $state<{ locale: string; kind: AssetKind; device: string | null } | null>(null);
  let diff = $state<AssetDiffView | null>(null);
  let selection = $state<Picked[]>([]);
  let bulkBusy = $state(false);

  const mayChange = $derived(canChangeAssets(role));
  const selectedIds = $derived(selection.map((p) => p.id));
  const allGroups = $derived(index ? groupAssets(index, NO_FILTER) : []);
  const editorSet = $derived<EditorSet | null>(
    editorKey && index
      ? (() => {
          const key = editorKey;
          const files = index.assets
            .filter((a) => a.locale === key.locale && a.kind === key.kind && a.device === key.device)
            .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
          const device = files.length > 0 ? (files[0]?.deviceLabel ?? '') : '';
          return { ...key, title: setLabel(kindLabel(key.kind), key.device !== null ? device : '', key.locale), files, commit: index.commit };
        })()
      : null,
  );

  function toggleSelected(locale: string, set: DeviceGroup) {
    const id = setIdOf(locale, set.kind, set.device);
    selection = selectedIds.indexOf(id) !== -1 ? selection.filter((p) => p.id !== id) : [...selection, { id, locale, kind: set.kind, device: set.device }];
  }

  function openEditor(locale: string, set: DeviceGroup) {
    editorKey = { locale, kind: set.kind, device: set.device };
    editorOpen = true;
  }

  function openCompare(locale: string, set: DeviceGroup | null) {
    compareFocus = set ? { locale, kind: set.kind, device: set.device } : null;
    compareOpen = true;
  }

  function compareFromEditor() {
    if (!editorKey) return;
    compareFocus = { ...editorKey };
    editorOpen = false;
    compareOpen = true;
  }

  function pullFromStore(sets: string[] | null) {
    pullSets = sets;
    pullOpen = true;
  }

  async function stageSelected() {
    if (bulkBusy || stagingId !== '' || stagingAll || selection.length === 0) return;
    bulkBusy = true;
    let done = 0;
    const left: string[] = [];
    let problem = '';
    for (const pick of selection) {
      let found: DeviceGroup | null = null;
      for (const l of allGroups) {
        if (l.locale !== pick.locale) continue;
        for (const g of l.groups) if (g.kind === pick.kind && g.device === pick.device) found = g;
      }
      if (!found) {
        left.push(pick.id);
        continue;
      }
      const st = stageFor(pick.locale, found);
      if (!st.canStage) {
        left.push(pick.id);
        continue;
      }
      problem = await stageOne(pick.locale, found);
      if (problem !== '') break;
      done += 1;
    }
    bulkBusy = false;
    selection = selection.filter((p) => left.indexOf(p.id) !== -1);
    if (problem !== '') toast.error(t('assets:tab.toastBulkStopped', { count: done, problem }));
    else if (left.length > 0) toast.warning(t('assets:tab.toastBulkLeft', { count: left.length, done }));
    else toast.success(t('assets:tab.toastStagedMany', { count: done }));
  }
  const searched = $derived(index ? [...index.folders.screenshots, ...index.folders.previews, ...(index.folders.androidImages ? [index.folders.androidImages] : [])] : []);
  const problemSplit = $derived(splitProblems(index?.problems ?? []));
  const lead = $derived(index ? assetsLead({ problems: index.problems, summary: summaryText(index) }) : null);
  /** Stage is the one primary of the page when nothing blocks; with a blocking problem the problems come first and it stays quiet. */
  const stagePrimary = $derived(lead !== null && lead.blocking === 0 && stageableShown.length > 0);
</script>

<div class="stack assets" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if allowed}
    <StoreGraphics {api} {workspaceId} {role} {app} {now} {locked} view={storeView} problem={storeProblem} reloading={storeReloading} onreload={() => loadStore(true)} channel={storeChannel} onchannel={pickChannel} />
  {/if}

  {#if !allowed}
    <div class="card">
      <EmptyState icon="lock" title={t('assets:tab.noAccess')} description={t('assets:tab.noAccessText')} />
    </div>
  {:else if !compareMedia}
    {#if !locked}<StagedTray {api} {workspaceId} {role} members={[app]} />{/if}
    {#if index && index.status !== 'no_repository' && index.assets.length > 0}
      <p class="muted">{t('assets:store.repoHidden', { count: index.assets.length })}</p>
    {/if}
  {:else if loading && !index}
    <div role="status" aria-label={t('assets:tab.reading')}>
      <Skeleton width="50%" height="16px" />
      <div class="card"><div class="stack"><Skeleton width="30%" height="16px" /><Skeleton width="100%" height="180px" /></div></div>
    </div>
  {:else if loadProblem && !index}
    <div class="stack">
      <Alert tone="error" title={t('assets:tab.readFailed')}>{loadProblem}</Alert>
      <div class="row"><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if index}
    {#if loadProblem}
      <Alert tone="error" title={t('assets:tab.rereadFailed')}>{t('assets:tab.rereadFailedText', { problem: loadProblem })}</Alert>
    {/if}

    {#if !locked}<StagedTray {api} {workspaceId} {role} members={[app]} />{/if}

    {#if index.status === 'no_repository'}
      <div class="card">
        <EmptyState
          icon="repo"
          title={t('assets:tab.noRepo')}
          description={t('assets:tab.noRepoText')}
        >
          {#snippet actions()}
            <Button href="#/repositories" variant="primary" icon="repo">{t('assets:tab.goRepos')}</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <section aria-label={t('assets:tab.sourceLabel')} class="sourcebar">
        <AssetSource {index} {now} {reloading} onreload={load} />
      </section>

      {#if index.partial.partial}
        <Alert tone="warn" title={t('assets:tab.partial')}>
          <ul class="plain">
            {#each index.partial.reasons as reason (reason)}<li>{reason}</li>{/each}
          </ul>
          <p class="alert-text">
            {index.source?.fast ? t('assets:tab.partialFast') : t('assets:tab.partialSlow')}
          </p>
        </Alert>
      {/if}

      {#each index.notes as note (note)}
        <Alert tone="info">{note}</Alert>
      {/each}

      {#if index.assets.length === 0}
        <div class="card">
          <EmptyState
            icon="images"
            title={t('assets:tab.noMedia')}
            description={index.target ? t('assets:tab.noMediaTarget', { target: index.target.label }) : t('assets:tab.noMediaText')}
          >
            {#snippet actions()}
              {#if searched.length > 0}
                <p class="muted searched">{t('assets:tab.searched', { paths: formatList(searched, { type: 'unit' }) })}</p>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        {#if lead}
          <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="assets-lead">
            {#snippet aside()}
              <span class="row wrap staging">
                <SectionsToggle />
                <InfoTip label={t('assets:tab.aboutStaging')} buttonText={t('assets:tab.aboutStaging')} align="start" width="24rem">
                  <p>{t('assets:tab.stagingAbout', { note: reverseImageSyncNote() })}</p>
                </InfoTip>
              </span>
            {/snippet}
            {#snippet actions()}
              <div class="row wrap staging" role="group" aria-label={t('assets:tab.summaryLabel')}>
                {#if !locked}
                <Button
                  variant={stagePrimary ? 'primary' : 'secondary'}
                  icon="layers"
                  loading={stagingAll}
                  disabled={stageableShown.length === 0 || stagingId !== '' || stagingAll}
                  title={!canStage(role) ? stageRoleReason() : stageableShown.length === 0 ? t('assets:tab.nothingToStage') : undefined}
                  onclick={stageAll}
                >{stageableShown.length > 0 ? t('assets:tab.stageShown', { count: stageableShown.length }) : t('assets:gallery.stageForStore')}</Button>
                {/if}
                <Button icon="eye" onclick={() => openCompare('', null)} title={t('assets:tab.compareHint')}>{t('assets:gallery.compare')}</Button>
                <Button icon="download" disabled={!mayChange} title={!mayChange ? t(SYNC_ROLE_REASON) : t('assets:tab.pullHint')} onclick={() => pullFromStore(null)}>{t('assets:tab.pullFromStore')}</Button>
              </div>
            {/snippet}
          </PageLead>
        {/if}

        {#if selection.length > 0}
          <section class="bulk" aria-label={t('assets:tab.selectedLabel')}>
            <span><T key="assets:tab.selected" params={{ count: selection.length }} /></span>
            {#if !locked}<Button size="sm" icon="layers" loading={bulkBusy} disabled={bulkBusy || stagingAll || stagingId !== '' || !canStage(role)} title={!canStage(role) ? stageRoleReason() : undefined} onclick={stageSelected}>{t('assets:tab.stageSelected')}</Button>{/if}
            <Button size="sm" icon="download" disabled={bulkBusy || !mayChange} title={!mayChange ? t(SYNC_ROLE_REASON) : t('assets:tab.pullSelectedHint')} onclick={() => pullFromStore(selection.map((p) => storeKeyOf(app.platform, p.locale, p.kind, p.device)))}>{t('assets:tab.pullSelected')}</Button>
            <Button size="sm" variant="ghost" disabled={bulkBusy} onclick={() => (selection = [])}>{t('assets:tab.clearSelection')}</Button>
          </section>
        {/if}

        {#if problemSplit.blocking.length > 0}
          <section class="blocking" aria-label={t('assets:problems.toFix')}>
            <AssetProblemLines problems={problemSplit.blocking} onopenpath={openPath} />
          </section>
        {/if}

        {#if problemSplit.other.length > 0}
          <Section title={t('assets:problems.label')} key="problems" count={problemSplit.other.length} summary={otherCountsText(problemSplit.other)} defaultOpen={false}>
            <div class="problem-list"><AssetProblems problems={problemSplit.other} onopenpath={openPath} /></div>
          </Section>
        {/if}

        {#if groupShown}
          <div class="filters">
            <div class="field">
              <label for="asset-locale-{app.id}">{t('assets:tab.filterLocale')}</label>
              <select id="asset-locale-{app.id}" value={active.locale} onchange={(e) => {
                  filter = { ...filter, locale: e.currentTarget.value };
                  writeLocale(e.currentTarget.value);
                }}>
                <option value={ALL}>{t('assets:tab.allLocales')}</option>
                {#each options.locales as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
            {#if options.devices.length > 1 || active.device !== ALL}
              <div class="field">
                <label for="asset-device-{app.id}">{t('assets:tab.filterDevice')}</label>
                <select id="asset-device-{app.id}" value={active.device} onchange={(e) => (filter = { ...filter, device: e.currentTarget.value })}>
                  <option value={ALL}>{t('assets:tab.allDevices')}</option>
                  {#each options.devices as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              </div>
            {/if}
            {#if options.kinds.length > 1 || active.kind !== ALL}
              <div class="field">
                <label for="asset-kind-{app.id}">{t('assets:tab.filterKind')}</label>
                <select id="asset-kind-{app.id}" value={active.kind} onchange={(e) => (filter = { ...filter, kind: e.currentTarget.value })}>
                  <option value={ALL}>{t('assets:tab.allKinds')}</option>
                  {#each options.kinds as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              </div>
            {/if}
            {#if isFiltered(active)}
              <Button variant="ghost" onclick={() => {
                filter = { ...NO_FILTER };
                writeLocale(ALL);
              }}>{t('assets:tab.clearFilters')}</Button>
            {/if}
          </div>
        {/if}

        <Tabs
          label={t('assets:tab.groupsLabel')}
          bind:value={group}
          tabs={summaries.map((g) => ({ id: g.id, label: g.label, count: g.files }))}
        >
          {#snippet panel(id)}
            {@const gAvail = groupAvailability(asGroupId(id), app.platform)}
            {@const here = summaries.filter((g) => g.id === id)[0]}
            {@const hintKey = groupDef(asGroupId(id)).hintKey}
            <div class="stack group-panel">
              <p class="muted small">{t(hintKey)}</p>
              {#if !gAvail.available}
                <div class="card"><EmptyState icon="lock" title={t('assets:tab.notOnStore')} description={gAvail.reason ?? ''} /></div>
              {:else if here && here.files === 0}
                <div class="card">
                  <EmptyState icon="images" title={t(NONE_FOUND[asGroupId(id)])} description={t('assets:tab.noneFoundText')} />
                </div>
              {:else}
                {#if groups.length === 0}
                  <div class="card">
                    <EmptyState icon="filter" title={t('assets:tab.noMatch')} description={t('assets:tab.noMatchText')}>
                      {#snippet actions()}
                        <Button onclick={() => {
                      filter = { ...NO_FILTER };
                      writeLocale(ALL);
                    }}>{t('assets:tab.clearFilters')}</Button>
                      {/snippet}
                    </EmptyState>
                  </div>
                {:else}
                  <AssetGallery
                    {groups}
                    {workspaceId}
                    appId={app.id}
                    commit={index?.commit ?? null}
                    maxServedBytes={maxServed}
                    {problemMap}
                    storeSide={seam}
                    onopen={openAsset}
                    stageFor={locked ? undefined : stageFor}
                    onstage={locked ? undefined : stageSet}
                    onunstage={locked ? undefined : (id) => unstageSet(id)}
                    {stagingId}
                    {diff}
                    selected={selectedIds}
                    ontoggle={toggleSelected}
                    onedit={locked ? undefined : openEditor}
                    oncompare={(locale, set) => openCompare(locale, set)}
                  />
                {/if}
              {/if}
            </div>
          {/snippet}
        </Tabs>
      {/if}

      <Section title={t('assets:tab.howChecks')} key="specs" defaultOpen={false}>
        <div class="stack spec-body">
          <p>{index.specs.basis}</p>
          <p class="muted">{t('assets:tab.rulesFrom')}</p>
          <ul class="plain">
            {#each Object.entries(index.specs.sources) as [name, url] (name)}
              <li>{#if url.startsWith('https://')}<a href={url} target="_blank" rel="noopener noreferrer">{url}<span class="visually-hidden"> {t('assets:problems.newTab')}</span></a>{:else}{url}{/if}</li>
            {/each}
          </ul>
          {#if index.specs.unverified.length > 0}
            <p class="muted">{t('assets:tab.unconfirmed')}</p>
            <ul class="plain">
              {#each index.specs.unverified as u (u.id)}<li><code>{u.id}</code> {u.text}</li>{/each}
            </ul>
          {/if}
        </div>
      </Section>

      <AssetPullDialog bind:open={pullOpen} {api} {workspaceId} {role} {app} initialSets={pullSets} />
      <AssetCompareDialog bind:open={compareOpen} {api} {workspaceId} {role} {app} focus={compareFocus} ondiff={(d) => (diff = d)} />
      <AssetSetEditor bind:open={editorOpen} {api} {workspaceId} {role} {app} set={editorSet} oncompare={compareFromEditor} />

      <AssetLightbox
        bind:open={lightboxOpen}
        bind:index={lightboxIndex}
        assets={shownAssets}
        {urlFor}
        problemsFor={problemsOfFile}
        {stateFor}
        {noteFor}
      />
    {/if}
  {/if}
</div>

<style>
  .sourcebar {
    padding: var(--space-2) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .small {
    margin: 0;
    font-size: 0.9375rem;
  }
  .staging {
    gap: var(--space-2) var(--space-3);
  }
  .blocking {
    margin: 0;
  }
  .bulk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .group-panel {
    gap: var(--space-4);
    padding-top: var(--space-4);
    font-size: 0.9375rem;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-3);
  }
  .filters .field {
    min-width: 160px;
  }
  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }
  .searched {
    margin: 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }
  .problem-list,
  .spec-body {
    margin-top: var(--space-3);
  }
</style>
