<!--
  StatChip: a count with its label as one small chip, for a row of numbers (apps in review, new
  reviews, triage). A zero is dimmed, or hidden with `hideZero`, so the numbers that matter stand out.
  Props: label, value (number or text), tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info', hideZero,
  dim (draw it as a zero even when it is not, for "not available"), href? (a link), onclick? (a button; `pressed` marks the selected one).
-->
<script lang="ts">
  let {
    label,
    value,
    tone = 'neutral',
    hideZero = false,
    dim = false,
    href,
    onclick,
    pressed,
  }: {
    label: string;
    value: number | string;
    tone?: 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | undefined;
    hideZero?: boolean | undefined;
    dim?: boolean | undefined;
    href?: string | undefined;
    onclick?: (() => void) | undefined;
    pressed?: boolean | undefined;
  } = $props();

  const zero = $derived(dim || value === 0 || value === '0');
</script>

{#if !(hideZero && zero && !dim)}
  {#if href}
    <a class="statchip {tone}" class:zero {href}><span class="v tabular">{value}</span> <span class="l">{label}</span></a>
  {:else if onclick}
    <button type="button" class="bare statchip {tone}" class:zero aria-pressed={pressed} {onclick}>
      <span class="v tabular">{value}</span> <span class="l">{label}</span>
    </button>
  {:else}
    <span class="statchip {tone}" class:zero><span class="v tabular">{value}</span> <span class="l">{label}</span></span>
  {/if}
{/if}

<style>
  .statchip {
    display: inline-flex;
    gap: var(--space-2);
    align-items: baseline;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    line-height: calc(var(--control-sm) - 2px);
    color: var(--ink);
    text-decoration: none;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .v {
    font-weight: var(--weight-semibold);
  }

  .l {
    color: var(--muted);
  }

  .statchip.zero {
    background: transparent;
    border-color: var(--line);
  }

  .statchip.zero .v,
  .statchip.zero .l {
    color: var(--muted);
    font-weight: var(--weight-regular);
  }

  .statchip.ok:not(.zero) {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .statchip.bad:not(.zero) {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .statchip.warn:not(.zero) {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .statchip.info:not(.zero) {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .statchip:not(.zero) .l {
    color: inherit;
  }

  a.statchip:hover,
  button.statchip:hover {
    border-color: var(--line-hover);
  }

  button.statchip {
    cursor: pointer;
  }

  button.statchip[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .statchip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
