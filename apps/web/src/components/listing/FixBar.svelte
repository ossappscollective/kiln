<!--
  FixBar: the fixable findings of ONE locale of one app, in the locale panel of Store listing: the findings of the listing checks that have a fix (or a
  hand-off to the editor or AI), each with its button, and "Fix all that can be fixed (N)". It reads `GET .../listing/fixes` (the server computes them
  from the staged text where there is one, else the store's) and says nothing when the locale has nothing to fix. A fix is only staged (pending
  changes); nothing reaches a store. Props: api, workspaceId, role, app, locale (a store locale code), locked, refreshKey? (changes after a sync or a staging elsewhere).
-->
<script lang="ts">
  import { can, type CheckIssue, type Role } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { fixAllOf, type ListingFixesView } from '../../lib/listing/fixes.ts';
  import { placementLabel } from '../../lib/ai/placement.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import FixAll from './FixAll.svelte';
  import FixButtons from './FixButtons.svelte';

  let { api, workspaceId, role, app, locale, locked = false, refreshKey = 0 }: { api: Api; workspaceId: string; role: Role; app: AppSummary; locale: string; locked?: boolean | undefined; refreshKey?: number | string | undefined } = $props();

  let view = $state<ListingFixesView | null>(null);
  let checks = $state<CheckIssue[]>([]);
  let problem = $state('');
  let generation = 0;

  async function load() {
    const mine = ++generation;
    try {
      const [fixes, listing] = await Promise.all([api.listingFixes(workspaceId, app.id), api.appListingChecks(workspaceId, app.id)]);
      if (mine !== generation) return;
      view = fixes;
      checks = (listing.locales.find((l) => l.locale === locale)?.issues ?? []) as CheckIssue[];
      problem = '';
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : '';
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void locale;
    void refreshKey;
    if (can(role, 'listing.read')) untrack(() => void load());
  });

  const mine = $derived(view?.locales.find((l) => l.locale === locale));
  const resolved = $derived(new Set(view?.afterPending?.resolved ?? []));
  const rows = $derived(
    checks.filter((i) => i.field !== null && (resolved.has(i.id) || (mine?.fixes ?? []).some((f) => f.field === i.field && f.resolves.indexOf(i.code) >= 0) || (mine?.cannot ?? []).some((c) => c.field === i.field && c.code === i.code))),
  );
</script>

{#if rows.length > 0 || fixAllOf(mine).length > 0}
  <section class="fixbar" aria-label={t('listing:fix.barTitle')} data-testid="fix-bar">
    <div class="head">
      <strong>{t('listing:fix.barTitle')}</strong>
      <FixAll {api} {workspaceId} {role} appId={app.id} fixes={fixAllOf(mine)} {locked} onchanged={load} />
    </div>
    <ul>
      {#each rows as issue (issue.id)}
        <li>
          <span>{placementLabel(issue.field ?? '')}</span>
          <FixButtons {api} {workspaceId} {role} {app} locale={mine} {issue} resolved={resolved.has(issue.id)} {locked} onchanged={load} />
        </li>
      {/each}
    </ul>
    {#if problem}<p class="muted">{problem}</p>{/if}
  </section>
{/if}

<style>
  .fixbar {
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  ul {
    padding: 0;
    margin: var(--space-2) 0 0;
    list-style: none;
  }

  li {
    margin-top: var(--space-2);
  }
</style>
