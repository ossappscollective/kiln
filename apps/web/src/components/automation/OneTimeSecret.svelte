<!--
  OneTimeSecret: shows a secret that the server will never show again (an API token, a webhook
  signing secret) with a copy button and a clear warning. It lives only in this component's memory:
  dismissing it forgets the value. Props: title, label (what the value is called), value, warning
  (what to do and what a leak means), ondismiss, children? (extra help below, such as an example).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';

  let {
    title,
    label,
    value,
    warning,
    ondismiss,
    children,
  }: { title: string; label: string; value: string; warning: string; ondismiss: () => void; children?: Snippet | undefined } = $props();

  const uid = $props.id();
  let heading = $state<HTMLElement>();

  // Move focus here when it appears, so a screen reader reads the warning first.
  $effect(() => {
    heading?.focus();
  });
</script>

<div class="card box" role="region" aria-labelledby="{uid}-title">
  <h3 id="{uid}-title" tabindex="-1" bind:this={heading}>{title}</h3>
  <Alert tone="warn" title={t('workspace:secret.copyNow')}>{warning}</Alert>
  <div class="row">
    <label class="visually-hidden" for="{uid}-value">{label}</label>
    <input id="{uid}-value" value={value} readonly autocomplete="off" spellcheck="false" onfocus={(e) => e.currentTarget.select()} />
    <CopyButton {value} label={t('workspace:secret.copy')} variant="secondary" size="md" />
  </div>
  {#if children}{@render children()}{/if}
  <div class="row">
    <Button onclick={ondismiss}>{t('workspace:secret.copied')}</Button>
  </div>
</div>

<style>
  .box {
    display: grid;
    gap: 12px;
    border-color: var(--warn-line);
  }

  h3:focus {
    outline: none;
  }

  .row input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
