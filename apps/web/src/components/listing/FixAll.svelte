<!--
  FixAll: "Fix all that can be fixed (N)" for one locale or a whole app: opens the review of every mechanical fix at once (one per field, the strongest),
  and "Stage fixes" puts them in the pending changes. Drawn only when at least one can be staged. Off with its reason for a locked version or a role
  that may not stage. Props: api, workspaceId, role, appId, fixes (the fixes to stage, from `fixAllOf`), locked, onchanged.
-->
<script lang="ts">
  import { can, type Fix, type Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Button from '../ui/Button.svelte';
  import FixReview from './FixReview.svelte';

  let {
    api,
    workspaceId,
    role,
    appId,
    fixes,
    locked = false,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    appId: string;
    fixes: Fix[];
    locked?: boolean | undefined;
    onchanged?: (() => void | Promise<void>) | undefined;
  } = $props();

  let open = $state(false);
  const reason = $derived(locked ? t('listing:fix.locked') : can(role, 'changesets.write') ? null : t('listing:fix.noRight'));
</script>

{#if fixes.length > 0}
  <Button variant="secondary" size="sm" icon="zap" disabled={reason !== null} title={reason ?? undefined} onclick={() => (open = true)}>
    {t('listing:fix.all', { count: fixes.length })}
  </Button>
  {#if reason !== null}<span class="muted hint">{reason}</span>{/if}
  <FixReview {api} {workspaceId} {appId} {fixes} bind:open onstaged={onchanged} />
{/if}

<style>
  .hint {
    font-size: var(--text-sm);
  }
</style>
