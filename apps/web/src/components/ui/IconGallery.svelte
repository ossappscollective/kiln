<!--
  IconGallery: DEV ONLY. Every icon in the registry at several sizes, the store and platform badges
  in each variant and tone, and the status icons, so the maintainer can look at them in both themes.
  It is not routed and nothing imports it. To see it, temporarily mount it, for example in
  src/main.ts: `mount(IconGallery, { target: document.body })`, then run `pnpm --filter @mrm/web dev`.
  The look of the icons has only been checked for path validity and bounds, never in a browser.
  No props.
-->
<script lang="ts">
  import { RELEASE_STATES } from '@mrm/core';
  import { type IconName, genericBrandIcons, iconNames, iconSizes } from '../../lib/icons.ts';
  import { statusIcon } from '../../lib/status-icons.ts';
  import { storeIds } from '../../lib/stores.ts';
  import Icon from './Icon.svelte';
  import PlatformBadge from './PlatformBadge.svelte';
  import StoreBadge from './StoreBadge.svelte';

  const sizes = Object.entries(iconSizes);
  const marks = Object.keys(genericBrandIcons) as IconName[];
</script>

<div class="gallery stack loose">
  <section class="stack">
    <h2>Icons ({iconNames.length})</h2>
    <ul class="grid">
      {#each iconNames as name (name)}
        <li>
          <Icon {name} size="xl" />
          <code>{name}</code>
        </li>
      {/each}
    </ul>
  </section>

  <section class="stack">
    <h2>Sizes</h2>
    <p class="row">
      {#each sizes as [label, px] (label)}
        <span class="sample"><Icon name="rocket" size={label as 'sm'} /> {label} {px}px</span>
      {/each}
    </p>
    <p class="row">
      <span class="sample"><Icon name="check-circle" title="With a title: role img" /> title</span>
      <span class="sample ok"><Icon name="check-circle" /> ok</span>
      <span class="sample bad"><Icon name="x-circle" /> bad</span>
      <span class="sample warn"><Icon name="alert-triangle" /> warn</span>
      <span class="sample info"><Icon name="info" /> info</span>
    </p>
  </section>

  <section class="stack">
    <h2>Generic store, platform and tool marks ({marks.length})</h2>
    <p class="muted">Not company logos. See THIRD_PARTY_NOTICES.md.</p>
    <p class="row">
      {#each marks as name (name)}
        <span class="sample"><Icon {name} size="lg" /> <code>{name}</code></span>
      {/each}
    </p>
  </section>

  <section class="stack">
    <h2>Store badges</h2>
    {#each ['icon', 'chip', 'full'] as variant (variant)}
      <p class="row">
        <strong class="label">{variant}</strong>
        {#each storeIds as store (store)}<StoreBadge {store} variant={variant as 'chip'} />{/each}
      </p>
      <p class="row">
        <strong class="label">{variant} tinted</strong>
        {#each storeIds as store (store)}<StoreBadge {store} variant={variant as 'chip'} tone="tinted" />{/each}
      </p>
    {/each}
    <p class="row">
      <strong class="label">small</strong>
      {#each storeIds as store (store)}<StoreBadge {store} size="sm" />{/each}
    </p>
    <p class="row">
      <strong class="label">unknown</strong>
      <StoreBadge store="not-a-store" variant="full" />
    </p>
  </section>

  <section class="stack">
    <h2>Platform badges</h2>
    <p class="row"><PlatformBadge platform="ios" /> <PlatformBadge platform="macos" /> <PlatformBadge platform="android" /> <PlatformBadge platform="tizen" /></p>
    <p class="row"><PlatformBadge platform="ios" tinted={false} /> <PlatformBadge platform="android" tinted={false} /> <PlatformBadge platform="ios" showLabel={false} /></p>
  </section>

  <section class="stack">
    <h2>Release status icons</h2>
    <p class="row">
      {#each RELEASE_STATES as state (state)}
        <span class="sample"><Icon name={statusIcon(state)} /> {state}</span>
      {/each}
    </p>
  </section>
</div>

<style>
  .gallery {
    max-width: var(--content-width);
    padding: var(--space-6);
    margin: 0 auto;
    color: var(--ink);
  }

  .grid {
    display: grid;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  }

  .grid li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-3) var(--space-2);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .grid code {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .row {
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .sample {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }

  .label {
    min-width: 96px;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .ok {
    color: var(--ok);
  }

  .bad {
    color: var(--bad);
  }

  .warn {
    color: var(--warn);
  }

  .info {
    color: var(--info);
  }
</style>
