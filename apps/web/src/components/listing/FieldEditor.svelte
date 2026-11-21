<!--
  FieldEditor: edit one main text field of one locale of an app's listing (title or name, subtitle, short description, keyword field,
  promotional text, description) in a dialog, and STAGE the change. It shows the text the store has now, a box to edit, a live counter
  against the store's limit (characters, or bytes for the App Store keyword field), and the text before and after with the changes
  marked. "Suggest with AI" (when AI is on and the role may use it) asks for a proposal in the same words: it is shown with what the
  field says now and staged only when the person says so.
  Reading order (docs/design/readability.md, "Second pass: forms and dialogs"): the label, the box, the counter and ONE line of hint (why Stage
  is off, in red when the text is over the limit); then the quiet helpers (the AI suggestion); the comparison with the store sits behind
  "Show the changes against the store" and only exists once the text differs. The primary is "Stage in <field>" in the footer.
  Everything here is saved in OUR OWN database as a staged change. Nothing reaches a store: the staged text goes to the store's draft
  only through the previewed, confirmed push of the staged changes, which this never starts. The App Store name and subtitle cannot be
  written by a draft push, so for them the editor is a place to work the text out and copy it, and says so.
  Props: api, workspaceId, role, appId, platform, locale, field (the listing field id), open (bindable), current? (the text the store has
  now, when the caller has it; else it is read from the stored listing), seed? (a text to start from, for example a keyword added to the
  field, with a note), onstaged? (after a text was staged or taken back).
-->
<script lang="ts">
  import { type AiAcceptedRef, type Platform, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { storeTextOf } from '../../lib/aso/keyword-use.ts';
  import {
    fieldInfo,
    measureField,
    notStageableReason,
    sameText,
    stageBlockedReason,
  } from '../../lib/listing/edit.ts';
  import { canStage, findStagedText, normalizeText, stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import ImproveField from '../ai/ImproveField.svelte';
  import BudgetMeter from '../aso/BudgetMeter.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Modal from '../ui/Modal.svelte';
  import DiffText from './DiffText.svelte';

  let {
    api,
    workspaceId,
    role,
    appId,
    platform,
    locale,
    field,
    open = $bindable(false),
    current,
    seed = null,
    onstaged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    appId: string;
    platform: Platform;
    locale: string;
    field: string;
    open?: boolean | undefined;
    current?: string | null | undefined;
    seed?: { text: string; note: string } | null | undefined;
    onstaged?: (() => void | Promise<void>) | undefined;
  } = $props();

  const uid = $props.id();
  const info = $derived(fieldInfo(platform, field));
  const staged = $derived(findStagedText(stagedStore.view(appId), locale, field));

  /** The text the store has now: given by the caller, else read from the stored listing of this app. */
  let loaded = $state<string | null>(null);
  let loadProblem = $state('');
  let loading = $state(false);
  const storeText = $derived(current !== undefined ? current : loaded);

  let draft = $state('');
  let busy = $state<'' | 'stage' | 'unstage'>('');
  let problem = $state('');
  let showDiff = $state(false);
  let startedFor = '';

  async function readStore() {
    loading = true;
    loadProblem = '';
    try {
      const listing = await api.asoListingKeywords(workspaceId, appId);
      const found = listing.locales.find((l) => l.locale === locale);
      loaded = found ? storeTextOf(found.fields, field) : null;
    } catch {
      loaded = null;
      loadProblem = 'Could not read the stored text of this field. You can still write a new text.';
    } finally {
      loading = false;
    }
  }

  // Opening (or another field, locale or seed) starts clean: the seed, else the text already staged, else the store's text.
  $effect(() => {
    if (!open) {
      startedFor = '';
      return;
    }
    const id = `${appId}/${locale}/${field}/${seed?.text ?? ''}`;
    untrack(() => {
      if (id === startedFor) return;
      startedFor = id;
      problem = '';
      showDiff = false;
      loaded = null;
      loadProblem = '';
      void stagedStore.load(api, workspaceId, appId).then(() => {
        if (startedFor !== id) return;
        draft = seed?.text ?? findStagedText(stagedStore.view(appId), locale, field)?.value ?? storeText ?? '';
      });
      if (current === undefined) {
        void readStore().then(() => {
          // The store text arrives after the staged view: start from it when nothing else did.
          if (startedFor === id && seed === null && findStagedText(stagedStore.view(appId), locale, field) === null) {
            draft = loaded ?? '';
          }
        });
      } else if (seed === null && findStagedText(stagedStore.view(appId), locale, field) === null) {
        draft = current ?? '';
      }
    });
  });

  const meter = $derived(info ? measureField(info, draft) : null);
  const before = $derived(storeText ?? '');
  const unchanged = $derived(sameText(draft, before));
  const empty = $derived(normalizeText(draft) === '');
  const blocked = $derived(
    info === null
      ? 'This field cannot be edited here.'
      : stageBlockedReason({
          platform,
          field,
          canStage: canStage(role),
          empty,
          over: meter?.over === true,
          unchanged,
        }),
  );
  const stageable = $derived(notStageableReason(platform, field) === null);
  const alreadyStaged = $derived(staged !== null && sameText(staged.value, draft));

  async function stage() {
    if (busy !== '' || blocked !== null || info === null) return;
    busy = 'stage';
    problem = '';
    try {
      const done = await api.stageText(workspaceId, appId, { locale, field, from: 'local', value: draft });
      stagedStore.set(done.staged);
      toast.success(`Staged ${info.lower} (${locale}). It is not in the store yet: it goes to the store's draft only when you push the staged changes.`);
      await onstaged?.();
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = '';
    }
  }

  async function unstage() {
    if (busy !== '' || staged === null) return;
    busy = 'unstage';
    problem = '';
    try {
      const done = await api.unstageItem(workspaceId, appId, staged.id);
      stagedStore.set(done.staged);
      draft = storeText ?? '';
      await onstaged?.();
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = '';
    }
  }

  /** The AI proposal was staged by its own card: take the staged text into the box. */
  async function aiStaged(_result: AiAcceptedRef) {
    await stagedStore.load(api, workspaceId, appId);
    const now = findStagedText(stagedStore.view(appId), locale, field);
    if (now) draft = now.value;
    await onstaged?.();
  }
</script>

<Modal
  bind:open
  size="lg"
  title={info ? `Edit ${info.lower} · ${locale}` : 'Edit'}
  description="{storeName(platform)}. Staged here, in this tool: nothing reaches the store until you push the staged changes."
>
  {#if info === null || meter === null}
    <p>This field cannot be edited here.</p>
  {:else}
    <div class="stack editor">
      {#if !stageable}
        <Alert tone="info">{notStageableReason(platform, field)}</Alert>
      {/if}
      {#if loadProblem}<Alert tone="warn">{loadProblem}</Alert>{/if}
      {#if seed?.note}<p class="muted note">{seed.note}</p>{/if}
      {#if staged !== null}
        <p class="muted note">
          A text is already staged for this field{staged.pushed ? ' (and in the store draft)' : ''}. Staging again replaces it.
        </p>
      {/if}

      <div class="stack tight">
        <label for="{uid}-text"><strong>{info.label}</strong> <span class="muted">· your text</span></label>
        <textarea
          id="{uid}-text"
          rows={info.multiline ? 10 : 3}
          bind:value={draft}
          aria-describedby="{uid}-meter"
          spellcheck="true"
        ></textarea>
        {#if meter.limit !== null && meter.remaining !== null}
          <BudgetMeter
            id={`${uid}-meter`}
            label={info.label}
            used={meter.used}
            limit={meter.limit}
            unit={meter.unit}
            remaining={meter.remaining}
            over={meter.over}
            percent={meter.percent}
          />
        {:else}
          <p id="{uid}-meter" class="muted note">{meter.text}</p>
        {/if}
        {#if blocked !== null && stageable && !unchanged}<p class="note hintline" class:bad={meter.over}>{blocked}</p>{/if}
      </div>

      {#if info.stageable}
        <div class="helpers">
          <ImproveField
            {api}
            {workspaceId}
            {role}
            app={{ id: appId, platform }}
            field={{ locale, field, label: info.label }}
            current={storeText}
            buttonLabel="Suggest with AI"
            onaccepted={aiStaged}
          />
        </div>
      {/if}

      {#if !unchanged}
        <div>
          <button type="button" class="link" aria-expanded={showDiff} aria-controls="{uid}-compare" onclick={() => (showDiff = !showDiff)}>
            {showDiff ? 'Hide the changes against the store' : 'Show the changes against the store'}
          </button>
        </div>
        <div id="{uid}-compare" class="stack tight" hidden={!showDiff}>
          <div class="compare" aria-label="Before and after">
            <div class="side">
              <p class="eyebrow">In the store now</p>
              <p class="text">
                {#if loading}<span class="muted">Reading…</span>
                {:else if before === ''}<span class="muted">(nothing stored)</span>
                {:else}<DiffText from={before} to={draft} side="from" fromName="the store" toName="your text" />{/if}
              </p>
            </div>
            <div class="side">
              <p class="eyebrow">After your change</p>
              <p class="text">
                {#if empty}<span class="muted">(empty)</span>
                {:else}<DiffText from={before} to={draft} side="to" fromName="the store" toName="your text" />{/if}
              </p>
            </div>
          </div>
          <p class="muted note">Words only in the store are struck through; words only in your text are underlined.</p>
        </div>
      {/if}

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if staged !== null}
      <Button variant="ghost" loading={busy === 'unstage'} disabled={busy !== ''} onclick={() => void unstage()}>Take back the staged text</Button>
    {/if}
    <Button variant="ghost" onclick={() => (draft = storeText ?? '')} disabled={busy !== '' || unchanged}>Reset to the store text</Button>
    <CopyButton value={draft} label="Copy text" variant="secondary" size="md" />
    {#if stageable}
      <Button
        variant="primary"
        icon="layers"
        loading={busy === 'stage'}
        disabled={busy !== '' || blocked !== null || alreadyStaged}
        title={alreadyStaged ? 'This text is already staged' : (blocked ?? undefined)}
        onclick={() => void stage()}
      >
        {alreadyStaged ? 'Staged' : `Stage in ${info?.lower ?? 'field'}`}
      </Button>
    {/if}
    <Button onclick={() => (open = false)}>Close</Button>
  {/snippet}
</Modal>

<style>
  .editor textarea {
    width: 100%;
    font: inherit;
    font-size: 0.9375rem;
    line-height: 1.5;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .hintline.bad {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .helpers {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-3);
  }

  .side .eyebrow {
    margin: 0 0 var(--space-1);
  }

  .text {
    margin: 0;
    padding: var(--space-3);
    overflow-wrap: anywhere;
    font-size: 0.9375rem;
    line-height: 1.5;
    white-space: pre-wrap;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
</style>
