<!--
  AlertRuleRow: one alert type's workspace rule, as a small form: on or off, the channels it uses by default (the webhook channel
  sends the alert.raised event to the workspace's webhooks), the thresholds the type has, and the most alerts per hour before repeats
  are collapsed. "Back to the built-in rule" removes the workspace's change. Props: api, workspaceId, entry, onsaved.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type AlertChannel,
    type CatalogEntry,
    allChannels,
    channelLabel,
    ruleBody,
    severityLabel,
    severityTone,
  } from '../../lib/alerts/alerts.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';

  let { api, workspaceId, entry, onsaved }: { api: Api; workspaceId: string; entry: CatalogEntry; onsaved: () => void } = $props();

  let enabled = $state(true);
  let channels = $state<AlertChannel[]>([]);
  let maxPerHour = $state(10);
  let params = $state<Record<string, number>>({});
  let busy = $state<'' | 'save' | 'reset'>('');
  let error = $state('');
  let saved = $state(false);

  $effect(() => {
    const r = entry.rule;
    enabled = r.enabled;
    channels = r.channels.slice();
    maxPerHour = r.maxPerHour;
    params = { ...r.params };
  });

  const toggle = (c: AlertChannel, on: boolean) => {
    channels = allChannels.filter((x) => (x === c ? on : channels.indexOf(x) >= 0));
  };

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = 'save';
    error = '';
    saved = false;
    try {
      await api.setAlertRule(workspaceId, entry.id, ruleBody({ enabled, channels, maxPerHour, params }));
      saved = true;
      onsaved();
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('workspace:alerts.rule.saveFailed');
    } finally {
      busy = '';
    }
  }

  async function reset() {
    busy = 'reset';
    error = '';
    saved = false;
    try {
      await api.resetAlertRule(workspaceId, entry.id);
      onsaved();
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('workspace:alerts.rule.resetFailed');
    } finally {
      busy = '';
    }
  }
</script>

<form class="rule stack tight" onsubmit={save} aria-label={t('workspace:alerts.rule.formLabel', { label: entry.label })}>
  <div class="head">
    <strong>{entry.label}</strong>
    <Badge tone={severityTone[entry.severity]}>{severityLabel(entry.severity)}</Badge>
    <Badge tone="neutral">{entry.scope === 'app' ? t('workspace:alerts.rule.perApp') : t('workspace:alerts.rule.workspace')}</Badge>
    {#if entry.rule.custom}<Badge tone="accent">{t('workspace:alerts.rule.changed')}</Badge>{/if}
  </div>
  <p class="hint">{t('workspace:alerts.rule.hint', { description: entry.description, audience: entry.audience, count: entry.dedupeWindowHours })}</p>

  <label class="check">
    <input type="checkbox" bind:checked={enabled} />
    {t('workspace:alerts.rule.raise')}
  </label>

  <fieldset disabled={!enabled}>
    <legend>{t('workspace:alerts.rule.defaultChannels')}</legend>
    <div class="row wrap">
      {#each allChannels as c (c)}
        {#if entry.allowedChannels.indexOf(c) >= 0}
          <label class="check">
            <input type="checkbox" checked={channels.indexOf(c) >= 0} onchange={(e) => toggle(c, e.currentTarget.checked)} />
            {channelLabel(c)}
          </label>
        {/if}
      {/each}
    </div>
  </fieldset>

  <div class="row wrap">
    {#each entry.params as p (p.key)}
      <div>
        <label for="p-{entry.id}-{p.key}">{p.unit ? t('workspace:alerts.rule.paramWithUnit', { label: p.label, unit: p.unit }) : p.label}</label>
        <input id="p-{entry.id}-{p.key}" type="number" min={p.min} max={p.max} step="1" bind:value={params[p.key]} disabled={!enabled} />
      </div>
    {/each}
    <div>
      <label for="m-{entry.id}">{t('workspace:alerts.rule.mostPerHour')}</label>
      <input id="m-{entry.id}" type="number" min="1" max="1000" step="1" bind:value={maxPerHour} disabled={!enabled} />
    </div>
  </div>

  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="row">
    <Button type="submit" size="sm" variant="primary" loading={busy === 'save'}>{t('workspace:alerts.rule.save')}</Button>
    {#if entry.rule.custom}
      <Button size="sm" variant="ghost" loading={busy === 'reset'} onclick={reset}>{t('workspace:alerts.rule.reset')}</Button>
    {/if}
    {#if saved}<span class="muted" role="status">{t('workspace:alerts.rule.saved')}</span>{/if}
  </div>
</form>

<style>
  .rule {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .hint {
    margin: 0;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
  }
  legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-weight: var(--weight-medium);
  }
  input[type='number'] {
    width: 7rem;
  }
</style>
