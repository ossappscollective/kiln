<!--
  AnalyticsOff: what a person sees for an app while analytics is off for the workspace (the default) and nothing is stored:
  one card that says what turning it on will do, and the way to do it. Analytics is opt-in; nothing is requested from a store
  before it is on. Turning it on needs `analytics.manage` (owners and admins); everyone else is told who can. For an Apple app a
  report file can be imported without turning anything on, because that contacts no store.
  Props: api, workspaceId, app (id and platform), role, onchanged.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import TurnOnAnalytics from './TurnOnAnalytics.svelte';

  let { api, workspaceId, app, role, onchanged }: { api: Api; workspaceId: string; app: { id: string; platform: string }; role: Role; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const apple = $derived(app.platform !== 'android');
  let importOpen = $state(false);
</script>

<section class="card off" aria-label="Analytics is off">
  <div class="stack">
    <h3><Icon name="activity" size={16} /> Analytics is off</h3>
    <p>
      {#if apple}
        Analytics reads daily numbers for this app from App Store Connect: impressions, product page views, downloads, conversion, crashes and, with a vendor number, units and proceeds.
      {:else}
        Analytics reads daily numbers for this app from Google Play: crash and ANR rate by app version, and, with the bucket id of the Play Console reports, installs and ratings.
      {/if}
      It keeps them on this server and shows where each number comes from, how late it can be and what it leaves out. Nothing is requested from a store until it is turned on.
    </p>
    <div class="row">
      {#if canManage}
        <TurnOnAnalytics {api} {workspaceId} {onchanged} />
        {#if apple}<Button icon="upload" onclick={() => (importOpen = true)}>Import a report file instead</Button>{/if}
      {:else}
        <p class="muted note">An owner or an admin can turn it on. The setting is under Settings, Analytics.</p>
      {/if}
      <Button variant="ghost" href="#/settings">Open Settings</Button>
    </div>
    {#if canManage && apple}<p class="muted note">Importing a report file works without turning analytics on: it reads a file you give it and contacts no store.</p>{/if}
  </div>
</section>

{#if canManage && apple}
  <ImportReportDialog bind:open={importOpen} {api} {workspaceId} appId={app.id} onimported={onchanged} />
{/if}

<style>
  .off {
    max-width: 48rem;
    padding: var(--space-5);
  }

  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  p {
    margin: 0;
  }

  .note {
    font-size: var(--text-sm);
  }
</style>
