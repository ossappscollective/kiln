<!--
  EmptyState: what to show when a list has nothing yet.
  Props: icon? (icon name), title, description?, actions? (snippet, usually one primary Button).
  Say what the space is for and give the next step.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  let {
    icon,
    title,
    description,
    actions,
  }: { icon?: IconName | undefined; title: string; description?: string | undefined; actions?: Snippet | undefined } = $props();
</script>

<div class="empty-state">
  {#if icon}<span class="empty-icon"><Icon name={icon} size={22} /></span>{/if}
  <h3>{title}</h3>
  {#if description}<p>{description}</p>{/if}
  {#if actions}<div class="empty-actions row">{@render actions()}</div>{/if}
</div>
