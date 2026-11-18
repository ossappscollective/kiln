<!--
  PlatformBadge: the platform of an app, as a small icon tile and its name. A thin wrapper around
  ui/PlatformBadge.svelte, kept so existing imports and props keep working.
  Props: platform, showLabel = true (false keeps the name for assistive technology only).
-->
<script lang="ts">
  import type { Platform } from '@mrm/core';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let { platform, showLabel = true }: { platform: Platform; showLabel?: boolean } = $props();
</script>

<PlatformBadge {platform} {showLabel} />
