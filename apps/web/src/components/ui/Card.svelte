<!--
  Card: a bordered surface for a group of related content.
  Props: title?, description?, actions? (snippet, header right), flush (no padding, for tables
  and lists), raised (stronger shadow). Without a title there is no header.
  Collapsible: give `collapseKey` (unique on the page) and the card becomes a Section (ui/Section.svelte): the title is the toggle,
  the state is remembered, `summary` and `count` show while it is collapsed, `defaultOpen` sets the first state; the description
  moves into the body and the actions show while open.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Section from './Section.svelte';

  let {
    title,
    description,
    actions,
    flush = false,
    raised = false,
    collapseKey,
    summary,
    count,
    defaultOpen = true,
    children,
  }: {
    title?: string | undefined;
    description?: string | undefined;
    actions?: Snippet | undefined;
    flush?: boolean | undefined;
    raised?: boolean | undefined;
    collapseKey?: string | undefined;
    summary?: string | undefined;
    count?: number | string | undefined;
    defaultOpen?: boolean | undefined;
    children: Snippet;
  } = $props();
</script>

{#if collapseKey !== undefined && title}
  <Section {title} key={collapseKey} {summary} {count} {defaultOpen} {flush} {actions}>
    {#if description}<p class="desc">{description}</p>{/if}
    {@render children()}
  </Section>
{:else}
<section class="card" class:flush class:raised>
  {#if title}
    <div class="card-header" class:padded={flush}>
      <div>
        <h3>{title}</h3>
        {#if description}<p>{description}</p>{/if}
      </div>
      {#if actions}<div class="row">{@render actions()}</div>{/if}
    </div>
  {/if}
  {@render children()}
</section>
{/if}

<style>
  .desc {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .card-header.padded {
    padding: var(--space-4) var(--space-5);
    margin-bottom: 0;
    border-bottom: 1px solid var(--line);
  }
</style>
