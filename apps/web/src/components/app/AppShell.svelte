<!--
  AppShell: an open app. Everything below the workspace is scoped to it: a header with the icon,
  the stores, the "where the data lives" chips and the platform control, then the section the
  address names (the left panel is AppNav, drawn by the shell). The records of the two stores that
  are one product are shown as one app (lib/app-groups.ts).
  Props: api, workspaceId, role, id (an id of one of its platform records, from the address).
  The section, the open release and the platform scope all come from the address.
  Versioned pages (listing, releases, assets, ASO fit) carry one compact row under the title: platform, version
  (with its state) and locale (AppHeaderRow), kept in the address as ?platform=&version=&locale= and shared by the
  tabs; the other pages keep the platform control at the top right. The versions come from the releases already
  loaded here. When the selected version is live (or in review where the store forbids edits) a slim banner says
  so and the listing and assets are read-only (lockedPlatforms).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
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
  import { type AppGroup, groupApps, groupOf } from '../../lib/app-groups.ts';
  import { type AppSection, appAddress, resolveScope, visibleSections } from '../../lib/app-scope.ts';
  import { appLabel, describeError, portfolioHref, syncApp, syncSummaryText } from '../../lib/portfolio.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import AppHeaderRow from './AppHeaderRow.svelte';
  import AppSectionView from './AppSection.svelte';
  import DataChips from './DataChips.svelte';
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
  /** The section the address names, or the dashboard when the role may not open it. */
  const section = $derived<AppSection>(
    open && visibleSections((a) => can(role, a)).some((s) => s.id === open.section) ? open.section : 'dashboard',
  );
  const anySyncing = $derived(scoped.some((m) => syncing[m.id] === true));

  // The header row of a versioned page: its pickers, from data already loaded here and by the pages.
  const picker = $derived(pickersFor(section, { asoView: asoViewFromHash(address.hash), releaseOpen: open?.release != null }));
  const params = $derived(headerParams(address.hash));
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
      <AppIcon
        name={group.name}
        url={members.map((m) => m.iconUrl ?? null).find((u) => u) ?? null}
        platform={members.length === 1 ? members[0]?.platform : undefined}
        seed={group.key}
        size="lg"
      />
      <div class="id">
        <div class="titleline">
          <h1 class="page-title">{group.name}</h1>
          <DataChips {chips} />
        </div>
        <p class="sub">
          {#each members as m (m.id)}
            <span class="store"><StoreBadge store={storeForPlatform(m.platform).store} size="sm" /> <code>{m.identifier}</code></span>
          {/each}
        </p>
      </div>
      <div class="tools">
        {#if !picker}<ScopeControl options={resolved.options} scope={resolved.scope} onchange={setPlatformScope} />{/if}
        {#if canSync}
          <Button variant="primary" icon="refresh" loading={anySyncing} onclick={syncScoped}>{anySyncing ? 'Syncing…' : 'Sync now'}</Button>
        {/if}
      </div>
    </header>

    {#if picker}
      <div class="picks">
        <AppHeaderRow
          scopeOptions={resolved.options}
          scope={resolved.scope}
          onscope={setPlatformScope}
          versions={versionOptions}
          {version}
          onversion={setVersion}
          showVersion={picker.version}
          locales={localeList}
          locale={params.locale}
          onlocale={setLocale}
          showLocale={picker.locale}
        />
      </div>
    {/if}
    {#if lock.text !== ''}
      <LockedBanner text={lock.text} href={appAddress(id, 'releases', address.platform)} />
    {/if}

    <div class="body">
      <AppSectionView
        {api}
        {workspaceId}
        {role}
        {section}
        members={scoped}
        all={members}
        openId={id}
        version={open?.release ?? null}
        releases={releaseLists}
        {now}
        {syncRuns}
        {syncing}
        onsync={sync}
        lockedPlatforms={lock.locked}
        locale={params.locale}
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
    margin-bottom: var(--space-4);
  }

  .id {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 240px;
  }

  .titleline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: center;
  }

  .page-title {
    font-size: var(--text-xl);
    line-height: 1.2;
  }

  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .store {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .picks {
    margin-bottom: var(--space-4);
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-left: auto;
  }
</style>
