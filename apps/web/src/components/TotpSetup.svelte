<!--
  TotpSetup: the second half of setting up an authenticator app: the QR code, the same secret as text (for an app that cannot scan),
  and the field for the first code it shows. Presentational: the caller makes the calls (the Security card, or the sign-in
  step that is required by policy) and shows its own errors through `problem`.
  Props: begin ({ secret, uri, issuer, account }), busy, problem, onconfirm(code), oncancel().
-->
<script lang="ts">
  import { codeComplete, groupSecret, type TotpBegin } from '../lib/two-factor.ts';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import CopyButton from './ui/CopyButton.svelte';
  import TextField from './ui/TextField.svelte';
  import QrCode from './QrCode.svelte';

  let {
    begin,
    busy = false,
    problem = '',
    onconfirm,
    oncancel,
  }: { begin: TotpBegin; busy?: boolean; problem?: string; onconfirm: (code: string) => void; oncancel: () => void } = $props();

  let code = $state('');

  function submit(event: Event) {
    event.preventDefault();
    if (busy || !codeComplete(code)) return;
    onconfirm(code.replace(/\D+/g, ''));
  }
</script>

<div class="stack">
  <ol class="steps">
    <li>Open your authenticator app (1Password, Authy, Google Authenticator, Microsoft Authenticator, Apple Passwords or similar) and add an account.</li>
    <li>Scan this code, or type the key below.</li>
    <li>Enter the six digits the app shows.</li>
  </ol>
  <div class="setup">
    <QrCode text={begin.uri} label="QR code to add this account to an authenticator app" />
    <div class="stack key">
      <span class="muted small">Key for typing it in ({begin.account})</span>
      <code class="secret">{groupSecret(begin.secret)}</code>
      <CopyButton value={begin.secret} label="Copy the key" />
    </div>
  </div>
  <form class="stack" onsubmit={submit}>
    <TextField
      label="Code from the app"
      bind:value={code}
      inputmode="numeric"
      autocomplete="one-time-code"
      placeholder="123456"
      maxlength={7}
      required
      disabled={busy}
    />
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    <div class="row">
      <Button type="submit" variant="primary" loading={busy} disabled={busy || !codeComplete(code)}>Verify and turn on</Button>
      <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    </div>
  </form>
</div>

<style>
  .steps {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .setup {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }

  .key {
    min-width: 12rem;
    max-width: 22rem;
  }

  .secret {
    font-size: var(--text-md);
    letter-spacing: 0.05em;
    word-break: break-all;
    user-select: all;
  }

  .small {
    font-size: var(--text-sm);
  }
</style>
