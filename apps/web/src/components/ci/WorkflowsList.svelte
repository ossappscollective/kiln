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
  import { isPending, runTitle } from '../../lib/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { type WorkflowRow, relevanceLabel, runBlockedReason } from '../../lib/workflows.ts';
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
    showRepository?: boolean;
    actors?: Record<string, string | null | undefined>;
    onrun: (row: WorkflowRow) => void;
    onfollow: (run: WorkflowRun, row: WorkflowRow) => void;
  } = $props();

  const actorOf = (row: WorkflowRow): string | null => (row.last ? (actors[`${row.repository.id}/${row.last.id}`] ?? null) : null);
</script>

<div class="table-wrap">
  <table class="compact">
    <caption class="visually-hidden">Workflows</caption>
    <thead>
      <tr>
        <th scope="col">Workflow</th>
        <th scope="col">Last run</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
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
                <Badge tone="warn">{workflow.state === 'unknown' ? 'Not listed by GitHub' : workflow.state.replace(/_/g, ' ')}</Badge>
              {/if}
            </div>
            <span class="path muted">{#if showRepository}{row.repository.name} · {/if}<code>{workflow.path}</code></span>
          </td>
          <td>
            {#if last}
              <div class="last">
                <RunStatus run={last} />
                <span class="muted text-sm">
                  {#if last.branch}<code>{last.branch}</code> · {/if}
                  {#if actor}{actor} · {/if}
                  <time datetime={new Date(last.startedAt).toISOString()} title={fullTime(last.startedAt)}>{timeAgo(last.startedAt, now)}</time>
                </span>
                {#if last.url}
                  <a class="icon-link" href={last.url} target="_blank" rel="noopener noreferrer" title="Open {runTitle(last)} on GitHub">
                    <Icon name="external-link" size={14} /><span class="visually-hidden">Open the last run of {workflow.name} on GitHub (opens in a new tab)</span>
                  </a>
                {/if}
                {#if !isPending(last)}
                  <Button size="sm" variant="ghost" label="{last.active ? 'Follow' : 'Jobs of'} the last run of {workflow.name}" onclick={() => onfollow(last, row)}
                    >{last.active ? 'Follow' : 'Jobs'}</Button
                  >
                {:else}
                  <span class="muted text-sm">Waiting for GitHub to name the run</span>
                {/if}
              </div>
            {:else}
              <span class="muted">No runs yet</span>
            {/if}
          </td>
          <td class="actions">
            {#if canDispatch}
              <Button
                size="sm"
                icon="play"
                disabled={blocked !== null}
                label={blocked ? `${blocked} (${workflow.name})` : `Run ${workflow.name}`}
                onclick={() => onrun(row)}>Run</Button
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

  .path {
    display: block;
    font-size: var(--text-xs);
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
