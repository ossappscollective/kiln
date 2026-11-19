<!--
  AppNav: the left panel while an app is open. It replaces the workspace navigation, so the whole
  UI is scoped to the app. Each link keeps the platform scope of the address, and the version and locale
  of the page header (?version=&locale=), so the tabs share them. Each entry shows its `g` shortcut as a quiet
  hint (on hover, on focus, and while the first key is waiting). The "All apps" link carries the number of
  apps that need attention, when the overview has loaded it.
  Props: address (the open app: id, section, platform), allowed (does the role have this action), attention?
  (the number of apps that need attention, or null), counts? (the badges of this app: `reviews` the unanswered reviews, `releases`
  the releases left unfinished, `pending` the changes that wait to be published and `pendingBlocking` whether an error blocks one of
  them (warning tone); null draws nothing).
-->
<script lang="ts">
  import type { Action } from '@mrm/core';
  import { address as pageAddress, appContext } from '../../lib/address.svelte.ts';
  import { carryHeaderParams } from '../../lib/app-header.ts';
  import { type AppAddress, appAddress, visibleSections } from '../../lib/app-scope.ts';
  import { badgeLabel, badgeText } from '../../lib/nav-badges.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { portfolioHref } from '../../lib/portfolio.ts';
  import { chordHint } from '../../lib/shortcuts.ts';
  import Icon from '../ui/Icon.svelte';

  let {
    address,
    allowed,
    attention = null,
    counts = { reviews: null, releases: null, pending: null, pendingBlocking: false },
  }: {
    address: AppAddress;
    allowed: (action: Action) => boolean;
    attention?: number | null;
    counts?: { reviews: number | null; releases: number | null; pending?: number | null; pendingBlocking?: boolean };
  } = $props();

  const badgeFor = (id: string): { count: number | null; one: string; many: string; tone: 'warn' | 'accent' } | null =>
    id === 'reviews'
      ? { count: counts.reviews, one: 'unanswered review', many: 'unanswered reviews', tone: 'warn' }
      : id === 'releases'
        ? { count: counts.releases, one: 'release left unfinished', many: 'releases left unfinished', tone: 'warn' }
        : id === 'pending'
          ? { count: counts.pending ?? null, one: 'pending change', many: 'pending changes', tone: counts.pendingBlocking === true ? 'warn' : 'accent' }
          : null;

  const sections = $derived(visibleSections(allowed));
</script>

<div class="app-nav" class:chord={navSignals.chordPending}>
  <a class="back" href={portfolioHref}>
    <Icon name="chevron-left" size={16} /> All apps
    {#if badgeText(attention)}
      <span class="badge warn nav-count">{badgeText(attention)}<span class="visually-hidden"> {badgeLabel(attention, 'app needs attention', 'apps need attention')}</span></span>
    {/if}
  </a>
  {#if appContext.name}<p class="name" title={appContext.name}>{appContext.name}</p>{/if}
  <nav aria-label="This app">
    <ul>
      {#each sections as s (s.id)}
        {@const hint = chordHint('app', s.id)}
        {@const badge = badgeFor(s.id)}
        <li>
          <a href={carryHeaderParams(appAddress(address.id, s.id, address.platform), pageAddress.hash)} aria-current={address.section === s.id ? 'page' : undefined}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
            {#if hint}<kbd class="nav-hint" aria-hidden="true">{hint}</kbd>{/if}
            {#if badge && badgeText(badge.count)}
              <span class="badge {badge.tone} nav-count">{badgeText(badge.count)}<span class="visually-hidden"> {badgeLabel(badge.count, badge.one, badge.many)}</span></span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
</div>

<style>
  .app-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .back {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-2);
    font-weight: var(--weight-medium);
  }

  .name {
    margin: 0;
    padding: 0 var(--space-3);
    overflow: hidden;
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  nav a {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
    /* No background fade: switching section must show one current item, not two for a moment. */
    transition: color var(--duration-fast) var(--ease);
  }

  nav a:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  nav a[aria-current='page'] {
    color: var(--ink);
    background: var(--accent-bg);
  }

  nav a[aria-current='page'] :global(.icon) {
    color: var(--accent);
  }
</style>
