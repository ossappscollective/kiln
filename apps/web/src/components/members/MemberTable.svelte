<script lang="ts">
  import { type Role, assignableBy, decideRemoval, decideRoleChange } from '@mrm/core';
  import type { Member } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import { roleLabel } from './roles.ts';

  let {
    members,
    myId,
    myRole,
    busyId,
    onchangerole,
    onremove,
  }: {
    members: Member[];
    myId: string;
    myRole: Role;
    busyId: string;
    onchangerole: (member: Member, role: Role) => void;
    onremove: (member: Member) => void;
  } = $props();

  const ownerCount = $derived(members.filter((m) => m.role === 'owner').length);
  /** The member whose removal waits for confirmation in the dialog. */
  let confirming = $state<Member | null>(null);
  let open = $state(false);

  // Only the roles the API would accept for this person, so the selector never offers a refusal.
  const rolesFor = (member: Member) =>
    assignableBy(myRole).filter(
      (next) =>
        next !== member.role &&
        decideRoleChange({ actorRole: myRole, targetRole: member.role, newRole: next, ownerCount }).ok,
    );
  const canRemove = (member: Member) =>
    decideRemoval({ actorRole: myRole, self: member.userId === myId, targetRole: member.role, ownerCount }).ok;
  const lastOwner = (member: Member) => member.role === 'owner' && ownerCount <= 1;

  function ask(member: Member) {
    confirming = member;
    open = true;
  }

  function confirm() {
    const member = confirming;
    open = false;
    if (member) onremove(member);
  }
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Members of this workspace</caption>
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Email</th>
        <th scope="col">Role</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each members as member (member.userId)}
        {@const options = rolesFor(member)}
        {@const self = member.userId === myId}
        <tr>
          <td>
            {member.displayName}
            {#if self}<Badge>You</Badge>{/if}
          </td>
          <td class="muted">{member.email}</td>
          <td>
            {#if options.length > 0}
              <label class="visually-hidden" for="role-{member.userId}">Role of {member.displayName}</label>
              <select
                id="role-{member.userId}"
                class="role"
                value={member.role}
                disabled={busyId === member.userId}
                onchange={(e) => {
                  const next = e.currentTarget.value as Role;
                  e.currentTarget.value = member.role;
                  onchangerole(member, next);
                }}
              >
                <option value={member.role}>{roleLabel[member.role]}</option>
                {#each options as r (r)}<option value={r}>{roleLabel[r]}</option>{/each}
              </select>
            {:else}
              <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>{roleLabel[member.role]}</Badge>
              {#if lastOwner(member)}<span class="hint inline">Last owner</span>{/if}
            {/if}
          </td>
          <td class="actions">
            {#if canRemove(member)}
              <Button
                variant="danger"
                size="sm"
                disabled={busyId === member.userId}
                label={self ? 'Leave this workspace' : `Remove ${member.displayName}`}
                onclick={() => ask(member)}>{self ? 'Leave' : 'Remove'}</Button
              >
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal
  bind:open
  size="sm"
  title={confirming && confirming.userId === myId ? 'Leave this workspace?' : 'Remove this person?'}
  onclose={() => (confirming = null)}
>
  {#if confirming}
    {#if confirming.userId === myId}
      <p>You will lose access to this workspace until someone invites you again.</p>
    {:else}
      <p>
        <strong>{confirming.displayName}</strong> ({confirming.email}) will lose access to this
        workspace. They can be invited again later.
      </p>
    {/if}
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger-solid" onclick={confirm}>
      {confirming && confirming.userId === myId ? 'Leave' : 'Remove'}
    </Button>
  {/snippet}
</Modal>

<style>
  .role {
    width: auto;
    min-width: 120px;
  }

  .inline {
    display: inline;
    margin-left: 8px;
  }
</style>
