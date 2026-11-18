<!--
  RepositorySection: the repository each record of the app is linked to (name, branch, project type, local
  clone), the listing targets saved for it, and where to manage it. Reads only.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { links, notAvailable } from '../../../lib/app-settings.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import type { AppSummary, RepositorySummary, SavedListingTarget } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const canRead = $derived(can(role, 'repositories.read'));

  let repositories = $state<RepositorySummary[]>([]);
  let targets = $state<Record<string, SavedListingTarget[] | undefined>>({});
  let problem = $state('');

  const key = $derived(`${workspaceId}/${members.map((m) => m.repositoryId ?? '-').join(',')}`);

  $effect(() => {
    const id = workspaceId;
    const repoIds = members.map((m) => m.repositoryId).filter((r): r is string => r !== null);
    void key;
    untrack(() => {
      repositories = [];
      targets = {};
      problem = '';
    });
    if (!canRead || repoIds.length === 0) return;
    let current = true;
    api
      .repositories(id)
      .then((r) => {
        if (current) repositories = r.repositories;
      })
      .catch(() => {
        if (current) problem = 'Could not read the repositories. Reload the page to try again.';
      });
    for (const repoId of repoIds.filter((r, i) => repoIds.indexOf(r) === i)) {
      api
        .listingTargets(id, repoId)
        .then((r) => {
          if (current) targets = { ...targets, [repoId]: r.targets };
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  });

  const repoOf = (app: AppSummary) => repositories.filter((r) => r.id === app.repositoryId)[0] ?? null;
  const targetsOf = (app: AppSummary) => (targets[app.repositoryId ?? ''] ?? []).filter((t) => t.appId === null || t.appId === app.id);
</script>

<SettingsCard
  title="Repository"
  icon="git-branch"
  description="Where the files of this app live: fastlane metadata, screenshots and the build tags. The store listing and the assets are read from here."
  unavailable={notAvailable.changeRepository}
>
  {#if problem}<Alert tone="warn">{problem}</Alert>{/if}
  <div class="stack">
    {#each members as app (app.id)}
      {@const repo = repoOf(app)}
      <div class="record">
        <div class="row between">
          <PlatformBadge platform={app.platform} tinted />
          {#if app.repositoryId === null}<Badge tone="neutral">Not linked</Badge>{:else}<Badge tone="ok">Linked</Badge>{/if}
        </div>
        {#if app.repositoryId === null}
          <p class="muted note">This {platformLabel(app.platform)} record has no repository. Without one, the store listing cannot be compared with files and the assets tab has nothing to read.</p>
        {:else if !canRead}
          <p class="muted note">Seeing the repository needs a role that can read repositories.</p>
        {:else if repo}
          <dl class="facts">
            <div>
              <dt>Repository</dt>
              <dd>{repo.name}</dd>
            </div>
            <div>
              <dt>Default branch</dt>
              <dd><code>{repo.defaultBranch}</code></dd>
            </div>
            <div>
              <dt>Project type</dt>
              <dd>{repo.projectKind ?? 'Not scanned yet'}</dd>
            </div>
            <div>
              <dt>Connection</dt>
              <dd>{repo.localOnly ? 'Local folder only' : repo.local ? 'GitHub with a local clone' : 'GitHub'}</dd>
            </div>
          </dl>
          <div>
            <p class="label">Listing targets</p>
            {#if targets[app.repositoryId ?? ''] === undefined}
              <p class="muted note">Reading…</p>
            {:else if targetsOf(app).length === 0}
              <p class="muted note">None saved. The folders are detected from the repository.</p>
            {:else}
              <ul class="plain">
                {#each targetsOf(app) as t (t.id)}
                  <li>{t.name}{t.appStoreRoot ? ` · App Store: ${t.appStoreRoot}` : ''}{t.googlePlayRoot ? ` · Google Play: ${t.googlePlayRoot}` : ''}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else if !problem}
          <p class="muted note">Reading the repository…</p>
        {/if}
      </div>
    {/each}
  </div>
  {#if canRead}<div><Button size="sm" variant="ghost" href={links.repositories}>Manage repositories</Button></div>{/if}
</SettingsCard>

<style>
  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .record + .record {
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }

  .facts dt,
  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
