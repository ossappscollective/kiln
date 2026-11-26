<!--
  AppShell: an open app. Everything below the workspace is scoped to it: one slim header, then the page the address names (the
  left panel is AppNav, drawn by the shell). The header is the name of the page and the app, the platform control (only for an app
  on several platforms, and not on the settings page), the version and locale pickers on the pages they apply to (Releases and Store
  listing, AppHeaderRow) and a small Status button (StatusPopover) that holds the store chips, the bundle ids, the last sync and
  what each source last read. The page's Sync (SyncButton, split: this page's sources, or more from its menu) sits beside it. While the app has changes waiting, a button in the top bar (next to the account menu) shows how many and opens the pending cart (PendingCart, PendingCartButton).
  The records of the two stores that are one product are shown as one app (lib/app-groups.ts).
  Props: api, workspaceId, role, id (an id of one of its platform records, from the address).
  The page, its view (`?view=`: Store listing text or graphics, Insights analytics or ASO, Builds builds, workflows or test builds),
  the open release and the platform scope all come from the address. An old address (assets, aso, analytics, workflows, test-builds)
  is replaced by its new one (lib/app-nav.ts `canonicalAppHash`) and reads as the new page at once.
  The versions come from the releases already loaded here. When the selected version is live (or in review where the store forbids
  edits) a slim banner says so and the listing and graphics are read-only (lockedPlatforms).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { type Action, can, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, appContext, replaceHash, setPlatformScope } from '../../lib/address.svelte.ts';
  import {
    buildVersionOptions,
    headerParams,
    lockInfo,
    lockableSections,
    noLock,
    pickersFor,
    resolveVersion,
    withHeaderParams,
  } from '../../lib/app-header.ts';
  import { asoViewFromHash } from '../../lib/aso/aso.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { tint } from '../../lib/tint/store.svelte.ts';
  import { dataChips } from '../../lib/app-chips.ts';
  import { canonicalAppHash, canonicalSection, pageTitle, resolveView, showsScope, viewsFor } from '../../lib/app-nav.ts';
  import { PUBLISHED_EVENT } from '../../lib/app-page.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { batchAppIds, onStagedChanged } from '../../lib/staged-sync.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { type AppGroup, groupApps, groupOf } from '../../lib/app-groups.ts';
  import { type AppSection, appAddress, resolveScope, visibleSections } from '../../lib/app-scope.ts';
  import { appLabel, describeError, portfolioHref, syncApp, syncSummaryText } from '../../lib/portfolio.ts';
  import { syncRest } from '../../lib/sync-all.ts';
  import type { SyncTarget } from '../../lib/sync-plan.ts';
  import { syncRun } from '../../lib/sync-run.svelte.ts';
  import { runsOfApps } from '../../lib/sync-scope.ts';
  import { runActive } from '../../lib/sync-sources.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AppHeaderRow from './AppHeaderRow.svelte';
  import AppSectionView from './AppSection.svelte';
  import PendingCart from './PendingCart.svelte';
  import StatusPopover from './StatusPopover.svelte';
  import SyncButton from './SyncButton.svelte';
  import LockedBanner from './LockedBanner.svelte';
  import ScopeControl from './ScopeControl.svelte';

  let { api, workspaceId, role, id }: { api: Api; workspaceId: string; role: Role; id: string } = $props();
  /** The app tint (docs/adr/0068-app-tint.md): re-maps the accent tokens inside this page only. Empty: no tint. */
  const tintStyle = $derived(tint.style(id));

  const canSync = $derived(can(role, 'apps.sync'));

  let group = $state<AppGroup | null>(null);
  /** The records as last loaded or synced, and their releases, by app id. */
  let records = $state<Record<string, AppSummary | undefined>>({});
  let releases = $state<Record<string, ReleaseSummary[] | undefined>>({});
  let loading = $state(true);
  let loadError = $state<{ message: string; notFound: boolean } | null>(null);
  let syncing = $state<Record<string, boolean | undefined>>({});
  let syncRuns = $state(0);
  let now = $state(Date.now());
  let generation = 0;
  let loadedFor = '';

  const members = $derived(group ? group.members.map((m) => records[m.id] ?? m) : []);
  const resolved = $derived(resolveScope(address.platform, members.map((m) => m.platform)));
  const scoped = $derived(members.filter((m) => resolved.platforms.includes(m.platform)));
  const chips = $derived(dataChips(scoped, now));
  const releaseLists = $derived(
    members.reduce<Record<string, ReleaseSummary[]>>((acc, m) => {
      acc[m.id] = releases[m.id] ?? [];
      return acc;
    }, {}),
  );
  const open = $derived(address.app);
  const allowed = (a: Action) => can(role, a);
  /** The address as the new page reads it: an old address (assets, aso, ...) is replaced below, and meanwhile reads as its new page. */
  const hash = $derived(canonicalAppHash(address.hash) ?? address.hash);
  /** The page the address names (an old page as the page that replaced it), or the overview when the role may not open it. */
  const section = $derived<AppSection>(open && visibleSections(allowed).some((s) => s.id === canonicalSection(open.section)) ? canonicalSection(open.section) : 'dashboard');
  const androidInScope = $derived(scoped.some((m) => supports(m.platform, 'searchTermsImport')));
  const appleInScope = $derived(scoped.some((m) => supports(m.platform, 'testflightFeedbackApi')));
  const views = $derived(viewsFor(section, allowed, { androidInScope, appleInScope }));
  const view = $derived(resolveView(section, hash, allowed, { androidInScope, appleInScope }));
  const anySyncing = $derived(scoped.some((m) => syncing[m.id] === true) || runActive(runsOfApps(syncRun.runs, members.map((m) => m.id))));
  // The state model's view of the open app (docs/state-model.md): the top bar button reads it, scoped like this page. The Next step card, the
  // pending panels and every action read the same model through `appStateStore`; this page works out no pending count of its own.
  $effect(() => {
    appStateStore.setOpenApp({ workspaceId, role, records: members, scope: resolved.scope, onPendingPage: section === 'pending' });
    return () => appStateStore.setOpenApp(null);
  });
  const scopeShown = $derived(showsScope(section, members.length));

  // The header row of a versioned page: its pickers, from data already loaded here and by the pages.
  const picker = $derived(pickersFor(section, { asoView: asoViewFromHash(hash), releaseOpen: open?.release != null }));
  const params = $derived(headerParams(hash));
  const scopedReleases = $derived(scoped.reduce<ReleaseSummary[]>((all, m) => all.concat(releaseLists[m.id] ?? []), []));
  const versionOptions = $derived(buildVersionOptions(scopedReleases, resolved.platforms));
  const version = $derived(resolveVersion(params.version, versionOptions));
  const localeList = $derived.by(() => {
    const read = navSignals.localesOf(workspaceId, members.map((m) => m.id));
    // A locale in the address that no page has read yet stays visible, so the row does not lie about the page.
    return params.locale !== null && read.indexOf(params.locale) < 0 ? [params.locale, ...read] : read;
  });
  const lock = $derived(lockableSections.indexOf(section) >= 0 ? lockInfo(scopedReleases, version, resolved.platforms, { fallbackToNewest: params.version !== version }) : noLock);
  const setVersion = (next: string) => replaceHash(withHeaderParams(location.hash, { version: next }));
  const setLocale = (next: string | null) => replaceHash(withHeaderParams(location.hash, { locale: next }));

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = null;
    try {
      const list = (await api.apps(workspaceId)).apps;
      navSignals.setApps(workspaceId, list);
      const found = groupOf(groupApps(list), id);
      if (mine !== generation) return;
      if (!found) {
        group = null;
        loadError = { message: '', notFound: true };
        return;
      }
      const details = await Promise.all(found.members.map((m) => api.app(workspaceId, m.id)));
      if (mine !== generation) return;
      const nextRecords: Record<string, AppSummary> = {};
      const nextReleases: Record<string, ReleaseSummary[]> = {};
      for (const d of details) {
        nextRecords[d.app.id] = d.app;
        nextReleases[d.app.id] = d.releases;
      }
      records = nextRecords;
      releases = nextReleases;
      group = found;
      appContext.name = found.name;
    } catch (e) {
      if (mine !== generation) return;
      group = null;
      loadError = { message: describeError(e, 'load'), notFound: false };
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // The left panel shows the status of each platform from the releases loaded here.
  $effect(() => {
    const space = workspaceId;
    for (const [appId, list] of Object.entries(releases)) {
      if (list) untrack(() => navSignals.setReleases(space, appId, list));
    }
  });

  // Load when the app changes. Moving to the other platform record of the same app keeps what is shown.
  $effect(() => {
    const space = workspaceId;
    const wanted = id;
    untrack(() => {
      if (space === loadedFor && group && group.members.some((m) => m.id === wanted)) return;
      loadedFor = space;
      group = null;
      records = {};
      releases = {};
      syncing = {};
      // The run of the app left behind is not this app's: no busy Sync, no progress, no failed source carried over.
      syncRun.clear();
      appContext.name = '';
      void load();
    });
  });

  // An old address (workflows, assets, aso, ...) is replaced by the address of the page that holds it now; the history keeps one entry.
  $effect(() => {
    const target = canonicalAppHash(address.hash);
    if (target !== null) replaceHash(target);
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => {
      clearInterval(timer);
      appContext.name = '';
    };
  });

  async function sync(app: AppSummary) {
    if (syncing[app.id]) return;
    const mine = generation;
    syncing[app.id] = true;
    const outcome = await syncApp(api, workspaceId, app.id);
    if (mine !== generation) return;
    syncing[app.id] = false;
    now = Date.now();
    syncRuns += 1;
    if (outcome.ok) {
      records[app.id] = outcome.app;
      releases[app.id] = outcome.releases;
      toast.success(syncSummaryText(appLabel(outcome.app), outcome.sync));
    } else {
      // A failed sync is stored on the app, so the server sends the app back with the new message.
      if (outcome.app) records[app.id] = outcome.app;
      toast.error(`${appLabel(app)}: ${outcome.failure.message}`);
    }
  }

  /**
   * The page's Sync (docs/ux-ia.md "Sync is per page"): `targets` is what the SyncButton planned (the page's failed or not fresh sources, one kind
   * from its menu, or only the failed ones); `everything` reads every source of every record in scope. The store listing runs directly, so the
   * releases are on screen when it ends; the rest goes through the server's queue (critical first, only the kinds asked for) and the two kinds
   * without a queue (lib/sync-all.ts). Progress per source is in the Status popover (SyncSources); pages say "Updated X ago".
   */
  async function syncTargets(targets: SyncTarget[], everything: boolean) {
    if (anySyncing) return;
    const mine = generation;
    const list = scoped.filter((m) => everything || targets.some((x) => x.appId === m.id));
    const kindsOf = (app: AppSummary) => targets.filter((x) => x.appId === app.id);
    for (const app of list) {
      if (!everything && !kindsOf(app).some((x) => x.kind === 'app')) continue;
      syncRun.set(app.id, 'app', 'running');
      await sync(app);
      if (mine !== generation) return;
      syncRun.set(app.id, 'app', records[app.id]?.lastSyncError ? 'failed' : 'done');
    }
    let problem: string | null = null;
    let queued = false;
    for (const app of list) {
      const mineTargets = kindsOf(app).filter((x) => x.kind !== 'app');
      if (!everything && mineTargets.length === 0) continue;
      const sources = mineTargets.find((x) => x.kind === 'analytics')?.sources;
      const rest = await syncRest(api, workspaceId, app, role, (kind, state) => (mine === generation ? syncRun.set(app.id, kind, state) : undefined), everything ? undefined : { kinds: mineTargets.map((x) => x.kind), sources });
      if (mine !== generation) return;
      syncRun.plan(app.id, rest.plan, rest.extra);
      queued = queued || rest.plan.some((p) => p.state === 'queued');
      problem = problem ?? rest.problem;
    }
    if (mine !== generation) return;
    if (problem) toast.error(t('app:sync.problem', { message: problem }));
    // The queue works in the background: wait (at most a minute and a half) until this app has no feed being read and no job waiting.
    for (let i = 0; queued && i < 36 && mine === generation; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const activity = await api.syncActivity(workspaceId).catch(() => null);
      if (activity === null || (activity.queued === 0 && !activity.apps.some((a) => list.some((m) => m.id === a.id)))) break;
    }
    if (mine !== generation) return;
    syncRun.settle();
    now = Date.now();
    syncRuns += 1;
  }

  // Something was published from this app's "Review and publish all": read the store again and show the releases (where the new state is).
  // The ONE listener of staged state (lib/staged-sync.ts): a stage, unstage, discard or publish anywhere (the cart, the listing, the graphics
  // tab, a release page) makes this read the staged and pending state of those apps again; every screen reads the same stores.
  $effect(() => {
    const mine = () => members.map((m) => m.id);
    const batch = batchAppIds((appIds) => {
      const known = mine();
      const ids = appIds.filter((a) => known.includes(a));
      if (ids.length > 0) void pendingStore.refresh(api, workspaceId, ids, { submit: canSubmit(role) });
    });
    const off = onStagedChanged((d) => batch.add(d.appId));
    return () => {
      off();
      batch.cancel();
    };
  });

  $effect(() => {
    const onPublished = (event: Event) => {
      const appId = (event as CustomEvent<{ appId?: string }>).detail?.appId;
      const published = members.find((m) => m.id === appId);
      if (appId === undefined || published === undefined) return;
      // The record that was published (it may be the other platform than the page shows): read its store again, then the pending
      // lists of every record of the app, so no stale "draft to publish" is left on either.
      window.location.hash = appAddress(id, 'releases', scoped.includes(published) ? address.platform : published.platform);
      void sync(published).then(() => pendingStore.refresh(api, workspaceId, members.map((m) => m.id), { submit: canSubmit(role) }));
    };
    window.addEventListener(PUBLISHED_EVENT, onPublished);
    return () => window.removeEventListener(PUBLISHED_EVENT, onPublished);
  });
</script>

<section aria-busy={loading} data-app-tint={tintStyle ? '' : undefined} style={tintStyle || undefined}>
  {#if loading && !group}
    <div role="status" aria-label={t('app:shell.loading')}>
      <div class="skeleton-head"><Skeleton width="240px" height="28px" /><Skeleton width="160px" height="16px" /></div>
      <div class="card"><div class="stack"><Skeleton width="60%" height="16px" /><Skeleton width="40%" height="16px" /></div></div>
    </div>
  {:else if loadError}
    {#if loadError.notFound}
      <div class="card">
        <EmptyState icon="box" title={t('app:shell.notFound')} description={t('app:shell.notFoundHelp')}>
          {#snippet actions()}<Button href={portfolioHref} variant="primary">{t('app:shell.backToApps')}</Button>{/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="stack">
        <Alert tone="error" title={t('app:shell.loadFailed')}>{loadError.message}</Alert>
        <div class="row">
          <Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button>
          <Button href={portfolioHref} variant="ghost">{t('app:shell.backToApps')}</Button>
        </div>
      </div>
    {/if}
  {:else if group}
    <header class="head">
      <div class="id">
        <AppIcon
          name={group.name}
          url={members.map((m) => m.iconUrl ?? null).find((u) => u) ?? null}
          platform={members.length === 1 ? members[0]?.platform : undefined}
          seed={group.key}
          size="md"
        />
        <div class="titles">
          <h1 class="page-title">{pageTitle(section)}</h1>
          <p class="appname" title={group.name}>
            <span class="name">{group.name}</span>
            <span class="ident" aria-hidden="true">{members.map((m) => m.identifier).filter((v, i, all) => all.indexOf(v) === i).join(' · ')}</span>
          </p>
        </div>
      </div>
      <div class="tools">
        {#if picker}
          <AppHeaderRow
            scopeOptions={resolved.options}
            scope={resolved.scope}
            onscope={setPlatformScope}
            showScope={scopeShown}
            versions={versionOptions}
            {version}
            onversion={setVersion}
            showVersion={picker.version}
            locales={localeList}
            locale={params.locale}
            onlocale={setLocale}
            showLocale={picker.locale}
          />
        {:else if scopeShown}
          <ScopeControl options={resolved.options} scope={resolved.scope} onchange={setPlatformScope} />
        {/if}
        {#if canSync}
          <SyncButton {api} {workspaceId} {role} members={scoped} {section} {view} {now} busy={anySyncing} refreshKey={syncRuns} onrun={syncTargets} />
        {/if}
        <StatusPopover {api} {workspaceId} {role} {members} {chips} {now} syncing={anySyncing} {syncRuns} settingsHref={appAddress(id, 'settings', address.platform)} />
        {#if section !== 'settings'}
          <Button href={appAddress(id, 'settings', address.platform)} variant="ghost" icon="settings" iconOnly label={t('app:title.settings')} />
        {/if}
      </div>
    </header>


    {#if lock.text !== ''}
      <LockedBanner text={lock.text} href={appAddress(id, 'releases', address.platform)} />
    {/if}

    <div class="body">
      <AppSectionView
        {api}
        {workspaceId}
        {role}
        {section}
        {view}
        {views}
        members={scoped}
        all={members}
        openId={id}
        version={open?.release ?? null}
        releases={releaseLists}
        {now}
        {syncRuns}
        {syncing}
        lockedPlatforms={lock.locked}
        locale={params.locale}
      />
    </div>
  {/if}
  <PendingCart {api} {workspaceId} {role} groupId={id} members={scoped} platform={address.platform} />
</section>

<style>
  .skeleton-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-5);
  }

  .id {
    display: flex;
    flex: 1;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    min-width: 12rem;
  }

  /* The icon surround: a ring in the app's accent (a shadow, so nothing moves). --app-accent only exists inside a tinted subtree; without it the ring is transparent. */
  .id :global(.app-icon) {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--app-accent, transparent);
  }

  .titles {
    min-width: 0;
  }

  .page-title {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: 1.2;
  }

  .appname {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-3);
    min-width: 0;
    margin: 2px 0 0;
    color: var(--muted);
  }

  .appname .name {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .appname .ident {
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-left: auto;
  }
</style>
