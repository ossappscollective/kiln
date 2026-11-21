<script lang="ts">
  import { isWebUrl } from '../../lib/credentials.ts';
  import { t } from '../../lib/i18n/t.ts';

  let { href, label }: { href: string; label: string } = $props();
</script>

{#if isWebUrl(href)}
  <a {href} target="_blank" rel="noopener noreferrer"
    >{label}<svg class="icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false"
      ><path
        d="M7 1.5h3.5V5M10.5 1.5 5.5 6.5M9 7v3a.5.5 0 0 1-.5.5h-6A.5.5 0 0 1 2 10V4a.5.5 0 0 1 .5-.5H5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      /></svg
    ><span class="visually-hidden"> {t('credentials:link.newTab')}</span></a
  >
{:else}
  <span>{label}</span>
{/if}

<style>
  .icon {
    margin-left: 3px;
    vertical-align: -1px;
  }
</style>
