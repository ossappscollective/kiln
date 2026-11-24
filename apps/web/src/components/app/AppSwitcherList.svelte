<!--
  AppSwitcherList: the rows of the app switcher (icon, name; bundle ids and pending chip on the meta line; platforms, number). One list
  for the Cmd or Ctrl + K dialog (AppSwitcher) and the switcher field of the left panel (AppSwitcherField); the
  parent owns the search text and the highlighted row, and the keys (lib/app-switcher.ts moveActive).
  Props: items (already filtered), current (the highlighted row), selectedKey? (the open app, marked), id (the listbox
  id; the rows are `<id>-o<index>`), mod (Cmd or Ctrl, for the number hint), onhover (index), onpick (item).
  The list sits inside the open app's tint scope, so EACH ROW is its own scope (ADR 0068): `data-app-tint` with the style of the row's
  own app (lib/tint/switcher.ts rowTintStyle, from the palette cache), so the pending chip, the highlight and the icon ring follow that app,
  and a row without a known palette is neutral (the container resets, see styles/tint.css). The palettes of the rows on screen are read
  lazily (tint.warm, two at a time, colour only: nothing moves). The open app is marked by a check, an underline and a start edge in its own tint, not by a coloured name. The icon itself is plain (no ring or coloured tile).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { tint } from '../../lib/tint/store.svelte.ts';
  import { rowTintStyle } from '../../lib/tint/switcher.ts';
  import Icon from '../ui/Icon.svelte';
  import type { SwitcherItem } from '../../lib/app-switcher.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import PendingChip from '../publish/PendingChip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    items,
    current,
    selectedKey = null,
    id,
    mod = 'Ctrl',
    onhover,
    onpick,
  }: {
    items: SwitcherItem[];
    current: number;
    selectedKey?: string | null | undefined;
    id: string;
    mod?: string | undefined;
    onhover: (index: number) => void;
    onpick: (item: SwitcherItem) => void;
  } = $props();

  /** Reads the palette of a row's icon when the row scrolls into view (at once without IntersectionObserver). */
  function warm(node: HTMLElement, item: SwitcherItem) {
    if (typeof IntersectionObserver === 'undefined') {
      tint.warm(item.key, item.iconUrl);
      return {};
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        tint.warm(item.key, item.iconUrl);
        io.disconnect();
      }
    });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
</script>

<ul {id} class="list" role="listbox" aria-label={t('app:switcher.apps')}>
  {#each items as item, i (item.key)}
    {@const rowTint = rowTintStyle(item, (id) => tint.style(id))}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <li
      use:warm={item}
      data-app-tint={rowTint ? '' : undefined}
      style={rowTint || undefined}
      id="{id}-o{i}"
      role="option"
      aria-selected={i === current}
      class:active={i === current}
      class:open={item.key === selectedKey}
      onpointerenter={() => onhover(i)}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onpick(item)}
    >
      <AppIcon name={item.name} url={item.iconUrl} seed={item.key} size="sm" labelled neutral />
      <span class="names">
        <span class="head">
          <strong class="name" title={item.name}>{item.name}</strong>
          {#if item.key === selectedKey}<span class="here" title={t('app:switcher.current')}><Icon name="check" size={14} /><span class="visually-hidden">{t('app:switcher.current')}</span></span>{/if}
        </span>
        <span class="meta">
          <code class="ids" title={item.identifiers.join(' · ')}>{item.identifiers.join(' · ')}</code>
          {#if item.pending}<span class="chip"><PendingChip line={item.pending} /></span>{/if}
        </span>
      </span>
      <span class="plats">{#each item.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}</span>
      {#if item.number !== null}<kbd class="num" title="{mod} + {item.number}">{item.number}</kbd>{/if}
    </li>
  {/each}
</ul>

<style>
  .list {
    max-height: 340px;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    list-style: none;
  }

  /*
    A stable row at any width: icon | text (the one column that gives way) | platform tiles | number. The text column is
    `minmax(0, 1fr)`, so the name and the bundle ids are cut with an ellipsis instead of being squeezed to one letter per line,
    and the tiles and the number never shrink or wrap.
  */
  .list li {
    display: grid;
    grid-auto-columns: auto;
    grid-auto-flow: column;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3);
    align-items: center;
    min-height: var(--control-lg);
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .list li.active {
    background: var(--accent-bg);
  }

  .names {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* The name has the first line to itself (cut with an ellipsis only when it is longer than the column); below it the bundle
     ids and the pending chip share the meta line, where the ids give way first. */
  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .chip {
    flex: none;
  }

  .ids {
    display: block;
    flex: 0 1 auto;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: 0;
  }

  .plats {
    display: inline-flex;
    gap: var(--space-1);
    white-space: nowrap;
  }

  .num {
    min-width: 20px;
    padding-inline: var(--space-1);
    font-size: var(--text-xs);
    text-align: center;
    color: var(--muted);
  }

  /* The app icon is the plain icon: no coloured circle, ring or tile behind it (`neutral`). The row's tint shows in the highlight, the
     pending chip and, for the open app, a start edge (an inset shadow: nothing moves). --app-accent is the row's own; the container
     resets it, so a row without a palette falls back to the default accent. */
  .list li.open {
    box-shadow: inset 3px 0 0 var(--app-accent, var(--accent));
  }

  /* The open app: a check and an underline, in the ink colour (the colour is the row's, so it cannot say "open" by itself). */
  .list li.open .name {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }

  .here {
    display: inline-flex;
    flex: none;
    color: var(--accent);
  }
</style>
