<!--
  CloneCard: how much disk the server's clone of this repository takes, when it was last used, and a
  "Free space" button for admin and owner. The clone is a cache of what GitHub (or an attached local
  folder) holds: freeing it costs a fetch on the next read, and the server removes idle or surplus
  clones by itself (MRM_CLONE_IDLE_DAYS, MRM_CLONE_MAX_BYTES).
  Props: api, workspaceId, repository, role.
  Shown to everyone who can see the repository; only repositories.write may free the space.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type RepositoryClone, cloneSummary, limitsSentence, purgeMessage } from '../../lib/clone-upkeep.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
  } = $props();

  let info = $state<RepositoryClone | null>(null);
  let error = $state('');
  let freeing = $state(false);

  const mayFree = $derived(can(role, 'repositories.write'));

  async function load() {
    error = '';
    try {
      info = await api.repositoryClone(workspaceId, repository.id);
    } catch (e) {
      info = null;
      error = e instanceof ApiError ? e.message : 'Could not look at the clone.';
    }
  }

  $effect(() => {
    void repository.id;
    void workspaceId;
    void load();
  });

  async function free() {
    if (freeing) return;
    freeing = true;
    try {
      const result = await api.purgeRepositoryClone(workspaceId, repository.id);
      toast.success(purgeMessage(result));
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The clone could not be removed. Try again.');
    } finally {
      freeing = false;
    }
  }
</script>

{#if error}
  <Alert tone="warn">{error}</Alert>
{:else if info && (info.enabled || info.clone)}
  <Card title="Clone on the server" description="A cache of the repository, so scans and listings do not download it every time.">
    {#snippet actions()}
      {#if mayFree && info?.clone}
        <Button size="sm" icon="trash" loading={freeing} onclick={free}>{freeing ? 'Freeing…' : 'Free space'}</Button>
      {/if}
    {/snippet}
    <div class="stack tight">
      <p class="line">{cloneSummary(info)}</p>
      {#if info.clone}
        <p class="muted small">
          Last used
          <time datetime={new Date(info.clone.lastUsedAt).toISOString()} title={fullTime(info.clone.lastUsedAt)}>{timeAgo(info.clone.lastUsedAt)}</time>.
          {limitsSentence(info.limits)}
        </p>
      {/if}
    </div>
  </Card>
{/if}

<style>
  .line {
    margin: 0;
  }
</style>
