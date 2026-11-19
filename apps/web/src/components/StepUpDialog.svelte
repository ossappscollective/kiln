<!--
  StepUpDialog: asks the person to confirm ONE hard action again, with a passkey (Touch ID, Face ID, Windows Hello, a
  security key) or their password (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md).
  It sends nothing but the confirmation: `onGranted(grant)` is called once with the short-lived, single-use grant and the
  caller repeats ITS OWN call with it. Every sentence for a failure comes from a fixed code, never from the browser.
  A web view that offers no passkeys (the desktop app's shell may not) gets the password form and a note.
  Props: open (bindable), api, workspaceId, action, target ({ id?, hash? }), factors (the ways the server offered),
  onGranted(grant), oncancel().
-->
<script lang="ts">
  import { ApiError, type Api } from '../lib/api.ts';
  import {
    type StepUpAction,
    type StepUpFactor,
    type StepUpTarget,
    assertionToServer,
    passkeyOnlyButUnsupported,
    primaryFactor,
    requestOptionsFromServer,
    stepUpActionLabel,
    webauthnFailureMessage,
    webauthnSupported,
  } from '../lib/step-up.ts';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import TextField from './ui/TextField.svelte';

  let {
    open = $bindable(true),
    api,
    workspaceId,
    action,
    target = {},
    factors,
    onGranted,
    oncancel,
  }: {
    open?: boolean;
    api: Api;
    workspaceId: string;
    action: string;
    target?: StepUpTarget;
    factors: readonly StepUpFactor[];
    onGranted: (grant: string) => void;
    oncancel: () => void;
  } = $props();

  const supported = webauthnSupported(typeof window === 'undefined' ? {} : window);
  const first = $derived(primaryFactor(factors, supported));
  const stuck = $derived(passkeyOnlyButUnsupported(factors, supported));
  const hasPassword = $derived(factors.indexOf('password') >= 0);
  const hasPasskey = $derived(factors.indexOf('passkey') >= 0 && supported);

  let usePassword = $state(false);
  let password = $state('');
  let busy = $state(false);
  let problem = $state('');
  let settled = false;

  const showPassword = $derived(hasPassword && (usePassword || first === 'password'));

  function finish(grant: string) {
    settled = true;
    open = false;
    onGranted(grant);
  }

  function failed(error: unknown) {
    problem = error instanceof ApiError ? error.message : webauthnFailureMessage(error);
  }

  async function withPasskey() {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      const options = await api.stepUpAssertionOptions(workspaceId, { action: action as StepUpAction, target });
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({ publicKey: requestOptionsFromServer(options.publicKey) as unknown as PublicKeyCredentialRequestOptions });
      } catch (error) {
        failed(error);
        return;
      }
      if (!credential) {
        problem = webauthnFailureMessage(undefined);
        return;
      }
      const assertion = assertionToServer(credential as unknown as Parameters<typeof assertionToServer>[0]);
      const done = await api.stepUpVerify(workspaceId, { factor: 'passkey', action, target, challengeId: options.challengeId, assertion });
      finish(done.grant);
    } catch (error) {
      failed(error);
    } finally {
      busy = false;
    }
  }

  async function withPassword(event: Event) {
    event.preventDefault();
    if (busy || password === '') return;
    busy = true;
    problem = '';
    try {
      const done = await api.stepUpVerify(workspaceId, { factor: 'password', action, target, password });
      password = '';
      finish(done.grant);
    } catch (error) {
      password = '';
      failed(error);
    } finally {
      busy = false;
    }
  }

  function closed() {
    if (!settled) {
      settled = true;
      oncancel();
    }
  }
</script>

<Modal
  bind:open
  size="sm"
  title="Confirm: {stepUpActionLabel(action)}"
  description="This is a hard action, so you are asked once more. The confirmation is good for one use, for a few minutes."
  dismissible={!busy}
  onclose={closed}
>
  <div class="stack">
    {#if stuck}
      <Alert tone="warn" title="This window cannot use passkeys">
        Your passkey cannot be used here (the desktop app's window may not offer passkeys). Open the app in a browser, or set a confirmation
        password in Settings, Security.
      </Alert>
    {/if}

    {#if hasPasskey && !showPassword}
      <p class="muted">Use the passkey on this device (Touch ID, Face ID, Windows Hello) or a security key.</p>
      <Button variant="primary" icon="key" loading={busy} disabled={busy} onclick={withPasskey}>Confirm with Touch ID / passkey</Button>
      {#if hasPassword}
        <p><Button variant="link" disabled={busy} onclick={() => (usePassword = true)}>Use password</Button></p>
      {/if}
    {/if}

    {#if showPassword}
      <form class="stack" onsubmit={withPassword}>
        <TextField label="Password" type="password" reveal bind:value={password} autocomplete="current-password" required disabled={busy} />
        <div class="row">
          <Button type="submit" variant="primary" loading={busy} disabled={busy || password === ''}>Confirm</Button>
          {#if hasPasskey}<Button variant="link" disabled={busy} onclick={() => (usePassword = false)}>Use passkey</Button>{/if}
        </div>
      </form>
    {/if}

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
  {/snippet}
</Modal>
