<!--
  SecuritySettings: step-up confirmation (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md). Hard actions (publish,
  submit for review, release, change a rollout, turn on Apple analytics, delete a credential, switch a feature on) can ask the
  person to confirm again with a passkey (Touch ID, Face ID, Windows Hello, a security key) or a password.
  Everyone sees their own ways to confirm and can add or remove them; owners and admins also switch the policy and choose which
  actions it covers. It has its own buttons: it is not part of the settings form above.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
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
      toast.success('Confirmation settings saved.');
      await load();
    });

  const addPasskey = () =>
    run(async () => {
      const name = passkeyName.trim();
      if (!name) {
        problem = 'Give the passkey a name, such as “MacBook Touch ID”.';
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
      toast.success(`Added “${name}”.`);
      await load();
    });

  const removePasskey = (id: string, name: string) =>
    run(async () => {
      await confirmed((grant) => api.stepUpDeletePasskey(workspaceId, id, grant));
      toast.success(`Removed “${name}”.`);
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
        problem = 'Use at least 12 characters.';
        return;
      }
      const password = newPassword;
      await confirmed((grant) => api.stepUpSetPassword(workspaceId, password, grant));
      newPassword = '';
      toast.success('Confirmation password saved.');
      await load();
    });
</script>

<Card title="Security: confirm hard actions" description="Ask for a passkey or a password again before publishing, submitting, releasing, changing a rollout, turning on Apple analytics, deleting a credential or switching a feature on.">
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
    <p><Button onclick={load}>Try again</Button></p>
  {:else if !status}
    <Skeleton />
  {:else}
    <div class="stack">
      <Alert tone={status.policy.mode === 'off' ? 'warn' : status.enrolled ? 'ok' : 'warn'}>{securitySummary(status)}</Alert>

      <section class="stack" aria-labelledby="su-ways">
        <h4 id="su-ways">How you confirm</h4>
        {#if status.factors.passkeys.length > 0}
          <ul class="plain">
            {#each status.factors.passkeys as passkey (passkey.id)}
              <li class="row">
                <span><strong>{passkey.name}</strong> <span class="muted">added {fullTime(passkey.createdAt)}{passkey.lastUsedAt ? `, last used ${fullTime(passkey.lastUsedAt)}` : ', not used yet'}</span></span>
                <Button size="sm" variant="danger" icon="trash" disabled={busy} onclick={() => removePasskey(passkey.id, passkey.name)}>Remove</Button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted">No passkey yet.</p>
        {/if}

        {#if browserPasskeys && status.supported.webauthn}
          <div class="row">
            <TextField label="Name for a new passkey" bind:value={passkeyName} placeholder="MacBook Touch ID" maxlength={60} disabled={busy} />
            <Button icon="key" loading={busy} disabled={busy || status.factors.passkeys.length >= status.supported.maxPasskeys} onclick={addPasskey}>Add a passkey</Button>
          </div>
          <p class="muted small">Your device asks for Touch ID, Face ID, Windows Hello or your PIN. Only a public key is stored here.</p>
        {:else}
          <Alert tone="info" title="Passkeys are not available in this window">
            Passkeys need a browser that offers them and an address that is https or http://localhost. The desktop app's window may not offer
            them. Use a password instead{status.factors.confirmationPasswordSettable ? ' (below)' : ''}, or open this server in a browser.
          </Alert>
        {/if}

        {#if status.factors.confirmationPasswordSettable}
          <div class="stack">
            <h5>Confirmation password</h5>
            <p class="muted small">
              {status.factors.password ? 'A confirmation password is set.' : 'This app has no sign-in password, so set one here to confirm with.'}
              At least 12 characters. It is stored hashed, wrong guesses lock confirmation for a while, and it only confirms actions; it does not sign anyone in.
            </p>
            <div class="row">
              <TextField label={status.factors.password ? 'New confirmation password' : 'Confirmation password'} type="password" reveal bind:value={newPassword} autocomplete="new-password" disabled={busy} />
              <Button loading={busy} disabled={busy || newPassword === ''} onclick={savePassword}>{status.factors.password ? 'Change password' : 'Set password'}</Button>
            </div>
          </div>
        {:else if status.factors.password}
          <p class="muted small">Your account password confirms. Change it with your account.</p>
        {/if}
      </section>

      <section class="stack" aria-labelledby="su-policy">
        <h4 id="su-policy">When to ask</h4>
        {#if isAdmin}
          <label class="check"><input type="checkbox" bind:checked={on} disabled={busy} /> Ask for a confirmation before hard actions (recommended)</label>
          {#if on}
            <fieldset class="stack">
              <legend>Actions that ask</legend>
              {#each STEP_UP_ACTIONS as action (action)}
                <label class="check">
                  <input type="checkbox" checked={covered.indexOf(action) >= 0} disabled={busy} onchange={(e) => (covered = toggleAction(covered, action, e.currentTarget.checked))} />
                  {stepUpActionLabel(action)}
                </label>
              {/each}
            </fieldset>
            <details>
              <summary>Allow API tokens without a person (CI and automation)</summary>
              <p class="muted small">
                A token cannot confirm anything, so by default a token that does a covered action is refused. Tick an action to let tokens do it with
                no confirmation at all. That is the trade-off for automation: anyone who holds such a token can do it.
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
            <Alert tone="warn">You have no way to confirm yet. Add a passkey or set a confirmation password first, or hard actions will be refused for you.</Alert>
          {/if}
          <div class="row"><Button variant="primary" loading={busy} disabled={busy || !policyChanged} onclick={savePolicy}>Save</Button></div>
        {:else}
          <p>
            {#if status.policy.mode === 'off'}Not switched on. An owner or admin can switch it on.{:else}Switched on by an owner or admin for:
              {#each status.policy.actions as action, i (action)}{i > 0 ? ', ' : ' '}{stepUpActionLabel(action)}{/each}.{/if}
          </p>
        {/if}
      </section>

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
  {/if}
</Card>

{#if isAdmin && status}
  <Card title="Recovery codes" description="Ten one-time codes to confirm with when your passkey or password is lost. Keep them offline.">
    <div class="stack">
      {#if shown}
        <Alert tone="warn" title="Save these codes now">
          They are shown only this once and cannot be looked up again. Keep them in a password manager or print them. Each works once.
        </Alert>
        <ul class="plain codes" aria-label="Your new recovery codes">
          {#each shown.codes as code (code)}<li><code>{code}</code></li>{/each}
        </ul>
        <div class="row">
          <CopyButton value={shown.codes.join('\n')} label="Copy codes" size="sm" variant="secondary" />
          <Button size="sm" icon="download" onclick={downloadCodes}>Download as text</Button>
        </div>
        <div class="row"><Button variant="primary" onclick={() => (shown = null)}>I have saved them</Button></div>
      {:else}
        <p class="muted small">{recoverySummary(status.recovery)}</p>
        {#if !status.enrolled}
          <p class="muted small">Add a passkey or a confirmation password first. Recovery codes stand in for them.</p>
        {:else if replacing}
          <Alert tone="warn">
            Making new codes stops every old one from working, including the {status.recovery?.remaining ?? 0} you have left. You will be asked to confirm.
          </Alert>
          <div class="row">
            <Button variant="danger" loading={busy} disabled={busy} onclick={makeCodes}>Replace my codes</Button>
            <Button disabled={busy} onclick={() => (replacing = false)}>Cancel</Button>
          </div>
        {:else}
          <div class="row">
            <Button
              loading={busy}
              disabled={busy}
              onclick={() => ((status?.recovery?.total ?? 0) > 0 ? (replacing = true) : makeCodes())}
            >{(status.recovery?.total ?? 0) > 0 ? 'Make new codes' : 'Make recovery codes'}</Button>
          </div>
        {/if}
        <p class="muted small">
          Lost your passkey or password? Remove the lost passkey or set a new confirmation password in the card above. When you are asked to confirm,
          choose "Use a recovery code". Using a code is recorded in the audit log.
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
