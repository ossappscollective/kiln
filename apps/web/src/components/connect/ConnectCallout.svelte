<!--
  ConnectCallout: what the Products page (RevenueCat) and the Builds page (Expo) say while the app is not linked: which key was found in
  Credentials, what is missing (the link of this app) and why that leaves the page empty, with one button that opens "Connect your apps"
  for this app. Without a key it points to Credentials; for a person who may not change links it says whom to ask. Hidden once linked, and (Expo) while the repository does not look like an Expo project.
  Props: api, workspaceId, role, app, kind, linked (the page knows: true hides it), compact (one line for a page that has data).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type ConnectKind, credentialsFor, eligible, looksLikeExpo, missingLinkText } from '../../lib/connect/connect.ts';
  import { connectStore } from '../../lib/app-state/connect-facade.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import ConnectAppsDialog from './ConnectAppsDialog.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    kind,
    linked = false,
  }: { api: Api; workspaceId: string; role: Role; app: AppSummary; kind: ConnectKind; linked?: boolean } = $props();

  const mayWrite = $derived(can(role, 'apps.write'));
  let credentials = $state<CredentialSummary[] | null>(null);
  let isLinked = $state<boolean | null>(null);
  // Expo only: does the repository look like an Expo project? Unknown (null) hides the notice.
  let expoProject = $state<boolean | null>(null);
  let dialogOpen = $state(false);

  $effect(() => {
    void workspaceId;
    void app.id;
    void connectStore.version;
    let current = true;
    untrack(() => {
      if (can(role, 'credentials.read')) {
        void api
          .credentials(workspaceId)
          .then((r) => {
            if (current) credentials = r.credentials;
          })
          .catch(() => {});
      }
      void api
        .integrationLinks(workspaceId)
        .then((r) => {
          if (current) isLinked = (kind === 'revenuecat' ? r.revenuecat : r.expo).indexOf(app.id) >= 0;
        })
        .catch(() => {});
      if (kind === 'expo' && !linked) {
        expoProject = null;
        void api
          .detectExpoProject(workspaceId, app.id)
          .then((r) => {
            if (current) expoProject = looksLikeExpo(r.detection);
          })
          .catch(() => {});
      }
    });
    return () => {
      current = false;
    };
  });

  const keys = $derived(credentials === null ? null : credentialsFor(kind, credentials));
  const show = $derived(
    !linked && isLinked === false && eligible(kind, app) && (kind !== 'expo' || expoProject === true),
  );
  const hasKey = $derived(keys !== null && keys.length > 0);
</script>

{#if show}
  <Alert tone="info" title={kind === 'revenuecat' ? t('connect:callout.rc.title') : t('connect:callout.expo.title')}>
    <p data-testid="connect-callout-{kind}">{missingLinkText(kind, keys, mayWrite)}</p>
    <div class="actions">
      {#if mayWrite && hasKey}
        <Button variant="primary" size="sm" icon="link" onclick={() => (dialogOpen = true)}>{kind === 'revenuecat' ? t('connect:callout.rc.button') : t('connect:callout.expo.button')}</Button>
      {:else if mayWrite && keys !== null}
        <Button variant="primary" size="sm" icon="key" href="#/credentials">{t('connect:callout.addKey')}</Button>
      {/if}
    </div>
  </Alert>
  {#if mayWrite && hasKey}
    <ConnectAppsDialog {api} {workspaceId} {role} apps={[app]} {kind} only={[app.id]} bind:open={dialogOpen} />
  {/if}
{/if}

<style>
  .actions {
    margin-top: var(--space-2);
  }
</style>
