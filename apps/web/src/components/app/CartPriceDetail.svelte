<!--
  CartPriceDetail: what a staged price change is in the pending cart (docs/adr/0062-price-writes.md): per territory the price now and the
  price wanted, each in its own currency, with the change in percent in words (up or down, never colour alone); the date, the choice for
  existing subscribers and the acknowledgements that were given. Amounts of different currencies are never added: the summary counts lines
  per currency. Props: price (the staged change), open (show the territory list unfolded).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import { bpText, moneyChange, perCurrency } from '../../lib/prices.ts';
  import type { StagedPriceChange } from '../../lib/types.ts';

  let { price, open = false }: { price: StagedPriceChange; open?: boolean | undefined } = $props();

  const ACK_KEYS = {
    large_change: k('products:price.ack.largeChange'),
    large_absolute: k('products:price.ack.largeAbsolute'),
    existing_subscribers: k('products:price.ack.existingSubscribers'),
  } as const;
  const RULE_KEYS = {
    preserve: k('products:price.rule.preserve'),
    apply: k('products:price.rule.apply'),
    opt_in: k('products:price.rule.optIn'),
    opt_out: k('products:price.rule.optOut'),
    not_applicable: k('products:price.rule.notApplicable'),
  } as const;

  const currencies = $derived(perCurrency(price.lines));
  const DIRECTION_KEYS = {
    increase: k('products:price.direction.increase'),
    decrease: k('products:price.direction.decrease'),
    same: k('products:price.direction.same'),
  } as const;
  const directionText = (d: 'increase' | 'decrease' | 'same') => t(DIRECTION_KEYS[d]);
</script>

<div class="price" data-testid="cart-price-detail">
  <p class="summary">
    {t('app:cart.price.summary', { count: price.lines.length })}
    {#each currencies as c, i (c.currency)}{i > 0 ? '; ' : ' '}{t('app:cart.price.perCurrency', { currency: c.currency, up: c.up, down: c.down })}{/each}
  </p>
  <details {open}>
    <summary>{t('app:cart.price.territories', { count: price.lines.length })}</summary>
    <table class="compact">
      <caption class="visually-hidden">{t('app:cart.price.caption', { id: price.productId })}</caption>
      <thead>
        <tr>
          <th scope="col">{t('products:detail.colTerritory')}</th>
          <th scope="col">{t('app:cart.price.colChange')}</th>
          <th scope="col" class="num">{t('app:cart.price.colPercent')}</th>
        </tr>
      </thead>
      <tbody>
        {#each price.lines as l (l.territory)}
          <tr>
            <td><span class="mono">{l.territory}</span></td>
            <td>{moneyChange(l.before, l.after, l.currency)}</td>
            <td class="num {l.direction}">{bpText(l.percentBp)} <span class="dir">{directionText(l.direction)}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
  <p class="facts muted">
    {price.effectiveDate ? t('app:cart.price.from', { date: price.effectiveDate }) : t('app:cart.price.asap')}
    {#if price.kind === 'subscription'} · {t(RULE_KEYS[price.existingSubscribers])}{/if}
    {#if price.planId} · <span class="mono">{price.planId}</span>{/if}
  </p>
  {#if price.acknowledgements.length > 0}
    <p class="facts">{t('app:cart.price.acks')} {price.acknowledgements.map((a) => t(ACK_KEYS[a])).join('; ')}</p>
  {/if}
</div>

<style>
  .price {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .price p {
    margin: 0;
  }
  .facts {
    font-size: var(--text-sm);
  }
  summary {
    cursor: pointer;
    font-size: var(--text-sm);
  }
  table {
    width: 100%;
    margin-top: var(--space-1);
  }
  td.increase {
    color: var(--warn-ink);
  }
  td.decrease {
    color: var(--info-ink);
  }
  .dir {
    font-size: var(--text-xs);
  }
</style>
