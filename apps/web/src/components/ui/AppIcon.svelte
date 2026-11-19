<!--
  AppIcon: the icon of an app, in a square of a fixed size. The size is set on the box, so an icon
  that arrives late never moves anything.
  Props: name (the app's name: initials and alt text), url? (`iconUrl` of the app JSON: only the
  icon route of this server is loaded, see lib/app-icon.ts), platform? ('ios' | 'macos' | 'android': the
  glyph of the fallback tile), seed? (what the tile color follows; the name when not given),
  size = 'md' ('xs' 20, 'sm' 24, 'md' 32, 'lg' 48, 'xl' 64, or a pixel number),
  labelled = true (the name is written beside the icon, so the icon is decorative; false gives the
  image the name as its alt text), class?.
  Never a broken image: with no URL, a 404 (no icon is known yet) or any load error the tile shows
  the initials of the app (the platform glyph at the smallest size, and as a corner mark from 'lg').
  The image loads lazily and decodes off the main thread. No new dependency, no icon is stored here.
-->
<script lang="ts">
  import { type AppIconSize, appIconPixels, iconAlt, iconSrc, initialsOf, tintIndex } from '../../lib/app-icon.ts';
  import { platformById } from '../../lib/stores.ts';
  import Icon from './Icon.svelte';

  let {
    name,
    url = null,
    platform,
    seed,
    size = 'md',
    labelled = true,
    class: className = '',
  }: {
    name: string;
    url?: string | null;
    platform?: string | null;
    seed?: string;
    size?: AppIconSize | number;
    labelled?: boolean;
    class?: string;
  } = $props();

  const px = $derived(appIconPixels(size));
  const src = $derived(iconSrc(url));
  const tint = $derived(tintIndex(seed ?? name));
  const glyph = $derived(platformById(platform));

  let failedSrc = $state<string | null>(null);
  let loadedSrc = $state<string | null>(null);
  const showImage = $derived(src !== null && failedSrc !== src);
  const loaded = $derived(src !== null && loadedSrc === src);
  const tiny = $derived(px < 24);
  const big = $derived(px >= 48);
</script>

<span
  class="app-icon t{tint} {className}"
  class:has-image={loaded}
  style:--app-icon-size="{px}px"
  role={labelled ? undefined : 'img'}
  aria-label={labelled ? undefined : iconAlt(name, false)}
  aria-hidden={labelled ? 'true' : undefined}
>
  {#if tiny}
    <Icon name={glyph.icon} size={Math.round(px * 0.7)} />
  {:else}
    <span class="initials" style:font-size="{Math.round(px * 0.38)}px">{initialsOf(name)}</span>
    {#if big}<span class="mark"><Icon name={glyph.icon} size={Math.round(px * 0.28)} /></span>{/if}
  {/if}
  {#if showImage && src}
    <img
      {src}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      draggable="false"
      referrerpolicy="no-referrer"
      onload={() => {
        loadedSrc = src;
      }}
      onerror={() => {
        failedSrc = src;
      }}
    />
  {/if}
</span>

<style>
  .app-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    box-sizing: border-box;
    width: var(--app-icon-size);
    height: var(--app-icon-size);
    border-radius: calc(var(--app-icon-size) * 0.225);
    overflow: hidden;
    vertical-align: middle;
    font-family: var(--font-sans);
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
    border: 1px solid var(--line);
    user-select: none;
  }
  .t0 {
    background: var(--accent-bg);
    color: var(--accent);
  }
  .t1 {
    background: var(--info-bg);
    color: var(--info-ink);
  }
  .t2 {
    background: var(--ok-bg);
    color: var(--ok-ink);
  }
  .t3 {
    background: var(--warn-bg);
    color: var(--warn-ink);
  }
  .initials {
    display: block;
  }
  .mark {
    position: absolute;
    right: 0;
    bottom: 0;
    display: inline-flex;
    padding: 2px;
    border-top-left-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--muted);
    opacity: 0.9;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    background: var(--surface);
  }
  .has-image img {
    opacity: 1;
  }
  .has-image .initials,
  .has-image .mark,
  .has-image :global(.icon) {
    visibility: hidden;
  }
  @media (prefers-reduced-motion: no-preference) {
    img {
      transition: opacity var(--duration-fast, 120ms) ease;
    }
  }
</style>
