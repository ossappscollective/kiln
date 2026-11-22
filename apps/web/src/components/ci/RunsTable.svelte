<!--
  RunsTable: recent workflow runs of a repository, one line each: status word, workflow, branch, when, how long, and Jobs or Follow.
  The failing workflows come first, then the runs going now, then the newest (lib/workflow-lead.ts, orderRuns). What is only sometimes
  needed (the run's number and event, the commit and its message, the inputs it was started with) sits behind "Details" on the row.
  Props: runs, now (epoch ms, for "5 minutes ago"), repository ({ owner, repo }, for the commit links),
  onfollow? (called with a run: opens its panel with the jobs; not offered for a run GitHub has not named).
  A run that GitHub has not named yet (we just started it) has no link; it says so.
-->
<script lang="ts">
  import { isPending, runDuration, runProvider, runTitle, shortSha } from '../../lib/ci/ci.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { githubUrl } from '../../lib/repositories.ts';
  import type { WorkflowRun } from '../../lib/types.ts';
  import { orderRuns } from '../../lib/ci/lead.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import RunStatus from './RunStatus.svelte';

  let {
    runs,
    now,
    repository,
    onfollow,
  }: {
    runs: WorkflowRun[];
    now: number;
    repository: { owner: string | null; repo: string | null };
    onfollow?: ((run: WorkflowRun) => void) | undefined;
  } = $props();

  const uid = $props.id();
  const rows = $derived(orderRuns(runs));
  let opened = $state<Record<string, boolean>>({});
  const hasDetails = (run: WorkflowRun): boolean =>
    run.headSha !== null || run.event !== null || run.runNumber !== null || (run.inputs !== null && Object.keys(run.inputs).length > 0) || isPending(run);
</script>

<div class="table-wrap">
  <table class="runs">
    <caption class="visually-hidden">{t('builds:runs.caption', { repository: `${repository.owner}/${repository.repo}` })}</caption>
    <thead>
      <tr>
        <th scope="col">{t('builds:runs.status')}</th>
        <th scope="col">{t('builds:runs.workflow')}</th>
        <th scope="col">{t('builds:runs.branch')}</th>
        <th scope="col">{t('builds:runs.started')}</th>
        <th scope="col">{t('builds:runs.took')}</th>
        <th scope="col"><span class="visually-hidden">{t('builds:runs.actions')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as run (run.id)}
        {@const more = hasDetails(run)}
        {@const took = runDuration(run)}
        <tr class:open={opened[run.id]}>
          <td><RunStatus {run} /></td>
          <td class="wf">
            {#if run.url}
              <a href={run.url} target="_blank" rel="noopener noreferrer" class="title"
                >{runTitle(run)}<Icon name="external-link" size={14} /><span class="visually-hidden"> {t('common:link.opensInNewTab')}</span></a
              >
            {:else}
              <span class="title">{runTitle(run)}</span>
            {/if}
          </td>
          <td>{#if run.branch}<code>{run.branch}</code>{:else}<span class="muted">-</span>{/if}</td>
          <td class="muted">
            <time datetime={new Date(run.startedAt).toISOString()} title={fullTime(run.startedAt)}>{timeAgo(run.startedAt, now)}</time>
          </td>
          <td class="muted">{took ?? (run.active ? t('builds:runs.running') : '-')}</td>
          <td class="acts">
            {#if onfollow && !isPending(run) && runProvider(run).readsJobs}
              <Button size="sm" variant="ghost" label={run.active ? t('builds:runs.followLabel', { name: runTitle(run) }) : t('builds:runs.jobsLabel', { name: runTitle(run) })} onclick={() => onfollow(run)}
                >{run.active ? t('builds:runs.follow') : t('builds:runs.jobs')}</Button
              >
            {/if}
            {#if more}
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={opened[run.id] ? 'true' : 'false'}
                aria-controls="{uid}-{run.id}"
                label={t('builds:runs.detailsLabel', { name: runTitle(run) })}
                onclick={() => (opened = { ...opened, [run.id]: !opened[run.id] })}>{t('builds:tests.details')}</Button
              >
            {/if}
          </td>
        </tr>
        {#if more && opened[run.id]}
          <tr class="detail">
            <td></td>
            <td colspan="5" id="{uid}-{run.id}">
              <dl class="facts">
                {#if run.runNumber !== null || run.event}
                  <div>
                    <dt>{t('builds:runs.run')}</dt>
                    <dd>{run.workflow}{#if run.runNumber !== null} #{run.runNumber}{/if}{#if run.event} · {run.event}{/if}</dd>
                  </div>
                {/if}
                {#if run.headSha}
                  <div>
                    <dt>{t('builds:runs.commit')}</dt>
                    <dd>
                      <a href="{githubUrl(repository.owner, repository.repo)}/commit/{run.headSha}" target="_blank" rel="noopener noreferrer"
                        ><code>{shortSha(run.headSha)}</code><span class="visually-hidden"> {t('common:link.opensInNewTab')}</span></a
                      >{#if run.commitMessage}<span class="muted"> {run.commitMessage}</span>{/if}
                    </dd>
                  </div>
                {/if}
                {#if run.inputs && Object.keys(run.inputs).length > 0}
                  <div>
                    <dt>{t('builds:runs.inputs')}</dt>
                    <dd>{Object.entries(run.inputs).map(([k, v]) => `${k}=${v}`).join(', ')}</dd>
                  </div>
                {/if}
                {#if isPending(run)}
                  <div>
                    <dt>{t('builds:runs.state')}</dt>
                    <dd>{t('builds:runs.waitingName')}</dd>
                  </div>
                {/if}
              </dl>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>

<style>
  .runs td,
  .runs th {
    padding-block: var(--space-3);
  }

  .runs td {
    font-size: 0.9375rem;
  }

  .runs th {
    font-size: var(--text-sm);
  }

  .title {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .acts {
    text-align: right;
    white-space: nowrap;
  }

  .detail td {
    padding-top: 0;
    border-top: 0;
  }

  .runs tr.open > td {
    border-bottom-color: transparent;
  }

  .facts {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }

  .facts > div {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
  }

  .facts dt {
    min-width: 5rem;
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
