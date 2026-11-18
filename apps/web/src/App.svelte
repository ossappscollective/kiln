<script lang="ts">
  import { onMount } from 'svelte';
  import AcceptInvite from './components/AcceptInvite.svelte';
  import AuthCard from './components/AuthCard.svelte';
  import LaunchRequired from './components/LaunchRequired.svelte';
  import Login from './components/Login.svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import Alert from './components/ui/Alert.svelte';
  import Button from './components/ui/Button.svelte';
  import Logo from './components/ui/Logo.svelte';
  import Spinner from './components/ui/Spinner.svelte';
  import ToastHost from './components/ui/ToastHost.svelte';
  import { tokenFromHash } from './components/members/links.ts';
  import { ApiError, createApi } from './lib/api.ts';
  import { initTheme } from './lib/theme.ts';
  import type { Me } from './lib/types.ts';

  type Phase =
    | { name: 'loading' }
    | { name: 'unreachable'; message: string }
    | { name: 'setup' }
    | { name: 'login'; notice?: string }
    | { name: 'launch' }
    | { name: 'app'; me: Me };

  // Apply the saved theme before anything renders.
  initTheme();

  let phase = $state<Phase>({ name: 'loading' });
  // The desktop app's server has no sign-in. Without a session the person has to come in through
  // the shell, so every "signed out" path shows that instead of the sign-in form.
  let singleUser = $state(false);

  const api = createApi({
    onUnauthenticated: () => {
      if (phase.name !== 'app') return;
      phase = singleUser ? { name: 'launch' } : { name: 'login', notice: 'Your session has ended. Sign in again.' };
    },
  });

  async function start() {
    try {
      const status = await api.status();
      singleUser = status.mode === 'single_user';
      if (singleUser) phase = status.user ? { name: 'app', me: await api.me() } : { name: 'launch' };
      else if (status.setupRequired) phase = { name: 'setup' };
      else if (status.user) phase = { name: 'app', me: await api.me() };
      else phase = { name: 'login' };
    } catch (e) {
      phase = { name: 'unreachable', message: e instanceof ApiError ? e.message : 'Something went wrong.' };
    }
  }

  async function enter() {
    try {
      phase = { name: 'app', me: await api.me() };
    } catch (e) {
      phase = { name: 'unreachable', message: e instanceof ApiError ? e.message : 'Something went wrong.' };
    }
  }

  // An invitation link (#/invite/<token>) is shown whether or not anyone is signed in.
  let inviteToken = $state(tokenFromHash(location.hash));
  $effect(() => {
    const onhash = () => (inviteToken = tokenFromHash(location.hash));
    window.addEventListener('hashchange', onhash);
    return () => window.removeEventListener('hashchange', onhash);
  });

  function leaveInvite() {
    inviteToken = null;
    location.hash = '';
    phase = { name: 'loading' };
    void start();
  }

  onMount(() => {
    void start();
  });
</script>

{#if inviteToken}
  <AcceptInvite
    {api}
    token={inviteToken}
    ondone={() => {
      inviteToken = null;
      location.hash = '';
      void enter();
    }}
    onsignedout={() => (phase = singleUser ? { name: 'launch' } : { name: 'login' })}
    onleave={leaveInvite}
  />
{:else if phase.name === 'loading'}
  <main class="boot" aria-busy="true">
    <Logo size={40} />
    <p class="muted row" role="status"><Spinner label="" /> Loading</p>
  </main>
{:else if phase.name === 'unreachable'}
  <AuthCard title="Cannot reach the server" subtitle="Check that the server is running, then try again.">
    <div class="stack">
      <Alert tone="error">{phase.message}</Alert>
      <Button
        icon="refresh"
        onclick={() => {
          phase = { name: 'loading' };
          void start();
        }}>Try again</Button
      >
    </div>
  </AuthCard>
{:else if phase.name === 'launch'}
  <LaunchRequired onretry={() => { phase = { name: 'loading' }; void start(); }} />
{:else if phase.name === 'setup'}
  <Setup {api} ondone={enter} />
{:else if phase.name === 'login'}
  <Login {api} notice={phase.notice} ondone={enter} />
{:else}
  <Shell
    {api}
    me={phase.me}
    canSignOut={!singleUser}
    onsignout={() => (phase = singleUser ? { name: 'launch' } : { name: 'login' })}
  />
{/if}

<ToastHost />

<style>
  .boot {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    min-height: 100dvh;
  }
</style>
