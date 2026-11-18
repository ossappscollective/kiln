<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { CreatedInvitation, Invitation, Member } from '../lib/types.ts';
  import InvitationTable from './members/InvitationTable.svelte';
  import InviteForm from './members/InviteForm.svelte';
  import InviteLink from './members/InviteLink.svelte';
  import MemberTable from './members/MemberTable.svelte';
  import { roleLabel } from './members/roles.ts';
  import Alert from './ui/Alert.svelte';
  import PageHeader from './ui/PageHeader.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'members.read'));
  const canManage = $derived(can(role, 'members.manage'));

  let members = $state<Member[] | null>(null);
  let invitations = $state<Invitation[] | null>(null);
  /** Single-user servers answer the invitation endpoints with 403 disabled_in_single_user_mode. */
  let invitesOff = $state(false);
  let myId = $state('');
  let error = $state('');
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();
  /** The one-time link, kept only in this component's memory until dismissed. */
  let created = $state<{ token: string; email: string } | null>(null);
  let busyId = $state('');

  async function loadInvitations() {
    if (!canManage || invitesOff) return;
    try {
      invitations = (await api.invitations(workspaceId)).invitations;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'disabled_in_single_user_mode') invitesOff = true;
      else error = e instanceof ApiError ? e.message : 'Could not load invitations.';
    }
  }

  async function load() {
    error = '';
    try {
      const [list, me] = await Promise.all([api.members(workspaceId), api.me()]);
      members = list.members;
      myId = me.user.id;
    } catch (e) {
      members = null;
      error = e instanceof ApiError ? e.message : 'Could not load members.';
      return;
    }
    await loadInvitations();
  }

  $effect(() => {
    void workspaceId;
    members = null;
    invitations = null;
    invitesOff = false;
    created = null;
    notice = '';
    if (canRead) void load();
  });

  async function announce(message: string) {
    notice = message;
    await tick();
    noticeEl?.focus();
  }

  async function oncreated(result: CreatedInvitation) {
    created = { token: result.token, email: result.invitation.email };
    notice = '';
    await loadInvitations();
  }

  // Your own role or membership just changed, so what you may see changed too. Start over.
  const restart = () => location.reload();

  async function changeRole(member: Member, next: Role) {
    busyId = member.userId;
    error = '';
    try {
      await api.changeRole(workspaceId, member.userId, next);
      if (member.userId === myId) return restart();
      await load();
      await announce(`${member.displayName} is now ${roleLabel[next].toLowerCase()}.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not change the role.';
    } finally {
      busyId = '';
    }
  }

  async function remove(member: Member) {
    busyId = member.userId;
    error = '';
    try {
      await api.removeMember(workspaceId, member.userId);
      if (member.userId === myId) return restart();
      await load();
      await announce(`Removed ${member.displayName}.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not remove that person.';
    } finally {
      busyId = '';
    }
  }

  async function revoke(invitation: Invitation) {
    busyId = invitation.id;
    error = '';
    try {
      await api.revokeInvitation(workspaceId, invitation.id);
      await loadInvitations();
      await announce(`Revoked the invitation for ${invitation.email}.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not revoke the invitation.';
      await loadInvitations();
    } finally {
      busyId = '';
    }
  }
</script>

<section>
  <PageHeader
    title="Members"
    description="Who can use this workspace. People join by invitation link; there is no open sign-up."
  />

  {#if !canRead}
    <Alert tone="info">Your role does not include the member list.</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>
    {#if error}<div class="problem"><Alert tone="error">{error}</Alert></div>{/if}

    {#if members === null && !error}
      <p class="muted">Loading…</p>
    {:else if members}
      <MemberTable
        {members}
        {myId}
        myRole={role}
        {busyId}
        onchangerole={changeRole}
        onremove={remove}
      />
    {/if}

    {#if canManage}
      <div class="stack section">
        {#if invitesOff}
          <Alert tone="info">
            Invitations are not available in single-user mode, where one person uses this server.
          </Alert>
        {:else}
          {#if created}
            <InviteLink token={created.token} email={created.email} ondismiss={() => (created = null)} />
          {/if}
          <InviteForm {api} {workspaceId} {role} {oncreated} />

          <div>
            <h3>Pending invitations</h3>
            {#if invitations === null}
              <p class="muted">Loading…</p>
            {:else if invitations.length === 0}
              <p class="muted">No pending invitations.</p>
            {:else}
              <div class="table">
                <InvitationTable {invitations} {busyId} onrevoke={revoke} />
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .section {
    margin-top: 32px;
  }

  .table {
    margin-top: 12px;
  }

  .problem {
    margin-bottom: 16px;
  }

  .notice {
    display: none;
    padding: 10px 12px;
    margin: 0 0 16px;
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-radius: 6px;
  }

  .notice.shown {
    display: block;
  }
</style>
