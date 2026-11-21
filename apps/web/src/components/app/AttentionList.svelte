<!--
  AttentionList: "Needs attention" on the dashboard of an app: one line per thing to look at, most
  serious first, each with a link to where it is handled. Drawn only when there is something to show.
  An item with `submitAppId` ("Draft pushed — ready to submit?") shows the submit control of that app
  (SubmitReady, bare) instead of a link; it is only built for admin and up.
  Only the first three lines are shown (and every urgent one, whatever its place); the rest is one "Show N more" button, so
  the Next step card stays short. On the Overview it is its own card, "Also worth a look" (title), with the platform of each line when the
  app has several. Props: items (from attentionItems in lib/app-attention.ts), api, workspaceId, role, members (the app records
  in scope, for the submit control), title?, bare = false (drawn inside the Next step card: no card of its own and a quieter
  "Also needs attention" heading).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import type { AttentionItem } from '../../lib/app-attention.ts';
  import { capItems } from '../../lib/readability.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import SubmitReady from '../listing/SubmitReady.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    items,
    api,
    workspaceId,
    role,
    members,
    bare = false,
    title,
  }: { items: AttentionItem[]; api: Api; workspaceId: string; role: Role; members: AppSummary[]; bare?: boolean | undefined; title?: string | undefined } = $props();

  /** The platform an item is about (its id starts with the app record's id), only when the app has more than one. */
  const platformOf = (item: AttentionItem) =>
    members.length > 1 ? members.find((m) => item.id.startsWith(`${m.id}:`))?.platform ?? null : null;

  const LIMIT = 3;
  let all = $state(false);
  const capped = $derived(capItems(items, LIMIT));
  const listed = $derived(all ? items : capped.shown);
</script>

<section class="attention" class:card={!bare} class:bare aria-labelledby="attention-title">
  <div class="head">
    <h2 id="attention-title">{title ?? (bare ? 'Also needs attention' : 'Needs attention')}</h2>
    <Badge tone={items.some((i) => i.tone === 'bad') ? 'bad' : 'warn'}>{items.length}</Badge>
  </div>
  <ul>
    {#each listed as item (item.id)}
      <li class={item.tone}>
        <span class="mark"><Icon name={item.icon} size={16} /></span>
        <div class="text">
          <p class="line">
            {#if platformOf(item)}<span class="on"><PlatformBadge platform={platformOf(item) as string} /></span>{/if}
            {item.text}
          </p>
          {#if item.detail}<p class="detail muted">{item.detail}</p>{/if}
        </div>
        {#if item.href}<a class="go" href={item.href}>{item.action}</a>{/if}
        {#if item.submitAppId}
          {@const target = members.find((m) => m.id === item.submitAppId)}
          {#if target}<div class="go"><SubmitReady {api} {workspaceId} {role} app={target} bare /></div>{/if}
        {/if}
      </li>
    {/each}
  </ul>
  {#if capped.hidden.length > 0}
    <button type="button" class="more-toggle" aria-expanded={all} onclick={() => (all = !all)}>
      {all ? 'Show fewer' : `Show ${capped.hidden.length} more`}
    </button>
  {/if}
</section>

<style>
  .attention:not(.bare) {
    padding: var(--space-5) var(--space-6);
    border-radius: var(--radius-xl);
  }

  .bare {
    padding-top: var(--space-3);
  }

  .bare h2 {
    font-size: var(--text-base);
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  ul {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-1) var(--space-3);
    align-items: start;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }

  li:first-child {
    border-top: 0;
  }

  .mark {
    display: inline-flex;
    margin-top: 2px;
  }

  li.bad .mark {
    color: var(--bad);
  }

  li.warn .mark {
    color: var(--warn);
  }

  li.info .mark {
    color: var(--info);
  }

  .line {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
  }

  .on {
    margin-right: var(--space-2);
    font-size: var(--text-sm);
    vertical-align: middle;
  }

  .detail {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .go {
    grid-column: 3;
    font-size: var(--text-base);
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .go {
      grid-column: 2;
    }
  }

  .more-toggle {
    padding: var(--space-2) 0 0;
    font: inherit;
    font-size: var(--text-base);
    color: var(--accent);
    cursor: pointer;
    background: none;
    border: 0;
  }

  .more-toggle:hover {
    text-decoration: underline;
  }
</style>
