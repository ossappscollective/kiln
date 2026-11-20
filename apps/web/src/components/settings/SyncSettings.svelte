<!--
  SyncSettings: the scheduled refresh of the stores (docs/api/settings.md, docs/adr/0030-workspace-sync-setting.md).
  Props: form (bindable), editable, errors, writable (the keys the caller may write), sync (what the server says: its own interval,
  whether a refresh runs, when the last scheduled one ran). The refresh only reads the stores. It is what lets alerts tell you when a
  release goes into review, is approved, rejected or halted. Google Play reports no review state, so Android alerts say what Play reports.
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, type SyncStatus, canEdit, lastRefreshText, syncIntervalLabel, syncIntervalOptions, syncOffText } from '../../lib/settings.ts';
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

<Card title="Store refresh" collapseKey="store-refresh" description="Reads your apps from the stores on a schedule, so alerts can tell you what changed.">
  {#if sync && sync.off === 'server_off'}<Alert tone="warn">{off}</Alert>{/if}
  <div class="field">
    <label class="check" for="{uid}-enabled">
      <input id="{uid}-enabled" type="checkbox" bind:checked={form.syncEnabled} disabled={!can(KEYS.syncEnabled)} aria-describedby="{uid}-enabled-hint" />
      Refresh my apps from the stores on a schedule
    </label>
    <p class="hint" id="{uid}-enabled-hint">On by default. It only reads the stores; nothing is changed there. It is what lets alerts tell you when a release is approved, rejected or halted.</p>
  </div>
  <div class="field">
    <label for="{uid}-every">How often</label>
    <select id="{uid}-every" bind:value={form.syncIntervalMinutes} disabled={!can(KEYS.syncIntervalMinutes) || !form.syncEnabled} aria-describedby="{uid}-every-hint" aria-invalid={errors.syncIntervalMinutes ? 'true' : undefined}>
      {#each options as option (option.value)}
        <option value={String(option.value)}>Every {option.value === 1440 ? 'day' : syncIntervalLabel(option.value).toLowerCase()}</option>
      {/each}
    </select>
    <p class="hint" id="{uid}-every-hint">A shorter time notices a change sooner and asks the stores more often.</p>
    {#if errors.syncIntervalMinutes}<p class="field-error" role="alert">{errors.syncIntervalMinutes}</p>{/if}
  </div>
  {#if sync}
    <p class="hint">{lastRun}</p>
    {#if off && sync.off !== 'server_off'}<p class="hint">{off}</p>{/if}
  {/if}
  <Disclosure summary="How the refresh works">
    <p class="hint">
      Each app is read again when this long has passed since its last read, spread out a little so the reads do not all start together. Google Play
      reports no review state, so for Android apps alerts cover what Play does report: the track, the rollout, and a halted rollout.
    </p>
  </Disclosure>
</Card>
