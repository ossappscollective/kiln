<!--
  ListingPanel: the store listing files of a repository, per locale, with the store limits.
  Props: api, workspaceId, repository, role (the listing is read with repositories.scan: member and
  up), canEdit (may create a change set), data, edited and selection (all bindable, so the edits and
  the chosen target survive a switch of tab), oncreated (called with the new draft).
  A repository can have several apps or a listing in an unusual place: the target bar picks which
  one is read (a detected one, or a saved one that an admin keeps in "Manage targets"). Edits are
  kept per target: switching is blocked while there are unsaved edits.
  Each store shows where its listing comes from (the Expo store.config.json or fastlane) and the
  path. Editing never writes anything: "Create draft change set" makes a draft that an admin approves.
  A viewer never calls the listing endpoint and gets a read-only message instead.
-->
<script lang="ts">
  import {
    type Listing,
    type ListingFieldSpec,
    type ListingStore,
    type Role,
    can,
    fieldSpecOf,
    RELEASE_NOTES_FIELD,
    validateListing,
  } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    changelogCodes,
    changelogField,
    cloneListing,
    copyrightLocation,
    errorCountOf,
    emptyListingDescription,
    listingEdits,
    listingForChangeSet,
    listingIsEmpty,
    listingReadNotice,
    listingSourceBadge,
    listingStores,
    localeFieldSpecs,
    readField,
    repositoryName,
    selectionForRequest,
    showTargetBar,
    sourcePathKind,
    sourceProblem,
    storeLabel,
    storeLocales,
    suggestSummary,
    type TargetForm,
    targetOptionLabel,
    targetRootsSummary,
    writeField,
  } from '../../lib/repositories.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type {
    ChangeSetView,
    ListingSelection,
    RepositoryListing,
    RepositorySummary,
    StoreSource,
  } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import T from '../ui/T.svelte';
  import TextField from '../ui/TextField.svelte';
  import FieldEditor from './FieldEditor.svelte';
  import ListingDiagnostics from './ListingDiagnostics.svelte';
  import ListingTargetsDialog from './ListingTargetsDialog.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
    canEdit,
    data = $bindable(null),
    edited = $bindable(null),
    selection = $bindable({}),
    oncreated,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
    canEdit: boolean;
    data?: RepositoryListing | null | undefined;
    edited?: Listing | null | undefined;
    selection?: ListingSelection | undefined;
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
  let targetsOpen = $state(false);
  let targetsPrefill = $state<Partial<TargetForm>>({});

  async function load() {
    loading = true;
    loadError = '';
    try {
      const result = await api.repositoryListing(workspaceId, repository.id, selection);
      data = result;
      edited = cloneListing(result.listing);
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : t('repositories:lp.loadFailed');
    } finally {
      loading = false;
    }
  }

  // Read the files once per repository. Edits are kept when the person switches tabs. A role that
  // may not read the listing never calls the endpoint (it would answer 403).
  const repoId = $derived(repository.id);
  const readNotice = $derived(listingReadNotice(role));
  $effect(() => {
    void repoId;
    untrack(() => {
      if (readNotice === null && data === null && !loading) void load();
    });
  });

  const base = $derived(data?.listing ?? {});
  const edits = $derived(data && edited ? listingEdits(base, edited) : []);
  const canManageTargets = $derived(can(role, 'repositories.write'));
  const savedTargets = $derived((data?.targets ?? []).filter((t) => t.origin === 'custom'));
  const switching = $derived(edits.length > 0);

  // Reads the listing of another target. The edits belong to the target that was read, so the
  // switch is blocked while there are any (the selector is disabled and says why).
  async function choose(next: ListingSelection) {
    if (switching || loading) return;
    selection = next;
    data = null;
    edited = null;
    summaryTouched = false;
    await load();
  }

  // A folder from the diagnostic, used for one store. Folders win over the target on the server.
  function useFolder(store: ListingStore, path: string) {
    const key = store === 'app_store' ? 'appStore' : 'googlePlay';
    void choose({ ...selection, roots: { ...selection.roots, [key]: path } });
  }

  function saveFolder(store: ListingStore, path: string) {
    targetsPrefill = store === 'app_store' ? { appStoreRoot: path } : { googlePlayRoot: path };
    targetsOpen = true;
  }

  function openTargets() {
    targetsPrefill = {};
    targetsOpen = true;
  }

  async function targetsChanged(info: { selectId?: string; deletedId?: string }) {
    if (info.selectId) selection = { target: info.selectId };
    else if (info.deletedId && (selection.target === info.deletedId || data?.selected?.id === info.deletedId)) {
      selection = {};
    }
    data = null;
    edited = null;
    summaryTouched = false;
    await load();
  }
  const problems = $derived(edited ? validateListing(edited) : []);
  const errorCount = $derived(errorCountOf(problems));
  // The specs of the Play release notes and the App Store copyright: the one owner (`fieldSpecOf`), never a table imported here.
  const changelogSpec = fieldSpecOf('google_play', RELEASE_NOTES_FIELD) as ListingFieldSpec;
  const copyrightSpec = fieldSpecOf('app_store', 'copyright') as ListingFieldSpec;
  const localesEdited = $derived(new Set(edits.map((e) => `${e.store}:${e.locale ?? ''}`)));

  /** The locale in the picker: the code (or what "default" means), and a mark when it has edits. */
  const localeOptionLabel = (s: ListingStore, code: string) => {
    const label = code === 'default' ? t('repositories:lp.localeDefault') : code;
    return localesEdited.has(`${s}:${code}`) ? t('repositories:lp.localeEdited', { label }) : label;
  };
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
    toast.info(t('repositories:lp.discarded'));
  }

  async function create() {
    if (!data || !edited || creating) return;
    creating = true;
    createError = '';
    try {
      // Made in the folders the person was looking at, not whatever is detected by default now.
      const result = await api.createChangeSet(workspaceId, repository.id, {
        summary: summary.trim(),
        listing: listingForChangeSet(data.listing, edited),
        ...selectionForRequest(data),
      });
      toast.success(t('repositories:lp.created'));
      if (result.warnings?.length) toast.warning(result.warnings.join(' '));
      // What was edited now lives in the draft, so the boxes go back to the repository's text.
      edited = cloneListing(data.listing);
      summaryTouched = false;
      oncreated(result.changeSet);
    } catch (e) {
      createError = e instanceof ApiError ? e.message : t('repositories:lp.createFailed');
    } finally {
      creating = false;
    }
  }

  const problemsFor = (s: ListingStore, locale: string | undefined, field: string) =>
    problems.filter((p) => p.store === s && p.locale === locale && p.field === field);
</script>

{#snippet targetBar()}
  {#if data && showTargetBar(data, canManageTargets)}
    {@const targets = data.targets ?? []}
    <div class="card target-bar">
      <div class="locale-bar">
        <div class="field">
          <label for="{uid}-target">{t('repositories:lp.targetLabel')}</label>
          <select
            id="{uid}-target"
            value={data.selected?.id ?? ''}
            disabled={switching || loading}
            aria-describedby={switching ? `${uid}-target-hint` : undefined}
            onchange={(e) => void choose({ target: e.currentTarget.value })}
          >
            {#if data.selected?.id == null}
              <option value="" disabled>{data.selected?.label ?? t('repositories:lp.detectedFolders')}</option>
            {/if}
            {#each targets as target (target.id)}
              <option value={target.id}>{targetOptionLabel(target)}</option>
            {/each}
          </select>
        </div>
        {#if canManageTargets}
          <Button icon="settings" disabled={switching || loading} onclick={openTargets}>{t('repositories:lp.manageTargets')}</Button>
        {/if}
      </div>
      <p class="hint root" id="{uid}-target-hint">
        {#if switching}
          {t('repositories:lp.switchHint')}
        {:else}
          <T key="repositories:lp.reading" params={{ roots: targetRootsSummary({ appStore: data.roots.appStore || null, googlePlay: data.roots.googlePlay || null }) }} />
          {#if targets.filter((t) => t.origin === 'detected').length > 1 && data.selected?.origin === 'default'}
            {t('repositories:lp.severalApps')}
          {/if}
        {/if}
      </p>
    </div>
  {/if}
{/snippet}

{#snippet diagnosticFor(s: ListingStore)}
  {@const diag = s === 'app_store' ? data?.diagnostics?.appStore : data?.diagnostics?.googlePlay}
  {#if diag}
    <ListingDiagnostics
      diagnostic={diag}
      label={storeLabel[s]}
      store={s}
      canChoose={readNotice === null}
      canSave={canManageTargets}
      onuse={(path) => useFolder(s, path)}
      onsave={(path) => saveFolder(s, path)}
    />
  {/if}
{/snippet}

{#snippet sourceLine(src: StoreSource)}
  {@const badge = listingSourceBadge(src.source)}
  <p class="hint root source">
    <Badge tone={badge.tone}>{badge.label}</Badge>
    <span>
      {#if sourcePathKind(src.source) === 'file'}
        <T key="repositories:lp.sourceFile" params={{ path: src.path, branch: repository.defaultBranch }} />
      {:else}
        <T key="repositories:lp.sourceFolder" params={{ path: src.path, branch: repository.defaultBranch }} />
      {/if}
    </span>
  </p>
{/snippet}

{#snippet storePanel(id: string)}
  {@const s = asStore(id)}
  {@const list = localesOf(s)}
  {@const locale = localeFor(s)}
  {@const found = s === 'app_store' ? data?.found.appStore : data?.found.googlePlay}
  {@const src = s === 'app_store' ? data?.sources.appStore : data?.sources.googlePlay}
  {@const broken = src ? sourceProblem(src) : null}
  {#if edited && src && broken}
    <div class="stack loose">
      {@render sourceLine(src)}
      <Alert tone="error" title={t('repositories:lp.cannotRead', { store: storeLabel[s] })}>{broken}</Alert>
    </div>
  {:else if edited && src && list.length === 0}
    <div class="stack loose">
      {@render sourceLine(src)}
      <div class="card">
        <EmptyState
          icon="file-text"
          title={t('repositories:lp.noText', { store: storeLabel[s] })}
          description={found === false
            ? src.source === 'expo-store-config'
              ? t('repositories:lp.emptyExpoLocales', { path: src.path })
              : t('repositories:lp.emptyFastlane', { path: src.path })
            : t('repositories:lp.noLocales')}
        />
        {#if found === false && src.source === 'fastlane'}{@render diagnosticFor(s)}{/if}
      </div>
    </div>
  {:else if edited && src}
    <div class="stack loose">
      <div class="locale-bar">
        <div class="field">
          <label for="{uid}-{s}-locale">{t('repositories:lp.locale')}</label>
          <select
            id="{uid}-{s}-locale"
            value={locale}
            onchange={(e) => (localeByStore[s] = e.currentTarget.value)}
          >
            {#each list as code (code)}
              <option value={code}>{localeOptionLabel(s, code)}</option>
            {/each}
          </select>
        </div>
        {@render sourceLine(src)}
      </div>
      {#if src.source === 'expo-store-config' && src.warnings.length > 0}
        <Alert tone="warn" title={t('repositories:lp.notesOn', { path: src.path })}>
          <ul class="plain">
            {#each src.warnings as warning (warning)}<li>{warning}</li>{/each}
          </ul>
        </Alert>
      {/if}

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
              <h3>{t('repositories:lp.releaseNotes')}</h3>
              <p><T key="repositories:lp.releaseNotesHint" /></p>
            </div>
          </div>
          {#if codes.length === 0}
            <p class="muted">{t('repositories:lp.noReleaseNotes')}</p>
          {:else}
            {#each codes as code (code)}
              <FieldEditor
                spec={changelogSpec}
                id="{uid}-{s}-{locale}-changelog-{code}"
                label={code === 'default' ? t('repositories:lp.releaseNotesDefault') : t('repositories:lp.releaseNotesFor', { code })}
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
              <h3>{t('repositories:lp.allLocales')}</h3>
              <p><T key="repositories:lp.allLocalesHint" params={{ file: copyrightLocation(src.source) }} /></p>
            </div>
          </div>
          <FieldEditor
            spec={copyrightSpec}
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

{#if readNotice !== null}
  <Alert tone="info" title={t('repositories:lp.notAvailable')}>{readNotice}</Alert>
{:else if loadError}
  <div class="stack">
    <Alert tone="error">{loadError}</Alert>
    <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
  </div>
{:else if data === null || edited === null}
  <div class="card" role="status" aria-label={t('repositories:lp.readingAria')}>
    <div class="stack">
      <Skeleton width="25%" height="14px" />
      <Skeleton height="36px" />
      <Skeleton width="25%" height="14px" />
      <Skeleton height="112px" />
      <p class="muted">{t('repositories:lp.readingFrom', { name: repositoryName(repository) })}</p>
    </div>
  </div>
{:else if listingIsEmpty(data)}
  <div class="stack loose">
    {@render targetBar()}
    <div class="card">
      <EmptyState icon="file-text" title={t('repositories:lp.noFilesTitle')} description={emptyListingDescription(data)}>
        {#snippet actions()}<Button icon="refresh" onclick={load}>{t('repositories:lp.checkAgain')}</Button>{/snippet}
      </EmptyState>
      {#each listingStores as s (s)}
        {#if s === 'app_store' ? data.sources.appStore.source === 'fastlane' : true}
          <h3 class="diag-title">{storeLabel[s]}</h3>
          {@render diagnosticFor(s)}
        {/if}
      {/each}
    </div>
  </div>
{:else}
  <div class="stack loose">
    {@render targetBar()}
    {#if !canEdit}
      <Alert tone="info">{t('repositories:lp.readOnly')}</Alert>
    {/if}
    {#if data.warnings.length > 0}
      <Alert tone="warn" title={t('repositories:lp.warnings')}>
        <ul class="plain">
          {#each data.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    <Tabs {tabs} bind:value={store} label={t('repositories:lp.storeTabs')} panel={storePanel} />

    {#if canEdit}
      <form
        class="card bar"
        aria-label={t('repositories:lp.formAria')}
        onsubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div class="card-header">
          <div>
            <h3>{t('repositories:lp.formTitle')}</h3>
            <p>
              {#if edits.length === 0}
                {t('repositories:lp.formHintEmpty')}
              {:else}
                {t('repositories:lp.formHintEdited', { count: edits.length })}
              {/if}
            </p>
          </div>
        </div>
        <TextField
          label={t('repositories:lp.summary')}
          bind:value={summary}
          oninput={() => (summaryTouched = true)}
          maxlength={200}
          autocomplete="off"
          hint={t('repositories:lp.summaryHint')}
        />
        {#if errorCount > 0 && edits.length > 0}
          <div class="gap">
            <Alert tone="warn">
              {t('repositories:lp.overLimit', { count: errorCount })}
            </Alert>
          </div>
        {/if}
        {#if createError}<div class="gap"><Alert tone="error">{createError}</Alert></div>{/if}
        <div class="row end gap">
          <Button disabled={edits.length === 0 || creating} onclick={discardEdits}>{t('repositories:lp.discardEdits')}</Button>
          <Button type="submit" variant="primary" icon="git-pull-request" loading={creating} disabled={edits.length === 0 || summary.trim() === ''}>
            {creating ? t('repositories:lp.creating') : t('repositories:lp.createDraft')}
          </Button>
        </div>
      </form>
    {/if}
  </div>
{/if}

{#if canManageTargets}
  <ListingTargetsDialog
    {api}
    {workspaceId}
    {repository}
    targets={savedTargets}
    bind:open={targetsOpen}
    prefill={targetsPrefill}
    onchanged={targetsChanged}
  />
{/if}

<style>
  .diag-title {
    padding: var(--space-3) var(--space-5) 0;
    margin: 0;
    font-size: var(--text-md, 1rem);
  }

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

  .source {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
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
