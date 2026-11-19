<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { Api } from '../lib/api.ts';
  import { can } from '@mrm/core';
  import { address, appContext } from '../lib/address.svelte.ts';
  import { carryHeaderParams } from '../lib/app-header.ts';
  import { groupApps } from '../lib/app-groups.ts';
  import { type AppSection, appAddress, parseViewPath, visibleSections } from '../lib/app-scope.ts';
  import { pageTitle } from '../lib/app-nav.ts';
  import { jumpTarget, switcherItems, type SwitcherItem } from '../lib/app-switcher.ts';
  import { breadcrumbItems } from '../lib/breadcrumb.ts';
  import { DEMO_BANNER_TEXT } from '../lib/demo.ts';
  import { appNavCounts, badgeLabel, badgeText } from '../lib/nav-badges.ts';
  import { lineFor } from '../lib/pending.ts';
  import { pendingStore } from '../lib/pending-store.svelte.ts';
  import { pipelineStore } from '../lib/pipeline-store.svelte.ts';
  import { navSignals } from '../lib/nav-signals.svelte.ts';
  import { CHORD_TIMEOUT_MS, type ChordState, chordHint, idleChord, isTypingTarget, stepShortcut } from '../lib/shortcuts.ts';
  import { initials } from '../lib/format.ts';
  import type { Me } from '../lib/types.ts';
  import { views } from '../lib/views.ts';
  import AppNav from './app/AppNav.svelte';
  import AppSwitcher from './app/AppSwitcher.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Icon from './ui/Icon.svelte';
  import StepUpHost from './StepUpHost.svelte';
  import Logo from './ui/Logo.svelte';
  import ThemeToggle from './ui/ThemeToggle.svelte';
  import { productName } from './ui/brand.ts';
  import { isIconName } from './ui/icons.ts';

  let {
    api,
    me,
    onsignout,
    canSignOut = true,
  }: { api: Api; me: Me; onsignout: () => void; canSignOut?: boolean } = $props();

  // The demo workspace (`pnpm demo`) says so in a slim bar; any other server has no /demo/status and the bar never shows.
  let demo = $state(false);
  onMount(() => {
    void api.demoStatus().then((yes) => (demo = yes));
  });

  const KEY = 'mrm.workspace';
  const remembered = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };

  // The person's last choice, if it is still one of their workspaces; otherwise the first.
  let chosen = $state(remembered());
  const workspaceId = $derived(
    me.workspaces.find((w) => w.id === chosen)?.id ?? me.workspaces[0]?.id ?? '',
  );
  const workspace = $derived(me.workspaces.find((w) => w.id === workspaceId));
  const roleLabel = $derived(workspace ? workspace.role.charAt(0).toUpperCase() + workspace.role.slice(1) : '');

  const visibleViews = $derived(
    views.filter((v) => !v.requires || !workspace || can(workspace.role, v.requires)),
  );
  // The section named by the address (`#/id`, or `#/id/...` for a screen with its own sub-routes), or the first one the person may see.
  // A `?query` belongs to the screen (`#/reviews?rating=1`, `?platform=ios`): it never changes the section.
  const path = $derived(parseViewPath(address.hash));
  const current = $derived(visibleViews.find((v) => v.id === path.segments[0]) ?? visibleViews[0]);
  const mainViews = $derived(visibleViews.filter((v) => v.group !== 'workspace'));
  const workspaceViews = $derived(visibleViews.filter((v) => v.group === 'workspace'));
  /** The open app: while one is open its panel replaces the workspace navigation. */
  const appAddr = $derived(current?.id === 'portfolio' ? address.app : null);

  // ---- Counts beside the navigation, the app switcher and the keyboard shortcuts (lib/shortcuts.ts)
  const canApps = $derived(workspace ? can(workspace.role, 'apps.read') : false);
  const attention = $derived(canApps ? navSignals.attentionOf(workspaceId) : null);
  const unanswered = $derived(workspace && can(workspace.role, 'reviews.read') ? navSignals.unansweredOf(workspaceId) : null);
  /** The badges of the open app's sidebar: unanswered reviews, and a release left unfinished. Nothing is read for this. */
  const appCounts = $derived.by(() => {
    if (!appAddr || !canApps) return { reviews: null, releases: null, pending: null, pendingBlocking: false };
    const apps = navSignals.appsOf(workspaceId);
    const group = apps ? groupApps(apps).filter((g) => g.members.some((m) => m.id === appAddr.id))[0] : undefined;
    const ids = group ? group.members.map((m) => m.id) : [appAddr.id];
    const line = lineFor(pendingStore.summary(workspaceId), ids);
    return {
      ...appNavCounts({
        memberIds: ids,
        unanswered: can(workspace?.role ?? 'viewer', 'reviews.read') ? navSignals.unansweredByAppOf(workspaceId) : {},
        stalled: pipelineStore.summary(workspaceId)?.apps ?? [],
      }),
      pending: line && line.count > 0 ? line.count : null,
      pendingBlocking: (line?.blocking ?? 0) > 0,
    };
  });
  const switcherList = $derived.by(() => {
    const apps = canApps ? navSignals.appsOf(workspaceId) : null;
    if (!apps) return null;
    const groups = groupApps(apps);
    const summary = pendingStore.summary(workspaceId);
    // The pending chip of each app (null when the summary is not known: no chip).
    return switcherItems(groups).map((item, i) => ({ ...item, pending: lineFor(summary, (groups[i]?.members ?? []).map((m) => m.id)) }));
  });

  // The pending summary behind the chips: read when the workspace changes and when an app is opened or left (so the numbers are fresh).
  $effect(() => {
    const space = workspaceId;
    void appAddr?.id;
    if (space !== '' && workspace && can(workspace.role, 'listing.read')) untrack(() => void pendingStore.loadSummary(api, space));
  });
  const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '');
  const modKey = isMac ? 'Cmd' : 'Ctrl';
  let switcherOpen = $state(false);
  let chord: ChordState = idleChord;
  let chordTimer: ReturnType<typeof setTimeout> | null = null;

  function openSwitcher() {
    if (!canApps) return;
    switcherOpen = true;
    void navSignals.ensureApps(api, workspaceId);
  }

  function pickApp(item: SwitcherItem) {
    location.hash = appAddress(item.key);
  }

  function setChord(next: ChordState) {
    chord = next;
    navSignals.chordPending = next.pendingAt !== null;
    if (chordTimer !== null) clearTimeout(chordTimer);
    chordTimer = null;
    if (next.pendingAt !== null) {
      chordTimer = setTimeout(() => {
        chord = idleChord;
        navSignals.chordPending = false;
      }, CHORD_TIMEOUT_MS);
    }
  }

  /** Capture phase, so a consumed key (the letter after `g`) never reaches the single-key shortcuts of a screen. */
  function onShortcut(event: KeyboardEvent) {
    if (!workspace) return;
    const step = stepShortcut(
      chord,
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        typing: isTypingTarget(event.target as HTMLElement | null),
        dialogOpen: document.querySelector('dialog[open]') !== null,
      },
      Date.now(),
      appAddr ? 'app' : 'workspace',
    );
    setChord(step.state);
    const action = step.action;
    if (!action) return;
    if (step.consume) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (action.type === 'open-switcher') {
      openSwitcher();
    } else if (action.type === 'jump-app') {
      if (!canApps) return;
      const index = action.index;
      void navSignals.ensureApps(api, workspaceId).then((apps) => {
        const item = apps ? jumpTarget(switcherItems(groupApps(apps)), index) : null;
        if (item) pickApp(item);
      });
    } else if (action.type === 'go') {
      if (appAddr && workspace) {
        const allowedHere = visibleSections((a) => can(workspace.role, a)).some((s) => s.id === action.target);
        if (allowedHere) location.hash = carryHeaderParams(appAddress(appAddr.id, action.target as AppSection, appAddr.platform), address.hash);
      } else if (visibleViews.some((v) => v.id === action.target)) {
        location.hash = `#/${action.target}`;
      }
    }
  }

  let drawerOpen = $state(false);
  let menuOpen = $state(false);
  let navEl = $state<HTMLElement>();
  let mainEl = $state<HTMLElement>();
  let menuButton = $state<HTMLButtonElement>();
  let userButton = $state<HTMLButtonElement>();
  let userEl = $state<HTMLElement>();

  // Following a link closes the drawer.
  $effect(() => {
    void address.hash;
    drawerOpen = false;
  });

  // The drawer only exists on narrow screens. Growing the window closes it.
  $effect(() => {
    const query = window.matchMedia('(min-width: 900px)');
    const onchange = () => {
      if (query.matches) drawerOpen = false;
    };
    query.addEventListener('change', onchange);
    return () => query.removeEventListener('change', onchange);
  });

  const crumbs = $derived(
    breadcrumbItems({
      workspace: workspace?.name,
      section: current ? { label: current.label, href: `#/${current.id}` } : null,
      appName: appContext.name,
      appOpen: Boolean(appAddr && current),
      page: appAddr ? pageTitle(appAddr.section) : null,
      appHref: appAddr ? appAddress(appAddr.id, 'dashboard', appAddr.platform) : null,
    }),
  );

  $effect(() => {
    const parts = [appAddr ? appContext.name : '', current?.label, workspace?.name, productName].filter(Boolean);
    document.title = parts.join(' · ');
  });

  async function openDrawer() {
    drawerOpen = true;
    await tick();
    navEl?.querySelector<HTMLElement>('a')?.focus();
  }

  function closeDrawer(restoreFocus = true) {
    drawerOpen = false;
    if (restoreFocus) menuButton?.focus();
  }

  function closeMenu(restoreFocus = true) {
    menuOpen = false;
    if (restoreFocus) userButton?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (menuOpen) closeMenu();
    else if (drawerOpen) closeDrawer();
  }

  function onpointerdown(event: PointerEvent) {
    if (menuOpen && userEl && !userEl.contains(event.target as Node)) menuOpen = false;
  }

  function onUserFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (menuOpen && next && userEl && !userEl.contains(next)) menuOpen = false;
  }

  function chooseWorkspace(id: string) {
    chosen = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // A private window can refuse storage. The choice just will not be remembered.
    }
  }

  // The skip link must not change the hash: the hash is the router.
  function skipToContent(event: Event) {
    event.preventDefault();
    mainEl?.focus();
  }

  let signingOut = $state(false);
  async function signOut() {
    signingOut = true;
    try {
      await api.logout();
    } finally {
      onsignout();
    }
  }
</script>

<svelte:window {onkeydown} {onpointerdown} onkeydowncapture={onShortcut} />

{#snippet item(v: (typeof views)[number])}
  {@const hint = chordHint('workspace', v.id)}
  {@const count = v.id === 'portfolio' ? attention : v.id === 'reviews' ? unanswered : null}
  <li>
    <a href="#/{v.id}" aria-current={current?.id === v.id ? 'page' : undefined}>
      <Icon name={isIconName(v.icon) ? v.icon : 'box'} size={18} />
      <span>{v.label}</span>
      {#if badgeText(count)}
        <span class="badge nav-count {v.id === 'portfolio' ? 'warn' : 'accent'}">{badgeText(count)}<span class="visually-hidden"> {v.id === 'portfolio' ? badgeLabel(count, 'app needs attention', 'apps need attention') : badgeLabel(count, 'unanswered review', 'unanswered reviews')}</span></span>
      {/if}
      {#if hint}<kbd class="nav-hint" aria-hidden="true">{hint}</kbd>{/if}
    </a>
  </li>
{/snippet}

<a class="skip-link" href="#main" onclick={skipToContent}>Skip to content</a>

<div class="shell">
  <aside id="sidebar" class="sidebar no-print" data-open={drawerOpen}>
    <div class="side-head">
      <Logo size={28} wordmark />
      <button type="button" class="ghost icon sm close" aria-label="Close navigation" onclick={() => closeDrawer()}>
        <Icon name="x" />
      </button>
    </div>

    {#if workspace}
      <div class="ws" class:single={me.workspaces.length < 2}>
        <span class="ws-mark" aria-hidden="true">{initials(workspace.name)}</span>
        <span class="ws-text">
          <span class="ws-name">{workspace.name}</span>
          <span class="ws-role">{roleLabel}</span>
        </span>
        {#if me.workspaces.length > 1}
          <Icon name="chevron-down" />
          <label class="visually-hidden" for="workspace">Workspace</label>
          <select id="workspace" value={workspaceId} onchange={(e) => chooseWorkspace(e.currentTarget.value)}>
            {#each me.workspaces as w (w.id)}<option value={w.id}>{w.name}</option>{/each}
          </select>
        {/if}
      </div>
    {/if}

    <div bind:this={navEl} class="nav-wrap" class:chord={navSignals.chordPending}>
      {#if appAddr && workspace}
        <AppNav address={appAddr} allowed={(a) => can(workspace.role, a)} {attention} {unanswered} workspaceItems={visibleViews} counts={appCounts} switcher={switcherList} mod={modKey} onopenswitcher={() => void navSignals.ensureApps(api, workspaceId)} onpickapp={pickApp} />
      {:else}
        <nav aria-label="Sections">
          <ul>
            {#each mainViews as v (v.id)}
              {@render item(v)}
            {/each}
          </ul>
          {#if workspaceViews.length > 0}
            <p class="eyebrow group-label">Workspace</p>
            <ul>
              {#each workspaceViews as v (v.id)}
                {@render item(v)}
              {/each}
            </ul>
          {/if}
        </nav>
      {/if}
    </div>
  </aside>

  <button
    type="button"
    class="bare scrim no-print"
    data-open={drawerOpen}
    aria-label="Close navigation"
    tabindex="-1"
    onclick={() => closeDrawer()}
  ></button>

  <div class="column" inert={drawerOpen}>
    {#if demo}
      <p class="demo-bar no-print" role="note" data-testid="demo-banner">{DEMO_BANNER_TEXT}</p>
    {/if}
    <header class="topbar no-print">
      <button
        bind:this={menuButton}
        type="button"
        class="ghost icon menu-button"
        aria-label="Open navigation"
        aria-expanded={drawerOpen}
        aria-controls="sidebar"
        onclick={openDrawer}
      >
        <Icon name="menu" size={20} />
      </button>

      <nav class="crumbs" aria-label="Breadcrumb">
        <ol>
          {#each crumbs as c (c.kind)}
            <li class:crumb-ws={c.kind === 'workspace'} aria-current={c.current ? 'page' : undefined} title={c.label}>
              {#if c.href}<a href={c.href}>{c.label}</a>{:else}{c.label}{/if}
            </li>
          {/each}
        </ol>
      </nav>

      <span class="spacer"></span>

      {#if canApps}
        <button type="button" class="ghost sm go" aria-label="Go to an app ({modKey} K)" onclick={openSwitcher}>
          <Icon name="search" size={16} />
          <span class="go-text">Go to app</span>
          <kbd aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
      {/if}

      <div class="user" bind:this={userEl} onfocusout={onUserFocusOut}>
        <button
          bind:this={userButton}
          type="button"
          class="bare user-button"
          aria-label="Account menu for {me.user.displayName}"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls="user-menu"
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class="avatar" aria-hidden="true">{initials(me.user.displayName)}</span>
          <span class="who" aria-hidden="true">{me.user.displayName}</span>
          <Icon name="chevron-down" />
        </button>

        {#if menuOpen}
          <div id="user-menu" class="menu" role="group" aria-label="Account">
            <div class="menu-head">
              <span class="avatar large" aria-hidden="true">{initials(me.user.displayName)}</span>
              <div class="menu-who">
                <p class="menu-name">{me.user.displayName}</p>
                <p class="menu-email">{me.user.email}</p>
              </div>
            </div>
            <div class="menu-section">
              <p class="eyebrow">Theme</p>
              <ThemeToggle block />
            </div>
            {#if canSignOut}
              <div class="menu-section">
                <Button variant="ghost" block icon="log-out" loading={signingOut} onclick={signOut}>Sign out</Button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </header>

    <main id="main" tabindex="-1" bind:this={mainEl}>
      <div class="content" class:wide={current?.id === 'portfolio'}>
        {#if !workspace}
          <EmptyState
            icon="layers"
            title="No workspace yet"
            description="You are not a member of any workspace. Ask an owner to invite you."
          />
        {:else if current}
          <current.component {api} workspaceId={workspace.id} role={workspace.role} />
        {:else}
          <EmptyState
            icon="lock"
            title="Nothing to show yet"
            description="Your role does not include any sections yet."
          />
        {/if}
      </div>
    </main>
  </div>
</div>

{#if workspace && canApps}
  <AppSwitcher bind:open={switcherOpen} items={switcherList} mod={modKey} onpick={pickApp} />
{/if}

{#if workspace}
  <StepUpHost {api} {workspaceId} />
{/if}

<style>
  .skip-link {
    position: fixed;
    top: var(--space-2);
    left: var(--space-2);
    z-index: calc(var(--z-toast) + 10);
    padding: var(--space-2) var(--space-4);
    font-weight: var(--weight-medium);
    color: var(--accent-ink);
    text-decoration: none;
    background: var(--accent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    transform: translateY(-200%);
  }

  .skip-link:focus {
    transform: none;
  }

  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    min-height: 100vh;
  }

  /* ---- Sidebar ---- */
  .sidebar {
    position: sticky;
    top: 0;
    z-index: var(--z-sidebar);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    height: 100vh;
    height: 100dvh;
    padding: var(--space-4) var(--space-3);
    overflow-y: auto;
    background: var(--surface);
    border-right: 1px solid var(--line);
  }

  .side-head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
    min-height: var(--control-md);
    padding: 0 var(--space-2);
  }

  .close {
    display: none;
  }

  /* The demo bar: slim and permanent (it cannot be dismissed), above the top bar. */
  .demo-bar {
    padding: var(--space-1) var(--space-4);
    margin: 0;
    font-size: var(--text-xs);
    text-align: center;
    color: var(--ink);
    background: var(--warn-bg);
    border-bottom: 1px solid var(--line);
  }

  .ws {
    position: relative;
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2);
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    transition:
      border-color var(--duration-fast) var(--ease),
      background-color var(--duration-fast) var(--ease);
  }

  .ws:not(.single):hover {
    background: var(--surface-hover);
    border-color: var(--line-hover);
  }

  .ws:has(select:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .ws select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    cursor: pointer;
    background: none;
    border: 0;
    box-shadow: none;
    opacity: 0;
  }

  .ws-mark {
    display: grid;
    flex: none;
    width: 28px;
    height: 28px;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--ink);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    place-items: center;
  }

  .ws-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }

  .ws-name {
    overflow: hidden;
    font-weight: var(--weight-medium);
    color: var(--ink);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ws-role {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .group-label {
    margin: var(--space-5) 0 var(--space-2);
    padding: 0 var(--space-3);
  }

  /* Scoped to the sidebar: the breadcrumb is a <nav> too and must not inherit the menu-link look. */
  .sidebar nav ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .sidebar nav a {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
    transition:
      background-color var(--duration-fast) var(--ease),
      color var(--duration-fast) var(--ease);
  }

  .sidebar nav a:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  .sidebar nav a[aria-current='page'] {
    color: var(--ink);
    background: var(--accent-bg);
  }

  .sidebar nav a[aria-current='page'] :global(.icon) {
    color: var(--accent);
  }

  /* Counts and shortcut hints beside a navigation entry (also those drawn by AppNav). Quiet by default:
     a hint shows on hover, on keyboard focus, and while the first key of a `g` chord is waiting. */
  .sidebar :global(.nav-count) {
    margin-left: auto;
  }

  .sidebar :global(.nav-hint) {
    padding: 0 var(--space-1);
    margin-left: auto;
    font-size: var(--text-xs);
    line-height: 16px;
    color: var(--muted);
    border-bottom-width: 1px;
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease);
  }

  .sidebar :global(.nav-count + .nav-hint) {
    margin-left: var(--space-2);
  }

  .sidebar :global(nav a:hover .nav-hint),
  .sidebar :global(nav a:focus-visible .nav-hint),
  .sidebar :global(.chord .nav-hint) {
    opacity: 1;
  }

  .go {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    color: var(--muted);
  }

  .go kbd {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  @media (max-width: 700px) {
    .go-text,
    .go kbd {
      display: none;
    }
  }

  /* ---- Top bar ---- */
  .column {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    gap: var(--space-3);
    align-items: center;
    height: var(--topbar-height);
    padding: 0 var(--space-8);
    background: color-mix(in srgb, var(--ground) 88%, transparent);
    border-bottom: 1px solid var(--line);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }

  .menu-button {
    display: none;
  }

  .crumbs {
    flex: 0 1 auto;
    min-width: 0;
  }

  /* One line, one baseline: every item is a shrinkable inline box that truncates with an ellipsis. */
  .crumbs ol {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-2);
    align-items: baseline;
    min-width: 0;
    padding: 0;
    margin: 0;
    font-weight: var(--weight-medium);
    color: var(--muted);
    white-space: nowrap;
    list-style: none;
  }

  .crumbs li {
    display: block;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .crumbs li[aria-current='page'] {
    flex-shrink: 1;
    max-width: 40ch;
    color: var(--ink);
  }

  .crumbs li + li::before {
    margin-right: var(--space-2);
    color: var(--faint);
    content: '/';
  }

  .crumbs a {
    color: inherit;
    text-decoration: none;
  }

  .crumbs a:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  /* ---- User menu ---- */
  .user {
    position: relative;
  }

  .user-button {
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-full);
    transition: background-color var(--duration-fast) var(--ease);
  }

  .user-button:hover {
    background: var(--surface-hover);
  }

  .who {
    max-width: 160px;
    overflow: hidden;
    font-weight: var(--weight-medium);
    color: var(--ink);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .avatar {
    display: grid;
    flex: none;
    width: 28px;
    height: 28px;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--accent);
    background: var(--accent-bg);
    border-radius: 50%;
    place-items: center;
  }

  .avatar.large {
    width: 40px;
    height: 40px;
    font-size: var(--text-base);
  }

  .menu {
    position: absolute;
    top: calc(100% + var(--space-2));
    right: 0;
    z-index: var(--z-dropdown);
    width: 280px;
    max-width: calc(100vw - var(--space-8));
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    animation: menu-in var(--duration-base) var(--ease);
  }

  .menu-head {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-4);
  }

  .menu-who {
    min-width: 0;
  }

  .menu-name,
  .menu-email {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-name {
    font-weight: var(--weight-semibold);
  }

  .menu-email {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .menu-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  /* ---- Content ---- */
  main {
    flex: 1;
    min-width: 0;
    padding: var(--space-8);
  }

  main:focus {
    outline: none;
  }

  .content {
    width: 100%;
    max-width: var(--content-width);
    margin: 0 auto;
  }

  /* The apps and the screens of an app are dense: they use the width there is. */
  .content.wide {
    max-width: 1600px;
  }

  .scrim {
    display: none;
  }

  /* ---- Narrow screens: the sidebar becomes a drawer ---- */
  @media (max-width: 899px) {
    .shell {
      display: block;
    }

    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: var(--z-overlay);
      width: min(300px, 86vw);
      visibility: hidden;
      box-shadow: var(--shadow-lg);
      transform: translateX(-100%);
      transition:
        transform var(--duration-slow) var(--ease),
        visibility var(--duration-slow);
    }

    .sidebar[data-open='true'] {
      visibility: visible;
      transform: none;
    }

    .close,
    .menu-button {
      display: inline-flex;
    }

    .scrim {
      position: fixed;
      inset: 0;
      z-index: calc(var(--z-overlay) - 1);
      display: block;
      visibility: hidden;
      background: var(--scrim);
      opacity: 0;
      transition:
        opacity var(--duration-slow) var(--ease),
        visibility var(--duration-slow);
    }

    .scrim[data-open='true'] {
      visibility: visible;
      opacity: 1;
    }

    .topbar {
      padding: 0 var(--space-4);
    }

    .crumb-ws {
      display: none;
    }

    .crumb-ws + li::before {
      display: none;
    }

    main {
      padding: var(--space-6) var(--space-4);
    }
  }

  @media (max-width: 599px) {
    .who {
      display: none;
    }

    .user-button {
      padding-right: var(--space-1);
    }
  }

  @media print {
    .shell {
      display: block;
    }

    main {
      padding: 0;
    }
  }
</style>
