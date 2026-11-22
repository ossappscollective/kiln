<!--
  CopyButton: copies `value` to the clipboard and says so. Falls back to a hidden textarea and
  execCommand where the async Clipboard API is unavailable (plain http, older webviews).
  Props: value, label (default: the translated "Copy"), copiedLabel (default: "Copied"), iconOnly (square, label becomes the
  accessible name), size = 'sm' | 'md', variant = 'ghost' | 'secondary', oncopy?, onerror?.
  The feedback is read aloud through a live region and resets after 2 seconds.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import Button from './Button.svelte';

  let {
    value,
    label,
    copiedLabel,
    iconOnly = false,
    size = 'sm',
    variant = 'ghost',
    oncopy,
    onerror,
  }: {
    value: string;
    label?: string | undefined;
    copiedLabel?: string | undefined;
    iconOnly?: boolean | undefined;
    size?: 'sm' | 'md' | undefined;
    variant?: 'ghost' | 'secondary' | undefined;
    oncopy?: (() => void) | undefined;
    onerror?: (() => void) | undefined;
  } = $props();

  let state = $state<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;

  function fallbackCopy(text: string): boolean {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(area);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    previous?.focus();
    return ok;
  }

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = fallbackCopy(value);
    state = ok ? 'copied' : 'failed';
    if (ok) oncopy?.();
    else onerror?.();
    clearTimeout(timer);
    timer = setTimeout(() => (state = 'idle'), 2000);
  }

  onDestroy(() => clearTimeout(timer));

  const labelText = $derived(label ?? t('common:action.copy'));
  const copiedText = $derived(copiedLabel ?? t('common:action.copied'));
  const shown = $derived(state === 'copied' ? copiedText : state === 'failed' ? t('common:copy.failed') : labelText);
</script>

<Button
  {variant}
  {size}
  {iconOnly}
  icon={state === 'copied' ? 'check' : 'copy'}
  label={iconOnly ? shown : undefined}
  onclick={copy}
>
  {#if !iconOnly}{shown}{/if}
</Button>
<span class="visually-hidden" role="status">{state === 'copied' ? copiedText : state === 'failed' ? t('common:copy.failed') : ''}</span>
