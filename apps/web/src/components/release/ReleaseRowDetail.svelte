<!--
  ReleaseRowDetail: what opens under a row of the releases table: the store side (state, rollout
  share, as the store last reported it), the plan side (target date, checklist, readiness), the
  rollout plan steps with the store-versus-plan comparison (the existing Rollout card, loaded when
  the row opens), and the builds of this release with their CI run. Store data is read only; the
  plan is our own planning data.
  Props: api, workspaceId, role, row (ReleaseRow), app (the platform record), builds (the builds of
  that app, or null when not loaded), now, scope (the platform scope for links), promote? (Google Play: this release is in a track
  that is not production, so "Promote to production" is offered; it opens Prepare release with its version codes).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { type PlatformScope, appAddress } from '../../lib/app-scope.ts';
  import { runBadge } from '../../lib/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { describeError, storeName } from '../../lib/portfolio.ts';
  import { dueText, formatTargetDate, rolloutHeadline } from '../../lib/release.ts';
  import { type PromoteOption, promoteHref } from '../../lib/play-promote.ts';
  import { type ReleaseRow, buildsForRelease } from '../../lib/releases-table.ts';
  import type { AppBuild, AppSummary, PlanDetail } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Rollout from './Rollout.svelte';
  import RolloutObserved from './RolloutObserved.svelte';

  let {
    api,
    workspaceId,
    role,
    row,
    app,
    builds,
    now,
    scope,
    promote = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    row: ReleaseRow;
    app: AppSummary;
    builds: readonly AppBuild[] | null;
    now: number;
    scope: PlatformScope | null;
    /** Google Play: this release is in a track that is not production and can be promoted. */
    promote?: PromoteOption | null;
  } = $props();

  const canReadPlans = $derived(can(role, 'plans.read'));
  const canWrite = $derived(can(role, 'plans.write'));
  const plan = $derived(row.plan.kind === 'plan' ? row.plan.plan : null);
  const matching = $derived(builds === null ? [] : buildsForRelease(row.release, builds));
  const due = $derived(plan?.targetDate ? dueText(plan.due, plan.released) : null);

  let detail = $state<PlanDetail | null>(null);
  let planProblem = $state('');
  let planLoading = $state(false);
  let generation = 0;

  // The full plan is needed by the rollout card only: load it when this row is open (it is mounted
  // only then) and again when the row shows another plan.
  const planKey = $derived(plan ? `${plan.appId}/${plan.id}` : '');
  $effect(() => {
    const wanted = planKey;
    const mine = ++generation;
    detail = null;
    planProblem = '';
    if (wanted === '' || !plan || !canReadPlans) {
      planLoading = false;
      return;
    }
    const target = plan;
    planLoading = true;
    api
      .plan(workspaceId, target.appId, target.id)
      .then((r) => {
        if (mine !== generation) return;
        detail = r.plan;
        planLoading = false;
      })
      .catch((e) => {
        if (mine !== generation) return;
        planProblem = describeError(e, 'load');
        planLoading = false;
      });
  });

  const releaseHref = $derived(appAddress(row.appId, 'releases', scope, row.version));
  const buildsHref = $derived(appAddress(row.appId, 'builds', scope));
</script>

<div class="detail">
  <div class="row wrap actions">
    <Button variant={promote ? 'secondary' : 'primary'} icon="rocket" href={releaseHref}>Open the release</Button>
    <Button variant="ghost" icon="pipeline" href={buildsHref}>Builds and CI</Button>
  </div>
  <div class="grid">
    <section class="part" aria-label="Store">
      <h4>In the store <span class="muted">· {storeName(row.platform)}, read only</span></h4>
      <dl>
        <div><dt>State</dt><dd><code>{row.release.rawState}</code></dd></div>
        <div><dt>{row.platform === 'android' ? 'Version codes' : 'Build'}</dt><dd>{row.buildText}</dd></div>
        {#if row.release.track !== null}<div><dt>Track</dt><dd>{row.trackText}</dd></div>{/if}
        <div>
          <dt>Changed in the store</dt>
          <dd>
            {#if row.release.storeUpdatedAt !== null}
              <time datetime={new Date(row.release.storeUpdatedAt).toISOString()} title={fullTime(row.release.storeUpdatedAt)}>{timeAgo(row.release.storeUpdatedAt, now)}</time>
            {:else}
              <span class="muted">not reported</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt>Last read</dt>
          <dd><time datetime={new Date(row.release.syncedAt).toISOString()} title={fullTime(row.release.syncedAt)}>{timeAgo(row.release.syncedAt, now)}</time></dd>
        </div>
      </dl>
      <RolloutObserved release={row.release} />
      {#if promote}
        <p class="promote-line">
          <Button size="sm" variant="primary" icon="arrow-right" href={promoteHref(promote)}>{promote.label}</Button>
          <span class="muted note">Opens Prepare release with version code{promote.codes.length === 1 ? '' : 's'} {promote.codes.join(', ')} from {promote.fromLabel}. You set the notes and the share, and confirm at the end.</span>
        </p>
      {/if}
    </section>

    <section class="part" aria-label="Plan">
      <h4>Plan <span class="muted">· our own planning data</span></h4>
      {#if plan === null}
        <p class="muted">{row.plan.kind === 'none' ? row.plan.title : ''}</p>
        {#if canReadPlans}<p class="muted">Open the release to start a plan with a checklist, release notes and a target date.</p>{/if}
      {:else}
        <p class="chips">
          <Badge tone={row.plan.tone}>{row.plan.label}</Badge>
          {#if due}<Badge tone={due.tone}>{due.text}</Badge>{/if}
        </p>
        <dl>
          <div><dt>Target date</dt><dd>{plan.targetDate ? formatTargetDate(plan.targetDate) : 'Not set'}</dd></div>
          <div><dt>Checklist</dt><dd>{plan.checklist.done} of {plan.checklist.total} done</dd></div>
          <div><dt>Rollout plan</dt><dd>{rolloutHeadline(plan.rollout)}</dd></div>
        </dl>
        {#if plan.blocked}<Alert tone="warn" title="Blocked">{plan.blockedReason}</Alert>{/if}
        {#if row.plan.kind === 'plan' && row.plan.viaApp}<p class="muted note">This plan is on the other platform's app and covers both.</p>{/if}
      {/if}
    </section>
  </div>

  {#if plan !== null && canReadPlans}
    <section class="wide" aria-label="Rollout plan and store comparison">
      {#if planLoading}
        <div role="status" aria-label="Loading the plan" class="stack"><Skeleton width="40%" height="16px" /><Skeleton width="100%" height="64px" /></div>
      {:else if planProblem}
        <Alert tone="error" title="Could not load the plan">{planProblem}</Alert>
      {:else if detail}
        <Rollout {api} {workspaceId} plan={detail} {canWrite} onsummary={(summary) => { if (detail) detail = { ...detail, rollout: summary }; }} />
      {/if}
    </section>
  {/if}

  <section class="wide" aria-label="Builds">
    <h4>Builds <span class="muted">· read from the store and matched to CI runs</span></h4>
    {#if builds === null}
      <p class="muted">Build data is not available.</p>
    {:else if matching.length === 0}
      <p class="muted">No build with {row.platform === 'android' ? 'these version codes' : 'this build number'} was found. A sync reads builds from the store.</p>
    {:else}
      <div class="table-scroll">
        <table class="compact">
          <caption class="visually-hidden">Builds of {row.version} on {storeName(row.platform)}</caption>
          <thead>
            <tr><th scope="col">Build</th><th scope="col">Uploaded</th><th scope="col">CI</th><th scope="col">Commit</th></tr>
          </thead>
          <tbody>
            {#each matching as b (b.buildNumber)}
              {@const badge = b.link?.run ? runBadge(b.link.run) : null}
              <tr>
                <th scope="row">{b.buildNumber}</th>
                <td class="muted">
                  {#if b.uploadedAt !== null}<time datetime={new Date(b.uploadedAt).toISOString()} title={fullTime(b.uploadedAt)}>{timeAgo(b.uploadedAt, now)}</time>{:else}—{/if}
                </td>
                <td>
                  {#if badge}
                    <Badge tone={badge.tone} dot={badge.dot}>{badge.label}</Badge>
                    {#if b.link?.run?.url}<a href={b.link.run.url} target="_blank" rel="noreferrer noopener">{b.link.run.workflow}</a>{/if}
                  {:else if b.linkState === 'tag'}
                    <Badge tone="info">Tag found</Badge>
                  {:else}
                    <span class="muted">Not linked</span>
                  {/if}
                </td>
                <td class="muted">{b.link?.commit ? b.link.commit.shortSha : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    background: var(--surface-sunken);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: var(--space-4);
    align-items: start;
  }

  .part,
  .wide {
    min-width: 0;
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  h4 .muted {
    font-weight: var(--weight-regular);
  }

  dl {
    display: grid;
    gap: var(--space-1);
    margin: 0 0 var(--space-3);
    font-size: 0.9375rem;
  }

  dl > div {
    display: flex;
    gap: var(--space-3);
  }

  dt {
    flex: 0 0 9rem;
    color: var(--muted);
  }

  dd {
    min-width: 0;
    margin: 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0 0 var(--space-2);
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }

  .promote-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    margin: var(--space-2) 0 0;
  }

  .part p {
    margin: 0 0 var(--space-2);
  }

  .actions {
    justify-content: flex-start;
  }
</style>
