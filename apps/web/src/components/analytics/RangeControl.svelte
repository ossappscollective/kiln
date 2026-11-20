<!--
  RangeControl: the one filter row of the Analytics screen: Last 7, 28 or 90 days, or a custom range (two dates). It scopes
  every figure and chart below it, so the numbers always agree. Presets are quick; the custom range is behind a button and checked
  before it is applied (not in the future, start not after end, at most 400 days). The choice lives in the address (`?range=`
  or `?from=&to=`), so a link keeps it.
  Props: choice (the current RangeChoice), now (epoch ms), onchange (called with the new choice).
-->
<script lang="ts">
  import { dateToDay } from '@mrm/core';
  import { PRESET_DAYS, type RangeChoice, type ResolvedRange, customRangeProblem, formatDay, rangeText } from '../../lib/analytics/analytics.ts';
  import Button from '../ui/Button.svelte';

  let { choice, range, now, onchange }: { choice: RangeChoice; range: ResolvedRange; now: number; onchange: (next: RangeChoice) => void } = $props();

  const uid = $props.id();
  let editing = $state(false);
  let from = $state('');
  let to = $state('');
  let showError = $state(false);

  const today = $derived(dateToDay(now));
  const problem = $derived(showError ? customRangeProblem(from, to, now) : '');

  function openCustom() {
    from = choice.kind === 'custom' ? choice.from : range.from;
    to = choice.kind === 'custom' ? choice.to : range.to;
    showError = false;
    editing = true;
  }

  function apply(event: SubmitEvent) {
    event.preventDefault();
    showError = true;
    if (customRangeProblem(from, to, now) !== '') return;
    editing = false;
    onchange({ kind: 'custom', from, to });
  }
</script>

<div class="range">
  <div class="seg-group" role="group" aria-label="Date range">
    {#each PRESET_DAYS as days (days)}
      <button type="button" class="bare seg" aria-pressed={choice.kind === 'preset' && choice.days === days} onclick={() => { editing = false; onchange({ kind: 'preset', days }); }}>{days} days</button>
    {/each}
    <button type="button" class="bare seg" aria-pressed={choice.kind === 'custom' || editing} aria-expanded={editing} aria-controls="{uid}-custom" onclick={() => (editing ? (editing = false) : openCustom())}>Custom</button>
  </div>
  <span class="text muted">{rangeText(choice, range)}{choice.kind === 'preset' ? `, ${formatDay(range.from)} to ${formatDay(range.to)}` : ''}</span>
</div>

{#if editing}
  <form class="custom" id="{uid}-custom" onsubmit={apply} novalidate>
    <div class="field">
      <label for="{uid}-from">From</label>
      <input id="{uid}-from" type="date" max={today} bind:value={from} aria-invalid={problem ? 'true' : undefined} />
    </div>
    <div class="field">
      <label for="{uid}-to">To</label>
      <input id="{uid}-to" type="date" max={today} bind:value={to} aria-invalid={problem ? 'true' : undefined} />
    </div>
    <Button type="submit" variant="primary" size="sm">Apply</Button>
    <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
    {#if problem}<p class="field-error" role="alert">{problem}</p>{/if}
  </form>
{/if}

<style>
  .range {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .seg-group {
    display: inline-flex;
    padding: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .seg {
    min-height: calc(var(--control-md) - 6px);
    padding: 0 var(--space-3);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border-radius: calc(var(--radius-md) - 2px);
  }

  .seg:hover {
    color: var(--ink);
  }

  .seg[aria-pressed='true'] {
    color: var(--ink);
    background: var(--surface);
    box-shadow: var(--shadow-xs);
  }

  .seg:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .text {
    font-size: var(--text-sm);
  }

  .custom {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
    margin-top: var(--space-3);
  }

  .custom .field {
    margin: 0;
  }

  .field-error {
    flex-basis: 100%;
    margin: 0;
  }
</style>
