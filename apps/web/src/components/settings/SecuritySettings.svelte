<!--
  SecuritySettings: step-up confirmation (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md). Hard actions (publish,
  submit for review, release, change a rollout, turn on Apple analytics, delete a credential, switch a feature on) can ask the
  person to confirm again with a passkey (Touch ID, Face ID, Windows Hello, a security key) or a password.
  Everyone sees their own ways to confirm and can add or remove them; owners and admins also switch the policy and choose which
  actions it covers. It has its own buttons: it is not part of the settings form above.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    type StepUpAction,
    type StepUpStatus,
    STEP_UP_ACTIONS,
    RECOVERY_FILE_NAME,
    attestationToServer,
    creationOptionsFromServer,
    recoveryCodesText,
    recoverySummary,
    securitySummary,
    stepUpActionLabel,
    toggleAction,
    webauthnFailureMessage,
    webauthnSupported,
  } from '../../lib/step-up.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const isAdmin = $derived(can(role, 'settings.write'));
  const browserPasskeys = webauthnSupported(typeof window === 'undefined' ? {} : window);

  let status = $state<StepUpStatus | null>(null);
  let loadError = $state('');
  let problem = $state('');
  let busy = $state(false);

  let on = $state(false);
  let covered = $state<StepUpAction[]>([]);
  let unattended = $state<StepUpAction[]>([]);
  let passkeyName = $state('');
  let newPassword = $state('');

  // Recovery codes are shown once, here, and held in memory only until the person says they are saved.
  let shown = $state<{ codes: string[]; generatedAt: number } | null>(null);
  let replacing = $state(false);
  let codeProblem = $state('');

  const message = (e: unknown) => (e instanceof ApiError ? e.message : webauthnFailureMessage(e));

  async function load() {
    loadError = '';
    try {
      const next = await api.stepUpStatus(workspaceId);
      status = next;
      on = next.policy.mode === 'hard_actions';
      covered = [...next.policy.actions];
      unattended = [...next.policy.unattended];
    } catch (e) {
      loadError = message(e);
    }
  }
  $effect(() => {
    void workspaceId;
    shown = null;
    replacing = false;
    codeProblem = '';
    load();
    return () => {
      shown = null;
    };
  });

  async function run(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      await task();
    } catch (e) {
      problem = message(e);
    } finally {
      busy = false;
    }
  }

  const policyChanged = $derived(
    !!status &&
      (on !== (status.policy.mode === 'hard_actions') ||
        covered.join() !== status.policy.actions.join() ||
        unattended.join() !== status.policy.unattended.join()),
  );

  const savePolicy = () =>
    run(async () => {
      await confirmed((grant) => api.stepUpSetPolicy(workspaceId, { mode: on ? 'hard_actions' : 'off', actions: covered, unattended }, grant));
      toast.success(t('settings:security.policySaved'));
      await load();
    });

  const addPasskey = () =>
    run(async () => {
      const name = passkeyName.trim();
      if (!name) {
        problem = t('settings:security.passkeyNameNeeded');
        return;
      }
      const options = await api.stepUpRegisterOptions(workspaceId);
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({ publicKey: creationOptionsFromServer(options.publicKey) as unknown as PublicKeyCredentialCreationOptions });
      } catch (e) {
        problem = webauthnFailureMessage(e);
        return;
      }
      if (!credential) {
        problem = webauthnFailureMessage(undefined);
        return;
      }
      const sent = attestationToServer(credential as unknown as Parameters<typeof attestationToServer>[0]);
      await confirmed((grant) => api.stepUpRegisterVerify(workspaceId, { challengeId: options.challengeId, name, credential: sent }, grant));
      passkeyName = '';
      toast.success(t('settings:security.passkeyAdded', { name }));
      await load();
    });

  const removePasskey = (id: string, name: string) =>
    run(async () => {
      await confirmed((grant) => api.stepUpDeletePasskey(workspaceId, id, grant));
      toast.success(t('settings:security.passkeyRemoved', { name }));
      await load();
    });

  async function makeCodes() {
    if (busy) return;
    busy = true;
    codeProblem = '';
    try {
      const made = await confirmed((grant) => api.stepUpMakeRecoveryCodes(workspaceId, grant));
      shown = { codes: made.codes, generatedAt: made.generatedAt };
      replacing = false;
      await load();
    } catch (e) {
      codeProblem = message(e);
    } finally {
      busy = false;
    }
  }

  function downloadCodes() {
    if (!shown) return;
    const url = URL.createObjectURL(new Blob([recoveryCodesText(shown.codes, shown.generatedAt)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = RECOVERY_FILE_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const savePassword = () =>
    run(async () => {
      if (newPassword.length < 12) {
        problem = t('settings:security.passwordMin', { count: 12 });
        return;
      }
      const password = newPassword;
      await confirmed((grant) => api.stepUpSetPassword(workspaceId, password, grant));
      newPassword = '';
      toast.success(t('settings:security.passwordSaved'));
      await load();
    });
</script>

<Card title={t('settings:security.title')} collapseKey="security" description={t('settings:security.description')}>
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
    <p><Button onclick={load}>{t('common:action.tryAgain')}</Button></p>
  {:else if !status}
    <Skeleton />
  {:else}
    <div class="stack">
      <Alert tone={status.policy.mode === 'off' ? 'warn' : status.enrolled ? 'ok' : 'warn'}>{securitySummary(status)}</Alert>

      <section class="stack" aria-labelledby="su-ways">
        <h4 id="su-ways">{t('settings:security.waysTitle')}</h4>
        {#if status.factors.passkeys.length > 0}
          <ul class="plain">
            {#each status.factors.passkeys as passkey (passkey.id)}
              <li class="row">
                <span><strong>{passkey.name}</strong> <span class="muted">{passkey.lastUsedAt ? t('settings:security.passkeyMeta', { added: fullTime(passkey.createdAt), used: fullTime(passkey.lastUsedAt) }) : t('settings:security.passkeyMetaUnused', { added: fullTime(passkey.createdAt) })}</span></span>
                <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={() => removePasskey(passkey.id, passkey.name)}>{t('settings:security.remove')}</Button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted">{t('settings:security.noPasskey')}</p>
        {/if}

        {#if browserPasskeys && status.supported.webauthn}
          <div class="row">
            <TextField label={t('settings:security.passkeyNameLabel')} bind:value={passkeyName} placeholder="MacBook Touch ID" maxlength={60} disabled={busy} />
            <Button icon="key" loading={busy} disabled={busy || status.factors.passkeys.length >= status.supported.maxPasskeys} onclick={addPasskey}>{t('settings:security.addPasskey')}</Button>
          </div>
          <p class="muted small">{t('settings:security.passkeyNote')}</p>
        {:else}
          <Alert tone="info" title={t('settings:security.noPasskeysTitle')}>
            {status.factors.confirmationPasswordSettable ? t('settings:security.noPasskeysBodyBelow') : t('settings:security.noPasskeysBody')}
          </Alert>
        {/if}

        {#if status.factors.confirmationPasswordSettable}
          <div class="stack">
            <h5>{t('settings:security.passwordTitle')}</h5>
            <p class="muted small">
              {status.factors.password ? t('settings:security.passwordIsSet') : t('settings:security.passwordNone')}
              {t('settings:security.passwordRules')}
            </p>
            <div class="row">
              <TextField label={status.factors.password ? t('settings:security.passwordNewLabel') : t('settings:security.passwordLabel')} type="password" reveal bind:value={newPassword} autocomplete="new-password" disabled={busy} />
              <Button loading={busy} disabled={busy || newPassword === ''} onclick={savePassword}>{status.factors.password ? t('settings:security.passwordChange') : t('settings:security.passwordSet')}</Button>
            </div>
          </div>
        {:else if status.factors.password}
          <p class="muted small">{t('settings:security.accountPasswordConfirms')}</p>
        {/if}
      </section>

      <section class="stack" aria-labelledby="su-policy">
        <h4 id="su-policy">{t('settings:security.policyTitle')}</h4>
        {#if isAdmin}
          <label class="check"><input type="checkbox" bind:checked={on} disabled={busy} /> {t('settings:security.policyToggle')}</label>
          {#if on}
            <fieldset class="stack">
              <legend>{t('settings:security.actionsLegend')}</legend>
              {#each STEP_UP_ACTIONS as action (action)}
                <label class="check">
                  <input type="checkbox" checked={covered.indexOf(action) >= 0} disabled={busy} onchange={(e) => (covered = toggleAction(covered, action, e.currentTarget.checked))} />
                  {stepUpActionLabel(action)}
                </label>
              {/each}
            </fieldset>
            <details>
              <summary>{t('settings:security.unattendedSummary')}</summary>
              <p class="muted small">
                {t('settings:security.unattendedText')}
              </p>
              {#each covered as action (action)}
                <label class="check">
                  <input type="checkbox" checked={unattended.indexOf(action) >= 0} disabled={busy} onchange={(e) => (unattended = toggleAction(unattended, action, e.currentTarget.checked))} />
                  {stepUpActionLabel(action)}
                </label>
              {/each}
            </details>
          {/if}
          {#if on && !status.enrolled}
            <Alert tone="warn">{t('settings:security.noWayToConfirm')}</Alert>
          {/if}
          <div class="row"><Button variant="primary" loading={busy} disabled={busy || !policyChanged} onclick={savePolicy}>{t('settings:security.save')}</Button></div>
        {:else}
          <p>
            {#if status.policy.mode === 'off'}{t('settings:security.policyOff')}{:else}{t('settings:security.policyOn', { actions: formatList(status.policy.actions.map((action) => stepUpActionLabel(action)), { type: 'unit' }) })}{/if}
          </p>
        {/if}
      </section>

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {/if}
</Card>

{#if isAdmin && status}
  <Card title={t('settings:security.recoveryTitle')} collapseKey="recovery-codes" description={t('settings:security.recoveryDescription')}>
    <div class="stack">
      {#if shown}
        <Alert tone="warn" title={t('settings:security.saveCodesTitle')}>
          {t('settings:security.saveCodesBody')}
        </Alert>
        <ul class="plain codes" aria-label={t('settings:security.codesLabel')}>
          {#each shown.codes as code (code)}<li><code>{code}</code></li>{/each}
        </ul>
        <div class="row">
          <CopyButton value={shown.codes.join('\n')} label={t('settings:security.copyCodes')} size="sm" variant="secondary" />
          <Button size="sm" icon="download" onclick={downloadCodes}>{t('settings:security.downloadCodes')}</Button>
        </div>
        <div class="row"><Button variant="primary" onclick={() => (shown = null)}>{t('settings:security.savedThem')}</Button></div>
      {:else}
        <p class="muted small">{recoverySummary(status.recovery)}</p>
        {#if !status.enrolled}
          <p class="muted small">{t('settings:security.codesNeedFactor')}</p>
        {:else if replacing}
          <Alert tone="warn">
            {t('settings:security.replaceWarn', { count: status.recovery?.remaining ?? 0 })}
          </Alert>
          <div class="row">
            <Button variant="danger" loading={busy} disabled={busy} onclick={makeCodes}>{t('settings:security.replaceCodes')}</Button>
            <Button disabled={busy} onclick={() => (replacing = false)}>{t('settings:security.cancel')}</Button>
          </div>
        {:else}
          <div class="row">
            <Button
              loading={busy}
              disabled={busy}
              onclick={() => ((status?.recovery?.total ?? 0) > 0 ? (replacing = true) : makeCodes())}
            >{(status.recovery?.total ?? 0) > 0 ? t('settings:security.makeNewCodes') : t('settings:security.makeCodes')}</Button>
          </div>
        {/if}
        <p class="muted small">
          {t('settings:security.lostHelp')}
        </p>
      {/if}
      {#if codeProblem}<Alert tone="error">{codeProblem}</Alert>{/if}
    </div>
  </Card>
{/if}

<style>
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .codes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--space-2);
  }

  .check {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  h4,
  h5 {
    margin: 0;
  }

  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
  }
</style>
