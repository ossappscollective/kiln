<!--
  TwoFactorSettings: "Authenticator app and email" (docs/api/two-factor.md, docs/adr/0021-two-factor-and-smtp.md). Two more ways to
  confirm a hard action, next to passkeys and the password: the six digit code an authenticator app shows, and a six digit code
  emailed to a verified address. On a server with accounts, owners and admins also choose whether SIGNING IN asks for a second
  factor (off, optional, required for owners and admins, required for everyone).
  Changing a factor asks for a fresh confirmation (`confirmed`, like passkeys). The secret and every code are shown here once, in
  memory only, and never stored by the page. Every failure sentence comes from a fixed code.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import {
    LOGIN_MODES,
    type CodeSent,
    type LoginMode,
    type TotpBegin,
    type TwoFactorStatus,
    codeComplete,
    loginModeSummary,
    resendIn,
    twoFactorProblem,
    twoFactorSummary,
  } from '../../lib/two-factor.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';
  import TotpSetup from '../TotpSetup.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const isAdmin = $derived(can(role, 'settings.write'));

  let status = $state<TwoFactorStatus | null>(null);
  let loadError = $state('');
  let problem = $state('');
  let busy = $state(false);

  // Authenticator app: the secret lives here only while the person is setting it up.
  let begin = $state<TotpBegin | null>(null);
  let totpProblem = $state('');

  // Email
  let address = $state('');
  let sent = $state<{ info: CodeSent; at: number } | null>(null);
  let emailCode = $state('');
  let emailProblem = $state('');
  let now = $state(Date.now());

  let mode = $state<LoginMode>('off');

  async function load() {
    loadError = '';
    try {
      const next = await api.twoFactorStatus(workspaceId);
      status = next;
      mode = next.login.mode;
    } catch (e) {
      loadError = twoFactorProblem(e);
    }
  }
  $effect(() => {
    void workspaceId;
    begin = null;
    sent = null;
    load();
    return () => {
      begin = null;
    };
  });
  // The "send again" button counts down while a code is waiting.
  $effect(() => {
    if (!sent) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function run(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      await task();
    } catch (e) {
      problem = twoFactorProblem(e);
    } finally {
      busy = false;
    }
  }

  const startTotp = () =>
    run(async () => {
      totpProblem = '';
      begin = await confirmed((grant) => api.twoFactorTotpBegin(workspaceId, grant));
    });

  async function confirmTotp(code: string) {
    if (busy) return;
    busy = true;
    totpProblem = '';
    try {
      await api.twoFactorTotpConfirm(workspaceId, code);
      begin = null;
      toast.success('Authenticator app turned on.');
      await load();
    } catch (e) {
      totpProblem = twoFactorProblem(e);
    } finally {
      busy = false;
    }
  }

  const removeTotp = () =>
    run(async () => {
      await confirmed((grant) => api.twoFactorTotpRemove(workspaceId, grant));
      toast.success('Authenticator app removed.');
      await load();
    });

  const sendEmail = () =>
    run(async () => {
      emailProblem = '';
      const typed = status?.emailAddressEditable ? address.trim() : undefined;
      const info = await confirmed((grant) => api.twoFactorEmailBegin(workspaceId, typed, grant));
      sent = { info, at: Date.now() };
      now = Date.now();
      emailCode = '';
    });

  async function confirmEmail(event: Event) {
    event.preventDefault();
    if (busy || !codeComplete(emailCode)) return;
    busy = true;
    emailProblem = '';
    try {
      await api.twoFactorEmailConfirm(workspaceId, emailCode.replace(/\D+/g, ''));
      sent = null;
      emailCode = '';
      toast.success('Email address verified.');
      await load();
    } catch (e) {
      emailProblem = twoFactorProblem(e);
    } finally {
      busy = false;
    }
  }

  const removeEmail = () =>
    run(async () => {
      await confirmed((grant) => api.twoFactorEmailRemove(workspaceId, grant));
      toast.success('Email address removed.');
      await load();
    });

  const saveMode = () =>
    run(async () => {
      const done = await confirmed((grant) => api.twoFactorSetPolicy(workspaceId, mode, grant));
      toast.success('Sign-in settings saved.');
      await load();
      if (done.membersWithoutSecondFactor > 0 && (mode === 'admins' || mode === 'all')) {
        toast.info(`${done.membersWithoutSecondFactor} member${done.membersWithoutSecondFactor === 1 ? ' has' : 's have'} no second factor yet and will set one up at their next sign-in.`);
      }
    });

  const wait = $derived(sent ? resendIn(sent.at, sent.info.resendAfterSeconds, now) : 0);
  const emailBlocked = $derived(!!status && !status.mailConfigured);
</script>

<Card
  title="Authenticator app and email"
  collapseKey="two-factor"
  summary={status ? twoFactorSummary(status) : undefined}
  description="Two more ways to confirm a hard action: the six digits an authenticator app shows, or a code sent to your email. On a server with accounts, an owner or admin can also ask for one when people sign in."
>
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
  {:else if !status}
    <Skeleton />
  {:else}
    <div class="stack">
      <section class="stack" aria-labelledby="tf-app">
        <h4 id="tf-app">Authenticator app</h4>
        {#if begin}
          <TotpSetup {begin} {busy} problem={totpProblem} onconfirm={confirmTotp} oncancel={() => (begin = null)} />
        {:else if status.totp.state === 'active'}
          <div class="row">
            <span>On{status.totp.confirmedAt ? ` since ${fullTime(status.totp.confirmedAt)}` : ''}. Codes change every 30 seconds and work once.</span>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={removeTotp}>Remove</Button>
          </div>
        {:else}
          <p class="muted">Not set up. Works with 1Password, Authy, Google Authenticator, Microsoft Authenticator, Apple Passwords and any app that follows the TOTP standard.</p>
          <div class="row"><Button variant="primary" loading={busy} disabled={busy} onclick={startTotp}>Set up an authenticator app</Button></div>
        {/if}
      </section>

      <section class="stack" aria-labelledby="tf-email">
        <h4 id="tf-email">Email</h4>
        {#if emailBlocked}
          <Alert tone="info" title="No mail server is set up">
            Codes cannot be emailed until a mail server is added{isAdmin ? ' (the Mail card below)' : ' by an owner or admin'}.
          </Alert>
        {/if}
        {#if status.email?.verified && !sent}
          <div class="row">
            <span>Codes go to <strong>{status.email.address}</strong>, verified {status.email.verifiedAt ? fullTime(status.email.verifiedAt) : ''}.</span>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={removeEmail}>Remove</Button>
          </div>
          {#if !status.email.usable}
            <Alert tone="warn">This address no longer matches your account email, so it is not used. Remove it and verify again.</Alert>
          {/if}
        {:else if sent}
          <form class="stack" onsubmit={confirmEmail}>
            <p class="muted">A code was sent to <strong>{sent.info.to}</strong>. It works once and lasts 10 minutes.</p>
            <TextField label="Code from the email" bind:value={emailCode} inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength={7} required disabled={busy} />
            {#if emailProblem}<Alert tone="error">{emailProblem}</Alert>{/if}
            <div class="row">
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !codeComplete(emailCode)}>Verify</Button>
              <Button disabled={busy || wait > 0} onclick={sendEmail}>{wait > 0 ? `Send again in ${wait}s` : 'Send again'}</Button>
              <Button disabled={busy} onclick={() => (sent = null)}>Cancel</Button>
            </div>
          </form>
        {:else}
          <p class="muted">
            {#if status.emailAddressEditable}
              Enter the address to send codes to; a code is sent there to prove it is yours.
            {:else}
              A code is sent to the email address you sign in with, to prove it is yours.
            {/if}
          </p>
          {#if status.emailAddressEditable}
            <TextField label="Email address" type="email" bind:value={address} autocomplete="email" disabled={busy || emailBlocked} />
          {/if}
          {#if emailProblem}<Alert tone="error">{emailProblem}</Alert>{/if}
          <div class="row">
            <Button variant="primary" loading={busy} disabled={busy || emailBlocked || (status.emailAddressEditable && address.trim() === '')} onclick={sendEmail}>Email me a code</Button>
          </div>
        {/if}
      </section>

      {#if status.login.supported}
        <section class="stack" aria-labelledby="tf-login">
          <h4 id="tf-login">Signing in</h4>
          {#if isAdmin}
            <fieldset class="stack" disabled={busy}>
              <legend class="muted small">After the password, ask for a second factor:</legend>
              {#each LOGIN_MODES as option (option.value)}
                <label class="check">
                  <input type="radio" name="tf-mode" value={option.value} bind:group={mode} />
                  <span><strong>{option.label}</strong> <span class="muted small">{option.hint}</span></span>
                </label>
              {/each}
            </fieldset>
            {#if (mode === 'admins' || mode === 'all') && typeof status.login.membersWithoutSecondFactor === 'number' && status.login.membersWithoutSecondFactor > 0}
              <p class="muted small">
                {status.login.membersWithoutSecondFactor} member{status.login.membersWithoutSecondFactor === 1 ? ' has' : 's have'} no second factor yet. Anyone it applies to sets one up at their next sign-in; until they do, only the password protects that account.
              </p>
            {/if}
            <div class="row"><Button variant="primary" loading={busy} disabled={busy || mode === status.login.mode} onclick={saveMode}>Save</Button></div>
          {:else}
            <p class="muted">Signing in asks for: {loginModeSummary(status.login.mode).toLowerCase()}.</p>
          {/if}
        </section>
      {/if}

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {/if}
</Card>

<style>
  .check {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  h4 {
    margin: 0;
  }

  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
  }
</style>
