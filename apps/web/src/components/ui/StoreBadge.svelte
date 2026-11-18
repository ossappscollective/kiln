<!--
  StoreBadge: identifies a store or tool with a small generic glyph and its name. The glyphs are
  plain geometric marks, not company logos; names belong to their owners and are used only to
  identify the service (see THIRD_PARTY_NOTICES.md).
  Props: store ('app_store' | 'google_play' | 'testflight' | 'github' | 'expo' | 'fastlane' | 'git'
  | 'generic'; an unknown id draws the neutral store), variant = 'chip' ('icon' glyph only, 'chip'
  glyph and short name, 'full' glyph and console name, e.g. App Store Connect), size = 'md'
  ('sm' | 'md'), tone = 'neutral' ('tinted' uses the store's one restrained accent: the info or ok
  status tint of the design system).
  The name is always there: visible text, or a title on the glyph for the icon variant. Color is
  never the only signal.
-->
<script lang="ts">
  import { type BadgeVariant, type StoreTint, storeBadgeText, storeById } from '../../lib/stores.ts';
  import Icon from './Icon.svelte';

  let {
    store,
    variant = 'chip',
    size = 'md',
    tone = 'neutral',
  }: {
    store: string;
    variant?: BadgeVariant;
    size?: 'sm' | 'md';
    tone?: 'neutral' | 'tinted';
  } = $props();

  const info = $derived(storeById(store));
  const text = $derived(storeBadgeText(info, variant));
  const tint = $derived<StoreTint>(tone === 'tinted' ? info.tint : 'neutral');
</script>

<span class="store {size} {tint}" class:bare={variant === 'icon'}>
  <Icon name={info.icon} size={size === 'sm' ? 'sm' : 'md'} title={text.iconNeedsTitle ? text.name : undefined} />
  {#if text.visible}<span class="name">{text.visible}</span>{/if}
</span>

<style>
  .store {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: 1.25rem;
    color: var(--ink);
    white-space: nowrap;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
  }

  .store.md {
    font-size: var(--text-sm);
    line-height: 1.5rem;
  }

  .store.bare {
    padding: 0 var(--space-1);
  }

  .store.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .store.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
</style>
