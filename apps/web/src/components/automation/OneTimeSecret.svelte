<!--
  OneTimeSecret: shows a secret that the server will never show again (an API token, a webhook
  signing secret) with a copy button and a clear warning. It lives only in this component's memory:
  dismissing it forgets the value. Props: title, label (what the value is called), value, warning
  (what to do and what a leak means), ondismiss, children? (extra help below, such as an example).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
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
  }: { title: string; label: string; value: string; warning: string; ondismiss: () => void; children?: Snippet } = $props();

  const uid = $props.id();
  let heading = $state<HTMLElement>();

  // Move focus here when it appears, so a screen reader reads the warning first.
  $effect(() => {
    heading?.focus();
  });
</script>

<div class="card box" role="region" aria-labelledby="{uid}-title">
  <h3 id="{uid}-title" tabindex="-1" bind:this={heading}>{title}</h3>
  <Alert tone="warn" title="Copy it now. It is shown only once.">{warning}</Alert>
  <div class="row">
    <label class="visually-hidden" for="{uid}-value">{label}</label>
    <input id="{uid}-value" value={value} readonly autocomplete="off" spellcheck="false" onfocus={(e) => e.currentTarget.select()} />
    <CopyButton {value} label="Copy" variant="secondary" size="md" />
  </div>
  {#if children}{@render children()}{/if}
  <div class="row">
    <Button onclick={ondismiss}>I have copied it</Button>
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
