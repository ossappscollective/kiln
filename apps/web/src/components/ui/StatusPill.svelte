<!--
  StatusPill: one line that says how things stand (a warning, an error, a state), with the details a
  click away. The pill is a button (aria-expanded). Text and icon say the status, not the color alone.
  Two ways to show the details:
  - with `children`, they open inline right under the pill;
  - without `children`, the pill only reports `open` (bind it) and `controls`, and the parent draws the
    details wherever it wants (for example under a toolbar), with that id.
  Props: tone = 'warn' | 'bad' | 'info' | 'ok' | 'neutral', label (the one line), open (bindable),
  stateKey? (kept in memory, lib/disclosure-state.ts), controls? (id of the details drawn by the parent),
  children? (the details).
-->
<script lang="ts">
  import { type Snippet, untrack } from 'svelte';
  import { recallExpanded, rememberExpanded } from '../../lib/disclosure-state.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import Icon from './Icon.svelte';

  let {
    tone = 'neutral',
    label,
    open = $bindable(false),
    stateKey,
    controls,
    children,
  }: {
    tone?: 'warn' | 'bad' | 'info' | 'ok' | 'neutral';
    label: string;
    open?: boolean;
    stateKey?: string;
    controls?: string;
    children?: Snippet;
  } = $props();

  const uid = $props.id();

  const remembered = untrack(() => recallExpanded(stateKey));
  if (remembered !== undefined) open = remembered;

  function toggle() {
    open = !open;
    rememberExpanded(stateKey, open);
  }
</script>

<div class="statuspill">
  <button
    type="button"
    class="bare pill {tone}"
    aria-expanded={open}
    aria-controls={children ? `${uid}-details` : controls}
    onclick={toggle}
  >
    <Icon name={toneIcon(tone)} size={14} />
    <span class="text">{label}</span>
    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
  </button>
  {#if children && open}
    <div class="details {tone}" id="{uid}-details">{@render children()}</div>
  {/if}
</div>

<style>
  .statuspill {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
    max-width: 100%;
  }

  .pill {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    max-width: 100%;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink);
    cursor: pointer;
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .pill .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--line-hover);
  }

  .pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .pill.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .pill.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .pill.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .pill.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .details {
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .details.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .details.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .details.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .details :global(p) {
    margin: 0;
  }
</style>
