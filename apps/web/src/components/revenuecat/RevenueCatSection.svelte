<!--
  RevenueCatSection: the "RevenueCat project" card of the app Settings (docs/adr/0039-revenuecat.md): which RevenueCat project and app each
  record of the app belongs to, and which RevenueCat credential reads it. Only records of a store RevenueCat serves (App Store, Mac App
  Store, Google Play: the `revenueCat` capability of the platform) get a form; an app with none carries no card. Linking changes nothing in
  RevenueCat, and the read of it happens with "Sync products" on the Products page.
  Props: api, workspaceId, role, members (the records in scope), now.
-->
<script lang="ts">
  import { type Role, can, platformSupports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type RevenueCatLinkView, revenueCatSummary } from '../../lib/revenuecat/revenuecat.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import SettingsCard from '../app/settings/SettingsCard.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import RevenueCatLinkField from './RevenueCatLinkField.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  const served = $derived(members.filter((m) => platformSupports(m.platform, 'revenueCat')));

  let links = $state<Record<string, RevenueCatLinkView | null | undefined>>({});
  let credentials = $state<CredentialSummary[] | null>(null);
  let loaded = $state(false);

  const key = $derived(`${workspaceId}/${served.map((m) => m.id).join(',')}`);

  $effect(() => {
    const space = workspaceId;
    const apps = served.map((m) => m.id);
    void key;
    untrack(() => {
      links = {};
      credentials = null;
      loaded = false;
    });
    let current = true;
    const reads: Promise<unknown>[] = apps.map((id) =>
      api
        .revenueCatLink(space, id)
        .then((r) => {
          if (current) links = { ...links, [id]: r.link };
        })
        .catch(() => {}),
    );
    if (can(role, 'credentials.read')) {
      reads.push(
        api
          .credentials(space)
          .then((r) => {
            if (current) credentials = r.credentials;
          })
          .catch(() => {}),
      );
    }
    void Promise.all(reads).then(() => {
      if (current) loaded = true;
    });
    return () => {
      current = false;
    };
  });

  const allLinks = $derived(served.map((m) => links[m.id] ?? null));
</script>

{#if served.length > 0 && loaded}
  <SettingsCard
    title={t('products:rc.section.title')}
    icon="tag"
    description={t('products:rc.section.description')}
    summary={revenueCatSummary(allLinks)}
  >
    {#each served as app (app.id)}
      <section class="stack tight" aria-label={t('products:rc.section.aria', { platform: app.platform })}>
        {#if served.length > 1}<PlatformBadge platform={app.platform} />{/if}
        <RevenueCatLinkField
          {api}
          {workspaceId}
          {role}
          {app}
          link={links[app.id] ?? null}
          {credentials}
          {now}
          onchanged={(next) => (links = { ...links, [app.id]: next })}
        />
      </section>
    {/each}
  </SettingsCard>
{/if}
