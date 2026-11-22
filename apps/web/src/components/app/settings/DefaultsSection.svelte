<!--
  DefaultsSection: what shapes a new release of this app, from what exists: how builds are matched to tags and
  CI (the app's, else the repository's, else the defaults) and the checklist templates a plan can start from.
  Reads only; editing the build matching is on the Builds tab.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { conventionLines, links, notAvailable, templatesSummary } from '../../../lib/app-settings.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import type { AppSummary, BuildConventionsView, ChecklistTemplate } from '../../../lib/types.ts';
  import Button from '../../ui/Button.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const canRepos = $derived(can(role, 'repositories.read'));
  const canPlans = $derived(can(role, 'plans.read'));

  let templates = $state<ChecklistTemplate[] | null>(null);
  let conventions = $state<Record<string, BuildConventionsView | undefined>>({});

  const key = $derived(`${workspaceId}/${members.map((m) => `${m.id}:${m.repositoryId ?? '-'}`).join(',')}`);

  $effect(() => {
    const id = workspaceId;
    void key;
    untrack(() => {
      templates = null;
      conventions = {};
    });
    let current = true;
    if (canPlans) {
      api
        .checklistTemplates(id)
        .then((r) => {
          if (current) templates = r.templates;
        })
        .catch(() => {});
    }
    if (canRepos) {
      for (const app of members) {
        if (app.repositoryId === null) continue;
        api
          .buildConventions(id, app.repositoryId, app.id)
          .then((v) => {
            if (current) conventions = { ...conventions, [app.id]: v };
          })
          .catch(() => {});
      }
    }
    return () => {
      current = false;
    };
  });
</script>

<SettingsCard
  title={t('app:settings.part.defaults')}
  key="Release defaults"
  icon="rocket"
  description={t('app:defaults.description')}
  unavailable={notAvailable.releaseDefaults}
>
  <div class="stack">
    {#each members as app (app.id)}
      <div class="record">
        <PlatformBadge platform={app.platform} tinted />
        {#if app.repositoryId === null}
          <p class="muted note">{t('app:defaults.noRepository', { platform: platformLabel(app.platform) })}</p>
        {:else if !canRepos}
          <p class="muted note">{t('app:defaults.needRepos')}</p>
        {:else if conventions[app.id]}
          <ul class="plain">
            {#each conventionLines(conventions[app.id] as BuildConventionsView) as line (line)}<li>{line}</li>{/each}
          </ul>
        {:else}
          <p class="muted note">{t('app:defaults.reading')}</p>
        {/if}
      </div>
    {/each}
  </div>
  <div class="stack tight">
    <p class="label">{t('app:defaults.templates')}</p>
    {#if !canPlans}
      <p class="muted note">{t('app:defaults.needPlans')}</p>
    {:else if templates === null}
      <p class="muted note">{t('app:defaults.reading')}</p>
    {:else}
      <p class="note">{t('app:defaults.templatesPick', { summary: templatesSummary(templates) })}</p>
    {/if}
  </div>
  <div class="row wrap">
    {#if members.length > 0}<Button size="sm" variant="ghost" href={links.builds(members[0]?.id ?? '')}>{t('app:defaults.editMatching')}</Button>{/if}
  </div>
</SettingsCard>

<style>
  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: 0.9375rem;
  }

  .label {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
