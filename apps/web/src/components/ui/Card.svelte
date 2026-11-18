<!--
  Card: a bordered surface for a group of related content.
  Props: title?, description?, actions? (snippet, header right), flush (no padding, for tables
  and lists), raised (stronger shadow). Without a title there is no header.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    actions,
    flush = false,
    raised = false,
    children,
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    flush?: boolean;
    raised?: boolean;
    children: Snippet;
  } = $props();
</script>

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

<style>
  .card-header.padded {
    padding: var(--space-4) var(--space-5);
    margin-bottom: 0;
    border-bottom: 1px solid var(--line);
  }
</style>
