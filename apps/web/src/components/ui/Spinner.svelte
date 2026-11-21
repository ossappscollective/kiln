<!--
  Spinner: an indeterminate progress ring.
  Props: size = 16 (px), label = 'Loading' in the active language (read aloud; pass '' when text nearby already says it).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';

  let { size = 16, label: labelProp }: { size?: number | undefined; label?: string | undefined } = $props();
  const label = $derived(labelProp ?? t('common:state.loading'));
</script>

<span class="spinner" style:width="{size}px" style:height="{size}px" role={label ? 'status' : undefined} aria-hidden={label ? undefined : 'true'}>
  {#if label}<span class="visually-hidden">{label}</span>{/if}
</span>
