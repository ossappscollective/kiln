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
      problem = e instanceof ApiError ? e.message : 'Could not make the link.';
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

<Modal bind:open title="Install on a phone" description={row.title} size="sm" {onclose}>
  <div class="stack">
    {#if busy && !link}
      <div class="center" role="status" aria-label="Making the link"><Spinner /></div>
    {:else if problem}
      <Alert tone="error" title="Could not make the link">{problem}</Alert>
    {:else if link}
      {#if unreachable}
        <Alert tone="warn" title="A phone cannot open this address">
          This page is open at <code>{location.host}</code>, which only this computer can reach. Open Mobile Release Manager at the computer's network address or a public address, then make the code again.
        </Alert>
      {/if}
      {#if code}
        <div class="qr" class:old={expired}>
          <svg viewBox="0 0 {code.size} {code.size}" role="img" aria-label="QR code with the download link" shape-rendering="crispEdges">
            <rect width={code.size} height={code.size} fill="#fff" />
            <path d={code.d} fill="#000" />
          </svg>
        </div>
      {:else}
        <Alert tone="warn" title="The link is too long for a code">Copy the address below and open it on the phone.</Alert>
      {/if}
      <p class="muted text-sm" aria-live="polite">
        {#if expired}This link has expired. Make a new one.{:else}Scan with the phone's camera. The link works once and for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.{/if}
      </p>
      <ol class="steps text-sm">
        <li>Scan the code. The phone downloads a zip.</li>
        <li>Unzip it, open the APK and allow "Install unknown apps" once when asked.</li>
      </ol>
      <div class="row"><code class="url">{url}</code><CopyButton value={url} label="Copy link" iconOnly size="sm" /></div>
    {/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Close</Button>
    {#if expired || problem}<Button variant="primary" icon="refresh" loading={busy} onclick={() => void make()}>Make a new link</Button>{/if}
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
