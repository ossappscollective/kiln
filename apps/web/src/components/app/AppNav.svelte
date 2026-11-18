<!--
  AppNav: the left panel while an app is open. It replaces the workspace navigation, so the whole
  UI is scoped to the app. Each link keeps the platform scope of the address.
  Props: address (the open app: id, section, platform), allowed (does the role have this action).
-->
<script lang="ts">
  import type { Action } from '@mrm/core';
  import { appContext } from '../../lib/address.svelte.ts';
  import { type AppAddress, appAddress, visibleSections } from '../../lib/app-scope.ts';
  import { portfolioHref } from '../../lib/portfolio.ts';
  import Icon from '../ui/Icon.svelte';

  let { address, allowed }: { address: AppAddress; allowed: (action: Action) => boolean } = $props();

  const sections = $derived(visibleSections(allowed));
</script>

<div class="app-nav">
  <a class="back" href={portfolioHref}><Icon name="chevron-left" size={16} /> All apps</a>
  {#if appContext.name}<p class="name" title={appContext.name}>{appContext.name}</p>{/if}
  <nav aria-label="This app">
    <ul>
      {#each sections as s (s.id)}
        <li>
          <a href={appAddress(address.id, s.id, address.platform)} aria-current={address.section === s.id ? 'page' : undefined}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>
</div>

<style>
  .app-nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .back {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-2);
    font-weight: var(--weight-medium);
  }

  .name {
    margin: 0;
    padding: 0 var(--space-3);
    overflow: hidden;
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  nav a {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
    transition:
      background-color var(--duration-fast) var(--ease),
      color var(--duration-fast) var(--ease);
  }

  nav a:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  nav a[aria-current='page'] {
    color: var(--ink);
    background: var(--accent-bg);
  }

  nav a[aria-current='page'] :global(.icon) {
    color: var(--accent);
  }
</style>
