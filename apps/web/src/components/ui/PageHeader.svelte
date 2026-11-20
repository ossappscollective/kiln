<!--
  PageHeader: the title block at the top of a screen.
  Props: title, description?, actions? (snippet of buttons, aligned right), level = 1 | 2 (heading
  level; use 1 for the screen's title, 2 inside tabs or nested views).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    actions,
    level = 1,
  }: { title: string; description?: string | undefined; actions?: Snippet | undefined; level?: 1 | 2 | undefined } = $props();
</script>

<header class="page-header">
  <div>
    {#if level === 1}
      <h1 class="page-title">{title}</h1>
    {:else}
      <h2 class="page-title">{title}</h2>
    {/if}
    {#if description}<p class="page-desc">{description}</p>{/if}
  </div>
  {#if actions}<div class="page-actions">{@render actions()}</div>{/if}
</header>
