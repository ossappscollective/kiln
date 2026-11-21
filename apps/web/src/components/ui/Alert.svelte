<!--
  Alert: an inline message with an icon.
  Props: tone = 'info' | 'error' | 'warn' | 'ok', title? (bold first line), ondismiss? (adds a close
  button). Errors use role="alert" (announced at once); the others use role="status".
  Say what happened and what to do next, in plain words.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import Icon from './Icon.svelte';

  let {
    tone = 'info',
    title,
    ondismiss,
    children,
  }: {
    tone?: 'info' | 'error' | 'warn' | 'ok' | undefined;
    title?: string | undefined;
    ondismiss?: (() => void) | undefined;
    children: Snippet;
  } = $props();
</script>

<div class="alert {tone}" role={tone === 'error' ? 'alert' : 'status'}>
  {#if title}<span class="alert-title">{title}</span>{/if}
  {@render children()}
  {#if ondismiss}
    <button type="button" class="alert-close" aria-label={t('common:action.dismiss')} onclick={ondismiss}>
      <Icon name="x" />
    </button>
  {/if}
</div>
