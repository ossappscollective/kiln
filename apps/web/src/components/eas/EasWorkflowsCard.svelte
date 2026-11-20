<!--
  EasWorkflowsCard: EAS Workflows of ONE linked app record (docs/adr/0035-eas-workflows.md): start a workflow of the Expo project and see
  the runs started here. The runs are also listed with the runs of the app's repository, like any other CI run; this is where to start one
  and where Expo is asked for a run that is going. Starting runs the team's workflow with the project's EAS secrets, so it takes two steps
  (fill in, then confirm) and needs the member or admin role (`ci.dispatch`).
  Props: api, workspaceId, role, app (id, repositoryId), link (the saved Expo link), now (epoch ms).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { onMount } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { runTitle, runProvider } from '../../lib/ci/ci.ts';
  import type { ExpoLinkView } from '../../lib/eas/eas.ts';
  import {
    activeRuns,
    easWorkflowErrorText,
    startBlocker,
    startForm,
    startSummary,
    type EasWorkflowDispatchBody,
  } from '../../lib/eas/eas-workflows.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { WorkflowRun } from '../../lib/types.ts';
  import RunStatus from '../ci/RunStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import '../readable-card.css';

  let {
    api,
    workspaceId,
    role,
    app,
    link,
    now,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; repositoryId: string | null };
    link: ExpoLinkView;
    now: number;
  } = $props();

  const uid = $props.id();
  const canStart = $derived(can(role, 'ci.dispatch'));
  const canAsk = $derived(can(role, 'apps.sync'));
  const blocker = $derived(startBlocker({ credentialAvailable: link.credentialAvailable, hasRepository: app.repositoryId !== null, canStart }));

  let runs = $state<WorkflowRun[] | null>(null);
  let workflow = $state('');
  let ref = $state('');
  let inputsText = $state('');
  let problems = $state<string[]>([]);
  let confirming = $state<EasWorkflowDispatchBody | null>(null);
  let starting = $state(false);
  let refreshing = $state(false);
  let problem = $state('');
  let readProblem = $state('');

  async function load() {
    try {
      runs = (await api.easWorkflowRuns(workspaceId, app.id)).runs;
      readProblem = '';
    } catch (e) {
      readProblem = easWorkflowErrorText(e);
      if (runs === null) runs = [];
    }
  }

  // The server follows a run until it finishes; this only reads what it stored, every 15 seconds while one is going and the tab is shown.
  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && runs !== null && activeRuns(runs).length > 0) void load();
    }, 15_000);
    return () => clearInterval(timer);
  });

  function review() {
    const checked = startForm({ workflow, ref, inputsText });
    problems = checked.problems;
    problem = '';
    confirming = checked.body;
  }

  async function start() {
    const body = confirming;
    if (!body || starting) return;
    starting = true;
    problem = '';
    try {
      const out = await api.dispatchEasWorkflow(workspaceId, app.id, body);
      runs = [out.run, ...(runs ?? []).filter((r) => r.id !== out.run.id)];
      confirming = null;
      workflow = '';
      ref = '';
      inputsText = '';
      toast.success(`Asked Expo to start ${body.workflow}. The run is followed below.`);
    } catch (e) {
      problem = easWorkflowErrorText(e);
      confirming = null;
    } finally {
      starting = false;
    }
  }

  /** Asks Expo for each run that is going (the server stores the answer), then reads the list again. */
  async function refreshFromExpo() {
    if (!canAsk || refreshing || runs === null) return;
    refreshing = true;
    readProblem = '';
    try {
      for (const run of activeRuns(runs).slice(0, 10)) await api.easWorkflowRun(workspaceId, app.id, run.id, true);
      await load();
    } catch (e) {
      readProblem = easWorkflowErrorText(e);
    } finally {
      refreshing = false;
    }
  }

  const shown = $derived((runs ?? []).slice(0, 8));
  const going = $derived(runs === null ? 0 : activeRuns(runs).length);
</script>

<div class="stack readable-card">
  <h4 class="title">Workflows</h4>
  <p class="muted">Start a workflow of {link.fullName} and follow it here. Runs also appear with the runs of the repository and in the release pipeline.</p>

  {#if blocker !== ''}
    <p class="muted">{blocker}</p>
  {:else if confirming === null}
    <div class="field">
      <label for="{uid}-workflow">Workflow file</label>
      <input id="{uid}-workflow" type="text" autocomplete="off" spellcheck="false" placeholder=".eas/workflows/build.yml" bind:value={workflow} disabled={starting} />
    </div>
    <div class="field">
      <label for="{uid}-ref">Branch, tag or commit</label>
      <input id="{uid}-ref" type="text" autocomplete="off" spellcheck="false" placeholder="The default branch of the repository" bind:value={ref} disabled={starting} />
    </div>
    <div class="field">
      <label for="{uid}-inputs">Inputs</label>
      <textarea id="{uid}-inputs" rows="3" spellcheck="false" placeholder="name=value, one per line" bind:value={inputsText} disabled={starting}></textarea>
      <p class="hint">Only the inputs the workflow file declares under on.workflow_dispatch. Leave empty to use their defaults.</p>
    </div>
    {#if problems.length > 0}<Alert tone="error">{#each problems as p (p)}<div>{p}</div>{/each}</Alert>{/if}
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    <div class="row">
      <Button variant="primary" icon="play" disabled={workflow.trim() === ''} onclick={review}>Review and start</Button>
    </div>
  {:else}
    <Alert tone="warn">
      {startSummary({ workflow: confirming.workflow, ref: confirming.ref ?? 'the default branch', project: link.fullName, inputCount: Object.keys(confirming.inputs ?? {}).length })}
    </Alert>
    <div class="row">
      <Button variant="primary" loading={starting} disabled={starting} onclick={() => void start()}>Start the run</Button>
      <Button variant="ghost" disabled={starting} onclick={() => (confirming = null)}>Back</Button>
    </div>
  {/if}

  {#if readProblem}<Alert tone="info">{readProblem}</Alert>{/if}
  {#if runs === null}
    <p class="muted">Reading the runs.</p>
  {:else if shown.length === 0}
    <p class="muted">No workflow has been started from here yet.</p>
  {:else}
    <ul class="runs plain">
      {#each shown as run (run.id)}
        <li>
          <RunStatus {run} />
          <span class="what">
            <strong>{runTitle(run)}</strong>
            {#if run.branch}<span class="muted"> <code>{run.branch}</code></span>{/if}
          </span>
          <span class="muted"><time datetime={new Date(run.startedAt).toISOString()} title={fullTime(run.startedAt)}>{timeAgo(run.startedAt, now)}</time></span>
          {#if run.url}
            <a class="icon-link" href={run.url} target="_blank" rel="noopener noreferrer" title="Open on {runProvider(run).host}">
              <Icon name="external-link" size={14} /><span class="visually-hidden">Open {run.workflow} on {runProvider(run).host} (opens in a new tab)</span>
            </a>
          {/if}
        </li>
      {/each}
    </ul>
    {#if going > 0 && canAsk}
      <div class="row">
        <Button size="sm" variant="ghost" icon="refresh" loading={refreshing} disabled={refreshing} onclick={() => void refreshFromExpo()}>Ask Expo about {going === 1 ? 'the run' : `${going} runs`} going</Button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .title {
    margin: 0;
    font-size: 1rem;
  }

  .runs {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .runs li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
