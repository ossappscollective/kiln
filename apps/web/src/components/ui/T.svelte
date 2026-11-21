<!--
  T: a message that has a link or emphasis inside it, translated as ONE message. The translator sees
  `Read <link>the setup guide</link> first.` and never any HTML; the code decides what `link` is.
  Props: key ('ns:key'), params? (the {{placeholders}} and `count`), tags? (a snippet per tag name, called with the text inside the tag).
  `strong`, `em` and `code` need no snippet. A tag with no snippet shows its text. Tags do not nest. Nothing here uses {@html}.

    <T key="app:setup.help" tags={{ link }} params={{ name }} />
    {#snippet link(text)}<a href="#/settings">{text}</a>{/snippet}

  The allowed tag names are `link`, `link2`, `link3`, `strong`, `em`, `code` (lib/i18n/core.ts RICH_TAGS; `pnpm i18n:check` enforces them).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Params } from '../../lib/i18n/core.ts';
  import { tParts } from '../../lib/i18n/t.ts';

  let {
    key,
    params,
    tags,
  }: { key: string; params?: Params | undefined; tags?: Record<string, Snippet<[string]> | undefined> | undefined } = $props();

  const parts = $derived(tParts(key, params));
</script>

{#each parts as part, i (i)}
  {#if part.tag === undefined}{part.text}{:else}
    {@const render = tags?.[part.tag]}
    {#if render}{@render render(part.text)}{:else if part.tag === 'strong'}<strong>{part.text}</strong>{:else if part.tag === 'em'}<em>{part.text}</em>{:else if part.tag === 'code'}<code>{part.text}</code>{:else}{part.text}{/if}
  {/if}
{/each}
