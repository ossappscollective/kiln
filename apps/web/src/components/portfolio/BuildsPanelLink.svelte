<!--
  BuildsPanelLink: link a build to the CI run that made it, by hand. Pick one of the recent runs
  (only runs with a commit can explain a build), or type a run id that is not listed. A link made
  here stays until it is removed; the automatic matching never replaces it.
  Props: api, workspaceId, appId, repository ({ id, owner, repo }), build, onclose, onlinked
  (called with the updated build). Mount it when a build is chosen; unmount it on close.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { buildName, isPending, runTitle, shortSha, sortRuns } from '../../lib/ci/ci.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppBuild, WorkflowRun } from '../../lib/types.ts';
  import RunStatus from '../ci/RunStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    appId,
    repository,
    build,
    onclose,
    onlinked,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    repository: { id: string; owner: string; repo: string };
    build: AppBuild;
    onclose: () => void;
    onlinked: (build: AppBuild) => void;
  } = $props();

  const uid = $props.id();

  let open = $state(true);
  let runs = $state<WorkflowRun[] | null>(null);
  let loadProblem = $state('');
  let chosen = $state('');
  let typed = $state('');
  let submitting = $state(false);
  let problem = $state('');
  const now = Date.now();

  async function load() {
    loadProblem = '';
    try {
      const read = await api.workflowRuns(workspaceId, repository.id, { limit: 50 });
      runs = sortRuns(read.runs.filter((r) => r.headSha !== null && !isPending(r)));
    } catch (e) {
      runs = [];
      loadProblem = e instanceof ApiError ? e.message : t('portfolio:link.loadRunsFailed');
    }
  }

  $effect(() => {
    untrack(() => void load());
  });

  const runId = $derived(typed.trim() !== '' ? typed.trim() : chosen);
  const typedProblem = $derived(typed.trim() !== '' && !/^[0-9]{1,20}$/.test(typed.trim()) ? t('portfolio:link.runIdInvalid') : '');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (runId === '' || typedProblem) return;
    submitting = true;
    problem = '';
    try {
      const done = await api.linkBuild(workspaceId, appId, build, runId);
      toast.success(t('portfolio:link.linked', { name: buildName(build), run: runId }));
      onlinked(done.build);
      open = false;
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('portfolio:link.failed');
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  bind:open
  size="md"
  title={t('portfolio:link.title', { build: build.buildNumber })}
  description={t('portfolio:link.description', { name: buildName(build) })}
  dismissible={!submitting}
  {onclose}
>
  <form id="{uid}-form" class="stack" novalidate onsubmit={submit}>
    {#if runs === null}
      <div class="stack" role="status" aria-label={t('portfolio:link.loadingRuns')}>
        <Skeleton width="80%" height="16px" />
        <Skeleton width="65%" height="16px" />
        <Skeleton width="72%" height="16px" />
      </div>
    {:else}
      {#if loadProblem}<Alert tone="warn" title={t('portfolio:link.loadRunsTitle')}>{loadProblem} {t('portfolio:link.stillType')}</Alert>{/if}
      {#if runs.length > 0}
        <fieldset class="runs">
          <legend>{t('portfolio:link.recent', { repository: `${repository.owner}/${repository.repo}` })}</legend>
          {#each runs as run (run.id)}
            <label class="run">
              <input type="radio" name="{uid}-run" value={run.id} bind:group={chosen} disabled={typed.trim() !== ''} />
              <span class="what">
                <span class="line"><RunStatus {run} /> <strong>{runTitle(run)}</strong></span>
                <span class="muted text-sm">
                  {run.workflow}{#if run.branch} · {run.branch}{/if}{#if run.headSha} · <code>{shortSha(run.headSha)}</code>{/if} · {timeAgo(run.startedAt, now)}
                </span>
              </span>
            </label>
          {/each}
        </fieldset>
      {:else if !loadProblem}
        <p class="muted">{t('portfolio:link.noRuns')}</p>
      {/if}
      <TextField
        label={t('portfolio:link.orRunId')}
        bind:value={typed}
        error={typedProblem || undefined}
        hint={t('portfolio:link.runIdHint')}
        inputmode="numeric"
        autocomplete="off"
      />
    {/if}
    {#if problem}<Alert tone="error" title={t('portfolio:link.failedTitle')}>{problem}</Alert>{/if}
  </form>

  {#snippet footer()}
    <Button disabled={submitting} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="primary" type="submit" form="{uid}-form" loading={submitting} disabled={runId === '' || typedProblem !== ''}>{t('portfolio:link.submit')}</Button>
  {/snippet}
</Modal>

<style>
  .runs {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 18rem;
    overflow-y: auto;
  }

  .runs legend {
    margin-bottom: var(--space-2);
    font-weight: var(--weight-semibold);
  }

  .run {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    font-weight: var(--weight-regular);
    cursor: pointer;
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .line {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    overflow-wrap: anywhere;
  }
</style>
