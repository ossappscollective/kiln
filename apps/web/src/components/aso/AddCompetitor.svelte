<!--
  AddCompetitor: follow an app of the store. One field: "Search by name, or paste a store link or id".
  App Store: a name (2 letters or more, after 300 ms, stale calls aborted) searches Apple's public search in a storefront (the app's
  usual one, changeable); each result shows icon, name, developer, category, rating and price, and one click or Enter follows it.
  A pasted apps.apple.com link, `id123` or a number resolves directly, with no search. Google Play has no official search and Kiln does
  not scrape it: the field takes a package name or a play.google.com link, checks the format and says where to find the package.
  Following reads the public store once (so the name is real and the first snapshot exists) and is rate limited per workspace.
  Keyboard: arrows move through the results, Enter follows, Escape closes the list (then the form). Props: api, workspaceId, members,
  config, ondone (after an app was added), oncancel.
-->
<script lang="ts">
  import { needsStoreAppId, supports } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { ApiError } from '../../lib/api.ts';
  import { searchImageUrl } from '../../lib/aso/competitor-changes.ts';
  import { type AsoConfig, type AsoCompetitorSearchResult, asoErrorMessage, commonCountries } from '../../lib/aso/aso.ts';
  import { moveActive, primaryCountry, readField, SEARCH_DEBOUNCE_MS } from '../../lib/aso/competitor-search.ts';
  import { bumpCompetitors } from '../../lib/aso/competitor-sync.svelte.ts';
  import { formatDisplayName, formatNumber } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    members,
    config,
    ondone,
    oncancel,
  }: { api: Api; workspaceId: string; members: AppSummary[]; config: AsoConfig | null; ondone: () => void; oncancel: () => void } = $props();

  const uid = $props.id();
  const playOff = $derived(config !== null && !config.play.enabled);
  const choices = $derived(members.filter((m) => !supports(m.platform, 'unofficialSearch') || !playOff));

  let appId = $state('');
  let query = $state('');
  let country = $state('us');
  let countryTouched = false;
  let busy = $state('');
  let error = $state('');
  let status = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  let problem = $state('');
  let offline = $state(false);
  let results = $state<AsoCompetitorSearchResult[]>([]);
  let searchedTerm = $state('');
  let open = $state(true);
  let active = $state(-1);
  let retry = $state(0);

  const target = $derived(choices.find((m) => m.id === appId) ?? choices[0]);
  const store = $derived(target !== undefined && !needsStoreAppId(target.platform) ? 'google_play' : 'app_store');
  const meaning = $derived(readField(query, store));
  const countries = $derived(commonCountries.indexOf(country) >= 0 ? commonCountries : [country].concat(commonCountries));
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const showList = $derived(open && store === 'app_store' && meaning.kind === 'search' && status === 'done' && results.length > 0);

  // The storefront the app is already tracked in (its most common keyword or competitor country), once per app. Own database only.
  $effect(() => {
    const app = target;
    if (!app) return;
    countryTouched = false;
    let stale = false;
    Promise.all([api.asoKeywords(workspaceId, app.id).catch(() => null), api.asoCompetitors(workspaceId, app.id).catch(() => null)]).then(([k, c]) => {
      if (stale || countryTouched) return;
      const found: string[] = [];
      for (const x of k?.keywords ?? []) found.push(x.country);
      for (const x of c?.competitors ?? []) found.push(x.country);
      country = primaryCountry(found);
    });
    return () => {
      stale = true;
    };
  });

  // The search: debounced, one request at a time, a stale one aborted.
  $effect(() => {
    const m = meaning;
    const app = target;
    const cc = country;
    void retry;
    error = '';
    active = -1;
    if (m.kind !== 'search' || !app || store !== 'app_store') {
      status = 'idle';
      results = [];
      problem = '';
      offline = false;
      return;
    }
    status = 'loading';
    problem = '';
    offline = false;
    open = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const out = await api.searchAsoCompetitors(workspaceId, app.id, m.term, cc, controller.signal);
        if (controller.signal.aborted) return;
        results = out.results;
        searchedTerm = m.term;
        status = 'done';
      } catch (e) {
        if (controller.signal.aborted) return;
        results = [];
        offline = e instanceof ApiError && e.code === 'network';
        problem = offline ? t('aso:follow.offline') : asoErrorMessage(e, t('aso:follow.searchFailed'));
        status = 'error';
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  async function follow(externalId: string, countryCode: string, key: string) {
    if (busy || !target) return;
    busy = key;
    error = '';
    try {
      const out = await api.addAsoCompetitor(workspaceId, target.id, { externalId, country: countryCode });
      toast.success(t('aso:follow.toast', { name: out.competitor.name }));
      bumpCompetitors();
      ondone();
    } catch (e) {
      error = asoErrorMessage(e, t('aso:err.followApp'));
    } finally {
      busy = '';
    }
  }

  function addResult(r: AsoCompetitorSearchResult) {
    if (r.state !== 'available') return;
    void follow(r.externalId, country, r.externalId);
  }

  function addRef() {
    if (meaning.kind !== 'ref') return;
    const code = meaning.ref.store === 'app_store' && meaning.ref.country ? meaning.ref.country : country;
    void follow(meaning.ref.id, code, 'ref');
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!showList && status === 'done' && results.length > 0) open = true;
      if (results.length === 0) return;
      event.preventDefault();
      active = moveActive(active, results.length, event.key);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const r = results[active];
      if (showList && r) addResult(r);
      else if (meaning.kind === 'ref') addRef();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (showList) {
        open = false;
        active = -1;
      } else oncancel();
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (meaning.kind === 'ref') addRef();
  }

  const priceText = (p: string | null) => (p === null ? '' : p === 'Free' ? t('aso:follow.free') : p);
  const refText = $derived(
    meaning.kind === 'ref'
      ? meaning.ref.store === 'google_play'
        ? t('aso:follow.resolvedPackage', { id: meaning.ref.id })
        : t('aso:follow.resolvedId', { id: meaning.ref.id, country: (meaning.ref.country ?? country).toUpperCase() })
      : '',
  );
  const countText = $derived(t('aso:follow.count', { count: results.length }));
  let brokenIcons = $state<Record<string, true>>({});
</script>

<form class="card stack" onsubmit={submit} novalidate>
  {#if choices.length === 0}
    <Alert tone="info">{t('aso:follow.playOff')}</Alert>
    <div><Button variant="ghost" onclick={oncancel}>{t('common:action.close')}</Button></div>
  {:else}
    <div class="row fields">
      {#if choices.length > 1}
        <div class="field">
          <label for="{uid}-store">{t('aso:label.store')}</label>
          <select id="{uid}-store" bind:value={appId}>
            {#each choices as m (m.id)}<option value={m.id}>{platformLabel(m.platform)}</option>{/each}
          </select>
        </div>
      {/if}
      <div class="field grow">
        <label for="{uid}-q">
          {store === 'app_store' ? t('aso:follow.searchLabel') : t('aso:follow.packageLabel')}
          <InfoTip label={t('aso:follow.whatLabel')} text={t('aso:follow.whatText')} />
        </label>
        <input
          id="{uid}-q"
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          aria-invalid={meaning.kind === 'badPackage' || meaning.kind === 'wrongStore'}
          aria-describedby="{uid}-hint"
          bind:value={query}
          {onkeydown}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <p class="hint" id="{uid}-hint">{store === 'app_store' ? t('aso:follow.hintAppStore') : t('aso:follow.hintPackage')}</p>
      </div>
      {#if store === 'app_store'}
        <div class="field">
          <label for="{uid}-country">{t('aso:label.country')}</label>
          <select id="{uid}-country" bind:value={country} onchange={() => (countryTouched = true)}>
            {#each countries as c (c)}<option value={c}>{formatDisplayName(c, 'region')} ({c.toUpperCase()})</option>{/each}
          </select>
        </div>
      {/if}
    </div>

    <p class="visually-hidden" aria-live="polite">{status === 'done' && meaning.kind === 'search' ? (results.length > 0 ? countText : t('aso:follow.emptyShort')) : ''}</p>

    {#if meaning.kind === 'badPackage'}<p class="field-error">{t('aso:follow.badPackage')}</p>{/if}
    {#if meaning.kind === 'wrongStore'}
      <p class="field-error">{meaning.ref.store === 'app_store' ? t('aso:follow.wrongStoreApple') : t('aso:follow.wrongStorePlay')}</p>
    {/if}

    {#if meaning.kind === 'ref'}
      <div class="resolved row">
        <span class="grow">{refText}</span>
        <Button type="button" variant="primary" loading={busy === 'ref'} onclick={addRef}>{t('aso:action.follow')}</Button>
      </div>
    {/if}

    {#if store === 'app_store' && meaning.kind === 'search'}
      {#if status === 'loading'}
        <div class="skeletons" aria-hidden="true">
          {#each [0, 1, 2] as n (n)}
            <div class="skeleton-row"><Skeleton width="40px" height="40px" /><div class="stack-tight"><Skeleton width="45%" height="14px" /><Skeleton width="70%" height="12px" /></div></div>
          {/each}
        </div>
        <p class="visually-hidden" role="status">{t('aso:follow.searching')}</p>
      {:else if status === 'error'}
        <Alert tone={offline ? 'warn' : 'error'}>{problem}</Alert>
        <div><Button type="button" icon="refresh" onclick={() => (retry += 1)}>{t('common:action.tryAgain')}</Button></div>
      {:else if status === 'done' && results.length === 0}
        <p class="empty">{t('aso:follow.empty', { term: searchedTerm, country: country.toUpperCase() })}</p>
      {/if}
    {/if}

    <ul id={listId} class="results" role="listbox" aria-label={t('aso:follow.results')} hidden={!showList}>
      {#each results as r, i (r.externalId)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          role="option"
          tabindex="-1"
          aria-selected={i === active}
          aria-disabled={r.state !== 'available'}
          class="result"
          class:active={i === active}
          class:off={r.state !== 'available'}
          onmousemove={() => (active = i)}
          onclick={() => addResult(r)}
        >
          {#if r.iconRef && target && !brokenIcons[r.externalId]}
            <img class="icon" src={searchImageUrl(workspaceId, target.id, r.iconRef, 96)} alt="" width="40" height="40" loading="lazy" onerror={() => (brokenIcons[r.externalId] = true)} />
          {:else}
            <AppIcon name={r.name} size={40} labelled={false} />
          {/if}
          <span class="body">
            <strong class="truncate">{r.name}</strong>
            <span class="muted truncate">{[r.developer, r.category].filter((x) => x !== null).join(' · ')}</span>
            <span class="muted">
              {#if r.ratingAverage !== null}{formatNumber(r.ratingAverage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★{#if r.ratingCount !== null}
                  ({t('aso:follow.ratings', { count: r.ratingCount })}){/if}{:else}{t('aso:follow.noRating')}{/if}{#if r.price !== null}
                · {priceText(r.price)}{/if}
            </span>
          </span>
          {#if r.state === 'followed'}<span class="tag">{t('aso:follow.stateFollowed')}</span>
          {:else if r.state === 'own'}<span class="tag">{t('aso:follow.stateOwn')}</span>
          {:else if busy === r.externalId}<span class="tag">{t('aso:follow.adding')}</span>{/if}
        </li>
      {/each}
    </ul>
    {#if showList}<p class="hint">{t('aso:follow.keys')}</p>{/if}

    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="row">
      <Button variant="ghost" onclick={oncancel}>{t('common:action.cancel')}</Button>
    </div>
  {/if}
</form>

<style>
  .fields {
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .grow {
    flex: 1;
    min-width: 16rem;
  }

  .resolved {
    gap: var(--space-3);
    align-items: center;
  }

  .skeletons {
    display: grid;
    gap: var(--space-3);
  }

  .skeleton-row {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .stack-tight {
    flex: 1;
    display: grid;
    gap: var(--space-2);
  }

  .empty {
    color: var(--muted);
    margin: 0;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
    max-height: 24rem;
    overflow-y: auto;
  }

  .results[hidden] {
    display: none;
  }

  .result {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .result.active {
    background: var(--surface-hover);
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }

  .result.off {
    cursor: default;
    opacity: 0.7;
  }

  .icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    flex: none;
  }

  .body {
    display: grid;
    min-width: 0;
    flex: 1;
    font-size: var(--text-sm);
  }

  .tag {
    flex: none;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    background: var(--chip-bg);
    color: var(--chip-ink);
  }
</style>
