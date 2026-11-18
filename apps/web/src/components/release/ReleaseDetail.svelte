<!--
  ReleaseDetail: one version of one app: where it is in the lifecycle on each platform, what the
  store reports (read only, including Android's staged rollout beside Apple's phased release), and
  the plan we keep for it: checklist, release notes per locale, target date, blocked flag.
  It lives at `#/portfolio/<appId>/release/<version>`, a screen of the portfolio next to the app
  page, because it can show two apps (iOS and Android) of one product, which the app page cannot.
  Props: api, workspaceId, role, appId, version.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { appLabel, describeError, portfolioHref } from '../../lib/portfolio.ts';
  import { attentionOf } from '../../lib/dashboard.ts';
  import { dueText, findSibling, planPlatformLabel, releaseHref, releasesOfVersion, rolloutBadge } from '../../lib/release.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { AppSummary, PlanDetail, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import AttentionStrip from '../dashboard/AttentionStrip.svelte';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Checklist from './Checklist.svelte';
  import NewPlan from './NewPlan.svelte';
  import PlanOverview from './PlanOverview.svelte';
  import PlatformPanel from './PlatformPanel.svelte';
  import ReleaseNotes from './ReleaseNotes.svelte';
  import Rollout from './Rollout.svelte';

  let { api, workspaceId, role, appId, version }: { api: Api; workspaceId: string; role: Role; appId: string; version: string } = $props();

  /** Back to the app's Releases tab, keeping the platform scope that is in the address. */
  const backHref = $derived(appAddress(appId, 'releases', address.platform));

  const canReadPlans = $derived(can(role, 'plans.read'));
  const canWrite = $derived(can(role, 'plans.write'));

  let app = $state<AppSummary | null>(null);
  let releases = $state<ReleaseSummary[]>([]);
  let sibling = $state<AppSummary | null>(null);
  let siblingReleases = $state<ReleaseSummary[]>([]);
  /** A plan for this version on the other platform's app, when this app has none. */
  let siblingPlan = $state<PlanSummary | null>(null);
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
    announcement = `Opened version ${version} of ${appLabel(current)}.`;
  }

  async function loadSibling(current: AppSummary, mine: number) {
    try {
      const list = (await api.apps(workspaceId)).apps;
      const other = findSibling(list, current);
      if (!other) {
        if (mine === generation) {
          sibling = null;
          siblingReleases = [];
        }
        return;
      }
      const detail = await api.app(workspaceId, other.id);
      if (mine !== generation) return;
      sibling = detail.app;
      siblingReleases = detail.releases;
      if (canReadPlans) {
        const theirs = (await api.appPlans(workspaceId, other.id)).plans.find((p) => p.version === version) ?? null;
        if (mine === generation) siblingPlan = theirs;
      }
    } catch {
      if (mine === generation) {
        sibling = null;
        siblingReleases = [];
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
    sibling = null;
    siblingPlan = null;
    siblingReleases = [];
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
  const theirs = $derived(releasesOfVersion(siblingReleases, version));
  const ordered = $derived(app && sibling ? (app.platform === 'ios' ? [app, sibling] : [sibling, app]) : app ? [app] : []);
  const due = $derived(plan?.targetDate ? dueText(plan.due, plan.released) : null);
  const rollout = $derived(plan ? rolloutBadge(plan.rollout) : null);
  const attention = $derived(plan ? attentionOf(plan) : null);

  const releasesFor = (a: AppSummary) => (a.id === appId ? mine : theirs);
  const planFor = (a: AppSummary) => (a.id === appId ? plan : null);

  function setPlan(next: PlanDetail) {
    plan = next;
    hasPlans = true;
  }
</script>

<section aria-busy={loading}>
  <p class="back">
    <a href={backHref}><Icon name="chevron-left" size={16} /> Releases</a>
    {#if app}<span aria-hidden="true"> / </span><span>{app.name} {version}</span>{/if}
  </p>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !app}
    <div role="status" aria-label="Loading the release">
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
        <EmptyState icon="box" title="App not found" description="This app is not in this workspace. It may have been deleted.">
          {#snippet actions()}
            <Button href={portfolioHref} variant="primary">Back to all apps</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="stack">
        <Alert tone="error" title="Could not load the release">{loadError.message}</Alert>
        <div class="row">
          <Button icon="refresh" onclick={load}>Try again</Button>
          <Button href={portfolioHref} variant="ghost">Back to all apps</Button>
        </div>
      </div>
    {/if}
  {:else if app}
    <div class="release-head">
      <AppIcon name={app.name} url={app.iconUrl} platform={app.platform} seed={app.id} size="lg" />
      <div class="release-head-main">
    <PageHeader title="{app.name} {version}" description="Where this version is on each platform, and the plan for getting it out. The store state is read only; the plan is our own.">
      {#snippet actions()}
        <div class="row">
          {#if plan?.blocked}<Badge tone="bad" icon={toneIcon('bad')}>Blocked</Badge>{/if}
          {#if due}<Badge tone={due.tone} icon={toneIcon(due.tone)}>{due.text}</Badge>{/if}
          {#if rollout}<Badge tone={rollout.tone} icon={toneIcon(rollout.tone)}>{rollout.label}</Badge>{/if}
        </div>
      {/snippet}
    </PageHeader>
      </div>
    </div>

    <div class="stack loose">
      {#if plan?.blocked}
        <Alert tone="warn" title="Blocked">{plan.blockedReason}</Alert>
      {/if}
      {#if attention}<AttentionStrip items={[attention]} compact />{/if}

      <div class="columns">
        {#each ordered as a (a.id)}
          <PlatformPanel app={a} version={version} releases={releasesFor(a)} {now} plan={planFor(a)} primary={a.id === appId} />
        {/each}
      </div>
      {#if !sibling}
        <p class="muted note">
          Only {app.platform === 'ios' ? 'iOS' : 'Android'} is shown. If this product is also in the other store, add that app with the same identifier or name and it appears beside this one.
        </p>
      {/if}

      {#if !canReadPlans}
        <Alert tone="info">Your role does not include release plans.</Alert>
      {:else if plansProblem}
        <Alert tone="error" title="Could not load the plan">{plansProblem}</Alert>
        <div><Button icon="refresh" onclick={load}>Try again</Button></div>
      {:else if plan}
        <PlanOverview {api} {workspaceId} {plan} {canWrite} onplan={setPlan} ondelete={() => { plan = null; }} />
        <Checklist {api} {workspaceId} {plan} {canWrite} onplan={setPlan} />
        <Rollout {api} {workspaceId} {plan} {canWrite} onsummary={(summary) => { if (plan) plan = { ...plan, rollout: summary }; }} />
        <ReleaseNotes {api} {workspaceId} {plan} {canWrite} onplan={setPlan} />
      {:else if canWrite}
        {#if siblingPlan && sibling}
          <Alert tone="info">
            The {planPlatformLabel(sibling.platform)} app has a plan for {version}{siblingPlan.platform === null ? ' that covers both platforms' : ''}.
            <a href={releaseHref(sibling.id, version)}>Open it there</a>.
          </Alert>
        {/if}
        <NewPlan {api} {workspaceId} {app} {version} {hasPlans} oncreated={setPlan} />
      {:else}
        <div class="card">
          <EmptyState icon="file-text" title="No plan for this version" description="A member or admin can start a plan with a checklist, release notes and a target date." />
        </div>
      {/if}
    </div>
  {/if}
</section>

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
    font-size: var(--text-sm);
  }
</style>
