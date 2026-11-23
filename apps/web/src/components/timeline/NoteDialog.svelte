<!--
  NoteDialog: "Add note", a person's own event on a day (an ad campaign, a price change, press, anything else), saved to the timeline of one
  app record (POST .../timeline/events, needs `aso.write`; docs/api/timeline.md). The note is text only: nothing is sent to a store. With
  several platforms in scope the person says which record it belongs to. A title of up to 120 characters is required, the note is optional
  (up to 500). Props: api, workspaceId, members (records in scope), today (UTC day, the default date), open (bindable), onsaved (after a save).
-->
<script lang="ts">
  import { type ManualEventKind, manualEventKinds } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { kindLabelKeys } from '../../lib/timeline/timeline.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    members,
    today,
    open = $bindable(false),
    onsaved,
  }: { api: Api; workspaceId: string; members: AppSummary[]; today: string; open?: boolean | undefined; onsaved: () => void } = $props();

  const uid = $props.id();
  const TITLE_MAX = 120;
  const NOTE_MAX = 500;

  let appId = $state('');
  let kind = $state<ManualEventKind>('other');
  let day = $state('');
  let title = $state('');
  let note = $state('');
  let saving = $state(false);
  let problem = $state('');

  // A fresh form each time the dialog opens.
  $effect(() => {
    if (!open) return;
    appId = members[0]?.id ?? '';
    kind = 'other';
    day = today;
    title = '';
    note = '';
    problem = '';
  });

  const dayOk = $derived(/^\d{4}-\d{2}-\d{2}$/.test(day));
  const valid = $derived(appId !== '' && dayOk && title.trim().length > 0 && title.length <= TITLE_MAX && note.length <= NOTE_MAX);

  async function save() {
    if (!valid || saving) return;
    saving = true;
    problem = '';
    try {
      await api.createTimelineEvent(workspaceId, appId, { kind, day, title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      open = false;
      toast.success(t('timeline:add.saved'));
      onsaved();
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('timeline:add.failed');
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open size="md" title={t('timeline:add.title')} description={t('timeline:add.description')} dismissible={!saving}>
  <form
    id="{uid}-form"
    class="stack"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    {#if members.length > 1}
      <div class="field">
        <label for="{uid}-app">{t('timeline:add.app')}</label>
        <select id="{uid}-app" bind:value={appId}>
          {#each members as m (m.id)}<option value={m.id}>{platformLabel(m.platform)}</option>{/each}
        </select>
      </div>
    {/if}
    <div class="field">
      <label for="{uid}-kind">{t('timeline:add.kind')}</label>
      <select id="{uid}-kind" bind:value={kind}>
        {#each manualEventKinds as v (v)}<option value={v}>{t(kindLabelKeys[v])}</option>{/each}
      </select>
    </div>
    <TextField label={t('timeline:add.day')} type="date" bind:value={day} required />
    <TextField label={t('timeline:add.name')} bind:value={title} maxlength={TITLE_MAX} required hint={t('timeline:add.nameHint')} />
    <div class="field">
      <label for="{uid}-note">{t('timeline:add.note')}</label>
      <textarea id="{uid}-note" rows="3" maxlength={NOTE_MAX} bind:value={note}></textarea>
      <p class="quiet">{t('timeline:add.noteHint', { max: NOTE_MAX })}</p>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)} disabled={saving}>{t('common:action.cancel')}</Button>
    <Button variant="primary" type="submit" form="{uid}-form" loading={saving} disabled={!valid}>{t('timeline:add.save')}</Button>
  {/snippet}
</Modal>
