<!--
  AsoCompetitors: the apps you follow, per store in scope: a card each (version, rating and how many ratings,
  price, the last change), a collapsed change history, a side by side with your app and suggestions from the
  discovery that you confirm. Following reads the public store once; viewers only read.
  Props: api, workspaceId, role, members, config, canWrite, releases (by app id), version, now, onchanged.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import type { AsoCompetitor, AsoConfig } from '../../lib/aso/aso.ts';
  import { competitorCounts, competitorsLead } from '../../lib/aso/lead.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import AddCompetitor from './AddCompetitor.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import CompetitorGroup from './CompetitorGroup.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    config,
    canWrite,
    releases,
    version,
    now,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    config: AsoConfig | null;
    canWrite: boolean;
    releases: Record<string, ReleaseSummary[]>;
    version: number;
    now: number;
    onchanged: () => Promise<void>;
  } = $props();

  let adding = $state(false);
  /** Bumped by this view when a competitor was added or removed, so only the cards read again. */
  let local = $state(0);
  const canReviews = $derived(can(role, 'reviews.read'));

  function changed() {
    local += 1;
  }

  /** What each group holds, for the one lead above them. */
  let summaries = $state<Record<string, { competitors: AsoCompetitor[]; suggestions: number } | undefined>>({});
  const lead = $derived.by(() => {
    const groups = members.map((m) => summaries[m.id]).filter((g): g is { competitors: AsoCompetitor[]; suggestions: number } => g !== undefined);
    const counts = competitorCounts(groups.flatMap((g) => g.competitors), now);
    return competitorsLead({ ...counts, suggestions: groups.reduce((n, g) => n + g.suggestions, 0) });
  });
  const summarised = $derived(members.every((m) => summaries[m.id] !== undefined));

  function added() {
    adding = false;
    changed();
  }
</script>

<div class="competitors stack">
  {#if summarised}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="competitors-lead">
      {#snippet actions()}
        {#if canWrite}
          <div class="acts" role="toolbar" aria-label="Competitor actions">
            <Button variant="primary" icon="plus" onclick={() => (adding = !adding)} aria-expanded={adding}>Add competitor</Button>
          </div>
        {/if}
      {/snippet}
    </PageLead>
  {:else if canWrite}
    <div class="acts" role="toolbar" aria-label="Competitor actions">
      <Button variant="primary" icon="plus" onclick={() => (adding = !adding)} aria-expanded={adding}>Add competitor</Button>
    </div>
  {/if}
  {#if adding && canWrite}
    <AddCompetitor {api} {workspaceId} {members} {config} ondone={added} oncancel={() => (adding = false)} />
  {/if}
  {#each members as app (app.id)}
    <CompetitorGroup
      {api}
      {workspaceId}
      {app}
      multi={members.length > 1}
      {canWrite}
      {canReviews}
      {now}
      releases={releases[app.id] ?? []}
      version={version + local}
      onchanged={changed}
      onsummary={(id, facts) => (summaries[id] = facts)}
    />
  {/each}
</div>

<style>
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
</style>
