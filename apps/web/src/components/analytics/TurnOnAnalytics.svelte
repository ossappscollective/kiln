<!--
  TurnOnAnalytics: the opt-in. A button that opens a dialog saying exactly what turning analytics on does, and a confirmation.
  It writes one workspace setting (`analytics.enabled`, needs `analytics.manage`: owners and admins). Nothing is requested from a
  store by turning it on; the first read happens at the next scheduled or manual sync. It can be turned off again in Settings.
  Props: api, workspaceId, onchanged (called after the setting was saved), label = 'Turn on analytics', variant = 'primary'.
  Readable pass (docs/design/readability.md): one sentence and one line that it only reads; the points sit behind "How it works".
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
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
    label = 'Turn on analytics',
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
      toast.success('Analytics is on. The first numbers arrive with the next sync.');
      onchanged();
    } catch (e) {
      problem = analyticsErrorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<Button {variant} icon="activity" onclick={() => { problem = ''; open = true; }}>{label}</Button>

<Modal bind:open size="md" title="Turn on analytics for this workspace?" dismissible={!busy}>
  <div class="stack readable-card">
    <p>Analytics reads daily numbers for your apps from the stores and keeps them on this server.</p>
    <p class="warn-line">It only reads: the one write, an Apple report request, is a separate step with its own confirmation.</p>
    <Disclosure summary="How it works">
      <ul class="points">
        <li>For iOS and macOS apps: App Store analytics reports, and Sales and Trends (units and proceeds, also by product) when a vendor number is set.</li>
        <li>For Android apps: Android vitals and the monthly Play Console reports, when the bucket id is set. Estimated sales (what buyers paid, not your proceeds), monthly earnings (net of Google's fees and taxes) and subscription statistics also need the Play Console permission View financial data.</li>
        <li>Apple deletes its daily reports after 35 days, so the numbers this server reads are the only copy. They are not deleted.</li>
        <li>You can turn it off again under Settings. Numbers already stored stay readable.</li>
      </ul>
    </Disclosure>
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>
  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={turnOn}>Turn on analytics</Button>
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
