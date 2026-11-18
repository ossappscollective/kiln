<!--
  RolloutControls: change the staged rollout of a release IN THE STORE (docs/api/rollout.md): raise the Google
  Play share, halt, resume, release to 100%, pause or resume an Apple phased release, release to all.
  A store write that changes who gets an update, so: only for admin and owner (`releases.rollout`; everyone
  else sees nothing), switched off unless the server sets MRM_STORE_ROLLOUT_ENABLED (then a note says so and
  nothing can be clicked), and every change goes through a preview and a confirmation.
  The rollout PLAN (steps, planned times) is planning data and lives in each release row.
  Props: api, workspaceId, role, members (the app records in scope), releases (by app id).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type RolloutConfig, controlsAvailability } from '../../lib/store-rollout.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import RolloutAppControl from './RolloutAppControl.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    releases,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
  } = $props();

  const uid = $props.id();
  let config = $state<RolloutConfig | null>(null);
  let failed = $state(false);

  const availability = $derived(controlsAvailability(role, config, failed));

  // The config is readable by every member, also while the feature is off, so the screen can explain it.
  $effect(() => {
    const id = workspaceId;
    untrack(() => {
      config = null;
      failed = false;
    });
    let current = true;
    api
      .rolloutConfig(id)
      .then((c) => {
        if (current) config = c;
      })
      .catch(() => {
        if (current) failed = true;
      });
    return () => {
      current = false;
    };
  });
</script>

{#if availability.state !== 'hidden'}
  <section class="controls" aria-labelledby="{uid}-title">
    <div class="head">
      <h3 id="{uid}-title"><Icon name="rocket" size={16} /> Rollout controls</h3>
      {#if availability.state === 'ready'}
        <Badge tone="warn" icon="lock">Changes the live store</Badge>
      {:else if availability.state === 'off'}
        <Badge tone="neutral" icon="lock">Switched off</Badge>
      {/if}
    </div>

    {#if availability.state === 'loading'}
      <Skeleton />
    {:else if availability.state === 'unknown'}
      <Alert tone="warn">{availability.message}</Alert>
    {:else if availability.state === 'off'}
      <Alert tone="info" title="Rollout changes are off">{availability.message}</Alert>
      <p class="muted note">
        The rollout plan in each release row is planning data and does not touch a store; it works without this switch.
      </p>
    {:else if config}
      <p class="muted note">
        Each change is previewed against the live store first, needs your confirmation, and is recorded in the audit log.
        Some changes cannot be undone and ask you to type the version.
      </p>
      <div class="stack">
        {#each members as app (app.id)}
          <RolloutAppControl {api} {workspaceId} {app} releases={releases[app.id] ?? []} {config} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
