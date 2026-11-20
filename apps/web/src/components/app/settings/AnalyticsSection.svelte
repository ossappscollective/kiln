<!--
  AnalyticsSection: the analytics setting of an Android app: the Google Play reports bucket (PlayBucketField). One card for the
  records in scope; nothing is drawn when none of them is an Android app. The bucket belongs to the Play account that owns the
  app, so it is set per app and inherits the workspace default (Settings, Analytics).
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import PlayBucketField from '../../analytics/PlayBucketField.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const android = $derived(members.filter((m) => m.platform === 'android'));
</script>

{#if android.length > 0}
  <SettingsCard
    title="Play reports bucket"
    icon="trending-up"
    description="Where installs and ratings are read from on Google Play; this app uses the workspace default until you set its own."
  >
    {#each android as app (app.id)}
      <section class="stack tight" aria-label="{platformLabel(app.platform)} reports bucket">
        {#if members.length > 1}<PlatformBadge platform={app.platform} />{/if}
        <PlayBucketField {api} {workspaceId} {role} {app} heading={false} />
      </section>
    {/each}
  </SettingsCard>
{/if}
