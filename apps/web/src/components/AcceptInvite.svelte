<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { InvitationPreview, User } from '../lib/types.ts';
  import AuthCard from './AuthCard.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import { roleLabel } from './members/roles.ts';

  let {
    api,
    token,
    ondone,
    onsignedout,
    onleave,
  }: {
    api: Api;
    token: string;
    /** The person is now a member. `workspaceId` is the workspace they joined. */
    ondone: (workspaceId: string) => void;
    /** The person signed out here, so the app must forget who was signed in. */
    onsignedout: () => void;
    /** Leave this screen: the app starts over and shows the sign-in page or the workspace. */
    onleave: () => void;
  } = $props();

  type Load =
    | { name: 'loading' }
    | { name: 'invalid'; message: string }
    | { name: 'ready'; invitation: InvitationPreview; user: User | null };

  let load = $state<Load>({ name: 'loading' });
  let displayName = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let accountExists = $state(false);

  const INVALID =
    'This invitation link is not valid. It may have expired, been used already or been revoked. Ask the person who invited you for a new link.';

  async function start() {
    load = { name: 'loading' };
    try {
      const [invitation, status] = await Promise.all([api.invitation(token), api.status()]);
      load = { name: 'ready', invitation, user: status.user };
    } catch (e) {
      // Not found for every kind of bad link, on purpose; say what a person can do about it.
      load = {
        name: 'invalid',
        message: e instanceof ApiError && e.status !== 404 ? e.message : INVALID,
      };
    }
  }

  onMount(() => {
    void start();
  });

  const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // Shell opens the workspace the person last used; make that the one they just joined.
  function remember(workspaceId: string) {
    try {
      localStorage.setItem('mrm.workspace', workspaceId);
    } catch {
      // Storage can be refused in a private window. The first workspace is shown instead.
    }
  }

  async function accept(body: { displayName?: string; password?: string }) {
    busy = true;
    error = '';
    accountExists = false;
    try {
      const joined = await api.acceptInvitation(token, body);
      remember(joined.workspaceId);
      ondone(joined.workspaceId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        load = { name: 'invalid', message: INVALID };
      } else {
        accountExists = e instanceof ApiError && e.code === 'account_exists';
        error = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
      }
    } finally {
      busy = false;
    }
  }

  function submitNew(event: SubmitEvent) {
    event.preventDefault();
    void accept({ displayName, password });
  }

  async function signOut() {
    busy = true;
    try {
      await api.logout();
      onsignedout();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not sign out. Try again.';
    } finally {
      busy = false;
    }
    await start();
  }
</script>

{#if load.name === 'loading'}
  <p class="center muted" role="status">Checking your invitation…</p>
{:else if load.name === 'invalid'}
  <AuthCard title="Invitation not valid">
    <Alert tone="error">{load.message}</Alert>
    <p class="back"><Button variant="link" onclick={onleave}>Go to the app</Button></p>
  </AuthCard>
{:else}
  {@const invitation = load.invitation}
  {@const user = load.user}
  <AuthCard
    title="Join {invitation.workspaceName}"
    subtitle="You were invited as {roleLabel[invitation.role].toLowerCase()} for {invitation.email}."
  >
    {#if user && sameEmail(user.email, invitation.email)}
      <div class="stack">
        <p>You are signed in as <strong>{user.email}</strong>.</p>
        {#if error}<Alert tone="error">{error}</Alert>{/if}
        <Button variant="primary" loading={busy} onclick={() => accept({})}>
          {busy ? 'Joining…' : `Join ${invitation.workspaceName}`}
        </Button>
      </div>
    {:else if user}
      <div class="stack">
        <Alert tone="warn" title="This invitation is for a different account">
          It is for <strong>{invitation.email}</strong>, but you are signed in as
          <strong>{user.email}</strong>. Sign out, then open the link again.
        </Alert>
        {#if error}<Alert tone="error">{error}</Alert>{/if}
        <Button loading={busy} onclick={signOut}>Sign out</Button>
      </div>
    {:else}
      <form onsubmit={submitNew} class="stack">
        <div class="field">
          <label for="invite-account-email">Email</label>
          <input id="invite-account-email" type="email" value={invitation.email} readonly />
        </div>
        <div class="field">
          <label for="invite-name">Your name</label>
          <input id="invite-name" bind:value={displayName} autocomplete="name" required />
        </div>
        <div class="field">
          <label for="invite-password">Choose a password</label>
          <input
            id="invite-password"
            type="password"
            bind:value={password}
            autocomplete="new-password"
            minlength="12"
            required
          />
          <p class="hint">At least 12 characters. A few random words work well.</p>
        </div>
        {#if error}<Alert tone="error">{error}</Alert>{/if}
        {#if accountExists}
          <Button onclick={onleave}>Sign in</Button>
        {/if}
        <Button type="submit" variant="primary" loading={busy}>
          {busy ? 'Creating account…' : 'Create account and join'}
        </Button>
      </form>
    {/if}
  </AuthCard>
{/if}

<style>
  .center {
    display: grid;
    min-height: 100vh;
    place-content: center;
  }

  .back {
    margin: 16px 0 0;
  }
</style>
