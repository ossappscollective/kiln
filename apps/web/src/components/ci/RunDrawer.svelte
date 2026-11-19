<!--
  RunDrawer: follow one workflow run in a side panel: its state, who and what started it, how long it
  has gone, and its jobs with their steps (names, states and times; never logs). While the run is not
  finished and the panel is open the jobs are read again every few seconds (the server keeps a read for
  10 seconds, so more panels do not mean more GitHub calls); a hidden tab waits; one last read runs
  when the run finishes. A viewer sees what a member read lately, which may be nothing.
  Props: open (bindable), api, workspaceId, run (the run as the list holds it now; the parent keeps
  it current), repository ({ owner, repo }), now (epoch ms, ticking), actor? (GitHub login).
  A native <dialog> shown as a side panel, like the listing history: focus trap, Escape and focus return.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { isPending, runTitle, shortSha } from '../../lib/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { createPoller } from '../../lib/poll.ts';
  import { githubUrl } from '../../lib/repositories.ts';
  import { elapsedText, runElapsedMs, showsSteps, spanMs, stateVisual } from '../../lib/running.ts';
  import type { RunJob, RunJobs, WorkflowRun } from '../../lib/types.ts';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import RunStatus from './RunStatus.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    run,
    repository,
    now: nowProp,
    actor = null,
  }: {
    open?: boolean;
    api: Api;
    workspaceId: string;
    run: WorkflowRun;
    repository: { owner: string | null; repo: string | null };
    now: number;
    actor?: string | null;
  } = $props();

  const JOBS_POLL_MS = 10_000;
  const uid = $props.id();

  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;
  let jobs = $state<RunJobs | null>(null);
  let loading = $state(false);
  let problem = $state('');
  let generation = 0;

  // The parent's clock may be slow (the runs table ticks every 30 seconds): while a run goes and the panel
  // is open this one ticks every second by itself.
  let ticking = $state(Date.now());
  const now = $derived(open && run.active ? Math.max(ticking, nowProp) : nowProp);
  $effect(() => {
    if (!open || !run.active) return;
    ticking = Date.now();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') ticking = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const pending = $derived(isPending(run));
  const elapsed = $derived(elapsedText(runElapsedMs(run, now)));

  /** Reads the jobs. Returns false when the read failed, so the poller backs off. */
  async function load(): Promise<boolean> {
    const mine = generation;
    try {
      const read = await api.workflowRunJobs(workspaceId, run.repositoryId, run.id);
      if (mine !== generation) return true;
      jobs = read;
      problem = '';
      return true;
    } catch (e) {
      if (mine !== generation) return true;
      problem = e instanceof ApiError ? e.message : 'Could not read the jobs.';
      return false;
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Follow the jobs while the panel is open and the run has a page on GitHub. The poller waits while the tab is hidden.
  $effect(() => {
    if (!open || pending) return;
    void run.id;
    untrack(() => {
      generation += 1;
      jobs = null;
      problem = '';
      loading = true;
    });
    const poller = createPoller({
      intervalMs: JOBS_POLL_MS,
      maxIntervalMs: 60_000,
      tick: async () => {
        const ok = await load();
        if (!ok) throw new Error('The jobs could not be read.');
        // One more read after the run finished, then stop.
        return untrack(() => run.active);
      },
    });
    poller.start(true);
    return () => {
      poller.stop();
      generation += 1;
    };
  });

  function handleClose() {
    open = false;
    opener?.focus();
    opener = null;
  }

  // The backdrop belongs to the dialog element: a click that lands on it is a click outside.
  function handleClick(event: MouseEvent) {
    if (event.target === dialog) open = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="drawer" aria-labelledby="{uid}-title" onclose={handleClose} onclick={handleClick}>
  {#if open}
    <div class="surface">
      <header>
        <div class="titles">
          <h2 id="{uid}-title">{runTitle(run)}</h2>
          <p class="muted">{run.workflow}{#if run.runNumber !== null} · run {run.runNumber}{/if}{#if run.event} · {run.event}{/if}</p>
        </div>
        <button type="button" class="ghost icon sm" aria-label="Close" onclick={() => (open = false)}>
          <Icon name="x" />
        </button>
      </header>

      <div class="body">
        <div class="facts">
          <RunStatus {run} />
          <span class="num" title="Started {fullTime(run.startedAt)}">{run.active ? 'Running for' : 'Took'} {elapsed}</span>
          {#if run.branch}<code>{run.branch}</code>{/if}
          {#if run.headSha}
            <a href="{githubUrl(repository.owner, repository.repo)}/commit/{run.headSha}" target="_blank" rel="noopener noreferrer"
              ><code>{shortSha(run.headSha)}</code><span class="visually-hidden"> (opens in a new tab)</span></a
            >
          {/if}
          {#if actor}<span class="muted">by {actor}</span>{/if}
          {#if run.url}
            <a class="github" href={run.url} target="_blank" rel="noopener noreferrer"
              >Open on GitHub<Icon name="external-link" size={14} /><span class="visually-hidden"> (opens in a new tab)</span></a
            >
          {/if}
        </div>
        {#if run.commitMessage}<p class="muted commit">{run.commitMessage}</p>{/if}

        <h3 class="section">Jobs</h3>
        {#if pending}
          <p class="muted">GitHub has not named this run yet. The jobs show here as soon as it does.</p>
        {:else if loading && jobs === null}
          <div class="stack" role="status" aria-label="Reading the jobs">
            <Skeleton width="50%" height="16px" />
            <Skeleton width="100%" height="32px" />
            <Skeleton width="70%" height="16px" />
          </div>
        {:else}
          {#if problem}
            <StatusPill tone="info" label={jobs === null ? 'The jobs could not be read' : 'Not updating'}>
              {problem}{#if jobs !== null} Showing what was read {jobs.readAt ? timeAgo(jobs.readAt, now) : 'earlier'}.{/if}
            </StatusPill>
          {/if}
          {#if jobs && jobs.jobs.length > 0}
            <ol class="jobs">
              {#each jobs.jobs as job (job.id)}
                {@const v = stateVisual(job.status, job.conclusion)}
                {@const took = spanMs(job, now)}
                <li>
                  <div class="jobhead">
                    <span class="state {v.tone}"><Icon name={v.icon} size={14} /><span class="visually-hidden">{v.label}: </span></span>
                    {#if job.url}
                      <a href={job.url} target="_blank" rel="noopener noreferrer" class="jobname"
                        >{job.name}<span class="visually-hidden"> (opens in a new tab)</span></a
                      >
                    {:else}
                      <strong class="jobname">{job.name}</strong>
                    {/if}
                    <span class="muted text-sm">{v.label}{#if took !== null} · {elapsedText(took)}{/if}</span>
                  </div>
                  {#if job.steps.length > 0}
                    {#if showsSteps(job)}
                      {@render steps(job)}
                    {:else}
                      <Disclosure summary="{job.steps.length} {job.steps.length === 1 ? 'step' : 'steps'}">{@render steps(job)}</Disclosure>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ol>
            {#if jobs.truncated}<p class="muted text-sm">GitHub has more jobs than are listed here.</p>{/if}
            {#if jobs.readAt}<p class="muted text-xs">Read {timeAgo(jobs.readAt, now)}{#if !jobs.live} by a member{/if}.</p>{/if}
          {:else if jobs && !problem}
            <p class="muted">
              {#if jobs.live}
                {run.active ? 'GitHub lists no jobs yet. They appear when a runner picks the run up.' : 'GitHub lists no jobs for this run.'}
              {:else}
                Job details are read from GitHub by members and admins. Nobody has opened this run lately.
              {/if}
            </p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</dialog>

{#snippet steps(job: RunJob)}
  <ul class="steps">
    {#each job.steps as step (step.number)}
      {@const v = stateVisual(step.status, step.conclusion)}
      {@const took = spanMs(step, now)}
      <li class:current={step.status === 'in_progress'}>
        <span class="state {v.tone}"><Icon name={v.icon} size={12} /><span class="visually-hidden">{v.label}: </span></span>
        <span class="stepname">{step.name}</span>
        {#if took !== null}<span class="muted text-xs num">{elapsedText(took)}</span>{/if}
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  dialog.drawer {
    width: min(560px, 100%);
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    padding: 0;
    margin: 0 0 0 auto;
    overflow: hidden;
    color: var(--ink);
    background: var(--surface);
    border: 0;
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
  }

  dialog.drawer[open] {
    animation: slide var(--duration-slow) var(--ease);
  }

  dialog.drawer::backdrop {
    background: var(--scrim);
  }

  .surface {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-5);
    border-bottom: 1px solid var(--line);
  }

  .titles {
    min-width: 0;
  }

  header h2 {
    font-size: var(--text-lg);
    overflow-wrap: anywhere;
  }

  header p {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .body {
    flex: 1;
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    font-size: var(--text-sm);
  }

  .github {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    margin-left: auto;
  }

  .commit {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .section {
    margin: var(--space-5) 0 var(--space-3);
    font-size: var(--text-md);
  }

  .jobs,
  .steps {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .jobs > li {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }

  .jobs > li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .jobhead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .jobname {
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .steps {
    margin: var(--space-2) 0 0 var(--space-5);
  }

  .steps li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    padding: 2px 0;
    font-size: var(--text-sm);
  }

  .steps li.current .stepname {
    font-weight: var(--weight-semibold);
  }

  .stepname {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .state {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    color: var(--muted);
  }

  .state.ok {
    color: var(--ok-ink);
  }

  .state.bad {
    color: var(--bad-ink);
  }

  .state.info {
    color: var(--info-ink);
  }

  .state.warn {
    color: var(--warn-ink);
  }

  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
</style>
