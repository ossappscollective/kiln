<!--
  ConnectBanner: the nudge to "Connect your apps" (docs/ux-ia.md). Shown to people who may change links (`apps.write`) while a credential
  of kind RevenueCat or Expo exists and at least one app record of a store it serves is not linked; gone as soon as every record is linked.
  One quiet line per integration with one button that opens the review. Reads only the list of credentials, the links of the workspace
  (database only) and the app records (unless the page passes them); it writes nothing.
  Props: api, workspaceId, role, apps (the records when the page has them, else null: they are read here), context ('credentials' says it
  is the next step after saving a key), refreshKey (anything that changes when the credentials changed).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { bannerKinds, type ConnectKind, type IntegrationLinks } from '../../lib/connect/connect.ts';
  import { connectStore } from '../../lib/app-state/connect-facade.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import ConnectAppsDialog from './ConnectAppsDialog.svelte';
  import { readApps } from '../../lib/app-state/workspace-reads.ts';

  let {
    api,
    workspaceId,
    role,
    apps = null,
    context,
    refreshKey = 0,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    apps?: AppSummary[] | null;
    context: 'credentials' | 'portfolio';
    refreshKey?: unknown;
  } = $props();

  const mayWrite = $derived(can(role, 'apps.write') && can(role, 'credentials.read'));

  let credentials = $state<CredentialSummary[] | null>(null);
  let links = $state<IntegrationLinks | null>(null);
  let own = $state<AppSummary[] | null>(null);
  let opened = $state<ConnectKind | null>(null);
  let dialogOpen = $state(false);

  $effect(() => {
    void workspaceId;
    void refreshKey;
    void connectStore.version;
    if (!mayWrite) return;
    let current = true;
    untrack(() => {
      void api
        .credentials(workspaceId)
        .then((r) => {
          if (current) credentials = r.credentials;
        })
        .catch(() => {});
      void api
        .integrationLinks(workspaceId)
        .then((r) => {
          if (current) links = r;
        })
        .catch(() => {});
      if (apps === null) {
        void readApps(api, workspaceId)
          .then((r) => {
            if (current) own = r.apps;
          })
          .catch(() => {});
      }
    });
    return () => {
      current = false;
    };
  });

  const records = $derived(apps ?? own);
  const shown = $derived(bannerKinds({ mayWrite, credentials, apps: records, links }));

  function open(kind: ConnectKind) {
    opened = kind;
    dialogOpen = true;
  }
</script>

{#each shown as b (b.kind)}
  <Alert tone="info" title={b.kind === 'revenuecat' ? t('connect:banner.rc.title') : t('connect:banner.expo.title')}>
    <p data-testid="connect-banner-{b.kind}">
      {#if b.kind === 'revenuecat'}
        {context === 'credentials'
          ? t('connect:banner.rc.next', { label: b.credentialLabel, count: b.pending })
          : t('connect:banner.rc.text', { label: b.credentialLabel, count: b.pending })}
      {:else}
        {context === 'credentials'
          ? t('connect:banner.expo.next', { label: b.credentialLabel, count: b.pending })
          : t('connect:banner.expo.text', { label: b.credentialLabel, count: b.pending })}
      {/if}
    </p>
    <div class="actions"><Button variant="primary" size="sm" icon="link" onclick={() => open(b.kind)}>{t('connect:banner.button')}</Button></div>
  </Alert>
{/each}

{#if opened !== null && records !== null}
  <ConnectAppsDialog {api} {workspaceId} {role} apps={records} kind={opened} bind:open={dialogOpen} />
{/if}

<style>
  .actions {
    margin-top: var(--space-2);
  }
</style>
