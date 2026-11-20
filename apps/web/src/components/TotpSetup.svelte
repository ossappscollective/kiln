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
  import './auth-form.css';

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

<div class="stack readable-form">
  <ol class="steps">
    <li>Open your authenticator app and add an account.</li>
    <li>Scan this code, or type the key below.</li>
    <li>Enter the six digits the app shows.</li>
  </ol>
  <div class="setup">
    <QrCode text={begin.uri} label="QR code to add this account to an authenticator app" />
    <div class="key">
      <span class="quiet">Key for typing it in ({begin.account})</span>
      <div class="keyline">
        <code class="secret">{groupSecret(begin.secret)}</code>
        <CopyButton value={begin.secret} label="Copy the key" />
      </div>
    </div>
  </div>
  <form class="stack" onsubmit={submit}>
    <TextField
      id="totp-setup-code"
      name="totp"
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
    <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || !codeComplete(code)}>Verify and turn on</Button>
    <p class="quiet-links"><Button variant="link" disabled={busy} onclick={oncancel}>Cancel</Button></p>
  </form>
</div>

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-left: var(--space-6);
    margin: 0;
    font-size: 1rem;
    line-height: 1.5;
  }

  .steps li::marker {
    font-weight: var(--weight-semibold);
    color: var(--accent);
  }

  .setup {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: center;
    padding: var(--space-4);
    background: var(--surface-sunken);
    border-radius: var(--radius-lg);
  }

  .key {
    display: flex;
    flex: 1 1 12rem;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .keyline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .secret {
    font-size: 1rem;
    font-weight: var(--weight-semibold);
    letter-spacing: 0.05em;
    word-break: break-all;
    user-select: all;
  }
</style>
