<!--
  Disclosure: a collapsed part of a screen with a one-line summary that is always visible. The head is
  a real button (aria-expanded, aria-controls); the body is only drawn while open. Use it for what a
  person needs only now and then: details, notes, older items.
  Props: summary (a string, or a snippet for rich content), meta? (snippet, muted text at the right of
  the head), open (bindable), stateKey? (an in-memory key, so the choice is kept while the person moves
  between tabs; see lib/disclosure-state.ts), variant = 'plain' | 'boxed', children (the body).
-->
<script lang="ts">
  import { type Snippet, untrack } from 'svelte';
  import { rememberExpanded, recallExpanded } from '../../lib/disclosure-state.ts';
  import Icon from './Icon.svelte';

  let {
    summary,
    meta,
    open = $bindable(false),
    stateKey,
    variant = 'plain',
    children,
  }: {
    summary: string | Snippet;
    meta?: Snippet;
    open?: boolean;
    stateKey?: string;
    variant?: 'plain' | 'boxed';
    children: Snippet;
  } = $props();

  const uid = $props.id();

  // The remembered choice wins over the default, once, when the part is first drawn.
  const remembered = untrack(() => recallExpanded(stateKey));
  if (remembered !== undefined) open = remembered;

  function toggle() {
    open = !open;
    rememberExpanded(stateKey, open);
  }
</script>

<div class="disclosure {variant}" class:open>
  <button type="button" class="bare head" aria-expanded={open} aria-controls="{uid}-body" onclick={toggle}>
    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
    <span class="summary">{#if typeof summary === 'string'}{summary}{:else}{@render summary()}{/if}</span>
    {#if meta}<span class="meta">{@render meta()}</span>{/if}
  </button>
  {#if open}
    <div class="body" id="{uid}-body">{@render children()}</div>
  {/if}
</div>

<style>
  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    min-height: var(--control-sm);
    padding: 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .head:hover {
    background: var(--surface-hover);
  }

  .head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .head :global(.icon) {
    flex: none;
    color: var(--muted);
  }

  .summary {
    flex: 0 1 auto;
    min-width: 0;
  }

  .meta {
    margin-left: auto;
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    color: var(--muted);
  }

  .body {
    padding: var(--space-2) var(--space-1) var(--space-1) var(--space-6);
  }

  .boxed {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .boxed .head {
    padding: 0 var(--space-3);
    min-height: var(--control-md);
  }

  .boxed .body {
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--line);
  }
</style>
