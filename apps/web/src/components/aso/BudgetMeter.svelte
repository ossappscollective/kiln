<!--
  BudgetMeter: one thin bar with a number, for a text against its limit: "Keyword field  ====----  62/100". It is the line AsoBudget draws for
  each field of a listing, and the same bar shows a proposed text against the limit of its field (an AI suggestion), so a person sees at a
  glance whether it fits. Over the limit is red, within a tenth of it is amber, and the number says the same in words (color is never alone).
  Props: id (the id of the label, for aria-labelledby), label, used, limit, unit ('characters' | 'bytes'), remaining, over, percent (0 to 100),
  suffix? (small text after the label, for example " (staged)").
-->
<script lang="ts">
  import { meterNumber, meterTitle, meterTone } from '../../lib/aso-budget.ts';

  let {
    id,
    label,
    used,
    limit,
    unit,
    remaining,
    over,
    percent,
    suffix = '',
  }: {
    id: string;
    label: string;
    used: number;
    limit: number;
    unit: 'characters' | 'bytes';
    remaining: number;
    over: boolean;
    percent: number;
    suffix?: string;
  } = $props();

  const f = $derived({ used, limit, unit, remaining, over });
  const tone = $derived(meterTone(f));
</script>

<div class="line">
  <span class="lab" {id}>{label}{#if suffix}<span class="suffix">{suffix}</span>{/if}</span>
  <svg class="meter {tone}" viewBox="0 0 100 4" preserveAspectRatio="none" role="meter" aria-valuemin="0" aria-valuemax={limit} aria-valuenow={used} aria-labelledby={id} aria-valuetext={meterTitle(f)}>
    <rect x="0" y="0" width="100" height="4" class="track" />
    <rect x="0" y="0" width={percent} height="4" class="fill" />
  </svg>
  <span class="num tabular {tone}" title={meterTitle(f)}>{meterNumber(f)}{#if over}<span class="visually-hidden"> over the limit</span>{/if}</span>
</div>

<style>
  .line {
    display: grid;
    grid-template-columns: 8.5rem minmax(0, 1fr) 4.5rem;
    gap: var(--space-3);
    align-items: center;
  }

  .lab {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .suffix {
    font-size: var(--text-xs);
  }

  .num {
    text-align: right;
  }

  .num.ok {
    color: var(--muted);
  }

  .num.warn {
    color: var(--warn-ink);
  }

  .num.bad {
    color: var(--bad-ink);
  }

  .meter {
    display: block;
    width: 100%;
    height: 4px;
    border-radius: var(--radius-full);
  }

  .meter .track {
    fill: var(--surface-sunken);
  }

  .meter.ok .fill {
    fill: var(--muted);
  }

  .meter.warn .fill {
    fill: var(--warn);
  }

  .meter.bad .fill {
    fill: var(--bad);
  }
</style>
