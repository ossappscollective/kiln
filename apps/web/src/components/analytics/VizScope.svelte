<!--
  VizScope: the wrapper of the Analytics charts. The chart colors are tokens defined once in styles/theme.css, for both themes,
  and validated there (src/lib/tokens.ts, contrast.test.ts, 3:1 against the card):
  - --viz-1 is the app's accent (blue), --viz-2 is ember, used only where a second series matters,
  - --viz-mid and --viz-end are the middle and the end of the gradient a single-series line is drawn with,
  - --viz-grid, --viz-axis, --viz-hatch and --viz-wash follow the borders and the track.
  A second series is never told apart by color alone: the legend names it, and in forced colors it is dashed.
  Light and dark follow the theme the same way everywhere (the OS setting, and the choice on `data-theme`).
  Props: children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="viz">{@render children()}</div>
