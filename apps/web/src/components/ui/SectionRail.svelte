<!--
  SectionRail: a rail of sections on the left and one section at a time on the right, like the workspace Settings. For a page that would
  otherwise stack many sections down one long column (app Builds, Insights overview). The section is kept in the address (`?section=`,
  lib/section-rail.ts), so a link opens it and the back button works; every entry is a real link. Arrow keys move focus along the rail,
  Home and End jump to its ends. On a narrow screen the rail becomes a strip of tabs that scrolls sideways.
  Props: groups (RailGroup[]: id, label, entries with id, label, count?, note?), value (the open entry id), hrefFor (id -> address), label
  (accessible name of the navigation), children (the open section's content, a snippet), aside? (a snippet drawn under the rail, e.g. a note).
  The current entry takes its look from the shared `.sidebar nav a[aria-current='page']` rule of app.css.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { type RailGroup, nonEmptyGroups, railEntries, stepRail } from '../../lib/section-rail.ts';
  import { badgeText } from '../../lib/nav-badges.ts';

  let {
    groups,
    value,
    hrefFor,
    label,
    children,
    aside,
  }: {
    groups: readonly RailGroup[];
    value: string;
    hrefFor: (id: string) => string;
    label: string;
    children: Snippet;
    aside?: Snippet | undefined;
  } = $props();

  const uid = $props.id();
  const shown = $derived(nonEmptyGroups(groups));
  const ids = $derived(railEntries(shown).map((e) => e.id));
  let navEl = $state<HTMLElement>();

  function onkeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const from = target?.closest<HTMLElement>('a[data-rail-id]')?.dataset.railId;
    if (!from) return;
    const next = stepRail(ids, from, event.key);
    if (next === null) return;
    event.preventDefault();
    navEl?.querySelector<HTMLElement>(`a[data-rail-id="${CSS.escape(next)}"]`)?.focus();
  }
</script>

<div class="layout">
  <aside class="rail sidebar no-print">
    <!-- The keys are handled for the links inside (arrow keys move focus between them); the nav itself is not interactive. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav bind:this={navEl} aria-label={label} {onkeydown}>
      {#each shown as g (g.id)}
        <div class="group" role="group" aria-labelledby="{uid}-{g.id}">
          <h2 id="{uid}-{g.id}">{g.label}</h2>
          <ul>
            {#each g.entries as e (e.id)}
              <li>
                <a href={hrefFor(e.id)} data-rail-id={e.id} aria-current={value === e.id ? 'page' : undefined}>
                  <span class="label">{e.label}</span>
                  {#if e.count !== null && e.count !== undefined}
                    <span class="count num">{badgeText(e.count) ?? e.count}{#if e.note}<span class="visually-hidden"> {e.note}</span>{/if}</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>
    {#if aside}{@render aside()}{/if}
  </aside>
  <div class="pane" id="{uid}-pane">{@render children()}</div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 14rem minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
  }

  .rail {
    position: sticky;
    top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .rail nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .group h2 {
    padding: 0 var(--space-3);
    margin: 0 0 var(--space-1);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .group ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .rail nav a {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
    min-height: 2.25rem;
    padding: 0 var(--space-3);
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
  }

  .rail nav a:not([aria-current='page']):hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  /* The current item takes its shape from the shared sidebar rule in app.css; the radius is repeated because this block is scoped. */
  .rail nav a[aria-current='page'] {
    font-weight: var(--weight-semibold);
    color: var(--ink);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }

  .count {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  /* Narrow: one strip of tabs that scrolls sideways; the group names go, the order stays. */
  @media (max-width: 48rem) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-4);
    }

    .rail {
      position: static;
    }

    .rail nav {
      flex-direction: row;
      gap: var(--space-1);
      overflow-x: auto;
      border-bottom: 1px solid var(--line);
      scrollbar-width: thin;
    }

    .group {
      display: flex;
      flex: none;
    }

    .group h2 {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
    }

    .group ul {
      display: flex;
      gap: var(--space-1);
    }

    .rail nav a {
      white-space: nowrap;
      border-radius: var(--radius-md) var(--radius-md) 0 0;
    }

    .rail nav a[aria-current='page'] {
      border-radius: var(--radius-md) var(--radius-md) 0 0;
    }

    .rail nav a[aria-current='page']::before {
      inset: auto 0 0;
      width: auto;
      height: 3px;
    }
  }
</style>
