<!--
  MailSettings: the mail server (SMTP) this instance sends email through (docs/api/mail.md, docs/adr/0021-two-factor-and-smtp.md).
  Emailed codes and alerts use it. Owners and admins only. The password is typed here and never shown again; saving, clearing and the
  test message are separate buttons (this card is not part of the settings form above). A server whose mail is set in the environment
  (KILN_SMTP_HOST) shows it read only. "Send test email" sends one message to the signed-in person's own address.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { type Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import {
    SMTP_SECURE_OPTIONS,
    type MailTestResult,
    type SmtpSecure,
    type SmtpSettings,
    defaultSmtpPort,
    mailTestSummary,
    smtpProblem,
    smtpSourceLabel,
    twoFactorProblem,
  } from '../../lib/two-factor.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';
  import '../readable-card.css';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const isAdmin = $derived(can(role, 'settings.write'));
  const uid = $props.id();

  let settings = $state<SmtpSettings | null>(null);
  let loadError = $state('');
  let busy = $state(false);
  let problem = $state('');
  let testing = $state(false);
  let testResult = $state<MailTestResult | null>(null);
  let testTo = $state('');
  let askTestAddress = $state(false);

  let host = $state('');
  let port = $state('587');
  let secure = $state<SmtpSecure>('starttls');
  let user = $state('');
  let password = $state('');
  let from = $state('');

  function fill(next: SmtpSettings) {
    settings = next;
    host = next.host ?? '';
    port = String(next.port ?? defaultSmtpPort(next.secure ?? 'starttls'));
    secure = next.secure ?? 'starttls';
    user = next.user ?? '';
    from = next.from ?? '';
    password = '';
  }

  async function load() {
    loadError = '';
    try {
      fill(await api.mailSettings(workspaceId));
    } catch (e) {
      loadError = twoFactorProblem(e);
    }
  }
  $effect(() => {
    void workspaceId;
    if (isAdmin) load();
  });

  const locked = $derived(!!settings?.locked);
  const canEdit = $derived(isAdmin && !locked);
  const summary = $derived(settings ? (settings.configured ? `${settings.host}:${settings.port}` : t('settings:mail.notSetUp')) : undefined);

  function pickSecure(next: SmtpSecure) {
    // Move the port along with the setting, unless the person typed a port of their own.
    const typedOwn = SMTP_SECURE_OPTIONS.every((o) => String(o.port) !== port);
    secure = next;
    if (!typedOwn) port = String(defaultSmtpPort(next));
  }

  async function save(event: Event) {
    event.preventDefault();
    if (busy || !canEdit) return;
    const first = smtpProblem({ host, port, from });
    if (first) {
      problem = first;
      return;
    }
    busy = true;
    problem = '';
    testResult = null;
    try {
      const body = {
        host: host.trim(),
        port: port.trim() === '' ? undefined : Number(port),
        secure,
        user: user.trim() === '' ? undefined : user.trim(),
        // Left empty, the saved password stays. The server asks for it again when the host, port or user name changes.
        password: password === '' ? undefined : password,
        from: from.trim(),
      };
      fill(await confirmed((grant) => api.mailSaveSettings(workspaceId, body, grant)));
      toast.success(t('settings:mail.saved'));
    } catch (e) {
      problem = twoFactorProblem(e);
    } finally {
      busy = false;
    }
  }

  async function clear() {
    if (busy || !canEdit) return;
    busy = true;
    problem = '';
    testResult = null;
    try {
      fill(await confirmed((grant) => api.mailClearSettings(workspaceId, grant)));
      toast.success(t('settings:mail.removed'));
    } catch (e) {
      problem = twoFactorProblem(e);
    } finally {
      busy = false;
    }
  }

  async function sendTest() {
    if (testing) return;
    testing = true;
    problem = '';
    testResult = null;
    try {
      testResult = await api.mailSendTest(workspaceId, askTestAddress && testTo.trim() ? testTo.trim() : undefined);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      // With no account email (single-user mode) the person says where the test goes.
      if (code === 'email_required') askTestAddress = true;
      problem = twoFactorProblem(e);
    } finally {
      testing = false;
    }
  }
</script>

{#if isAdmin}
  <Card
    title={t('settings:mail.title')}
    collapseKey="mail-settings"
    {summary}
    description={t('settings:mail.description')}
  >
    {#if loadError}
      <Alert tone="error">{loadError}</Alert>
    {:else if !settings}
      <Skeleton />
    {:else}
      <form class="stack readable-card" onsubmit={save} novalidate>
        <p class="muted">{smtpSourceLabel(settings.source)}.</p>
        {#if locked}
          <Alert tone="info">{t('settings:mail.locked')}</Alert>
        {/if}
        <TextField label={t('settings:mail.hostLabel')} bind:value={host} placeholder="smtp.example.com" autocomplete="off" disabled={!canEdit || busy} required />
        <div class="field">
          <label for="{uid}-secure">{t('settings:mail.secureLabel')}</label>
          <select id="{uid}-secure" value={secure} disabled={!canEdit || busy} onchange={(e) => pickSecure((e.currentTarget as HTMLSelectElement).value as SmtpSecure)}>
            {#each SMTP_SECURE_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <TextField label={t('settings:mail.portLabel')} bind:value={port} inputmode="numeric" disabled={!canEdit || busy} />
        <TextField label={t('settings:mail.userLabel')} bind:value={user} autocomplete="off" disabled={!canEdit || busy} />
        <TextField
          label={t('settings:mail.passwordLabel')}
          type="password"
          reveal
          bind:value={password}
          autocomplete="new-password"
          placeholder={settings.passwordSet ? t('settings:mail.passwordSaved') : ''}
          disabled={!canEdit || busy}
        />
        <TextField label={t('settings:mail.fromLabel')} bind:value={from} type="text" placeholder="Kiln <kiln@example.com>" autocomplete="off" disabled={!canEdit || busy} required />
        {#if secure === 'none'}
          <Alert tone="warn">{t('settings:mail.noTls')}</Alert>
        {/if}
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
        {#if testResult}<Alert tone={testResult.ok ? 'ok' : 'error'}>{mailTestSummary(testResult)}</Alert>{/if}
        {#if askTestAddress}
          <TextField label={t('settings:mail.testToLabel')} type="email" bind:value={testTo} autocomplete="email" />
        {/if}
        <div class="row">
          {#if canEdit}
            <Button type="submit" variant="primary" loading={busy} disabled={busy}>{t('settings:mail.save')}</Button>
          {/if}
          <Button icon="send" loading={testing} disabled={testing || busy || !settings.configured} onclick={sendTest}>{t('settings:mail.sendTest')}</Button>
          {#if canEdit && settings.source === 'settings'}
            <Button variant="danger" icon="trash" disabled={busy} onclick={clear}>{t('settings:mail.remove')}</Button>
          {/if}
        </div>
        {#if !settings.configured}
          <p class="muted">{t('settings:mail.saveFirst')}</p>
        {/if}
      </form>
    {/if}
  </Card>
{/if}
