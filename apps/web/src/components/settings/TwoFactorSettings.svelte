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
  import { type Role, can } from '@kiln/core';
  import { type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import { currentLocale, t } from '../../lib/i18n/t.ts';
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
  import T from '../ui/T.svelte';

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
      toast.success(t('settings:twoFactor.totpOn'));
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
      toast.success(t('settings:twoFactor.totpRemoved'));
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
      toast.success(t('settings:twoFactor.emailVerified'));
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
      toast.success(t('settings:twoFactor.emailRemoved'));
      await load();
    });

  const saveMode = () =>
    run(async () => {
      const done = await confirmed((grant) => api.twoFactorSetPolicy(workspaceId, mode, grant));
      toast.success(t('settings:twoFactor.loginSaved'));
      await load();
      if (done.membersWithoutSecondFactor > 0 && (mode === 'admins' || mode === 'all')) {
        toast.info(t('settings:twoFactor.membersToast', { count: done.membersWithoutSecondFactor }));
      }
    });

  /** The summary of the sign-in mode in the middle of a sentence: its first letter in lower case (not in German, where nouns keep their capital). */
  const lowerFirst = (text: string): string => (currentLocale() === 'de' ? text : text.charAt(0).toLowerCase() + text.slice(1));

  const wait = $derived(sent ? resendIn(sent.at, sent.info.resendAfterSeconds, now) : 0);
  const emailBlocked = $derived(!!status && !status.mailConfigured);
</script>

<Card
  title={t('settings:twoFactor.title')}
  collapseKey="two-factor"
  summary={status ? twoFactorSummary(status) : undefined}
  description={t('settings:twoFactor.description')}
>
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
  {:else if !status}
    <Skeleton />
  {:else}
    <div class="stack">
      <section class="stack" aria-labelledby="tf-app">
        <h4 id="tf-app">{t('settings:twoFactor.appTitle')}</h4>
        {#if begin}
          <TotpSetup {begin} {busy} problem={totpProblem} onconfirm={confirmTotp} oncancel={() => (begin = null)} />
        {:else if status.totp.state === 'active'}
          <div class="row">
            <span>{status.totp.confirmedAt ? t('settings:twoFactor.totpActiveSince', { date: fullTime(status.totp.confirmedAt) }) : t('settings:twoFactor.totpActive')}</span>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={removeTotp}>{t('settings:twoFactor.remove')}</Button>
          </div>
        {:else}
          <p class="muted">{t('settings:twoFactor.totpNotSetUp')}</p>
          <div class="row"><Button variant="primary" loading={busy} disabled={busy} onclick={startTotp}>{t('settings:twoFactor.totpSetUp')}</Button></div>
        {/if}
      </section>

      <section class="stack" aria-labelledby="tf-email">
        <h4 id="tf-email">{t('settings:twoFactor.emailTitle')}</h4>
        {#if emailBlocked}
          <Alert tone="info" title={t('settings:twoFactor.noMailTitle')}>
            {isAdmin ? t('settings:twoFactor.noMailAdmin') : t('settings:twoFactor.noMailMember')}
          </Alert>
        {/if}
        {#if status.email?.verified && !sent}
          <div class="row">
            <span>{#if status.email.verifiedAt}<T key="settings:twoFactor.codesGoTo" params={{ address: status.email.address, date: fullTime(status.email.verifiedAt) }} />{:else}<T key="settings:twoFactor.codesGoToNoDate" params={{ address: status.email.address }} />{/if}</span>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={removeEmail}>{t('settings:twoFactor.remove')}</Button>
          </div>
          {#if !status.email.usable}
            <Alert tone="warn">{t('settings:twoFactor.emailUnusable')}</Alert>
          {/if}
        {:else if sent}
          <form class="stack" onsubmit={confirmEmail}>
            <p class="muted"><T key="settings:twoFactor.codeSent" params={{ to: sent.info.to }} /></p>
            <TextField label={t('settings:twoFactor.codeLabel')} bind:value={emailCode} inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength={7} required disabled={busy} />
            {#if emailProblem}<Alert tone="error">{emailProblem}</Alert>{/if}
            <div class="row">
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !codeComplete(emailCode)}>{t('settings:twoFactor.verify')}</Button>
              <Button disabled={busy || wait > 0} onclick={sendEmail}>{wait > 0 ? t('settings:twoFactor.sendAgainIn', { seconds: wait }) : t('settings:twoFactor.sendAgain')}</Button>
              <Button disabled={busy} onclick={() => (sent = null)}>{t('settings:twoFactor.cancel')}</Button>
            </div>
          </form>
        {:else}
          <p class="muted">
            {#if status.emailAddressEditable}
              {t('settings:twoFactor.emailEnter')}
            {:else}
              {t('settings:twoFactor.emailSignInAddress')}
            {/if}
          </p>
          {#if status.emailAddressEditable}
            <TextField label={t('settings:twoFactor.emailLabel')} type="email" bind:value={address} autocomplete="email" disabled={busy || emailBlocked} />
          {/if}
          {#if emailProblem}<Alert tone="error">{emailProblem}</Alert>{/if}
          <div class="row">
            <Button variant="primary" loading={busy} disabled={busy || emailBlocked || (status.emailAddressEditable && address.trim() === '')} onclick={sendEmail}>{t('settings:twoFactor.emailMe')}</Button>
          </div>
        {/if}
      </section>

      {#if status.login.supported}
        <section class="stack" aria-labelledby="tf-login">
          <h4 id="tf-login">{t('settings:twoFactor.loginTitle')}</h4>
          {#if isAdmin}
            <fieldset class="stack" disabled={busy}>
              <legend class="muted small">{t('settings:twoFactor.loginLegend')}</legend>
              {#each LOGIN_MODES as option (option.value)}
                <label class="check">
                  <input type="radio" name="tf-mode" value={option.value} bind:group={mode} />
                  <span><strong>{option.label}</strong> <span class="muted small">{option.hint}</span></span>
                </label>
              {/each}
            </fieldset>
            {#if (mode === 'admins' || mode === 'all') && typeof status.login.membersWithoutSecondFactor === 'number' && status.login.membersWithoutSecondFactor > 0}
              <p class="muted small">
                {t('settings:twoFactor.membersNote', { count: status.login.membersWithoutSecondFactor })}
              </p>
            {/if}
            <div class="row"><Button variant="primary" loading={busy} disabled={busy || mode === status.login.mode} onclick={saveMode}>{t('settings:twoFactor.save')}</Button></div>
          {:else}
            <p class="muted">{t('settings:twoFactor.loginAsks', { mode: lowerFirst(loginModeSummary(status.login.mode)) })}</p>
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
