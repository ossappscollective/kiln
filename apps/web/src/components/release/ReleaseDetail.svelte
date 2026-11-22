<!--
  ReleaseDetail: one version of one app: where it is in the lifecycle on each platform, what the
  store reports (read only, including Android's staged rollout beside Apple's phased release), and
  the plan we keep for it: checklist, release notes per locale, target date, blocked flag.
  It lives at `#/portfolio/<appId>/release/<version>`, a screen of the portfolio next to the app
  page, because it can show the apps (iOS, macOS, Android) of one product, which the app page cannot.
  Props: api, workspaceId, role, appId, version.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { appLabel, describeError, platformLabel, platformRank, portfolioHref } from '../../lib/portfolio.ts';
  import { attentionOf } from '../../lib/dashboard.ts';
  import { findSiblings, planPlatformLabel, releaseHref, releasesOfVersion } from '../../lib/release.ts';
  import { releaseLead } from '../../lib/release-detail.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, PlanDetail, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import AttentionStrip from '../dashboard/AttentionStrip.svelte';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import Checklist from './Checklist.svelte';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import NewPlan from './NewPlan.svelte';
  import PlanOverview from './PlanOverview.svelte';
  import PlatformPanel from './PlatformPanel.svelte';
  import ReleaseNotes from './ReleaseNotes.svelte';
  import Rollout from './Rollout.svelte';

  let { api, workspaceId, role, appId, version }: { api: Api; workspaceId: string; role: Role; appId: string; version: string } = $props();

  /** Back to the app's Releases tab, keeping the platform scope that is in the address. */
  const backHref = $derived(appAddress(appId, 'releases', address.platform));

  const canReadPlans = $derived(PLANS_ENABLED && can(role, 'plans.read'));
  const canWrite = $derived(can(role, 'plans.write'));

  let app = $state<AppSummary | null>(null);
  let releases = $state<ReleaseSummary[]>([]);
  /** The apps of the other platforms that are the same product, each with its releases. */
  let siblings = $state<{ app: AppSummary; releases: ReleaseSummary[] }[]>([]);
  /** A plan for this version on another platform's app, when this app has none. */
  let siblingPlan = $state<{ plan: PlanSummary; app: AppSummary } | null>(null);
  let plan = $state<PlanDetail | null>(null);
  let hasPlans = $state(false);
  let plansProblem = $state('');
  let loading = $state(true);
  let loadError = $state<{ message: string; notFound: boolean } | null>(null);
  let now = $state(Date.now());
  let announcement = $state('');

  /** Ignores a late answer for a release that is no longer open. */
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = null;
    plansProblem = '';
    try {
      const detail = await api.app(workspaceId, appId);
      if (mine !== generation) return;
      app = detail.app;
      releases = detail.releases;
    } catch (e) {
      if (mine !== generation) return;
      app = null;
      releases = [];
      loadError = { message: describeError(e, 'load'), notFound: e instanceof ApiError && e.status === 404 };
      loading = false;
      return;
    }
    // The rest is extra: a failure shows a note and leaves the page usable.
    const current = app as AppSummary;
    await Promise.all([loadSibling(current, mine), loadPlans(current, mine)]);
    if (mine !== generation) return;
    loading = false;
    announcement = t('release:rd.opened', { version, app: appLabel(current) });
  }

  async function loadSibling(current: AppSummary, mine: number) {
    try {
      const list = (await api.apps(workspaceId)).apps;
      const others = findSiblings(list, current);
      if (others.length === 0) {
        if (mine === generation) siblings = [];
        return;
      }
      const details = await Promise.all(others.map((o) => api.app(workspaceId, o.id)));
      if (mine !== generation) return;
      siblings = details.map((d) => ({ app: d.app, releases: d.releases }));
      if (canReadPlans) {
        for (const other of siblings) {
          const theirs = (await api.appPlans(workspaceId, other.app.id)).plans.find((p) => p.version === version) ?? null;
          if (mine !== generation) return;
          if (theirs) {
            siblingPlan = { plan: theirs, app: other.app };
            break;
          }
        }
      }
    } catch {
      if (mine === generation) {
        siblings = [];
        siblingPlan = null;
      }
    }
  }

  async function loadPlans(current: AppSummary, mine: number) {
    if (!canReadPlans) {
      plan = null;
      return;
    }
    try {
      const list = (await api.appPlans(workspaceId, current.id)).plans;
      if (mine !== generation) return;
      hasPlans = list.length > 0;
      const found = list.find((p) => p.version === version);
      if (!found) {
        plan = null;
        return;
      }
      const detail = (await api.plan(workspaceId, current.id, found.id)).plan;
      if (mine === generation) plan = detail;
    } catch (e) {
      if (mine === generation) {
        plan = null;
        plansProblem = describeError(e, 'load');
      }
    }
  }

  $effect(() => {
    void workspaceId;
    void appId;
    void version;
    app = null;
    plan = null;
    siblings = [];
    siblingPlan = null;
    releases = [];
    void load();
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  const mine = $derived(releasesOfVersion(releases, version));
  const ordered = $derived(app ? [app, ...siblings.map((s) => s.app)].sort((a, b) => platformRank(a.platform) - platformRank(b.platform)) : []);
  const attention = $derived(plan ? attentionOf(plan) : null);

  const releasesFor = (a: AppSummary) => (a.id === appId ? mine : releasesOfVersion(siblings.find((s) => s.app.id === a.id)?.releases ?? [], version));
  const planFor = (a: AppSummary) => (a.id === appId ? plan : null);

  /** Where this version is, for the lead: one sentence, one word per platform, one primary action. */
  const lead = $derived(
    app
      ? releaseLead({
          version,
          appId,
          releases: ordered.flatMap((a) =>
            releasesFor(a).map((r) => ({
              appId: a.id,
              platform: r.platform,
              status: r.status,
              track: r.track,
              rolloutFraction: r.rolloutFraction,
              since: r.statusSince ?? r.sentForReviewAt ?? null,
            })),
          ),
          planned: plan !== null,
          blocked: plan?.blocked ?? false,
          now,
        })
      : null,
  );

  function setPlan(next: PlanDetail) {
    plan = next;
    hasPlans = true;
  }
</script>

<section aria-busy={loading}>
  <p class="back">
    <a href={backHref}><Icon name="chevron-left" size={16} /> {t('release:rd.back')}</a>
    {#if app}<span aria-hidden="true"> / </span><span>{app.name} {version}</span>{/if}
  </p>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !app}
    <div role="status" aria-label={t('release:rd.loading')}>
      <div class="skeleton-head">
        <Skeleton width="260px" height="28px" />
        <Skeleton width="180px" height="16px" />
      </div>
      <div class="columns">
        <div class="card"><div class="stack"><Skeleton width="60%" height="16px" /><Skeleton width="80%" height="16px" /></div></div>
        <div class="card"><div class="stack"><Skeleton width="50%" height="16px" /><Skeleton width="70%" height="16px" /></div></div>
      </div>
    </div>
  {:else if loadError}
    {#if loadError.notFound}
      <div class="card">
        <EmptyState icon="box" title={t('release:rd.notFound')} description={t('release:rd.notFoundHint')}>
          {#snippet actions()}
            <Button href={portfolioHref} variant="primary">{t('release:rd.backToApps')}</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="stack">
        <Alert tone="error" title={t('release:rd.loadFailed')}>{loadError.message}</Alert>
        <div class="row">
          <Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button>
          <Button href={portfolioHref} variant="ghost">{t('release:rd.backToApps')}</Button>
        </div>
      </div>
    {/if}
  {:else if app}
    <div class="release-head">
      <AppIcon name={app.name} url={app.iconUrl} platform={app.platform} seed={app.id} size="lg" />
      <div class="release-head-main">
    <PageHeader title="{app.name} {version}" description={PLANS_ENABLED ? t('release:rd.descPlans') : t('release:rd.desc')} />
      </div>
    </div>

    <div class="stack loose">
      {#if lead}
        {@const l = lead}
        <PageLead headline={l.headline} hint={l.hint} tone={l.tone} testid="release-lead">
          {#snippet aside()}
            <ul class="words" aria-label={t('release:rd.statusPerPlatform')}>
              {#each l.words as w (w.platform)}
                <li><PlatformBadge platform={w.platform} /> <span class="word">{w.word}</span></li>
              {/each}
            </ul>
          {/snippet}
          {#snippet actions()}
            {#if l.action}
              <Button variant="primary" size="lg" icon="arrow-right" href={releaseStepHref(l.action.appId, address.platform, l.action.step, version)}>{l.action.label}</Button>
            {/if}
          {/snippet}
        </PageLead>
      {/if}
      {#if plan?.blocked}
        <Alert tone="warn" title={t('release:plan.blocked')}>{plan.blockedReason}</Alert>
      {/if}
      {#if attention}<AttentionStrip items={[attention]} compact />{/if}

      <div class="columns">
        {#each ordered as a (a.id)}
          <PlatformPanel app={a} version={version} releases={releasesFor(a)} {now} plan={planFor(a)} primary={a.id === appId} />
        {/each}
      </div>
      {#if siblings.length === 0}
        <p class="muted note">
          {t('release:rd.onlyShown', { platform: platformLabel(app.platform) })}
        </p>
      {/if}

      {#if !PLANS_ENABLED}
        <!-- Release plans are switched off (lib/features.ts). -->
      {:else if !canReadPlans}
        <Alert tone="info">{t('release:rd.noRolePlans')}</Alert>
      {:else if plansProblem}
        <Alert tone="error" title={t('release:row.loadFailed')}>{plansProblem}</Alert>
        <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
      {:else if plan}
        <PlanOverview {api} {workspaceId} {plan} {canWrite} onplan={setPlan} ondelete={() => { plan = null; }} />
        <Checklist {api} {workspaceId} {plan} {canWrite} onplan={setPlan} />
        <Rollout {api} {workspaceId} {plan} {canWrite} onsummary={(summary) => { if (plan) plan = { ...plan, rollout: summary }; }} />
        <ReleaseNotes {api} {workspaceId} {plan} {canWrite} onplan={setPlan} />
      {:else if canWrite}
        {#if siblingPlan}
          <Alert tone="info">
            {@const sibling = siblingPlan}
            {#if sibling.plan.platform === null}
              <T key="release:rd.siblingPlanAll" params={{ platform: planPlatformLabel(sibling.app.platform), version }} tags={{ link: openThere }} />
            {:else}
              <T key="release:rd.siblingPlan" params={{ platform: planPlatformLabel(sibling.app.platform), version }} tags={{ link: openThere }} />
            {/if}
          </Alert>
        {/if}
        <NewPlan {api} {workspaceId} {app} {version} {hasPlans} oncreated={setPlan} />
      {:else}
        <div class="card">
          <EmptyState icon="file-text" title={t('release:rd.noPlan')} description={t('release:rd.noPlanHint')} />
        </div>
      {/if}
    </div>
  {/if}
</section>

{#snippet openThere(text: string)}
  {#if siblingPlan}<a href={releaseHref(siblingPlan.app.id, version)}>{text}</a>{:else}{text}{/if}
{/snippet}

<style>
  .release-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
  }
  .release-head-main {
    flex: 1;
    min-width: 0;
  }
  .back {
    margin: 0 0 var(--space-3);
  }

  .back a {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .skeleton-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }

  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: var(--space-4);
    align-items: start;
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }

  .words {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .words li {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .word {
    font-weight: var(--weight-semibold);
  }
</style>
