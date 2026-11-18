<!--
  ReviewCard: one customer review, as plain text, with its developer response and internal triage.
  Props: api, workspaceId, appId, review, members (for the assignee), canTriage, lowThreshold, now (ms),
  onchange (called with the updated review after a triage change is saved).

  The review text, title and display name are written by customers: they are text nodes only (never
  markup, never in a URL). Triage (status, assignee, note) is internal; nothing here replies to a
  review or changes anything in a store.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    MAX_NOTE_LENGTH,
    collapseText,
    isLowRating,
    ratingText,
    reviewErrorMessage,
    reviewFacts,
    statusLabel,
    statusOrder,
    triageDiff,
    type Review,
    type ReviewStatus,
  } from '../../lib/reviews.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  let {
    api,
    workspaceId,
    appId,
    review,
    members,
    canTriage,
    lowThreshold,
    now,
    onchange,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    review: Review;
    members: Member[];
    canTriage: boolean;
    lowThreshold: number;
    now: number;
    onchange: (updated: Review) => void;
  } = $props();

  const uid = $props.id();

  let expanded = $state(false);
  let responseExpanded = $state(false);
  /** The triage form, open or closed. A draft is copied from the review when it opens. */
  let editing = $state(false);
  let draft = $state<{ status: ReviewStatus; assigneeUserId: string; internalNote: string }>({
    status: 'new',
    assigneeUserId: '',
    internalNote: '',
  });
  let saving = $state(false);
  let problem = $state('');

  const text = $derived(collapseText(review.body));
  const response = $derived(review.developerResponse ? collapseText(review.developerResponse.body) : null);
  const facts = $derived(reviewFacts(review));
  const low = $derived(isLowRating(review.rating, lowThreshold));
  const edited = $derived(review.updatedAt > review.createdAt + 60_000);
  const assignee = $derived(
    review.assigneeUserId ? (members.find((m) => m.userId === review.assigneeUserId)?.displayName ?? 'A former member') : null,
  );
  const tone = $derived(
    review.status === 'new' ? 'info' : review.status === 'ignored' ? 'neutral' : review.status === 'replied_in_console' ? 'ok' : 'accent',
  );
  const changes = $derived(
    triageDiff(review, {
      status: draft.status,
      assigneeUserId: draft.assigneeUserId === '' ? null : draft.assigneeUserId,
      internalNote: draft.internalNote,
    }),
  );
  const dirty = $derived(Object.keys(changes).length > 0);

  function open() {
    draft = {
      status: review.status,
      assigneeUserId: review.assigneeUserId ?? '',
      internalNote: review.internalNote ?? '',
    };
    problem = '';
    editing = true;
  }

  /** The one click most reviews need: new to triaged. */
  async function markTriaged() {
    if (saving) return;
    saving = true;
    problem = '';
    try {
      onchange((await api.triageReview(workspaceId, appId, review.id, { status: 'triaged' })).review);
    } catch (e) {
      problem = reviewErrorMessage(e, 'triage');
    } finally {
      saving = false;
    }
  }

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    problem = '';
    try {
      const done = await api.triageReview(workspaceId, appId, review.id, changes);
      onchange(done.review);
      editing = false;
      toast.success('Saved. Nothing was sent to the store.');
    } catch (e) {
      problem = reviewErrorMessage(e, 'triage');
    } finally {
      saving = false;
    }
  }
</script>

<article class="review" class:low aria-labelledby="{uid}-head">
  <header class="head" id="{uid}-head">
    <span class="stars" role="img" aria-label={ratingText(review.rating)}>
      {#each [1, 2, 3, 4, 5] as n (n)}
        <Icon name={n <= review.rating ? 'star-filled' : 'star'} size={16} />
      {/each}
    </span>
    {#if low}<Badge tone="bad">Low rating</Badge>{/if}
    <Badge {tone}>{statusLabel(review.status)}</Badge>
    <span class="muted when">
      <time datetime={new Date(review.createdAt).toISOString()} title={fullTime(review.createdAt)}>{timeAgo(review.createdAt, now)}</time>
      {#if review.store === 'googleplay'}<span class="faint"> (first seen)</span>{/if}
      {#if edited}<span class="faint"> · edited {timeAgo(review.updatedAt, now)}</span>{/if}
    </span>
  </header>

  {#if review.title}<h4 class="title">{review.title}</h4>{/if}
  {#if review.body}
    <p class="body">{expanded ? review.body : text.text}</p>
    {#if text.cut}
      <button type="button" class="link sm" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
        {expanded ? 'Show less' : 'Show the whole review'}
      </button>
    {/if}
  {:else}
    <p class="muted body">This review has no text.</p>
  {/if}

  <p class="meta muted">
    {#if review.authorName}<span>{review.authorName}</span>{/if}
    {#each facts as fact (fact)}<span>{fact}</span>{/each}
  </p>

  {#if review.developerResponse && response}
    <div class="response">
      <p class="response-head">
        <Icon name="message" size={14} />
        <strong>Developer response</strong>
        <span class="muted">
          {#if review.developerResponse.at !== null}{timeAgo(review.developerResponse.at, now)}{/if}
          {#if review.developerResponse.state} · {review.developerResponse.state}{/if}
        </span>
      </p>
      <p class="body">{responseExpanded ? review.developerResponse.body : response.text}</p>
      {#if response.cut}
        <button type="button" class="link sm" aria-expanded={responseExpanded} onclick={() => (responseExpanded = !responseExpanded)}>
          {responseExpanded ? 'Show less' : 'Show the whole response'}
        </button>
      {/if}
    </div>
  {/if}

  {#if assignee || review.internalNote}
    <div class="internal">
      <p class="internal-head"><Icon name="lock" size={14} /> <strong>Internal</strong> <span class="muted">(only your team sees this)</span></p>
      {#if assignee}<p class="note">Assigned to {assignee}.</p>{/if}
      {#if review.internalNote}<p class="note body">{review.internalNote}</p>{/if}
    </div>
  {/if}

  {#if canTriage}
    {#if editing}
      <form
        class="triage"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="triage-row">
          <div class="field">
            <label for="{uid}-status">Status</label>
            <select id="{uid}-status" bind:value={draft.status} disabled={saving}>
              {#each statusOrder as status (status)}<option value={status}>{statusLabel(status)}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-assignee">Assigned to</label>
            <select id="{uid}-assignee" bind:value={draft.assigneeUserId} disabled={saving}>
              <option value="">Nobody</option>
              {#each members as member (member.userId)}<option value={member.userId}>{member.displayName}</option>{/each}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="{uid}-note">Internal note</label>
          <textarea id="{uid}-note" rows="3" maxlength={MAX_NOTE_LENGTH} bind:value={draft.internalNote} disabled={saving} aria-describedby="{uid}-note-hint"></textarea>
          <p class="hint" id="{uid}-note-hint">Only visible here. It is never sent to the store.</p>
        </div>
        {#if draft.status === 'replied_in_console'}
          <p class="hint">This only records that someone answered in the store’s own console. Nothing is sent from here.</p>
        {/if}
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
        <div class="row">
          <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty}>Save</Button>
          <Button size="sm" disabled={saving} onclick={() => (editing = false)}>Cancel</Button>
        </div>
      </form>
    {:else}
      <div class="row">
        <Button size="sm" icon="edit" onclick={open}>Triage</Button>
        {#if review.status === 'new'}
          <Button size="sm" variant="ghost" disabled={saving} onclick={markTriaged}>Mark triaged</Button>
        {/if}
      </div>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    {/if}
  {/if}
</article>

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .review.low {
    border-left: 3px solid var(--bad);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .stars {
    display: inline-flex;
    color: var(--warn);
  }

  .when {
    margin-left: auto;
    font-size: var(--text-sm);
  }

  .faint {
    color: var(--faint);
  }

  .title {
    margin: 0;
    font-size: var(--text-base);
    overflow-wrap: anywhere;
  }

  /* Customer text: plain, wrapped, line breaks kept. */
  .body {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }

  .response,
  .internal {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }

  .response-head,
  .internal-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  .note {
    font-size: var(--text-sm);
  }

  .triage {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .triage-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
  }
</style>
