<!--
  PhoneLinkDialog: hands one Android build to a phone. It asks the server for a link that works without signing in, once, for ten
  minutes, and draws it as a QR code to scan with the phone's camera. The link never contains the GitHub address or credential.
  A page opened as localhost cannot be reached by a phone: the dialog says so and still shows the address to copy.
  Props: api, workspaceId, appId, row (a CI row), onclose.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type BuildRow, type DownloadLink, phoneCannotReach, phoneUrl, secondsLeft } from '../../lib/builds.ts';
  import { qrMatrix, qrPath } from '../../lib/qr.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Modal from '../ui/Modal.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import T from '../ui/T.svelte';

  let { api, workspaceId, appId, row, onclose }: { api: Api; workspaceId: string; appId: string; row: BuildRow; onclose: () => void } = $props();

  let open = $state(true);
  let link = $state<DownloadLink | null>(null);
  let problem = $state('');
  let busy = $state(false);
  let now = $state(Date.now());

  const url = $derived(link ? phoneUrl(location.origin, link.path) : '');
  const code = $derived.by(() => {
    if (!url) return null;
    const matrix = qrMatrix(url);
    return matrix ? qrPath(matrix) : null;
  });
  const left = $derived(link ? secondsLeft(link.expiresAt, now) : 0);
  const expired = $derived(link !== null && left === 0);
  const unreachable = $derived(phoneCannotReach(location.origin));

  async function make() {
    busy = true;
    problem = '';
    try {
      link = await api.createBuildLink(workspaceId, appId, row.artifact?.id ?? '');
      now = Date.now();
    } catch (e) {
      link = null;
      problem = e instanceof ApiError ? e.message : t('builds:phone.makeFailed');
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void make();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
</script>

<Modal bind:open title={t('builds:phone.title')} description={row.title} size="sm" {onclose}>
  <div class="stack">
    {#if busy && !link}
      <div class="center" role="status" aria-label={t('builds:phone.making')}><Spinner /></div>
    {:else if problem}
      <Alert tone="error" title={t('builds:phone.makeFailedTitle')}>{problem}</Alert>
    {:else if link}
      {#if unreachable}
        <Alert tone="warn" title={t('builds:phone.unreachableTitle')}>
          <T key="builds:phone.unreachable" params={{ host: location.host }} />
        </Alert>
      {/if}
      {#if code}
        <div class="qr" class:old={expired}>
          <svg viewBox="0 0 {code.size} {code.size}" role="img" aria-label={t('builds:phone.qrLabel')} shape-rendering="crispEdges">
            <rect width={code.size} height={code.size} fill="#fff" />
            <path d={code.d} fill="#000" />
          </svg>
        </div>
      {:else}
        <Alert tone="warn" title={t('builds:phone.tooLongTitle')}>{t('builds:phone.tooLong')}</Alert>
      {/if}
      <p class="muted text-sm" aria-live="polite">
        {#if expired}{t('builds:phone.expired')}{:else}{t('builds:phone.scan', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}{/if}
      </p>
      <ol class="steps text-sm">
        <li>{t('builds:phone.step1')}</li>
        <li>{t('builds:phone.step2')}</li>
      </ol>
      <div class="row"><code class="url">{url}</code><CopyButton value={url} label={t('builds:phone.copyLink')} iconOnly size="sm" /></div>
    {/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('common:action.close')}</Button>
    {#if expired || problem}<Button variant="primary" icon="refresh" loading={busy} onclick={() => void make()}>{t('builds:phone.makeNew')}</Button>{/if}
  {/snippet}
</Modal>

<style>
  .qr {
    display: flex;
    justify-content: center;
  }

  .qr svg {
    width: min(16rem, 100%);
    height: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .qr.old {
    opacity: 0.25;
  }

  .center {
    display: flex;
    justify-content: center;
    padding: var(--space-6);
  }

  .steps {
    margin: 0;
    padding-left: var(--space-5);
  }

  .url {
    overflow-wrap: anywhere;
    font-size: var(--text-xs);
  }
</style>
