<!--
  TestflightTab: the TestFlight beta feedback and crash reports of one app (docs/api/testflight-feedback.md, docs/adr/0049-testflight-feedback.md),
  a view of the Reviews page ("next to the store reviews"). Apple only: Kiln reads what testers send from TestFlight by "Sync" (and with the
  scheduled review read) into a stored copy, and the team triages it here. Reading never changes App Store Connect; nothing can be deleted there.
  Two lists (Feedback, Crashes), filters (version, build, status, tester), a list with a detail beside it, crash groups by build and by signature,
  and a link to App Store Connect. Screenshots are NOT drawn (the content security policy allows images from this site only): the detail
  offers Apple's short-lived links on request.
  Props: api, workspaceId, role, app, refreshKey (changes when an app sync finished, so this reads again).
-->
<script lang="ts">
  import { can, platformSupports, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { releaseFactsStore } from '../../lib/app-state/release-facts-store.svelte.ts';
  import { formatDateTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import {
    buildLabel,
    type CrashGroups,
    emptyFilters,
    filterOptions,
    type ListFilters,
    listQuery,
    statusBadge,
    syncLine,
    testerLabel,
    testerOptions,
    testflightConsoleUrl,
    TRIAGE_STATUSES,
    statusLabel,
    type TestflightItem,
    type TestflightKind,
    type TestflightListItem,
    type TestflightView,
  } from '../../lib/testflight.ts';
  import type { AppSummary, Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import UpdatedLine from '../app/UpdatedLine.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TestflightDetail from './TestflightDetail.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const uid = $props.id();
  const apple = $derived(platformSupports(app.platform, 'testflightFeedbackApi'));
  const consoleUrl = $derived(apple ? testflightConsoleUrl(app.storeAppId) : null);

  let kind = $state<TestflightKind>('feedback');
  let filters = $state<ListFilters>(emptyFilters());
  let view = $state<TestflightView | null>(null);
  let items = $state<TestflightListItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let problem = $state('');
  let syncProblem = $state('');
  const clock = useNow({ everyMs: 30_000 });
  const now = $derived(clock.value);
  let selectedId = $state('');
  let members = $state<Member[]>([]);
  let groups = $state<CrashGroups | null>(null);
  let groupsProblem = $state('');
  let generation = 0;

  async function load() {
    if (!apple) {
      loading = false;
      return;
    }
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await releaseFactsStore.readTestflight(api, workspaceId, app.id, listQuery({ ...filters, kind }), { force: true });
      if (mine !== generation) return;
      view = read;
      clock.touch();
      items = read.items;
      nextCursor = read.nextCursor;
      if (selectedId !== '' && !read.items.some((i) => i.id === selectedId)) selectedId = '';
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : t('testflight:tab.loadError');
    } finally {
      if (mine === generation) loading = false;
    }
    if (mine === generation && kind === 'crash') void loadGroups(mine);
  }

  async function loadGroups(mine: number) {
    groupsProblem = '';
    try {
      const read = await releaseFactsStore.readTestflightCrashGroups(api, workspaceId, app.id, { force: true });
      if (mine === generation) groups = read;
    } catch (e) {
      if (mine === generation) groupsProblem = e instanceof ApiError ? e.message : t('testflight:groups.loadError');
    }
  }

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    loadingMore = true;
    const mine = generation;
    try {
      const read = await releaseFactsStore.readTestflight(api, workspaceId, app.id, listQuery({ ...filters, kind }, nextCursor), { force: true });
      if (mine !== generation) return;
      items = [...items, ...read.items.filter((i) => !items.some((x) => x.id === i.id))];
      nextCursor = read.nextCursor;
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('testflight:tab.loadError');
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => {
      void load();
      void api
        .members(workspaceId)
        .then((r) => (members = r.members))
        .catch(() => {});
    });
  });

  /** The tab list is bound to `tabValue`; a change of it is a change of kind (the filters belong to a kind, so they start empty). */
  let tabValue = $state<string>('feedback');
  $effect(() => {
    const next: TestflightKind = tabValue === 'crash' ? 'crash' : 'feedback';
    untrack(() => {
      if (next === kind) return;
      kind = next;
      filters = emptyFilters(next);
      selectedId = '';
      void load();
    });
  });

  function changed() {
    selectedId = '';
    void load();
  }

  function clearFilters() {
    filters = emptyFilters(kind);
    changed();
  }


  /** A triage change in the detail: the row follows, and the counts are read again (a page of one row). */
  function onTriaged(item: TestflightItem) {
    items = items.map((i) => (i.id === item.id ? { ...i, status: item.status, assigneeUserId: item.assigneeUserId, hasNote: (item.internalNote ?? '') !== '' } : i));
    void releaseFactsStore
      .readTestflight(api, workspaceId, app.id, `kind=${kind}&limit=1`, { force: true })
      .then((r) => {
        if (view) view = { ...view, counts: r.counts };
      })
      .catch(() => {});
  }

  function showSignature(signature: string | null) {
    if (signature === null) return;
    filters = { ...emptyFilters('crash'), signature };
    changed();
  }

  const counts = $derived(view?.counts);
  const tabs = $derived([
    { id: 'feedback', label: t('testflight:kind.feedback'), ...(counts ? { count: counts.feedback } : {}) },
    { id: 'crash', label: t('testflight:kind.crash'), ...(counts ? { count: counts.crashes } : {}) },
  ]);
  const options = $derived(filterOptions(view?.builds ?? [], kind));
  const testers = $derived(testerOptions(items));
  const hasFilter = $derived(filters.build !== '' || filters.version !== '' || filters.status !== '' || filters.tester !== '' || filters.signature !== '');
  const line = $derived(view ? syncLine(view.sync, now) : null);
  const synced = $derived(view?.sync?.lastSyncedAt != null);
  const total = $derived((counts?.feedback ?? 0) + (counts?.crashes ?? 0));
  const headline = $derived(
    !apple
      ? t('testflight:unsupported.title')
      : view === null
        ? t('testflight:tab.headlineDefault')
        : total === 0
          ? t('testflight:tab.headlineNone')
          : t('testflight:tab.headlineCount', { feedback: counts?.feedback ?? 0, crashes: counts?.crashes ?? 0 }),
  );
</script>

<div class="stack">
  <PageLead {headline} hint={t('testflight:tab.leadHint')}>
    {#snippet aside()}
      <InfoTip label={t('testflight:tab.about')} buttonText={t('testflight:tab.about')} width="26rem">
        <p>{t('testflight:tab.aboutBody')}</p>
        <p>{t('testflight:tab.aboutRequirements')}</p>
        <p>{t('testflight:tab.aboutRetention')}</p>
      </InfoTip>
    {/snippet}
    {#snippet actions()}
      {#if consoleUrl}
        <Button icon="external-link" href={consoleUrl} target="_blank">{t('testflight:tab.openConsole')}</Button>
      {/if}
      {#if apple}
        <UpdatedLine {api} {workspaceId} {role} apps={[app]} kinds={['testflight']} {refreshKey} />
      {/if}
    {/snippet}
  </PageLead>

  {#if !apple}
    <Alert tone="info" title={t('testflight:unsupported.title')}>{t('testflight:unsupported.body')}</Alert>
  {:else}
    {#if syncProblem !== ''}<Alert tone="error" title={t('testflight:tab.syncFailedTitle')}>{syncProblem}</Alert>{/if}

    {#if loading && !view}
      <div role="status" aria-label={t('testflight:tab.reading')} class="stack">
        <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
      </div>
    {:else if problem !== '' && !view}
      <Alert tone="error" title={t('testflight:tab.loadErrorTitle')}>
        {problem}
        <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>{t('common:action.tryAgain')}</Button></div>
      </Alert>
    {:else if view}
      {#if line && view.sync !== null}
        <p class="sync-line text-sm" class:bad={line.tone === 'bad'} class:warn={line.tone === 'warn'} role={line.tone === 'bad' ? 'alert' : 'status'}>{line.text}</p>
      {/if}
      {#if view.sync && view.sync.warnings.length > 0}
        <Alert tone="warn" title={t('testflight:tab.partsTitle')}>
          <ul class="warnings">{#each view.sync.warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
        </Alert>
      {/if}
      <Alert tone="info" title={t('testflight:console.title')}>{t('testflight:console.body')}</Alert>

      <div class="row">
        <SegmentTabs {tabs} bind:value={tabValue} label={t('testflight:tab.kinds')} idPrefix="{uid}-kind" />
      </div>

      {@const ids = segmentIds(`${uid}-kind`, kind)}
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} class="stack">
      <div class="filters row" role="group" aria-label={t('testflight:filter.label')}>
        <div class="field">
          <label for="{uid}-version">{t('testflight:filter.version')}</label>
          <select id="{uid}-version" bind:value={filters.version} onchange={changed}>
            <option value="">{t('testflight:filter.all')}</option>
            {#each options.versions as v (v)}<option value={v}>{v}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label for="{uid}-build">{t('testflight:filter.build')}</label>
          <select id="{uid}-build" bind:value={filters.build} onchange={changed}>
            <option value="">{t('testflight:filter.all')}</option>
            {#each options.builds as b (b.value)}<option value={b.value}>{b.label}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label for="{uid}-status">{t('testflight:filter.status')}</label>
          <select id="{uid}-status" bind:value={filters.status} onchange={changed}>
            <option value="">{t('testflight:filter.all')}</option>
            <option value="new,seen,in_progress">{t('testflight:filter.open')}</option>
            {#each TRIAGE_STATUSES as s (s)}<option value={s}>{statusLabel(s)}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label for="{uid}-tester">{t('testflight:filter.tester')}</label>
          <select id="{uid}-tester" bind:value={filters.tester} onchange={changed}>
            <option value="">{t('testflight:filter.all')}</option>
            {#each testers as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </div>
        {#if hasFilter}<Button size="sm" variant="ghost" onclick={clearFilters}>{t('testflight:filter.clear')}</Button>{/if}
      </div>
      {#if filters.signature !== ''}<p class="muted text-sm">{t('testflight:filter.signature')}: <span class="mono">{filters.signature}</span></p>{/if}

      {#if kind === 'crash' && groups}
        <Disclosure summary={t('testflight:groups.heading')} stateKey="testflight-groups-{app.id}">
          <div class="groups">
            <div>
              <h4 class="heading">{t('testflight:groups.byBuild')}</h4>
              <ul class="plain">
                {#each groups.byBuild as g (`${g.buildNumber}|${g.version}`)}
                  <li class="row between"><span>{buildLabel(g.buildNumber, g.version)}</span><span class="muted">{t('testflight:groups.count', { count: g.count })}</span></li>
                {/each}
              </ul>
            </div>
            <div>
              <h4 class="heading">{t('testflight:groups.bySignature')}</h4>
              <ul class="plain">
                {#each groups.bySignature as g (g.signature ?? '')}
                  <li class="group">
                    <div class="row between">
                      <span class="mono sig">{g.signature ?? t('testflight:groups.unknown')}</span>
                      <span class="muted">{t('testflight:groups.count', { count: g.count })} · {t('testflight:groups.open', { count: g.open })}</span>
                    </div>
                    <div class="row text-sm muted">
                      <span>{t('testflight:groups.builds', { builds: g.builds.map((b) => b ?? '?').join(', ') })}</span>
                      {#if g.signature !== null}<Button size="sm" variant="ghost" onclick={() => showSignature(g.signature)}>{t('testflight:groups.show')}</Button>{/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          </div>
        </Disclosure>
      {:else if kind === 'crash' && groupsProblem !== ''}
        <p class="muted text-sm">{groupsProblem}</p>
      {/if}

      {#if items.length === 0}
        <EmptyState
          icon="message"
          title={!synced && !hasFilter ? t('testflight:empty.neverTitle') : kind === 'crash' ? t('testflight:empty.crashTitle') : t('testflight:empty.feedbackTitle')}
          description={!synced && !hasFilter ? t('testflight:empty.neverDescription') : kind === 'crash' ? t('testflight:empty.crashDescription') : t('testflight:empty.feedbackDescription')}
        >
          {#snippet actions()}
            <UpdatedLine {api} {workspaceId} {role} apps={[app]} kinds={['testflight']} {refreshKey} />
          {/snippet}
        </EmptyState>
      {:else}
        <div class="split" class:with-detail={selectedId !== ''}>
          <div class="table-wrap card flush">
            <table aria-label={t('testflight:tab.listLabel', { kind: kind === 'crash' ? t('testflight:kind.crash') : t('testflight:kind.feedback'), app: app.name })}>
              <thead>
                <tr>
                  <th scope="col">{t('testflight:list.colSent')}</th>
                  <th scope="col">{t('testflight:list.colBuild')}</th>
                  <th scope="col">{t('testflight:list.colTester')}</th>
                  <th scope="col">{t('testflight:list.colComment')}</th>
                  <th scope="col">{t('testflight:list.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {#each items as i (i.id)}
                  {@const badge = statusBadge(i.status)}
                  <tr class:selected={i.id === selectedId}>
                    <td class="muted text-sm nowrap">{formatDateTime(i.createdAt)}</td>
                    <td class="text-sm">{buildLabel(i.buildNumber, i.version)}</td>
                    <td class="text-sm">{testerLabel(i)}</td>
                    <td>
                      <button type="button" class="open" aria-pressed={i.id === selectedId} onclick={() => (selectedId = i.id === selectedId ? '' : i.id)}>
                        {#if i.comment !== ''}{i.comment}{#if i.commentTruncated}…{/if}{:else}<span class="muted">{t('testflight:list.noComment')}</span>{/if}
                      </button>
                      {#if i.kind === 'crash' && i.signature}<div class="muted text-sm mono sig">{i.signature}</div>{/if}
                      {#if i.screenshotCount > 0}<div class="muted text-sm">{t('testflight:list.screenshots', { count: i.screenshotCount })}</div>{/if}
                    </td>
                    <td><Badge tone={badge.tone} dot>{badge.label}</Badge></td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if nextCursor !== null}
              <div class="more"><Button size="sm" loading={loadingMore} onclick={() => void loadMore()}>{t('testflight:list.more')}</Button></div>
            {/if}
          </div>
          {#if selectedId !== ''}
            {#key selectedId}
              <TestflightDetail {api} {workspaceId} {role} appId={app.id} id={selectedId} {members} {consoleUrl} onclose={() => (selectedId = '')} ontriaged={onTriaged} />
            {/key}
          {/if}
        </div>
      {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .sync-line {
    margin: 0;
    color: var(--muted);
  }

  .sync-line.bad {
    color: var(--bad-ink);
  }

  .sync-line.warn {
    color: var(--warn-ink);
  }

  .heading {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .warnings,
  .plain {
    margin: 0;
    padding-left: var(--space-4);
  }

  .plain {
    padding-left: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .filters {
    align-items: flex-end;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .groups {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .between {
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }

  .sig {
    overflow-wrap: anywhere;
  }

  .split {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  @media (min-width: 64rem) {
    .split.with-detail {
      grid-template-columns: minmax(0, 1fr) minmax(0, 28rem);
    }
  }

  .nowrap {
    white-space: nowrap;
  }

  .open {
    all: unset;
    cursor: pointer;
    display: block;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .open:hover {
    text-decoration: underline;
  }

  .open:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  tr.selected {
    background: var(--surface-active);
  }

  .more {
    padding: var(--space-3);
    display: flex;
    justify-content: center;
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
