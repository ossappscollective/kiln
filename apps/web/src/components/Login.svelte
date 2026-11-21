<script lang="ts">
  import { ApiError, type Api } from '../lib/api.ts';
  import { t } from '../lib/i18n/t.ts';
  import { type LoginChallenge, isLoginChallenge } from '../lib/two-factor.ts';
  import { emailProblem } from '../lib/validate.ts';
  import AuthCard from './AuthCard.svelte';
  import LoginSecondFactor from './LoginSecondFactor.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import TextField from './ui/TextField.svelte';

  let { api, notice, ondone }: { api: Api; notice?: string | undefined; ondone: () => void } = $props();

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  // Problems show once a field has been left, or after a failed attempt to submit.
  let touched = $state({ email: false, password: false });
  // Set when the server asks for a second factor after the password (docs/api/two-factor.md): shown in place of this form.
  let challenge = $state<LoginChallenge | null>(null);

  const emailError = $derived(touched.email ? emailProblem(email) : '');
  const passwordError = $derived(touched.password && !password ? t('auth:login.passwordRequired') : '');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    touched = { email: true, password: true };
    if (emailProblem(email) || !password) return;
    busy = true;
    error = '';
    try {
      const result = await api.login({ email: email.trim(), password });
      if (isLoginChallenge(result)) {
        challenge = result;
        password = '';
        return;
      }
      ondone();
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('common:error.genericRetry');
      password = '';
      touched.password = false;
    } finally {
      busy = false;
    }
  }
</script>

{#if challenge}
  <LoginSecondFactor
    {api}
    {challenge}
    {ondone}
    oncancel={() => {
      challenge = null;
      error = '';
    }}
  />
{:else}
<AuthCard title={t('auth:login.title')} subtitle={t('auth:login.subtitle')}>
  <form onsubmit={submit} class="stack" novalidate>
    {#if notice}<Alert tone="info">{notice}</Alert>{/if}
    <TextField
      label={t('auth:login.email')}
      type="email"
      bind:value={email}
      autocomplete="username"
      required
      error={emailError}
      onblur={() => (touched.email = true)}
    />
    <TextField
      label={t('auth:login.password')}
      type="password"
      reveal
      bind:value={password}
      autocomplete="current-password"
      required
      error={passwordError}
      onblur={() => (touched.password = true)}
    />
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <Button variant="primary" type="submit" size="lg" block loading={busy}>
      {busy ? t('auth:login.submitting') : t('auth:login.submit')}
    </Button>
  </form>
</AuthCard>
{/if}
