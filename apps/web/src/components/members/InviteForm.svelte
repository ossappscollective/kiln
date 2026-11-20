<script lang="ts">
  import { type Role, invitableBy } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import type { CreatedInvitation } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import { roleHelp, roleLabel } from './roles.ts';

  let {
    api,
    workspaceId,
    role,
    oncreated,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    oncreated: (created: CreatedInvitation) => void;
  } = $props();

  const options = $derived(invitableBy(role));
  let email = $state('');
  let chosen = $state<string>('member');
  const selected = $derived(options.find((r) => r === chosen) ?? options[options.length - 1] ?? 'member');
  let busy = $state(false);
  let error = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      const created = await api.createInvitation(workspaceId, { email, role: selected });
      email = '';
      oncreated(created);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<form class="card" onsubmit={submit}>
  <div class="card-header">
    <div>
      <h3>Invite someone</h3>
      <p>You get a link to send them; this server sends no email. It works only for the address you enter.</p>
    </div>
  </div>
  <div class="grid">
    <div class="field">
      <label for="invite-email">Email</label>
      <input id="invite-email" type="email" bind:value={email} autocomplete="off" required />
    </div>
    <div class="field">
      <label for="invite-role">Role</label>
      <select id="invite-role" value={selected} onchange={(e) => (chosen = e.currentTarget.value)}>
        {#each options as r (r)}<option value={r}>{roleLabel[r]}</option>{/each}
      </select>
    </div>
  </div>
  <p class="hint">{roleHelp[selected as Role]}</p>
  {#if error}<div class="problem"><Alert tone="error">{error}</Alert></div>{/if}
  <div class="row actions">
    <Button type="submit" variant="primary" loading={busy}>{busy ? 'Creating…' : 'Create invitation link'}</Button>
  </div>
</form>

<style>
  .grid {
    display: grid;
    gap: 12px 16px;
    grid-template-columns: 1fr 180px;
  }

  .actions {
    margin-top: 16px;
  }

  .problem {
    margin-top: 12px;
  }

  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
