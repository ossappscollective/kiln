<!--
  Section: the one collapsible part of a page (a card or a plain block with a heading). The head is a real button inside the heading
  (aria-expanded, aria-controls; Enter and Space work); the body is only drawn while open unless keepMounted. The state is remembered
  per workspace, person, page and `key` (lib/section-state.ts) and falls back to defaultOpen. While collapsed the head shows a one-line
  summary ("12 locales · 3 need attention") and the count; the actions (right side) show only while open. With three or more
  sections on a page, SectionsToggle offers Collapse all and Expand all.
  Props: title, key (unique on the page; add the platform or the group to it when several are drawn), level? = 3 (heading level),
  count? (a number or a short text, a chip beside the title), summary? (string or snippet, shown while collapsed), defaultOpen = true,
  variant = 'card' | 'plain', flush? (a card whose body has no padding: tables and lists), keepMounted? (the body stays in the page,
  hidden, while collapsed), actions? (snippet, right side of the head), edge? (a summary card: the 2px brand-gradient top edge, `.accent-edge`),
  onchange? (open), children (the body).
-->
<script lang="ts">
  import { type Snippet, onMount, untrack } from 'svelte';
  import { sectionHost } from '../../lib/section-host.svelte.ts';
  import Icon from './Icon.svelte';

  let {
    title,
    key,
    level = 3,
    count,
    summary,
    defaultOpen = true,
    variant = 'card',
    flush = false,
    keepMounted = false,
    edge = false,
    actions,
    onchange,
    children,
  }: {
    title: string;
    key: string;
    level?: 2 | 3 | 4 | undefined;
    count?: number | string | undefined;
    summary?: string | Snippet | undefined;
    defaultOpen?: boolean | undefined;
    variant?: 'card' | 'plain' | undefined;
    flush?: boolean | undefined;
    keepMounted?: boolean | undefined;
    edge?: boolean | undefined;
    actions?: Snippet | undefined;
    onchange?: ((open: boolean) => void) | undefined;
    children: Snippet;
  } = $props();

  const uid = $props.id();
  const host = sectionHost();

  // The remembered choice wins over the default, once, when the section is first drawn.
  let open = $state(untrack(() => host?.read(key, defaultOpen) ?? defaultOpen));

  function toggle() {
    open = !open;
    host?.write(key, open);
    host?.update(uid, open);
    onchange?.(open);
  }

  onMount(() =>
    host?.register(uid, key, open, (next) => {
      open = next;
      onchange?.(next);
    }),
  );

  $effect(() => {
    host?.update(uid, open);
  });

  const hasSummary = $derived(summary !== undefined && summary !== '');
</script>

<section class="section {variant}" class:open class:flush class:accent-edge={edge && variant === 'card'} aria-labelledby="{uid}-title">
  <div class="head">
    <svelte:element this={`h${level}`} class="heading" id="{uid}-title">
      <button type="button" class="bare toggle" aria-expanded={open} aria-controls="{uid}-body" onclick={toggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span class="title">{title}</span>
        {#if count !== undefined && count !== ''}<span class="count">{count}</span>{/if}
        {#if !open && hasSummary}
          <span class="summary">{#if typeof summary === 'string'}{summary}{:else if summary}{@render summary()}{/if}</span>
        {/if}
      </button>
    </svelte:element>
    {#if actions && open}<div class="row actions">{@render actions()}</div>{/if}
  </div>
  {#if open || keepMounted}
    <div class="body" id="{uid}-body" hidden={!open}>{@render children()}</div>
  {/if}
</section>

<style>
  .section.card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .card .head {
    padding: var(--space-1) var(--space-3);
    min-height: var(--control-lg, 2.5rem);
  }

  .heading {
    flex: 1 1 12rem;
    min-width: 0;
    font-size: var(--text-md);
  }

  .toggle {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    min-height: var(--control-sm);
    padding: 0 var(--space-1);
    font: inherit;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .toggle:hover {
    background: var(--surface-hover);
  }

  .toggle:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .toggle :global(.icon) {
    flex: none;
    color: var(--muted);
  }

  .title {
    font-weight: var(--weight-semibold);
    letter-spacing: -0.01em;
  }

  .count {
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: 1.25rem;
    color: var(--muted);
    background: var(--surface-sunken);
    border-radius: var(--radius-full);
  }

  .summary {
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .actions {
    flex: none;
  }

  .body {
    padding: var(--space-3) var(--space-1) var(--space-1);
  }

  .body[hidden] {
    display: none;
  }

  .card .body {
    padding: var(--space-4);
    border-top: 1px solid var(--line);
  }

  .card.flush .body {
    padding: 0;
    overflow: hidden;
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
</style>
