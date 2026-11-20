<!--
  PlatformBadge: the platform of an app as a small tinted tile and its name (iOS, macOS or Android).
  Each platform has its own hue (the --platform-* tokens, light and dark), its own glyph silhouette
  and its name in text, so no single signal carries the meaning. The logos in
  src/assets/platforms/<platform>.svg (Simple Icons, CC0; see THIRD_PARTY_NOTICES.md) are drawn in place of the glyph (see lib/platform-logos.ts).
  Props: platform ('ios' | 'macos' | 'android'; anything else draws a neutral phone), showLabel = true
  (false keeps the name for assistive technology only; use it only where a name is shown beside it),
  tinted = true (false draws the neutral tile).
  The tile is a fixed square, so it never shifts the layout.
-->
<script lang="ts">
  import { platformLogoUrl } from '../../lib/platform-logos.ts';
  import { platformBadgeText, platformById } from '../../lib/stores.ts';
  import Icon from './Icon.svelte';

  // Logo files in src/assets/platforms; the glyph is the fallback when one is missing.
  const logos = import.meta.glob('../../assets/platforms/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<
    string,
    string
  >;

  let { platform, showLabel = true, tinted = true }: { platform: string; showLabel?: boolean | undefined; tinted?: boolean | undefined } = $props();

  const info = $derived(platformById(platform));
  const text = $derived(platformBadgeText(info, showLabel));
  const tint = $derived(tinted ? info.tint : 'neutral');
  const logo = $derived(platformLogoUrl(logos, platform));
</script>

<span class="platform {tint}">
  <span class="tile" aria-hidden="true">
    {#if logo}<span class="logo" style={`-webkit-mask-image: url("${logo}"); mask-image: url("${logo}");`}></span>{:else}<Icon name={info.icon} size="md" />{/if}
  </span>
  <span class="name" class:visually-hidden={!showLabel}>{text.name}</span>
</span>

<style>
  .platform {
    --p-bg: var(--surface-sunken);
    --p-ink: var(--muted);
    --p-line: var(--line);

    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }

  .platform.ios {
    --p-bg: var(--platform-ios-bg);
    --p-ink: var(--platform-ios-ink);
    --p-line: var(--platform-ios-line);
  }

  .platform.macos {
    --p-bg: var(--platform-macos-bg);
    --p-ink: var(--platform-macos-ink);
    --p-line: var(--platform-macos-line);
  }

  .platform.android {
    --p-bg: var(--platform-android-bg);
    --p-ink: var(--platform-android-ink);
    --p-line: var(--platform-android-line);
  }

  .tile {
    display: inline-grid;
    flex: none;
    width: var(--control-sm);
    height: var(--control-sm);
    color: var(--p-ink);
    background: var(--p-bg);
    border: 1px solid var(--p-line);
    border-radius: var(--radius-md);
    place-items: center;
  }

  /* The logos are single-colour (Simple Icons, CC0), so they are drawn as a mask over the platform ink
     and follow the tinted tile in light and dark; an <img> could not inherit the colour. */
  .logo {
    display: block;
    width: 20px;
    height: 20px;
    background: currentcolor;
    -webkit-mask-position: center;
    mask-position: center;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-size: contain;
    mask-size: contain;
  }

  /* The name takes the platform ink only when tinted, so an untinted badge stays plain text. */
  .platform:not(.neutral) .name {
    color: var(--p-ink);
  }
</style>
