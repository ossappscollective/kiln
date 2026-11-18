<!--
  AppSettings: facts about each record of the app and, for admins, removing one from the workspace.
  Nothing in a store is changed. Stores, credentials, release defaults and notifications settings
  of an app are not built yet; this page says so instead of showing empty controls.
  Props: api, workspaceId, role, members (the records in scope), now.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appErrorMessage, appLabel, describeError, platformLabel, portfolioHref, storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Modal from '../ui/Modal.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  const canWrite = $derived(can(role, 'apps.write'));

  let target = $state<AppSummary | null>(null);
  let open = $state(false);
  let deleting = $state(false);
  let problem = $state('');

  async function remove() {
    if (!target) return;
    const app = target;
    deleting = true;
    problem = '';
    try {
      await api.deleteApp(workspaceId, app.id);
      open = false;
      toast.success(`Deleted ${appLabel(app)}. Nothing in the store was changed.`);
      location.hash = portfolioHref;
    } catch (e) {
      problem = e instanceof ApiError ? appErrorMessage(e, 'delete') : describeError(e, 'delete');
    } finally {
      deleting = false;
    }
  }
</script>

<div class="stack loose">
  {#each members as app (app.id)}
    <section class="card" aria-label="{platformLabel(app.platform)} record">
      <div class="row between">
        <PlatformBadge platform={app.platform} tinted />
        {#if canWrite}
          <Button
            variant="danger"
            icon="trash"
            onclick={() => {
              target = app;
              problem = '';
              open = true;
            }}>Delete {platformLabel(app.platform)} app</Button
          >
        {/if}
      </div>
      <dl class="facts">
        <div>
          <dt>Store</dt>
          <dd>{storeName(app.platform)}</dd>
        </div>
        <div>
          <dt>{app.platform === 'ios' ? 'Bundle ID' : 'Package name'}</dt>
          <dd class="row"><code>{app.identifier}</code><CopyButton value={app.identifier} iconOnly label="Copy the identifier" /></dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd><time datetime={new Date(app.createdAt).toISOString()} title={fullTime(app.createdAt)}>{timeAgo(app.createdAt, now)}</time></dd>
        </div>
      </dl>
    </section>
  {/each}
  <p class="muted note">Stores and credentials, repository targets, release defaults and notifications for an app are not available here yet.</p>
</div>

{#if canWrite}
  <Modal bind:open size="sm" title="Delete this app?" dismissible={!deleting}>
    {#if target}
      <div class="stack">
        <p>
          <strong>{target.name}</strong> ({platformLabel(target.platform)}, {target.identifier}) and its stored releases will be removed from this workspace.
        </p>
        <p class="muted">Nothing in {storeName(target.platform)} is changed. You can add the app again later.</p>
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      </div>
    {/if}
    {#snippet footer()}
      <Button disabled={deleting} onclick={() => (open = false)}>Cancel</Button>
      <Button variant="danger-solid" loading={deleting} onclick={remove}>Delete app</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4) var(--space-6);
    margin: var(--space-4) 0 0;
  }

  .facts dt {
    margin-bottom: var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
