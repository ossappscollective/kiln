<!--
  NoteDialog: add or change a note of the manual tracker (docs/api/experiments.md). Kiln's own data: nothing is sent to a store.
  The same checks as the server (`validateNote`), shown before the round trip; the server's answer is shown when it refuses.
  Props: open (bindable), api, workspaceId, appId, platform, note (null to add), onsaved (called with the saved note).
-->
<script lang="ts">
  import { platformSupports } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    type ExperimentNote,
    NOTE_KINDS,
    NOTE_STATUSES,
    type NoteInput,
    noteKindLabel,
    noteStatusBadge,
    validateNote,
  } from '../../lib/experiments.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    platform,
    note,
    onsaved,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    appId: string;
    platform: string;
    note: ExperimentNote | null;
    onsaved: (saved: ExperimentNote) => void;
  } = $props();

  const uid = $props.id();
  const google = $derived(platformSupports(platform, 'releaseTracks'));

  let kind = $state<NoteInput['kind']>('experiment');
  let name = $state('');
  let status = $state<NoteInput['status']>('planned');
  let startedOn = $state('');
  let endedOn = $state('');
  let url = $state('');
  let listing = $state('');
  let text = $state('');
  let saving = $state(false);
  let problem = $state('');
  let shown = $state(false);

  // The form starts from the note each time the dialog opens.
  $effect(() => {
    if (open) {
      kind = note?.kind ?? 'experiment';
      name = note?.name ?? '';
      status = note?.status ?? 'planned';
      startedOn = note?.startedOn ?? '';
      endedOn = note?.endedOn ?? '';
      url = note?.url ?? '';
      listing = note?.listing ?? '';
      text = note?.note ?? '';
      problem = '';
      shown = false;
    }
  });

  const input = $derived<NoteInput>({
    kind,
    name,
    status,
    startedOn: startedOn === '' ? null : startedOn,
    endedOn: endedOn === '' ? null : endedOn,
    url: url.trim() === '' ? null : url.trim(),
    listing: listing.trim() === '' ? null : listing.trim(),
    note: text,
  });
  const problems = $derived(validateNote(input));
  const invalid = $derived(Object.keys(problems).length > 0);

  async function save(event: Event) {
    event.preventDefault();
    shown = true;
    if (invalid || saving) return;
    saving = true;
    problem = '';
    try {
      const body = { ...input, name: input.name.trim() };
      const done = note
        ? await api.updateExperimentNote(workspaceId, appId, note.id, {
            name: body.name,
            status: body.status,
            startedOn: body.startedOn,
            endedOn: body.endedOn,
            url: body.url,
            listing: body.listing,
            note: body.note,
          })
        : await api.createExperimentNote(workspaceId, appId, body);
      onsaved(done.note);
      open = false;
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('experiments:noteDialog.saveFailed');
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open title={note ? t('experiments:noteDialog.editTitle') : t('experiments:noteDialog.addTitle')} description={t('experiments:noteDialog.description')}>
  <form class="stack" id="{uid}-form" onsubmit={save} novalidate>
    {#if problem !== ''}<Alert tone="error" title={t('experiments:noteDialog.saveFailedTitle')}>{problem}</Alert>{/if}
    <div class="field">
      <label for="{uid}-kind">{t('experiments:noteDialog.kind')}</label>
      <select id="{uid}-kind" bind:value={kind} disabled={note !== null}>
        {#each NOTE_KINDS as k (k)}<option value={k}>{noteKindLabel(k)}</option>{/each}
      </select>
    </div>
    <TextField label={t('experiments:noteDialog.name')} bind:value={name} maxlength={120} placeholder={t('experiments:noteDialog.namePlaceholder')} error={shown ? problems.name : undefined} required />
    <div class="field">
      <label for="{uid}-status">{t('experiments:noteDialog.status')}</label>
      <select id="{uid}-status" bind:value={status}>
        {#each NOTE_STATUSES as s (s)}<option value={s}>{noteStatusBadge(s).label}</option>{/each}
      </select>
    </div>
    <div class="row dates">
      <TextField label={t('experiments:noteDialog.startedOn')} type="date" bind:value={startedOn} error={shown ? problems.startedOn : undefined} />
      <TextField label={t('experiments:noteDialog.endedOn')} type="date" bind:value={endedOn} error={shown ? problems.endedOn : undefined} />
    </div>
    <TextField label={t('experiments:noteDialog.url')} type="url" bind:value={url} hint={t('experiments:noteDialog.urlHint')} error={shown ? problems.url : undefined} />
    {#if google && kind === 'custom_page'}
      <TextField label={t('experiments:noteDialog.listing')} bind:value={listing} hint={t('experiments:noteDialog.listingHint')} error={shown ? problems.listing : undefined} />
    {/if}
    <div class="field">
      <label for="{uid}-note">{t('experiments:noteDialog.note')}</label>
      <textarea id="{uid}-note" rows="4" bind:value={text} maxlength={2000} aria-invalid={shown && problems.note ? 'true' : undefined}></textarea>
      <p class="hint">{t('experiments:noteDialog.noteHint')}</p>
      {#if shown && problems.note}<p class="field-error" role="alert">{problems.note}</p>{/if}
    </div>
  </form>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="primary" type="submit" form="{uid}-form" loading={saving}>{t('common:action.save')}</Button>
  {/snippet}
</Modal>

<style>
  .dates {
    align-items: flex-start;
    gap: var(--space-3);
  }
</style>
