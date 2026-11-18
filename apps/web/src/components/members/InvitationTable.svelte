<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { roleIcons } from '../../lib/status-icons.ts';
  import type { Invitation } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import { expiresIn } from './expiry.ts';
  import { roleLabel } from './roles.ts';

  let {
    invitations,
    busyId,
    onrevoke,
  }: {
    invitations: Invitation[];
    busyId: string;
    onrevoke: (invitation: Invitation) => void;
  } = $props();

  const now = Date.now();
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Pending invitations</caption>
    <thead>
      <tr>
        <th scope="col">Email</th>
        <th scope="col">Role</th>
        <th scope="col">Invited by</th>
        <th scope="col">Expires</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each invitations as invitation (invitation.id)}
        <tr>
          <td>{invitation.email}</td>
          <td><Badge icon={roleIcons[invitation.role]}>{roleLabel[invitation.role]}</Badge></td>
          <td class="muted">{invitation.createdByName ?? 'Unknown'}</td>
          <td class="muted" title={fullTime(invitation.expiresAt)}>{expiresIn(invitation.expiresAt, now)}</td>
          <td class="actions">
            <Button
              variant="danger"
              size="sm"
              disabled={busyId === invitation.id}
              label="Revoke invitation for {invitation.email}"
              onclick={() => onrevoke(invitation)}>Revoke</Button
            >
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
