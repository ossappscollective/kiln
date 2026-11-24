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
  import { t } from '../../../lib/i18n/t.ts';
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { credentialFacts, effectiveAnalyticsValues, links, notAvailable, type EffectiveValue } from '../../../lib/app-settings.ts';
  import { appAddress } from '../../../lib/app-scope.ts';
  import { testErrorMessage } from '../../../lib/credentials.ts';
  import { fullTime, timeAgo } from '../../../lib/format.ts';
    import { identifierLabel, platformLabel, storeName, syncInfo } from '../../../lib/portfolio.ts';
  import type { AppSummary, CredentialSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import CopyValue from '../../ui/CopyValue.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import AddAppModal from '../../portfolio/AddAppModal.svelte';
  import CredentialIdentifiers from '../../credentials/CredentialIdentifiers.svelte';
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
  /** What each record really uses for analytics (vendor number, Play bucket) and where it comes from. */
  let effective = $state<Record<string, EffectiveValue[]>>({});
  const canSeeAnalytics = $derived(can(role, 'analytics.read'));

  $effect(() => {
    const id = workspaceId;
    const apps = members.map((m) => m.id);
    const allowed = canSeeAnalytics && canRead;
    untrack(() => (effective = {}));
    if (!allowed) return;
    let current = true;
    for (const appId of apps) {
      api
        .analyticsStatus(id, appId)
        .then((status) => {
          if (current) effective = { ...effective, [appId]: effectiveAnalyticsValues(status) };
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  });

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
        if (current) loadProblem = t('app:stores.loadFailed');
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
  title={t('app:settings.part.stores')}
  icon="key"
  description={t('app:stores.description')}
  unavailable={notAvailable.changeCredential}
>
  {#if loadProblem}<Alert tone="warn">{loadProblem}</Alert>{/if}
  <div class="stack">
  <div class="records">
    {#each members as app (app.id)}
      {@const cred = credentialFacts(app.credentialId, canRead ? list : null, now)}
      {@const sync = syncInfo(app, now)}
      <section class="record">
        <header class="head">
          <PlatformBadge platform={app.platform} tinted />
          <span class="muted store">{storeName(app.platform)}</span>
        </header>
        <div class="body">
          <div class="facts">
            <dl class="group">
              <div>
                <dt>{identifierLabel(app.platform)}</dt>
                <dd><CopyValue value={app.identifier} copyLabel={t('app:stores.copyIdentifier')} /></dd>
              </div>
              {#if app.storeAppId}
                <div>
                  <dt>{t('app:stores.storeId')}</dt>
                  <dd><CopyValue value={app.storeAppId} copyable={false} copyLabel={t('app:stores.copyIdentifier')} /></dd>
                </div>
              {/if}
              <div>
                <dt>{t('app:stores.lastSync')}</dt>
                <dd>
                  {#if app.lastSyncedAt !== null}
                    <time datetime={new Date(app.lastSyncedAt).toISOString()} title={fullTime(app.lastSyncedAt)}>{timeAgo(app.lastSyncedAt, now)}</time>
                  {:else}
                    {t('app:stores.never')}
                  {/if}
                  {#if sync.attempt}<span class="muted"> · {sync.attempt}</span>{/if}
                </dd>
              </div>
            </dl>
            <section class="group">
              <h4 class="group-title">{t('app:stores.credential')}</h4>
              <dl class="group">
                <div>
                  <dt>{t('credentials:table.name')}</dt>
                  <dd>{cred.label}</dd>
                </div>
                {#if cred.kind}
                  <div>
                    <dt>{t('credentials:table.type')}</dt>
                    <dd>{cred.kind}</dd>
                  </div>
                {/if}
                <div>
                  <dt>{t('credentials:table.status')}</dt>
                  <dd><Badge tone={cred.tone === 'none' ? 'neutral' : cred.tone}>{cred.status}</Badge></dd>
                </div>
                {#if (canTest && cred.found) || canRead}
                  <div>
                    <dt class="visually-hidden">{t('app:stores.credential')}</dt>
                    <dd class="actions">
                      {#if canTest && cred.found}
                        <Button size="sm" loading={testing === app.id} disabled={testing !== ''} onclick={() => test(app)}>{t('app:stores.test', { platform: platformLabel(app.platform) })}</Button>
                      {/if}
                      {#if canRead}<Button size="sm" variant="ghost" href={links.credentials}>{t('app:stores.manage')}</Button>{/if}
                    </dd>
                  </div>
                {/if}
              </dl>
            </section>
            {#if canRead && cred.found}
              <section class="group">
                <h4 class="group-title">{t('app:stores.identifiers')}</h4>
                <CredentialIdentifiers compact aligned identifiers={list?.find((c) => c.id === app.credentialId)?.identifiers ?? []} effective={effective[app.id] ?? []} />
              </section>
            {/if}
          </div>
          {#if app.lastSyncError}<Alert tone="warn" title={t('app:attention.syncFailed')}>{app.lastSyncError}</Alert>{/if}
          {#if canRead && !cred.found && list !== null}<Alert tone="error">{cred.detail}</Alert>{/if}
          {#if results[app.id]}
            {@const r = results[app.id]}
            {#if r}<Alert tone={r.ok ? 'ok' : 'error'}>{r.message}</Alert>{/if}
          {/if}
          {#if !canRead}<p class="muted note">{cred.detail}</p>{/if}
        </div>
      </section>
    {/each}
  </div>
  </div>
  {#if offerMac && iosRecord}
    <div class="row wrap">
      <Button size="sm" icon="platform-macos" onclick={() => (adding = true)}>{t('app:stores.addMac')}</Button>
      <span class="muted note">{t('app:stores.addMacHint')}</span>
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
  /* Two records side by side only when the card has 1100px or more; otherwise stacked. */
  .stack {
    container-type: inline-size;
  }

  .records {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
  }

  @container (min-width: 1100px) {
    .records {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .record {
    min-width: 0;
    overflow: hidden;
    font-size: 0.9375rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    container-type: inline-size;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--line);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  /* One label column for the whole card: the groups below are subgrids of it, so every label and value lines up. */
  .facts {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
    gap: var(--space-4) var(--space-4);
    align-items: start;
    min-width: 0;
  }

  .group {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    gap: var(--space-2) var(--space-4);
    min-width: 0;
    margin: 0;
  }

  dl.group > div {
    display: contents;
  }

  .group-title {
    grid-column: 1 / -1;
    margin: 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  section.group {
    row-gap: var(--space-2);
  }

  dt {
    font-size: var(--text-sm);
    color: var(--muted);
    align-self: center;
  }

  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    grid-column: 1 / -1;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }

  /* Under 520px of card width the labels sit above their values. */
  @container (max-width: 519px) {
    .facts,
    .group {
      grid-template-columns: minmax(0, 1fr);
    }

    .facts {
      gap: var(--space-3);
    }

    dl.group > div {
      display: block;
    }

    dl.group > div + div {
      margin-top: var(--space-2);
    }

    .head {
      padding-inline: var(--space-3);
    }
  }
</style>
