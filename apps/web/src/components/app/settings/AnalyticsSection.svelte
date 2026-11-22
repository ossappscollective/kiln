<!--
  AnalyticsSection: the analytics setting of an Android app: the Google Play reports bucket (PlayBucketField). One card for the
  records in scope; nothing is drawn when none of them is an Android app. The bucket belongs to the Play account that owns the
  app, so it is set per app and inherits the workspace default (Settings, Analytics).
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import type { Role } from '@kiln/core';
  import type { Api } from '../../../lib/api.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import PlayBucketField from '../../analytics/PlayBucketField.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';
import { supports } from '@kiln/core';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const android = $derived(members.filter((m) => supports(m.platform, 'playReportsBucket')));
</script>

{#if android.length > 0}
  <SettingsCard
    title={t('app:analytics.title')}
    key="Play reports bucket"
    icon="trending-up"
    description={t('app:analytics.description')}
  >
    {#each android as app (app.id)}
      <section class="stack tight" aria-label={t('app:analytics.bucketLabel', { platform: platformLabel(app.platform) })}>
        {#if members.length > 1}<PlatformBadge platform={app.platform} />{/if}
        <PlayBucketField {api} {workspaceId} {role} {app} heading={false} />
      </section>
    {/each}
  </SettingsCard>
{/if}
