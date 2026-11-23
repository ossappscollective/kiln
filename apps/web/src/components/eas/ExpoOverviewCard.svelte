<!--
  ExpoOverviewCard: the Expo (EAS) card of the app Overview. Per iOS or Android record of the app: the latest EAS build and the latest EAS
  submission with their state, version and build number, and when. From the STORED snapshot only (`GET .../eas/status`, database only, docs/api/eas-builds.md):
  it never calls Expo. Every row links to the Builds page. A record that is not linked to Expo says so with a link to Builds, where the link is made
  ("Connect your apps"); a linked record without builds says that none is stored yet. macOS and other platforms have no row. Hidden for a role that may
  not read builds. (A current OTA update is not drawn: it is only read live from Expo, and the Overview makes no live call.)
  Props: api, workspaceId, role, members (the app records in scope), now, refreshKey (changes when a sync finished).
-->
<script lang="ts">
  import { can, platformLabel, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { expoCardVisible, expoRows, expoSupported } from '../../lib/eas/eas-overview.ts';
  import { easBuildDetail, easBuildState, easBuildTitle, type EasStatusView, easSubmissionBuild, easSubmissionState } from '../../lib/eas/eas-status.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Badge from '../ui/Badge.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined } = $props();

  let views = $state<Record<string, EasStatusView | null | undefined>>({});
  let generation = 0;

  const mine = $derived(members.filter((m) => expoSupported(m.platform)));
  const allowed = $derived(can(role, 'builds.read'));
  const rows = $derived(expoRows(mine, views));

  $effect(() => {
    void workspaceId;
    void refreshKey;
    const list = mine.map((m) => m.id);
    if (!allowed || list.length === 0) return;
    untrack(() => {
      const gen = ++generation;
      for (const id of list) {
        api
          .easStatus(workspaceId, id)
          .then((r) => {
            if (gen === generation) views[id] = r.status;
          })
          .catch(() => {
            if (gen === generation) views[id] = null;
          });
      }
    });
  });
</script>

{#if allowed && expoCardVisible(rows)}
  <section class="card expo" aria-label={t('eas:overview.aria')} data-testid="expo-overview">
    <h3 class="title">{t('eas:overview.title')}</h3>
    {#each rows as row (row.appId)}
      {@const builds = appAddress(row.appId, 'builds', row.platform)}
      <div class="row" data-testid="expo-overview-row-{row.platform}">
        <div class="plat"><PlatformBadge platform={row.platform} tinted /></div>
        {#if row.state === 'loading'}
          <p class="muted text-sm">{t('eas:overview.loading')}</p>
        {:else if row.state === 'unavailable'}
          <p class="muted text-sm">{t('eas:overview.unavailable', { platform: platformLabel(row.platform) })}</p>
        {:else if row.state === 'not_linked'}
          <p class="muted text-sm" data-testid="expo-overview-not-linked">
            {t('eas:overview.notLinked')} <a href={builds}>{t('eas:overview.link')}</a>
          </p>
        {:else if row.state === 'no_builds'}
          <p class="muted text-sm" data-testid="expo-overview-empty">
            {t('eas:overview.noBuilds')} <a href={builds}>{t('eas:overview.openBuilds')}</a>
          </p>
        {:else}
          <dl class="facts">
            <div>
              <dt>{t('eas:overview.latestBuild')}</dt>
              {#if row.build}
                {@const state = easBuildState(row.build)}
                <dd>
                  <a href={builds} class="strong">{easBuildTitle(row.build)}</a>
                  <Badge tone={state.tone} dot>{state.label}</Badge>
                  {#if row.build.createdAt !== null}
                    <time class="muted text-sm" datetime={new Date(row.build.createdAt).toISOString()} title={formatDateTime(row.build.createdAt)}>{formatRelativeTime(row.build.createdAt, { now })}</time>
                  {/if}
                  {#if easBuildDetail(row.build) !== ''}<span class="muted text-sm block">{easBuildDetail(row.build)}</span>{/if}
                </dd>
              {:else}
                <dd class="muted">{t('eas:overview.noBuild')}</dd>
              {/if}
            </div>
            <div>
              <dt>{t('eas:overview.latestSubmission')}</dt>
              {#if row.submission}
                {@const state = easSubmissionState(row.submission)}
                <dd>
                  <a href={builds} class="strong">{easSubmissionBuild(row.submission)}</a>
                  <Badge tone={state.tone} dot>{state.label}</Badge>
                  {#if row.submission.createdAt !== null}
                    <time class="muted text-sm" datetime={new Date(row.submission.createdAt).toISOString()} title={formatDateTime(row.submission.createdAt)}>{formatRelativeTime(row.submission.createdAt, { now })}</time>
                  {/if}
                  <span class="muted text-sm block">{row.submission.store.name}</span>
                </dd>
              {:else}
                <dd class="muted">{t('eas:overview.noSubmission')}</dd>
              {/if}
            </div>
          </dl>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .expo {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  .title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    align-items: flex-start;
  }

  .plat {
    min-width: 6rem;
  }

  .facts {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
    margin: 0;
  }

  dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  .strong {
    font-weight: var(--weight-semibold);
  }

  .block {
    display: block;
  }

  p {
    margin: 0;
  }
</style>
