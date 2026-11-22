<!--
  BuildsPanelConventions: "Build number conventions". How this team's tags and GitHub releases carry
  a build number, as patterns with placeholders (`{platform}/{flavor}/{version}/{buildNumber}`), for
  the whole repository or for this app only (a monorepo with a tag prefix per app). A live preview
  reads the repository's real tag and release names through the draft, so a pattern is checked
  before it is saved, and an "add pattern" helper writes one from a single example name.
  Everyone who can see the app can read the conventions; saving needs the right to write
  repositories, and the preview (which asks GitHub) needs the right of a scan.
  Props: api, workspaceId, role, repository ({ id, owner, repo }), app, build (the build the helper
  takes its number and version from), onclose, onsaved (called with `{ rematch }` after a save;
  true when the person asked to match the builds again).
  Mount it when the dialog is opened; unmount it on close, so every open starts clean.
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { PLACEHOLDER_HELP, type PatternKind } from '@kiln/core';
  import { type Role, can, platformLabel } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type ConventionDraft,
    appendPattern,
    conventionSourceLabel,
    draftOf,
    draftProblems,
    draftValues,
    hasDraftProblems,
    previewConventions,
    previewReading,
    proposeFromExample,
    rowsForBuild,
    sameDraft,
  } from '../../lib/ci/ci.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppBuild, AppSummary, BuildConventionsView, RepositoryTags } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    role,
    repository,
    app,
    build,
    onclose,
    onsaved,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    repository: { id: string; owner: string; repo: string };
    app: AppSummary;
    build: Pick<AppBuild, 'buildNumber' | 'version'> | null;
    onclose: () => void;
    onsaved: (result: { rematch: boolean }) => void;
  } = $props();

  const uid = $props.id();
  const canWrite = $derived(can(role, 'repositories.write'));
  const canScan = $derived(can(role, 'repositories.scan'));
  /** How many names the preview lists before it says there are more. */
  const SHOWN = 12;

  let open = $state(true);
  let scope = $state<'repository' | 'app'>('repository');
  let view = $state<BuildConventionsView | null>(null);
  let draft = $state<ConventionDraft>({ tagText: '', releaseText: '', prefix: '', workflow: '' });
  let saved = $state<ConventionDraft>({ tagText: '', releaseText: '', prefix: '', workflow: '' });
  let loadProblem = $state('');
  let loading = $state(true);
  let names = $state<RepositoryTags | null>(null);
  let namesProblem = $state('');
  let namesLoading = $state(false);
  let saving = $state(false);
  let problem = $state('');
  let tried = $state(false);
  let rematch = $state(true);
  let showAllTags = $state(false);
  let showAllReleases = $state(false);

  // The helper: one example name in, one pattern out.
  let example = $state('');
  let kind = $state<PatternKind>('tag');
  let proposed = $state('');
  let helperMessage = $state('');

  const now = Date.now();
  let generation = 0;

  async function loadConventions() {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await api.buildConventions(workspaceId, repository.id, scope === 'app' ? app.id : undefined);
      if (mine !== generation) return;
      view = read;
      draft = draftOf(read);
      saved = draftOf(read);
      tried = false;
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      loadProblem = e instanceof ApiError ? e.message : t('portfolio:conv.loadFailed');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  async function loadNames() {
    namesLoading = true;
    namesProblem = '';
    try {
      names = await api.conventionTags(workspaceId, repository.id);
    } catch (e) {
      names = null;
      namesProblem = e instanceof ApiError ? e.message : t('portfolio:conv.tagsFailed');
    } finally {
      namesLoading = false;
    }
  }

  $effect(() => {
    void scope;
    untrack(() => void loadConventions());
  });

  $effect(() => {
    if (canScan) untrack(() => void loadNames());
  });

  const problems = $derived(draftProblems(draft));
  const invalid = $derived(hasDraftProblems(problems));
  const changed = $derived(!sameDraft(draft, saved));
  const preview = $derived(names ? previewConventions(names, draft, app.platform) : null);
  const tagRows = $derived(preview ? (showAllTags ? preview.tags : preview.tags.slice(0, SHOWN)) : []);
  const releaseRows = $derived(preview ? (showAllReleases ? preview.releases : preview.releases.slice(0, SHOWN)) : []);
  const forBuild = $derived(
    build && preview
      ? { tags: rowsForBuild(preview.tags, build.buildNumber), releases: rowsForBuild(preview.releases, build.buildNumber) }
      : null,
  );
  /** Names that fit no pattern: the likely examples for the helper. */
  const unmatched = $derived(
    preview
      ? [...preview.tags.filter((r) => !r.matched).map((r) => r.name), ...preview.releases.filter((r) => !r.matched).map((r) => r.name)].slice(0, 60)
      : [],
  );
  const defaults = $derived(view?.defaults ?? { tagPatterns: [], releasePatterns: [] });

  function propose() {
    helperMessage = '';
    proposed = '';
    if (!build) {
      helperMessage = t('portfolio:conv.noBuilds');
      return;
    }
    const result = proposeFromExample(example, build, kind);
    if (result.ok) proposed = result.pattern;
    else helperMessage = result.message;
  }

  function addProposed() {
    const into = kind === 'tag' ? draft.tagText : draft.releaseText;
    const done = appendPattern(into, proposed, kind === 'tag' ? defaults.tagPatterns : defaults.releasePatterns);
    if (!done.added) {
      helperMessage = done.reason ?? '';
      return;
    }
    if (kind === 'tag') draft.tagText = done.text;
    else draft.releaseText = done.text;
    helperMessage = kind === 'tag' ? t('portfolio:conv.addedTag') : t('portfolio:conv.addedRelease');
    proposed = '';
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    tried = true;
    if (!canWrite || invalid) return;
    saving = true;
    problem = '';
    try {
      const values = draftValues(draft);
      await api.setBuildConventions(workspaceId, repository.id, { ...(scope === 'app' ? { appId: app.id } : {}), ...values });
      toast.success(scope === 'app' ? t('portfolio:conv.savedApp', { name: app.name }) : t('portfolio:conv.savedRepository'));
      onsaved({ rematch });
      open = false;
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('portfolio:conv.saveFailed');
    } finally {
      saving = false;
    }
  }

  const usingDefaults = $derived(draft.tagText.trim() === '' && draft.releaseText.trim() === '');
</script>

<Modal
  bind:open
  size="lg"
  title={t('portfolio:builds.conventions')}
  description={t('portfolio:conv.description', { repository: `${repository.owner}/${repository.repo}` })}
  dismissible={!saving}
  {onclose}
>
  <form id="{uid}-form" class="stack loose" novalidate onsubmit={save}>
    {#if loading && !view}
      <div class="stack" role="status" aria-label={t('portfolio:conv.loading')}>
        <Skeleton width="80%" height="16px" />
        <Skeleton width="60%" height="16px" />
        <Skeleton width="70%" height="16px" />
      </div>
    {:else if loadProblem}
      <div class="stack">
        <Alert tone="error" title={t('portfolio:conv.loadFailedTitle')}>{loadProblem}</Alert>
        <div><Button icon="refresh" onclick={loadConventions}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else if view}
      {#if !canWrite}
        <Alert tone="info" title={t('portfolio:conv.readOnly')}>
          {canScan ? t('portfolio:conv.readOnlyScan') : t('portfolio:conv.readOnlyHelp')}
        </Alert>
      {/if}

      <fieldset class="scope">
        <legend>{t('portfolio:conv.appliesTo')}</legend>
        <label class="choice">
          <input type="radio" name="{uid}-scope" value="repository" bind:group={scope} disabled={saving} />
          <span>{t('portfolio:conv.allApps')}</span>
        </label>
        <label class="choice">
          <input type="radio" name="{uid}-scope" value="app" bind:group={scope} disabled={saving} />
          <span>{t('portfolio:conv.onlyApp', { name: app.name })}<span class="muted text-sm"> {t('portfolio:conv.onlyAppNote')}</span></span>
        </label>
      </fieldset>

      <p class="muted text-sm">
        {t('portfolio:conv.inUse', { source: conventionSourceLabel(view.effective) })}
        {#if scope === 'app' && view.stored === null && view.repository}{t('portfolio:conv.followsRepository')}{/if}
        {#if view.stored === null}{t('portfolio:conv.nothingStored')}{/if}
      </p>

      <div class="field">
        <label for="{uid}-tags">{t('portfolio:conv.tagPatterns')}</label>
        <textarea
          id="{uid}-tags"
          rows="4"
          bind:value={draft.tagText}
          disabled={!canWrite || saving}
          spellcheck="false"
          autocomplete="off"
          aria-invalid={tried && problems.tags.length > 0}
          aria-describedby="{uid}-tags-hint"
          placeholder={defaults.tagPatterns.slice(0, 3).join('\n')}
        ></textarea>
        <p class="hint" id="{uid}-tags-hint">
          <T key="portfolio:conv.tagHint" params={{ count: defaults.tagPatterns.length }} />
        </p>
        {#if problems.tags.length > 0}
          <ul class="problems" id="{uid}-tags-problems">
            {#each problems.tags as message (message)}<li>{message}</li>{/each}
          </ul>
        {/if}
      </div>

      <div class="field">
        <label for="{uid}-releases">{t('portfolio:conv.releasePatterns')}</label>
        <textarea
          id="{uid}-releases"
          rows="3"
          bind:value={draft.releaseText}
          disabled={!canWrite || saving}
          spellcheck="false"
          autocomplete="off"
          aria-invalid={tried && problems.releases.length > 0}
          aria-describedby="{uid}-releases-hint"
          placeholder={defaults.releasePatterns.slice(0, 2).join('\n')}
        ></textarea>
        <p class="hint" id="{uid}-releases-hint">
          <T key="portfolio:conv.releaseHint" params={{ count: defaults.releasePatterns.length }} />
        </p>
        {#if problems.releases.length > 0}
          <ul class="problems" id="{uid}-releases-problems">
            {#each problems.releases as message (message)}<li>{message}</li>{/each}
          </ul>
        {/if}
      </div>

      <div class="two">
        <TextField
          label={t('portfolio:conv.prefix')}
          bind:value={draft.prefix}
          disabled={!canWrite || saving}
          error={problems.prefix}
          hint={t('portfolio:conv.prefixHint', { help: PLACEHOLDER_HELP.prefix })}
          autocomplete="off"
          spellcheck={false}
        />
        <TextField
          label={t('portfolio:conv.workflow')}
          bind:value={draft.workflow}
          disabled={!canWrite || saving}
          error={problems.workflow}
          hint={t('portfolio:conv.workflowHint')}
          autocomplete="off"
          spellcheck={false}
        />
      </div>

      <details>
        <summary>{t('portfolio:conv.builtIn')}</summary>
        <p class="muted text-sm">{t('portfolio:conv.usedWhenEmpty')}</p>
        <p class="text-sm"><strong>{t('portfolio:conv.tags')}</strong></p>
        <ul class="plain">
          {#each defaults.tagPatterns as pattern (pattern)}<li><code>{pattern}</code></li>{/each}
        </ul>
        <p class="text-sm"><strong>{t('portfolio:conv.releases')}</strong></p>
        <ul class="plain">
          {#each defaults.releasePatterns as pattern (pattern)}<li><code>{pattern}</code></li>{/each}
        </ul>
      </details>

      <section class="stack" aria-labelledby="{uid}-preview">
        <h3 id="{uid}-preview">{t('portfolio:conv.preview')}</h3>
        {#if !canScan}
          <p class="muted">{t('portfolio:conv.noScan')}</p>
        {:else if namesLoading && !names}
          <div class="stack" role="status" aria-label={t('portfolio:conv.readingTags')}>
            <Skeleton width="75%" height="14px" />
            <Skeleton width="60%" height="14px" />
          </div>
        {:else if namesProblem}
          <Alert tone="warn" title={t('portfolio:conv.tagsFailedTitle')}>{namesProblem}</Alert>
          <div><Button size="sm" icon="refresh" onclick={loadNames}>{t('common:action.tryAgain')}</Button></div>
        {:else if names && preview}
          <p class="muted text-sm">
            {#snippet readTime(text: string)}<time datetime={new Date(names.readAt).toISOString()}>{text}</time>{/snippet}
            <T key="portfolio:conv.read" params={{ tags: names.tagsTruncated ? t('portfolio:conv.tagCountMore', { count: names.tags.length }) : t('portfolio:conv.tagCount', { count: names.tags.length }), releases: names.releasesTruncated ? t('portfolio:conv.releaseCountMore', { count: names.releases.length }) : t('portfolio:conv.releaseCount', { count: names.releases.length }), when: timeAgo(names.readAt, now) }} tags={{ link: readTime }} />
            {t('portfolio:conv.fits', { tags: t('portfolio:conv.tagCount', { count: preview.tagFits }), releases: t('portfolio:conv.releaseCount', { count: preview.releaseFits }), platform: platformLabel(app.platform) })}
          </p>
          {#if names.releasesError}<Alert tone="warn" title={t('portfolio:conv.releasesFailed')}>{names.releasesError}</Alert>{/if}
          {#if build && forBuild}
            <p aria-live="polite">
              {#if forBuild.tags.length + forBuild.releases.length > 0}
                <Badge tone="ok">{t('portfolio:conv.foundBadge')}</Badge>
                <T key="portfolio:conv.found" params={{ count: forBuild.tags.length + forBuild.releases.length, build: build.buildNumber, example: (forBuild.tags[0] ?? forBuild.releases[0])?.name ?? '' }} />
              {:else}
                <Badge tone="warn">{t('portfolio:conv.notFoundBadge')}</Badge>
                {t('portfolio:conv.notFound', { build: build.buildNumber })}
              {/if}
            </p>
          {/if}

          {#if names.tags.length > 0}
            <div class="table-wrap">
              <table>
                <caption class="visually-hidden">{t('portfolio:conv.tagsCaption')}</caption>
                <thead>
                  <tr><th scope="col">{t('portfolio:conv.tag')}</th><th scope="col">{t('portfolio:conv.readAs')}</th></tr>
                </thead>
                <tbody>
                  {#each tagRows as row (row.name)}
                    <tr>
                      <td><code>{row.name}</code></td>
                      <td class:muted={!row.matched || row.platformOk === false}>{previewReading(row)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if preview.tags.length > SHOWN}
              <div><Button size="sm" variant="ghost" onclick={() => (showAllTags = !showAllTags)}>{showAllTags ? t('portfolio:conv.fewerTags') : t('portfolio:conv.allTags', { count: preview.tags.length })}</Button></div>
            {/if}
          {/if}

          {#if names.releases.length > 0}
            <div class="table-wrap">
              <table>
                <caption class="visually-hidden">{t('portfolio:conv.releasesCaption')}</caption>
                <thead>
                  <tr><th scope="col">{t('portfolio:conv.release')}</th><th scope="col">{t('portfolio:conv.readAs')}</th></tr>
                </thead>
                <tbody>
                  {#each releaseRows as row, i (`${i}-${row.name}`)}
                    <tr>
                      <td>{row.name}</td>
                      <td class:muted={!row.matched || row.platformOk === false}>{previewReading(row)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if preview.releases.length > SHOWN}
              <div><Button size="sm" variant="ghost" onclick={() => (showAllReleases = !showAllReleases)}>{showAllReleases ? t('portfolio:conv.fewerReleases') : t('portfolio:conv.allReleases', { count: preview.releases.length })}</Button></div>
            {/if}
          {/if}
          {#if names.tags.length === 0 && names.releases.length === 0}
            <p class="muted">{t('portfolio:conv.noTags')}</p>
          {/if}
        {/if}
      </section>

      {#if canWrite}
        <section class="stack helper" aria-labelledby="{uid}-helper">
          <h3 id="{uid}-helper">{t('portfolio:conv.helperTitle')}</h3>
          <p class="muted text-sm">
            {build ? t('portfolio:conv.helperBuild', { build: build.buildNumber }) : t('portfolio:conv.helperNoBuild')}
          </p>
          <fieldset class="scope inline">
            <legend class="visually-hidden">{t('portfolio:conv.exampleIs')}</legend>
            <label class="choice"><input type="radio" name="{uid}-kind" value="tag" bind:group={kind} /> <span>{t('portfolio:conv.tag')}</span></label>
            <label class="choice"><input type="radio" name="{uid}-kind" value="release" bind:group={kind} /> <span>{t('portfolio:conv.releaseName')}</span></label>
          </fieldset>
          <TextField
            label={t('portfolio:conv.exampleName')}
            bind:value={example}
            list="{uid}-examples"
            autocomplete="off"
            spellcheck={false}
            hint={unmatched.length > 0 ? t('portfolio:conv.examplePick') : t('portfolio:conv.exampleType')}
          />
          <datalist id="{uid}-examples">
            {#each unmatched as name (name)}<option value={name}></option>{/each}
          </datalist>
          <div class="buttons">
            <Button size="sm" onclick={propose} disabled={example.trim() === ''}>{t('portfolio:conv.propose')}</Button>
            {#if proposed}<Button size="sm" variant="primary" icon="plus" onclick={addProposed}>{kind === 'tag' ? t('portfolio:conv.addToTag') : t('portfolio:conv.addToRelease')}</Button>{/if}
          </div>
          {#if proposed}<p><T key="portfolio:conv.proposed" params={{ pattern: proposed }} /></p>{/if}
          <p class="text-sm" role="status">{helperMessage}</p>
        </section>
      {/if}

      {#if canWrite}
        <label class="choice">
          <input type="checkbox" bind:checked={rematch} disabled={saving} />
          <span>{t('portfolio:conv.rematch')}</span>
        </label>
        {#if usingDefaults && changed}<p class="muted text-sm">{t('portfolio:conv.bothEmpty')}</p>{/if}
      {/if}
      {#if problem}<Alert tone="error" title={t('portfolio:conv.saveFailedTitle')}>{problem}</Alert>{/if}
    {/if}
  </form>

  {#snippet footer()}
    <Button disabled={saving} onclick={() => (open = false)}>{canWrite ? t('common:action.cancel') : t('common:action.close')}</Button>
    {#if canWrite}
      <Button variant="primary" type="submit" form="{uid}-form" loading={saving} disabled={!view || !changed || (tried && invalid)}>{t('portfolio:conv.save')}</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .scope {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .scope legend {
    margin-bottom: var(--space-2);
    font-weight: var(--weight-semibold);
  }

  .scope.inline {
    flex-direction: row;
    gap: var(--space-4);
  }

  .choice {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: 0;
    font-weight: var(--weight-regular);
  }

  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-4);
  }

  .problems {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
    color: var(--danger-text, var(--danger));
    font-size: var(--text-sm);
  }

  .hint {
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .plain {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-5);
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .helper {
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  td code {
    overflow-wrap: anywhere;
  }
</style>
