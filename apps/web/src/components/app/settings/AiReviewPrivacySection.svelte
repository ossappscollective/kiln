<!--
  AiReviewPrivacySection: "Privacy and AI" in the settings of an app: which reviews may go to the AI provider (your own, and those of
  followed competitors), in what form (full, text only, ratings only), whether emails, phone numbers, links and @handles are replaced first,
  a preview of exactly what would be sent for the first three reviews, and deleting the AI summaries of the app.
  The workspace setting (Settings > AI) is the CEILING: when it is off the choice here is shown locked, with the reason. The SERVER enforces
  every choice where the AI input is built; this form only edits it. Changing a choice does not delete past summaries.
  Drawn only when AI is on for the workspace and the role may use it. Reading needs `ai.use`; saving and deleting need `apps.write`;
  the preview needs `reviews.read`.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { aiErrorMessage } from '../../../lib/ai/ai.ts';
  import {
    choiceLabel,
    detailChoices,
    detailText,
    effectiveWord,
    kindText,
    isPrivacyDirty,
    lockedText,
    previewJson,
    privacyChanges,
    privacyToForm,
    type ReviewPayloadPreview,
    type ReviewPrivacyForm,
    type ReviewPrivacyView,
    switchChoices,
  } from '../../../lib/ai/review-privacy.ts';
  import { aiStore } from '../../../lib/ai/store.svelte.ts';
  import type { Api } from '../../../lib/api.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import Modal from '../../ui/Modal.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';
  import SaveBar from './SaveBar.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const config = $derived(aiStore.config(workspaceId));
  const on = $derived(can(role, 'ai.use') && config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');
  const canPreview = $derived(can(role, 'reviews.read'));

  let saved = $state<Record<string, ReviewPrivacyView | undefined>>({});
  let forms = $state<Record<string, ReviewPrivacyForm | undefined>>({});
  let problems = $state<Record<string, string | undefined>>({});
  let saving = $state<Record<string, boolean | undefined>>({});
  let previews = $state<Record<string, ReviewPayloadPreview | undefined>>({});
  let previewing = $state<Record<string, boolean | undefined>>({});
  let loadFailed = $state(false);
  let deleting = $state<AppSummary | null>(null);
  let deleteBusy = $state(false);
  let deleteProblem = $state('');

  $effect(() => {
    if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
  });

  $effect(() => {
    const ids = members.map((m) => m.id);
    const ws = workspaceId;
    if (!on) return;
    untrack(() => {
      loadFailed = false;
      for (const id of ids) {
        if (saved[id] !== undefined) continue;
        api
          .appAiReviewPrivacy(ws, id)
          .then((view) => {
            saved[id] = view;
            forms[id] = privacyToForm(view);
          })
          .catch(() => {
            loadFailed = true;
          });
      }
    });
  });

  async function save(app: AppSummary, event: SubmitEvent) {
    event.preventDefault();
    const view = saved[app.id];
    const form = forms[app.id];
    if (!view || !form || saving[app.id]) return;
    problems[app.id] = '';
    saving[app.id] = true;
    try {
      const next = await api.updateAppAiReviewPrivacy(workspaceId, app.id, privacyChanges(view, form));
      saved[app.id] = next;
      forms[app.id] = privacyToForm(next);
      previews[app.id] = undefined;
      toast.success(t('app:aiPrivacy.saved'));
    } catch (e) {
      problems[app.id] = aiErrorMessage(e, t('app:aiPrivacy.saveFailed'));
    } finally {
      saving[app.id] = false;
    }
  }

  function revert(app: AppSummary) {
    const view = saved[app.id];
    if (view) forms[app.id] = privacyToForm(view);
    problems[app.id] = '';
  }

  async function preview(app: AppSummary) {
    previewing[app.id] = true;
    problems[app.id] = '';
    try {
      previews[app.id] = (await api.previewAppAiReviewPrivacy(workspaceId, app.id)).preview;
    } catch (e) {
      problems[app.id] = aiErrorMessage(e, t('app:aiPrivacy.previewFailed'));
    } finally {
      previewing[app.id] = false;
    }
  }

  async function confirmDelete() {
    const app = deleting;
    if (!app) return;
    deleteBusy = true;
    deleteProblem = '';
    try {
      const out = await api.deleteAppAiSummaries(workspaceId, app.id);
      deleting = null;
      void aiStore.loadSuggestions(api, workspaceId, app.id, true);
      toast.success(t('app:aiPrivacy.deleted', { count: out.deleted }));
    } catch (e) {
      deleteProblem = aiErrorMessage(e, t('app:aiPrivacy.deleteFailed'));
    } finally {
      deleteBusy = false;
    }
  }

  const name = (group: string, id: string) => `${uid}-${group}-${id}`;
</script>

{#if on}
  <SettingsCard title={t('app:settings.part.aiPrivacy')} icon="shield" description={t('app:aiPrivacy.description')}>
    {#if loadFailed && members.every((m) => saved[m.id] === undefined)}
      <Alert tone="error">{t('app:aiPrivacy.loadFailed')}</Alert>
    {/if}
    {#each members as app (app.id)}
      {@const view = saved[app.id]}
      {@const form = forms[app.id]}
      {#if members.length > 1}<h4 class="plat">{platformLabel(app.platform)}</h4>{/if}
      {#if !view || !form}
        <Skeleton height="120px" />
      {:else}
        {@const editable = view.canEdit}
        <form class="stack loose" onsubmit={(e) => void save(app, e)} novalidate>
          {#if !editable}<p class="hint">{t('app:aiPrivacy.adminOnly')}</p>{/if}

          {#each [{ key: 'own', ceiling: view.ceiling.ownReviews }, { key: 'competitor', ceiling: view.ceiling.competitorReviews }] as kind (kind.key)}
            {@const locked = view.effective[kind.key as 'own' | 'competitor'].locked}
            <fieldset class="group">
              <legend>{t(kindText[kind.key as 'own' | 'competitor'].legend)}</legend>
              <p class="sub">{t(kindText[kind.key as 'own' | 'competitor'].sub)}</p>
              {#each switchChoices as choice (choice)}
                <label class="option">
                  <input
                    type="radio"
                    name={name(kind.key, app.id)}
                    value={choice}
                    bind:group={form[kind.key as 'own' | 'competitor']}
                    disabled={!editable || locked}
                  />
                  <span>{choiceLabel(choice, kind.ceiling)}</span>
                </label>
              {/each}
              {#if locked}
                <p class="hint warning" data-testid="locked-{kind.key}">{lockedText(kind.key as 'own' | 'competitor', view)}</p>
              {:else}
                <p class="hint" data-testid="effective-{kind.key}">{t('app:aiPrivacy.effective', { state: effectiveWord(view.effective[kind.key as 'own' | 'competitor'].allowed) })}</p>
              {/if}
            </fieldset>
          {/each}
          <p class="hint">{t('app:aiPrivacy.competitorNote')}</p>

          <fieldset class="group">
            <legend>{t('app:aiPrivacy.detail.legend')}</legend>
            {#each detailChoices as detail (detail)}
              <label class="option">
                <input type="radio" name={name('detail', app.id)} value={detail} bind:group={form.detail} disabled={!editable} />
                <span>
                  <strong>{t(detailText[detail].label)}</strong>
                  <span class="hint block">{t(detailText[detail].hint)}</span>
                </span>
              </label>
            {/each}
          </fieldset>

          <div class="field">
            <label class="check">
              <input type="checkbox" bind:checked={form.redact} disabled={!editable} />
              {t('app:aiPrivacy.redact')}
            </label>
            <p class="hint">{t('app:aiPrivacy.redactHint')}</p>
          </div>

          {#if problems[app.id]}<Alert tone="error">{problems[app.id]}</Alert>{/if}
          {#if editable}
            <SaveBar type="submit" dirty={isPrivacyDirty(view, form)} saving={saving[app.id] === true} ondiscard={() => revert(app)} />
          {/if}
        </form>

        <div class="stack">
          <h4 class="sect">{t('app:aiPrivacy.preview.title')}</h4>
          <p class="hint">{t('app:aiPrivacy.preview.sub')}</p>
          {#if canPreview}
            <div>
              <Button icon="eye" loading={previewing[app.id] === true} onclick={() => void preview(app)}>{t('app:aiPrivacy.preview.button')}</Button>
            </div>
          {/if}
          {#if previews[app.id]}
            {@const p = previews[app.id]}
            {#if p}
              <p class="hint" data-testid="preview-state">
                {p.allowed ? t('app:aiPrivacy.preview.allowed') : t('app:aiPrivacy.preview.blocked')}
                {p.sampleOf === 0 ? t('app:aiPrivacy.preview.none') : t('app:aiPrivacy.preview.count', { count: p.sampleOf })}
              </p>
              {#if p.sampleOf > 0}<pre class="payload" data-testid="preview-json" tabindex="0">{previewJson(p)}</pre>{/if}
            {/if}
          {/if}
        </div>

        {#if editable}
          <div class="stack">
            <h4 class="sect">{t('app:aiPrivacy.delete.title')}</h4>
            <p class="hint">{t('app:aiPrivacy.delete.sub')}</p>
            <div><Button variant="danger" icon="trash" onclick={() => { deleting = app; deleteProblem = ''; }}>{t('app:aiPrivacy.delete.button')}</Button></div>
          </div>
        {/if}
      {/if}
    {/each}
  </SettingsCard>
{/if}

<Modal open={deleting !== null} title={t('app:aiPrivacy.delete.confirmTitle')} description={t('app:aiPrivacy.delete.confirmBody')} onclose={() => (deleting = null)}>
  {#if deleteProblem}<Alert tone="error">{deleteProblem}</Alert>{/if}
  {#snippet footer()}
    <Button onclick={() => (deleting = null)}>{t('common:action.cancel')}</Button>
    <Button variant="danger" icon="trash" loading={deleteBusy} onclick={() => void confirmDelete()}>{t('app:aiPrivacy.delete.confirm')}</Button>
  {/snippet}
</Modal>

<style>
  .plat {
    margin: 0;
    font-size: 0.9375rem;
  }

  .sect {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .group legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .sub,
  .hint {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .hint.warning {
    color: var(--ink);
  }

  .block {
    display: block;
  }

  .option,
  .check {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    font-weight: 400;
    cursor: pointer;
  }

  .check {
    align-items: center;
    font-weight: 500;
  }

  .option input {
    margin-top: 0.3rem;
  }

  .payload {
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    max-height: 18rem;
    font-size: var(--text-xs);
    background: var(--surface-sunken, var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
