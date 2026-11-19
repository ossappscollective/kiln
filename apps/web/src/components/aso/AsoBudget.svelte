<!--
  AsoBudget: how much of each searched listing field one locale uses, as thin bars with a number: the App Store name
  and subtitle (30 characters) and keyword field (100 bytes), or the Google Play title (30), short description (80)
  and full description (4000). Quiet by design: the bars and one muted line show here, and a popover holds the
  details: which tracked keywords are in which field, what is wasted (spaces after commas, repeated or plural
  entries, words the name or subtitle already hold), words in several fields, words no tracked keyword uses,
  tracked keywords that are in no field, and the storefronts that are reported to read other locales
  (UNVERIFIED: Apple does not state it). The sums are worked out in `@mrm/core` (`listingBudget`); nothing here
  reads a store or changes a listing, and no number is a search volume.
  Props: platform, locale, fields (the text of the locale: the store copy with staged text on top), staged? (the
  fields whose text is staged), keywords (the keywords tracked in this locale), listingLocales? (every locale of
  the listing, for the storefront hint), countries? (storefronts tracked in this locale), addHref? (where to add
  keywords), title? (the heading, default "Keyword budget").
-->
<script lang="ts">
  import { type AsoPlatform, type FitField, type FitFields, type FitKeyword, isApplePlatform, listingBudget, storefrontCombos } from '@mrm/core';
  import { budgetHeadline, fieldWord, wasteReasonText } from '../../lib/aso-budget.ts';
  import CopyButton from '../ui/CopyButton.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import BudgetMeter from './BudgetMeter.svelte';

  let {
    platform,
    locale,
    fields,
    staged = [],
    keywords,
    listingLocales = [],
    countries = [],
    addHref,
    title = 'Keyword budget',
  }: {
    platform: AsoPlatform;
    locale: string;
    fields: FitFields;
    staged?: FitField[];
    keywords: FitKeyword[];
    listingLocales?: string[];
    countries?: string[];
    addHref?: string;
    title?: string;
  } = $props();

  const budget = $derived(listingBudget({ platform, locale, fields, keywords }));
  const headline = $derived(budgetHeadline(budget));
  const apple = $derived(isApplePlatform(platform));
  const labelOf = (field: FitField): string => budget.fields.find((f) => f.field === field)?.label ?? fieldWord(field);
  const combos = $derived(apple ? countries.map((c) => storefrontCombos(c, listingLocales)).filter((c) => c.locales.length > 1) : []);
  const uid = $props.id();
</script>

<div class="budget" role="group" aria-label="{title}, {locale}">
  <div class="head">
    <span class="eyebrow">{title}</span>
    <InfoTip label="Details of the keyword budget" align="start" width="30rem">
      <div class="tip stack tight">
        <section aria-label="Tracked keywords by field">
          <h4>Tracked keywords by field</h4>
          {#if keywords.length === 0}
            <p class="muted">
              No keywords are tracked in {locale}.
              {#if addHref}<a href={addHref}>Add keywords</a>{/if}
            </p>
          {:else}
            <ul class="plain">
              {#each budget.fields as f (f.field)}
                <li><strong>{f.label}:</strong> {f.keywords.length > 0 ? f.keywords.map((k) => k.term).join(', ') : 'none'}</li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if budget.keywordField && budget.keywordField.items.length > 0}
          {@const kf = budget.keywordField}
          <section aria-label="Wasted space in the keyword field">
            <h4>Wasted in the keyword field ({kf.totalBytes} {kf.totalBytes === 1 ? 'byte' : 'bytes'})</h4>
            <ul class="plain">
              {#each kf.items as item, i (i)}
                <li>{item.text === '' ? '(empty)' : item.text}: {wasteReasonText[item.reason]}, {item.bytes} {item.bytes === 1 ? 'byte' : 'bytes'}</li>
              {/each}
            </ul>
            <p class="row compact-row">
              <span class="muted">Without them ({kf.compactedBytes} bytes):</span>
              <code class="truncate">{kf.compacted === '' ? '(empty)' : kf.compacted}</code>
              {#if kf.compacted !== ''}<CopyButton value={kf.compacted} iconOnly label="Copy the keyword field without the waste" />{/if}
            </p>
          </section>
        {/if}

        {#if budget.repeated.length > 0}
          <section aria-label="Words in several fields">
            <h4>{apple ? 'Words in more than one field' : 'Tracked terms in more than one field'}</h4>
            <ul class="plain">
              {#each budget.repeated as r (r.word)}
                <li>
                  {r.word}: {r.fields.map(labelOf).join(', ')}{r.wastedCharacters > 0 ? ` (${r.wastedCharacters} characters in the later ${r.fields.length > 2 ? 'fields' : 'field'})` : ''}
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if budget.missing.length > 0 || budget.partial.length > 0}
          <section aria-label="Tracked keywords the fields lack">
            <h4>Tracked keywords not covered</h4>
            <ul class="plain">
              {#if budget.missing.length > 0}<li>In no field: {budget.missing.map((m) => m.term).join(', ')}</li>{/if}
              {#if budget.partial.length > 0}<li>Only some words: {budget.partial.map((m) => m.term).join(', ')}</li>{/if}
            </ul>
          </section>
        {/if}

        {#if budget.untracked.length > 0}
          <section aria-label="Words no tracked keyword uses">
            <h4>Words no tracked keyword uses</h4>
            <ul class="plain">
              {#each budget.untracked as u (u.field)}<li><strong>{u.label}:</strong> {u.terms.join(', ')}</li>{/each}
            </ul>
            <p class="muted">A brand name in the name is fine. Track a word to see where the app ranks for it.</p>
          </section>
        {/if}

        {#if combos.length > 0}
          <section aria-label="Storefronts">
            <h4>Storefronts (UNVERIFIED)</h4>
            <ul class="plain">
              {#each combos as c (c.country)}
                <li>
                  {c.country.toUpperCase()}: reported to also read
                  {#each c.locales.filter((l) => l.kind === 'reported') as l, i (l.locale)}{i > 0 ? ', ' : ' '}{l.locale} ({l.present ? 'in your listing' : 'no text yet'}){/each}
                </li>
              {/each}
            </ul>
            <p class="muted">{combos[0]?.note}</p>
          </section>
        {/if}

        <section aria-label="What is assumed">
          <h4>What is assumed</h4>
          <ul class="plain">{#each budget.assumptions as a (a)}<li>{a}</li>{/each}</ul>
        </section>
      </div>
    </InfoTip>
  </div>

  <div class="rows">
    {#each budget.fields as f (f.field)}
      <BudgetMeter
        id="{uid}-{f.field}"
        label={f.label}
        suffix={staged.indexOf(f.field) >= 0 ? ' (staged)' : ''}
        used={f.used}
        limit={f.limit}
        unit={f.unit}
        remaining={f.remaining}
        over={f.over}
        percent={f.percent}
      />
    {/each}
  </div>
  {#if headline}<p class="muted headline">{headline}</p>{/if}
</div>

<style>
  .budget {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  .head {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .headline {
    margin: 0;
    font-size: var(--text-xs);
  }

  .tip h4 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
  }

  .tip p {
    margin: 0 0 var(--space-1);
  }

  .plain {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .compact-row {
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
  }
</style>
