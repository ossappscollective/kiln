<!--
  VizScope: the chart colors of the Analytics screens, defined once for everything inside it. One system, validated for the
  surfaces it sits on (scripts/validate_palette.js of the dataviz skill, categorical, adjacent pairs: normal-vision and
  color-vision distance, lightness band, contrast of at least 3:1):
  - slot 1 is the app's accent (light #3453d4; dark #6a82ec, the accent stepped into the dark lightness band, because the
    accent text color of the dark theme is too light for a mark),
  - slot 2 is orange (light #eb6834, dark #d95926), used only where a second series matters.
  A second series is never told apart by color alone: the legend names it, and in forced colors it is dashed.
  Light and dark follow the theme the same way app.css does (the OS setting, and the choice on `data-theme`).
  Props: children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="viz">{@render children()}</div>

<style>
  .viz {
    --viz-1: #3453d4;
    --viz-2: #eb6834;
    --viz-grid: var(--line);
    --viz-axis: var(--line-strong);
    --viz-hatch: var(--line-strong);
    --viz-wash: var(--surface-sunken);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:where(:not([data-theme='light']))) .viz {
      --viz-1: #6a82ec;
      --viz-2: #d95926;
    }
  }

  :global(:root[data-theme='dark']) .viz {
    --viz-1: #6a82ec;
    --viz-2: #d95926;
  }
</style>
