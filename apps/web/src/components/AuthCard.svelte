<script lang="ts">
  import type { Snippet } from 'svelte';
  import Logo from './ui/Logo.svelte';
  import ThemeToggle from './ui/ThemeToggle.svelte';
  import { productName } from './ui/brand.ts';
  import './auth-form.css';

  let {
    title,
    subtitle,
    children,
    footer,
  }: { title: string; subtitle?: string | undefined; children: Snippet; footer?: Snippet | undefined } = $props();
</script>

<main class="page">
  <div class="column">
    <div class="brand">
      <Logo size={40} />
      <p class="product">{productName}</p>
      <p class="tagline muted">iOS and Android releases, from one place.</p>
    </div>
    <div class="card panel readable-form">
      <h1 class="gradient-title">{title}</h1>
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
    background: var(--ambient) no-repeat;
    place-items: center;
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 440px;
  }

  .brand {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: center;
    margin-bottom: var(--space-6);
    text-align: center;
  }

  .brand :global(.logo) {
    margin-bottom: var(--space-2);
  }

  .product {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.0625rem;
    font-weight: var(--weight-display);
  }

  .tagline {
    margin: 0;
    font-size: 0.9375rem;
  }

  .panel {
    padding: var(--space-8);
    box-shadow: var(--shadow-card);
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
    line-height: 1.2;
  }

  .subtitle {
    margin: var(--space-3) 0 0;
    font-size: 1rem;
    line-height: 1.5;
  }

  .content {
    margin-top: var(--space-8);
  }

  .footer {
    margin-top: var(--space-5);
    font-size: 0.9375rem;
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

    h1 {
      font-size: 1.5rem;
    }

    .content {
      margin-top: var(--space-6);
    }
  }
</style>
