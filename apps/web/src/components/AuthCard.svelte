<script lang="ts">
  import type { Snippet } from 'svelte';
  import Logo from './ui/Logo.svelte';
  import ThemeToggle from './ui/ThemeToggle.svelte';
  import { productName } from './ui/brand.ts';

  let {
    title,
    subtitle,
    children,
    footer,
  }: { title: string; subtitle?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<main class="page">
  <div class="column">
    <div class="brand">
      <Logo size={40} />
      <p class="product">{productName}</p>
    </div>
    <div class="card panel">
      <h1>{title}</h1>
      {#if subtitle}<p class="muted subtitle">{subtitle}</p>{/if}
      <div class="content">{@render children()}</div>
    </div>
    {#if footer}<div class="footer muted">{@render footer()}</div>{/if}
    <div class="theme no-print"><ThemeToggle compact /></div>
  </div>
</main>

<style>
  .page {
    display: grid;
    min-height: 100vh;
    min-height: 100dvh;
    padding: var(--space-8) var(--space-4);
    place-items: center;
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 400px;
  }

  .brand {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-6);
    text-align: center;
  }

  .product {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
  }

  .panel {
    padding: var(--space-8);
    box-shadow: var(--shadow-sm);
  }

  h1 {
    font-size: var(--text-xl);
    line-height: 1.75rem;
  }

  .subtitle {
    margin-top: var(--space-2);
    line-height: 1.5;
  }

  .content {
    margin-top: var(--space-6);
  }

  .footer {
    margin-top: var(--space-4);
    font-size: var(--text-sm);
    text-align: center;
  }

  .theme {
    display: flex;
    justify-content: center;
    margin-top: var(--space-6);
  }

  @media (max-width: 479px) {
    .page {
      padding: var(--space-6) var(--space-4);
    }

    .panel {
      padding: var(--space-6) var(--space-5);
    }
  }
</style>
