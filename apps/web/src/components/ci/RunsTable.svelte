<!--
  RunsTable: recent workflow runs of a repository, running ones first.
  Props: runs, now (epoch ms, for "5 minutes ago"), repository ({ owner, repo }, for the commit links).
  A run that GitHub has not named yet (we just started it) has no link; it says so.
-->
<script lang="ts">
  import { isPending, runDuration, runTitle, shortSha, sortRuns } from '../../lib/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { githubUrl } from '../../lib/repositories.ts';
  import type { WorkflowRun } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';
  import RunStatus from './RunStatus.svelte';

  let {
    runs,
    now,
    repository,
  }: { runs: WorkflowRun[]; now: number; repository: { owner: string; repo: string } } = $props();

  const rows = $derived(sortRuns(runs));
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Recent workflow runs of {repository.owner}/{repository.repo}</caption>
    <thead>
      <tr>
        <th scope="col">Status</th>
        <th scope="col">Run</th>
        <th scope="col">Branch and commit</th>
        <th scope="col">Started</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as run (run.id)}
        <tr>
          <td><RunStatus {run} /></td>
          <td>
            <div class="run">
              {#if run.url}
                <a href={run.url} target="_blank" rel="noopener noreferrer" class="title"
                  >{runTitle(run)}<Icon name="external-link" size={14} /><span class="visually-hidden"> (opens in a new tab)</span></a
                >
              {:else}
                <span class="title">{runTitle(run)}</span>
              {/if}
              <span class="muted text-sm">
                {run.workflow}{#if run.event} · {run.event}{/if}
                {#if isPending(run)} · waiting for GitHub to name the run{/if}
              </span>
              {#if run.inputs && Object.keys(run.inputs).length > 0}
                <span class="muted text-sm">
                  Inputs: {Object.entries(run.inputs).map(([k, v]) => `${k}=${v}`).join(', ')}
                </span>
              {/if}
            </div>
          </td>
          <td>
            <div class="run">
              {#if run.branch}<code>{run.branch}</code>{/if}
              {#if run.headSha}
                <span class="text-sm">
                  <a href="{githubUrl(repository.owner, repository.repo)}/commit/{run.headSha}" target="_blank" rel="noopener noreferrer"
                    ><code>{shortSha(run.headSha)}</code><span class="visually-hidden"> (opens in a new tab)</span></a
                  >{#if run.commitMessage}
                    <span class="muted"> {run.commitMessage}</span>{/if}
                </span>
              {/if}
            </div>
          </td>
          <td class="muted">
            <time datetime={new Date(run.startedAt).toISOString()} title={fullTime(run.startedAt)}>{timeAgo(run.startedAt, now)}</time>
            {#if runDuration(run)}<span class="text-sm"> · took {runDuration(run)}</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .run {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .title {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }
</style>
