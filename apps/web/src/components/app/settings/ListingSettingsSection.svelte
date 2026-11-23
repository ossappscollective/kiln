<!--
  ListingSettingsSection: whether Kiln compares this app's repository with the store (texts) and its repository graphics with the store's.
  Both are OFF by default: many apps keep no fastlane files, and for them "only one side has a value" is noise. With a switch off, the store
  page is still checked on its own (limits, required fields) and its graphics are listed as the store has them. One pair of switches per record
  of the app (iOS and Android are separate apps for the store); a change is saved at once, and nothing is written to a store or a repository.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../../lib/api.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppListingSettings, AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const mayEdit = $derived(can(role, 'apps.write'));
  let values = $state<Record<string, AppListingSettings | undefined>>({});
  let saving = $state('');
  let problem = $state('');

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  $effect(() => {
    void key;
    let current = true;
    untrack(() => {
      values = {};
    });
    for (const app of members) {
      api
        .appListingSettings(workspaceId, app.id)
        .then((r) => {
          if (current) values = { ...values, [app.id]: r.settings };
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  });

  async function change(app: AppSummary, name: keyof AppListingSettings, checked: boolean) {
    if (!mayEdit || saving !== '') return;
    saving = app.id;
    problem = '';
    try {
      const done = await api.updateAppListingSettings(workspaceId, app.id, { [name]: checked });
      values = { ...values, [app.id]: done.settings };
      toast.success(t('app:listingSettings.saved'));
    } catch (e) {
      problem = e instanceof ApiError && e.status === 403 ? t('app:listingSettings.forbidden') : t('app:listingSettings.saveFailed');
    } finally {
      saving = '';
    }
  }
</script>

<SettingsCard title={t('app:settings.part.listing')} icon="git-branch" description={t('app:listingSettings.description')}>
  <div class="stack">
    {#each members as app (app.id)}
      {@const v = values[app.id]}
      <div class="record">
        <PlatformBadge platform={app.platform} tinted />
        {#if v === undefined}
          <p class="muted note">{t('app:defaults.reading')}</p>
        {:else}
          <div class="field">
            <label class="check" for="{uid}-{app.id}-repo">
              <input id="{uid}-{app.id}-repo" type="checkbox" checked={v.compareRepo} disabled={!mayEdit || saving !== ''} onchange={(e) => change(app, 'compareRepo', e.currentTarget.checked)} aria-describedby="{uid}-{app.id}-repo-hint" />
              {t('app:listingSettings.compareRepo')}
            </label>
            <p class="hint" id="{uid}-{app.id}-repo-hint">{t('app:listingSettings.compareRepoHint')}</p>
          </div>
          <div class="field">
            <label class="check" for="{uid}-{app.id}-media">
              <input id="{uid}-{app.id}-media" type="checkbox" checked={v.compareMedia} disabled={!mayEdit || saving !== ''} onchange={(e) => change(app, 'compareMedia', e.currentTarget.checked)} aria-describedby="{uid}-{app.id}-media-hint" />
              {t('app:listingSettings.compareMedia')}
            </label>
            <p class="hint" id="{uid}-{app.id}-media-hint">{t('app:listingSettings.compareMediaHint')}</p>
          </div>
        {/if}
      </div>
    {/each}
    {#if !mayEdit}<p class="muted note">{t('app:listingSettings.readOnly')}</p>{/if}
    {#if problem}<Alert tone="error" title={t('app:listingSettings.notSaved')}>{problem}</Alert>{/if}
  </div>
</SettingsCard>

<style>
  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 40rem;
  }

  .note {
    margin: 0;
  }

  .muted {
    color: var(--muted);
  }
</style>
