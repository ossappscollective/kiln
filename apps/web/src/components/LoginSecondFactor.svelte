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
    type CodeSent,
    type LoginChallenge,
    type LoginMethod,
    type TotpBegin,
    codeComplete,
    firstMethod,
    resendIn,
    twoFactorProblem,
  } from '../lib/two-factor.ts';
  import { enrollChoiceHint, otherWayLabel } from '../lib/auth-copy.ts';
  import { t } from '../lib/i18n/t.ts';
  import T from './ui/T.svelte';
  import AuthCard from './AuthCard.svelte';
  import TotpSetup from './TotpSetup.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import TextField from './ui/TextField.svelte';
  import { useNow } from '../lib/app-state/clock.svelte.ts';

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
  const clock = useNow({ everyMs: 1000, while: () => sent !== null });
  const now = $derived(clock.value);
  // The challenge ends the sign-in when the server says so (expired, used up): then only the password step is left.
  let dead = $state(false);


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
      sent = { info, at: clock.touch() };
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
  const showOthers = $derived(!dead && !enrolling && others.length > 0);
  const showBack = $derived(!dead && !(enrolling && !method));
  const title = $derived(enrolling ? t('auth:secondFactor.titleEnroll') : t('auth:secondFactor.titleCheck'));
  const subtitle = $derived(
    enrolling
      ? t('auth:secondFactor.subtitleEnroll')
      : method === 'totp'
        ? t('auth:secondFactor.subtitleTotp')
        : method === 'email'
          ? t('auth:secondFactor.subtitleEmail')
          : t('auth:secondFactor.subtitleRecovery'),
  );
</script>

<AuthCard {title} {subtitle}>
  <div class="stack">
    {#if dead}
      <Alert tone="error">{problem || t('auth:secondFactor.expired')}</Alert>
      <Button variant="primary" size="lg" block onclick={oncancel}>{t('auth:secondFactor.backToSignIn')}</Button>
    {:else if enrolling && !method}
      <p class="quiet">{t('auth:secondFactor.chooseHow')}</p>
      {#each challenge.methods as option (option)}
        <div class="choice">
          <Button size="lg" block onclick={() => choose(option)}>{option === 'totp' ? t('settings:twoFactor.appTitle') : t('settings:twoFactor.emailMe')}</Button>
          <p class="quiet">{enrollChoiceHint(option)}</p>
        </div>
      {/each}
      <p class="quiet-links"><Button variant="link" onclick={oncancel}>{t('common:action.back')}</Button></p>
    {:else if enrolling && method === 'totp'}
      {#if begin}
        <TotpSetup {begin} {busy} {problem} onconfirm={confirmTotp} oncancel={() => (begin = null)} />
      {:else}
        <Button variant="primary" size="lg" block loading={busy} onclick={startTotp}>{t('auth:secondFactor.showQr')}</Button>
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {/if}
      <p class="quiet-links"><Button variant="link" onclick={() => (method = undefined)}>{t('auth:secondFactor.chooseAnother')}</Button></p>
    {:else if method === 'totp' || method === 'recovery' || (method === 'email' && sent)}
      <form class="stack" onsubmit={submit} novalidate>
        {#if method === 'email' && sent}
          <p class="quiet"><T key="settings:twoFactor.codeSent" params={{ to: sent.info.to }} /></p>
        {/if}
        <TextField
          id="second-factor-code"
          name={method === 'recovery' ? 'recovery-code' : 'totp'}
          label={method === 'recovery' ? t('auth:secondFactor.recoveryCode') : t('auth:secondFactor.code')}
          bind:value={code}
          inputmode={method === 'recovery' ? 'text' : 'numeric'}
          autocomplete="one-time-code"
          placeholder={method === 'recovery' ? '' : '123456'}
          required
        />
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
        <Button variant="primary" type="submit" size="lg" block loading={busy} disabled={!ready}>{t('auth:secondFactor.continue')}</Button>
        {#if method === 'email'}
          <p class="quiet-links"><Button variant="link" disabled={busy || wait > 0} onclick={sendEmail}>{wait > 0 ? t('settings:twoFactor.sendAgainIn', { seconds: wait }) : t('settings:twoFactor.sendAgain')}</Button></p>
        {/if}
      </form>
    {:else if method === 'email'}
      <p class="quiet">{t('auth:secondFactor.emailWillSend')}</p>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <Button variant="primary" size="lg" block loading={busy} onclick={sendEmail}>{t('settings:twoFactor.emailMe')}</Button>
    {:else}
      <Alert tone="error">{t('auth:secondFactor.noWay')}</Alert>
    {/if}

    {#if showOthers || showBack}
      <p class="quiet-links">
        {#if showOthers}
          {#each others as other (other)}
            <Button variant="link" onclick={() => choose(other)}>{otherWayLabel(other)}</Button>
          {/each}
        {/if}
        {#if showBack}
          <Button variant="link" onclick={oncancel}>{t('auth:secondFactor.backToSignIn')}</Button>
        {/if}
      </p>
    {/if}
  </div>
</AuthCard>

<style>
  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .choice + .choice {
    margin-top: var(--space-5);
  }
</style>
