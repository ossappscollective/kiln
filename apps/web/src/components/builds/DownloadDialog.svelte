<!--
  DownloadDialog: confirms the download of one CI artifact. The file comes through this server (the GitHub credential never
  reaches the browser) and is a zip. The button is a plain link to the server's download address, so the browser saves it as a file.
  Props: workspaceId, appId, row (a CI row), onclose.
-->
<script lang="ts">
  import { type BuildRow, downloadPath, humanSize, installGuide } from '../../lib/builds.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';

  let { workspaceId, appId, row, onclose }: { workspaceId: string; appId: string; row: BuildRow; onclose: () => void } = $props();

  let open = $state(true);
  const guide = $derived(installGuide(row));
  const href = $derived(downloadPath(workspaceId, appId, row.artifact?.id ?? ''));
</script>

<Modal bind:open title={t('builds:download.title', { name: row.title })} description={t('builds:download.description')} size="sm" {onclose}>
  <div class="stack">
    <p>
      {#if row.sizeBytes !== null}{t('builds:download.sizeIntro', { size: humanSize(row.sizeBytes) })}{/if}
      {t('builds:download.recorded')}
    </p>
    <p class="muted text-sm">{guide.steps[0]}</p>
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <a class="btn primary" {href} download onclick={() => setTimeout(() => (open = false), 0)}><Icon name="download" size={16} />{t('builds:download.button')}</a>
  {/snippet}
</Modal>
