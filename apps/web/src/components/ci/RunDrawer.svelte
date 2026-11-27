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
  import { isPending, runTitle, shortSha } from '../../lib/ci/ci.ts';
  import { t } from '../../lib/i18n/t.ts';
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
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    run,
    repository,
    now: nowProp,
    actor = null,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    run: WorkflowRun;
    repository: { owner: string | null; repo: string | null };
    now: number;
    actor?: string | null | undefined;
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
  const tickClock = useNow({ everyMs: 1000, visibleOnly: true, while: () => open && run.active });
  const now = $derived(open && run.active ? Math.max(tickClock.value, nowProp) : nowProp);

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
      problem = e instanceof ApiError ? e.message : t('builds:drawer.readFailed');
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
          <p class="muted">{run.workflow}{#if run.runNumber !== null} · {t('builds:drawer.runNumber', { number: run.runNumber })}{/if}{#if run.event} · {run.event}{/if}</p>
        </div>
        <button type="button" class="ghost icon sm" aria-label={t('common:action.close')} onclick={() => (open = false)}>
          <Icon name="x" />
        </button>
      </header>

      <div class="body">
        <div class="facts">
          <RunStatus {run} />
          <span class="num" title={t('builds:running.startedAt', { time: fullTime(run.startedAt) })}>{run.active ? t('builds:drawer.runningFor', { duration: elapsed }) : t('builds:drawer.took', { duration: elapsed })}</span>
          {#if run.branch}<code>{run.branch}</code>{/if}
          {#if run.headSha}
            <a href="{githubUrl(repository.owner, repository.repo)}/commit/{run.headSha}" target="_blank" rel="noopener noreferrer"
              ><code>{shortSha(run.headSha)}</code><span class="visually-hidden"> {t('common:link.opensInNewTab')}</span></a
            >
          {/if}
          {#if actor}<span class="muted">{t('builds:running.by', { actor })}</span>{/if}
          {#if run.url}
            <a class="github" href={run.url} target="_blank" rel="noopener noreferrer"
              >{t('builds:drawer.openOnGithub')}<Icon name="external-link" size={14} /><span class="visually-hidden"> {t('common:link.opensInNewTab')}</span></a
            >
          {/if}
        </div>
        {#if run.commitMessage}<p class="muted commit">{run.commitMessage}</p>{/if}

        <h3 class="section">{t('builds:runs.jobs')}</h3>
        {#if pending}
          <p class="muted">{t('builds:drawer.pending')}</p>
        {:else if loading && jobs === null}
          <div class="stack" role="status" aria-label={t('builds:drawer.reading')}>
            <Skeleton width="50%" height="16px" />
            <Skeleton width="100%" height="32px" />
            <Skeleton width="70%" height="16px" />
          </div>
        {:else}
          {#if problem}
            <StatusPill tone="info" label={jobs === null ? t('builds:drawer.unreadable') : t('builds:drawer.notUpdating')}>
              {problem}{#if jobs !== null} {jobs.readAt ? t('builds:drawer.showingRead', { ago: timeAgo(jobs.readAt, now) }) : t('builds:drawer.showingReadEarlier')}{/if}
            </StatusPill>
          {/if}
          {#if jobs && jobs.jobs.length > 0}
            <ol class="jobs">
              {#each jobs.jobs as job (job.id)}
                {@const v = stateVisual(job.status, job.conclusion)}
                {@const took = spanMs(job, now)}
                <li>
                  <div class="jobhead">
                    <span class="state {v.tone}"><Icon name={v.icon} size={14} /><span class="visually-hidden">{t('builds:drawer.stateOf', { state: v.label })} </span></span>
                    {#if job.url}
                      <a href={job.url} target="_blank" rel="noopener noreferrer" class="jobname"
                        >{job.name}<span class="visually-hidden"> {t('common:link.opensInNewTab')}</span></a
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
                      <Disclosure summary={t('builds:drawer.steps', { count: job.steps.length })}>{@render steps(job)}</Disclosure>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ol>
            {#if jobs.truncated}<p class="muted text-sm">{t('builds:drawer.truncated')}</p>{/if}
            {#if jobs.readAt}<p class="muted text-xs">{jobs.live ? t('builds:drawer.readAt', { ago: timeAgo(jobs.readAt, now) }) : t('builds:drawer.readAtMember', { ago: timeAgo(jobs.readAt, now) })}</p>{/if}
          {:else if jobs && !problem}
            <p class="muted">
              {#if jobs.live}
                {run.active ? t('builds:drawer.noJobsYet') : t('builds:drawer.noJobs')}
              {:else}
                {t('builds:drawer.notRead')}
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
        <span class="state {v.tone}"><Icon name={v.icon} size={12} /><span class="visually-hidden">{t('builds:drawer.stateOf', { state: v.label })} </span></span>
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

  /* Header fixed, .body the one scroll container: min-height 0 lets a flex child shrink below its content so it can scroll. */
  .surface {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    flex: none;
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
    min-height: 0;
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
    overscroll-behavior: contain;
    scroll-padding: var(--space-5);
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
