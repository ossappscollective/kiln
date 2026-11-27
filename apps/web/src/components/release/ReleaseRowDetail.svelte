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
  import { can, platformMeta, type Role, supports } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { releaseFactsStore } from '../../lib/app-state/release-facts-store.svelte.ts';
  import { type PlatformScope, appAddress } from '../../lib/app-scope.ts';
  import { runBadge } from '../../lib/ci/ci.ts';
  import { formatDateTime, formatList, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { describeError, storeName } from '../../lib/portfolio.ts';
  import { dueText, formatTargetDate, rolloutHeadline } from '../../lib/release.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import type { Promotion } from '../../lib/app-state/types.ts';
  import { type ReleaseRow, buildsForRelease } from '../../lib/releases-table.ts';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import type { AppBuild, AppSummary, PlanDetail } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import PublishingNote from '../publish/PublishingNote.svelte';
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
    promote?: Promotion | null | undefined;
  } = $props();

  const promoteVerdict = $derived(appStateStore.verdict(workspaceId, role, app, 'promote'));
  const canReadPlans = $derived(PLANS_ENABLED && can(role, 'plans.read'));
  const canWrite = $derived(can(role, 'plans.write'));
  const plan = $derived(PLANS_ENABLED && row.plan.kind === 'plan' ? row.plan.plan : null);
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
    releaseFactsStore
      .readPlan(api, workspaceId, target.appId, target.id)
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
    <Button variant={promote ? 'secondary' : 'primary'} icon="rocket" href={releaseHref}>{t('release:row.openRelease')}</Button>
    <Button variant="ghost" icon="pipeline" href={buildsHref}>{t('release:row.buildsAndCi')}</Button>
  </div>
  <div class="grid">
    <section class="part" aria-label={t('release:row.store')}>
      <h4>{t('release:row.inStore')} <span class="muted">{t('release:row.inStoreNote', { store: storeName(row.platform) })}</span></h4>
      <dl>
        <div><dt>{t('release:row.state')}</dt><dd><code>{row.release.rawState}</code></dd></div>
        <div><dt>{platformMeta(row.platform).buildLabel}</dt><dd>{row.buildText}</dd></div>
        {#if row.release.track !== null}<div><dt>{t('release:row.track')}</dt><dd>{row.trackText}</dd></div>{/if}
        <div>
          <dt>{t('release:row.changedInStore')}</dt>
          <dd>
            {#if row.release.storeUpdatedAt !== null}
              <time datetime={new Date(row.release.storeUpdatedAt).toISOString()} title={formatDateTime(row.release.storeUpdatedAt)}>{formatRelativeTime(row.release.storeUpdatedAt, { now })}</time>
            {:else}
              <span class="muted">{t('release:row.notReported')}</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt>{t('release:row.lastRead')}</dt>
          <dd><time datetime={new Date(row.release.syncedAt).toISOString()} title={formatDateTime(row.release.syncedAt)}>{formatRelativeTime(row.release.syncedAt, { now })}</time></dd>
        </div>
      </dl>
      <RolloutObserved release={row.release} />
      {#if promote}
        <p class="promote-line">
          {#if promote.offer.enabled && promote.offer.href}
            <Button size="sm" variant="primary" icon="arrow-right" href={promote.offer.href}>{promote.offer.label}</Button>
          {:else}
            <!-- the app state holds it back (a publish of the app runs, or its last publish failed): the reason is shown below -->
            <Button size="sm" variant="primary" icon="arrow-right" disabled title={promote.offer.disabledReason ?? undefined}>{promote.offer.label}</Button>
          {/if}
          <span class="muted note">{t('release:row.promoteNote', { count: promote.option.codes.length, codes: formatList(promote.option.codes.map(String)), from: promote.option.fromLabel })}</span>
        </p>
        <PublishingNote verdict={promoteVerdict} appId={app.id} platform={scope} />
      {/if}
    </section>

    {#if PLANS_ENABLED}
    <section class="part" aria-label={t('release:row.plan')}>
      <h4>{t('release:row.plan')} <span class="muted">{t('release:row.planNote')}</span></h4>
      {#if plan === null}
        <p class="muted">{row.plan.kind === 'none' ? row.plan.title : ''}</p>
        {#if canReadPlans}<p class="muted">{t('release:row.startPlan')}</p>{/if}
      {:else}
        <p class="chips">
          <Badge tone={row.plan.tone}>{row.plan.label}</Badge>
          {#if due}<Badge tone={due.tone}>{due.text}</Badge>{/if}
        </p>
        <dl>
          <div><dt>{t('release:row.targetDate')}</dt><dd>{plan.targetDate ? formatTargetDate(plan.targetDate) : t('release:row.notSet')}</dd></div>
          <div><dt>{t('release:row.checklist')}</dt><dd>{t('release:checklist.progress', { done: plan.checklist.done, total: plan.checklist.total })}</dd></div>
          <div><dt>{t('release:row.rolloutPlan')}</dt><dd>{rolloutHeadline(plan.rollout)}</dd></div>
        </dl>
        {#if plan.blocked}<Alert tone="warn" title={t('release:plan.blocked')}>{plan.blockedReason}</Alert>{/if}
        {#if row.plan.kind === 'plan' && row.plan.viaApp}<p class="muted note">{t('release:row.viaApp')}</p>{/if}
      {/if}
    </section>
    {/if}
  </div>

  {#if plan !== null && canReadPlans}
    <section class="wide" aria-label={t('release:row.rolloutSection')}>
      {#if planLoading}
        <div role="status" aria-label={t('release:row.loadingPlan')} class="stack"><Skeleton width="40%" height="16px" /><Skeleton width="100%" height="64px" /></div>
      {:else if planProblem}
        <Alert tone="error" title={t('release:row.loadFailed')}>{planProblem}</Alert>
      {:else if detail}
        <Rollout {api} {workspaceId} plan={detail} {canWrite} onsummary={(summary) => { if (detail) detail = { ...detail, rollout: summary }; }} />
      {/if}
    </section>
  {/if}

  <section class="wide" aria-label={t('release:row.builds')}>
    <h4>{t('release:row.builds')} <span class="muted">{t('release:row.buildsNote')}</span></h4>
    {#if builds === null}
      <p class="muted">{t('release:row.noBuildData')}</p>
    {:else if matching.length === 0}
      <p class="muted">{supports(row.platform, 'releaseTracks') ? t('release:row.noBuildCodes') : t('release:row.noBuildNumber')}</p>
    {:else}
      <div class="table-scroll">
        <table class="compact">
          <caption class="visually-hidden">{t('release:row.buildsCaption', { version: row.version, store: storeName(row.platform) })}</caption>
          <thead>
            <tr><th scope="col">{t('release:row.col.build')}</th><th scope="col">{t('release:row.col.uploaded')}</th><th scope="col">{t('release:row.col.ci')}</th><th scope="col">{t('release:row.col.commit')}</th></tr>
          </thead>
          <tbody>
            {#each matching as b (b.buildNumber)}
              {@const badge = b.link?.run ? runBadge(b.link.run) : null}
              <tr>
                <th scope="row">{b.buildNumber}</th>
                <td class="muted">
                  {#if b.uploadedAt !== null}<time datetime={new Date(b.uploadedAt).toISOString()} title={formatDateTime(b.uploadedAt)}>{formatRelativeTime(b.uploadedAt, { now })}</time>{:else}—{/if}
                </td>
                <td>
                  {#if badge}
                    <Badge tone={badge.tone} dot={badge.dot}>{badge.label}</Badge>
                    {#if b.link?.run?.url}<a href={b.link.run.url} target="_blank" rel="noreferrer noopener">{b.link.run.workflow}</a>{/if}
                  {:else if b.linkState === 'tag'}
                    <Badge tone="info">{t('release:row.tagFound')}</Badge>
                  {:else}
                    <span class="muted">{t('release:row.notLinked')}</span>
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
