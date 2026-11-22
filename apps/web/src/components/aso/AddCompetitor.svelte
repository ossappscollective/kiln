<!--
  AddCompetitor: follow an app of the store by its address or id: the numeric App Store id, `id123`, an
  apps.apple.com link, an Android package name or a play.google.com link. Following reads the public store once
  (so the name is real and the first snapshot exists) and is rate limited per workspace. Google Play is not offered
  while its reading is switched off.
  Props: api, workspaceId, members, config, ondone (called with the name that was added), oncancel.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { type AsoConfig, asoErrorMessage } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
import { needsStoreAppId, supports } from '@kiln/core';

  let {
    api,
    workspaceId,
    members,
    config,
    ondone,
    oncancel,
  }: { api: Api; workspaceId: string; members: AppSummary[]; config: AsoConfig | null; ondone: () => void; oncancel: () => void } = $props();

  const uid = $props.id();
  const playOff = $derived(config !== null && !config.play.enabled);
  const choices = $derived(members.filter((m) => !supports(m.platform, 'unofficialSearch') || !playOff));

  let appId = $state('');
  let externalId = $state('');
  let country = $state('us');
  let busy = $state(false);
  let error = $state('');
  let tried = $state(false);

  const target = $derived(choices.find((m) => m.id === appId) ?? choices[0]);
  const hint = $derived(target !== undefined && !needsStoreAppId(target.platform) ? t('aso:follow.hintPackage') : t('aso:follow.hintAppStore'));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !target) return;
    tried = true;
    error = '';
    if (externalId.trim() === '') return;
    busy = true;
    try {
      const out = await api.addAsoCompetitor(workspaceId, target.id, { externalId: externalId.trim(), ...(country.trim() ? { country: country.trim().toLowerCase() } : {}) });
      toast.success(t('aso:follow.toast', { name: out.competitor.name }));
      ondone();
    } catch (e) {
      error = asoErrorMessage(e, t('aso:err.followApp'));
    } finally {
      busy = false;
    }
  }
</script>

<form class="card stack" onsubmit={submit} novalidate>
  {#if choices.length === 0}
    <Alert tone="info">{t('aso:follow.playOff')}</Alert>
    <div><Button variant="ghost" onclick={oncancel}>{t('common:action.close')}</Button></div>
  {:else}
    <div class="row fields">
      {#if choices.length > 1}
        <div class="field">
          <label for="{uid}-store">{t('aso:label.store')}</label>
          <select id="{uid}-store" bind:value={appId}>
            {#each choices as m (m.id)}<option value={m.id}>{platformLabel(m.platform)}</option>{/each}
          </select>
        </div>
      {/if}
      <div class="field grow">
        <label for="{uid}-id">
          {t('aso:follow.linkOrId')}
          <InfoTip label={t('aso:follow.whatLabel')} text={t('aso:follow.whatText')} />
        </label>
        <input id="{uid}-id" bind:value={externalId} autocomplete="off" aria-invalid={tried && externalId.trim() === ''} aria-describedby="{uid}-hint" />
        <p class="hint" id="{uid}-hint">{hint}</p>
      </div>
      <div class="field">
        <label for="{uid}-country">{t('aso:label.country')}</label>
        <input id="{uid}-country" class="country" maxlength="2" bind:value={country} autocomplete="off" />
      </div>
    </div>
    {#if tried && externalId.trim() === ''}<p class="field-error">{t('aso:follow.required')}</p>{/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="row">
      <Button type="submit" variant="primary" loading={busy}>{t('aso:action.follow')}</Button>
      <Button variant="ghost" onclick={oncancel}>{t('common:action.cancel')}</Button>
    </div>
  {/if}
</form>

<style>
  .fields {
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .grow {
    flex: 1;
    min-width: 16rem;
  }

  .country {
    width: 5rem;
    text-transform: lowercase;
  }
</style>
