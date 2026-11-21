<!--
  StoresSection: the store and the credential each record of the app is linked to, and the last sync.
  Reads the credential list (members and above; others see "not shown"). A member or admin can test the
  saved credential: that only asks the provider whether it works (it changes nothing in a store).
  An iOS record with no macOS record offers "Add the macOS version": one more record of the same app entry
  (the same credential, and the bundle ID prefilled; a Mac app with its own bundle ID can change it).
  Props: api, workspaceId, role, members (the records in scope), all? (every record of the app; the members
  when not given), now.
-->
<script lang="ts">
  import { can, platformMeta, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { credentialFacts, links, notAvailable } from '../../../lib/app-settings.ts';
  import { appAddress } from '../../../lib/app-scope.ts';
  import { testErrorMessage } from '../../../lib/credentials.ts';
  import { fullTime, timeAgo } from '../../../lib/format.ts';
  import { countOf } from '../../../lib/section-state.ts';
  import { platformLabel, storeName, syncInfo } from '../../../lib/portfolio.ts';
  import type { AppSummary, CredentialSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import CopyButton from '../../ui/CopyButton.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import AddAppModal from '../../portfolio/AddAppModal.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members, all, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; all?: AppSummary[] | undefined; now: number } = $props();

  const records = $derived(all ?? members);
  const iosRecord = $derived(records.find((r) => r.platform === 'ios') ?? null);
  const canAdd = $derived(can(role, 'apps.write'));
  /** Quiet by default: the offer only exists for an iOS app that has no macOS record yet. */
  const offerMac = $derived(canAdd && iosRecord !== null && !records.some((r) => r.platform === 'macos'));
  let adding = $state(false);

  const canRead = $derived(can(role, 'credentials.read'));
  const canTest = $derived(can(role, 'credentials.write'));

  let list = $state<CredentialSummary[] | null>(null);
  let loadProblem = $state('');
  let testing = $state('');
  let results = $state<Record<string, { ok: boolean; message: string } | undefined>>({});

  $effect(() => {
    const id = workspaceId;
    const allowed = canRead;
    untrack(() => {
      list = null;
      loadProblem = '';
    });
    if (!allowed) return;
    let current = true;
    api
      .credentials(id)
      .then((r) => {
        if (current) list = r.credentials;
      })
      .catch(() => {
        if (current) loadProblem = 'Could not read the credentials. Reload the page to try again.';
      });
    return () => {
      current = false;
    };
  });

  async function test(app: AppSummary) {
    if (testing !== '') return;
    testing = app.id;
    try {
      const done = await api.testCredential(workspaceId, app.credentialId);
      results = { ...results, [app.id]: { ok: done.ok, message: done.message } };
      const fresh = await api.credentials(workspaceId);
      list = fresh.credentials;
    } catch (e) {
      results = { ...results, [app.id]: { ok: false, message: testErrorMessage(e) } };
    } finally {
      testing = '';
    }
  }
</script>

<SettingsCard
  title="Stores and credentials"
  icon="key"
  description="Which store each record of this app is in and the credential it reads it with. Secrets are never shown."
  unavailable={notAvailable.changeCredential}
  summary={countOf(records.length, 'store record')}
>
  {#if loadProblem}<Alert tone="warn">{loadProblem}</Alert>{/if}
  <div class="stack">
    {#each members as app (app.id)}
      {@const cred = credentialFacts(app.credentialId, canRead ? list : null, now)}
      {@const sync = syncInfo(app, now)}
      <div class="record">
        <div class="row between">
          <PlatformBadge platform={app.platform} tinted />
          <span class="muted">{storeName(app.platform)}</span>
        </div>
        <dl class="facts">
          <div>
            <dt>{platformMeta(app.platform).identifierLabel}</dt>
            <dd class="row"><code>{app.identifier}</code><CopyButton value={app.identifier} iconOnly label="Copy the identifier" /></dd>
          </div>
          {#if app.storeAppId}
            <div>
              <dt>Store id</dt>
              <dd><code>{app.storeAppId}</code></dd>
            </div>
          {/if}
          <div>
            <dt>Credential</dt>
            <dd class="row wrap">
              <span>{cred.label}</span>
              {#if cred.kind}<span class="muted">({cred.kind})</span>{/if}
              <Badge tone={cred.tone === 'none' ? 'neutral' : cred.tone}>{cred.status}</Badge>
            </dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>
              {#if app.lastSyncedAt !== null}
                <time datetime={new Date(app.lastSyncedAt).toISOString()} title={fullTime(app.lastSyncedAt)}>{timeAgo(app.lastSyncedAt, now)}</time>
              {:else}
                Never
              {/if}
              {#if sync.attempt}<span class="muted"> · {sync.attempt}</span>{/if}
            </dd>
          </div>
        </dl>
        {#if app.lastSyncError}<Alert tone="warn" title="The last sync failed">{app.lastSyncError}</Alert>{/if}
        {#if canRead && !cred.found && list !== null}<Alert tone="error">{cred.detail}</Alert>{/if}
        <div class="row wrap">
          {#if canTest && cred.found}
            <Button size="sm" loading={testing === app.id} disabled={testing !== ''} onclick={() => test(app)}>Test the {platformLabel(app.platform)} credential</Button>
          {/if}
          {#if canRead}<Button size="sm" variant="ghost" href={links.credentials}>Manage credentials</Button>{/if}
        </div>
        {#if results[app.id]}
          {@const r = results[app.id]}
          {#if r}<Alert tone={r.ok ? 'ok' : 'error'}>{r.message}</Alert>{/if}
        {/if}
        {#if !canRead}<p class="muted note">{cred.detail}</p>{/if}
      </div>
    {/each}
  </div>
  {#if offerMac && iosRecord}
    <div class="row wrap">
      <Button size="sm" icon="platform-macos" onclick={() => (adding = true)}>Add the macOS version</Button>
      <span class="muted note">The same app entry, with a Mac App Store record. The reviews stay under iOS.</span>
    </div>
  {/if}
</SettingsCard>

{#if offerMac && iosRecord}
  <AddAppModal
    {api}
    {workspaceId}
    bind:open={adding}
    prefill={{ platform: 'macos', identifier: iosRecord.identifier, name: iosRecord.name, credentialId: iosRecord.credentialId, repositoryId: iosRecord.repositoryId ?? '' }}
    onadded={(app) => {
      window.location.hash = appAddress(app.id, 'dashboard', 'macos');
    }}
  />
{/if}

<style>
  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: 0.9375rem;
  }

  .record + .record {
    padding-top: var(--space-5);
    border-top: 1px solid var(--line);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }

  .facts dt {
    margin-bottom: var(--space-1);
    font-size: var(--text-sm);
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
    font-size: 0.9375rem;
  }
</style>
