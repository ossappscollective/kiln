<!--
  AnalyticsOff: what a person sees for an app while analytics is off for the workspace (the default) and nothing is stored:
  one card that says what turning it on will do, and the way to do it. Analytics is opt-in; nothing is requested from a store
  before it is on. Turning it on needs `analytics.manage` (owners and admins); everyone else is told who can. For an Apple app a
  report file can be imported without turning anything on, because that contacts no store.
  Props: api, workspaceId, app (id and platform), role, onchanged.
  Readable pass (docs/design/readability.md): one sentence, the turn-on button (the one primary), notes at 15px.
-->
<script lang="ts">
  import { can, type Role, supports } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import TurnOnAnalytics from './TurnOnAnalytics.svelte';

  let { api, workspaceId, app, role, onchanged }: { api: Api; workspaceId: string; app: { id: string; platform: string }; role: Role; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const apple = $derived(supports(app.platform, 'appleAnalyticsReports'));
  let importOpen = $state(false);
</script>

<section class="card off" aria-label="Analytics is off">
  <div class="stack">
    <h3><Icon name="activity" size={16} /> Analytics is off</h3>
    <div class="lead-line">
      Turn it on to see this app's daily downloads, conversion and crashes.
      <InfoTip label="What analytics reads" buttonText="What it reads" align="start" width="26rem">
        <p>
          {#if apple}
            Analytics reads daily numbers for this app from App Store Connect: impressions, product page views, downloads, conversion, crashes and, with a vendor number, units and proceeds.
          {:else}
            Analytics reads daily numbers for this app from Google Play: crash and ANR rate by app version, and, with the bucket id of the Play Console reports, installs and ratings.
          {/if}
        </p>
        <p>It keeps them on this server and shows where each number comes from, how late it can be and what it leaves out. Nothing is requested from a store until it is turned on.</p>
      </InfoTip>
    </div>
    <div class="row">
      {#if canManage}
        <TurnOnAnalytics {api} {workspaceId} {onchanged} />
        {#if apple}<Button icon="upload" onclick={() => (importOpen = true)}>Import a report file instead</Button>{/if}
      {:else}
        <p class="muted note">An owner or an admin can turn it on. The setting is under Settings, Analytics.</p>
      {/if}
      <Button variant="ghost" href="#/settings?view=analytics">Open Settings</Button>
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
    font-size: var(--text-xl);
  }

  .lead-line {
    font-size: 1.0625rem;
  }

  p {
    margin: 0;
  }

  .note {
    font-size: 0.9375rem;
    line-height: 1.45;
  }
</style>
