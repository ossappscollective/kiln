<!--
  Badge: a short status label.
  Props: tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent', dot (adds a status dot),
  icon? (an icon name drawn before the text instead of the dot; decorative, the text still says
  the status). Never rely on color alone: the text must say the status.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '../../lib/icons.ts';
  import Icon from './Icon.svelte';

  let {
    tone = 'neutral',
    dot = false,
    icon,
    children,
  }: {
    tone?: 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent' | undefined;
    dot?: boolean | undefined;
    icon?: IconName | undefined;
    children: Snippet;
  } = $props();
</script>

<span class="badge {tone === 'neutral' ? '' : tone}" class:dot={dot && !icon}>
  {#if icon}<Icon name={icon} size={12} />{/if}{@render children()}
</span>
