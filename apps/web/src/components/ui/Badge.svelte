<!--
  Badge: a short status label.
  Props: tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent', dot (adds a status dot).
  Never rely on color alone: the text must say the status.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    tone = 'neutral',
    dot = false,
    children,
  }: {
    tone?: 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';
    dot?: boolean;
    children: Snippet;
  } = $props();
</script>

<span class="badge {tone === 'neutral' ? '' : tone}" class:dot>{@render children()}</span>
