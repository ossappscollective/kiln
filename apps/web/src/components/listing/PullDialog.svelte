<!--
  PullDialog: pull the live store text of some listing fields into the repository, as a draft change
  set. Shows where it goes (repository, branch, file or folder, kind of source) and exactly the old
  and the new text of every field, with the words that differ marked. Creating the draft changes
  nothing in the store and nothing in the repository: a person with approval rights reviews it, then
  it is applied.
  Props: open (bindable), api, workspaceId, role, app, fields (the DriftField rows to pull),
  channel (the store copy the listing view shows), onpulled (called with the answer, also when there
  was nothing to change).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    buildPullRequest,
    candidatesOf,
    defaultPullSummary,
    detectedPullSource,
    pullErrorMessage,
    selectionText,
    sourceKindLabel,
  } from '../../lib/listing/pull.ts';
  import { usage, usageText } from '../../lib/listing/drift.ts';
  import { storeName } from '../../lib/portfolio.ts';
  import type { AppSummary, DriftField, ProjectDetection, PullCandidate, PullResult, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import DiffText from './DiffText.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role,
    app,
    fields,
    channel,
    onpulled,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    fields: DriftField[];
    channel: 'live' | 'editable' | null;
    onpulled: (result: PullResult) => void;
  } = $props();

  const uid = $props.id();
  const canRefresh = $derived(can(role, 'apps.sync'));

  let refresh = $state(false);
  let summary = $state('');
  let busy = $state(false);
  let problem = $state('');
  let candidates = $state<PullCandidate[]>([]);
  let chosenTarget = $state('');
  let repository = $state<RepositorySummary | null>(null);
  let detection = $state<ProjectDetection | null>(null);
  let repoState = $state<'loading' | 'ready' | 'error'>('loading');
  let generation = 0;

  const source = $derived(detectedPullSource(detection, app.platform));
  const overLimit = (field: DriftField) => field.problems.live.some((p) => p.code === 'too_long' && p.severity === 'error');
  const pullCount = $derived(fields.filter((f) => !overLimit(f)).length);

  // Every time the dialog opens: clean options, and the repository the files would go to. Only
  // `open` re-runs this, so a refresh of the app behind the dialog does not reset what was typed.
  $effect(() => {
    if (!open) return;
    untrack(start);
  });

  function start() {
    refresh = false;
    summary = defaultPullSummary(app.name, app.platform);
    problem = '';
    candidates = [];
    chosenTarget = '';
    busy = false;
    const mine = ++generation;
    repoState = 'loading';
    repository = null;
    detection = null;
    const id = app.repositoryId;
    if (id === null) {
      repoState = 'error';
      return;
    }
    api
      .repository(workspaceId, id)
      .then((detail) => {
        if (mine !== generation) return;
        repository = detail.repository;
        detection = detail.detection;
        repoState = 'ready';
      })
      .catch(() => {
        if (mine === generation) repoState = 'error';
      });
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (busy || fields.length === 0) return;
    busy = true;
    problem = '';
    try {
      const result = await api.pullAppListing(
        workspaceId,
        app.id,
        buildPullRequest(fields, {
          channel,
          refresh: refresh && canRefresh,
          summary,
          ...(chosenTarget ? { target: chosenTarget } : {}),
        }),
      );
      open = false;
      onpulled(result);
    } catch (e) {
      if (e instanceof ApiError) {
        candidates = candidatesOf(e);
        if (candidates.length > 0 && chosenTarget === '') chosenTarget = candidates[0]?.id ?? '';
        problem = pullErrorMessage(e);
      } else {
        problem = t('common:error.genericRetry');
      }
    } finally {
      busy = false;
    }
  }

  const rootsText = (c: PullCandidate) =>
    formatList([c.roots.appStore, c.roots.googlePlay].filter((r): r is string => r !== null && r !== '')) || t('listing:pullDialog.noFolders');
</script>

<Modal
  bind:open
  size="lg"
  dismissible={!busy}
  title={t('listing:pullResult.title')}
  description={t('listing:pullDialog.description')}
>
  <form id="pull-{uid}" class="stack" onsubmit={submit}>
    <section aria-label={t('listing:pullDialog.whereAria')}>
      <h3>{t('listing:pullDialog.where')}</h3>
      {#if repoState === 'loading'}
        <div role="status" aria-label={t('listing:pullDialog.loadingRepoAria')}><Skeleton width="60%" height="14px" /></div>
      {:else if repoState === 'error' || !repository}
        <p class="muted">{t('listing:pullDialog.repoError')}</p>
      {:else}
        <dl class="target">
          <div><dt>{t('listing:pullDialog.repository')}</dt><dd>{repository.owner}/{repository.repo}</dd></div>
          <div><dt>{t('listing:pullDialog.branch')}</dt><dd><T key="listing:pullDialog.branchValue" params={{ branch: repository.defaultBranch }} /></dd></div>
          <div>
            <dt>{t('listing:pullDialog.storeListing', { store: storeName(app.platform) })}</dt>
            <dd>
              {#if source}
                <code>{source.path}</code> <span class="muted">· {sourceKindLabel(source.source)}</span>
              {:else}
                <span class="muted">{t('listing:pullDialog.noSource')}</span>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="muted small">{t('listing:pullDialog.targetHint')}</p>
      {/if}
    </section>

    <section aria-label={t('listing:pullDialog.changesAria')}>
      <h3>{t('listing:pullDialog.whatChanges', { selection: selectionText(fields) })}</h3>
      <ul class="changes">
        {#each fields as field (field.locale + field.field)}
          {@const u = usage(field.live.value, field.limit, field.unit)}
          <li>
            <h4>{t('listing:pullResult.changeLine', { locale: field.locale, label: field.label })}</h4>
            <div class="pair">
              <div class="side">
                <p class="side-title">{t('listing:pullDialog.nowInRepo')}</p>
                <div class="text"><DiffText from={field.repo.value ?? ''} to={field.live.value ?? ''} side="from" fromName={t('listing:diff.name.repository')} toName={t('listing:diff.name.store')} /></div>
              </div>
              <span class="arrow" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>
              <div class="side">
                <p class="side-title">{t('listing:pullDialog.willBecome')}</p>
                <div class="text"><DiffText from={field.repo.value ?? ''} to={field.live.value ?? ''} side="to" fromName={t('listing:diff.name.repository')} toName={t('listing:diff.name.store')} /></div>
              </div>
            </div>
            <p class="meta" class:over={overLimit(field)}>
              {overLimit(field) ? t('listing:pullDialog.overLimit', { usage: usageText(u) }) : usageText(u)}
            </p>
          </li>
        {/each}
      </ul>
    </section>

    <section class="options" aria-label={t('listing:pullDialog.optionsAria')}>
      {#if canRefresh}
        <label class="check">
          <input type="checkbox" bind:checked={refresh} disabled={busy} />
          <span>{t('listing:pullDialog.refresh')} <span class="muted">{t('listing:pullDialog.refreshHint')}</span></span>
        </label>
      {/if}
      <div class="field">
        <label for="pull-summary-{uid}">{t('listing:pullDialog.summary')}</label>
        <input id="pull-summary-{uid}" type="text" maxlength="200" bind:value={summary} disabled={busy} />
      </div>
    </section>

    {#if candidates.length > 0}
      <fieldset class="choices">
        <legend>{t('listing:pullDialog.whereInRepo')}</legend>
        {#each candidates as candidate (candidate.id)}
          <label class="check">
            <input type="radio" name="pull-target-{uid}" value={candidate.id} bind:group={chosenTarget} disabled={busy} />
            <span>{candidate.label} <span class="muted">· {rootsText(candidate)}</span></span>
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if problem}
      <Alert tone="error" title={t('listing:pullDialog.couldNot')}>{problem}</Alert>
    {/if}
  </form>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button
      type="submit"
      form="pull-{uid}"
      variant="primary"
      icon="git-pull-request"
      loading={busy}
      disabled={fields.length === 0 || pullCount === 0}
    >{t('listing:pullDialog.create')}</Button>
  {/snippet}
</Modal>

<style>
  h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .small {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .target {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    font-size: var(--text-sm);
  }

  .target div {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
  }

  .target dt {
    min-width: 9rem;
    font-weight: var(--weight-semibold);
  }

  .target dd {
    margin: 0;
  }

  .changes {
    display: grid;
    gap: var(--space-3);
    max-height: 22rem;
    padding: 0;
    margin: 0;
    overflow: auto;
    list-style: none;
  }

  .changes li {
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--space-3);
    align-items: start;
  }

  .side-title {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .text {
    max-height: 10rem;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .arrow {
    padding-top: var(--space-5);
    color: var(--muted);
  }

  .meta {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .meta.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .options {
    display: grid;
    gap: var(--space-3);
  }

  .choices {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  @media (max-width: 640px) {
    .pair {
      grid-template-columns: minmax(0, 1fr);
    }

    .arrow {
      display: none;
    }
  }
</style>
