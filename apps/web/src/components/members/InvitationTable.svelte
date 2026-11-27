<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { roleIcons } from '../../lib/status-icons.ts';
  import type { Invitation } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import { expiresIn } from './expiry.ts';
  import { roleLabel } from './roles.ts';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let {
    invitations,
    busyId,
    onrevoke,
  }: {
    invitations: Invitation[];
    busyId: string;
    onrevoke: (invitation: Invitation) => void;
  } = $props();

  const clock = useNow();
  const now = $derived(clock.value);
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">{t('workspace:members.invitations.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('workspace:members.invitations.email')}</th>
        <th scope="col">{t('workspace:members.invitations.role')}</th>
        <th scope="col">{t('workspace:members.invitations.invitedBy')}</th>
        <th scope="col">{t('workspace:members.invitations.expires')}</th>
        <th scope="col"><span class="visually-hidden">{t('workspace:members.invitations.actions')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each invitations as invitation (invitation.id)}
        <tr>
          <td>{invitation.email}</td>
          <td><Badge icon={roleIcons[invitation.role]}>{roleLabel[invitation.role]}</Badge></td>
          <td class="muted">{invitation.createdByName ?? t('workspace:members.invitations.unknown')}</td>
          <td class="muted" title={fullTime(invitation.expiresAt)}>{expiresIn(invitation.expiresAt, now)}</td>
          <td class="actions">
            <Button
              variant="danger"
              size="sm"
              disabled={busyId === invitation.id}
              label={t('workspace:members.invitations.revokeLabel', { email: invitation.email })}
              onclick={() => onrevoke(invitation)}>{t('workspace:members.invitations.revoke')}</Button
            >
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  td,
  th {
    font-size: 0.9375rem;
  }
</style>
