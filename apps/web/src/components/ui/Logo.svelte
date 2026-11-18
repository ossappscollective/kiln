<!--
  Logo: the product mark, an upward double chevron in a rounded square (a release moving up).
  Props: size = 32 (px), wordmark (shows the product name beside the mark), title? (accessible
  name when the mark stands alone; without it the mark is decorative).
-->
<script lang="ts">
  import { productName } from './brand.ts';

  let {
    size = 32,
    wordmark = false,
    title,
  }: { size?: number; wordmark?: boolean; title?: string } = $props();
</script>

<span class="logo">
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden={title && !wordmark ? undefined : 'true'}
    role={title && !wordmark ? 'img' : undefined}
    focusable="false"
  >
    {#if title && !wordmark}<title>{title}</title>{/if}
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M9 14.5 16 8l7 6.5" stroke="var(--accent-ink)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M9 22.5 16 16l7 6.5" stroke="var(--accent-ink)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" />
  </svg>
  {#if wordmark}<span class="name">{productName}</span>{/if}
</span>

<style>
  .logo {
    display: inline-flex;
    gap: var(--space-3);
    align-items: center;
    min-width: 0;
  }

  svg {
    flex: none;
  }

  .name {
    overflow: hidden;
    font-weight: var(--weight-semibold);
    color: var(--ink);
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
</style>
