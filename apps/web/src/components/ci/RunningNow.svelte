<!--
  RunningNow: the workflow runs going now, followed live: one compact row per run (workflow, the app
  and repository, branch, who started it, how long it has gone, a bar and a line for the job and step it
  is at, its state), a link to GitHub and a panel with the jobs. Runs started here or on GitHub are
  both followed. It draws nothing while no run is going and nothing was read; finished runs of the last
  24 hours (failed first) are one collapsed line under the rows, or alone when nothing is running. A
  repository GitHub cannot be read for is one quiet pill (never an alert); so is a refresh that fails.
  Reads `GET /ci/runs/active`: every 15 seconds while a run is going, every minute when none is,
  slower after a failure, not at all in a hidden tab. The elapsed time ticks in the browser.
  Props: api, workspaceId, repositoryIds? (only these repositories; default all), scope? (narrows the
  runs to an app, see scopeRunsToApps), apps? (to name the app a run was started for), heading,
  stateKey (keeps the collapsed line open or closed while moving between screens), ondata? (called with
  every answer, so a page that lists workflows can show the actor and notice when a run starts or ends).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { runProvider, runTitle } from '../../lib/ci/ci.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    type ScopedRuns,
    createRunsFeed,
    elapsedText,
    endsFeed,
    finishedCounts,
    problemPill,
    progressInfo,
    runAppNames,
    runElapsedMs,
    sortActive,
  } from '../../lib/running.ts';
  import type { ActiveRun, ActiveRuns, AppSummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import RunDrawer from './RunDrawer.svelte';
  import RunProgress from './RunProgress.svelte';
  import RunStatus from './RunStatus.svelte';

  let {
    api,
    workspaceId,
    repositoryIds,
    scope,
    apps = [],
    heading,
    stateKey = 'ci.running.recent',
    ondata,
  }: {
    api: Api;
    workspaceId: string;
    repositoryIds?: readonly string[] | undefined;
    scope?: ((runs: readonly ActiveRun[]) => ScopedRuns) | undefined;
    apps?: readonly AppSummary[] | undefined;
    heading?: string | undefined;
    stateKey?: string | undefined;
    ondata?: ((data: ActiveRuns) => void) | undefined;
  } = $props();

  let data = $state<ActiveRuns | null>(null);
  let problem = $state('');
  let now = $state(Date.now());
  let readAt = $state<number | null>(null);
  /** The run whose panel is open, by repository and run id; the last row seen is kept for when it leaves the list. */
  let selected = $state<{ repositoryId: string; id: string } | null>(null);
  let selectedRow = $state<ActiveRun | null>(null);
  let drawerOpen = $state(false);

  const idsKey = $derived(repositoryIds ? repositoryIds.join(',') : '');

  $effect(() => {
    const ws = workspaceId;
    const ids = idsKey === '' ? undefined : idsKey.split(',');
    let alive = true;
    untrack(() => {
      data = null;
      problem = '';
      readAt = null;
    });
    const feed = createRunsFeed({
      load: () => api.activeRuns(ws, ids),
      onData: (d) => {
        if (!alive) return;
        data = d;
        problem = '';
        now = Date.now();
        readAt = now;
        ondata?.(d);
      },
      onError: (e) => {
        if (!alive) return;
        problem = e instanceof ApiError ? e.message : t('builds:running.readFailed');
      },
      fatal: endsFeed,
    });
    feed.start(true);
    return () => {
      alive = false;
      feed.stop();
    };
  });

  const whole = $derived<ScopedRuns>(scope ? scope(data?.runs ?? []) : { runs: data?.runs ?? [], linked: true });
  const rows = $derived(sortActive(whole.runs));
  const recent = $derived<ActiveRun[]>(scope ? scope(data?.recent ?? []).runs : (data?.recent ?? []));
  const pill = $derived(data ? problemPill(data.problems, data.repositories) : null);

  // The clock of the rows ticks once a second while any run is going; a hidden tab skips the work.
  $effect(() => {
    if (rows.length === 0) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  // The "updated ... ago" text moves on without a new read.
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  /** The names of the apps the run was started for (several for a workflow that builds more than one app), or null for none. */
  const appName = (run: ActiveRun): string | null => {
    const names = runAppNames(run, apps);
    return names.length === 0 ? null : formatList(names, { type: 'unit' });
  };

  function follow(run: ActiveRun) {
    selected = { repositoryId: run.repositoryId, id: run.id };
    selectedRow = run;
    drawerOpen = true;
  }

  const current = $derived.by<ActiveRun | null>(() => {
    if (!selected) return null;
    const all = [...(data?.runs ?? []), ...(data?.recent ?? [])];
    return all.find((r) => r.repositoryId === selected?.repositoryId && r.id === selected.id) ?? selectedRow;
  });

  $effect(() => {
    if (!drawerOpen) selected = null;
  });

  const title = $derived(heading ?? t('builds:running.heading'));
  const showCard = $derived(rows.length > 0);
  const showAnything = $derived(showCard || recent.length > 0 || pill !== null || (problem !== '' && data === null));
</script>

{#if showAnything}
  <div class="running">
    {#if showCard}
      <section class="card flush" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <span class="count" aria-label={t('builds:running.countLabel', { count: rows.length })}>{rows.length}</span>
          {#if !whole.linked}
            <InfoTip
              label={t('builds:running.aboutRuns')}
              text={t('builds:running.unlinked')}
            />
          {/if}
          <span class="spacer"></span>
          {#if readAt !== null}<span class="muted text-xs">{t('builds:running.updated', { ago: timeAgo(readAt, now) })}</span>{/if}
        </header>
        <ul class="rows">
          {#each rows as run (run.repositoryId + '/' + run.id)}
            {@const info = progressInfo(run)}
            {@const name = appName(run)}
            <li class="row">
              <div class="line">
                <RunStatus {run} />
                <span class="title" title={runTitle(run)}>
                  <strong>{run.workflow}</strong>
                  {#if run.title && run.title !== run.workflow}<span class="muted"> {run.title}</span>{/if}
                </span>
                <span class="num elapsed" title={t('builds:running.startedAt', { time: fullTime(run.startedAt) })}>{elapsedText(runElapsedMs(run, now))}</span>
                <span class="actions">
                  {#if runProvider(run).readsJobs}
                    <Button size="sm" variant="ghost" onclick={() => follow(run)} label={t('builds:runs.followLabel', { name: run.workflow })}>{t('builds:runs.follow')}</Button>
                  {/if}
                  {#if run.url}
                    <a class="icon-link" href={run.url} target="_blank" rel="noopener noreferrer" title={t('builds:running.openOn', { host: runProvider(run).host })}>
                      <Icon name="external-link" size={14} /><span class="visually-hidden">{t('builds:running.openRunOn', { name: run.workflow, host: runProvider(run).host })} {t('common:link.opensInNewTab')}</span>
                    </a>
                  {/if}
                </span>
              </div>
              <div class="meta muted text-sm">
                {#if name}<span>{name}</span><span aria-hidden="true">·</span>{/if}
                <span>{run.repository.owner}/{run.repository.repo}</span>
                {#if run.branch}<span aria-hidden="true">·</span><code>{run.branch}</code>{/if}
                {#if run.actor}<span aria-hidden="true">·</span><span>{t('builds:running.by', { actor: run.actor })}</span>{/if}
              </div>
              <RunProgress percent={info.percent} label={info.label} name={run.workflow} />
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if pill}
      <StatusPill tone={pill.tone} label={pill.label}>
        <ul class="plain">{#each pill.lines as line (line)}<li>{line}</li>{/each}</ul>
      </StatusPill>
    {:else if problem !== ''}
      <StatusPill tone="info" label={data === null ? t('builds:running.unreadable') : t('builds:running.stale')}>{problem}</StatusPill>
    {/if}

    {#if recent.length > 0}
      <Disclosure {stateKey} summary={t('builds:running.finished', { counts: finishedCounts(recent) })}>
        <ul class="recent">
          {#each recent as run (run.repositoryId + '/' + run.id)}
            <li>
              <RunStatus {run} />
              <span class="title">
                <strong>{run.workflow}</strong>
                <span class="muted text-sm"> {run.repository.owner}/{run.repository.repo}{#if run.branch} · {run.branch}{/if}</span>
              </span>
              <span class="muted text-sm"><time datetime={new Date(run.updatedAt).toISOString()} title={fullTime(run.updatedAt)}>{timeAgo(run.updatedAt, now)}</time></span>
              {#if runProvider(run).readsJobs}
                <Button size="sm" variant="ghost" onclick={() => follow(run)} label={t('builds:runs.detailsLabel', { name: run.workflow })}>{t('builds:tests.details')}</Button>
              {:else if run.url}
                <a class="icon-link" href={run.url} target="_blank" rel="noopener noreferrer" title={t('builds:running.openOn', { host: runProvider(run).host })}>
                  <Icon name="external-link" size={14} /><span class="visually-hidden">{t('builds:running.openRunOn', { name: run.workflow, host: runProvider(run).host })} {t('common:link.opensInNewTab')}</span>
                </a>
              {/if}
            </li>
          {/each}
        </ul>
      </Disclosure>
    {/if}
  </div>
{/if}

{#if current}
  <RunDrawer
    bind:open={drawerOpen}
    {api}
    {workspaceId}
    run={current}
    repository={current.repository}
    actor={current.actor}
    {now}
  />
{/if}

<style>
  .running {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
    margin-bottom: var(--space-4);
  }

  .running > section,
  .running > :global(.disclosure) {
    align-self: stretch;
  }

  header {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-size: var(--text-md);
  }

  .count {
    min-width: var(--space-5);
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-align: center;
    color: var(--info-ink);
    background: var(--info-bg);
    border-radius: var(--radius-full);
  }

  .rows,
  .recent,
  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: stretch; /* the global .row centres: in a column that centred the content */
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
  }

  .row:first-child {
    border-top: 0;
  }

  .line {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-width: 0;
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .elapsed {
    flex: 0 0 auto;
    font-weight: var(--weight-medium);
  }

  .actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--space-1);
    align-items: center;
  }

  .icon-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-sm);
    height: var(--control-sm);
    color: var(--muted);
    border-radius: var(--radius-md);
  }

  .icon-link:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .recent li {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-1) 0;
  }
</style>
