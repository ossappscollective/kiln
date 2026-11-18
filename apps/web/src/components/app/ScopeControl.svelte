<!--
  ScopeControl: the platform scope of an app, iOS | Android | Both, top right of every app page.
  A side the app does not have is disabled with a reason. The choice goes into the address
  (`?platform=`), so every tab of the app shares it.
  Props: options (from resolveScope), scope (the active one), onchange.
-->
<script lang="ts">
  import type { PlatformScope, ScopeOption } from '../../lib/app-scope.ts';
  import Icon from '../ui/Icon.svelte';

  let { options, scope, onchange }: { options: ScopeOption[]; scope: PlatformScope; onchange: (scope: PlatformScope) => void } = $props();

  const icons = { ios: 'platform-ios', android: 'platform-android', both: 'layers' } as const;
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
      <Icon name={icons[o.id]} size={16} />
      {o.label}
    </button>
  {/each}
</div>

<style>
  .scope {
    display: inline-flex;
    padding: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
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
    background: var(--surface);
    box-shadow: var(--shadow-xs);
  }

  .seg:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .seg:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
