<script lang="ts">
  import { ApiError, type Api } from '../lib/api.ts';
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
  let error = $state('');
  let touched = $state({ displayName: false, email: false, password: false, workspaceName: false });

  const problems = $derived({
    displayName: requiredProblem(displayName, 'your name'),
    email: emailProblem(email),
    password: passwordProblem(password, MIN_PASSWORD),
    workspaceName: requiredProblem(workspaceName, 'a workspace name'),
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
    error = '';
    try {
      await api.register({ email: email.trim(), displayName: displayName.trim(), password, workspaceName: workspaceName.trim() });
      ondone();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<AuthCard
  title="Set up your workspace"
  subtitle="Create the first account. It becomes the owner of the workspace."
>
  <form onsubmit={submit} class="stack" novalidate>
    <TextField
      label="Your name"
      bind:value={displayName}
      autocomplete="name"
      required
      error={shown.displayName}
      onblur={() => (touched.displayName = true)}
    />
    <TextField
      label="Email"
      type="email"
      bind:value={email}
      autocomplete="email"
      required
      error={shown.email}
      onblur={() => (touched.email = true)}
    />
    <TextField
      label="Password"
      type="password"
      reveal
      bind:value={password}
      autocomplete="new-password"
      required
      hint="At least {MIN_PASSWORD} characters. A few random words work well."
      error={shown.password}
      onblur={() => (touched.password = true)}
    />
    <TextField
      label="Workspace name"
      bind:value={workspaceName}
      placeholder="Your company or team"
      hint="Teammates see this name when you invite them."
      required
      error={shown.workspaceName}
      onblur={() => (touched.workspaceName = true)}
    />
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <p class="quiet">Registration closes once this account exists.</p>
    <Button variant="primary" type="submit" size="lg" block loading={busy}>
      {busy ? 'Creating workspace' : 'Create workspace'}
    </Button>
  </form>
</AuthCard>
