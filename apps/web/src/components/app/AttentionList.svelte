<!--
  AttentionList: "Needs attention" on the dashboard of an app: one line per thing to look at, most
  serious first, each with a link to where it is handled. Drawn only when there is something to show.
  Props: items (from attentionItems in lib/app-attention.ts).
-->
<script lang="ts">
  import type { AttentionItem } from '../../lib/app-attention.ts';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';

  let { items }: { items: AttentionItem[] } = $props();
</script>

<section class="card attention" aria-labelledby="attention-title">
  <div class="head">
    <h2 id="attention-title">Needs attention</h2>
    <Badge tone={items.some((i) => i.tone === 'bad') ? 'bad' : 'warn'}>{items.length}</Badge>
  </div>
  <ul>
    {#each items as item (item.id)}
      <li class={item.tone}>
        <span class="mark"><Icon name={item.icon} size={16} /></span>
        <div class="text">
          <p class="line">{item.text}</p>
          {#if item.detail}<p class="detail muted">{item.detail}</p>{/if}
        </div>
        {#if item.href}<a class="go" href={item.href}>{item.action}</a>{/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .attention {
    padding: var(--space-4);
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
  }

  ul {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-1) var(--space-3);
    align-items: start;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  li:first-child {
    border-top: 0;
  }

  .mark {
    display: inline-flex;
    margin-top: 2px;
  }

  li.bad .mark {
    color: var(--bad);
  }

  li.warn .mark {
    color: var(--warn);
  }

  li.info .mark {
    color: var(--info);
  }

  .line {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .detail {
    margin: 0;
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .go {
    grid-column: 2;
    font-size: var(--text-xs);
  }
</style>
