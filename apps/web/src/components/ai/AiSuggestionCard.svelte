<!--
  AiSuggestionCard: one AI suggestion as a PROPOSAL. Each item shows what the assistant proposes, its reason (as plain text), its flags
  (over the limit, trimmed, already tracked, ...) and, for a text, a meter against the limit of its field. An item that cannot be accepted
  is shown but disabled, with the reason. A person ticks what they want and accepts, or dismisses the whole suggestion.
  Accepting calls an existing mechanism as the person who accepts (track keywords, stage a text, save a reply draft); this card never
  pushes, submits, publishes or sends, and says where the result is. Ticking only some keyword ideas tracks them and keeps the rest
  proposed (the suggestion closes with its last open idea); "Undo" removes the keywords the accept just tracked.
  Everything the model wrote is shown as text, never as markup; nothing about the provider is shown here.
  Wording that matters: a keyword idea says "Where it would go: Title" and "This is a suggestion for what to put there. Nothing changes
  until you stage it." Accepting an idea only TRACKS the keyword. Putting it in the listing is a separate button ("Stage in title") that
  opens the field editor with the keyword added, the text before and after and the character budget; only the editor's own "Stage" button
  writes (to our own database). A suggested text shows what the field says now ("Now") beside the suggestion with the changes underlined.
  Props: api, workspaceId, role, suggestion, platform? (the scope of the open app, for the links), compact? (no heading: the drawer of a
  listing field), appPlatform? (the platform of the app, to say where keywords went), current? (the text each field has now, by field id,
  for the before and after of a suggested text), onaccepted? (called with the ids the accept
  returned, and again after an undo, so the screen can read its own list again).
-->
<script lang="ts">
  import { type AiAcceptedRef, type AiSuggestionView, type Platform, type Role, aiAcceptAction, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import {
    acceptBody,
    acceptButtonLabel,
    acceptedNote,
    aiErrorMessage,
    initialSelection,
    needsReplace,
    proposalRows,
    replaceButtonLabel,
    suggestionTitle,
    toggleSelection,
  } from '../../lib/ai/ai.ts';
  import { PLACEMENT_NOT_APPLIED, TRACKING_ONLY_NOTE, platformOfStore } from '../../lib/ai/placement.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import { ApiError, type Api } from '../../lib/api.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import AiInsightView from './AiInsightView.svelte';
  import Button from '../ui/Button.svelte';
  import T from '../ui/T.svelte';
  import BudgetMeter from '../aso/BudgetMeter.svelte';
  import DiffText from '../listing/DiffText.svelte';
  import StageKeywordButton from './StageKeywordButton.svelte';

  let {
    api,
    workspaceId,
    role,
    suggestion,
    platform = null,
    appPlatform = null,
    compact = false,
    current,
    onaccepted,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    suggestion: AiSuggestionView;
    platform?: PlatformScope | null | undefined;
    appPlatform?: Platform | null | undefined;
    compact?: boolean | undefined;
    current?: Record<string, string> | undefined;
    onaccepted?: ((result: AiAcceptedRef) => void | Promise<void>) | undefined;
  } = $props();

  const uid = $props.id();

  const proposal = $derived(suggestion.proposal);
  const rows = $derived(proposalRows(proposal));
  const mayAccept = $derived(can(role, aiAcceptAction[suggestion.kind]));
  const done = $derived(aiStore.settled(suggestion.id));
  const note = $derived(done ? acceptedNote(done, suggestion.appId, platform, appPlatform) : null);
  /** Ideas that are still open after an accept: the note shows above them instead of replacing them. */
  const keepOpen = $derived(done?.kind === 'keywords' && (done.remaining ?? 0) > 0 && suggestion.status === 'proposed');
  const undoable = $derived(done?.kind === 'keywords' && done.keywordIds.length > 0 && mayAccept);

  let selected = $state<number[]>([]);
  let seen = '';
  $effect(() => {
    // A partial accept leaves fewer open ideas: the ticks start again from what is still open.
    const id = `${suggestion.id}:${rows.filter((r) => r.acceptable).length}`;
    untrack(() => {
      if (id !== seen) {
        seen = id;
        selected = initialSelection(rows);
      }
    });
  });

  let busy = $state<'' | 'accept' | 'dismiss' | 'undo'>('');
  let problem = $state('');
  let clash = $state(false);

  /** What the field of a text row says now, when the screen knows it (the row's field is its group for variants, else its key). */
  const nowOf = (row: { key: string; group: string | null; text: string | null }): string | null => {
    const value = current?.[row.group ?? row.key];
    return value === undefined || row.text === null ? null : value;
  };

  const nothingToTake = $derived(rows.every((r) => !r.acceptable));
  /** A report has nothing to tick: it can be marked as reviewed, which changes nothing. */
  const isReport = $derived(proposal.kind === 'insight');

  async function refreshAfter(result: AiAcceptedRef) {
    if (result.kind !== 'listing_text') return;
    // A staged text shows in the tray, the grid and Pending changes: read them again (our own database).
    await pendingStore.refresh(api, workspaceId, [suggestion.appId], { submit: canSubmit(role) });
  }

  async function accept(replace: boolean) {
    if (busy !== '' || !mayAccept) return;
    busy = 'accept';
    problem = '';
    clash = false;
    try {
      const result = await aiStore.accept(api, workspaceId, suggestion, acceptBody(proposal, rows, selected, replace));
      await refreshAfter(result);
      await onaccepted?.(result);
    } catch (e) {
      problem = aiErrorMessage(e);
      clash = needsReplace(e);
      if (clash) problem = t('ai:card.replaceQuestion', { problem });
      // Someone else decided it, or it is gone: read the list again so the card does not stay open on a closed suggestion.
      if (e instanceof ApiError && e.code === 'suggestion_not_proposed') {
        void aiStore.loadSuggestions(api, workspaceId, suggestion.appId, true);
      }
    } finally {
      busy = '';
    }
  }

  /** Takes back the keywords the accept just tracked (only the ones it created; ones that were there before stay). */
  async function undo() {
    if (busy !== '' || done?.kind !== 'keywords') return;
    busy = 'undo';
    problem = '';
    try {
      for (const id of done.keywordIds) await api.deleteAsoKeyword(workspaceId, suggestion.appId, id);
      aiStore.closeNote(suggestion.id);
      toast.info(t('ai:card.removedKeywords', { count: done.keywordIds.length }));
      await onaccepted?.(done);
    } catch (e) {
      problem = aiErrorMessage(e);
    } finally {
      busy = '';
    }
  }

  async function dismiss() {
    if (busy !== '') return;
    busy = 'dismiss';
    problem = '';
    clash = false;
    try {
      await aiStore.dismiss(api, workspaceId, suggestion);
    } catch (e) {
      problem = aiErrorMessage(e);
    } finally {
      busy = '';
    }
  }
</script>

<article class="card-ai" class:compact aria-label={suggestionTitle(proposal)}>
  {#if note}
    <Alert tone="ok">
      {#if note.href && note.linkLabel}
        <T key="ai:card.noteWithLink" params={{ text: note.text, label: note.linkLabel }} tags={{ link: noteLink }} />
      {:else}
        {note.text}
      {/if}
    </Alert>
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    <div class="row end">
      {#if undoable}<Button size="sm" variant="ghost" loading={busy === 'undo'} disabled={busy !== ''} onclick={() => void undo()}>{t('ai:card.undo')}</Button>{/if}
      <Button size="sm" variant="ghost" onclick={() => aiStore.closeNote(suggestion.id)}>{t('ai:card.done')}</Button>
    </div>
  {/if}
  {#if !note || keepOpen}
    {#if !compact}
      <header class="head">
        <strong>{suggestionTitle(proposal)}</strong>
        <span class="muted">{timeAgo(suggestion.createdAt, Date.now())}</span>
      </header>
    {/if}
    <p class="muted small">{t('ai:card.writtenByAi')}</p>
    {#if proposal.kind === 'keywords'}
      <p class="muted small">{t(TRACKING_ONLY_NOTE)}</p>
    {:else if proposal.kind === 'listing_text' || proposal.kind === 'listing_variants'}
      <p class="muted small">{t(PLACEMENT_NOT_APPLIED)}</p>
    {/if}

    {#if proposal.kind === 'insight'}
      <AiInsightView {proposal} appId={suggestion.appId} platform={appPlatform} />
    {/if}

    <ul class="rows">
      {#each rows as row (row.index)}
        <li class="item" class:blocked={!row.acceptable}>
          <input
            type={row.group !== null ? 'radio' : 'checkbox'}
            name={row.group !== null ? `${uid}-g-${row.group}` : undefined}
            checked={selected.indexOf(row.index) !== -1}
            disabled={!row.acceptable || busy !== '' || !mayAccept}
            aria-labelledby="{uid}-t{row.index}"
            aria-describedby={row.blocked ? `${uid}-b${row.index}` : undefined}
            onchange={(e) => (selected = toggleSelection(rows, selected, row.index, e.currentTarget.checked))}
          />
          <div class="body">
            <p class="line">
              <strong id="{uid}-t{row.index}" class="title">{row.title}</strong>
              {#if row.note}<span class="muted small">{row.note}</span>{/if}
              {#each row.flags as f (f.flag)}
                <Badge tone={f.tone} icon={f.tone === 'bad' ? 'x-circle' : f.tone === 'warn' ? 'alert-triangle' : undefined}>{f.text}</Badge>
              {/each}
            </p>
            {#if row.placement !== null && proposal.kind === 'keywords'}
              <p class="why muted">{t(PLACEMENT_NOT_APPLIED)}</p>
              {#if row.acceptable}
                <StageKeywordButton
                  {api}
                  {workspaceId}
                  {role}
                  appId={suggestion.appId}
                  platform={appPlatform ?? platformOfStore(proposal.store)}
                  store={proposal.store}
                  locale={proposal.locale}
                  term={row.title}
                  field={row.placement}
                />
              {/if}
            {/if}
            {#if row.text !== null}
              {@const before = nowOf(row)}
              {#if before !== null}
                <p class="cmp muted small">{t('ai:card.now')}</p>
                <p class="text">{#if before === ''}<span class="muted">{t('ai:card.empty')}</span>{:else}{before}{/if}</p>
                <p class="cmp muted small">{t('ai:card.suggestedUnderlined')}</p>
                <p class="text"><DiffText from={before} to={row.text} side="to" fromName={t('ai:card.textNow')} toName={t('ai:card.theSuggestion')} /></p>
              {:else}
                <p class="text">{row.text}</p>
              {/if}
            {/if}
            {#if row.meter}
              <BudgetMeter
                id="{uid}-m{row.index}"
                label={row.key === 'reply' ? t('ai:card.length') : row.title}
                used={row.meter.used}
                limit={row.meter.limit}
                unit={row.meter.unit}
                remaining={row.meter.remaining}
                over={row.meter.over}
                percent={row.meter.percent}
              />
            {/if}
            {#if row.reason}<p class="why muted">{row.reason}</p>{/if}
            {#if row.blocked}<p class="why blocked-why" id="{uid}-b{row.index}">{row.blocked}</p>{/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if problem}
      <Alert tone={clash ? 'warn' : 'error'}>{problem}</Alert>
    {/if}

    <div class="row foot">
      {#if rows.length > 2 && !nothingToTake && proposal.kind !== 'listing_variants'}
        <button type="button" class="link sm" onclick={() => (selected = initialSelection(rows))}>{t('ai:card.selectAll')}</button>
        <button type="button" class="link sm" onclick={() => (selected = [])}>{t('ai:card.selectNone')}</button>
      {/if}
      <span class="spacer"></span>
      <Button size="sm" variant="ghost" loading={busy === 'dismiss'} disabled={busy !== ''} onclick={() => void dismiss()}>{t('ai:card.dismiss')}</Button>
      {#if clash}
        <Button size="sm" variant="primary" loading={busy === 'accept'} disabled={busy !== '' || (!isReport && selected.length === 0)} onclick={() => void accept(true)}>{replaceButtonLabel(proposal, rows, selected)}</Button>
      {:else}
        <Button
          size="sm"
          variant="primary"
          icon="check"
          loading={busy === 'accept'}
          disabled={busy !== '' || (!isReport && selected.length === 0) || !mayAccept}
          onclick={() => void accept(false)}
        >
          {acceptButtonLabel(proposal, rows, selected)}
        </Button>
      {/if}
    </div>
    {#if !mayAccept}<p class="muted small">{t('ai:card.roleCannot')}</p>{/if}
    {#if isReport}<p class="muted small">{t('ai:card.reportNote')}</p>{/if}
  {/if}
</article>

{#snippet noteLink(text: string)}{#if note?.href}<a href={note.href}>{text}</a>{:else}{text}{/if}{/snippet}

<style>
  .card-ai {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .card-ai.compact {
    background: var(--surface-sunken);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: baseline;
  }

  .small {
    margin: 0;
    font-size: var(--text-xs);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-2);
    align-items: start;
  }

  .item input {
    margin-top: var(--space-1);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
  }

  .title {
    overflow-wrap: anywhere;
  }

  /* The text of a proposal: plain, wrapped, line breaks kept. It is data, never markup. */
  .text {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .compact .text {
    background: var(--surface);
  }

  .cmp {
    margin: var(--space-1) 0 0;
  }

  .why {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .blocked-why {
    color: var(--bad-ink);
  }

  .blocked .title {
    color: var(--muted);
  }

  .foot {
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .end {
    justify-content: flex-end;
  }
</style>
