<!--
  TurnOnAnalytics: the opt-in. A button that opens a dialog saying exactly what turning analytics on does, and a confirmation.
  It writes one workspace setting (`analytics.enabled`, needs `analytics.manage`: owners and admins). Nothing is requested from a
  store by turning it on; the first read happens at the next scheduled or manual sync. It can be turned off again in Settings.
  Props: api, workspaceId, onchanged (called after the setting was saved), label = 'Turn on analytics', variant = 'primary'.
  Readable pass (docs/design/readability.md): one sentence and one line that it only reads; the points sit behind "How it works".
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { analyticsErrorText } from '../../lib/analytics/analytics.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import '../readable-card.css';
  import Modal from '../ui/Modal.svelte';

  let {
    api,
    workspaceId,
    onchanged,
    label,
    variant = 'primary',
  }: { api: Api; workspaceId: string; onchanged: () => void; label?: string | undefined; variant?: 'primary' | 'secondary' | undefined } = $props();

  let open = $state(false);
  let busy = $state(false);
  let problem = $state('');

  async function turnOn() {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      await confirmed((grant) => api.updateWorkspaceSettings(workspaceId, { 'analytics.enabled': true }, grant));
      open = false;
      toast.success(t('analytics:turnOn.toast'));
      onchanged();
    } catch (e) {
      problem = analyticsErrorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<Button {variant} icon="activity" onclick={() => { problem = ''; open = true; }}>{label ?? t('analytics:turnOn.button')}</Button>

<Modal bind:open size="md" title={t('analytics:turnOn.title')} dismissible={!busy}>
  <div class="stack readable-card">
    <p>{t('analytics:turnOn.intro')}</p>
    <p class="warn-line">{t('analytics:turnOn.onlyReads')}</p>
    <Disclosure summary={t('analytics:turnOn.how')}>
      <ul class="points">
        <li>{t('analytics:turnOn.pointApple')}</li>
        <li>{t('analytics:turnOn.pointGoogle')}</li>
        <li>{t('analytics:turnOn.pointRetention')}</li>
        <li>{t('analytics:turnOn.pointOff')}</li>
      </ul>
    </Disclosure>
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>
  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="primary" loading={busy} onclick={turnOn}>{t('analytics:turnOn.button')}</Button>
  {/snippet}
</Modal>

<style>
  .points {
    padding-left: var(--space-5);
    margin: 0;
    font-size: 0.9375rem;
  }

  .points li + li {
    margin-top: var(--space-1);
  }
</style>
