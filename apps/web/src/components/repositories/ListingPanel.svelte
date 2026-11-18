<!--
  ListingPanel: the store listing files of a repository, per locale, with the store limits.
  Props: api, workspaceId, repository, canEdit (may create a change set), data and edited (both
  bindable, so the edits survive a switch of tab), oncreated (called with the new draft).
  Editing never writes anything: "Create draft change set" makes a draft that an admin approves.
-->
<script lang="ts">
  import {
    APP_STORE_COPYRIGHT_SPEC,
    type Listing,
    type ListingStore,
    PLAY_CHANGELOG_SPEC,
    validateListing,
  } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    changelogCodes,
    changelogField,
    cloneListing,
    listingEdits,
    listingForChangeSet,
    listingStores,
    localeFieldSpecs,
    readField,
    repositoryName,
    storeLabel,
    storeLocales,
    suggestSummary,
    writeField,
  } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChangeSetView, RepositoryListing, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import TextField from '../ui/TextField.svelte';
  import FieldEditor from './FieldEditor.svelte';

  let {
    api,
    workspaceId,
    repository,
    canEdit,
    data = $bindable(null),
    edited = $bindable(null),
    oncreated,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    canEdit: boolean;
    data?: RepositoryListing | null;
    edited?: Listing | null;
    oncreated: (changeSet: ChangeSetView) => void;
  } = $props();

  const uid = $props.id();

  let loading = $state(false);
  let loadError = $state('');
  let store = $state<string>('app_store');
  let localeByStore = $state<Record<string, string>>({});
  let summary = $state('');
  let summaryTouched = $state(false);
  let creating = $state(false);
  let createError = $state('');

  async function load() {
    loading = true;
    loadError = '';
    try {
      const result = await api.repositoryListing(workspaceId, repository.id);
      data = result;
      edited = cloneListing(result.listing);
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Could not read the listing files.';
    } finally {
      loading = false;
    }
  }

  // Read the files once per repository. Edits are kept when the person switches tabs.
  const repoId = $derived(repository.id);
  $effect(() => {
    void repoId;
    untrack(() => {
      if (data === null && !loading) void load();
    });
  });

  const base = $derived(data?.listing ?? {});
  const edits = $derived(data && edited ? listingEdits(base, edited) : []);
  const problems = $derived(edited ? validateListing(edited) : []);
  const errorCount = $derived(problems.filter((p) => p.severity === 'error').length);
  const localesEdited = $derived(new Set(edits.map((e) => `${e.store}:${e.locale ?? ''}`)));

  const asStore = (id: string): ListingStore => (id === 'google_play' ? 'google_play' : 'app_store');
  const tabs = $derived(
    listingStores.map((s) => ({ id: s, label: storeLabel[s], count: edited ? storeLocales(edited, s).length : 0 })),
  );

  const localesOf = (s: ListingStore) => (edited ? storeLocales(edited, s) : []);
  const localeFor = (s: ListingStore) => {
    const list = localesOf(s);
    const chosen = localeByStore[s];
    return chosen && list.includes(chosen) ? chosen : (list[0] ?? '');
  };

  // Follow the suggested summary until the person types their own.
  $effect(() => {
    const suggestion = suggestSummary(edits);
    if (!summaryTouched) summary = suggestion;
  });

  function setField(s: ListingStore, locale: string | undefined, field: string, value: string) {
    if (!edited) return;
    edited = writeField(edited, s, locale, field, value);
    createError = '';
  }

  function discardEdits() {
    if (!data) return;
    edited = cloneListing(data.listing);
    summaryTouched = false;
    createError = '';
    toast.info('Your edits were discarded.');
  }

  async function create() {
    if (!data || !edited || creating) return;
    creating = true;
    createError = '';
    try {
      const result = await api.createChangeSet(workspaceId, repository.id, {
        summary: summary.trim(),
        listing: listingForChangeSet(data.listing, edited),
      });
      toast.success('Draft change set created. An admin or owner can review and approve it.');
      // What was edited now lives in the draft, so the boxes go back to the repository's text.
      edited = cloneListing(data.listing);
      summaryTouched = false;
      oncreated(result.changeSet);
    } catch (e) {
      createError = e instanceof ApiError ? e.message : 'Could not create the change set.';
    } finally {
      creating = false;
    }
  }

  const problemsFor = (s: ListingStore, locale: string | undefined, field: string) =>
    problems.filter((p) => p.store === s && p.locale === locale && p.field === field);
</script>

{#snippet storePanel(id: string)}
  {@const s = asStore(id)}
  {@const list = localesOf(s)}
  {@const locale = localeFor(s)}
  {@const found = s === 'app_store' ? data?.found.appStore : data?.found.googlePlay}
  {@const root = s === 'app_store' ? data?.roots.appStore : data?.roots.googlePlay}
  {#if edited && list.length === 0}
    <div class="card">
      <EmptyState
        icon="file-text"
        title="No {storeLabel[s]} listing files found"
        description={found === false
          ? `Nothing was found under ${root}. A fastlane listing has one folder per locale, such as ${root}/en-US, with a text file for each field.`
          : 'The listing has no locales yet.'}
      />
    </div>
  {:else if edited}
    <div class="stack loose">
      <div class="locale-bar">
        <div class="field">
          <label for="{uid}-{s}-locale">Locale</label>
          <select
            id="{uid}-{s}-locale"
            value={locale}
            onchange={(e) => (localeByStore[s] = e.currentTarget.value)}
          >
            {#each list as code (code)}
              <option value={code}>{code === 'default' ? 'default (fallback for missing locales)' : code}{localesEdited.has(`${s}:${code}`) ? ' (edited)' : ''}</option>
            {/each}
          </select>
        </div>
        <p class="hint root">Read from <code>{root}</code> on <code>{repository.defaultBranch}</code></p>
      </div>

      <div class="card fields">
        {#each localeFieldSpecs(s) as spec (spec.id)}
          <FieldEditor
            {spec}
            id="{uid}-{s}-{locale}-{spec.id}"
            value={readField(edited, s, locale, spec.id) ?? ''}
            original={readField(base, s, locale, spec.id)}
            readonly={!canEdit}
            problems={problemsFor(s, locale, spec.id)}
            onchange={(value) => setField(s, locale, spec.id, value)}
          />
        {/each}
      </div>

      {#if s === 'google_play'}
        {@const codes = changelogCodes(edited, locale)}
        <div class="card fields">
          <div class="card-header">
            <div>
              <h3>Release notes</h3>
              <p>One file per version code in <code>changelogs/</code>. The file named default is the fallback.</p>
            </div>
          </div>
          {#if codes.length === 0}
            <p class="muted">This locale has no release note files.</p>
          {:else}
            {#each codes as code (code)}
              <FieldEditor
                spec={PLAY_CHANGELOG_SPEC}
                id="{uid}-{s}-{locale}-changelog-{code}"
                label={code === 'default' ? 'Release notes (default)' : `Release notes for version code ${code}`}
                value={readField(edited, s, locale, changelogField(code)) ?? ''}
                original={readField(base, s, locale, changelogField(code))}
                readonly={!canEdit}
                problems={problemsFor(s, locale, changelogField(code))}
                onchange={(value) => setField(s, locale, changelogField(code), value)}
              />
            {/each}
          {/if}
        </div>
      {:else}
        <div class="card fields">
          <div class="card-header">
            <div>
              <h3>Across all locales</h3>
              <p>Stored once, in <code>copyright.txt</code>.</p>
            </div>
          </div>
          <FieldEditor
            spec={APP_STORE_COPYRIGHT_SPEC}
            id="{uid}-{s}-copyright"
            value={readField(edited, s, undefined, 'copyright') ?? ''}
            original={readField(base, s, undefined, 'copyright')}
            readonly={!canEdit}
            problems={problemsFor(s, undefined, 'copyright')}
            onchange={(value) => setField(s, undefined, 'copyright', value)}
          />
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#if loadError}
  <div class="stack">
    <Alert tone="error">{loadError}</Alert>
    <div><Button icon="refresh" onclick={load}>Try again</Button></div>
  </div>
{:else if data === null || edited === null}
  <div class="card" role="status" aria-label="Reading the listing files from GitHub">
    <div class="stack">
      <Skeleton width="25%" height="14px" />
      <Skeleton height="36px" />
      <Skeleton width="25%" height="14px" />
      <Skeleton height="112px" />
      <p class="muted">Reading the listing files from {repositoryName(repository)}. This can take a few seconds.</p>
    </div>
  </div>
{:else if !data.found.appStore && !data.found.googlePlay}
  <div class="card">
    <EmptyState
      icon="file-text"
      title="No listing files found"
      description="This repository has no fastlane listing text at {data.roots.appStore} or {data.roots.googlePlay}. Run a scan to see what the project contains."
    >
      {#snippet actions()}<Button icon="refresh" onclick={load}>Check again</Button>{/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="stack loose">
    {#if !canEdit}
      <Alert tone="info">Your role can read the listing but not edit it.</Alert>
    {/if}
    {#if data.warnings.length > 0}
      <Alert tone="warn" title="Listing warnings">
        <ul class="plain">
          {#each data.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    <Tabs {tabs} bind:value={store} label="Store" panel={storePanel} />

    {#if canEdit}
      <form
        class="card bar"
        aria-label="Create a change set from your edits"
        onsubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div class="card-header">
          <div>
            <h3>Create a change set</h3>
            <p>
              {#if edits.length === 0}
                Edit a field above. Your changes become a draft that an admin or owner approves before anything is written to the repository.
              {:else}
                {edits.length} {edits.length === 1 ? 'field' : 'fields'} edited. Nothing is written until an admin or owner approves the draft and applies it as a pull request.
              {/if}
            </p>
          </div>
        </div>
        <TextField
          label="Summary"
          bind:value={summary}
          oninput={() => (summaryTouched = true)}
          maxlength={200}
          autocomplete="off"
          hint="One line that names the change. It becomes the pull request title."
        />
        {#if errorCount > 0 && edits.length > 0}
          <div class="gap">
            <Alert tone="warn">
              {errorCount} {errorCount === 1 ? 'field is' : 'fields are'} over a limit or missing. You can still create the draft, but the store may refuse it.
            </Alert>
          </div>
        {/if}
        {#if createError}<div class="gap"><Alert tone="error">{createError}</Alert></div>{/if}
        <div class="row end gap">
          <Button disabled={edits.length === 0 || creating} onclick={discardEdits}>Discard edits</Button>
          <Button type="submit" variant="primary" icon="git-pull-request" loading={creating} disabled={edits.length === 0 || summary.trim() === ''}>
            {creating ? 'Creating…' : 'Create draft change set'}
          </Button>
        </div>
      </form>
    {/if}
  </div>
{/if}

<style>
  .locale-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
    align-items: flex-end;
    justify-content: space-between;
  }

  .locale-bar .field {
    flex: 0 1 320px;
    margin: 0;
  }

  .root {
    margin: 0;
  }

  .fields > :global(.field:last-child) {
    margin-bottom: 0;
  }

  .plain {
    padding: 0;
    margin: var(--space-1) 0 0;
    list-style: none;
  }

  .row.end {
    justify-content: flex-end;
  }

  .gap {
    margin-top: var(--space-4);
  }
</style>
