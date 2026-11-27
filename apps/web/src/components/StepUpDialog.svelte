<!--
  StepUpDialog: asks the person to confirm ONE hard action again, with a passkey (Touch ID, Face ID, Windows Hello, a
  security key) their password or a one-time recovery code (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md).
  It sends nothing but the confirmation: `onGranted(grant)` is called once with the short-lived, single-use grant and the
  caller repeats ITS OWN call with it. Every sentence for a failure comes from a fixed code, never from the browser.
  A web view that offers no passkeys (the desktop app's shell may not) gets the password form and a note.
  An authenticator app code or an emailed code can confirm too (docs/api/two-factor.md).
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
    recoveryCodeHint,
    passkeyOnlyButUnsupported,
    primaryFactor,
    recoveryCodeComplete,
    recoveryFailureMessage,
    formatRecoveryCode,
    requestOptionsFromServer,
    stepUpActionLabel,
    webauthnFailureMessage,
    webauthnSupported,
  } from '../lib/step-up.ts';
  import { codeComplete, resendIn, twoFactorProblem } from '../lib/two-factor.ts';
  import { confirmSentence, stepUpValidity } from '../lib/auth-copy.ts';
  import { t } from '../lib/i18n/t.ts';
  import T from './ui/T.svelte';
  import './auth-form.css';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import TextField from './ui/TextField.svelte';
  import { useNow } from '../lib/app-state/clock.svelte.ts';

  let {
    open = $bindable(true),
    api,
    workspaceId,
    email,
    action,
    target = {},
    factors,
    onGranted,
    oncancel,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    /** The signed-in person: a password manager needs a username next to a password field to offer the right entry. */
    email?: string | undefined;
    action: string;
    target?: StepUpTarget | undefined;
    factors: readonly StepUpFactor[];
    onGranted: (grant: string) => void;
    oncancel: () => void;
  } = $props();

  const supported = webauthnSupported(typeof window === 'undefined' ? {} : window);
  const first = $derived(primaryFactor(factors, supported));
  const stuck = $derived(passkeyOnlyButUnsupported(factors, supported));
  const hasPassword = $derived(factors.indexOf('password') >= 0);
  const hasPasskey = $derived(factors.indexOf('passkey') >= 0 && supported);
  const hasRecovery = $derived(factors.indexOf('recovery') >= 0);
  const hasTotp = $derived(factors.indexOf('totp') >= 0);
  const hasEmail = $derived(factors.indexOf('email') >= 0);

  // The way the person chose to switch to; null means the first offered way.
  let chosen = $state<StepUpFactor | null>(null);
  let password = $state('');
  let recoveryCode = $state('');
  let totpCode = $state('');
  let emailCode = $state('');
  let emailSent = $state<{ to: string; at: number; wait: number } | null>(null);
  const clock = useNow({ everyMs: 1000, while: () => emailSent !== null });
  const now = $derived(clock.value);
  let busy = $state(false);
  let problem = $state('');
  let settled = false;

  const current = $derived<StepUpFactor | undefined>(chosen ?? first ?? (hasRecovery ? 'recovery' : undefined));
  const showPasskey = $derived(hasPasskey && current === 'passkey');
  const showPassword = $derived(hasPassword && current === 'password');
  const showRecovery = $derived(hasRecovery && current === 'recovery');
  const showTotp = $derived(hasTotp && current === 'totp');
  const showEmail = $derived(hasEmail && current === 'email');
  const emailWait = $derived(emailSent ? resendIn(emailSent.at, emailSent.wait, now) : 0);
  const switchTo = (factor: StepUpFactor) => () => {
    chosen = factor;
    problem = '';
  };

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

  async function withRecovery(event: Event) {
    event.preventDefault();
    if (busy || !recoveryCodeComplete(recoveryCode)) return;
    busy = true;
    problem = '';
    try {
      const done = await api.stepUpVerify(workspaceId, { factor: 'recovery', action, target, code: formatRecoveryCode(recoveryCode) });
      recoveryCode = '';
      finish(done.grant);
    } catch (error) {
      recoveryCode = '';
      problem = recoveryFailureMessage(error) ?? (error instanceof ApiError ? error.message : webauthnFailureMessage(error));
    } finally {
      busy = false;
    }
  }

  async function withCode(factor: 'totp' | 'email', typed: string) {
    if (busy || !codeComplete(typed)) return;
    busy = true;
    problem = '';
    try {
      const done = await api.stepUpVerify(workspaceId, { factor, action, target, code: typed.replace(/\D+/g, '') });
      totpCode = '';
      emailCode = '';
      finish(done.grant);
    } catch (error) {
      totpCode = '';
      emailCode = '';
      problem = twoFactorProblem(error);
    } finally {
      busy = false;
    }
  }

  async function sendEmailCode() {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      const sent = await api.stepUpEmailCode(workspaceId, { action, target });
      emailSent = { to: sent.to, at: clock.touch(), wait: sent.resendAfterSeconds };
      emailCode = '';
    } catch (error) {
      problem = twoFactorProblem(error);
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
  title={t('auth:stepUp.title', { action: stepUpActionLabel(action) })}
  description={confirmSentence(factors, supported)}
  dismissible={!busy}
  onclose={closed}
>
  <div class="stack readable-form">
    {#if stuck}
      <Alert tone="warn" title={t('auth:stepUp.stuckTitle')}>{t('auth:stepUp.stuckBody')}</Alert>
    {/if}

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}

    {#if showPasskey}
      <p class="muted">{t('auth:stepUp.passkeyHint')}</p>
      <Button variant="primary" size="lg" block icon="key" loading={busy} disabled={busy} onclick={withPasskey}>{t('auth:stepUp.passkeyButton')}</Button>
    {/if}

    {#if showPassword}
      <form class="stack" onsubmit={withPassword}>
        <!-- Not shown, but present for password managers (a login form is a username and a password). -->
        <input class="visually-hidden" type="text" name="username" autocomplete="username" value={email ?? ''} readonly tabindex="-1" aria-hidden="true" />
        <TextField id="step-up-password" name="password" label={t('auth:login.password')} type="password" reveal bind:value={password} autocomplete="current-password" required disabled={busy} />
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || password === ''}>{t('auth:stepUp.confirm')}</Button>
      </form>
    {/if}

    {#if showRecovery}
      <form class="stack" onsubmit={withRecovery}>
        <TextField
          label={t('auth:secondFactor.recoveryCode')}
          bind:value={recoveryCode}
          hint={recoveryCodeHint()}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          required
          disabled={busy}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || !recoveryCodeComplete(recoveryCode)}>{t('auth:stepUp.confirm')}</Button>
      </form>
    {/if}

    {#if showTotp}
      <form class="stack" onsubmit={(event) => { event.preventDefault(); void withCode('totp', totpCode); }}>
        <TextField id="step-up-totp" name="totp" label={t('auth:stepUp.totpLabel')} bind:value={totpCode} inputmode="numeric" autocomplete="one-time-code" placeholder="123456" hint={t('auth:stepUp.totpHint')} required disabled={busy} />
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || !codeComplete(totpCode)}>{t('auth:stepUp.confirm')}</Button>
      </form>
    {/if}

    {#if showEmail}
      {#if emailSent}
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void withCode('email', emailCode); }}>
          <p class="muted"><T key="auth:stepUp.emailSent" params={{ to: emailSent.to }} /></p>
          <TextField id="step-up-otp-email" name="otp" label={t('auth:stepUp.emailCodeLabel')} bind:value={emailCode} inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required disabled={busy} />
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || !codeComplete(emailCode)}>{t('auth:stepUp.confirm')}</Button>
          <p class="quiet-links"><Button variant="link" disabled={busy || emailWait > 0} onclick={sendEmailCode}>{emailWait > 0 ? t('settings:twoFactor.sendAgainIn', { seconds: emailWait }) : t('settings:twoFactor.sendAgain')}</Button></p>
        </form>
      {:else}
        <p class="muted">{t('auth:stepUp.emailIntro')}</p>
        <Button variant="primary" size="lg" block icon="mail" loading={busy} disabled={busy} onclick={sendEmailCode}>{t('settings:twoFactor.emailMe')}</Button>
      {/if}
    {/if}

    {#if current !== undefined && (hasPasskey || hasPassword || hasRecovery || hasTotp || hasEmail)}
      <p class="quiet-links">
        {#if hasPasskey && current !== 'passkey'}<Button variant="link" disabled={busy} onclick={switchTo('passkey')}>{t('auth:stepUp.usePasskey')}</Button>{/if}
        {#if hasPassword && current !== 'password'}<Button variant="link" disabled={busy} onclick={switchTo('password')}>{t('auth:stepUp.usePassword')}</Button>{/if}
        {#if hasTotp && current !== 'totp'}<Button variant="link" disabled={busy} onclick={switchTo('totp')}>{t('auth:stepUp.useTotp')}</Button>{/if}
        {#if hasEmail && current !== 'email'}<Button variant="link" disabled={busy} onclick={switchTo('email')}>{t('settings:twoFactor.emailMe')}</Button>{/if}
        {#if hasRecovery && current !== 'recovery'}<Button variant="link" disabled={busy} onclick={switchTo('recovery')}>{t('auth:otherWay.recovery')}</Button>{/if}
      </p>
    {/if}

    {#if current !== undefined}<p class="quiet">{stepUpValidity()}</p>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
  {/snippet}
</Modal>
