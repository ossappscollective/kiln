<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { Api } from '../lib/api.ts';
  import { floating } from '../lib/floating.ts';
  import { can } from '@kiln/core';
  import { address, appContext } from '../lib/address.svelte.ts';
  import { carryHeaderParams } from '../lib/app-header.ts';
  import { groupApps } from '../lib/app-groups.ts';
  import { type AppSection, appAddress, parseViewPath, visibleSections } from '../lib/app-scope.ts';
  import { pageTitle } from '../lib/app-nav.ts';
  import { appSwitchHash, jumpTarget, switcherItems, type SwitcherItem } from '../lib/app-switcher.ts';
  import { breadcrumbItems, charsFor, fitCrumbs } from '../lib/breadcrumb.ts';
  import { DEMO_BANNER_KEY } from '../lib/demo.ts';
  import { alertStore } from '../lib/alerts/store.svelte.ts';
  import { platformStatusLines } from '../lib/app-status.ts';
  import { t } from '../lib/i18n/t.ts';
  import { appNavCounts, badgeText } from '../lib/nav-badges.ts';
  import { navBadgeCount } from '../lib/insights/insights.ts';
  import { appStateStore } from '../lib/app-state/app-state-store.svelte.ts';
  import { roleLabel } from '../lib/role-label.ts';
  import { navSignals, pendingAcrossText } from '../lib/app-state/pending-facade.ts';
  import { tint } from '../lib/tint/store.svelte.ts';
  import { loadCollapsed, railApplies, saveCollapsed } from '../lib/sidebar-state.ts';
  import { CHORD_TIMEOUT_MS, type ChordState, chordHint, idleChord, isTypingTarget, stepShortcut } from '../lib/shortcuts.ts';
  import { initials } from '../lib/format.ts';
  import { heightToHold, shouldResetScroll } from '../lib/scroll-keep.ts';
  import { createSectionHost, provideSectionHost } from '../lib/section-host.svelte.ts';
  import { sectionPageOf } from '../lib/section-state.ts';
  import type { Me } from '../lib/types.ts';
  import { views } from '../lib/views.ts';
  import AppNav from './app/AppNav.svelte';
  import AlertBell from './alerts/AlertBell.svelte';
  import PendingCartButton from './app/PendingCartButton.svelte';
  import AppSwitcher from './app/AppSwitcher.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Icon from './ui/Icon.svelte';
  import LanguageSelect from './ui/LanguageSelect.svelte';
  import StepUpHost from './StepUpHost.svelte';
  import Logo from './ui/Logo.svelte';
  import ThemeToggle from './ui/ThemeToggle.svelte';
  import TintToggle from './ui/TintToggle.svelte';
  import { productName } from './ui/brand.ts';
  import { isIconName } from './ui/icons.ts';

  let {
    api,
    me,
    onsignout,
    canSignOut = true,
  }: { api: Api; me: Me; onsignout: () => void; canSignOut?: boolean | undefined } = $props();

  // The demo workspace (`pnpm demo`) says so in a slim bar; any other server has no /demo/status and the bar never shows.
  let demo = $state(false);
  onMount(() => {
    void api.demoStatus().then((yes) => (demo = yes));
  });

  const KEY = 'kiln.workspace';
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
  const roleName = $derived(workspace ? roleLabel(workspace.role) : '');

  const visibleViews = $derived(
    views.filter((v) => !v.requires || !workspace || can(workspace.role, v.requires)),
  );
  // The section named by the address (`#/id`, or `#/id/...` for a screen with its own sub-routes), or the first one the person may see.
  // A `?query` belongs to the screen (`#/reviews?rating=1`, `?platform=ios`): it never changes the section.
  const path = $derived(parseViewPath(address.hash));
  const current = $derived(visibleViews.find((v) => v.id === path.segments[0]) ?? visibleViews[0]);
  /** The workspace sections as the open app's panel wants them: with the name in the active language. */
  const railItems = $derived(visibleViews.map((v) => ({ ...v, label: t(v.labelKey) })));
  const mainViews = $derived(visibleViews.filter((v) => v.group !== 'workspace'));
  const workspaceViews = $derived(visibleViews.filter((v) => v.group === 'workspace'));
  /** The open app: while one is open its panel replaces the workspace navigation. */
  const appAddr = $derived(current?.id === 'portfolio' ? address.app : null);

  // ---- Counts beside the navigation, the app switcher and the keyboard shortcuts (lib/shortcuts.ts)
  const canApps = $derived(workspace ? can(workspace.role, 'apps.read') : false);
  const attention = $derived(canApps ? navSignals.attentionOf(workspaceId) : null);
  const unanswered = $derived(workspace && can(workspace.role, 'reviews.read') ? navSignals.unansweredOf(workspaceId) : null);
  /** Pending changes across every app of the workspace (the "Pending" entry): counts only, read from GET /pending/cart-summary (ADR 0064). */
  const canPending = $derived(workspace ? can(workspace.role, 'listing.read') : false);
  const pendingNav = $derived(canPending ? appStateStore.workspaceTotals(workspaceId, navSignals.appsOf(workspaceId)) : null);
  // The facts of what is pending and what publishes (docs/state-model.md): read when the workspace is shown and when the window comes back,
  // again soon after any stage, discard or publish, every few seconds only while a publish runs, never when none does. ONE store reads
  // them; every screen below asks it.
  $effect(() => {
    if (!canPending) return;
    const space = workspaceId;
    return untrack(() => appStateStore.watch(api, space));
  });
  /** The badges of the open app's sidebar: unanswered reviews, and a release left unfinished. Nothing is read for this. */
  const appCounts = $derived.by(() => {
    if (!appAddr || !canApps) return { reviews: null, releases: null, pending: null, pendingBlocking: false, insights: null };
    const apps = navSignals.appsOf(workspaceId);
    const group = apps ? groupApps(apps).filter((g) => g.members.some((m) => m.id === appAddr.id))[0] : undefined;
    const ids = group ? group.members.map((m) => m.id) : [appAddr.id];
    const line = appStateStore.lineOf(workspaceId, ids);
    return {
      insights: can(workspace?.role ?? 'viewer', 'analytics.read') ? navBadgeCount(ids, navSignals.insightsByAppOf(workspaceId)) : null,
      ...appNavCounts({
        memberIds: ids,
        unanswered: can(workspace?.role ?? 'viewer', 'reviews.read') ? navSignals.unansweredByAppOf(workspaceId) : {},
        stalled: appStateStore.stalledApps(workspaceId, navSignals.releasesOf(workspaceId)),
      }),
      pending: line && line.count > 0 ? line.count : null,
      pendingBlocking: (line?.blocking ?? 0) > 0 || line?.failed === true,
    };
  });
  /** One status line per platform of the open app (from the releases its screen loaded). */
  const appStatus = $derived.by(() => {
    if (!appAddr || !canApps) return [];
    const apps = navSignals.appsOf(workspaceId);
    const group = apps ? groupApps(apps).filter((g) => g.members.some((m) => m.id === appAddr.id))[0] : undefined;
    return group ? platformStatusLines(group.members, navSignals.releasesOf(workspaceId)) : [];
  });
  const switcherList = $derived.by(() => {
    const apps = canApps ? navSignals.appsOf(workspaceId) : null;
    if (!apps) return null;
    const groups = groupApps(apps);
    // The pending chip of each app (null when the count is not known: no chip).
    return switcherItems(groups).map((item, i) => ({ ...item, pending: appStateStore.lineOf(workspaceId, (groups[i]?.members ?? []).map((m) => m.id)) }));
  });

  // The pending summary behind the chips: read when the workspace changes and when an app is opened or left (so the numbers are fresh).
  $effect(() => {
    const space = workspaceId;
    void appAddr?.id;
    if (space !== '' && workspace && can(workspace.role, 'listing.read')) untrack(() => appStateStore.ensure(api, space));
  });
  // The badge of the Insights entry: one cheap read per record of the open app, when it is opened (and again only when the number is older than
  // five minutes); the Insights page keeps it exact after a dismissal. No timer.
  $effect(() => {
    const space = workspaceId;
    const id = appAddr?.id;
    if (space === '' || !id || !workspace || !can(workspace.role, 'analytics.read')) return;
    const apps = navSignals.appsOf(space);
    const group = apps ? groupApps(apps).filter((g) => g.members.some((m) => m.id === id))[0] : undefined;
    const ids = group ? group.members.map((m) => m.id) : [id];
    untrack(() => void navSignals.ensureInsightsCounts(api, space, ids));
  });
  // The app tint (docs/adr/0068-app-tint.md): the workspace's per-app overrides once, and the palette of the open app's icon (from the
  // cache at once, else read from the icon). Nothing here can fail visibly: no palette, no override, no tint.
  $effect(() => {
    const space = workspaceId;
    if (space === '' || !workspace || !can(workspace.role, 'apps.read')) return;
    let current = true;
    untrack(() =>
      api.appAppearances(space).then((r) => current && tint.setOverrides(r.apps)).catch(() => {}),
    );
    return () => {
      current = false;
    };
  });
  $effect(() => {
    const id = appAddr?.id;
    const apps = navSignals.appsOf(workspaceId);
    const icon = id && apps ? apps.find((a) => a.id === id)?.iconUrl : null;
    if (id && icon) untrack(() => tint.track(id, icon));
  });
  /** The tint of the open app: the inline style of the wrappers below; empty is no tint and the attribute is left off. */
  const appTintStyle = $derived(appAddr ? tint.style(appAddr.id) : '');
  // The alert bell's count and newest alerts, read while a workspace is open (lib/alert-store.svelte.ts).
  $effect(() => {
    const space = workspaceId;
    if (space === '' || !workspace || !can(workspace.role, 'alerts.read')) return;
    return untrack(() => alertStore.start(api, space));
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

  /** Another app opens on the same page (Releases stays Releases, a view and a platform that exist there stay), else on its Overview. */
  function pickApp(item: SwitcherItem) {
    const role = workspace?.role;
    location.hash = appSwitchHash(address.hash, item, role ? (a) => can(role, a) : undefined);
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
    } else if (action.type === 'toggle-sidebar') {
      toggleRail();
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
  // The left panel folds to a rail of icons on a wide screen (remembered per person in this browser). On a narrow screen it is the drawer.
  let wide = $state(true);
  let collapsed = $state(untrack(() => loadCollapsed(me.user.id)));
  const rail = $derived(railApplies(collapsed, wide));
  function toggleRail() {
    if (!wide) return;
    collapsed = !collapsed;
    saveCollapsed(me.user.id, collapsed);
  }
  let menuOpen = $state(false);
  let navEl = $state<HTMLElement>();
  let mainEl = $state<HTMLElement>();
  let menuButton = $state<HTMLButtonElement>();
  let userButton = $state<HTMLButtonElement>();
  let userEl = $state<HTMLElement>();

  // The collapsible sections of the page remember their state per workspace, person and page (components/ui/Section.svelte).
  provideSectionHost(createSectionHost(() => ({ workspaceId, userId: me.user.id, page: sectionPageOf(address.hash) })));

  // Scroll: only a different route path (another page or app) starts at the top. A change of the query alone (view, platform scope,
  // version, locale, filters) keeps the position: the page also keeps its height while the new view loads, so a short placeholder
  // cannot pull it up. Runs before the DOM is updated, while the old page is still measurable.
  let keptHash = untrack(() => address.hash);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  $effect.pre(() => {
    const next = address.hash;
    const prev = untrack(() => keptHash);
    if (next === prev) return;
    keptHash = next;
    const reset = shouldResetScroll(prev, next);
    const top = window.scrollY;
    const hold = untrack(() => heightToHold(reset, mainEl?.offsetHeight ?? 0));
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    if (mainEl) mainEl.style.minHeight = hold > 0 ? `${hold}px` : '';
    void tick().then(() => {
      if (reset) window.scrollTo(0, 0);
      else if (Math.abs(window.scrollY - top) > 1) window.scrollTo(0, top);
    });
    if (hold > 0) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (mainEl) mainEl.style.minHeight = '';
      }, 3000);
    }
  });

  // Following a link closes the drawer.
  $effect(() => {
    void address.hash;
    drawerOpen = false;
  });

  // The drawer only exists on narrow screens. Growing the window closes it.
  $effect(() => {
    const query = window.matchMedia('(min-width: 900px)');
    const onchange = () => {
      wide = query.matches;
      if (query.matches) drawerOpen = false;
    };
    onchange();
    query.addEventListener('change', onchange);
    return () => query.removeEventListener('change', onchange);
  });

  const crumbs = $derived(
    breadcrumbItems({
      workspace: workspace?.name,
      section: current ? { label: t(current.labelKey), href: `#/${current.id}` } : null,
      appName: appContext.name,
      appOpen: Boolean(appAddr && current),
      page: appAddr ? pageTitle(appAddr.section) : null,
      appHref: appAddr ? appAddress(appAddr.id, 'dashboard', appAddr.platform) : null,
    }),
  );

  // The room of the breadcrumb decides which crumbs are shown whole and which go behind the ellipsis menu (lib/breadcrumb.ts fitCrumbs).
  let crumbsWidth = $state(0);
  let crumbMenuOpen = $state(false);
  let crumbMenuEl = $state<HTMLElement>();
  let crumbMenuButton = $state<HTMLButtonElement>();
  const shownCrumbs = $derived(crumbsWidth > 0 ? fitCrumbs(crumbs, charsFor(crumbsWidth)) : crumbs);

  $effect(() => {
    const parts = [appAddr ? appContext.name : '', current ? t(current.labelKey) : '', workspace?.name, productName].filter(Boolean);
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
    if (crumbMenuOpen) {
      crumbMenuOpen = false;
      crumbMenuButton?.focus();
    } else if (menuOpen) closeMenu();
    else if (drawerOpen) closeDrawer();
  }

  function onpointerdown(event: PointerEvent) {
    if (crumbMenuOpen && crumbMenuEl && !crumbMenuEl.contains(event.target as Node)) crumbMenuOpen = false;
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
  {@const count = v.id === 'portfolio' ? attention : v.id === 'reviews' ? unanswered : v.id === 'pending' ? (pendingNav?.changes ?? null) : null}
  <li>
    <a href="#/{v.id}" aria-current={current?.id === v.id ? 'page' : undefined} title={rail ? t(v.labelKey) : undefined}>
      <Icon name={isIconName(v.icon) ? v.icon : 'box'} size={18} />
      <span>{t(v.navLabelKey ?? v.labelKey)}</span>
      {#if badgeText(count)}
        <span class="badge nav-count {v.id === 'portfolio' ? 'warn' : 'accent'}">{badgeText(count)}<span class="visually-hidden"> {#if v.id === 'portfolio'}{t('shell:badge.attention', { count })}{:else if v.id === 'pending' && pendingNav}{pendingAcrossText(pendingNav)}{:else}{t('shell:badge.unanswered', { count })}{/if}</span></span>
      {/if}
      {#if hint}<kbd class="nav-hint" aria-hidden="true">{hint}</kbd>{/if}
    </a>
  </li>
{/snippet}

<a class="skip-link" href="#main" onclick={skipToContent}>{t('shell:skipToContent')}</a>

<div class="shell" data-rail={rail}>
  <aside id="sidebar" class="sidebar no-print" data-open={drawerOpen} data-collapsed={rail}>
    <div class="side-head">
      <Logo size={28} wordmark={!rail} />
      <button
        type="button"
        class="ghost icon sm rail-toggle"
        aria-label={rail ? t('shell:nav.expand') : t('shell:nav.collapse')}
        aria-expanded={!rail}
        aria-controls="sidebar-nav"
        title={`${rail ? t('shell:nav.expand') : t('shell:nav.collapse')} (${modKey} B)`}
        onclick={toggleRail}
      >
        <Icon name={rail ? 'chevron-right' : 'chevron-left'} />
      </button>
      <button type="button" class="ghost icon sm close" aria-label={t('shell:nav.close')} onclick={() => closeDrawer()}>
        <Icon name="x" />
      </button>
    </div>

    {#if workspace}
      <div class="ws" class:single={me.workspaces.length < 2}>
        <span class="ws-mark" aria-hidden="true">{initials(workspace.name)}</span>
        <span class="ws-text" title={rail ? workspace.name : undefined}>
          <span class="ws-name">{workspace.name}</span>
          <span class="ws-role">{roleName}</span>
        </span>
        {#if me.workspaces.length > 1}
          <Icon name="chevron-down" />
          <label class="visually-hidden" for="workspace">{t('shell:workspace.selectLabel')}</label>
          <select id="workspace" value={workspaceId} onchange={(e) => chooseWorkspace(e.currentTarget.value)}>
            {#each me.workspaces as w (w.id)}<option value={w.id}>{w.name}</option>{/each}
          </select>
        {/if}
      </div>
    {/if}

    <div bind:this={navEl} id="sidebar-nav" class="nav-wrap" class:chord={navSignals.chordPending}>
      {#if appAddr && workspace}
        <AppNav address={appAddr} allowed={(a) => can(workspace.role, a)} {attention} {unanswered} pending={pendingNav} workspaceItems={railItems} counts={appCounts} status={appStatus} switcher={switcherList} mod={modKey} collapsed={rail} tintStyle={appTintStyle} onexpand={toggleRail} onopenswitcher={() => void navSignals.ensureApps(api, workspaceId)} onpickapp={pickApp} />
      {:else}
        <nav aria-label={t('shell:nav.sections')}>
          <ul>
            {#each mainViews as v (v.id)}
              {@render item(v)}
            {/each}
          </ul>
          {#if workspaceViews.length > 0}
            <p class="eyebrow group-label">{t('shell:nav.workspaceGroup')}</p>
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
    aria-label={t('shell:nav.close')}
    tabindex="-1"
    onclick={() => closeDrawer()}
  ></button>

  <div class="column" inert={drawerOpen} data-app-tint-glow={appTintStyle ? '' : undefined} style={appTintStyle || undefined}>
    {#if demo}
      <p class="demo-bar no-print" role="note" data-testid="demo-banner">{t(DEMO_BANNER_KEY)}</p>
    {/if}
    <header class="topbar no-print">
      <button
        bind:this={menuButton}
        type="button"
        class="ghost icon menu-button"
        aria-label={t('shell:nav.open')}
        aria-expanded={drawerOpen}
        aria-controls="sidebar"
        onclick={openDrawer}
      >
        <Icon name="menu" size={20} />
      </button>

      <nav class="crumbs" aria-label={t('shell:breadcrumb.label')} bind:clientWidth={crumbsWidth}>
        <ol>
          {#each shownCrumbs as c (c.kind)}
            {#if c.kind === 'more'}
              <li class="crumb-more" bind:this={crumbMenuEl} onfocusout={(e) => {
                const next = e.relatedTarget as Node | null;
                if (crumbMenuOpen && next && crumbMenuEl && !crumbMenuEl.contains(next)) crumbMenuOpen = false;
              }}>
                <button
                  bind:this={crumbMenuButton}
                  type="button"
                  class="bare crumb-more-button"
                  aria-label={t('shell:breadcrumb.more')}
                  aria-haspopup="true"
                  aria-expanded={crumbMenuOpen}
                  aria-controls="crumb-menu"
                  onclick={() => (crumbMenuOpen = !crumbMenuOpen)}
                >…</button>
                {#if crumbMenuOpen}
                  <ul id="crumb-menu" class="menu crumb-menu" aria-label={t('shell:breadcrumb.restOfPath')} use:floating={{ anchor: crumbMenuButton ?? null, align: 'start', gap: 6 }}>
                    {#each c.menu as m (m.kind)}
                      <li><a href={m.href ?? undefined} onclick={() => (crumbMenuOpen = false)}>{m.label}</a></li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {:else}
              <li class:crumb-ws={c.kind === 'workspace'} aria-current={c.current ? 'page' : undefined} title={c.label}>
                {#if c.href}<a href={c.href}>{c.label}</a>{:else}{c.label}{/if}
              </li>
            {/if}
          {/each}
        </ol>
      </nav>

      {#if canApps}
        <button type="button" class="ghost sm go" aria-label={t('shell:goToApp.label', { shortcut: `${modKey} K` })} onclick={openSwitcher}>
          <Icon name="search" size={16} />
          <span class="go-text">{t('shell:goToApp.text')}</span>
          <kbd aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
      {/if}

      {#if workspace && can(workspace.role, 'alerts.read')}
        <AlertBell {api} {workspaceId} />
      {/if}

      <PendingCartButton tintStyle={appTintStyle} {workspaceId} />

      <div class="user" bind:this={userEl} onfocusout={onUserFocusOut}>
        <button
          bind:this={userButton}
          type="button"
          class="bare user-button"
          aria-label={t('shell:account.menuLabel', { name: me.user.displayName })}
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
          <div id="user-menu" class="menu" role="group" aria-label={t('shell:account.group')} use:floating={{ anchor: userButton ?? null, align: 'end', gap: 8 }}>
            <div class="menu-head">
              <span class="avatar large" aria-hidden="true">{initials(me.user.displayName)}</span>
              <div class="menu-who">
                <p class="menu-name">{me.user.displayName}</p>
                <p class="menu-email">{me.user.email}</p>
              </div>
            </div>
            <div class="menu-section">
              <p class="eyebrow">{t('common:theme.label')}</p>
              <ThemeToggle block />
            </div>
            <div class="menu-section">
              <TintToggle />
            </div>
            <div class="menu-section">
              <LanguageSelect layout="stacked" block account />
            </div>
            {#if canSignOut}
              <div class="menu-section">
                <Button variant="ghost" block icon="log-out" loading={signingOut} onclick={signOut}>{t('shell:account.signOut')}</Button>
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
            title={t('shell:empty.noWorkspace.title')}
            description={t('shell:empty.noWorkspace.description')}
          />
        {:else if current}
          <current.component {api} workspaceId={workspace.id} role={workspace.role} />
        {:else}
          <EmptyState
            icon="lock"
            title={t('shell:empty.noSections.title')}
            description={t('shell:empty.noSections.description')}
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
  <StepUpHost {api} {workspaceId} email={me.user.email} />
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
    background: var(--sidebar);
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

  .close,
  .rail-toggle {
    display: none;
  }

  /* ---- Rail: the panel folded to icons (wide screens only; the drawer below is always whole) ---- */
  @media (min-width: 900px) {
    .shell {
      transition: grid-template-columns var(--duration-base) var(--ease);
    }

    .shell[data-rail='true'] {
      grid-template-columns: var(--sidebar-rail-width) minmax(0, 1fr);
    }

    .rail-toggle {
      display: inline-flex;
    }

    /* In the rail the toggle is as large as a nav icon (2.5rem), directly under the logo. */
    .sidebar[data-collapsed='true'] .rail-toggle {
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
    }

    .sidebar[data-collapsed='true'] {
      padding-inline: var(--space-2);
      overflow-x: hidden;
    }

    .sidebar[data-collapsed='true'] .side-head {
      flex-direction: column;
      gap: var(--space-2);
      padding: 0;
    }

    .sidebar[data-collapsed='true'] .ws {
      justify-content: center;
      padding: var(--space-1);
    }

    .sidebar[data-collapsed='true'] .ws :global(svg),
    .sidebar[data-collapsed='true'] .ws-text {
      display: none;
    }

    /* Labels stay in the page for assistive technology (visually hidden, not removed); the link also carries a title. */
    .sidebar[data-collapsed='true'] :global(nav a > span:not(.nav-count)),
    .sidebar[data-collapsed='true'] :global(.group-label),
    .sidebar[data-collapsed='true'] :global(.nav-hint) {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      white-space: nowrap;
      clip-path: inset(50%);
    }

    .sidebar[data-collapsed='true'] :global(nav a) {
      position: relative;
      justify-content: center;
      padding: 0;
    }

    .sidebar[data-collapsed='true'] :global(.nav-count) {
      position: absolute;
      top: 2px;
      right: 2px;
      min-width: 0;
      padding: 0 var(--space-1);
      margin: 0;
      font-size: var(--text-xs);
      line-height: 1.2;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .shell {
      transition: none;
    }
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
    outline: var(--ring);
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
    min-height: 2.5rem;
    padding: 0 var(--space-3);
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
    transition:
      background-color var(--duration-fast) var(--ease),
      color var(--duration-fast) var(--ease);
  }

  .sidebar nav a:not([aria-current='page']):hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  /* The wash and the gradient bar of the current item are in app.css ("Sidebar navigation"), shared with AppNav. */
  .sidebar nav a[aria-current='page'] {
    font-weight: var(--weight-semibold);
    /* The bar sits flush on the left: square there, rounded on the right. Must be repeated here, because the rule
       above ("nav a") is scoped and would otherwise round all four corners and leave the bar sticking out. */
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    color: var(--ink);
  }

  .sidebar nav a[aria-current='page'] :global(.icon) {
    color: var(--accent);
  }

  /* Counts and shortcut hints beside a navigation entry (also those drawn by AppNav). Quiet by default:
     a hint shows on hover, on keyboard focus, and while the first key of a `g` chord is waiting. */
  .sidebar :global(.nav-count) {
    flex-shrink: 0;
    padding-inline: var(--space-1);
    margin-left: auto;
  }

  /* A label stays on one line and gives way (ellipsis) before the count or the hint do. */
  .sidebar :global(nav a > span:not(.nav-count):not(.visually-hidden)) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar :global(.nav-hint) {
    flex-shrink: 0;
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
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    isolation: isolate;
  }

  /* The ambient light of the page: one soft layer behind the top bar and the page title, anchored to the top right corner.
     It is made of ellipses that reach transparent well inside the layer (--ambient), so no edge of it shows. Decorative only. */
  .column::before {
    position: absolute;
    inset: 0 0 auto;
    z-index: -1;
    height: 360px;
    pointer-events: none;
    content: '';
    background: var(--ambient);
  }

  @media print {
    .column::before {
      display: none;
    }
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

  /* Takes the room between the menu button and the right side; fitCrumbs decides what is shown from its width. */
  .crumbs {
    flex: 1 1 0;
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

  /* The page you are on is kept whole: fitCrumbs drops the others first. It only shrinks when it alone is wider than the bar. */
  .crumbs li[aria-current='page'] {
    flex-shrink: 0;
    max-width: 100%;
    color: var(--ink);
  }

  .crumbs li.crumb-more {
    position: relative;
    flex-shrink: 0;
    overflow: visible;
  }

  .crumb-more-button {
    min-height: 0;
    padding: 0 var(--space-1);
    font: inherit;
    color: inherit;
    letter-spacing: 0.08em;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .crumb-more-button:hover {
    color: var(--ink);
    background: var(--hover, var(--surface-sunken));
  }

  .crumb-menu {
    width: max-content;
    min-width: 10rem;
    max-width: calc(100vw - var(--space-8));
    padding: var(--space-1);
    margin: 0;
    list-style: none;
    white-space: normal;
  }

  .crumb-menu li {
    display: block;
    max-width: none;
    overflow: visible;
  }

  .crumbs .crumb-menu li + li::before {
    content: none;
  }

  .crumbs .crumb-menu a {
    display: block;
    padding: var(--space-2) var(--space-3);
    color: var(--ink);
    border-radius: var(--radius-sm);
  }

  .crumbs .crumb-menu a:hover {
    background: var(--hover, var(--surface-sunken));
    text-decoration: none;
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
