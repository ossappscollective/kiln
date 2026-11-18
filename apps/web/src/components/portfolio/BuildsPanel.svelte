<!--
  BuildsPanel: the builds of one app and the CI runs that made them. Each row is a build the store
  reported (an iOS build number, or an Android version code) with its state in the store, the CI run
  it was matched to (or "Unlinked"), the commit, and a "What changed" expander that lists the
  commits since the previous linked build. Reading is open to everyone who can see the app; linking
  by hand needs the right to sync, and "What changed" reads GitHub, which needs the right of a scan.
  Nothing here builds or publishes: runs are started from the repository's CI tab.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished, so this reloads).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { buildName, buildNumberLabel, linkSourceLabel, shortSha } from '../../lib/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppBuild, AppBuilds, AppSummary } from '../../lib/types.ts';
  import RunStatus from '../ci/RunStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import BuildsPanelChanges from './BuildsPanelChanges.svelte';
  import BuildsPanelLink from './BuildsPanelLink.svelte';
  import PlatformBadge from './PlatformBadge.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    refreshKey,
  }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const canLink = $derived(can(role, 'apps.sync'));
  const canRead = $derived(can(role, 'repositories.scan'));

  let data = $state<AppBuilds | null>(null);
  let loading = $state(true);
  let loadProblem = $state('');
  let open = $state<Record<string, boolean>>({});
  let linkTarget = $state<AppBuild | null>(null);
  let unlinking = $state('');
  let announcement = $state('');
  const now = $derived.by(() => {
    void data;
    return Date.now();
  });

  let generation = 0;

  const keyOf = (build: Pick<AppBuild, 'platform' | 'buildNumber'>) => `${build.platform}:${build.buildNumber}`;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await api.appBuilds(workspaceId, app.id);
      if (mine !== generation) return;
      data = read;
    } catch (e) {
      if (mine !== generation) return;
      data = null;
      loadProblem = e instanceof ApiError ? e.message : 'Could not load the builds.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  /** Puts one updated build into the table without reloading the rest. */
  function replace(updated: AppBuild | null, original: AppBuild) {
    if (!data) return;
    const key = keyOf(original);
    data = { ...data, builds: data.builds.map((b) => (keyOf(b) === key ? (updated ?? b) : b)) };
    // A new link means a new commit: what changed has to be read again.
    open = { ...open, [key]: false };
  }

  async function unlink(build: AppBuild) {
    unlinking = keyOf(build);
    try {
      const done = await api.unlinkBuild(workspaceId, app.id, build);
      replace(done.build, build);
      toast.success(`Removed the link of ${buildName(build)}.`);
      announcement = `Removed the link of build ${build.buildNumber}.`;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not remove the link.');
    } finally {
      unlinking = '';
    }
  }

  function linked(updated: AppBuild) {
    if (!linkTarget) return;
    replace(updated, linkTarget);
    announcement = `Linked build ${updated.buildNumber}.`;
  }

  const unlinkedCount = $derived(data?.builds.filter((b) => b.linkState === 'unlinked').length ?? 0);
</script>

<div class="stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !data}
    <div class="card" role="status" aria-label="Loading the builds">
      <div class="stack">
        <Skeleton width="70%" height="16px" />
        <Skeleton width="55%" height="16px" />
        <Skeleton width="62%" height="16px" />
      </div>
    </div>
  {:else if loadProblem}
    <div class="stack">
      <Alert tone="error" title="Could not load the builds">{loadProblem}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if data}
    {#if !data.repository}
      <Alert tone="info" title="No repository is linked to this app">
        Builds can only be matched to CI runs once the app is linked to a connected repository. The builds below come from the last store sync.
      </Alert>
    {/if}

    {#if data.builds.length === 0}
      <div class="card">
        <EmptyState
          icon="box"
          title="No builds yet"
          description="Builds come from the store. Sync the app to read its iOS builds or Android version codes."
        />
      </div>
    {:else}
      <div class="table-wrap">
        <table>
          <caption class="visually-hidden">Builds of {app.name}</caption>
          <thead>
            <tr>
              <th scope="col">Build</th>
              <th scope="col">In the store</th>
              <th scope="col">CI run</th>
              <th scope="col">Commit</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data.builds as build (keyOf(build))}
              {@const key = keyOf(build)}
              {@const link = build.link}
              <tr>
                <td>
                  <div class="cell">
                    <span class="line"><PlatformBadge platform={build.platform} showLabel={false} /> <strong>{build.version}</strong></span>
                    <span class="muted text-sm">{buildNumberLabel(build.platform)} <code>{build.buildNumber}</code></span>
                    {#if build.tracks.length > 0}<span class="muted text-sm">{build.tracks.join(', ')}</span>{/if}
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <ReleaseStatus status={build.status} rawState={build.rawState} />
                    {#if build.uploadedAt !== null}
                      <span class="muted text-sm"
                        >Uploaded <time datetime={new Date(build.uploadedAt).toISOString()} title={fullTime(build.uploadedAt)}>{timeAgo(build.uploadedAt, now)}</time></span
                      >
                    {/if}
                  </div>
                </td>
                <td>
                  {#if link}
                    <div class="cell">
                      {#if link.run}
                        <span class="line">
                          {#if link.run.status !== 'unknown'}<RunStatus run={link.run} />{/if}
                          {#if link.run.url}
                            <a href={link.run.url} target="_blank" rel="noopener noreferrer"
                              >Run {link.run.id}<Icon name="external-link" size={14} /><span class="visually-hidden"> on GitHub (opens in a new tab)</span></a
                            >
                          {:else}
                            <span>Run {link.run.id}</span>
                          {/if}
                        </span>
                        {#if link.run.workflow}<span class="muted text-sm">{link.run.workflow}</span>{/if}
                      {:else}
                        <span class="muted">The run is no longer stored.</span>
                      {/if}
                      <span class="muted text-sm" title={link.reason}>{linkSourceLabel(link.source)}</span>
                    </div>
                  {:else}
                    <div class="cell">
                      <Badge tone="warn">Unlinked</Badge>
                      <span class="muted text-sm">No CI run with build number {build.buildNumber} was found.</span>
                    </div>
                  {/if}
                </td>
                <td>
                  {#if link?.commit}
                    <div class="cell">
                      {#if link.commit.url}
                        <a href={link.commit.url} target="_blank" rel="noopener noreferrer"
                          ><code>{link.commit.shortSha}</code><span class="visually-hidden"> on GitHub (opens in a new tab)</span></a
                        >
                      {:else}
                        <code>{shortSha(link.commit.sha)}</code>
                      {/if}
                      {#if link.commit.message}<span class="muted text-sm">{link.commit.message}</span>{/if}
                    </div>
                  {:else}
                    <span class="muted">None</span>
                  {/if}
                </td>
                <td class="actions">
                  <div class="buttons">
                    {#if canRead && link?.commit}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={open[key] ? 'chevron-up' : 'chevron-down'}
                        aria-expanded={open[key] ? 'true' : 'false'}
                        aria-controls="changes-{key.replace(':', '-')}"
                        onclick={() => (open = { ...open, [key]: !open[key] })}>What changed</Button
                      >
                    {/if}
                    {#if canLink && data.repository}
                      <Button size="sm" icon="git-branch" onclick={() => (linkTarget = build)}>{link?.manual ? 'Change link' : 'Link'}</Button>
                      {#if link?.manual}
                        <Button size="sm" variant="ghost" icon="x" loading={unlinking === key} onclick={() => unlink(build)}
                          >Remove link<span class="visually-hidden"> of build {build.buildNumber}</span></Button
                        >
                      {/if}
                    {/if}
                  </div>
                </td>
              </tr>
              {#if open[key] && canRead && link?.commit}
                <tr class="expanded">
                  <td colspan="5" id="changes-{key.replace(':', '-')}">
                    <BuildsPanelChanges {api} {workspaceId} appId={app.id} {build} />
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>

      <details class="how">
        <summary>How builds are matched to runs</summary>
        <p class="muted">
          A build is matched to a run by its number, never by guessing. {#if unlinkedCount > 0}{unlinkedCount} of {data.builds.length}
            {unlinkedCount === 1 ? 'build is' : 'builds are'} unlinked.{/if} The matchers, in order:
        </p>
        <ul>
          {#each data.matchers as matcher (matcher.id)}
            <li><code>{matcher.id}</code>: {matcher.description}</li>
          {/each}
        </ul>
        {#if canLink}<p class="muted">A build that no matcher finds can be linked to a run by hand.</p>{/if}
      </details>
    {/if}
  {/if}
</div>

{#if linkTarget && data?.repository}
  <BuildsPanelLink
    {api}
    {workspaceId}
    appId={app.id}
    repository={data.repository}
    build={linkTarget}
    onclose={() => (linkTarget = null)}
    onlinked={linked}
  />
{/if}

<style>
  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .line {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .actions {
    text-align: right;
  }

  .buttons {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .expanded > td {
    background: var(--surface-sunken);
  }

  .how {
    font-size: var(--text-sm);
  }

  .how summary {
    cursor: pointer;
    font-weight: var(--weight-medium);
  }
</style>
