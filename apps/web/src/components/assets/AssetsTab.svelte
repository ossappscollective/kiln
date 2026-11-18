<!--
  AssetsTab: the store media found in the app's repository, in three groups (icon, Google Play graphics,
  screenshots), by locale and device, checked against the sizes and counts the stores document. Each
  file shows its status next to the store (in repo, in repo and store, differs) and its spec problems.
  Strictly read-only: nothing is uploaded or changed, here or in a store, and nothing is fetched from a
  store. "Stage for store" and "Pull from store" are shown disabled: they arrive with the draft push. The images are served from the repository by the app's own file route.
  Props: api, workspaceId, role, app, now (ms), refreshKey (changes when a sync finished, so this
  tab reads again), storeSide? (the seam for the store side: the counts the store has per locale,
  kind and device. Left out, the tab uses the one in the index, which is null today, so each set
  says "Not yet compared with the store").
  States: loading, error (with retry), no repository linked, no media found (with the folders that
  were searched), partial (a limit was reached: it says what was left out), ready.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    ALL,
    NO_FILTER,
    type AssetFilter,
    assetFileUrl,
    filterOptions,
    groupAssets,
    isFiltered,
    previewNote,
    previewState,
    problemCountsText,
    problemsByPath,
    sanitizeFilter,
    summaryText,
  } from '../../lib/assets.ts';
  import {
    type AssetGroupId,
    STAGING_NOTE,
    asGroupId,
    defaultGroup,
    groupAvailability,
    groupDef,
    groupOfKind,
    groupSummaries,
    sliceIndex,
  } from '../../lib/assets-groups.ts';
  import { describeError } from '../../lib/portfolio.ts';
  import type { AppSummary, AssetIndex, AssetItem, AssetStoreSide } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import AssetGallery from './AssetGallery.svelte';
  import AssetLightbox from './AssetLightbox.svelte';
  import AssetProblems from './AssetProblems.svelte';
  import AssetSource from './AssetSource.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    now,
    refreshKey,
    storeSide = undefined,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    now: number;
    refreshKey: number;
    storeSide?: AssetStoreSide | null;
  } = $props();

  const allowed = $derived(can(role, 'listing.read'));

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
      announcement = `Read ${next.totals.assets} store media files: ${problemCountsText(next)}.`;
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
      index = null;
      filter = { ...NO_FILTER };
      autoGroup = null;
      lightboxOpen = false;
    }
    untrack(() => void load());
  });

  const summaries = $derived(index ? groupSummaries(index, app.platform) : []);
  const slice = $derived(index ? sliceIndex(index, asGroupId(group)) : { assets: [], sets: [], problems: [] });
  const options = $derived(filterOptions(slice));
  // A choice the group does not offer (after switching group or reading again) counts as "all".
  const active = $derived(sanitizeFilter(filter, options));
  const groups = $derived(groupAssets(slice, active));
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
  const searched = $derived(index ? [...index.folders.screenshots, ...index.folders.previews, ...(index.folders.androidImages ? [index.folders.androidImages] : [])] : []);
</script>

<div class="stack loose assets" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if !allowed}
    <div class="card">
      <EmptyState icon="lock" title="No access to the assets" description="Reading the store media of a repository needs the right to read the listing." />
    </div>
  {:else if loading && !index}
    <div role="status" aria-label="Reading the store media">
      <Skeleton width="50%" height="16px" />
      <div class="card"><div class="stack"><Skeleton width="30%" height="16px" /><Skeleton width="100%" height="180px" /></div></div>
    </div>
  {:else if loadProblem && !index}
    <div class="stack">
      <Alert tone="error" title="Could not read the store media">{loadProblem}</Alert>
      <div class="row"><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if index}
    {#if loadProblem}
      <Alert tone="error" title="Could not read the media again">{loadProblem} The files below are from before.</Alert>
    {/if}

    {#if index.status === 'no_repository'}
      <div class="card">
        <EmptyState
          icon="repo"
          title="No repository linked"
          description="The store media of an app is read from its repository (screenshots, app previews and the Google Play graphics of fastlane). Link a repository to this app to see it here."
        >
          {#snippet actions()}
            <Button href="#/repositories" variant="primary" icon="repo">Go to repositories</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <section class="card" aria-label="Source of the assets">
        <div class="stack">
          <AssetSource {index} {now} {reloading} onreload={load} />
          <p class="muted basis">{index.specs.basis}</p>
        </div>
      </section>

      {#if index.partial.partial}
        <Alert tone="warn" title="Only part of the media was read">
          <ul class="plain">
            {#each index.partial.reasons as reason (reason)}<li>{reason}</li>{/each}
          </ul>
          <p class="alert-text">
            {index.source?.fast ? 'The folder holds more than the limit of a clone.' : 'GitHub is read over the network, so the limit is small. A local clone of the repository has no such limit.'}
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
            title="No store media found"
            description="The repository was read{index.target ? ` (${index.target.label})` : ''}, but it holds no screenshots, app previews or store graphics in the places fastlane uses."
          >
            {#snippet actions()}
              {#if searched.length > 0}
                <p class="muted searched">Searched: {searched.join(', ')}</p>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        <section class="card" aria-label="Summary">
          <div class="stack">
            <p class="summary"><strong>{summaryText(index)}</strong> <span class="muted">· {problemCountsText(index)}</span></p>
            <div class="row wrap staging">
              <Button size="sm" icon="upload" disabled title={STAGING_NOTE}>Stage for store</Button>
              <Button size="sm" icon="download" disabled title={STAGING_NOTE}>Pull from store</Button>
              <span class="muted small">{STAGING_NOTE}</span>
            </div>
          </div>
        </section>

        {#if index.problems.length > 0}
          <details class="card problems" open={index.totals.errors > 0}>
            <summary>Problems found ({index.problems.length}): {problemCountsText(index)}</summary>
            <div class="problem-list"><AssetProblems problems={index.problems} onopenpath={openPath} /></div>
          </details>
        {/if}

        <Tabs
          label="Asset groups"
          bind:value={group}
          tabs={summaries.map((g) => ({ id: g.id, label: g.label, count: g.files }))}
        >
          {#snippet panel(id)}
            {@const gAvail = groupAvailability(asGroupId(id), app.platform)}
            {@const here = summaries.filter((g) => g.id === id)[0]}
            <div class="stack group-panel">
              <p class="muted small">{groupDef(asGroupId(id)).hint}</p>
              {#if !gAvail.available}
                <div class="card"><EmptyState icon="lock" title="Not on this store" description={gAvail.reason ?? ''} /></div>
              {:else if here && here.files === 0}
                <div class="card">
                  <EmptyState icon="images" title="No {groupDef(asGroupId(id)).label.toLowerCase()} found" description="The repository holds none in the places the stores' tooling uses." />
                </div>
              {:else}
                <div class="filters">
                  <div class="field">
                    <label for="asset-locale-{app.id}">Locale</label>
                    <select id="asset-locale-{app.id}" value={active.locale} onchange={(e) => (filter = { ...filter, locale: e.currentTarget.value })}>
                      <option value={ALL}>All locales</option>
                      {#each options.locales as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                    </select>
                  </div>
                  {#if options.devices.length > 1 || active.device !== ALL}
                    <div class="field">
                      <label for="asset-device-{app.id}">Device</label>
                      <select id="asset-device-{app.id}" value={active.device} onchange={(e) => (filter = { ...filter, device: e.currentTarget.value })}>
                        <option value={ALL}>All devices</option>
                        {#each options.devices as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                      </select>
                    </div>
                  {/if}
                  {#if options.kinds.length > 1 || active.kind !== ALL}
                    <div class="field">
                      <label for="asset-kind-{app.id}">Kind</label>
                      <select id="asset-kind-{app.id}" value={active.kind} onchange={(e) => (filter = { ...filter, kind: e.currentTarget.value })}>
                        <option value={ALL}>All kinds</option>
                        {#each options.kinds as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                      </select>
                    </div>
                  {/if}
                  {#if isFiltered(active)}
                    <Button variant="ghost" onclick={() => (filter = { ...NO_FILTER })}>Clear filters</Button>
                  {/if}
                </div>

                {#if groups.length === 0}
                  <div class="card">
                    <EmptyState icon="filter" title="Nothing matches the filters" description="Choose another locale, device or kind.">
                      {#snippet actions()}
                        <Button onclick={() => (filter = { ...NO_FILTER })}>Clear filters</Button>
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
                  />
                {/if}
              {/if}
            </div>
          {/snippet}
        </Tabs>
      {/if}

      <details class="card specs">
        <summary>How these checks work</summary>
        <div class="stack spec-body">
          <p>{index.specs.basis}</p>
          <p class="muted">Rules come from these pages:</p>
          <ul class="plain">
            {#each Object.entries(index.specs.sources) as [name, url] (name)}
              <li>{#if url.startsWith('https://')}<a href={url} target="_blank" rel="noopener noreferrer">{url}<span class="visually-hidden"> (opens in a new tab)</span></a>{:else}{url}{/if}</li>
            {/each}
          </ul>
          {#if index.specs.unverified.length > 0}
            <p class="muted">Not confirmed on an official page (shown as information only, never as an error):</p>
            <ul class="plain">
              {#each index.specs.unverified as u (u.id)}<li><code>{u.id}</code> {u.text}</li>{/each}
            </ul>
          {/if}
        </div>
      </details>

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
  .basis {
    margin: 0;
    font-size: var(--text-sm);
  }
  .summary {
    margin: 0;
  }
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
  .staging {
    gap: var(--space-3);
  }
  .group-panel {
    padding-top: var(--space-4);
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
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  details > summary {
    cursor: pointer;
    font-weight: 600;
  }
  .problem-list,
  .spec-body {
    margin-top: var(--space-3);
  }
</style>
