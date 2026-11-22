<!--
  JumpTo: a row of buttons that scroll to a part of the same page ("Jump to: Store refresh, Reviews, Releases"). Buttons, not links:
  the address is a hash route, so `#section` would change the page. The target is an element id on the page; focus moves to the
  target so a keyboard user continues there. Props: sections ({ id, label }[]; nothing is drawn for fewer than two), label (the
  accessible name of the group).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { SettingsSection } from '../../lib/settings-views.ts';

  let { sections, label }: { sections: readonly SettingsSection[]; label?: string | undefined } = $props();

  function go(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }
</script>

{#if sections.length > 1}
  <nav class="jump" aria-label={label ?? t('settings:jump.label')}>
    <span class="lead">{t('settings:jump.lead')}</span>
    {#each sections as s (s.id)}
      <button type="button" class="bare chip" onclick={() => go(s.id)}>{s.label}</button>
    {/each}
  </nav>
{/if}

<style>
  .jump {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-4);
  }

  .lead {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .chip {
    padding: var(--space-1) var(--space-3);
    font-size: 0.9375rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
  }

  .chip:hover {
    background: var(--surface-sunken);
  }
</style>
