<!--
  LoginSecondFactor: the step after the password when this server asks for a second factor (docs/api/two-factor.md,
  docs/adr/0021-two-factor-and-smtp.md). The `challenge` from the password step is the only credential here: it lasts five minutes, is
  kept in memory and never written anywhere. Two modes:
    - check: enter the code from the authenticator app, the code that was emailed, or a recovery code (the fallback if the phone is gone);
    - enroll: the policy requires a second factor and this account has none, so set one up now (authenticator app, or email when the
      server can send mail). Signing in completes when the first code is right.
  Props: api, challenge (LoginChallenge), ondone(), oncancel() (back to the password).
-->
<script lang="ts">
  import { type Api } from '../lib/api.ts';
  import {
    METHOD_LABELS,
    type CodeSent,
    type LoginChallenge,
    type LoginMethod,
    type TotpBegin,
    codeComplete,
    firstMethod,
    resendIn,
    twoFactorProblem,
  } from '../lib/two-factor.ts';
  import AuthCard from './AuthCard.svelte';
  import TotpSetup from './TotpSetup.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import TextField from './ui/TextField.svelte';

  let { api, challenge, ondone, oncancel }: { api: Api; challenge: LoginChallenge; ondone: () => void; oncancel: () => void } = $props();

  const enrolling = $derived(challenge.enrollmentRequired);
  let method = $state<LoginMethod | undefined>(undefined);
  $effect(() => {
    if (method === undefined) method = enrolling ? undefined : firstMethod(challenge.methods);
  });

  let code = $state('');
  let busy = $state(false);
  let problem = $state('');
  let sent = $state<{ info: CodeSent; at: number } | null>(null);
  let begin = $state<TotpBegin | null>(null);
  let now = $state(Date.now());
  // The challenge ends the sign-in when the server says so (expired, used up): then only the password step is left.
  let dead = $state(false);

  $effect(() => {
    if (!sent) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function fail(e: unknown) {
    problem = twoFactorProblem(e);
    if ((e as { code?: unknown } | null)?.code === 'challenge_invalid') dead = true;
  }

  function choose(next: LoginMethod) {
    method = next;
    code = '';
    problem = '';
    sent = null;
    begin = null;
  }

  async function sendEmail() {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      const info = await (enrolling ? api.loginEnrollEmail(challenge.challenge) : api.loginEmailCode(challenge.challenge));
      sent = { info, at: Date.now() };
      now = Date.now();
      code = '';
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function startTotp() {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      begin = await api.loginEnrollTotp(challenge.challenge);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function confirmTotp(typed: string) {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      await api.loginEnrollTotpConfirm(challenge.challenge, typed);
      ondone();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  const ready = $derived(method === 'recovery' ? code.trim().length >= 8 : codeComplete(code));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !method || !ready) return;
    busy = true;
    problem = '';
    try {
      const typed = method === 'recovery' ? code.trim() : code.replace(/\D+/g, '');
      if (enrolling) {
        // Only email reaches here while enrolling (the app has its own confirm step).
        await api.loginEnrollEmailConfirm(challenge.challenge, typed);
      } else {
        await api.loginSecondFactor({ challenge: challenge.challenge, method, code: typed });
      }
      ondone();
    } catch (e) {
      fail(e);
      code = '';
    } finally {
      busy = false;
    }
  }

  const wait = $derived(sent ? resendIn(sent.at, sent.info.resendAfterSeconds, now) : 0);
  const others = $derived(challenge.methods.filter((m) => m !== method));
  const title = $derived(enrolling ? 'Set up a second step' : 'Confirm it is you');
  const subtitle = $derived(
    enrolling
      ? 'Your administrator requires a second step when signing in. Set one up now; it takes a minute.'
      : method === 'totp'
        ? 'Enter the six digits your authenticator app shows.'
        : method === 'email'
          ? 'We email a six digit code to your account address.'
          : 'Enter one of your recovery codes. Each works once.',
  );
</script>

<AuthCard {title} {subtitle}>
  <div class="stack">
    {#if dead}
      <Alert tone="error">{problem || 'This sign-in expired. Sign in again.'}</Alert>
      <Button variant="primary" size="lg" block onclick={oncancel}>Back to sign in</Button>
    {:else if enrolling && !method}
      <p class="muted">Choose how you will get your codes.</p>
      {#each challenge.methods as option (option)}
        <Button size="lg" block onclick={() => choose(option)}>{option === 'totp' ? 'Authenticator app' : 'Email me a code'}</Button>
      {/each}
      <Button variant="ghost" onclick={oncancel}>Back</Button>
    {:else if enrolling && method === 'totp'}
      {#if begin}
        <TotpSetup {begin} {busy} {problem} onconfirm={confirmTotp} oncancel={() => (begin = null)} />
      {:else}
        <Button variant="primary" size="lg" block loading={busy} onclick={startTotp}>Show the QR code</Button>
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {/if}
      <Button variant="ghost" onclick={() => (method = undefined)}>Choose another way</Button>
    {:else if method === 'totp' || method === 'recovery' || (method === 'email' && sent)}
      <form class="stack" onsubmit={submit} novalidate>
        {#if method === 'email' && sent}
          <p class="muted">A code was sent to <strong>{sent.info.to}</strong>. It works once and lasts 10 minutes.</p>
        {/if}
        <TextField
          label={method === 'recovery' ? 'Recovery code' : 'Code'}
          bind:value={code}
          inputmode={method === 'recovery' ? 'text' : 'numeric'}
          autocomplete="one-time-code"
          placeholder={method === 'recovery' ? '' : '123456'}
          required
        />
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
        <Button variant="primary" type="submit" size="lg" block loading={busy} disabled={!ready}>Continue</Button>
        {#if method === 'email'}
          <Button disabled={busy || wait > 0} onclick={sendEmail}>{wait > 0 ? `Send again in ${wait}s` : 'Send again'}</Button>
        {/if}
      </form>
    {:else if method === 'email'}
      <p class="muted">We will email a six digit code to the address on your account.</p>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <Button variant="primary" size="lg" block loading={busy} onclick={sendEmail}>Email me a code</Button>
    {:else}
      <Alert tone="error">There is no way to confirm this sign-in. Ask an owner or admin to reset your second factor.</Alert>
    {/if}

    {#if !dead && !enrolling && others.length > 0}
      <div class="row">
        {#each others as other (other)}
          <Button variant="link" onclick={() => choose(other)}>{METHOD_LABELS[other]}</Button>
        {/each}
      </div>
    {/if}
    {#if !dead && !(enrolling && !method)}
      <Button variant="ghost" onclick={oncancel}>Back to sign in</Button>
    {/if}
  </div>
</AuthCard>
