<!--
  ReleaseSettingsSection: the release settings of a Google Play app (docs/adr/0029-direct-play-release.md): the default share of a
  release and whether a staged rollout is offered. They only pre-fill and hide inputs; the share is still confirmed in the typed
  phrase of each release. Stored values, no store is contacted. Shown only for an Android record.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { can, type Role, STAGED_ROLLOUT_MODES, type StagedRolloutMode, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../../lib/api.ts';
  import { stagedRolloutHint } from '../../../lib/app-settings.ts';
  import { STAGED_ROLLOUT_LABEL, parseDefaultShare } from '../../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../../lib/app-state/release-settings-store.svelte.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import SaveBar from './SaveBar.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const android = $derived(members.find((m) => supports(m.platform, 'releaseTracks')) ?? null);
  const mayEdit = $derived(can(role, 'apps.write'));

  let share = $state('');
  let mode = $state<StagedRolloutMode>('auto');
  let shareError = $state('');
  let problem = $state('');
  let saving = $state(false);
  let loadedFor = '';
  const view = $derived(android ? releaseSettingsStore.get(android.id) : null);

  $effect(() => {
    const app = android;
    if (!app) return;
    const key = `${workspaceId}/${app.id}`;
    if (key === loadedFor) return;
    loadedFor = key;
    untrack(() => {
      void releaseSettingsStore.load(api, workspaceId, app.id);
    });
  });

  let shown = '';
  $effect(() => {
    const v = view;
    if (!v) return;
    const key = JSON.stringify(v.settings);
    if (key === shown) return;
    shown = key;
    untrack(() => {
      share = v.settings.defaultSharePercent === null ? '' : String(v.settings.defaultSharePercent);
      mode = v.settings.stagedRollout;
    });
  });

  const dirty = $derived(
    view !== null &&
      (share.trim() !== (view.settings.defaultSharePercent === null ? '' : String(view.settings.defaultSharePercent)) ||
        mode !== view.settings.stagedRollout),
  );

  function discard() {
    if (!view) return;
    share = view.settings.defaultSharePercent === null ? '' : String(view.settings.defaultSharePercent);
    mode = view.settings.stagedRollout;
    shareError = '';
    problem = '';
  }

  async function save() {
    if (!android || !view || saving) return;
    const parsed = parseDefaultShare(share);
    if (!parsed.ok) {
      shareError = t('app:releaseSettings.shareInvalid');
      return;
    }
    shareError = '';
    problem = '';
    saving = true;
    try {
      await api.updateAppReleaseSettings(workspaceId, android.id, { defaultSharePercent: parsed.value, stagedRollout: mode });
      await releaseSettingsStore.load(api, workspaceId, android.id);
      toast.success(t('app:releaseSettings.saved'));
    } catch (e) {
      problem =
        e instanceof ApiError && e.status === 403
          ? t('app:releaseSettings.forbidden')
          : t('app:releaseSettings.saveFailed');
    } finally {
      saving = false;
    }
  }
</script>

{#snippet readOnlyNote()}{t('app:releaseSettings.readOnly')}{/snippet}

{#if android}
  <SettingsCard
    title={t('app:settings.part.playReleases')}
    icon="rocket"
    description={t('app:releaseSettings.description')}
  >
    {#if view === null}
      <p class="muted note">{t('app:defaults.reading')}</p>
    {:else}
      <div class="stack">
        <div class="field">
          <label for="{uid}-share">{t('app:releaseSettings.shareLabel')}</label>
          <input
            id="{uid}-share"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder={t('app:releaseSettings.sharePlaceholder')}
            bind:value={share}
            disabled={!mayEdit || saving}
            aria-invalid={shareError !== '' ? 'true' : undefined}
          />
          <p class="hint">{t('app:releaseSettings.shareHint')}</p>
          {#if shareError}<p class="hint bad">{shareError}</p>{/if}
        </div>
        <div class="field">
          <label for="{uid}-mode">{t('app:releaseSettings.modeLabel')}</label>
          <select id="{uid}-mode" bind:value={mode} disabled={!mayEdit || saving}>
            {#each STAGED_ROLLOUT_MODES as m (m)}<option value={m}>{STAGED_ROLLOUT_LABEL[m]}</option>{/each}
          </select>
          <p class="hint">{stagedRolloutHint(view.earlierProductionRelease)}</p>
        </div>
        {#if problem}<Alert tone="error" title={t('app:releaseSettings.notSaved')}>{problem}</Alert>{/if}
        <SaveBar {dirty} {saving} disabled={!mayEdit} onsave={save} ondiscard={discard} note={mayEdit ? undefined : readOnlyNote} />
      </div>
    {/if}
  </SettingsCard>
{/if}

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 32rem;
  }

  .field label {
    font-size: 0.9375rem;
    font-weight: var(--weight-semibold);
  }

  .hint,
  .note {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .hint.bad {
    color: var(--bad-ink);
  }
</style>
