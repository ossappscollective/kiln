<script lang="ts">
  import { ApiError, type Api } from '../lib/api.ts';
  import { type LoginChallenge, isLoginChallenge } from '../lib/two-factor.ts';
  import { emailProblem } from '../lib/validate.ts';
  import AuthCard from './AuthCard.svelte';
  import LoginSecondFactor from './LoginSecondFactor.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import TextField from './ui/TextField.svelte';

  let { api, notice, ondone }: { api: Api; notice?: string; ondone: () => void } = $props();

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  // Problems show once a field has been left, or after a failed attempt to submit.
  let touched = $state({ email: false, password: false });
  // Set when the server asks for a second factor after the password (docs/api/two-factor.md): shown in place of this form.
  let challenge = $state<LoginChallenge | null>(null);

  const emailError = $derived(touched.email ? emailProblem(email) : '');
  const passwordError = $derived(touched.password && !password ? 'Enter your password.' : '');

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
      error = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
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
<AuthCard title="Sign in" subtitle="Use the email and password for your account.">
  <form onsubmit={submit} class="stack" novalidate>
    {#if notice}<Alert tone="info">{notice}</Alert>{/if}
    <TextField
      label="Email"
      type="email"
      bind:value={email}
      autocomplete="username"
      required
      error={emailError}
      onblur={() => (touched.email = true)}
    />
    <TextField
      label="Password"
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
      {busy ? 'Signing in' : 'Sign in'}
    </Button>
  </form>
</AuthCard>
{/if}
