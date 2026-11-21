<!--
  AnalyticsOff: what a person sees for an app while analytics is off for the workspace (the default) and nothing is stored:
  one card that says what turning it on will do, and the way to do it. Analytics is opt-in; nothing is requested from a store
  before it is on. Turning it on needs `analytics.manage` (owners and admins); everyone else is told who can. For an Apple app a
  report file can be imported without turning anything on, because that contacts no store.
  Props: api, workspaceId, app (id and platform), role, onchanged.
  Readable pass (docs/design/readability.md): one sentence, the turn-on button (the one primary), notes at 15px.
-->
<script lang="ts">
  import { can, platformSupports, type Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import ImportReportDialog from './ImportReportDialog.svelte';
  import TurnOnAnalytics from './TurnOnAnalytics.svelte';

  let { api, workspaceId, app, role, onchanged }: { api: Api; workspaceId: string; app: { id: string; platform: string }; role: Role; onchanged: () => void } = $props();

  const canManage = $derived(can(role, 'analytics.manage'));
  const apple = $derived(platformSupports(app.platform, 'appleAnalyticsReports'));
  let importOpen = $state(false);
</script>

<section class="card off" aria-label={t('analytics:off.title')}>
  <div class="stack">
    <h3><Icon name="activity" size={16} /> {t('analytics:off.title')}</h3>
    <div class="lead-line">
      {t('analytics:off.lead')}
      <InfoTip label={t('analytics:off.tipLabel')} buttonText={t('analytics:off.tipButton')} align="start" width="26rem">
        <p>
          {#if apple}
            {t('analytics:off.tipApple')}
          {:else}
            {t('analytics:off.tipGoogle')}
          {/if}
        </p>
        <p>{t('analytics:off.tipKeeps')}</p>
      </InfoTip>
    </div>
    <div class="row">
      {#if canManage}
        <TurnOnAnalytics {api} {workspaceId} {onchanged} />
        {#if apple}<Button icon="upload" onclick={() => (importOpen = true)}>{t('analytics:off.importInstead')}</Button>{/if}
      {:else}
        <p class="muted note">{t('analytics:off.managerOnly')}</p>
      {/if}
      <Button variant="ghost" href="#/settings?view=analytics">{t('analytics:off.openSettings')}</Button>
    </div>
    {#if canManage && apple}<p class="muted note">{t('analytics:off.importNote')}</p>{/if}
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
