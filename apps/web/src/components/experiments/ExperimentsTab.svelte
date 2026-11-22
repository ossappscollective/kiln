<!--
  ExperimentsTab: the store experiments and custom product pages of one app (docs/api/experiments.md, docs/adr/0048-store-experiments.md).
  Apple: Product Page Optimization experiments (state, dates, traffic, treatments with their languages and media) and custom product pages
  (state, languages, deep link, the address to share), read from App Store Connect by "Sync" into a stored copy. Reading never changes a store and
  Kiln cannot start, stop or edit a test or a page: the page says so, and links to App Store Connect, where the RESULTS are (Apple's API has none).
  Google Play: its API has neither store listing experiments nor custom store listings, so the page explains that and links to the Play Console.
  The manual tracker (notes) is Kiln's own data for any app and is the whole record for Google Play.
  Props: api, workspaceId, role, app, refreshKey (changes when an app sync finished, so this reads again).
-->
<script lang="ts">
  import { can, PLATFORM_META, platformSupports, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    appStoreConnectUrl,
    assetsText,
    dateRangeText,
    type ExperimentNote,
    type ExperimentsView,
    localesText,
    noteDateText,
    noteKindLabel,
    noteStatusBadge,
    PLAY_CONSOLE_URL,
    playListingUrl,
    runningByDates,
    stateBadge,
    sumAssets,
    syncLine,
    trafficText,
    treatmentLine,
  } from '../../lib/experiments.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import NoteDialog from './NoteDialog.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const maySync = $derived(can(role, 'apps.sync'));
  const mayWrite = $derived(can(role, 'aso.write'));
  const apple = $derived(platformSupports(app.platform, 'storeExperimentsApi'));
  const consoleName = $derived(PLATFORM_META[app.platform].consoleName);
  const consoleUrl = $derived(apple ? appStoreConnectUrl(app.storeAppId) : PLAY_CONSOLE_URL);

  let view = $state<ExperimentsView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let syncing = $state(false);
  let syncProblem = $state('');
  let now = $state(Date.now());
  let generation = 0;
  let dialogOpen = $state(false);
  let editing = $state<ExperimentNote | null>(null);
  let deleting = $state('');
  let noteProblem = $state('');

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appExperiments(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : t('experiments:tab.loadError');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  async function sync() {
    if (syncing) return;
    syncing = true;
    syncProblem = '';
    try {
      const done = await api.syncAppExperiments(workspaceId, app.id);
      toast.success(t('experiments:tab.syncDone', { experiments: done.sync.experiments, pages: done.sync.customPages }));
    } catch (e) {
      syncProblem = e instanceof ApiError ? e.message : t('experiments:tab.syncFailedNetwork');
    } finally {
      syncing = false;
      // The failure is also kept on the server, so the line says it.
      await load();
    }
  }

  function addNote() {
    editing = null;
    dialogOpen = true;
  }
  function editNote(note: ExperimentNote) {
    editing = note;
    dialogOpen = true;
  }
  async function removeNote(note: ExperimentNote) {
    if (deleting !== '') return;
    deleting = note.id;
    noteProblem = '';
    try {
      await api.deleteExperimentNote(workspaceId, app.id, note.id);
      toast.success(t('experiments:notes.deleted'));
      await load();
    } catch (e) {
      noteProblem = e instanceof ApiError ? e.message : t('experiments:notes.deleteFailed');
    } finally {
      deleting = '';
    }
  }

  const experiments = $derived(view?.experiments ?? []);
  const pages = $derived(view?.customPages ?? []);
  const notes = $derived(view?.notes ?? []);
  const line = $derived(view ? syncLine(view.sync, now) : null);
  const synced = $derived(view?.sync?.lastSyncedAt != null);
  const headline = $derived(
    view === null
      ? t('experiments:tab.headlineDefault')
      : !apple
        ? t('experiments:tab.headlineGoogle')
        : experiments.length + pages.length === 0
          ? t('experiments:tab.headlineNone')
          : t('experiments:tab.headlineCount', { experiments: experiments.length, pages: pages.length }),
  );
</script>

<div class="stack">
  <PageLead {headline} hint={apple ? t('experiments:tab.leadHintApple') : t('experiments:tab.leadHintGoogle')}>
    {#snippet aside()}
      <InfoTip label={t('experiments:tab.about')} buttonText={t('experiments:tab.about')} width="26rem">
        <p>{apple ? t('experiments:tab.aboutApple') : t('experiments:tab.aboutGoogle')}</p>
        <p>{t('experiments:tab.aboutReadOnly')}</p>
      </InfoTip>
    {/snippet}
    {#snippet actions()}
      {#if consoleUrl}
        <Button icon="external-link" href={consoleUrl} target="_blank">{t('experiments:tab.openConsole', { console: consoleName })}</Button>
      {/if}
      {#if apple && maySync}
        <Button variant={experiments.length + pages.length === 0 ? 'primary' : 'secondary'} icon="refresh" loading={syncing} onclick={() => void sync()}>{t('experiments:tab.sync')}</Button>
      {/if}
    {/snippet}
  </PageLead>

  {#if syncProblem !== ''}<Alert tone="error" title={t('experiments:tab.syncFailedTitle')}>{syncProblem}</Alert>{/if}

  {#if loading && !view}
    <div role="status" aria-label={t('experiments:tab.reading')} class="stack">
      <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
    </div>
  {:else if problem !== ''}
    <Alert tone="error" title={t('experiments:tab.loadErrorTitle')}>
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>{t('common:action.tryAgain')}</Button></div>
    </Alert>
  {:else if view}
    {#if apple}
      {#if line && view.sync !== null}
        <p class="sync-line text-sm" class:bad={line.tone === 'bad'} class:warn={line.tone === 'warn'} role={line.tone === 'bad' ? 'alert' : 'status'}>{line.text}</p>
      {/if}
      {#if view.sync && view.sync.warnings.length > 0}
        <Alert tone="warn" title={t('experiments:tab.partsTitle')}>
          <ul class="warnings">{#each view.sync.warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
        </Alert>
      {/if}
      <Alert tone="info" title={t('experiments:results.title')}>
        {t('experiments:results.body')}
        {#if consoleUrl}<a href={consoleUrl} target="_blank" rel="noopener noreferrer">{t('experiments:results.link', { console: consoleName })}</a>{/if}
      </Alert>

      <section class="stack" aria-label={t('experiments:experiments.heading')}>
        <h3 class="heading">{t('experiments:experiments.heading')}</h3>
        {#if experiments.length === 0}
          <EmptyState icon="tag" title={synced ? t('experiments:experiments.emptyTitle') : t('experiments:experiments.neverTitle')} description={synced ? t('experiments:experiments.emptyDescription') : t('experiments:experiments.neverDescription')}>
            {#snippet actions()}
              {#if apple && maySync && !synced}
                <Button variant="primary" icon="refresh" loading={syncing} onclick={() => void sync()}>{t('experiments:tab.sync')}</Button>
              {/if}
            {/snippet}
          </EmptyState>
        {:else}
          <div class="table-wrap card flush">
            <table aria-label={t('experiments:experiments.aria', { app: app.name })}>
              <thead>
                <tr>
                  <th scope="col">{t('experiments:experiments.colName')}</th>
                  <th scope="col">{t('experiments:experiments.colState')}</th>
                  <th scope="col">{t('experiments:experiments.colDates')}</th>
                  <th scope="col" class="num">{t('experiments:experiments.colTraffic')}</th>
                  <th scope="col">{t('experiments:experiments.colTreatments')}</th>
                </tr>
              </thead>
              <tbody>
                {#each experiments as e (e.id)}
                  {@const badge = stateBadge(e.state)}
                  <tr>
                    <td>
                      <div class="name">{e.name}</div>
                      {#if e.reviewRequired}<div class="muted text-sm">{t('experiments:experiments.reviewRequired')}</div>{/if}
                    </td>
                    <td>
                      <Badge tone={badge.tone} dot>{badge.label}</Badge>
                      {#if runningByDates(e, now)}<div class="muted text-sm">{t('experiments:experiments.runningByDates')}</div>{/if}
                      {#if e.rawState && badge.label.toLowerCase() !== e.rawState.toLowerCase().replace(/_/g, ' ')}<div class="muted text-sm mono" title={t('experiments:tab.rawState')}>{e.rawState}</div>{/if}
                    </td>
                    <td class="muted text-sm">{dateRangeText(e)}</td>
                    <td class="num">{trafficText(e.trafficProportion)}</td>
                    <td>
                      {#if e.treatments.length === 0}
                        <span class="muted text-sm">{t('experiments:experiments.noTreatments')}</span>
                      {:else}
                        <ul class="treatments">
                          {#each e.treatments as tr (tr.id)}
                            <li><span class="name">{tr.name}</span><div class="muted text-sm">{treatmentLine(tr)}</div></li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <section class="stack" aria-label={t('experiments:pages.heading')}>
        <h3 class="heading">{t('experiments:pages.heading')}</h3>
        {#if app.platform === 'macos'}
          <p class="muted text-sm">{t('experiments:pages.iosOnly')}</p>
        {:else if pages.length === 0}
          <EmptyState icon="tag" title={synced ? t('experiments:pages.emptyTitle') : t('experiments:pages.neverTitle')} description={synced ? t('experiments:pages.emptyDescription') : t('experiments:pages.neverDescription')} />
        {:else}
          <div class="table-wrap card flush">
            <table aria-label={t('experiments:pages.aria', { app: app.name })}>
              <thead>
                <tr>
                  <th scope="col">{t('experiments:pages.colName')}</th>
                  <th scope="col">{t('experiments:pages.colState')}</th>
                  <th scope="col">{t('experiments:pages.colLanguages')}</th>
                  <th scope="col">{t('experiments:pages.colDeepLink')}</th>
                  <th scope="col"><span class="visually-hidden">{t('experiments:pages.colActions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {#each pages as p (p.id)}
                  {@const badge = stateBadge(p.state)}
                  <tr>
                    <td>
                      <div class="name">{p.name}</div>
                      {#if p.visible === false}<div class="muted text-sm">{t('experiments:pages.hidden')}</div>{/if}
                    </td>
                    <td><Badge tone={badge.tone} dot>{badge.label}</Badge></td>
                    <td>
                      <div class="text-sm">{localesText(p.locales)}</div>
                      {#if p.locales.length > 0}<div class="muted text-sm">{assetsText(sumAssets(p.locales))}</div>{/if}
                    </td>
                    <td class="text-sm">{#if p.deepLink}<span class="mono">{p.deepLink}</span>{:else}<span class="muted">{t('experiments:pages.noDeepLink')}</span>{/if}</td>
                    <td class="actions">
                      {#if p.url}
                        <Button size="sm" icon="external-link" href={p.url} target="_blank">{t('experiments:pages.open')}<span class="visually-hidden"> {p.name}</span></Button>
                        <CopyButton value={p.url} size="sm" label={t('experiments:pages.copyLink')} />
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {:else}
      <Alert tone="info" title={t('experiments:google.title')}>
        <p>{t('experiments:google.body')}</p>
        <ul class="warnings">
          <li>{t('experiments:google.limitExperiments')}</li>
          <li>{t('experiments:google.limitListings')}</li>
        </ul>
      </Alert>
    {/if}

    <section class="stack" aria-label={t('experiments:notes.heading')}>
      <div class="row between">
        <h3 class="heading">{t('experiments:notes.heading')}</h3>
        {#if mayWrite}<Button size="sm" icon="plus" onclick={addNote}>{t('experiments:notes.add')}</Button>{/if}
      </div>
      <p class="muted text-sm">{apple ? t('experiments:notes.leadApple') : t('experiments:notes.leadGoogle')}</p>
      {#if noteProblem !== ''}<Alert tone="error" title={t('experiments:notes.deleteFailedTitle')}>{noteProblem}</Alert>{/if}
      {#if notes.length === 0}
        <EmptyState icon="file-text" title={t('experiments:notes.emptyTitle')} description={apple ? t('experiments:notes.emptyDescriptionApple') : t('experiments:notes.emptyDescriptionGoogle')}>
          {#snippet actions()}
            {#if mayWrite}<Button variant={apple ? 'secondary' : 'primary'} icon="plus" onclick={addNote}>{t('experiments:notes.add')}</Button>{/if}
          {/snippet}
        </EmptyState>
      {:else}
        <ul class="notes">
          {#each notes as n (n.id)}
            {@const status = noteStatusBadge(n.status)}
            {@const listingUrl = playListingUrl(app.identifier, n.listing)}
            <li class="card note">
              <div class="row between">
                <div>
                  <span class="name">{n.name}</span>
                  <span class="muted text-sm"> · {noteKindLabel(n.kind)}</span>
                </div>
                <Badge tone={status.tone} dot>{status.label}</Badge>
              </div>
              {#if n.startedOn || n.endedOn}
                <div class="muted text-sm">
                  {#if n.startedOn && n.endedOn}{t('experiments:dates.range', { from: noteDateText(n.startedOn) ?? '', to: noteDateText(n.endedOn) ?? '' })}
                  {:else if n.startedOn}{t('experiments:dates.since', { date: noteDateText(n.startedOn) ?? '' })}
                  {:else}{t('experiments:dates.until', { date: noteDateText(n.endedOn) ?? '' })}{/if}
                </div>
              {/if}
              {#if n.note}<p class="note-text">{n.note}</p>{/if}
              <div class="row links text-sm">
                {#if n.url}<a href={n.url} target="_blank" rel="noopener noreferrer">{t('experiments:notes.openLink')}</a>{/if}
                {#if listingUrl}<a href={listingUrl} target="_blank" rel="noopener noreferrer">{t('experiments:notes.openListing')}</a>{/if}
                <span class="spacer"></span>
                {#if mayWrite}
                  <Button size="sm" icon="edit" onclick={() => editNote(n)}>{t('experiments:notes.edit')}<span class="visually-hidden"> {n.name}</span></Button>
                  <Button size="sm" variant="danger" icon="trash" loading={deleting === n.id} onclick={() => void removeNote(n)}>{t('experiments:notes.delete')}<span class="visually-hidden"> {n.name}</span></Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<NoteDialog bind:open={dialogOpen} {api} {workspaceId} appId={app.id} platform={app.platform} note={editing} onsaved={() => void load()} />

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
    margin: 0;
    font-size: var(--text-md);
  }

  .name {
    font-weight: 500;
  }

  .warnings,
  .treatments,
  .notes {
    margin: 0;
    padding-left: var(--space-4);
  }

  .treatments,
  .notes {
    padding-left: 0;
    list-style: none;
  }

  .treatments li + li {
    margin-top: var(--space-2);
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .note {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .note-text {
    margin: 0;
    white-space: pre-wrap;
  }

  .links {
    align-items: center;
    gap: var(--space-3);
  }

  .between {
    justify-content: space-between;
    align-items: center;
  }

  .retry {
    margin-top: var(--space-2);
  }

  .actions {
    white-space: nowrap;
  }
</style>
