<!--
  AddKeywords: the form that tracks keywords. Paste many (one per line, or separated by commas), pick one or
  more markets (a two letter storefront and a locale, which follows the country until it is edited), and,
  when both stores are in scope, the store. Each keyword is judged on its own by the server: duplicates and
  over-the-limit items do not stop the others. Nothing is checked when a keyword is added; "Check now" does it.
  Props: api, workspaceId, members (the app records in scope), config, ondone (called after something was
  added), oncancel.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    type AsoConfig,
    type MarketChoice,
    addItems,
    addSummaryText,
    asoErrorMessage,
    checkMarket,
    chunk,
    commonCountries,
    localeForCountry,
    parsePastedTerms,
    sumAddSummary,
  } from '../../lib/aso/aso.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { territoryName } from '../../lib/reviews/reviews.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    members,
    config,
    ondone,
    oncancel,
  }: { api: Api; workspaceId: string; members: AppSummary[]; config: AsoConfig | null; ondone: () => void; oncancel: () => void } = $props();

  const uid = $props.id();

  type MarketRow = { id: number; country: string; locale: string; edited: boolean };
  let text = $state('');
  let markets = $state<MarketRow[]>([{ id: 1, country: 'us', locale: 'en-US', edited: false }]);
  let nextId = 2;
  let tag = $state('');
  let priority = $state('2');
  let appId = $state('');
  let busy = $state(false);
  let error = $state('');
  let note = $state('');
  let tried = $state(false);

  const target = $derived(members.find((m) => m.id === appId) ?? members[0]);
  const parsed = $derived(parsePastedTerms(text));
  const checks = $derived(markets.map((m) => checkMarket(m.country, m.locale)));
  const validMarkets = $derived(checks.filter((c): c is MarketChoice => c !== null));
  const total = $derived(parsed.terms.length * validMarkets.length);
  const perRequest = $derived(config?.limits.maxKeywordsPerRequest ?? 50);
  const countsText = $derived.by(() => {
    const p = { toAdd: parsed.terms.length, repeated: parsed.duplicates, invalid: parsed.invalid.length };
    if (p.repeated > 0 && p.invalid > 0) return t('aso:add.counts.both', p);
    if (p.repeated > 0) return t('aso:add.counts.repeated', p);
    if (p.invalid > 0) return t('aso:add.counts.invalid', p);
    return t('aso:add.counts', p);
  });

  function setCountry(row: MarketRow, value: string) {
    row.country = value;
    if (!row.edited && /^[A-Za-z]{2}$/.test(value.trim())) row.locale = localeForCountry(value.trim());
  }

  function addMarket() {
    markets.push({ id: nextId++, country: '', locale: '', edited: false });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !target) return;
    tried = true;
    error = '';
    note = '';
    if (parsed.terms.length === 0 || validMarkets.length !== markets.length) return;
    busy = true;
    try {
      const items = addItems(parsed.terms, validMarkets, { tag, priority: Number(priority) });
      const sums = [];
      for (const part of chunk(items, perRequest)) sums.push((await api.addAsoKeywords(workspaceId, target.id, part)).summary);
      const sum = sumAddSummary(sums);
      const message = addSummaryText(sum, config?.limits.maxKeywordsPerApp);
      if (sum.created > 0) {
        toast.success(message);
        ondone();
      } else {
        note = message;
      }
    } catch (e) {
      error = asoErrorMessage(e, t('aso:err.addKeywords'));
    } finally {
      busy = false;
    }
  }
</script>

<form class="card add stack" onsubmit={submit} novalidate>
  <div class="field">
    <label for="{uid}-text">{t('aso:add.keywords')}</label>
    <textarea id="{uid}-text" rows="4" bind:value={text} placeholder={t('aso:add.placeholderTerms')} aria-invalid={tried && parsed.terms.length === 0}></textarea>
    <p class="hint">
      {t('aso:add.hintLines')}
      {#if parsed.terms.length > 0 || parsed.duplicates > 0 || parsed.invalid.length > 0}
        <span class="tabular">
          {countsText}
        </span>
      {/if}
      {#if parsed.invalid.length > 0}
        <InfoTip label={t('aso:add.invalidLabel')} align="start">
          <ul class="plain">
            {#each parsed.invalid.slice(0, 8) as bad, i (i)}<li><strong>{bad.text}</strong>: {bad.reason}</li>{/each}
          </ul>
        </InfoTip>
      {/if}
    </p>
    {#if tried && parsed.terms.length === 0}<p class="field-error">{t('aso:add.required')}</p>{/if}
  </div>

  <fieldset class="markets">
    <legend>
      {t('aso:add.markets')}
      <InfoTip label={t('aso:add.marketsLabel')} text={t('aso:add.marketsText')} />
    </legend>
    {#each markets as row, i (row.id)}
      <div class="row market">
        <div class="field">
          <label for="{uid}-c{row.id}">{t('aso:label.country')}</label>
          <input
            id="{uid}-c{row.id}"
            class="country"
            list="{uid}-countries"
            maxlength="2"
            autocomplete="off"
            value={row.country}
            oninput={(e) => setCountry(row, e.currentTarget.value)}
            aria-invalid={tried && checks[i] === null}
          />
        </div>
        <div class="field">
          <label for="{uid}-l{row.id}">{t('aso:label.locale')}</label>
          <input
            id="{uid}-l{row.id}"
            class="locale"
            maxlength="12"
            autocomplete="off"
            bind:value={row.locale}
            oninput={() => (row.edited = true)}
            aria-invalid={tried && checks[i] === null}
          />
        </div>
        {#if markets.length > 1}
          <Button variant="ghost" icon="x" iconOnly label={t('aso:add.removeMarket')} onclick={() => markets.splice(i, 1)} />
        {/if}
      </div>
    {/each}
    <datalist id="{uid}-countries">
      {#each commonCountries as c (c)}<option value={c}>{territoryName(c)}</option>{/each}
    </datalist>
    {#if tried && validMarkets.length !== markets.length}<p class="field-error">{t('aso:add.marketInvalid')}</p>{/if}
    <div><Button size="sm" icon="plus" variant="ghost" onclick={addMarket}>{t('aso:add.addMarket')}</Button></div>
  </fieldset>

  <div class="row options">
    {#if members.length > 1}
      <div class="field">
        <label for="{uid}-store">{t('aso:label.store')}</label>
        <select id="{uid}-store" bind:value={appId}>
          {#each members as m (m.id)}<option value={m.id}>{platformLabel(m.platform)}</option>{/each}
        </select>
      </div>
    {/if}
    <div class="field">
      <label for="{uid}-prio">{t('aso:label.priority')}</label>
      <select id="{uid}-prio" bind:value={priority}>
        <option value="3">{t('aso:priority.high')}</option>
        <option value="2">{t('aso:priority.normal')}</option>
        <option value="1">{t('aso:priority.low')}</option>
      </select>
    </div>
    <div class="field grow">
      <label for="{uid}-tag">{t('aso:label.tag')} <span class="muted">{t('aso:label.optional')}</span></label>
      <input id="{uid}-tag" maxlength="40" bind:value={tag} placeholder={t('aso:add.tagPlaceholder')} />
    </div>
  </div>

  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if note}<Alert tone="info">{note}</Alert>{/if}

  <div class="row">
    <Button type="submit" variant="primary" loading={busy} disabled={total === 0 && tried}>
      {total > 0 ? t('aso:add.submit', { count: total }) : t('aso:add.submitNone')}
    </Button>
    <Button variant="ghost" onclick={oncancel}>{t('common:action.cancel')}</Button>
    {#if total > perRequest}<span class="muted hint">{t('aso:add.requests', { count: Math.ceil(total / perRequest) })}</span>{/if}
  </div>
</form>

<style>
  .add {
    margin-bottom: var(--space-3);
  }

  .markets {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    border: 0;
  }

  .markets legend {
    padding: 0;
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .market,
  .options {
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .country {
    width: 5rem;
    text-transform: lowercase;
  }

  .locale {
    width: 8rem;
  }

  .grow {
    flex: 1;
    min-width: 10rem;
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }
</style>
