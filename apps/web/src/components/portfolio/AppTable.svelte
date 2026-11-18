<!--
  AppTable: the apps of the workspace, one row each, with the latest release and the last sync.
  Props: apps (already sorted), releases (the loaded releases by app id), now (epoch ms),
  canSync (shows the Sync button), syncing (app ids being synced now), locked (true while a
  "Sync all" run owns the sync buttons), onsync (called with an app).
-->
<script lang="ts">
  import {
    appHref,
    appLabel,
    latestRelease,
    liveRelease,
    trackLabel,
    type ReleaseLoad,
  } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import PlatformBadge from './PlatformBadge.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';
  import SyncStatus from './SyncStatus.svelte';

  let {
    apps,
    releases,
    now,
    canSync,
    syncing,
    locked,
    onsync,
  }: {
    apps: AppSummary[];
    releases: Record<string, ReleaseLoad | undefined>;
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    locked: boolean;
    onsync: (app: AppSummary) => void;
  } = $props();
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Apps in this workspace</caption>
    <thead>
      <tr>
        <th scope="col">App</th>
        <th scope="col">Latest release</th>
        <th scope="col">Last synced</th>
        {#if canSync}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each apps as app (app.id)}
        {@const load = releases[app.id]}
        {@const latest = load?.state === 'ready' ? latestRelease(load.releases, app.platform) : null}
        {@const live = load?.state === 'ready' ? liveRelease(load.releases, app.platform) : null}
        <tr>
          <td>
            <div class="app">
              <AppIcon name={app.name} url={app.iconUrl} platform={app.platform} seed={app.id} size="md" />
              <div class="names">
                <a id="app-open-{app.id}" class="app-name" href={appHref(app.id)}>{app.name}</a>
                <div class="meta">
                  <PlatformBadge platform={app.platform} />
                  <code class="identifier">{app.identifier}</code>
                </div>
              </div>
            </div>
          </td>
          <td>
            {#if !load || load.state === 'loading'}
              <div class="loading" role="status" aria-label="Loading the latest release of {appLabel(app)}">
                <Skeleton width="72px" height="14px" />
                <Skeleton width="88px" height="20px" />
              </div>
            {:else if load.state === 'error'}
              <span class="muted">Could not load. Sync to try again.</span>
            {:else if latest}
              <div class="release">
                <div class="line">
                  <strong class="version">{latest.version}</strong>
                  {#if latest.build}<span class="muted build">build {latest.build}</span>{/if}
                  {#if latest.track && latest.track !== 'production'}
                    <span class="muted">{trackLabel(latest.track)}</span>
                  {/if}
                </div>
                <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} />
                {#if latest.status === null}<code class="raw">{latest.rawState}</code>{/if}
                {#if live && live.id !== latest.id}
                  <span class="muted live">Live: {live.version}</span>
                {/if}
              </div>
            {:else}
              <span class="muted">{app.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}</span>
            {/if}
          </td>
          <td><SyncStatus {app} {now} /></td>
          {#if canSync}
            <td class="actions">
              <Button
                size="sm"
                icon="refresh"
                loading={syncing[app.id] === true}
                disabled={locked && syncing[app.id] !== true}
                label="Sync {appLabel(app)}"
                onclick={() => onsync(app)}>Sync</Button
              >
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .app {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-width: 200px;
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .app-name {
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .identifier {
    width: fit-content;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .release {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }

  .build,
  .live,
  .raw {
    font-size: var(--text-sm);
  }

  td.actions {
    white-space: nowrap;
  }
</style>
