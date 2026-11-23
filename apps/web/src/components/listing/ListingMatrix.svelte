<!--
  ListingMatrix: the store listing of an app as a locale grid. Rows are locales, columns are listing
  fields, and each cell is a status dot per platform in scope: in sync, differs from the repository,
  differs from the store, diverged, missing, or over the limit. One click on a chip filters the
  locales (needs attention, missing only, over limit); a click on a locale opens its drawer with the
  full comparison of each field. The platform scope (iOS, macOS, Android or all) comes from the shell; with
  several, one grid merges the stores and the header shows a platform badge per column.
  Read-only toward the store: reading the store again is "Sync now" in the Status popover of the header (this page only points to it).
  The one
  thing it can write toward the repository is a draft change set ("Pull into repository", the existing
  PullDialog), which a person reviews in the repository. "Stage from repo" (in the locale drawer) collects a
  field's repository text in the staged-changes tray (our own database); a cell with a staged text shows a
  mark. The tray pushes staged changes to a store's DRAFT (a gated store write, admin and up) and never submits.
  Props: api, workspaceId, role, members (the platform records in scope), now (ms), syncing (by app
  id), refreshKey (changes when a sync
  finished, so this tab reloads), lockedPlatforms? (platforms whose selected version is live or in review: their
  fields are read-only, with no stage control and no staged-changes tray), locale? (the locale of the page header:
  naming one the grid has opens its drawer; stepping to another locale there tells onlocale), onlocale?.
  `panel` / `onpanel`: the locale whose drawer the address asks to open (`?panel=`), written by a click and removed on close; tab links drop it.
  Every cell whose field can be edited has a pencil ("Edit title, en-US"): it opens the field editor (FieldEditor) on that field and locale, with
  a live counter against the store's limit, the text before and after, "Suggest with AI" and "Stage". The same editor opens from "Edit" on
  each field of the locale drawer. Staging saves the text in our own database; nothing reaches a store from here.
  The locales read here are handed to the header picker (lib/nav-signals.svelte.ts).
-->
<script lang="ts">
  import { type Platform, type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import type { AsoKeyword } from '../../lib/aso/aso.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { openStatusPopover } from '../../lib/app-page.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { shortRef } from '../../lib/listing/drift.ts';
  import {
    LEGEND_ORDER,
    MODE_LABELS,
    MODE_ORDER,
    type CellStatus,
    type MatrixFilter,
    buildMatrix,
    cellInfo,
    cellMatchesMode,
    cellText,
    cellsSummary,
    columnScopeNote,
    defaultMatrixFilter,
    filterRows,
    limitText,
    listingContext,
    listingStatusLine,
    matrixSummary,
    modeCounts,
    type MatrixCell,
  } from '../../lib/listing/matrix.ts';
  import { fieldInfo } from '../../lib/listing/edit.ts';
  import { pullDisabledReason, pullableFields, summarizePull } from '../../lib/listing/pull.ts';
  import { warningCountOf, warningGroups } from '../../lib/listing/warnings.ts';
  import { describeError, platformLabel, storeName } from '../../lib/portfolio.ts';
  import { requestChangeSetReview, reviewHref } from '../../lib/repository-intent.ts';
  import { cellStagedText, stagingError as stagingMessage } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { platformById } from '../../lib/stores.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, DriftField, ListingDrift, LiveListing, PullResult } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Section from '../ui/Section.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import T from '../ui/T.svelte';
  import FieldEditor from './FieldEditor.svelte';
  import HistoryDrawer from './HistoryDrawer.svelte';
  import ListingSections from './ListingSections.svelte';
  import LocaleDrawer from './LocaleDrawer.svelte';
  import PullDialog from './PullDialog.svelte';
  import PullResultSummary from './PullResultSummary.svelte';
  import StagedTray from './StagedTray.svelte';
  import StatusDot from './StatusDot.svelte';
  import { summaryLine } from '../../lib/section-state.ts';
  import FilterChip from '../ui/FilterChip.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
    syncing,
    refreshKey,
    lockedPlatforms = [],
    locale = null,
    onlocale,
    panel = null,
    onpanel,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    now: number;
    syncing: Record<string, boolean | undefined>;
    refreshKey: number;
    lockedPlatforms?: Platform[] | undefined;
    locale?: string | null | undefined;
    onlocale?: ((locale: string) => void) | undefined;
    panel?: string | null | undefined;
    onpanel?: ((locale: string | null) => void) | undefined;
  } = $props();

  const canSync = $derived(can(role, 'apps.sync'));
  const readable = $derived(members.filter((m) => can(role, 'repositories.scan') && m.repositoryId !== null));
  const anySyncing = $derived(members.some((m) => syncing[m.id] === true));

  type View = { drift: ListingDrift | null; live: LiveListing | null; loading: boolean; reloading: boolean; problem: string };
  const blank = (): View => ({ drift: null, live: null, loading: true, reloading: false, problem: '' });

  let views = $state<Record<string, View | undefined>>({});
  let filter = $state<MatrixFilter>(defaultMatrixFilter());
  let repoReading = $state(false);
  let announcement = $state('');
  let lastPull = $state<PullResult | null>(null);
  let warningsOpen = $state(false);
  let moreOpen = $state(false);

  let drawerOpen = $state(false);
  let drawerLocale = $state<string | null>(null);

  let pullOpen = $state(false);
  let pullApp = $state<AppSummary | null>(null);
  let pullFieldsList = $state<DriftField[]>([]);

  let editOpen = $state(false);
  let editTarget = $state<{ app: AppSummary; locale: string; field: string; current: string } | null>(null);

  /** Opens the field editor on one field of one locale, with the text the store has now. */
  function openEditor(app: AppSummary, field: DriftField) {
    editTarget = { app, locale: field.locale, field: field.field, current: field.live.value ?? field.db.value ?? '' };
    editOpen = true;
  }

  /** The field of a cell that the editor can edit on a platform that is not locked, else null. */
  const editableField = (cell: MatrixCell): DriftField | null =>
    cell.field !== null && lockedPlatforms.indexOf(cell.platform) < 0 && fieldInfo(cell.platform, cell.field.field) !== null ? cell.field : null;

  /** The field being staged or unstaged: `<app id>\u0000<locale>\u0000<field>`, or ''. One at a time. */
  let stagingKey = $state('');

  let historyOpen = $state(false);
  let historyApp = $state<AppSummary | null>(null);
  let historyTarget = $state<{
    locale: string;
    field: string;
    label: string;
    limit: number | null;
    unit: 'characters' | 'bytes';
  } | null>(null);

  /** One counter per app, so a late answer for an earlier load of that app is dropped. */
  const generations: Record<string, number> = {};

  async function load(app: AppSummary) {
    const mine = (generations[app.id] = (generations[app.id] ?? 0) + 1);
    const before = views[app.id] ?? blank();
    views[app.id] = { ...before, loading: before.drift === null, reloading: before.drift !== null, problem: '' };
    try {
      const [drift, live] = await Promise.all([
        api.appListingDrift(workspaceId, app.id),
        api.appListingLive(workspaceId, app.id).catch(() => null),
      ]);
      if (mine !== generations[app.id]) return;
      views[app.id] = { drift, live: live ?? before.live, loading: false, reloading: false, problem: '' };
      announcement = t('listing:matrixView.compared', { platform: platformLabel(app.platform) });
    } catch (e) {
      if (mine !== generations[app.id]) return;
      const current = views[app.id] ?? before;
      views[app.id] = { ...current, loading: false, reloading: false, problem: describeError(e, 'load') };
    }
  }

  /** The tracked ASO keywords by app, for the keyword budget in the locale drawer. Best effort: a role without ASO reads none. */
  let asoKeywords = $state<Record<string, AsoKeyword[] | undefined>>({});
  const canReadAso = $derived(can(role, 'aso.read'));

  async function loadAso(app: AppSummary) {
    if (!canReadAso) return;
    try {
      const list = await api.asoKeywords(workspaceId, app.id);
      asoKeywords[app.id] = list.keywords;
    } catch {
      asoKeywords[app.id] = undefined;
    }
  }

  const reloadAll = () => {
    for (const app of members) {
      void load(app);
      void loadAso(app);
      void stagedStore.load(api, workspaceId, app.id);
    }
  };

  // A different app, scope or workspace starts clean; a finished sync loads again. The key is a
  // string, so a refreshed app record (a new object) does not reload the grid.
  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    void refreshKey;
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        views = {};
        asoKeywords = {};
        filter = defaultMatrixFilter();
        drawerOpen = false;
        drawerLocale = null;
        pullOpen = false;
        historyOpen = false;
        lastPull = null;
      }
      reloadAll();
    });
  });

  const matrix = $derived(buildMatrix(members.map((m) => ({ platform: m.platform, drift: views[m.id]?.drift ?? null }))));
  const shown = $derived(matrix.platforms);
  const both = $derived(shown.length > 1);
  const counts = $derived(modeCounts(matrix.rows));
  const line = $derived(listingStatusLine(matrix.rows));
  const rows = $derived(filterRows(matrix.rows, filter));
  const filtering = $derived(filter.mode !== 'all' || filter.query.trim() !== '');
  const loading = $derived(members.some((m) => views[m.id] === undefined || (views[m.id]?.loading === true && views[m.id]?.drift === null)));
  const failed = $derived(members.filter((m) => views[m.id]?.drift === null && (views[m.id]?.problem ?? '') !== ''));
  const nothingLoaded = $derived(members.every((m) => (views[m.id]?.drift ?? null) === null));
  const hasRows = $derived(!nothingLoaded && matrix.rows.length > 0);
  const warningGroupList = $derived(
    warningGroups(
      members.map((m) => {
        const drift = views[m.id]?.drift ?? null;
        return {
          appId: m.id,
          platform: platformLabel(m.platform),
          storeError: drift?.store.error ?? null,
          warnings: views[m.id]?.live?.warnings,
          repoError: drift && m.repositoryId !== null ? (drift.repo.error ?? null) : null,
        };
      }),
    ),
  );
  const warningCount = $derived(warningCountOf(warningGroupList));
  const channels = $derived(
    members.reduce<Partial<Record<Platform, 'live' | 'editable' | null>>>((acc, m) => {
      acc[m.platform] = views[m.id]?.drift?.channel ?? null;
      return acc;
    }, {}),
  );

  const pullReason = (app: AppSummary): string | null =>
    pullDisabledReason({ role, repositoryId: app.repositoryId, storeRead: (views[app.id]?.drift?.store.readAt ?? null) !== null });
  const pullReasons = $derived(
    members.reduce<Partial<Record<Platform, string | null>>>((acc, m) => {
      acc[m.platform] = pullReason(m);
      return acc;
    }, {}),
  );
  const pullables = $derived(
    members.map((app) => ({
      app,
      fields: pullableFields(views[app.id]?.drift?.locales ?? []),
      reason: pullReasons[app.platform] ?? null,
    })),
  );
  const anyPullable = $derived(pullables.some((p) => p.fields.length > 0));
  const pullBlocked = $derived(pullables.length > 0 && pullables.every((p) => p.reason !== null) ? (pullables[0]?.reason ?? null) : null);

  const drawerRow = $derived(drawerLocale === null ? null : (rows.find((r) => r.locale === drawerLocale) ?? matrix.rows.find((r) => r.locale === drawerLocale) ?? null));
  const drawerIndex = $derived(drawerLocale === null ? 0 : Math.max(0, rows.findIndex((r) => r.locale === drawerLocale)));

  function openLocale(locale: string) {
    drawerLocale = locale;
    drawerOpen = true;
    onpanel?.(locale);
  }

  function step(delta: -1 | 1) {
    const next = rows[drawerIndex + delta];
    if (next) {
      drawerLocale = next.locale;
      onpanel?.(next.locale);
      onlocale?.(next.locale);
    }
  }

  // The locales read here are what the header picker offers.
  $effect(() => {
    for (const m of members) {
      const read = views[m.id]?.drift;
      if (read) navSignals.setLocales(workspaceId, m.id, read.locales.map((l) => l.locale));
    }
  });

  // The drawer is driven by the address (`?panel=fr-FR`): a click writes it (openLocale), a deliberate deep link brings it, and no other
  // navigation carries it, so coming back to this page never opens it by itself. Closing the drawer removes it from the address.
  $effect(() => {
    const wanted = panel;
    const known = wanted !== null && matrix.rows.some((r) => r.locale === wanted);
    untrack(() => {
      if (wanted === null) {
        if (drawerOpen) drawerOpen = false;
      } else if (known && (drawerLocale !== wanted || !drawerOpen)) {
        drawerLocale = wanted;
        drawerOpen = true;
      }
    });
  });
  let wasOpen = false;
  $effect(() => {
    const isOpen = drawerOpen;
    untrack(() => {
      if (wasOpen && !isOpen && panel !== null) onpanel?.(null);
      wasOpen = isOpen;
    });
  });
  // A locale picked in the page header AFTER the page was shown is an explicit action: it opens that locale. The one already in the
  // address when the page appears only filters (the header context), it opens nothing.
  let seenLocale = locale;
  $effect(() => {
    const next = locale;
    untrack(() => {
      if (next === seenLocale) return;
      seenLocale = next;
      if (next !== null && matrix.rows.some((r) => r.locale === next)) openLocale(next);
    });
  });

  function openPull(app: AppSummary, fields: DriftField[]) {
    if (pullReason(app) !== null || fields.length === 0) return;
    pullApp = app;
    pullFieldsList = fields;
    pullOpen = true;
  }

  function openHistory(app: AppSummary, field: DriftField) {
    historyApp = app;
    historyTarget = { locale: field.locale, field: field.field, label: field.label, limit: field.limit, unit: field.unit };
    historyOpen = true;
  }

  const labelOf = (field: string): string => {
    for (const m of members) {
      for (const locale of views[m.id]?.drift?.locales ?? []) {
        const found = locale.fields.find((f) => f.field === field);
        if (found) return found.label;
      }
    }
    return field;
  };

  function pulled(result: PullResult) {
    lastPull = result;
    const summary = summarizePull(result);
    if (result.changeSet === null) {
      toast.info(summary.headline);
      return;
    }
    const changeSetId = result.changeSet.id;
    const repositoryId = result.target.repositoryId;
    const options = {
      action: {
        label: t('listing:tab.reviewDraft'),
        href: reviewHref,
        onclick: () => requestChangeSetReview({ repositoryId, changeSetId }),
      },
    };
    if (summary.tone === 'warn') toast.warning(summary.headline, options);
    else toast.success(summary.headline, options);
  }

  async function readRepository() {
    if (repoReading) return;
    repoReading = true;
    try {
      for (const app of readable) {
        try {
          const result = await api.refreshAppRepoListing(workspaceId, app.id);
          const platform = platformLabel(app.platform);
          if (!result.found) {
            toast.warning(both ? t('listing:matrixView.repoNoneFor', { platform }) : t('listing:tab.noRepoListing'));
          } else {
            const ref = shortRef('repo', result.ref);
            const counts = { changed: result.changed, removed: result.removed, unchanged: result.unchanged };
            toast.success(
              both
                ? ref
                  ? t('listing:matrixView.repoReadForAt', { platform, ref, ...counts })
                  : t('listing:matrixView.repoReadFor', { platform, ...counts })
                : ref
                  ? t('listing:tab.repoReadAt', { ref, ...counts })
                  : t('listing:tab.repoRead', counts),
            );
          }
          await load(app);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : t('common:error.genericRetry'));
        }
      }
    } finally {
      repoReading = false;
    }
  }

  const fieldKey = (app: AppSummary, field: DriftField) => `${app.id}\u0000${field.locale}\u0000${field.field}`;

  /** Stages the repository's text of one field for the draft push. Our own database only; no store is contacted. */
  async function stageField(app: AppSummary, field: DriftField) {
    if (stagingKey !== '') return;
    stagingKey = fieldKey(app, field);
    try {
      const done = await api.stageText(workspaceId, app.id, { locale: field.locale, field: field.field, from: 'repo' });
      stagedStore.set(done.staged);
      announcement = t('listing:matrixView.stagedAnnounce', { label: field.label, locale: field.locale });
      toast.success(t('listing:matrixView.stagedToast', { label: field.label, locale: field.locale }));
    } catch (e) {
      toast.error(stagingMessage(e));
    } finally {
      stagingKey = '';
    }
  }

  async function unstageField(app: AppSummary, id: string, field: DriftField) {
    if (stagingKey !== '') return;
    stagingKey = fieldKey(app, field);
    try {
      const done = await api.unstageItem(workspaceId, app.id, id);
      stagedStore.set(done.staged);
      announcement = t('listing:matrixView.unstagedAnnounce', { label: field.label, locale: field.locale });
    } catch (e) {
      toast.error(stagingMessage(e));
    } finally {
      stagingKey = '';
    }
  }

  /** The cells of a grid cell whose field has a staged text, for the mark. */
  const stagedCells = (cells: MatrixCell[]): MatrixCell[] =>
    cells.filter((c) => {
      const app = members.find((m) => m.platform === c.platform);
      return app !== undefined && cellStagedText(stagedStore.view(app.id), c.field) !== null;
    });


  function setMode(mode: MatrixFilter['mode']) {
    filter = { ...filter, mode };
  }

  const dimmed = (status: CellStatus) => filter.mode !== 'all' && !cellMatchesMode(status, filter.mode);
  const platformNames = (platforms: Platform[]) => formatList(platforms.map(platformLabel));
</script>

<div class="stack listing" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#each members as app (app.id)}
    {@const view = views[app.id]}
    {#if view?.problem}
      <Alert tone="error" title={t('listing:matrixView.loadFailed', { platform: platformLabel(app.platform) })}>
        {view.drift ? t('listing:tab.updateFailed', { problem: view.problem }) : view.problem}
        {#if !view.drift}<div class="retry"><Button size="sm" icon="refresh" onclick={() => load(app)}>{t('common:action.tryAgain')}</Button></div>{/if}
      </Alert>
    {/if}
  {/each}

  {#if hasRows}
    <PageLead
      testid="listing-status-line"
      tone={line.tone === 'ok' ? 'ok' : line.tone === 'warn' ? 'warn' : 'neutral'}
      headline={anySyncing ? t('listing:matrixView.reading', { text: line.text }) : line.text}
      hint={t('listing:matrixView.hint', { context: listingContext(shown, matrix.rows.length) })}
    >
      {#snippet actions()}
        {#if line.attention > 0 && filter.mode !== 'differing'}
          <Button variant="primary" onclick={() => setMode('differing')}>{t('listing:matrixView.showAttention', { count: line.attention })}</Button>
        {/if}
      {/snippet}
    </PageLead>
  {/if}

  <div class="toolbar">
    <div class="filters">
      {#if hasRows}
        <div class="chips" role="group" aria-label={t('listing:matrixView.filterAria')}>
          {#each MODE_ORDER as mode (mode)}
            <FilterChip label={t(MODE_LABELS[mode])} count={counts[mode]} pressed={filter.mode === mode} onclick={() => setMode(mode)} />
          {/each}
        </div>
        <label class="visually-hidden" for="listing-locale-query">{t('listing:matrixView.searchLabel')}</label>
        <input id="listing-locale-query" type="search" placeholder={t('listing:matrixView.searchPlaceholder')} bind:value={filter.query} />
      {/if}
      {#if !nothingLoaded}
        {#if warningCount > 0}
          <StatusPill
            tone="warn"
            label={t('listing:matrixView.warnings', { count: warningCount })}
            bind:open={warningsOpen}
            stateKey="listing.warnings"
            controls="listing-warnings"
          />
        {/if}
        {#if members.some((m) => views[m.id]?.reloading)}<span class="muted updating">{t('listing:matrixView.updating')}</span>{/if}
      {/if}
    </div>
    {#if !nothingLoaded}
      <div class="actions row wrap">
        <SectionsToggle />
        <InfoTip label={t('listing:matrixView.legendLabel')} buttonText={t('listing:matrixView.legendButton')} icon="info" align="end" width="min(28rem, 92vw)">
          {#if hasRows}
            <p>{t('listing:matrixView.legendIntro', { stores: formatList(members.map((m) => storeName(m.platform))) })}</p>
            <ul class="legend" aria-label={t('listing:matrixView.legendMarksAria')}>
              {#each LEGEND_ORDER as status (status)}
                <li><StatusDot {status} /> <span>{cellInfo(status).short}</span></li>
              {/each}
              {#if both}<li><StatusDot status="na" /> <span>{t('listing:matrixView.notOnStore')}</span></li>{/if}
              <li><span class="staged-mark"><Icon name="layers" size={14} /></span> <span>{t('listing:matrixView.stagedMark')}</span></li>
            </ul>
            <p class="muted">{t('listing:matrixView.legendNote')}</p>
          {/if}
          <p class="eyebrow">{t('listing:matrixView.sources')}</p>
          <dl class="sources">
            {#each members as app (app.id)}
              {@const view = views[app.id]}
              {#if view?.drift}
                <div>
                  <dt>{both ? platformLabel(app.platform) : storeName(app.platform)}</dt>
                  <dd>
                    {#if view.drift.store.readAt !== null}
                      <time datetime={new Date(view.drift.store.readAt).toISOString()} title={fullTime(view.drift.store.readAt)}>{t('listing:matrixView.storeReadAgo', { when: timeAgo(view.drift.store.readAt, now) })}</time>
                      {#if view.drift.channel === 'editable'}<span class="muted"> {t('listing:matrixView.editableNote')}</span>{/if}
                    {:else}
                      <span class="muted">{t('listing:matrixView.storeNotRead')}</span>
                    {/if}
                    <span class="muted"> · </span>
                    {#if app.repositoryId === null}
                      <span class="muted">{t('listing:matrixView.noRepoLinked')}</span>
                    {:else if view.drift.repo.readAt !== null}
                      <time datetime={new Date(view.drift.repo.readAt).toISOString()} title={fullTime(view.drift.repo.readAt)}>{t('listing:matrixView.repoReadAgo', { when: timeAgo(view.drift.repo.readAt, now) })}</time>
                      {#if view.drift.repo.ref}<span class="muted"> <T key="listing:matrixView.atRef" params={{ ref: shortRef('repo', view.drift.repo.ref) }} /></span>{/if}
                    {:else}
                      <span class="muted">{t('listing:matrixView.repoNotRead')}</span>
                    {/if}
                  </dd>
                </div>
              {/if}
            {/each}
          </dl>
          {#if canSync}
            <p class="pullnote muted">
              {t('listing:matrixView.syncHint')}
              <Button size="sm" variant="link" onclick={() => openStatusPopover()}>{t('listing:matrixView.openStatus')}</Button>
            </p>
          {/if}
          {#if hasRows}
            <p class="pullnote muted">
              {#if pullBlocked !== null}
                {t('listing:pullBar.unavailable', { reason: pullBlocked })}
              {:else if !anyPullable}
                {t('listing:pullBar.noDifferences')}
              {:else}
                {t('listing:matrixView.pullAhead')}
              {/if}
            </p>
          {/if}
        </InfoTip>
        {#if readable.length > 0 || (hasRows && anyPullable)}
          <InfoTip label={t('listing:matrixView.moreLabel')} buttonText={t('listing:matrixView.moreButton')} icon="more" align="end" width="min(20rem, 92vw)" bind:open={moreOpen}>
            <ul class="menu">
              {#if readable.length > 0}
                <li>
                  <Button icon="git-branch" loading={repoReading} onclick={() => { moreOpen = false; void readRepository(); }}>{repoReading ? t('listing:tab.reading') : t('listing:tab.readRepository')}</Button>
                  <span class="muted">{t('listing:matrixView.readRepoNote')}</span>
                </li>
              {/if}
              {#if hasRows}
                {#each pullables as p (p.app.id)}
                  {#if p.fields.length > 0}
                    <li>
                      <Button
                        icon="git-pull-request"
                        disabled={p.reason !== null}
                        title={p.reason ?? t('listing:matrixView.pullTitle')}
                        onclick={() => { moreOpen = false; openPull(p.app, p.fields); }}
                      >
                        {both ? t('listing:matrixView.pullDifferencesFor', { platform: platformLabel(p.app.platform), count: p.fields.length }) : t('listing:matrixView.pullDifferences', { count: p.fields.length })}
                      </Button>
                      <span class="muted">{p.reason ?? t('listing:matrixView.pullDraftNote')}</span>
                    </li>
                  {/if}
                {/each}
              {/if}
            </ul>
          </InfoTip>
        {/if}
      </div>
    {/if}
  </div>

  {#if warningCount > 0 && warningsOpen}
    <div id="listing-warnings" class="warnings stack tight">
      {#each warningGroupList as group (group.id)}
        <Alert tone="warn" title={group.title}>
          {#if group.lines.length === 1}
            <p class="alert-text">{group.lines[0]}</p>
          {:else}
            <ul class="alert-list">
              {#each group.lines as line (line)}<li>{line}</li>{/each}
            </ul>
          {/if}
          {#if group.note}<p class="alert-text">{group.note}</p>{/if}
        </Alert>
      {/each}
    </div>
  {/if}

  {#if loading && nothingLoaded && failed.length === 0}
    <div role="status" aria-label={t('listing:tab.loadingAria')} class="stack">
      <div class="card"><div class="stack"><Skeleton width="30%" height="16px" /><Skeleton width="100%" height="96px" /></div></div>
    </div>
  {:else}
    {#if !nothingLoaded && matrix.rows.length === 0}
      <div class="card">
        <EmptyState
          icon="file-text"
          title={t('listing:tab.emptyTitle')}
          description={t('listing:matrixView.emptyDescription')}
        >
          {#snippet actions()}
            {#if canSync}
              <Button variant="primary" icon="activity" onclick={() => openStatusPopover()}>{t('listing:matrixView.openStatusToSync')}</Button>
            {:else}
              <span class="muted">{t('listing:matrixView.canSync')}</span>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else if !nothingLoaded}
      <p class="visually-hidden" aria-live="polite">{matrixSummary(matrix.rows)}</p>

      {#if lastPull}
        <PullResultSummary
          result={lastPull}
          {labelOf}
          onreview={(r) => r.changeSet && requestChangeSetReview({ repositoryId: r.target.repositoryId, changeSetId: r.changeSet.id })}
          ondismiss={() => (lastPull = null)}
        />
      {/if}

      {#if rows.length === 0}
        <div class="card">
          <EmptyState icon="search" title={t('listing:matrixView.noLocalesMatch')} description={t('listing:tab.noMatchHint')}>
            {#snippet actions()}
              {#if filtering}<Button onclick={() => (filter = defaultMatrixFilter())}>{t('listing:tab.clearFilter')}</Button>{/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        <Section title={t('listing:matrixView.localesTitle')} key="locales" flush summary={summaryLine([t('listing:matrix.localesCount', { count: rows.length }), line.attention > 0 ? t('listing:matrix.summary.needAttention', { count: line.attention }) : t('listing:matrix.summary.allInSync')])}>
        <div class="grid-scroll">
          <table class="matrix compact">
            <caption class="visually-hidden">
              {both ? t('listing:matrixView.captionFor', { platforms: platformNames(shown) }) : t('listing:matrixView.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col" class="loc">{t('listing:matrixView.colLocale')}</th>
                {#if both}<th scope="col" class="stores">{t('listing:matrixView.colStores')}</th>{/if}
                {#each matrix.columns as column (column.key)}
                  {@const note = columnScopeNote(column, shown)}
                  <th scope="col" class="col">
                    <span class="label">{column.label}</span>
                    <span class="sub muted">{summaryLine([limitText(column), note])}</span>
                    {#if both}
                      <span class="plats" aria-hidden="true">
                        {#each shown as platform (platform)}
                          <span class="plat" class:off={!column.platforms.includes(platform)} title={platformLabel(platform)}>
                            <Icon name={platformById(platform).icon} size={12} />
                          </span>
                        {/each}
                      </span>
                    {/if}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.locale)}
                <tr class:current={drawerOpen && drawerLocale === row.locale}>
                  <th scope="row" class="loc">
                    <button type="button" class="bare locale-btn" onclick={() => openLocale(row.locale)} aria-label={row.name === row.locale ? t('listing:matrixView.openLocale', { locale: row.locale }) : t('listing:matrixView.openLocaleNamed', { locale: row.locale, name: row.name })}>
                      <span class="code">{row.locale}</span>
                      {#if row.name !== row.locale}<span class="name muted">{row.name}</span>{/if}
                    </button>
                  </th>
                  {#if both}
                    <td class="stores">
                      {#each row.platforms as platform (platform)}<PlatformBadge {platform} showLabel={false} tinted />{/each}
                    </td>
                  {/if}
                  {#each matrix.columns as column (column.key)}
                    {@const cells = row.cells[column.key] ?? []}
                    {@const staged = stagedCells(cells)}
                    <td class="cell">
                      <button
                        type="button"
                        class="bare dots"
                        class:dim={cells.every((c) => dimmed(c.status))}
                        aria-label={staged.length === 0
                          ? t('listing:matrixView.cellAria', { column: column.label, locale: row.locale, summary: cellsSummary(cells, both) })
                          : both
                            ? t('listing:matrixView.cellAriaStagedOn', { column: column.label, locale: row.locale, summary: cellsSummary(cells, both), platforms: platformNames(staged.map((c) => c.platform)) })
                            : t('listing:matrixView.cellAriaStaged', { column: column.label, locale: row.locale, summary: cellsSummary(cells, both) })}
                        onclick={() => openLocale(row.locale)}
                      >
                        {#each cells as cell (cell.platform)}
                          <StatusDot status={cell.status} label={cellText(column, cell, both)} />
                        {/each}
                        {#if staged.length > 0}<span class="staged-mark" aria-hidden="true" title={t('listing:matrixView.stagedMark')}><Icon name="layers" size={14} /></span>{/if}
                      </button>
                      {#each cells as cell (cell.platform)}
                        {@const editable = editableField(cell)}
                        {@const owner = members.find((m) => m.platform === cell.platform)}
                        {#if editable && owner}
                          <button
                            type="button"
                            class="bare edit"
                            aria-label={both
                              ? t('listing:matrixView.editAriaFor', { field: column.label.toLowerCase(), locale: row.locale, platform: platformLabel(cell.platform) })
                              : t('listing:matrixView.editAria', { field: column.label.toLowerCase(), locale: row.locale })}
                            title={both
                              ? t('listing:matrixView.editTitleFor', { field: column.label.toLowerCase(), locale: row.locale, platform: platformLabel(cell.platform) })
                              : t('listing:matrixView.editTitle', { field: column.label.toLowerCase(), locale: row.locale })}
                            onclick={() => openEditor(owner, editable)}
                          >
                            <Icon name="edit" size={14} />
                          </button>
                        {/if}
                      {/each}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        </Section>
      {/if}
    {/if}

    {#each members as app (app.id)}
      {@const view = views[app.id]}
      {#if view?.drift?.sections && view.drift.sections.length > 0}
        <section aria-label={t('listing:matrixView.sectionsAria', { platform: platformLabel(app.platform) })} class="stack">
          {#if both}<h2 class="phead"><PlatformBadge platform={app.platform} tinted /></h2>{/if}
          <ListingSections
            sections={view.drift.sections}
            platform={view.drift.platform}
            {now}
            storeReadAt={view.drift.store.readAt}
            repositoryLinked={app.repositoryId !== null}
          />
        </section>
      {/if}
    {/each}

    {#if lockedPlatforms.length < members.length}
      <StagedTray {api} {workspaceId} {role} members={members.filter((m) => lockedPlatforms.indexOf(m.platform) < 0)} />
    {/if}
  {/if}
</div>

<LocaleDrawer
  bind:open={drawerOpen}
  row={drawerRow}
  {members}
  {channels}
  {now}
  {pullReasons}
  position={{ index: drawerIndex, count: rows.length }}
  onstep={step}
  onpull={openPull}
  onhistory={openHistory}
  {role}
  onstage={stageField}
  onunstage={unstageField}
  {stagingKey}
  locked={lockedPlatforms}
  asoKeywords={canReadAso ? asoKeywords : undefined}
  allLocales={matrix.rows.map((r) => r.locale)}
  {api}
  {workspaceId}
  onedit={openEditor}
/>

{#if editTarget}
  <FieldEditor
    bind:open={editOpen}
    {api}
    {workspaceId}
    {role}
    appId={editTarget.app.id}
    platform={editTarget.app.platform}
    locale={editTarget.locale}
    field={editTarget.field}
    current={editTarget.current}
  />
{/if}

{#if members.length > 0}
  <PullDialog
    bind:open={pullOpen}
    {api}
    {workspaceId}
    {role}
    app={pullApp ?? (members[0] as AppSummary)}
    fields={pullFieldsList}
    channel={views[(pullApp ?? (members[0] as AppSummary)).id]?.drift?.channel ?? null}
    onpulled={pulled}
  />
  <HistoryDrawer bind:open={historyOpen} {api} {workspaceId} appId={(historyApp ?? (members[0] as AppSummary)).id} target={historyTarget} {now} />
{/if}

<style>
  .alert-text {
    margin: var(--space-1) 0 0;
  }

  .alert-list {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
  }

  .retry {
    margin-top: var(--space-2);
  }

  .sources {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }

  .sources dt {
    display: block;
    font-weight: var(--weight-semibold);
  }

  .sources dd {
    margin: 0;
  }

  .pullnote {
    margin-top: var(--space-3);
  }

  .updating {
    font-size: var(--text-xs);
  }

  .menu {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .menu li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
  }

  .menu .muted {
    font-size: var(--text-sm);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
  }

  .filters {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .actions {
    flex: none;
    margin-left: auto;
  }

  .filters input {
    width: 14rem;
    min-height: var(--control-md);
    font-size: 0.9375rem;
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }






  .legend {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-1) var(--space-4);
    padding: 0;
    margin: var(--space-3) 0;
    color: var(--muted);
    list-style: none;
  }

  .legend li {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .matrix {
    width: 100%;
    font-size: 0.9375rem;
    border-collapse: collapse;
  }

  .matrix th,
  .matrix td {
    padding: var(--space-3) var(--space-4);
    vertical-align: middle;
  }

  /* The grid scrolls inside its own box so the header row (and the locale column) stay in view. */
  .grid-scroll {
    max-height: calc(100vh - var(--topbar-height) - var(--space-12));
    overflow: auto;
  }

  .matrix thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    vertical-align: bottom;
    white-space: nowrap;
    background: var(--surface-sunken);
    box-shadow: 0 1px 0 var(--line);
  }

  .matrix thead th.loc {
    z-index: 3;
  }

  .col .label {
    display: block;
  }

  .col .sub {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .plats {
    display: flex;
    gap: var(--space-1);
    margin-top: var(--space-1);
    color: var(--muted);
  }

  .plat {
    display: inline-grid;
    place-items: center;
    width: 20px;
  }

  .plat.off {
    opacity: 0.35;
  }

  .loc {
    position: sticky;
    left: 0;
    min-width: 9rem;
    text-align: left;
    background: var(--surface);
  }

  .stores {
    white-space: nowrap;
  }

  .stores :global(.platform) {
    margin-right: var(--space-1);
  }

  tr.current .loc,
  tr.current td {
    background: var(--accent-bg);
  }

  .locale-btn {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0;
    font: inherit;
    text-align: left;
    color: var(--ink);
    cursor: pointer;
  }

  .locale-btn:hover .code {
    text-decoration: underline;
  }

  .locale-btn:focus-visible {
    outline: var(--ring);
    outline-offset: 2px;
  }

  .code {
    font-weight: var(--weight-semibold);
  }

  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .dots {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-1);
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .dots:hover {
    background: var(--surface-hover);
  }

  .dots:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .staged-mark {
    display: inline-flex;
    color: var(--accent);
  }

  .dots.dim {
    opacity: 0.3;
  }

  .edit {
    display: inline-flex;
    padding: var(--space-1);
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .edit:hover {
    color: var(--accent);
    background: var(--surface-hover);
  }

  .edit:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  h2.phead {
    margin: 0;
    font-size: var(--text-base);
  }
</style>
