<!--
  AppNav: the left panel while an app is open. It replaces the workspace navigation, so the whole UI is scoped to the app.
  Top: the app switcher (icon and name; click, focus or Cmd or Ctrl + K opens the searchable list). Then exactly six entries:
  Overview, Releases, Store listing, Reviews, Insights, Builds (lib/app-nav.ts; the old pages are views inside them and their old
  addresses redirect). Pending changes is not an entry: it is the pending bar under the page header. At the bottom the workspace:
  All apps, Inbox and Settings, and a collapsed "More" group with the other workspace pages the role may open (Repositories,
  Credentials, Members, API tokens, Webhooks, Audit log, ...). Each app link keeps the platform scope of the address, and the version and
  locale of the page header (?version=&locale=). Each entry shows its `g` shortcut as a quiet hint (on hover, on focus, and while the
  first key is waiting).
  Props: address (the open app: id, section, platform), allowed (does the role have this action), attention? (the number of apps that
  need attention, on All apps), unanswered? (the unanswered reviews of the workspace, on Inbox), workspaceItems (the workspace views
  the role may open: id, label, icon), counts? (the badges of this app: `reviews` the unanswered reviews, `releases` the releases left
  unfinished; null draws nothing), switcher?, mod, onopenswitcher, onpickapp.
-->
<script lang="ts">
  import type { Action } from '@mrm/core';
  import { address as pageAddress, appContext } from '../../lib/address.svelte.ts';
  import { carryHeaderParams } from '../../lib/app-header.ts';
  import { type RailItem, navEntryOf, visibleNav, workspaceRail } from '../../lib/app-nav.ts';
  import { type AppAddress, appAddress } from '../../lib/app-scope.ts';
  import { badgeLabel, badgeText } from '../../lib/nav-badges.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { chordHint } from '../../lib/shortcuts.ts';
  import type { SwitcherItem } from '../../lib/app-switcher.ts';
  import Icon from '../ui/Icon.svelte';
  import { isIconName } from '../ui/icons.ts';
  import AppSwitcherField from './AppSwitcherField.svelte';

  let {
    address,
    allowed,
    attention = null,
    unanswered = null,
    workspaceItems = [],
    counts = { reviews: null, releases: null },
    switcher = null,
    mod = 'Ctrl',
    onopenswitcher,
    onpickapp,
  }: {
    address: AppAddress;
    allowed: (action: Action) => boolean;
    attention?: number | null;
    unanswered?: number | null;
    workspaceItems?: RailItem[];
    /** The apps for the switcher field (null while being read); with `onpickapp` the app name is a switcher. */
    switcher?: SwitcherItem[] | null;
    mod?: string;
    onopenswitcher?: () => void;
    onpickapp?: (item: SwitcherItem) => void;
    counts?: { reviews: number | null; releases: number | null };
  } = $props();

  const badgeFor = (id: string): { count: number | null; one: string; many: string; tone: 'warn' | 'accent' } | null =>
    id === 'reviews'
      ? { count: counts.reviews, one: 'unanswered review', many: 'unanswered reviews', tone: 'warn' }
      : id === 'releases'
        ? { count: counts.releases, one: 'release left unfinished', many: 'releases left unfinished', tone: 'warn' }
        : null;

  const entries = $derived(visibleNav(allowed));
  const here = $derived(navEntryOf(address.section));
  const rail = $derived(workspaceRail(workspaceItems));
  const iconOf = (v: RailItem) => (isIconName(v.icon) ? v.icon : 'box');
</script>

<div class="app-nav" class:chord={navSignals.chordPending}>
  {#if onpickapp}
    <AppSwitcherField items={switcher} appId={address.id} fallbackName={appContext.name} {mod} onopen={onopenswitcher} onpick={onpickapp} />
  {:else if appContext.name}<p class="name" title={appContext.name}>{appContext.name}</p>{/if}
  <nav aria-label="This app">
    <ul>
      {#each entries as s (s.id)}
        {@const hint = chordHint('app', s.id)}
        {@const badge = badgeFor(s.id)}
        <li>
          <a href={carryHeaderParams(appAddress(address.id, s.id, address.platform), pageAddress.hash)} aria-current={here === s.id ? 'page' : undefined}>
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

  {#if rail.main.length > 0 || rail.more.length > 0}
    <nav class="workspace" aria-label="Workspace">
      {#if rail.main.length > 0}
        <ul>
          {#each rail.main as v (v.id)}
            {@const count = v.id === 'portfolio' ? attention : v.id === 'reviews' ? unanswered : null}
            {@const hint = chordHint('workspace', v.id)}
            <li>
              <a href="#/{v.id}">
                <Icon name={iconOf(v)} size={18} />
                <span>{v.label}</span>
                {#if hint}<kbd class="nav-hint" aria-hidden="true">{hint}</kbd>{/if}
                {#if badgeText(count)}
                  <span class="badge nav-count {v.id === 'portfolio' ? 'warn' : 'accent'}">{badgeText(count)}<span class="visually-hidden"> {v.id === 'portfolio' ? badgeLabel(count, 'app needs attention', 'apps need attention') : badgeLabel(count, 'unanswered review', 'unanswered reviews')}</span></span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if rail.more.length > 0}
        <details class="more">
          <summary>More</summary>
          <ul>
            {#each rail.more as v (v.id)}
              <li>
                <a href="#/{v.id}">
                  <Icon name={iconOf(v)} size={18} />
                  <span>{v.label}</span>
                </a>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </nav>
  {/if}
</div>

<style>
  .app-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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

  .workspace {
    padding-top: var(--space-3);
    margin-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .more summary {
    display: flex;
    align-items: center;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--muted);
    cursor: pointer;
  }

  .more summary:hover {
    color: var(--ink);
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
