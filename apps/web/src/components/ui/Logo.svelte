<!--
  Logo: the Kiln mark, two nested arches (a kiln door) with a glow, on a dark rounded square. The colours are the mark's own and do not follow the theme.
  Props: size = 32 (px), wordmark (shows the product name beside the mark), title? (accessible
  name when the mark stands alone; without it the mark is decorative).
-->
<script lang="ts">
  import { productName } from './brand.ts';

  let {
    size = 32,
    wordmark = false,
    title,
  }: { size?: number | undefined; wordmark?: boolean | undefined; title?: string | undefined } = $props();

  const uid = $props.id();
</script>

<span class="logo">
  <svg
    width={size}
    height={size}
    viewBox="0 0 120 120"
    fill="none"
    aria-hidden={title && !wordmark ? undefined : 'true'}
    role={title && !wordmark ? 'img' : undefined}
    focusable="false"
  >
    {#if title && !wordmark}<title>{title}</title>{/if}
    <defs>
      <linearGradient id="{uid}-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#171b3d" /><stop offset="1" stop-color="#0b0d22" /></linearGradient>
      <linearGradient id="{uid}-fg" gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="0" y2="100">
        <stop offset="0" stop-color="#7f99ff" /><stop offset="0.55" stop-color="#a98bff" /><stop offset="1" stop-color="#ffb04a" />
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="30" fill="url(#{uid}-bg)" />
    <path d="M32 94V56a28 28 0 0 1 56 0v38" stroke="url(#{uid}-fg)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M48 94V64a12 12 0 0 1 24 0v30" stroke="url(#{uid}-fg)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
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
