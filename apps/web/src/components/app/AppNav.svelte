<!--
  AppNav: the left panel while an app is open. It replaces the workspace navigation, so the whole UI is scoped to the app.
  Top: the app switcher (icon and name; click, focus or Cmd or Ctrl + K opens the searchable list) with the status of the app under
  it: one line per platform with its tint and name and its state ("iOS In review 2.9.0", "Android Live 2.8.1"; lib/app-status.ts).
  Then the group "This app" with exactly six entries:
  Overview, Releases, Store listing, Reviews, Insights, Builds (lib/app-nav.ts; the old pages are views inside them and their old
  addresses redirect). Pending changes is not an entry: it is the pending bar under the page header. At the bottom the workspace:
  All apps, Inbox and Settings, and a collapsed "More" group with the other workspace pages the role may open (Repositories,
  Credentials, Members, API tokens, Webhooks, Audit log, ...). Each app link keeps the platform scope of the address, and the version and
  locale of the page header (?version=&locale=). Each entry shows its `g` shortcut as a quiet hint (on hover, on focus, and while the
  first key is waiting).
  Props: address (the open app: id, section, platform), allowed (does the role have this action), attention? (the number of apps that
  need attention, on All apps), unanswered? (the unanswered reviews of the workspace, on Inbox), workspaceItems (the workspace views
  the role may open: id, label, icon), counts? (the badges of this app: `reviews` the unanswered reviews, `releases` the releases left
  unfinished, `pending` the changes waiting to publish (on Store listing, with `pendingBlocking` for an error that stops one); null
  draws nothing), status? (the platform lines), switcher?, mod, onopenswitcher, onpickapp.
  Groups are labelled ("This app", "Workspace"); a count says what needs the person, and the current page is marked by colour, weight and a bar.
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import { type Action, platformLabel } from '@kiln/core';
  import { address as pageAddress, appContext } from '../../lib/address.svelte.ts';
  import { carryHeaderParams } from '../../lib/app-header.ts';
  import { type RailItem, navEntryOf, visibleNav, withView, workspaceRail } from '../../lib/app-nav.ts';
  import { type AppAddress, type AppSection, appAddress } from '../../lib/app-scope.ts';
  import { badgeText } from '../../lib/nav-badges.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { chordHint } from '../../lib/shortcuts.ts';
  import type { SwitcherItem } from '../../lib/app-switcher.ts';
  import type { PlatformStatusLine } from '../../lib/app-status.ts';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import { isIconName } from '../ui/icons.ts';
  import AppSwitcherField from './AppSwitcherField.svelte';

  let {
    address,
    allowed,
    attention = null,
    unanswered = null,
    workspaceItems = [],
    counts = { reviews: null, releases: null },
    status = [],
    switcher = null,
    mod = 'Ctrl',
    onopenswitcher,
    onpickapp,
  }: {
    address: AppAddress;
    allowed: (action: Action) => boolean;
    attention?: number | null | undefined;
    unanswered?: number | null | undefined;
    workspaceItems?: RailItem[] | undefined;
    /** The apps for the switcher field (null while being read); with `onpickapp` the app name is a switcher. */
    switcher?: SwitcherItem[] | null | undefined;
    mod?: string | undefined;
    onopenswitcher?: (() => void) | undefined;
    onpickapp?: ((item: SwitcherItem) => void) | undefined;
    counts?: { reviews: number | null; releases: number | null; pending?: number | null; pendingBlocking?: boolean; insights?: number | null } | undefined;
    /** One line per platform of the app (lib/app-status.ts); empty draws no summary. */
    status?: PlatformStatusLine[] | undefined;
  } = $props();

  const badgeFor = (id: string): { count: number | null; labelKey: string; tone: 'warn' | 'accent' } | null =>
    id === 'reviews'
      ? { count: counts.reviews, labelKey: k('shell:badge.unanswered'), tone: 'warn' }
      : id === 'releases'
        ? { count: counts.releases, labelKey: k('app:nav.badgeUnfinished'), tone: 'warn' }
        : id === 'insights'
          ? { count: counts.insights ?? null, labelKey: k('app:nav.badgeInsights'), tone: 'accent' }
        : id === 'listing'
          ? { count: counts.pending ?? null, labelKey: k('app:nav.badgePending'), tone: counts.pendingBlocking ? 'warn' : 'accent' }
          : null;

  /** The link of an entry; with open Insights cards the entry opens on them (the badge counts them), not on the overview. */
  const entryHref = (id: AppSection, badge: { count: number | null } | null): string => {
    const href = carryHeaderParams(appAddress(address.id, id, address.platform), pageAddress.hash);
    return id === 'insights' && badgeText(badge?.count) ? withView(href, 'insights', 'highlights') : href;
  };
  const entries = $derived(visibleNav(allowed));
  const here = $derived(navEntryOf(address.section));
  const rail = $derived(workspaceRail(workspaceItems));
  const iconOf = (v: RailItem) => (isIconName(v.icon) ? v.icon : 'box');
</script>

<div class="app-nav" class:chord={navSignals.chordPending}>
  <div class="app-card">
    {#if onpickapp}
      <AppSwitcherField items={switcher} appId={address.id} fallbackName={appContext.name} {mod} onopen={onopenswitcher} onpick={onpickapp} />
    {:else if appContext.name}<p class="name" title={appContext.name}>{appContext.name}</p>{/if}
    {#if status.length > 0}
      <ul class="status" aria-label={t('app:nav.statusLabel')} data-testid="app-status">
        {#each status as line (line.platform)}
          <li class="tone-{line.tone}" data-platform={line.platform}>
            <PlatformBadge platform={line.platform} showLabel={false} />
            <span class="text">
              <span class="plat">{platformLabel(line.platform)}</span>
              <span class="state"><strong>{line.label}</strong>{#if line.version}<span class="version">{line.version}</span>{/if}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <nav aria-label={t('app:nav.thisApp')}>
    <p class="group-label" aria-hidden="true">{t('app:nav.thisApp')}</p>
    <ul>
      {#each entries as s (s.id)}
        {@const hint = chordHint('app', s.id)}
        {@const badge = badgeFor(s.id)}
        <li>
          <a href={entryHref(s.id, badge)} aria-current={here === s.id ? 'page' : undefined}>
            <Icon name={s.icon} size={18} />
            <span>{t(s.labelKey)}</span>
            {#if hint}<kbd class="nav-hint" aria-hidden="true">{hint}</kbd>{/if}
            {#if badge && badgeText(badge.count)}
              <span class="badge {badge.tone} nav-count">{badgeText(badge.count)}<span class="visually-hidden"> {t(badge.labelKey, { count: badge.count ?? 0 })}</span></span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  {#if rail.main.length > 0 || rail.more.length > 0}
    <nav class="workspace" aria-label={t('app:nav.workspace')}>
      <p class="group-label" aria-hidden="true">{t('app:nav.workspace')}</p>
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
                  <span class="badge nav-count {v.id === 'portfolio' ? 'warn' : 'accent'}">{badgeText(count)}<span class="visually-hidden"> {v.id === 'portfolio' ? t('shell:badge.attention', { count: count ?? 0 }) : t('shell:badge.unanswered', { count: count ?? 0 })}</span></span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if rail.more.length > 0}
        <details class="more">
          <summary>{t('app:nav.more')}</summary>
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
    gap: var(--space-3);
  }

  /* The app and what is going on with it, in one soft card. */
  .app-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .name {
    margin: 0;
    padding: 0 var(--space-3);
    overflow: hidden;
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-1);
    margin: 0;
    list-style: none;
  }

  /* One tile per platform, and beside it two short lines: the platform, then its state and version. The lines
     never wrap into each other, so the rows stay aligned however narrow the panel is. */
  .status li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3);
    align-items: center;
    font-size: var(--text-base);
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .plat {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .state {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .version {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
  }

  .tone-ok .state strong {
    color: var(--ok-ink);
  }

  .tone-bad .state strong {
    color: var(--bad-ink);
  }

  .tone-warn .state strong {
    color: var(--warn-ink);
  }

  .tone-neutral .state strong {
    font-weight: var(--weight-medium);
    color: var(--muted);
  }

  .group-label {
    padding: 0 var(--space-3);
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
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
    padding-top: var(--space-4);
    margin-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .more {
    margin-top: var(--space-1);
  }

  .more summary {
    display: flex;
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    font-size: var(--text-base);
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
    min-height: 2.5rem;
    padding: 0 var(--space-3);
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
    /* No background fade: switching section must show one current item, not two for a moment. */
    transition: color var(--duration-fast) var(--ease);
  }

  nav a:not([aria-current='page']):hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  /* The page you are on: colour, weight and a bar (app.css, "Sidebar navigation"), so it never rests on colour alone. */
  nav a[aria-current='page'] {
    font-weight: var(--weight-semibold);
    /* The bar sits flush on the left: square there, rounded on the right. Must be repeated here, because the rule
       above ("nav a") is scoped and would otherwise round all four corners and leave the bar sticking out. */
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    color: var(--ink);
  }

  nav a[aria-current='page'] :global(.icon) {
    color: var(--accent);
  }
</style>
