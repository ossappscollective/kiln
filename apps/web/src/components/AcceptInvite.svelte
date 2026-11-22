<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { InvitationPreview, User } from '../lib/types.ts';
  import AuthCard from './AuthCard.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import { roleLabel } from './members/roles.ts';
  import { k, t } from '../lib/i18n/t.ts';
  import { msg, msgText, rawMsg, type Msg } from '../lib/message.ts';
  import T from './ui/T.svelte';

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
    | { name: 'invalid'; message: Msg }
    | { name: 'ready'; invitation: InvitationPreview; user: User | null };

  let load = $state<Load>({ name: 'loading' });
  let displayName = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<Msg | null>(null);
  let accountExists = $state(false);

  const INVALID = msg(k('auth:invite.invalid'));

  async function start() {
    load = { name: 'loading' };
    try {
      const [invitation, status] = await Promise.all([api.invitation(token), api.status()]);
      load = { name: 'ready', invitation, user: status.user };
    } catch (e) {
      // Not found for every kind of bad link, on purpose; say what a person can do about it.
      load = {
        name: 'invalid',
        message: e instanceof ApiError && e.status !== 404 ? rawMsg(e.message) : INVALID,
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
      localStorage.setItem('kiln.workspace', workspaceId);
    } catch {
      // Storage can be refused in a private window. The first workspace is shown instead.
    }
  }

  async function accept(body: { displayName?: string; password?: string }) {
    busy = true;
    error = null;
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
        error = e instanceof ApiError ? rawMsg(e.message) : msg(k('common:error.genericRetry'));
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
      error = e instanceof ApiError ? rawMsg(e.message) : msg(k('auth:invite.signOutFailed'));
    } finally {
      busy = false;
    }
    await start();
  }
</script>

{#if load.name === 'loading'}
  <p class="center muted" role="status">{t('auth:invite.checking')}</p>
{:else if load.name === 'invalid'}
  <AuthCard title={t('auth:invite.invalidTitle')}>
    <Alert tone="error">{msgText(load.message)}</Alert>
    <p class="back"><Button variant="primary" size="lg" block onclick={onleave}>{t('auth:invite.goToApp')}</Button></p>
  </AuthCard>
{:else}
  {@const invitation = load.invitation}
  {@const user = load.user}
  <AuthCard
    title={t('auth:invite.title', { workspace: invitation.workspaceName })}
    subtitle={t('auth:invite.subtitle', { role: roleLabel[invitation.role].toLowerCase(), email: invitation.email })}
  >
    {#if user && sameEmail(user.email, invitation.email)}
      <div class="stack">
        <p><T key="auth:invite.signedInAs" params={{ email: user.email }} /></p>
        {#if error}<Alert tone="error">{msgText(error)}</Alert>{/if}
        <Button variant="primary" size="lg" block loading={busy} onclick={() => accept({})}>
          {busy ? t('auth:invite.joining') : t('auth:invite.title', { workspace: invitation.workspaceName })}
        </Button>
      </div>
    {:else if user}
      <div class="stack">
        <Alert tone="warn" title={t('auth:invite.wrongAccountTitle')}>
          <T key="auth:invite.wrongAccount" params={{ invited: invitation.email, current: user.email }} />
        </Alert>
        {#if error}<Alert tone="error">{msgText(error)}</Alert>{/if}
        <Button variant="primary" size="lg" block loading={busy} onclick={signOut}>{t('shell:account.signOut')}</Button>
      </div>
    {:else}
      <form onsubmit={submitNew} class="stack">
        <div class="field">
          <label for="invite-account-email">{t('auth:login.email')}</label>
          <input id="invite-account-email" type="email" value={invitation.email} readonly />
        </div>
        <div class="field">
          <label for="invite-name">{t('auth:invite.yourName')}</label>
          <input id="invite-name" bind:value={displayName} autocomplete="name" required />
        </div>
        <div class="field">
          <label for="invite-password">{t('auth:invite.choosePassword')}</label>
          <input
            id="invite-password"
            type="password"
            bind:value={password}
            autocomplete="new-password"
            minlength="12"
            required
          />
          <p class="hint">{t('auth:password.hint', { min: 12 })}</p>
        </div>
        {#if error}<Alert tone="error">{msgText(error)}</Alert>{/if}
        {#if accountExists}
          <Button variant="primary" size="lg" block onclick={onleave}>{t('auth:login.submit')}</Button>
        {/if}
        <Button type="submit" variant={accountExists ? 'secondary' : 'primary'} size="lg" block loading={busy}>
          {busy ? t('auth:invite.creating') : t('auth:invite.createAndJoin')}
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
    font-size: 1rem;
  }

  .back {
    margin: var(--space-5) 0 0;
  }
</style>
