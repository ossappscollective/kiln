<!--
  ReplyDialog: write, check and send the public reply to one review.
  Props: open (bindable), api, workspaceId, role, review (the review, with its reply draft when it has
  one), app ({ id, name }), config (the server's reply settings: on or off, limits, translation),
  onchange (called with the updated review after a reply was sent, or a draft changed).

  Two steps. "Write": a plain text box with the store's limit counted live, saved as a draft
  (a member may do this). "Confirm": the store, the app, the review, the count against the limit and
  the exact text, with the sentence that it is published publicly and cannot be recalled by this
  tool, and a tick to acknowledge it (an admin may send). Only the saved draft is sent: the server
  gets the hash of the text that was shown and refuses when the draft changed since. There is no
  automatic and no bulk sending, and nothing is sent when this dialog is closed.

  "Draft reply" (only when AI assistance is on and the role may draft) asks the assistant for a first draft of this one review and puts it in the
  editor as an ordinary, editable, UNSAVED text, labelled "AI draft — check before sending", with its flags and an Undo. It changes nothing by
  itself: saving and sending stay exactly the steps above. When the draft is saved, the AI suggestion is closed (accepted if the text is
  unchanged, dismissed if it was edited).

  Reading order (docs/design/readability.md, "Second pass: forms and dialogs"): the review (stars, author, version, its text at 15px) first; then
  the reply box with its counter and one hint line; the helpers (AI draft, templates, translation) as quiet secondary controls under it; the
  footer has ONE primary. In the confirmation the exact text comes first, the facts are quiet, the irreversible warning is directly above the
  tick, and "Send reply" stays disabled until the tick (nothing about the confirmation or the send changed).

  The review text and the reply are plain text nodes only, never markup and never in a URL.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type FlagInfo, aiErrorMessage, flagInfos } from '../../lib/ai/ai.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { formatNumber } from '../../lib/i18n/format.ts';
  import {
    type ReplyConfig,
    type ReplyDraft,
    type ReplyTemplate,
    canSendDraft,
    checkReply,
    confirmFacts,
    draftChanged,
    insertTemplateText,
    isLocked,
    lengthState,
    limitFor,
    needsReload,
    normalizeReplyText,
    previewTemplate,
    replyAvailability,
    replyErrorMessage,
    replyStatusLabel,
    replyStatusTone,
    statusExplanation,
  } from '../../lib/reviews/reply.ts';
  import { replacingNote, replyHint, reviewByline } from '../../lib/reviews/reply-dialog.ts';
  import { collapseText, ratingText, storeLabel, type Review } from '../../lib/reviews/reviews.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import SuggestButton from '../ai/SuggestButton.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role,
    review,
    app,
    config,
    onchange,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    role: Role;
    review: Review;
    app: { id: string; name: string };
    config: ReplyConfig;
    onchange: (updated: Review) => void;
  } = $props();

  const uid = $props.id();

  let step = $state<'write' | 'confirm'>('write');
  let text = $state('');
  let saved = $state<ReplyDraft | null>(null);
  let busy = $state<'' | 'save' | 'delete' | 'send' | 'translate' | 'template' | 'ai'>('');
  /** The AI draft now in the editor: its suggestion, its text and what the editor held before (for Undo). Never saved by itself. */
  let aiDraft = $state<{ id: string; text: string; before: string; flags: FlagInfo[] } | null>(null);
  let problem = $state('');
  let ack = $state(false);
  let templates = $state<ReplyTemplate[]>([]);
  let templateId = $state('');
  let templateName = $state('');
  let target = $state('');
  let showContext = $state(false);

  const limit = $derived(limitFor(config, review.store));
  const len = $derived(lengthState(text, limit));
  const check = $derived(text.trim() === '' ? null : checkReply(text, limit));
  const avail = $derived(replyAvailability(config, role));
  const unsaved = $derived(draftChanged(saved, text));
  const status = $derived(saved ? saved.status : 'none');
  const locked = $derived(isLocked(status));
  const explanation = $derived(saved ? statusExplanation(saved) : null);
  const replacing = $derived(review.developerResponse !== null || saved?.status === 'sent');
  const context = $derived(collapseText(review.body, 240));
  const byline = $derived(reviewByline(review));
  const facts = $derived(
    saved ? confirmFacts({ store: review.store, appName: app.name, review, draft: saved, replacing }) : null,
  );
  const sendable = $derived(canSendDraft({ draft: saved, unsavedChanges: unsaved, acknowledged: ack, availability: avail }));
  const canWrite = $derived(avail.canDraft && !locked && busy === '');
  const canReview = $derived(
    avail.canSend && saved !== null && !unsaved && !locked && check !== null && check.ok && saved.length <= saved.limit && busy === '',
  );
  const picked = $derived(templates.find((item) => item.id === templateId));
  const targetOk = $derived(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(target.trim()));

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) untrack(init);
    wasOpen = open;
  });

  function init() {
    step = 'write';
    saved = review.replyDraft ?? null;
    text = saved ? saved.text : review.developerResponse ? review.developerResponse.body : '';
    problem = '';
    ack = false;
    templateId = '';
    templateName = '';
    target = review.language ?? '';
    showContext = false;
    aiDraft = null;
    void loadTemplates();
    void reload(false);
  }

  async function loadTemplates() {
    try {
      templates = (await api.replyTemplates(workspaceId)).templates;
    } catch {
      // Best effort: without templates the dialog works as well.
    }
  }

  /** Reads the review again, for the latest draft. `keepText` leaves what is typed alone. */
  async function reload(keepText: boolean) {
    try {
      const fresh = (await api.review(workspaceId, app.id, review.id)).review;
      saved = fresh.replyDraft ?? null;
      if (!keepText || !unsaved) text = saved ? saved.text : text;
      onchange(fresh);
    } catch {
      // The draft shown stays; a failed read is not worth a message of its own.
    }
  }

  async function save(): Promise<boolean> {
    if (busy !== '' || !canWrite) return false;
    busy = 'save';
    problem = '';
    try {
      saved = (await api.saveReplyDraft(workspaceId, app.id, review.id, { text: normalizeReplyText(text) })).draft;
      text = saved.text;
      onchange({ ...review, replyDraft: saved, reply: { status: saved.status, sentAt: saved.sentAt } });
      void settleAi(saved.text);
      return true;
    } catch (e) {
      problem = replyErrorMessage(e, 'draft');
      if (needsReload(e)) await reload(true);
      return false;
    } finally {
      busy = '';
    }
  }

  async function remove() {
    if (busy !== '' || !saved || locked) return;
    busy = 'delete';
    problem = '';
    try {
      await api.deleteReplyDraft(workspaceId, app.id, review.id);
      saved = null;
      text = '';
      onchange({ ...review, replyDraft: null, reply: { status: 'none', sentAt: null } });
      toast.success(t('reviews:reply.draftDeleted'));
    } catch (e) {
      problem = replyErrorMessage(e, 'draft');
      if (needsReload(e)) await reload(false);
    } finally {
      busy = '';
    }
  }

  /** The editor now holds the AI draft: an ordinary unsaved text the person edits, checks and saves like any other. */
  async function draftWithAi() {
    if (busy !== '' || !canWrite) return;
    busy = 'ai';
    problem = '';
    try {
      const made = await aiStore.run(api, workspaceId, 'review_reply_draft', { appId: app.id, reviewId: review.id });
      if (made.proposal.kind !== 'reply_draft') return;
      const proposed = made.proposal;
      if (normalizeReplyText(proposed.text) === '') {
        problem = t('reviews:reply.aiUnusable');
        return;
      }
      aiDraft = { id: made.id, text: normalizeReplyText(proposed.text), before: text, flags: flagInfos(proposed.flags) };
      text = proposed.text;
    } catch (e) {
      problem = aiErrorMessage(e);
    } finally {
      busy = '';
    }
  }

  /** Puts back what the editor held and closes the suggestion. */
  function undoAi() {
    const mine = aiDraft;
    if (!mine) return;
    text = mine.before;
    aiDraft = null;
    void closeAi(mine.id, false);
  }

  /** The draft was saved: the suggestion is accepted when the text is the assistant's, dismissed when it was edited. Best effort. */
  async function settleAi(finalText: string) {
    const mine = aiDraft;
    if (!mine) return;
    aiDraft = null;
    await closeAi(mine.id, normalizeReplyText(finalText) === mine.text);
  }

  async function closeAi(id: string, accept: boolean) {
    const found = aiStore.byId(app.id, id);
    if (!found || found.status !== 'proposed') return;
    try {
      if (accept) await aiStore.accept(api, workspaceId, found, { replace: true });
      else await aiStore.dismiss(api, workspaceId, found);
    } catch {
      // The suggestion stays open in the list of the app, where it can be dismissed.
    }
  }

  async function saveAndReview() {
    if (unsaved && !(await save())) return;
    if (!saved) return;
    ack = false;
    step = 'confirm';
  }

  async function publish() {
    if (!sendable || !saved || busy !== '') return;
    busy = 'send';
    problem = '';
    try {
      const done = await api.sendReviewReply(workspaceId, app.id, review.id, saved.textHash);
      onchange(done.review);
      toast.success(
        done.confirmedByReread ? t('reviews:reply.publishedReread') : t('reviews:reply.sentToast'),
      );
      open = false;
    } catch (e) {
      problem = replyErrorMessage(e, 'send');
      if (needsReload(e)) {
        step = 'write';
        await reload(false);
      }
    } finally {
      busy = '';
    }
  }

  async function translate() {
    if (busy !== '' || !canWrite || !targetOk || normalizeReplyText(text) === '') return;
    busy = 'translate';
    problem = '';
    try {
      const done = await api.translateReplyDraft(workspaceId, app.id, review.id, { text: normalizeReplyText(text), target: target.trim() });
      text = done.text;
      toast.info(t('reviews:reply.translatedToast'));
    } catch (e) {
      problem = replyErrorMessage(e, 'translate');
    } finally {
      busy = '';
    }
  }

  function useTemplate() {
    if (!picked) return;
    text = insertTemplateText(text, previewTemplate(picked.body, { author: review.authorName, app: app.name }));
  }

  async function saveTemplate() {
    const name = templateName.trim();
    if (busy !== '' || name === '' || normalizeReplyText(text) === '') return;
    busy = 'template';
    problem = '';
    try {
      const made = (await api.createReplyTemplate(workspaceId, { name, body: normalizeReplyText(text) })).template;
      templates = [...templates, made].sort((a, b) => a.name.localeCompare(b.name));
      templateName = '';
      toast.success(t('reviews:reply.templateSaved'));
    } catch (e) {
      problem = replyErrorMessage(e, 'template');
    } finally {
      busy = '';
    }
  }

  async function removeTemplate() {
    if (busy !== '' || !picked) return;
    busy = 'template';
    problem = '';
    try {
      await api.deleteReplyTemplate(workspaceId, picked.id);
      templates = templates.filter((item) => item.id !== picked?.id);
      templateId = '';
    } catch (e) {
      problem = replyErrorMessage(e, 'template');
    } finally {
      busy = '';
    }
  }
</script>

<Modal
  bind:open
  size="lg"
  title={step === 'confirm' ? t('reviews:reply.titleConfirm') : replacing ? t('reviews:reply.titleEdit') : t('reviews:reply.titleNew')}
  description="{app.name} · {storeLabel(review.store)}"
  dismissible={busy === ''}
>
  <div class="context">
    <p class="context-head">
      <span class="visually-hidden">{t('reviews:reply.reviewPrefix')}</span>
      <span class="stars" role="img" aria-label={ratingText(review.rating)}>
        {#each [1, 2, 3, 4, 5] as n (n)}
          <Icon name={n <= review.rating ? 'star-filled' : 'star'} size={18} />
        {/each}
      </span>
      {#each byline as part, i (i)}<span class="byline">{part}</span>{/each}
    </p>
    {#if review.title}<p class="plain title"><strong>{review.title}</strong></p>{/if}
    <p class="plain body">{showContext ? review.body : context.text}</p>
    {#if context.cut}
      <button type="button" class="link sm" aria-expanded={showContext} onclick={() => (showContext = !showContext)}>
        {showContext ? t('reviews:card.showLess') : t('reviews:card.showWholeReview')}
      </button>
    {/if}
    {#if replacing}
      <p class="muted small">{replacingNote()}</p>
    {/if}
  </div>

  {#if avail.state === 'off' || avail.state === 'rights'}
    <Alert tone={avail.state === 'off' ? 'warn' : 'info'} title={avail.state === 'off' ? t('reviews:reply.offTitle') : t('reviews:reply.rightsTitle')}>
      {avail.reason}
    </Alert>
  {/if}

  {#if step === 'write'}
    <div class="stack">
      <div class="field">
        <div class="label-row">
          <label for="{uid}-text">{t('reviews:reply.label')}</label>
          {#if saved}<Badge tone={replyStatusTone(status)}>{replyStatusLabel(status)}</Badge>{/if}
        </div>
        {#if aiDraft}
          <p class="ai-note" role="status" data-testid="ai-draft-label">
            <Icon name="sparkles" size={14} />
            <strong>{t('reviews:reply.aiDraft')}</strong>
            {#each aiDraft.flags as f (f.flag)}<Badge tone={f.tone}>{f.text}</Badge>{/each}
            <button type="button" class="link sm" disabled={busy !== ''} onclick={undoAi}>{t('reviews:reply.undo')}</button>
          </p>
        {/if}
        <textarea
          id="{uid}-text"
          rows="7"
          bind:value={text}
          disabled={!canWrite}
          autocomplete="off"
          spellcheck="true"
          aria-describedby="{uid}-count {uid}-hint"
          aria-invalid={check !== null && !check.ok}
        ></textarea>
        <div class="meta-row">
          <p class="counter {len.tone}" id="{uid}-count" aria-live="polite">{len.label}</p>
          <p class="hint" id="{uid}-hint">{replyHint(storeLabel(review.store), limit)}</p>
        </div>
        {#if check && !check.ok}<p class="error" role="alert">{check.message}</p>{/if}
      </div>

      {#if explanation}<Alert tone={status === 'failed' || status === 'unknown' ? 'warn' : 'info'}>{explanation}</Alert>{/if}

      {#if avail.canDraft && !locked}
        <div class="helpers">
          <SuggestButton {api} {workspaceId} {role} kind="reply_draft" taskId="review_reply_draft" label={t('reviews:reply.draftButton')} onrun={draftWithAi} align="start" />
        </div>
        <details class="extras">
          <summary>{config.translation.available ? t('reviews:reply.extrasWithTranslation') : t('reviews:reply.extras')}</summary>
          <div class="extras-body">
            <div class="field">
              <label for="{uid}-template">{t('reviews:reply.templateStart')}</label>
              <div class="row">
                <select id="{uid}-template" bind:value={templateId} disabled={busy !== '' || templates.length === 0}>
                  <option value="">{templates.length === 0 ? t('reviews:reply.templatesNone') : t('reviews:reply.templatePick')}</option>
                  {#each templates as template (template.id)}<option value={template.id}>{template.name}</option>{/each}
                </select>
                <Button size="sm" disabled={!picked || busy !== ''} onclick={useTemplate}>{t('reviews:reply.insert')}</Button>
                <Button size="sm" variant="ghost" disabled={!picked || busy !== ''} onclick={removeTemplate}>{t('reviews:reply.templateDelete')}</Button>
              </div>
              <p class="hint">{t('reviews:reply.templateHint', { author: '{{author}}', app: '{{app}}' })}</p>
            </div>
            <div class="field">
              <label for="{uid}-tname">{t('reviews:reply.templateSaveLabel')}</label>
              <div class="row">
                <input id="{uid}-tname" type="text" maxlength="100" bind:value={templateName} placeholder={t('reviews:reply.templateName')} autocomplete="off" />
                <Button size="sm" disabled={busy !== '' || templateName.trim() === '' || text.trim() === ''} loading={busy === 'template'} onclick={saveTemplate}>
                  {t('reviews:reply.templateSave')}
                </Button>
              </div>
            </div>
            {#if config.translation.available}
              <div class="field">
                <label for="{uid}-target">{t('reviews:reply.translateLabel')}</label>
                <div class="row">
                  <input id="{uid}-target" type="text" maxlength="12" bind:value={target} placeholder={t('reviews:reply.translatePlaceholder')} autocomplete="off" />
                  <Button size="sm" disabled={busy !== '' || !targetOk || text.trim() === ''} loading={busy === 'translate'} onclick={translate}>{t('reviews:reply.translate')}</Button>
                </div>
                <p class="hint">{t('reviews:reply.translateHint')}</p>
              </div>
            {/if}
          </div>
        </details>
      {/if}

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {:else if facts}
    <div class="stack">
      <div>
        <p class="label-line" id="{uid}-exact">{t('reviews:reply.exactText')}</p>
        <p class="exact" aria-labelledby="{uid}-exact" data-testid="exact-reply">{facts.text}</p>
        <p class="counter {facts.count > facts.limit ? 'bad' : 'ok'}">{t('reviews:reply.charCount', { used: formatNumber(facts.count), limit: formatNumber(facts.limit) })}</p>
      </div>
      <dl class="facts">
        {#each facts.rows as row (row.label)}
          <div>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        {/each}
      </dl>
      <Alert tone="warn" title={t('reviews:reply.irreversible')}>{facts.warning}</Alert>
      <label class="check">
        <input type="checkbox" bind:checked={ack} disabled={busy !== ''} />
        {t('reviews:reply.ack', { store: storeLabel(review.store) })}
      </label>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if step === 'write'}
      <Button disabled={busy === 'send'} onclick={() => (open = false)}>{t('common:action.close')}</Button>
      {#if saved && avail.canDraft && !locked}
        <Button variant="ghost" loading={busy === 'delete'} disabled={busy !== ''} onclick={remove}>{t('reviews:reply.deleteDraft')}</Button>
      {/if}
      {#if status === 'sending'}
        <Button onclick={() => void reload(false)}>{t('reviews:reply.checkAgain')}</Button>
      {/if}
      {#if avail.canDraft && !locked}
        <Button loading={busy === 'save'} disabled={busy !== '' || !unsaved || (check !== null && !check.ok) || text.trim() === ''} onclick={() => void save()}>
          {t('reviews:reply.saveDraft')}
        </Button>
      {/if}
      {#if avail.canSend}
        <Button
          variant="primary"
          disabled={!(canReview || (unsaved && check !== null && check.ok && busy === '' && !locked))}
          onclick={() => void saveAndReview()}
        >
          {unsaved ? t('reviews:reply.saveAndReview') : t('reviews:reply.reviewAndSend')}
        </Button>
      {/if}
    {:else}
      <Button disabled={busy === 'send'} onclick={() => (step = 'write')}>{t('common:action.back')}</Button>
      <Button variant="danger-solid" loading={busy === 'send'} disabled={!sendable || busy !== ''} onclick={() => void publish()}>
        {status === 'unknown' ? t('reviews:reply.checkAndSend') : t('reviews:reply.send')}
      </Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .context {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .context-head,
  .plain {
    margin: 0;
  }

  .context-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .stars {
    display: inline-flex;
    color: var(--warn);
  }

  .byline {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* Customer text: plain, wrapped, line breaks kept. */
  .plain {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .plain.title {
    font-size: 1.0625rem;
  }

  .plain.body {
    font-size: 0.9375rem;
    line-height: 1.55;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .stack textarea {
    font-size: 0.9375rem;
    line-height: 1.5;
  }

  .label-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: baseline;
    justify-content: space-between;
  }

  .meta-row .hint {
    margin: 0;
    font-size: var(--text-sm);
  }

  .helpers {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .ai-note {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  .counter {
    margin: 0;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .counter.warn {
    color: var(--warn-ink);
  }

  .counter.bad {
    color: var(--bad-ink);
    font-weight: 600;
  }

  .error {
    margin: 0;
    color: var(--bad-ink);
    font-size: var(--text-sm);
  }

  .extras summary {
    cursor: pointer;
  }

  .extras-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-3);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }

  .facts dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .label-line {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* The exact text, as it will be published: nothing is formatted. */
  .exact {
    margin: 0;
    padding: var(--space-4);
    font-size: 1rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
</style>
