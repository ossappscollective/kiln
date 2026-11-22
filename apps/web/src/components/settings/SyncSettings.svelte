<!--
  SyncSettings: the scheduled refresh of the stores (docs/api/settings.md, docs/adr/0030-workspace-sync-setting.md).
  Props: form (bindable), editable, errors, writable (the keys the caller may write), sync (what the server says: its own interval,
  whether a refresh runs, when the last scheduled one ran). The refresh only reads the stores. It is what lets alerts tell you when a
  release goes into review, is approved, rejected or halted. Google Play reports no review state, so Android alerts say what Play reports.
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, type SyncStatus, canEdit, lastRefreshText, syncIntervalEveryLabel, syncIntervalOptions, syncOffText } from '../../lib/settings.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Card from '../ui/Card.svelte';
  import Disclosure from '../ui/Disclosure.svelte';

  let { form = $bindable(), editable, errors, writable, sync }: { form: SettingsForm; editable: boolean; errors: FormErrors; writable: readonly string[]; sync?: SyncStatus | undefined } = $props();

  const uid = $props.id();
  const can = (key: string): boolean => editable && canEdit(writable, key);
  const options = $derived(syncIntervalOptions(Number(form.syncIntervalMinutes)));
  const lastRun = $derived(lastRefreshText(sync));
  const off = $derived(syncOffText(sync));
</script>

<Card title={t('settings:sync.title')} collapseKey="store-refresh" description={t('settings:sync.description')}>
  {#if sync && sync.off === 'server_off'}<Alert tone="warn">{off}</Alert>{/if}
  <div class="field">
    <label class="check" for="{uid}-enabled">
      <input id="{uid}-enabled" type="checkbox" bind:checked={form.syncEnabled} disabled={!can(KEYS.syncEnabled)} aria-describedby="{uid}-enabled-hint" />
      {t('settings:sync.enabledLabel')}
    </label>
    <p class="hint" id="{uid}-enabled-hint">{t('settings:sync.enabledHint')}</p>
  </div>
  <div class="field">
    <label for="{uid}-every">{t('settings:sync.everyLabel')}</label>
    <select id="{uid}-every" bind:value={form.syncIntervalMinutes} disabled={!can(KEYS.syncIntervalMinutes) || !form.syncEnabled} aria-describedby="{uid}-every-hint" aria-invalid={errors.syncIntervalMinutes ? 'true' : undefined}>
      {#each options as option (option.value)}
        <option value={String(option.value)}>{syncIntervalEveryLabel(option.value)}</option>
      {/each}
    </select>
    <p class="hint" id="{uid}-every-hint">{t('settings:sync.everyHint')}</p>
    {#if errors.syncIntervalMinutes}<p class="field-error" role="alert">{errors.syncIntervalMinutes}</p>{/if}
  </div>
  {#if sync}
    <p class="hint">{lastRun}</p>
    {#if off && sync.off !== 'server_off'}<p class="hint">{off}</p>{/if}
  {/if}
  <Disclosure summary={t('settings:sync.howSummary')}>
    <p class="hint">
      {t('settings:sync.howText')}
    </p>
  </Disclosure>
</Card>
