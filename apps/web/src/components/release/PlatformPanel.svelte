<!--
  PlatformPanel: one app's side of a version: for each release of that version (each Play track),
  the place in the lifecycle, the store's own state, the build, the rollout and what to do next.
  All of it is read from the store by the last sync. It has no control that changes a store.
  Props: app (AppSummary), releases (the releases of this version), version, now (epoch ms), plan?
  (the plan for this version, for the next action), primary (the app the page was opened for).
-->
<script lang="ts">
  import { nextAction } from '../../lib/dashboard.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appHref, platformLabel, storeName, trackLabel } from '../../lib/portfolio.ts';
  import type { AppSummary, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import Timeline from '../portfolio/Timeline.svelte';
  import Icon from '../ui/Icon.svelte';
  import RolloutObserved from './RolloutObserved.svelte';

  let {
    app,
    releases,
    version,
    now,
    plan = null,
    primary = false,
  }: {
    app: AppSummary;
    releases: ReleaseSummary[];
    version: string;
    now: number;
    plan?: PlanSummary | null;
    /** The app the page was opened for; the other platform is marked as a neighbour. */
    primary?: boolean;
  } = $props();

  const uid = $props.id();
  const store = $derived(storeName(app.platform));
</script>

<section class="panel card" aria-labelledby="{uid}-title">
  <header class="head">
    <div class="who">
      <h2 id="{uid}-title" class="title">{platformLabel(app.platform)} · {store}</h2>
      <p class="muted small">
        <a href={appHref(app.id)}>{app.name}</a> · <code>{app.identifier}</code>{#if !primary} · the same product on the other platform{/if}
      </p>
    </div>
    <PlatformBadge platform={app.platform} showLabel={false} />
  </header>

  <p class="observed muted small">
    <Icon name="eye" size={14} />
    {#if app.lastSyncedAt !== null}
      Read from {store} <time datetime={new Date(app.lastSyncedAt).toISOString()} title={fullTime(app.lastSyncedAt)}>{timeAgo(app.lastSyncedAt, now)}</time>. This page cannot change it.
    {:else}
      Not read from {store} yet. Sync the app to see its state. This page cannot change it.
    {/if}
  </p>

  {#if releases.length === 0}
    <p class="none">
      Version {version} is not in the {store} snapshot{plan ? ' yet' : ''}.
      {#if plan}{nextAction({ platform: app.platform, status: null, planned: true, readiness: plan.readiness, blocked: plan.blocked ? { kind: 'other', reason: plan.blockedReason ?? '' } : null }).text}.{/if}
    </p>
  {:else}
    {#each releases as release (release.id)}
      {@const next = nextAction({
        platform: release.platform,
        status: release.status,
        rawState: release.rawState,
        readiness: plan?.readiness ?? null,
        blocked: plan?.blocked ? { kind: 'other', reason: plan.blockedReason ?? '' } : release.status === 'rejected' ? { kind: 'rejection', reason: 'The store rejected this version.' } : null,
      })}
      <div class="release">
        {#if release.track !== null}<h3 class="track">{trackLabel(release.track)}</h3>{/if}
        <div class="line">
          <ReleaseStatus status={release.status} rawState={release.rawState} />
          <span class="muted small">Store state <code>{release.rawState}</code></span>
        </div>
        {#if release.status}
          <Timeline platform={release.platform} status={release.status} label="Lifecycle of {platformLabel(release.platform)} version {release.version}{release.track ? `, ${trackLabel(release.track)}` : ''}" />
        {/if}
        <dl class="facts">
          <div>
            <dt>{release.platform === 'android' ? 'Version codes' : 'Build'}</dt>
            <dd>{release.platform === 'android' ? (release.versionCodes?.join(', ') ?? '—') : (release.build ?? '—')}</dd>
          </div>
          <div>
            <dt>Store updated</dt>
            <dd>
              {#if release.storeUpdatedAt !== null}
                <time datetime={new Date(release.storeUpdatedAt).toISOString()} title={fullTime(release.storeUpdatedAt)}>{timeAgo(release.storeUpdatedAt, now)}</time>
              {:else}—{/if}
            </dd>
          </div>
        </dl>
        <RolloutObserved {release} />
        <p class="next"><span class="eyebrow">Next</span> {next.text}</p>
      </div>
    {/each}
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .head {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
  }

  .title {
    margin: 0;
    font-size: var(--text-md);
  }

  .small {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .observed {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .none {
    margin: 0;
    color: var(--muted);
  }

  .release {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }

  .track {
    margin: 0;
    font-size: var(--text-base);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3);
    margin: 0;
  }

  .facts dt {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .next {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
