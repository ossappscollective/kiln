<!--
  ViewSwitch: the small segmented control of a page that holds several views (Store listing: Text and Graphics; Insights: Analytics and
  ASO; Builds: Builds, Workflows and Test builds). Each view is a link to the same page with `?view=` in the address, so a view can be
  linked, bookmarked and survives a reload; the platform, version and locale of the address stay (lib/app-nav.ts `withView`).
  Props: views ({ id, label }[]; nothing is drawn for fewer than two), value (the open view), hrefFor (the address of a view), label
  (the accessible name of the group).
-->
<script lang="ts">
  import type { SectionView } from '../../lib/app-nav.ts';

  let { views, value, hrefFor, label }: { views: readonly SectionView[]; value: string; hrefFor: (id: string) => string; label: string } = $props();
</script>

{#if views.length > 1}
  <nav class="view-switch" aria-label={label}>
    {#each views as v (v.id)}
      <a href={hrefFor(v.id)} aria-current={value === v.id ? 'page' : undefined}>{v.label}</a>
    {/each}
  </nav>
{/if}

<style>
  .view-switch {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  a {
    display: inline-flex;
    align-items: center;
    min-height: calc(var(--control-md) - 8px);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }

  a:hover {
    color: var(--ink);
  }

  a[aria-current='page'] {
    color: var(--ink);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
</style>
