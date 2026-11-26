<!--
  AppReleases: the releases tab of an app: a compact table of the releases the store reports for the
  platforms in scope, grouped by version (version, platform, build, status, rollout share, date, CI
  state, plan state), each row opening to its store and plan detail. The default view is what matters
  now (the newest release of each platform, what is live, in progress or planned); the rest is under a
  collapsed "Older releases" with a search. Below it, the "Rollout controls" section (a slim line while
  rollout changes are switched off).
  The plans and the builds are extras: when they cannot be loaded the table still shows the store's
  releases, with the plan and CI cells reading "—".
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), releases (by app id), now,
  syncRuns (changes when a sync finished, so plans and builds reload). Sync lives in the app header's Status button.
  Above the table one "Next step" card (NextStep) with ONE primary button chosen by state: the release that waits for you, the one
  in store review, or "Start release" (opens the dispatch dialog on the app's release workflow, follows the run it started) when nothing
  is going on; the five steps of a release on its way are inside it. Preparing a release by hand ("Prepare without CI", or "Prepare
  release" without a linked repository) opens the stepper (components/release/stepper) in place of the list; the step is kept in the
  address (`&step=`), so the "Release left unfinished" item and a reload land on it.
  The platform scope for links comes from the address.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { can, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { promoteFromHash, withoutPromote } from '../../lib/play-promote.ts';
  import { prefillFromHash, type StepId, stepFromHash, withStep } from '../../lib/release-stepper.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { scopeFor } from '../../lib/app-state/derive.ts';
  import {
    buildReleaseTable,
    defaultReleaseFilter,
    filterGroups,
    splitCurrent,
    type ObsoleteInfo,
    type ReleaseFilter,
  } from '../../lib/releases-table.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppBuild, AppSummary, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import ReleaseTable from '../release/ReleaseTable.svelte';
  import AssetProposalHint from '../release/AssetProposalHint.svelte';
  import NextStep from './NextStep.svelte';
  import ReleaseStepper from '../release/stepper/ReleaseStepper.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import RolloutControls from '../release/RolloutControls.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    releases,
    now,
    syncRuns,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[] | undefined;
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
  } = $props();

  const canReadPlans = $derived(PLANS_ENABLED && can(role, 'plans.read'));

  let plans = $state<Record<string, PlanSummary[] | undefined>>({});
  let plansOk = $state(false);
  let builds = $state<Record<string, AppBuild[] | undefined>>({});
  let filter = $state<ReleaseFilter>(defaultReleaseFilter());
  let generation = 0;

  async function loadExtras(list: AppSummary[]) {
    const mine = ++generation;
    const nextPlans: Record<string, PlanSummary[]> = {};
    const nextBuilds: Record<string, AppBuild[]> = {};
    let allPlans = canReadPlans;
    await Promise.all(
      list.map(async (app) => {
        if (canReadPlans) {
          try {
            nextPlans[app.id] = (await api.appPlans(workspaceId, app.id)).plans;
          } catch {
            allPlans = false;
          }
        }
        try {
          nextBuilds[app.id] = (await api.appBuilds(workspaceId, app.id)).builds;
        } catch {
          // No CI data for this app: its CI cells read "—".
        }
      }),
    );
    if (mine !== generation) return;
    plans = nextPlans;
    plansOk = allPlans;
    builds = nextBuilds;
  }

  // Another app, scope or workspace starts clean; a finished sync loads again. A string key, so a
  // refreshed record (a new object) does not reload.
  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    void syncRuns;
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        plans = {};
        plansOk = false;
        builds = {};
        filter = defaultReleaseFilter();
      }
      void loadExtras(members);
    });
  });

  // The one answer about candidates and versions left behind: the same state the card above reads.
  const modelRecords = $derived(all ?? members);
  const appState = $derived(
    appStateStore.of({ workspaceId, role, records: modelRecords, scope: scopeFor(modelRecords, members), releases }),
  );
  const obsoleteById = $derived(
    appState.obsolete.reduce<Record<string, ObsoleteInfo>>((acc, o) => {
      const notice = appState.notices.find((n) => n.kind === 'obsolete_version' && n.appId === o.appId && n.version === o.version);
      acc[o.releaseId] = { liveVersion: o.liveVersion, href: notice?.href ?? null, linkLabel: notice?.linkLabel ?? null };
      return acc;
    }, {}),
  );
  const groups = $derived(
    buildReleaseTable({
      releases,
      plans: plansOk ? plans : null,
      builds,
      appIds: members.map((m) => m.id),
      obsolete: obsoleteById,
    }),
  );
  // What matters now is the default view; the rest is under "Older releases". The "not live yet" switch
  // applies to both; the search only to the older ones, so the short list stays short.
  const notLive = $derived(filterGroups(groups, { query: '', inProgressOnly: filter.inProgressOnly }));
  const split = $derived(splitCurrent(notLive));
  const olderShown = $derived(filterGroups(split.older, { query: filter.query, inProgressOnly: false }));
  const olderShownCount = $derived(olderShown.reduce((n, g) => n + g.rows.length, 0));
  const visible = $derived(split.current);
  const apps = $derived(
    members.reduce<Record<string, AppSummary | undefined>>((acc, m) => {
      acc[m.id] = m;
      return acc;
    }, {}),
  );
  const empty = $derived(members.filter((m) => (releases[m.id] ?? []).length === 0));
  const filtering = $derived(filter.query.trim() !== '' || filter.inProgressOnly);
  const searching = $derived(filter.query.trim() !== '');
  const scope = $derived(address.platform);

  // "Prepare release": the stepper of the address (`&step=`). While it is open it replaces the table, so the page has one job.
  const canPrepare = $derived(can(role, 'listing.read'));
  const step = $derived<StepId | null>(canPrepare ? stepFromHash(address.hash) : null);
  const uid = $props.id();
  let stepperPlatform = $state('');
  const stepperTab = $derived(members.find((m) => m.platform === stepperPlatform)?.platform ?? members[0]?.platform ?? '');
  // "Promote to production" opens the first step with the track, the codes and the target in the address.
  const promote = $derived(canPrepare && step !== null ? promoteFromHash(address.hash) : null);
  // "Create release 2.0.1 from TestFlight build 95" opens the same first step with the version and the build in the address.
  const prefill = $derived(canPrepare && step !== null ? prefillFromHash(address.hash) : null);
  const openStepper = () => replaceHash(withStep(withoutPromote(location.hash), 'build'));
  /** The line "N store asset changes proposed" goes to the Assets step, where the proposal card is. */
  const openAssets = () => replaceHash(withStep(withoutPromote(location.hash), 'assets'));
  const closeStepper = () => replaceHash(withStep(withoutPromote(location.hash), null));
  const moveStep = (next: StepId) => replaceHash(withStep(location.hash, next));

  const emptyTitle = (app: (typeof members)[number]): string =>
    app.lastSyncedAt === null
      ? members.length > 1
        ? t('app:releases.notSyncedOn', { platform: platformLabel(app.platform) })
        : t('app:status.notSynced')
      : members.length > 1
        ? t('app:releases.noneOn', { platform: platformLabel(app.platform) })
        : t('app:dash.noReleasesReported');
</script>

<div class="stack loose">
  {#if step === null}
    <NextStep {api} {workspaceId} {role} {members} {all} {scope} {releases} refreshKey={syncRuns} onprepare={canPrepare ? openStepper : undefined} showRunning />
    {#if canPrepare}
      {#each members as app (app.id)}
        {#if app.repositoryId !== null}
          <AssetProposalHint {api} {workspaceId} {app} showPlatform={members.length > 1} refreshKey={syncRuns} onreview={openAssets} />
        {/if}
      {/each}
    {/if}
  {/if}

  {#if step !== null}
    <div class="stack">
      {#if members.length > 1}
        <div class="row">
          <SegmentTabs tabs={members.map((m) => ({ id: m.platform, label: platformLabel(m.platform) }))} bind:value={stepperPlatform} label={t('app:scope.label')} idPrefix="{uid}-prepare" />
        </div>
      {/if}
      {#each members as app (app.id)}
        {@const ids = segmentIds(`${uid}-prepare`, app.platform)}
        <div role={members.length > 1 ? 'tabpanel' : undefined} id={members.length > 1 ? ids.panel : undefined} aria-labelledby={members.length > 1 ? ids.tab : undefined} hidden={members.length > 1 && stepperTab !== app.platform}>
          <ReleaseStepper
            {api}
            {workspaceId}
            {role}
            {app}
            scope={scope}
            appBuilds={builds[app.id] ?? []}
            {releases}
            {step}
            promote={supports(app.platform, 'releaseTracks') ? promote : null}
            prefill={supports(app.platform, 'releaseTracks') ? null : prefill}
            onstep={moveStep}
            onclose={closeStepper}
            showPlatform={members.length > 1}
          />
        </div>
      {/each}
    </div>
  {/if}

  {#if step !== null}
    <!-- the steps replace the list while they are open -->
  {:else if groups.length === 0}
    <div class="stack">
      {#each members as app (app.id)}
        <div class="card">
          <EmptyState
            icon="box"
            title={emptyTitle(app)}
            description={app.lastSyncedAt === null ? t('app:releases.notSyncedHelp') : t('app:releases.syncedEmptyHelp')}
          >
          </EmptyState>
        </div>
      {/each}
    </div>
  {:else}
    <Section title={t('app:releases.current')} key="current" variant="plain" count={split.currentCount}>
      {#snippet actions()}
        <div class="filters">
          <label class="check">
            <input type="checkbox" bind:checked={filter.inProgressOnly} />
            <span>{t('app:releases.notLiveYet')}</span>
          </label>
          <InfoTip label={t('app:releases.aboutList')} align="end">
            <p>{PLANS_ENABLED ? t('app:releases.aboutShownPlans') : t('app:releases.aboutShown')}</p>
            <p>{t('app:releases.aboutSnapshot')}</p>
          </InfoTip>
        </div>
      {/snippet}
      <div class="stack">
      {#if empty.length > 0}
        <p class="muted note">
          {t('app:releases.emptyPlatforms', { platforms: formatList(empty.map((m) => platformLabel(m.platform))) })}
        </p>
      {/if}

      {#if visible.length === 0 && appState.candidates.length === 0}
        <div class="card">
          <EmptyState icon="check-circle" title={t('app:releases.nothingInProgress')} description={t('app:releases.noMatchFilter')}>
            {#snippet actions()}
              {#if filter.inProgressOnly}<Button onclick={() => (filter = defaultReleaseFilter())}>{t('app:releases.clearFilter')}</Button>{/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        <ReleaseTable {api} {workspaceId} {role} groups={visible} {apps} {builds} {releases} candidates={appState.candidates} {now} {scope} showPlatform={members.length > 1} />
      {/if}
      </div>
    </Section>

    {#if split.olderCount > 0}
      <Section title={t('app:releases.older')} key="older" count={split.olderCount} defaultOpen={false} summary={searching ? t('app:releases.matches', { count: olderShownCount }) : t('app:releases.newestFirst')}>
        <div class="stack">
          <div class="older-tools">
            <label class="visually-hidden" for="releases-query">{t('app:releases.searchOlder')}</label>
            <input id="releases-query" type="search" placeholder={t('app:releases.searchPlaceholder')} bind:value={filter.query} />
            {#if searching}<Button size="sm" variant="ghost" onclick={() => (filter = { ...filter, query: '' })}>{t('app:releases.clearSearch')}</Button>{/if}
          </div>
          {#if olderShown.length === 0}
            <p class="muted note">{t('app:releases.noOlderMatch')}</p>
          {:else}
            <ReleaseTable {api} {workspaceId} {role} groups={olderShown} {apps} {builds} {releases} {now} {scope} showPlatform={members.length > 1} />
          {/if}
        </div>
      </Section>
    {/if}
  {/if}

  {#if step === null}<RolloutControls {api} {workspaceId} {role} {members} {releases} />{/if}
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .filters {
    gap: var(--space-2);
  }

  .older-tools {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .older-tools input[type='search'] {
    width: 18rem;
    min-height: var(--control-sm);
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
