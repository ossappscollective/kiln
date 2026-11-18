<!--
  AppDashboard: the first screen of an app: one card per platform in scope with its latest release,
  what is live and the state of the last sync. A summary of data already loaded; it reads nothing new.
  Props: members (the records in scope), releases (by app id), now, canSync, syncing (by app id), onsync.
-->
<script lang="ts">
  import { appAddress } from '../../lib/app-scope.ts';
  import { latestRelease, liveRelease, trackLabel } from '../../lib/portfolio.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import SyncStatus from '../portfolio/SyncStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    members,
    releases,
    now,
    canSync,
    syncing,
    onsync,
  }: {
    members: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
  } = $props();
</script>

<div class="grid">
  {#each members as app (app.id)}
    {@const list = releases[app.id] ?? []}
    {@const latest = latestRelease(list, app.platform)}
    {@const live = liveRelease(list, app.platform)}
    <section class="card" aria-label="{app.platform === 'ios' ? 'iOS' : 'Android'} summary">
      <div class="row between">
        <PlatformBadge platform={app.platform} tinted />
        {#if canSync}
          <Button size="sm" icon="refresh" loading={syncing[app.id] === true} onclick={() => onsync(app)}>Sync</Button>
        {/if}
      </div>
      <dl class="facts">
        <div>
          <dt>{app.platform === 'ios' ? 'Bundle ID' : 'Package name'}</dt>
          <dd class="row"><code>{app.identifier}</code><CopyButton value={app.identifier} iconOnly label="Copy the identifier" /></dd>
        </div>
        <div>
          <dt>Latest release</dt>
          <dd>
            {#if latest}
              <span class="latest">
                <strong>{latest.version}</strong>
                {#if latest.track && latest.track !== 'production'}<span class="muted">{trackLabel(latest.track)}</span>{/if}
                <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} />
                <a href={appAddress(app.id, 'releases', null, latest.version)}>Plan and details<span class="visually-hidden"> for version {latest.version}</span></a>
              </span>
            {:else}
              <span class="muted">{app.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt>Live now</dt>
          <dd>{#if live}<strong>{live.version}</strong>{:else}<span class="muted">None reported</span>{/if}</dd>
        </div>
        <div>
          <dt>Last synced</dt>
          <dd><SyncStatus {app} {now} /></dd>
        </div>
      </dl>
      {#if (app.lastSyncError ?? '').trim() !== ''}
        <Alert tone="error" title="The last sync failed">{app.lastSyncError}</Alert>
      {/if}
    </section>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: var(--space-4);
    align-items: start;
  }

  .facts {
    display: grid;
    gap: var(--space-3);
    margin: var(--space-4) 0 0;
  }

  .facts dt {
    margin-bottom: var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .latest {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
</style>
