<!--
  WorkflowsList: a dense table of workflows with the state of their last run and a Run button. It is
  the list of an app's Workflows page (one repository) and of the workspace Workflows view (all of
  them, each named with its repository). The workflows that look like build or release workflows are marked
  and come first (lib/workflows.ts). Nothing is fetched here.
  Props: rows (WorkflowRow[]), now (epoch ms), canDispatch (false hides every Run button; say why
  once, above the table), showRepository?, actors? (GitHub login by `repositoryId/runId`),
  onrun (called with the row), onfollow (called with the run and its repository).
-->
<script lang="ts">
  import { isPending, runProvider, runTitle } from '../../lib/ci/ci.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { type WorkflowRow, relevanceLabel, runBlockedReason } from '../../lib/ci/workflows.ts';
  import type { WorkflowRun } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import RunStatus from './RunStatus.svelte';

  let {
    rows,
    now,
    canDispatch,
    showRepository = false,
    actors = {},
    onrun,
    onfollow,
  }: {
    rows: WorkflowRow[];
    now: number;
    canDispatch: boolean;
    showRepository?: boolean | undefined;
    actors?: Record<string, string | null | undefined>;
    onrun: (row: WorkflowRow) => void;
    onfollow: (run: WorkflowRun, row: WorkflowRow) => void;
  } = $props();

  const actorOf = (row: WorkflowRow): string | null => (row.last ? (actors[`${row.repository.id}/${row.last.id}`] ?? null) : null);
</script>

<div class="table-wrap">
  <table class="compact wfs">
    <caption class="visually-hidden">{t('builds:wfl.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('builds:runs.workflow')}</th>
        <th scope="col">{t('builds:wfl.lastRun')}</th>
        <th scope="col"><span class="visually-hidden">{t('builds:runs.actions')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.repository.id + '/' + row.entry.workflow.id)}
        {@const workflow = row.entry.workflow}
        {@const last = row.last}
        {@const blocked = runBlockedReason(workflow, canDispatch)}
        {@const actor = actorOf(row)}
        <tr>
          <td>
            <div class="name">
              <strong>{workflow.name}</strong>
              {#if row.entry.relevance !== 'other'}
                <span title={row.entry.reason}>
                  <Badge tone={row.entry.relevance === 'configured' || row.entry.relevance === 'used' ? 'accent' : 'neutral'}
                    >{relevanceLabel(row.entry.relevance)}</Badge
                  >
                </span>
              {/if}
              {#if workflow.state !== 'active'}
                <Badge tone="warn">{workflow.state === 'unknown' ? t('builds:wfl.notListed') : workflow.state.replace(/_/g, ' ')}</Badge>
              {/if}
            </div>
            <span class="path muted">{#if showRepository}{row.repository.name} · {/if}<code>{workflow.path}</code></span>
          </td>
          <td>
            {#if last}
              <div class="last">
                <RunStatus run={last} />
                <span class="muted when">
                  {#if last.branch}<code>{last.branch}</code> · {/if}
                  {#if actor}{actor} · {/if}
                  <time datetime={new Date(last.startedAt).toISOString()} title={fullTime(last.startedAt)}>{timeAgo(last.startedAt, now)}</time>
                </span>
                {#if last.url}
                  <a class="icon-link" href={last.url} target="_blank" rel="noopener noreferrer" title={t('builds:wfl.openRun', { name: runTitle(last), host: runProvider(last).host })}>
                    <Icon name="external-link" size={14} /><span class="visually-hidden">{t('builds:wfl.openLastRun', { name: workflow.name, host: runProvider(last).host })} {t('common:link.opensInNewTab')}</span>
                  </a>
                {/if}
                {#if runProvider(last).readsJobs}
                  {#if !isPending(last)}
                    <Button size="sm" variant="ghost" label={last.active ? t('builds:wfl.followLast', { name: workflow.name }) : t('builds:wfl.jobsLast', { name: workflow.name })} onclick={() => onfollow(last, row)}
                      >{last.active ? t('builds:runs.follow') : t('builds:runs.jobs')}</Button
                    >
                  {:else}
                    <span class="muted when">{t('builds:runs.waitingName')}</span>
                  {/if}
                {/if}
              </div>
            {:else}
              <span class="muted">{t('builds:wfl.noRuns')}</span>
            {/if}
          </td>
          <td class="actions">
            {#if canDispatch}
              <Button
                size="sm"
                icon="play"
                disabled={blocked !== null}
                label={blocked ? t('builds:wfl.blockedLabel', { reason: blocked, name: workflow.name }) : t('builds:lead.runWorkflow', { name: workflow.name })}
                onclick={() => onrun(row)}>{t('builds:wfl.run')}</Button
              >
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .name {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .wfs td {
    padding-block: var(--space-3);
    font-size: 0.9375rem;
  }

  .when {
    font-size: 0.9375rem;
  }

  .path {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .last {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
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

  .actions {
    text-align: right;
    white-space: nowrap;
  }
</style>
