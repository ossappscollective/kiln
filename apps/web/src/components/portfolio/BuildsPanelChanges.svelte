<!--
  BuildsPanelChanges: what changed in a build since the build before it: the commits between the
  two linked commits, newest first, read from GitHub's compare API when it opens. Reading GitHub
  needs the right of a scan, so the parent only mounts this for members and admins.
  Props: api, workspaceId, appId, build (platform and build number).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { changesHeadline } from '../../lib/ci/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import type { BuildChanges } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    appId,
    build,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    build: { platform: string; buildNumber: string };
  } = $props();

  let changes = $state<BuildChanges | null>(null);
  let problem = $state<{ message: string; code: string } | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    problem = null;
    try {
      changes = await api.buildChanges(workspaceId, appId, build);
    } catch (e) {
      changes = null;
      problem =
        e instanceof ApiError
          ? { message: e.message, code: e.code }
          : { message: 'Could not read what changed.', code: 'error' };
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    untrack(() => void load());
  });
</script>

<div class="changes" aria-busy={loading}>
  {#if loading}
    <div class="stack" role="status" aria-label="Reading the commits from GitHub">
      <Skeleton width="55%" height="14px" />
      <Skeleton width="70%" height="14px" />
      <Skeleton width="40%" height="14px" />
    </div>
  {:else if problem}
    {#if problem.code === 'no_base_build' || problem.code === 'build_not_linked'}
      <p class="muted">{problem.message}</p>
    {:else}
      <div class="stack">
        <Alert tone="error" title="Could not read what changed">{problem.message}</Alert>
        <div><Button size="sm" icon="refresh" onclick={load}>Try again</Button></div>
      </div>
    {/if}
  {:else if changes}
    <div class="stack">
      <p class="headline">
        {changesHeadline(changes)}
        <span class="muted text-sm">
          Compared <code>{changes.base.shortSha}</code> (build {changes.base.buildNumber}, {changes.base.version}) with
          <code>{changes.head.shortSha}</code> (build {changes.head.buildNumber}, {changes.head.version}).
        </span>
      </p>
      {#if changes.commits.length > 0}
        <ul class="commits">
          {#each changes.commits as commit (commit.sha)}
            <li>
              {#if commit.url}
                <a href={commit.url} target="_blank" rel="noopener noreferrer"
                  ><code>{commit.shortSha}</code><span class="visually-hidden"> (opens in a new tab)</span></a
                >
              {:else}
                <code>{commit.shortSha}</code>
              {/if}
              <span class="title">{commit.title}</span>
              <span class="muted text-sm">
                {#if commit.author}{commit.author}{/if}
                {#if commit.date !== null}
                  <time datetime={new Date(commit.date).toISOString()} title={fullTime(commit.date)}>{timeAgo(commit.date)}</time>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if changes.truncated}
        <Alert tone="info">
          GitHub reports {changes.totalCommits} commits; only the newest {changes.commits.length} are listed.
        </Alert>
      {/if}
      {#if changes.url}
        <p class="text-sm">
          <a href={changes.url} target="_blank" rel="noopener noreferrer"
            >Open the comparison on GitHub <Icon name="external-link" size={14} /><span class="visually-hidden"> (opens in a new tab)</span></a
          >
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .changes {
    padding: var(--space-3) 0;
  }

  .headline {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-weight: var(--weight-medium);
  }

  .commits {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .commits li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }

  .title {
    overflow-wrap: anywhere;
  }
</style>
