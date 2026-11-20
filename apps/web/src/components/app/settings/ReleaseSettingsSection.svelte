<!--
  ReleaseSettingsSection: the release settings of a Google Play app (docs/adr/0029-direct-play-release.md): the default share of a
  release and whether a staged rollout is offered. They only pre-fill and hide inputs; the share is still confirmed in the typed
  phrase of each release. Stored values, no store is contacted. Shown only for an Android record.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { type Role, STAGED_ROLLOUT_MODES, type StagedRolloutMode, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../../lib/api.ts';
  import { STAGED_ROLLOUT_LABEL, parseDefaultShare } from '../../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../../lib/release-settings-store.svelte.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const android = $derived(members.find((m) => m.platform === 'android') ?? null);
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

  async function save() {
    if (!android || !view || saving) return;
    const parsed = parseDefaultShare(share);
    if (!parsed.ok) {
      shareError = 'Type a whole percent from 1 to 100, or leave it empty to be asked every time.';
      return;
    }
    shareError = '';
    problem = '';
    saving = true;
    try {
      await api.updateAppReleaseSettings(workspaceId, android.id, { defaultSharePercent: parsed.value, stagedRollout: mode });
      await releaseSettingsStore.load(api, workspaceId, android.id);
      toast.success('Saved. Nothing in Google Play was changed.');
    } catch (e) {
      problem =
        e instanceof ApiError && e.status === 403
          ? 'Your role does not allow changing the settings of this app.'
          : 'Could not save the release settings. Nothing was changed.';
    } finally {
      saving = false;
    }
  }
</script>

{#if android}
  <SettingsCard
    title="Google Play releases"
    icon="rocket"
    description="What a release to Google Play starts from. You still type and confirm the share of every release."
  >
    {#if view === null}
      <p class="muted note">Reading…</p>
    {:else}
      <div class="stack">
        <div class="field">
          <label for="{uid}-share">Default share for Google Play releases (%)</label>
          <input
            id="{uid}-share"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="Empty: ask every time"
            bind:value={share}
            disabled={!mayEdit || saving}
            aria-invalid={shareError !== '' ? 'true' : undefined}
          />
          <p class="muted note">1 to 100. It is put in the share field of a release as a start. A share you staged wins. It is never confirmed for you.</p>
          {#if shareError}<p class="note bad">{shareError}</p>{/if}
        </div>
        <div class="field">
          <label for="{uid}-mode">Staged rollout on Google Play</label>
          <select id="{uid}-mode" bind:value={mode} disabled={!mayEdit || saving}>
            {#each STAGED_ROLLOUT_MODES as m (m)}<option value={m}>{STAGED_ROLLOUT_LABEL[m]}</option>{/each}
          </select>
          <p class="muted note">
            Google Play offers a staged rollout for updates, not for the first release in production.
            {#if view.earlierProductionRelease}An earlier production release exists for this app.{:else}No earlier production release is stored for this app yet.{/if}
          </p>
        </div>
        {#if problem}<Alert tone="error" title="Not saved">{problem}</Alert>{/if}
        <div class="row">
          <Button size="sm" variant="primary" loading={saving} disabled={!mayEdit || !dirty || saving} onclick={save}>Save</Button>
          {#if !mayEdit}<span class="muted note">Changing this needs a role that can edit apps.</span>{/if}
        </div>
      </div>
    {/if}
  </SettingsCard>
{/if}

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 28rem;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
