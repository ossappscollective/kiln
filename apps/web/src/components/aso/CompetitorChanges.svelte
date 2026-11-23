<!--
  CompetitorChanges: the listing changes Kiln found on one followed App Store competitor, newest first: screenshots as
  before and after strips (thumbnails through the server's proxy), the icon, and text changes as a short word diff that is
  collapsed until asked for. History starts when following began, and the line above says so. "Check now" reads the public
  store once. A Google Play competitor is shown as not watched: Kiln does not read Google Play pages.
  Props: api, workspaceId, appId, competitor, canWrite, now, onchecked (after a check found something, so the card can read again).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { type AsoCompetitor, asoErrorMessage } from '../../lib/aso/aso.ts';
  import {
    CHANGES_PAGE,
    type CompetitorChangesPage,
    type ListingChangeRow,
    changeImageRef,
    changeSentence,
    changesStatus,
    competitorImageUrl,
    deviceWord,
    diffOf,
    hasTextDiff,
    oldestOf,
    shotAlt,
    sideWord,
    stripOf,
  } from '../../lib/aso/competitor-changes.ts';
  import { formatDate, formatDateTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';

  let {
    api,
    workspaceId,
    appId,
    competitor,
    canWrite,
    now,
    onchecked,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    competitor: AsoCompetitor;
    canWrite: boolean;
    now: number;
    onchecked?: (() => void) | undefined;
  } = $props();

  const watched = $derived(competitor.store === 'app_store');
  let page = $state<CompetitorChangesPage | null>(null);
  let rows = $state<ListingChangeRow[]>([]);
  let loading = $state(true);
  let error = $state('');
  let checking = $state(false);
  let more = $state(false);
  let generation = 0;
  let broken = $state<Record<string, boolean>>({});

  async function load() {
    const mine = ++generation;
    loading = true;
    error = '';
    try {
      const got = await api.asoCompetitorChanges(workspaceId, appId, competitor.id, CHANGES_PAGE);
      if (mine !== generation) return;
      page = got;
      rows = got.changes;
    } catch (e) {
      if (mine !== generation) return;
      error = asoErrorMessage(e, t('aso:changes.loadFailed'));
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void competitor.id;
    void competitor.lastCheckedAt;
    if (!untrack(() => watched)) {
      loading = false;
      return;
    }
    void load();
  });

  async function older() {
    const before = oldestOf(rows);
    if (before === undefined) return;
    more = true;
    try {
      const got = await api.asoCompetitorChanges(workspaceId, appId, competitor.id, CHANGES_PAGE, before);
      rows = rows.concat(got.changes);
      if (page) page = { ...page, hasMore: got.hasMore };
    } catch (e) {
      error = asoErrorMessage(e, t('aso:changes.loadFailed'));
    } finally {
      more = false;
    }
  }

  async function check() {
    checking = true;
    error = '';
    try {
      const done = await api.checkAsoCompetitor(workspaceId, appId, competitor.id);
      if (done.state === 'recent') toast.info(t('aso:changes.checkedRecent'));
      else if (done.state === 'not_found') toast.info(t('aso:changes.checkedNotFound'));
      else if (done.changes > 0) toast.success(t('aso:changes.checked', { count: done.changes }));
      else toast.info(t('aso:changes.checkedNone'));
      // The card reads the list again, which changes `lastCheckedAt` and so reloads this section.
      if (onchecked) onchecked();
      else await load();
    } catch (e) {
      error = asoErrorMessage(e, t('aso:changes.checkFailed'));
    } finally {
      checking = false;
    }
  }

  const status = $derived(page ? changesStatus({ ...page, changes: rows }) : null);
  const summary = $derived(!watched ? t('aso:changes.summaryNotWatched') : rows.length === 0 ? t('aso:changes.summaryNone') : t('aso:changes.summary', { count: rows.length, more: page?.hasMore ? '+' : '' }));
  const day = (ms: number) => formatDate(ms, { year: 'numeric', month: 'short', day: 'numeric' });
  const sides = ['before', 'after'] as const;
</script>

<Disclosure {summary} stateKey="aso.competitor.changes.{competitor.id}">
  <div class="changes stack">
    {#if !watched}
      <p class="muted note" data-testid="changes-not-watched">{t('aso:changes.notWatched')}</p>
    {:else}
      {#if error}<Alert tone="error">{error}</Alert>{/if}
      <div class="bar">
        {#if status?.kind === 'none'}
          <p class="muted note">{t('aso:changes.noneSince', { ago: agoText(status.checkedAt, now), date: day(status.since) })}</p>
        {:else if status?.kind === 'firstOnly'}
          <p class="muted note">{t('aso:changes.firstOnly', { date: day(status.since) })}</p>
        {:else if status?.kind === 'notChecked'}
          <p class="muted note">{t('aso:changes.notChecked')}</p>
        {:else if status?.kind === 'list'}
          <p class="muted note">{t('aso:changes.watchingSince', { date: day(status.since) })}{#if status.checkedAt !== null} {t('aso:changes.checkedAgo', { ago: agoText(status.checkedAt, now) })}{/if}</p>
        {:else if loading}
          <p class="muted note">{t('common:state.loading')}</p>
        {/if}
        {#if canWrite}
          <Button size="sm" variant="secondary" icon="refresh" loading={checking} onclick={check}>{t('aso:changes.checkNow')}</Button>
        {/if}
      </div>
      {#if rows.length > 0}
        <ul class="list" aria-label={t('aso:changes.listLabel', { name: competitor.name })}>
          {#each rows as row (row.id)}
            <li class="row">
              <time class="when muted" datetime={new Date(row.detectedAt).toISOString()}>{formatDateTime(row.detectedAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
              <ul class="items">
                {#each row.changes as c, i (i)}
                  <li class="item">
                    <p class="sentence">{changeSentence(c)}</p>
                    {#if c.kind === 'screenshots'}
                      {#each sides as side (side)}
                        {@const strip = stripOf(row.id, c, side)}
                        {#if strip.length > 0}
                          <div class="strip-block" role="group" aria-label={t('aso:changes.stripLabel', { device: deviceWord(c.device), side: sideWord(side) })}>
                            <span class="side muted">{sideWord(side)}</span>
                            <ul class="strip">
                              {#each strip as item (item.ref)}
                                <li class="shot" class:removed={item.status === 'removed'} class:new={item.status === 'new'}>
                                  {#if broken[item.ref + row.id]}
                                    <span class="gone muted" role="img" aria-label={shotAlt(item, side, c.device)}>{item.n}</span>
                                  {:else}
                                    <img src={competitorImageUrl(workspaceId, appId, competitor.id, item.ref, 160)} alt={shotAlt(item, side, c.device)} loading="lazy" height="96" onerror={() => (broken[item.ref + row.id] = true)} />
                                  {/if}
                                  {#if item.status !== 'kept'}<span class="tag">{item.status === 'removed' ? t('aso:changes.status.removed') : t('aso:changes.status.new')}</span>{/if}
                                </li>
                              {/each}
                            </ul>
                          </div>
                        {/if}
                      {/each}
                    {:else if c.kind === 'icon'}
                      <ul class="strip">
                        {#each sides as side (side)}
                          {@const ref = changeImageRef(row.id, side, 'icon', 0)}
                          {#if (side === 'before' ? c.before : c.after) !== null}
                            <li class="shot icon">
                              {#if broken[ref]}
                                <span class="gone muted" role="img" aria-label={t('aso:changes.iconAlt', { side: sideWord(side) })}>?</span>
                              {:else}
                                <img src={competitorImageUrl(workspaceId, appId, competitor.id, ref, 96)} alt={t('aso:changes.iconAlt', { side: sideWord(side) })} loading="lazy" width="48" height="48" onerror={() => (broken[ref] = true)} />
                              {/if}
                              <span class="tag plain">{sideWord(side)}</span>
                            </li>
                          {/if}
                        {/each}
                      </ul>
                    {:else if hasTextDiff(c)}
                      <details class="diff">
                        <summary>{t('aso:changes.showDiff')}</summary>
                        <p class="words">
                          {#each diffOf(c) as seg, j (j)}
                            {#if seg.op === 'same'}{seg.text}{' '}{:else if seg.op === 'ins'}<ins><span class="visually-hidden">{t('aso:changes.sr.added')} </span>{seg.text}</ins>{' '}{:else}<del><span class="visually-hidden">{t('aso:changes.sr.removed')} </span>{seg.text}</del>{' '}{/if}
                          {/each}
                        </p>
                      </details>
                    {/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
        {#if page?.hasMore}
          <div><Button size="sm" variant="ghost" loading={more} onclick={older}>{t('aso:changes.older')}</Button></div>
        {/if}
        {#if page}<p class="muted note">{t('aso:changes.retention', { days: page.retentionDays })}</p>{/if}
      {/if}
    {/if}
  </div>
</Disclosure>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: flex-start;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .list,
  .items,
  .strip {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
    min-width: 0;
    text-align: left;
  }

  .row:first-child {
    border-top: 0;
  }

  .when {
    font-size: var(--text-sm);
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .sentence {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .strip-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .side {
    font-size: var(--text-sm);
  }

  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .shot {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    padding: var(--space-1);
    min-width: 0;
  }

  .shot img {
    display: block;
    height: 96px;
    width: auto;
    max-width: 100%;
    border-radius: var(--radius-sm);
  }

  .shot.icon img {
    height: 48px;
    width: 48px;
  }

  .shot.removed {
    border-color: var(--bad-line);
    background: var(--bad-bg);
  }

  .shot.new {
    border-color: var(--ok-line);
    background: var(--ok-bg);
  }

  .shot.removed img {
    opacity: 0.7;
  }

  .tag {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .shot.removed .tag {
    color: var(--bad-ink);
  }

  .shot.new .tag {
    color: var(--ok-ink);
  }

  .gone {
    display: inline-grid;
    place-items: center;
    min-width: 48px;
    height: 48px;
  }

  .diff summary {
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--accent);
  }

  .diff summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .words {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    overflow-wrap: anywhere;
    white-space: normal;
    max-height: 16rem;
    overflow-y: auto;
  }

  ins {
    background: var(--ok-bg);
    color: var(--ok-ink);
    text-decoration: underline;
  }

  del {
    background: var(--bad-bg);
    color: var(--bad-ink);
    text-decoration: line-through;
  }
</style>
