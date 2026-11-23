<!--
  AdsSettingsSection: the "Apple Ads" card of the app Settings (docs/adr/0058-apple-ads.md): which Apple Ads ad account each App Store record is
  linked to and which Apple Ads API user key reads it. READ ONLY: Kiln reads campaign reports, nothing is changed in Apple Ads. Drawn only for an
  app with an App Store record, and only when it can matter (a record is linked or the workspace has an Apple Ads credential or the person may add one).
  Props: api, workspaceId, role, members (the records in scope), now.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AdsLinkView, adsApps, adsCredentials } from '../../lib/ads/ads.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import SettingsCard from '../app/settings/SettingsCard.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import AdsLinkForm from './AdsLinkForm.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  const apps = $derived(adsApps(members));
  let links = $state<Record<string, AdsLinkView | null | undefined>>({});
  let credentials = $state<CredentialSummary[] | null>(null);
  let loaded = $state(false);

  $effect(() => {
    const space = workspaceId;
    const ids = apps.map((a) => a.id);
    untrack(() => {
      links = {};
      credentials = null;
      loaded = false;
    });
    let current = true;
    const reads: Promise<unknown>[] = ids.map((id) =>
      api
        .adsState(space, id)
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

  const anyLinked = $derived(apps.some((a) => links[a.id]));
  const show = $derived(loaded && apps.length > 0 && (anyLinked || adsCredentials(credentials).length > 0 || can(role, 'apps.write')));
</script>

{#if show}
  <SettingsCard title={t('ads:settings.title')} icon="trending-up" description={t('ads:settings.description')}>
    {#each apps as app (app.id)}
      <section class="stack tight" aria-label={t('ads:settings.platformLabel', { platform: app.platform })}>
        {#if apps.length > 1}<PlatformBadge platform={app.platform} />{/if}
        <AdsLinkForm {api} {workspaceId} {role} {app} link={links[app.id] ?? null} {credentials} {now} onchanged={(next) => (links = { ...links, [app.id]: next })} />
      </section>
    {/each}
  </SettingsCard>
{/if}
