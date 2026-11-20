<!--
  AppShell: an open app. Everything below the workspace is scoped to it: one slim header, then the page the address names (the
  left panel is AppNav, drawn by the shell). The header is the name of the page and the app, the platform control (only for an app
  on several platforms, and not on the settings page), the version and locale pickers on the pages they apply to (Releases and Store
  listing, AppHeaderRow) and a small Status button (StatusPopover) that holds the store chips, the bundle ids, the last sync and the
  one Sync now action. Under it, while the app has changes waiting, one quiet strip with "Review and publish" (PendingBar).
  The records of the two stores that are one product are shown as one app (lib/app-groups.ts).
  Props: api, workspaceId, role, id (an id of one of its platform records, from the address).
  The page, its view (`?view=`: Store listing text or graphics, Insights analytics or ASO, Builds builds, workflows or test builds),
  the open release and the platform scope all come from the address. An old address (assets, aso, analytics, workflows, test-builds)
  is replaced by its new one (lib/app-nav.ts `canonicalAppHash`) and reads as the new page at once.
  The versions come from the releases already loaded here. When the selected version is live (or in review where the store forbids
  edits) a slim banner says so and the listing and graphics are read-only (lockedPlatforms).
-->
<script lang="ts">
  import { type Action, type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, appContext, replaceHash, setPlatformScope } from '../../lib/address.svelte.ts';
  import {
    buildVersionOptions,
    headerParams,
    lockInfo,
    lockableSections,
    noLock,
    pickersFor,
    resolveVersion,
    withHeaderParams,
  } from '../../lib/app-header.ts';
  import { asoViewFromHash } from '../../lib/aso.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { dataChips } from '../../lib/app-chips.ts';
  import { canonicalAppHash, canonicalSection, pageTitle, resolveView, showsScope, viewsFor } from '../../lib/app-nav.ts';
  import { PUBLISHED_EVENT, pendingBar, pendingPlacement } from '../../lib/app-page.ts';
  import { lineFor } from '../../lib/pending.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { type AppGroup, groupApps, groupOf } from '../../lib/app-groups.ts';
  import { type AppSection, appAddress, resolveScope, visibleSections } from '../../lib/app-scope.ts';
  import { appLabel, describeError, portfolioHref, syncApp, syncSummaryText } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AppHeaderRow from './AppHeaderRow.svelte';
  import AppSectionView from './AppSection.svelte';
  import PendingBar from './PendingBar.svelte';
  import StatusPopover from './StatusPopover.svelte';
  import LockedBanner from './LockedBanner.svelte';
  import ScopeControl from './ScopeControl.svelte';

  let { api, workspaceId, role, id }: { api: Api; workspaceId: string; role: Role; id: string } = $props();

  const canSync = $derived(can(role, 'apps.sync'));

  let group = $state<AppGroup | null>(null);
  /** The records as last loaded or synced, and their releases, by app id. */
  let records = $state<Record<string, AppSummary | undefined>>({});
  let releases = $state<Record<string, ReleaseSummary[] | undefined>>({});
  let loading = $state(true);
  let loadError = $state<{ message: string; notFound: boolean } | null>(null);
  let syncing = $state<Record<string, boolean | undefined>>({});
  let syncRuns = $state(0);
  let now = $state(Date.now());
  let generation = 0;
  let loadedFor = '';

  const members = $derived(group ? group.members.map((m) => records[m.id] ?? m) : []);
  const resolved = $derived(resolveScope(address.platform, members.map((m) => m.platform)));
  const scoped = $derived(members.filter((m) => resolved.platforms.includes(m.platform)));
  const chips = $derived(dataChips(scoped, now));
  const releaseLists = $derived(
    members.reduce<Record<string, ReleaseSummary[]>>((acc, m) => {
      acc[m.id] = releases[m.id] ?? [];
      return acc;
    }, {}),
  );
  const open = $derived(address.app);
  const allowed = (a: Action) => can(role, a);
  /** The address as the new page reads it: an old address (assets, aso, ...) is replaced below, and meanwhile reads as its new page. */
  const hash = $derived(canonicalAppHash(address.hash) ?? address.hash);
  /** The page the address names (an old page as the page that replaced it), or the overview when the role may not open it. */
  const section = $derived<AppSection>(open && visibleSections(allowed).some((s) => s.id === canonicalSection(open.section)) ? canonicalSection(open.section) : 'dashboard');
  const androidInScope = $derived(scoped.some((m) => m.platform === 'android'));
  const views = $derived(viewsFor(section, allowed, { androidInScope }));
  const view = $derived(resolveView(section, hash, allowed, { androidInScope }));
  const anySyncing = $derived(scoped.some((m) => syncing[m.id] === true));
  /** What is pending for the app, from the workspace summary (all its records, not only those in scope); null draws no chip. */
  const lineOf = (list: readonly AppSummary[]) => lineFor(pendingStore.summary(workspaceId), list.map((m) => m.id), pendingStore.viewsOf(list.map((m) => m.id)));
  /** What is pending on the records of the page (the platform in scope). */
  const pendingLine = $derived(lineOf(scoped));
  /** What is pending on the other records of the app: the strip says where it is instead of showing it on a page that has none. */
  const elsewhere = $derived(members.filter((m) => !scoped.includes(m)));
  const elsewhereLine = $derived(lineOf(elsewhere));
  const bar = $derived(pendingBar(pendingLine, section) ?? pendingBar(elsewhereLine, section, elsewhere.map((m) => platformLabel(m.platform)).join(' and ')));
  const barHref = $derived(appAddress(id, 'pending', pendingBar(pendingLine, section) !== null || elsewhere.length === 0 ? address.platform : (elsewhere[0] as AppSummary).platform));
  /** On the Overview the pending changes are a link in the Next step card; a blocking error and the other pages keep the slim bar. */
  const placed = $derived(pendingPlacement(bar, section));
  const pendingLink = $derived(placed.link !== null ? { text: placed.link, href: barHref } : null);
  const scopeShown = $derived(showsScope(section, members.length));

  // The header row of a versioned page: its pickers, from data already loaded here and by the pages.
  const picker = $derived(pickersFor(section, { asoView: asoViewFromHash(hash), releaseOpen: open?.release != null }));
  const params = $derived(headerParams(hash));
  const scopedReleases = $derived(scoped.reduce<ReleaseSummary[]>((all, m) => all.concat(releaseLists[m.id] ?? []), []));
  const versionOptions = $derived(buildVersionOptions(scopedReleases, resolved.platforms));
  const version = $derived(resolveVersion(params.version, versionOptions));
  const localeList = $derived.by(() => {
    const read = navSignals.localesOf(workspaceId, members.map((m) => m.id));
    // A locale in the address that no page has read yet stays visible, so the row does not lie about the page.
    return params.locale !== null && read.indexOf(params.locale) < 0 ? [params.locale, ...read] : read;
  });
  const lock = $derived(lockableSections.indexOf(section) >= 0 ? lockInfo(scopedReleases, version, resolved.platforms, { fallbackToNewest: params.version !== version }) : noLock);
  const setVersion = (next: string) => replaceHash(withHeaderParams(location.hash, { version: next }));
  const setLocale = (next: string | null) => replaceHash(withHeaderParams(location.hash, { locale: next }));

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = null;
    try {
      const list = (await api.apps(workspaceId)).apps;
      navSignals.setApps(workspaceId, list);
      const found = groupOf(groupApps(list), id);
      if (mine !== generation) return;
      if (!found) {
        group = null;
        loadError = { message: '', notFound: true };
        return;
      }
      const details = await Promise.all(found.members.map((m) => api.app(workspaceId, m.id)));
      if (mine !== generation) return;
      const nextRecords: Record<string, AppSummary> = {};
      const nextReleases: Record<string, ReleaseSummary[]> = {};
      for (const d of details) {
        nextRecords[d.app.id] = d.app;
        nextReleases[d.app.id] = d.releases;
      }
      records = nextRecords;
      releases = nextReleases;
      group = found;
      appContext.name = found.name;
    } catch (e) {
      if (mine !== generation) return;
      group = null;
      loadError = { message: describeError(e, 'load'), notFound: false };
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // The left panel shows the status of each platform from the releases loaded here.
  $effect(() => {
    const space = workspaceId;
    for (const [appId, list] of Object.entries(releases)) {
      if (list) untrack(() => navSignals.setReleases(space, appId, list));
    }
  });

  // Load when the app changes. Moving to the other platform record of the same app keeps what is shown.
  $effect(() => {
    const space = workspaceId;
    const wanted = id;
    untrack(() => {
      if (space === loadedFor && group && group.members.some((m) => m.id === wanted)) return;
      loadedFor = space;
      group = null;
      records = {};
      releases = {};
      syncing = {};
      appContext.name = '';
      void load();
    });
  });

  // An old address (workflows, assets, aso, ...) is replaced by the address of the page that holds it now; the history keeps one entry.
  $effect(() => {
    const target = canonicalAppHash(address.hash);
    if (target !== null) replaceHash(target);
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => {
      clearInterval(timer);
      appContext.name = '';
    };
  });

  async function sync(app: AppSummary) {
    if (syncing[app.id]) return;
    const mine = generation;
    syncing[app.id] = true;
    const outcome = await syncApp(api, workspaceId, app.id);
    if (mine !== generation) return;
    syncing[app.id] = false;
    now = Date.now();
    syncRuns += 1;
    if (outcome.ok) {
      records[app.id] = outcome.app;
      releases[app.id] = outcome.releases;
      toast.success(syncSummaryText(appLabel(outcome.app), outcome.sync));
    } else {
      // A failed sync is stored on the app, so the server sends the app back with the new message.
      if (outcome.app) records[app.id] = outcome.app;
      toast.error(`${appLabel(app)}: ${outcome.failure.message}`);
    }
  }

  async function syncScoped() {
    for (const app of scoped) await sync(app);
  }

  // Something was published from this app's "Review and publish all": read the store again and show the releases (where the new state is).
  $effect(() => {
    const onPublished = (event: Event) => {
      const appId = (event as CustomEvent<{ appId?: string }>).detail?.appId;
      const published = members.find((m) => m.id === appId);
      if (appId === undefined || published === undefined) return;
      // The record that was published (it may be the other platform than the page shows): read its store again, then the pending
      // lists of every record of the app, so no stale "draft to publish" is left on either.
      window.location.hash = appAddress(id, 'releases', scoped.includes(published) ? address.platform : published.platform);
      void sync(published).then(() => pendingStore.refresh(api, workspaceId, members.map((m) => m.id), { submit: canSubmit(role) }));
    };
    window.addEventListener(PUBLISHED_EVENT, onPublished);
    return () => window.removeEventListener(PUBLISHED_EVENT, onPublished);
  });
</script>

<section aria-busy={loading}>
  {#if loading && !group}
    <div role="status" aria-label="Loading the app">
      <div class="skeleton-head"><Skeleton width="240px" height="28px" /><Skeleton width="160px" height="16px" /></div>
      <div class="card"><div class="stack"><Skeleton width="60%" height="16px" /><Skeleton width="40%" height="16px" /></div></div>
    </div>
  {:else if loadError}
    {#if loadError.notFound}
      <div class="card">
        <EmptyState icon="box" title="App not found" description="This app is not in this workspace. It may have been deleted.">
          {#snippet actions()}<Button href={portfolioHref} variant="primary">Back to all apps</Button>{/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="stack">
        <Alert tone="error" title="Could not load the app">{loadError.message}</Alert>
        <div class="row">
          <Button icon="refresh" onclick={load}>Try again</Button>
          <Button href={portfolioHref} variant="ghost">Back to all apps</Button>
        </div>
      </div>
    {/if}
  {:else if group}
    <header class="head">
      <div class="id">
        <AppIcon
          name={group.name}
          url={members.map((m) => m.iconUrl ?? null).find((u) => u) ?? null}
          platform={members.length === 1 ? members[0]?.platform : undefined}
          seed={group.key}
          size="md"
        />
        <div class="titles">
          <h1 class="page-title">{pageTitle(section)}</h1>
          <p class="appname" title={group.name}>
            <span class="name">{group.name}</span>
            <span class="ident" aria-hidden="true">{members.map((m) => m.identifier).filter((v, i, all) => all.indexOf(v) === i).join(' · ')}</span>
          </p>
        </div>
      </div>
      <div class="tools">
        {#if picker}
          <AppHeaderRow
            scopeOptions={resolved.options}
            scope={resolved.scope}
            onscope={setPlatformScope}
            showScope={scopeShown}
            versions={versionOptions}
            {version}
            onversion={setVersion}
            showVersion={picker.version}
            locales={localeList}
            locale={params.locale}
            onlocale={setLocale}
            showLocale={picker.locale}
          />
        {:else if scopeShown}
          <ScopeControl options={resolved.options} scope={resolved.scope} onchange={setPlatformScope} />
        {/if}
        {#if canSync}
          <Button size="sm" icon="refresh" loading={anySyncing} disabled={anySyncing} onclick={syncScoped}>{anySyncing ? 'Syncing…' : 'Sync'}</Button>
        {/if}
        <StatusPopover {members} {chips} {now} {canSync} syncing={anySyncing} onsync={syncScoped} settingsHref={appAddress(id, 'settings', address.platform)} />
        {#if section !== 'settings'}
          <Button href={appAddress(id, 'settings', address.platform)} variant="ghost" icon="settings" iconOnly label="App settings" />
        {/if}
      </div>
    </header>

    <PendingBar bar={placed.bar} href={barHref} />

    {#if lock.text !== ''}
      <LockedBanner text={lock.text} href={appAddress(id, 'releases', address.platform)} />
    {/if}

    <div class="body">
      <AppSectionView
        {api}
        {workspaceId}
        {role}
        {section}
        {view}
        {views}
        members={scoped}
        all={members}
        openId={id}
        version={open?.release ?? null}
        releases={releaseLists}
        {now}
        {syncRuns}
        {syncing}
        lockedPlatforms={lock.locked}
        locale={params.locale}
        pending={pendingLink}
      />
    </div>
  {/if}
</section>

<style>
  .skeleton-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-5);
  }

  .id {
    display: flex;
    flex: 1;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    min-width: 12rem;
  }

  .titles {
    min-width: 0;
  }

  .page-title {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: 1.2;
  }

  .appname {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-3);
    min-width: 0;
    margin: 2px 0 0;
    color: var(--muted);
  }

  .appname .name {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .appname .ident {
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-left: auto;
  }
</style>
