<!--
  ReleaseGroupCard: the releases of one platform and track: where the newest one is in the
  lifecycle, and a table of every version the store reported.
  Props: group (from groupReleases), now (epoch ms, so relative times update).
-->
<script lang="ts">
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { type ReleaseGroup, statusInfo } from '../../lib/portfolio.ts';
  import ReleaseStatus from './ReleaseStatus.svelte';
  import Timeline from './Timeline.svelte';

  let { group, now }: { group: ReleaseGroup; now: number } = $props();

  const uid = $props.id();
  const latest = $derived(group.latest);
  const info = $derived(statusInfo(latest.status, latest.rawState));
  const unmapped = $derived(group.releases.filter((r) => r.status === null).length);
</script>

<section class="card flush" aria-labelledby="{uid}-title">
  <div class="head">
    <h2 id="{uid}-title">{group.title}</h2>
    <span class="muted">{group.releases.length} {group.releases.length === 1 ? 'release' : 'releases'}</span>
  </div>

  <div class="lifecycle">
    <p class="eyebrow">Newest: {latest.version}</p>
    {#if latest.status}
      <Timeline platform={group.platform} status={latest.status} label="Lifecycle of version {latest.version}" />
      <p class="muted note">{info.description}</p>
    {:else}
      <p class="muted note">{info.description} It has no place on the timeline.</p>
    {/if}
  </div>

  <div class="table-scroll">
    <table class="compact">
      <caption class="visually-hidden">Releases on {group.title}, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">{group.platform === 'android' ? 'Version codes' : 'Build'}</th>
          <th scope="col">Status</th>
          <th scope="col">Store state</th>
          <th scope="col">Store updated</th>
          <th scope="col">Confirmed</th>
        </tr>
      </thead>
      <tbody>
        {#each group.releases as release (release.id)}
          <tr>
            <th scope="row" class="version">{release.version}</th>
            <td>{release.build ?? '—'}</td>
            <td><ReleaseStatus status={release.status} rawState={release.rawState} rolloutFraction={release.rolloutFraction} sentForReviewAt={release.sentForReviewAt} /></td>
            <td><code>{release.rawState}</code></td>
            <td class="muted">
              {#if release.storeUpdatedAt !== null}
                <time datetime={new Date(release.storeUpdatedAt).toISOString()} title={fullTime(release.storeUpdatedAt)}>{timeAgo(release.storeUpdatedAt, now)}</time>
              {:else}
                <span aria-label="Not reported by the store">—</span>
              {/if}
            </td>
            <td class="muted">
              <time datetime={new Date(release.syncedAt).toISOString()} title={fullTime(release.syncedAt)}>{timeAgo(release.syncedAt, now)}</time>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if unmapped > 0}
    <p class="muted footnote">
      {unmapped === 1 ? 'One release has' : `${unmapped} releases have`} a store state with no normalized status. The store’s own state is shown instead.
    </p>
  {/if}
</section>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--line);
  }

  .head h2 {
    font-size: var(--text-md);
  }

  .lifecycle {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--line);
  }

  .lifecycle p {
    margin: 0;
  }

  .note {
    font-size: var(--text-sm);
  }

  .table-scroll {
    overflow-x: auto;
  }

  .version {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    color: var(--ink);
    white-space: nowrap;
    background: none;
  }

  .footnote {
    padding: var(--space-3) var(--space-5);
    margin: 0;
    font-size: var(--text-sm);
    border-top: 1px solid var(--line);
  }
</style>
