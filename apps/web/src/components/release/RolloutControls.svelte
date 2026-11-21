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
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type RolloutConfig, controlsAvailability } from '../../lib/store-rollout.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
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

{#if availability.state === 'off'}
  <!-- Switched off: one slim line; the explanation is a click away and says exactly what it said before. -->
  <section class="slim" aria-labelledby="{uid}-title">
    <Disclosure stateKey="releases.rollout-controls-off">
      {#snippet summary()}
        <span id="{uid}-title" class="slimtitle"><Icon name="rocket" size={14} /> Rollout controls</span>
        <Badge tone="neutral" icon="lock">Switched off</Badge>
      {/snippet}
      <div class="stack">
        <Alert tone="info" title="Rollout changes are off">{availability.message}</Alert>
        <p class="muted note">
          The rollout plan in each release row is planning data and does not touch a store; it works without this switch.
        </p>
      </div>
    </Disclosure>
  </section>
{:else if availability.state !== 'hidden'}
  <section class="controls" aria-labelledby="{uid}-title">
    <div class="head">
      <div class="titles">
        <h3 id="{uid}-title"><Icon name="rocket" size={18} /> Rollout controls</h3>
        <p class="muted lead">Raise, pause, halt or finish a rollout in the store.</p>
      </div>
      {#if availability.state === 'ready'}
        <Badge tone="warn" icon="lock">Changes the live store</Badge>
      {/if}
    </div>

    {#if availability.state === 'loading'}
      <Skeleton />
    {:else if availability.state === 'unknown'}
      <Alert tone="warn">{availability.message}</Alert>
    {:else if config}
      <p class="muted note">
        Every change is previewed first, needs your confirmation and is recorded in the audit log.
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

  .titles {
    display: grid;
    gap: var(--space-1);
  }

  .lead {
    margin: 0;
    font-size: var(--text-md);
  }

  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-xl);
  }

  .slim {
    padding: var(--space-1) var(--space-2);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-lg);
  }

  .slimtitle {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-weight: var(--weight-semibold);
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
