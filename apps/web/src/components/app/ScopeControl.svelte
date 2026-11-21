<!--
  ScopeControl: the platform scope of an app, iOS | macOS | Android | Both (All from three platforms), top right of every app page.
  A side the app does not have is disabled with a reason. The choice goes into the address
  (`?platform=`), so every tab of the app shares it.
  Props: options (from resolveScope), scope (the active one), onchange.
-->
<script lang="ts">
  import type { PlatformScope, ScopeOption } from '../../lib/app-scope.ts';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let { options, scope, onchange }: { options: ScopeOption[]; scope: PlatformScope; onchange: (scope: PlatformScope) => void } = $props();

</script>

<div class="scope" role="group" aria-label="Platform">
  {#each options as o (o.id)}
    <button
      type="button"
      class="bare seg"
      aria-pressed={scope === o.id}
      disabled={o.disabled}
      title={o.disabled ? o.reason : undefined}
      onclick={() => onchange(o.id)}
    >
      {#if o.id === 'both'}
        <Icon name="layers" size={16} />
        {o.label}
      {:else}
        <PlatformBadge platform={o.id} />
      {/if}
    </button>
  {/each}
</div>

<style>
  .scope {
    display: inline-flex;
    padding: 2px;
    background: var(--seg-track);
    border-radius: var(--radius-md);
  }

  .seg {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    min-height: calc(var(--control-md) - 6px);
    padding: 0 var(--space-3);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border-radius: calc(var(--radius-md) - 2px);
  }

  .seg:hover:not(:disabled) {
    color: var(--ink);
  }

  .seg[aria-pressed='true'] {
    color: var(--ink);
    background: var(--seg-selected);
    box-shadow: var(--seg-selected-ring);
  }

  .seg:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .seg:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }
</style>
