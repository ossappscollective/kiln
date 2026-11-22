<script lang="ts">
  import { ApiError, type Api } from '../lib/api.ts';
  import { k, t } from '../lib/i18n/t.ts';
  import { msg, msgText, rawMsg, type Msg } from '../lib/message.ts';
  import { emailProblem, passwordProblem, requiredProblem } from '../lib/validate.ts';
  import AuthCard from './AuthCard.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import TextField from './ui/TextField.svelte';

  const MIN_PASSWORD = 12;

  let { api, ondone }: { api: Api; ondone: () => void } = $props();

  let displayName = $state('');
  let email = $state('');
  let password = $state('');
  let workspaceName = $state('');
  let busy = $state(false);
  let error = $state<Msg | null>(null);
  let touched = $state({ displayName: false, email: false, password: false, workspaceName: false });

  const problems = $derived({
    displayName: requiredProblem(displayName, k('common:validation.nameRequired')),
    email: emailProblem(email),
    password: passwordProblem(password, MIN_PASSWORD),
    workspaceName: requiredProblem(workspaceName, k('common:validation.workspaceNameRequired')),
  });
  const shown = $derived({
    displayName: touched.displayName ? problems.displayName : '',
    email: touched.email ? problems.email : '',
    password: touched.password ? problems.password : '',
    workspaceName: touched.workspaceName ? problems.workspaceName : '',
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    touched = { displayName: true, email: true, password: true, workspaceName: true };
    if (Object.values(problems).some(Boolean)) return;
    busy = true;
    error = null;
    try {
      await api.register({ email: email.trim(), displayName: displayName.trim(), password, workspaceName: workspaceName.trim() });
      ondone();
    } catch (e) {
      error = e instanceof ApiError ? rawMsg(e.message) : msg(k('common:error.genericRetry'));
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard
  title={t('auth:setup.title')}
  subtitle={t('auth:setup.subtitle')}
>
  <form onsubmit={submit} class="stack" novalidate>
    <TextField
      label={t('auth:invite.yourName')}
      bind:value={displayName}
      autocomplete="name"
      required
      error={shown.displayName}
      onblur={() => (touched.displayName = true)}
    />
    <TextField
      label={t('auth:login.email')}
      type="email"
      bind:value={email}
      autocomplete="email"
      required
      error={shown.email}
      onblur={() => (touched.email = true)}
    />
    <TextField
      label={t('auth:login.password')}
      type="password"
      reveal
      bind:value={password}
      autocomplete="new-password"
      required
      hint={t('auth:password.hint', { min: MIN_PASSWORD })}
      error={shown.password}
      onblur={() => (touched.password = true)}
    />
    <TextField
      label={t('auth:setup.workspaceName')}
      bind:value={workspaceName}
      placeholder={t('auth:setup.workspacePlaceholder')}
      hint={t('auth:setup.workspaceHint')}
      required
      error={shown.workspaceName}
      onblur={() => (touched.workspaceName = true)}
    />
    {#if error}<Alert tone="error">{msgText(error)}</Alert>{/if}
    <p class="quiet">{t('auth:setup.closes')}</p>
    <Button variant="primary" type="submit" size="lg" block loading={busy}>
      {busy ? t('auth:setup.submitting') : t('auth:setup.submit')}
    </Button>
  </form>
</AuthCard>
