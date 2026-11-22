<!--
  AsoBudget: how much of each searched listing field one locale uses, as thin bars with a number: the App Store name
  and subtitle (30 characters) and keyword field (100 bytes), or the Google Play title (30), short description (80)
  and full description (4000). Quiet by design: the bars and one muted line show here, and a popover holds the
  details: which tracked keywords are in which field, what is wasted (spaces after commas, repeated or plural
  entries, words the name or subtitle already hold), words in several fields, words no tracked keyword uses,
  tracked keywords that are in no field, and the storefronts that are reported to read other locales
  (UNVERIFIED: Apple does not state it). The sums are worked out in `@kiln/core` (`listingBudget`); nothing here
  reads a store or changes a listing, and no number is a search volume.
  Props: platform, locale, fields (the text of the locale: the store copy with staged text on top), staged? (the
  fields whose text is staged), keywords (the keywords tracked in this locale), listingLocales? (every locale of
  the listing, for the storefront hint), countries? (storefronts tracked in this locale), addHref? (where to add
  keywords), title? (the heading, default "Keyword budget").
-->
<script lang="ts">
  import { type AsoPlatform, type FitField, type FitFields, type FitKeyword, listingBudget, storefrontCombos, supports } from '@kiln/core';
  import { budgetFieldLabel, budgetHeadline, wasteReasonText } from '../../lib/aso/budget.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
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
    title }: {
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
  const apple = $derived(supports(platform, 'keywordField'));
  const heading = $derived(title ?? t('aso:budget.title'));
  const labelOf = (field: FitField): string => budgetFieldLabel(platform, field);
  const bytesText = (n: number): string => t('aso:budget.bytes', { count: n });
  const termList = (terms: string[]): string => formatList(terms, { type: 'unit' });
  const laterText = (r: { word: string; fields: FitField[]; wastedCharacters: number }): string => {
    const fields = termList(r.fields.map(labelOf));
    if (r.wastedCharacters <= 0) return t('aso:budget.repeatedItem', { word: r.word, fields });
    return r.fields.length > 2
      ? t('aso:budget.repeatedLaterMany', { word: r.word, fields, count: r.wastedCharacters })
      : t('aso:budget.repeatedLater', { word: r.word, fields, count: r.wastedCharacters });
  };
  const storefrontText = (c: { country: string; locales: { locale: string; kind: string; present: boolean }[] }): string =>
    t('aso:budget.storefrontLine', {
      country: c.country.toUpperCase(),
      locales: termList(
        c.locales
          .filter((l) => l.kind === 'reported')
          .map((l) => (l.present ? t('aso:budget.storefrontPresent', { locale: l.locale }) : t('aso:budget.storefrontAbsent', { locale: l.locale }))),
      ),
    });
  const combos = $derived(apple ? countries.map((c) => storefrontCombos(c, listingLocales)).filter((c) => c.locales.length > 1) : []);
  const uid = $props.id();
</script>

<div class="budget" role="group" aria-label={t('aso:budget.group', { title: heading, locale })}>
  <div class="head">
    <span class="eyebrow">{heading}</span>
    <InfoTip label={t('aso:budget.details')} align="start" width="30rem">
      <div class="tip stack tight">
        <section aria-label={t('aso:budget.byField')}>
          <h4>{t('aso:budget.byField')}</h4>
          {#if keywords.length === 0}
            <p class="muted">
              {t('aso:budget.noneTracked', { locale })}
              {#if addHref}<a href={addHref}>{t('aso:budget.addKeywords')}</a>{/if}
            </p>
          {:else}
            <ul class="plain">
              {#each budget.fields as f (f.field)}
                <li><strong>{t('aso:budget.fieldLabel', { label: labelOf(f.field) })}</strong> {f.keywords.length > 0 ? f.keywords.map((k) => k.term).join(', ') : t('aso:budget.none')}</li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if budget.keywordField && budget.keywordField.items.length > 0}
          {@const kf = budget.keywordField}
          <section aria-label={t('aso:budget.wasteAria')}>
            <h4>{t('aso:budget.wasteTitle', { count: kf.totalBytes })}</h4>
            <ul class="plain">
              {#each kf.items as item, i (i)}
                <li>{t('aso:budget.wasteItem', { text: item.text === '' ? t('aso:budget.empty') : item.text, reason: t(wasteReasonText[item.reason]), bytes: bytesText(item.bytes) })}</li>
              {/each}
            </ul>
            <p class="row compact-row">
              <span class="muted">{t('aso:budget.without', { count: kf.compactedBytes })}</span>
              <code class="truncate">{kf.compacted === '' ? t('aso:budget.empty') : kf.compacted}</code>
              {#if kf.compacted !== ''}<CopyButton value={kf.compacted} iconOnly label={t('aso:budget.copyCompact')} />{/if}
            </p>
          </section>
        {/if}

        {#if budget.repeated.length > 0}
          <section aria-label={t('aso:budget.repeatedAria')}>
            <h4>{apple ? t('aso:budget.repeatedApple') : t('aso:budget.repeatedPlay')}</h4>
            <ul class="plain">
              {#each budget.repeated as r (r.word)}
                <li>{laterText(r)}</li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if budget.missing.length > 0 || budget.partial.length > 0}
          <section aria-label={t('aso:budget.missingAria')}>
            <h4>{t('aso:budget.missingTitle')}</h4>
            <ul class="plain">
              {#if budget.missing.length > 0}<li>{t('aso:budget.inNoField', { terms: termList(budget.missing.map((m) => m.term)) })}</li>{/if}
              {#if budget.partial.length > 0}<li>{t('aso:budget.onlySome', { terms: termList(budget.partial.map((m) => m.term)) })}</li>{/if}
            </ul>
          </section>
        {/if}

        {#if budget.untracked.length > 0}
          <section aria-label={t('aso:budget.untracked')}>
            <h4>{t('aso:budget.untracked')}</h4>
            <ul class="plain">
              {#each budget.untracked as u (u.field)}<li><strong>{t('aso:budget.fieldLabel', { label: labelOf(u.field) })}</strong> {u.terms.join(', ')}</li>{/each}
            </ul>
            <p class="muted">{t('aso:budget.untrackedNote')}</p>
          </section>
        {/if}

        {#if combos.length > 0}
          <section aria-label={t('aso:budget.storefrontsAria')}>
            <h4>{t('aso:budget.storefronts')}</h4>
            <ul class="plain">
              {#each combos as c (c.country)}
                <li>{storefrontText(c)}</li>
              {/each}
            </ul>
            <p class="muted">{combos[0]?.note}</p>
          </section>
        {/if}

        <section aria-label={t('aso:budget.assumed')}>
          <h4>{t('aso:budget.assumed')}</h4>
          <ul class="plain">{#each budget.assumptions as a (a)}<li>{a}</li>{/each}</ul>
        </section>
      </div>
    </InfoTip>
  </div>

  <div class="rows">
    {#each budget.fields as f (f.field)}
      <BudgetMeter
        id="{uid}-{f.field}"
        label={labelOf(f.field)}
        suffix={staged.indexOf(f.field) >= 0 ? t('aso:budget.staged') : ''}
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
    font-size: var(--text-sm);
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
