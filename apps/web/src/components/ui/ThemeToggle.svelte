<!--
  ThemeToggle: choose Auto, Light or Dark. The choice is remembered in localStorage.
  Props: compact (icons only, with the names as accessible labels), block (fill the width).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { k, t } from '../../lib/i18n/t.ts';
  import { type ThemePref, getThemePref, onThemePref, setThemePref, themePrefs } from '../../lib/theme.ts';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  let { compact = false, block = false }: { compact?: boolean | undefined; block?: boolean | undefined } = $props();

  let pref = $state<ThemePref>(getThemePref());
  onMount(() => {
    pref = getThemePref();
    return onThemePref((p) => (pref = p));
  });

  const options: Record<ThemePref, { label: string; icon: IconName }> = {
    auto: { label: k('common:theme.auto'), icon: 'monitor' },
    light: { label: k('common:theme.light'), icon: 'sun' },
    dark: { label: k('common:theme.dark'), icon: 'moon' },
  };
</script>

<div class="toggle" class:block role="group" aria-label={t('common:theme.label')}>
  {#each themePrefs as p (p)}
    <button
      type="button"
      class="bare opt"
      aria-pressed={pref === p}
      aria-label={compact ? t(options[p].label) : undefined}
      title={compact ? t(options[p].label) : undefined}
      onclick={() => setThemePref(p)}
    >
      <Icon name={options[p].icon} />
      {#if !compact}<span>{t(options[p].label)}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    background: var(--seg-track);
    border-radius: var(--radius-md);
  }

  .toggle.block {
    display: flex;
  }

  .opt {
    flex: 1;
    gap: var(--space-1);
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border-radius: calc(var(--radius-md) - 2px);
    transition:
      background-color var(--duration-fast) var(--ease),
      color var(--duration-fast) var(--ease);
  }

  .opt:hover {
    color: var(--ink);
  }

  .opt[aria-pressed='true'] {
    color: var(--ink);
    background: var(--seg-selected);
    box-shadow: var(--seg-selected-ring);
  }
</style>
