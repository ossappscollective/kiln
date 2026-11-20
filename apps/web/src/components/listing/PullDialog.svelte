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
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
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
        problem = 'Something went wrong. Try again.';
      }
    } finally {
      busy = false;
    }
  }

  const rootsText = (c: PullCandidate) =>
    [c.roots.appStore, c.roots.googlePlay].filter((r): r is string => r !== null && r !== '').join(' and ') || 'no folders';
</script>

<Modal
  bind:open
  size="lg"
  dismissible={!busy}
  title="Pull into the repository"
  description="Copies the store's text into the listing files of the repository as a draft change set. Nothing changes in the store or in the repository until a person approves the change set and it is applied."
>
  <form id="pull-{uid}" class="stack" onsubmit={submit}>
    <section aria-label="Where it goes">
      <h3>Where it goes</h3>
      {#if repoState === 'loading'}
        <div role="status" aria-label="Loading the repository"><Skeleton width="60%" height="14px" /></div>
      {:else if repoState === 'error' || !repository}
        <p class="muted">The repository could not be loaded here. The change set still goes to the repository linked to this app.</p>
      {:else}
        <dl class="target">
          <div><dt>Repository</dt><dd>{repository.owner}/{repository.repo}</dd></div>
          <div><dt>Branch</dt><dd><code>{repository.defaultBranch}</code> (the pull request will target it)</dd></div>
          <div>
            <dt>{storeName(app.platform)} listing</dt>
            <dd>
              {#if source}
                <code>{source.path}</code> <span class="muted">· {sourceKindLabel(source.source)}</span>
              {:else}
                <span class="muted">No listing source was found by the last scan. The files are created in the default folder.</span>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="muted small">A saved listing target of this app, or the one you choose below, decides the exact folder when the draft is made.</p>
      {/if}
    </section>

    <section aria-label="What changes">
      <h3>What changes: {selectionText(fields)}</h3>
      <ul class="changes">
        {#each fields as field (field.locale + field.field)}
          {@const u = usage(field.live.value, field.limit, field.unit)}
          <li>
            <h4>{field.locale} · {field.label}</h4>
            <div class="pair">
              <div class="side">
                <p class="side-title">Now in the repository</p>
                <div class="text"><DiffText from={field.repo.value ?? ''} to={field.live.value ?? ''} side="from" fromName="the repository" toName="the store" /></div>
              </div>
              <span class="arrow" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>
              <div class="side">
                <p class="side-title">Will become (from the store)</p>
                <div class="text"><DiffText from={field.repo.value ?? ''} to={field.live.value ?? ''} side="to" fromName="the repository" toName="the store" /></div>
              </div>
            </div>
            <p class="meta" class:over={overLimit(field)}>
              {usageText(u)}{#if overLimit(field)}: over the store limit, so this field will be left out, not shortened.{/if}
            </p>
          </li>
        {/each}
      </ul>
    </section>

    <section class="options" aria-label="Options">
      {#if canRefresh}
        <label class="check">
          <input type="checkbox" bind:checked={refresh} disabled={busy} />
          <span>Refresh from the store first <span class="muted">(reads the store again, and counts toward the limit of 10 store reads a minute)</span></span>
        </label>
      {/if}
      <div class="field">
        <label for="pull-summary-{uid}">Summary of the change set</label>
        <input id="pull-summary-{uid}" type="text" maxlength="200" bind:value={summary} disabled={busy} />
      </div>
    </section>

    {#if candidates.length > 0}
      <fieldset class="choices">
        <legend>Where in the repository?</legend>
        {#each candidates as candidate (candidate.id)}
          <label class="check">
            <input type="radio" name="pull-target-{uid}" value={candidate.id} bind:group={chosenTarget} disabled={busy} />
            <span>{candidate.label} <span class="muted">· {rootsText(candidate)}</span></span>
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if problem}
      <Alert tone="error" title="Could not create the draft">{problem}</Alert>
    {/if}
  </form>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    <Button
      type="submit"
      form="pull-{uid}"
      variant="primary"
      icon="git-pull-request"
      loading={busy}
      disabled={fields.length === 0 || pullCount === 0}
    >Create draft change set</Button>
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
