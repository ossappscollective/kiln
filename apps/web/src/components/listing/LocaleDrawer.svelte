<!--
  LocaleDrawer: one locale of the listing grid in detail, as a side panel. For each platform that
  has the locale it shows every field with the existing comparison (FieldCompare: repository, last
  synced, store; counters; history) and the pull actions that exist today (pull into the repository
  as a draft change set). It never changes a store.
  Props: open (bindable), row (the locale, or null), members (the app records in scope), channels
  (which store copy each platform's values are, by platform), now, pullReasons (why pulling is not
  available, by platform; null when it is), position ({ index, count } among the filtered locales),
  onstep (-1 or 1: the previous or next locale), onpull (app, fields: opens the pull dialog),
  onhistory (app, field), role, onstage (app, field: stage the repository's text), onunstage (app, id, field),
  stagingKey (`<app id>\u0000<locale>\u0000<field>` of the field being staged or unstaged, or ''), locked? (the
  platforms whose version is locked: their fields are read-only here, with no stage control), asoKeywords? (the
  tracked ASO keywords by app id; given when the role can read ASO, it shows the keyword budget of each platform's
  fields: the store text with the staged text on top, see AsoBudget), allLocales? (every locale of the grid).
  A native <dialog> shown as a side panel, so the focus trap, Escape and the focus return come from
  the browser. A pull or history dialog opened from here stacks above it.
-->
<script lang="ts">
  import { type Platform, type Role, platformLabel } from '@mrm/core';
  import { coachHref, countriesForLocale, fieldsFromDrift, keywordsForLocale } from '../../lib/aso-budget.ts';
  import type { AsoKeyword } from '../../lib/aso.ts';
  import { localeSummary } from '../../lib/listing-drift.ts';
  import { cellInfo, cellStatus } from '../../lib/listing-matrix.ts';
  import type { MatrixRow } from '../../lib/listing-matrix.ts';
  import { canPullField, pullKey, pullableInLocale } from '../../lib/listing-pull.ts';
  import { storeName } from '../../lib/portfolio.ts';
  import { fieldStage } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import type { AppSummary, DriftField } from '../../lib/types.ts';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import AsoBudget from '../aso/AsoBudget.svelte';
  import FieldCompare from './FieldCompare.svelte';
  import StatusDot from './StatusDot.svelte';

  let {
    open = $bindable(false),
    row,
    members,
    channels,
    now,
    pullReasons,
    position,
    onstep,
    onpull,
    onhistory,
    role,
    onstage,
    onunstage,
    stagingKey = '',
    locked = [],
    asoKeywords,
    allLocales = [],
  }: {
    open?: boolean;
    row: MatrixRow | null;
    members: AppSummary[];
    channels: Partial<Record<Platform, 'live' | 'editable' | null>>;
    now: number;
    pullReasons: Partial<Record<Platform, string | null>>;
    position: { index: number; count: number };
    onstep: (delta: -1 | 1) => void;
    onpull: (app: AppSummary, fields: DriftField[]) => void;
    onhistory: (app: AppSummary, field: DriftField) => void;
    role: Role;
    onstage: (app: AppSummary, field: DriftField) => void;
    onunstage: (app: AppSummary, id: string, field: DriftField) => void;
    stagingKey?: string;
    locked?: Platform[];
    asoKeywords?: Record<string, AsoKeyword[] | undefined>;
    allLocales?: string[];
  } = $props();

  const uid = $props.id();

  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;
  /** Selected rows for "Pull selected": `<platform>\u0000<locale>\u0000<field>`. */
  let picked = $state<Set<string>>(new Set());

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Another locale (or reopening) starts with nothing selected.
  $effect(() => {
    void row?.locale;
    void open;
    picked = new Set();
  });

  function handleClose() {
    open = false;
    opener?.focus();
    opener = null;
  }

  // The backdrop belongs to the dialog element: a click that lands on it is a click outside.
  function handleClick(event: MouseEvent) {
    if (event.target === dialog) open = false;
  }

  const appOf = (platform: Platform): AppSummary | undefined => members.find((m) => m.platform === platform);
  const keyOf = (platform: Platform, field: DriftField) => `${platform}\u0000${pullKey(field)}`;

  function select(platform: Platform, field: DriftField, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(keyOf(platform, field));
    else next.delete(keyOf(platform, field));
    picked = next;
  }

  const pickedIn = (platform: Platform, fields: DriftField[]): DriftField[] =>
    fields.filter((f) => canPullField(f) && picked.has(keyOf(platform, f)));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="drawer" aria-labelledby="{uid}-title" onclose={handleClose} onclick={handleClick}>
  {#if open && row}
    <div class="surface">
      <header>
        <div class="who">
          <h2 id="{uid}-title">Locale {row.locale}</h2>
          <p class="muted">{row.name === row.locale ? '' : `${row.name} · `}{position.index + 1} of {position.count}</p>
        </div>
        <div class="nav">
          <Button size="sm" variant="ghost" iconOnly icon="chevron-left" label="Previous locale" disabled={position.index <= 0} onclick={() => onstep(-1)} />
          <Button size="sm" variant="ghost" iconOnly icon="chevron-right" label="Next locale" disabled={position.index >= position.count - 1} onclick={() => onstep(1)} />
          <button type="button" class="ghost icon sm" aria-label="Close" onclick={() => (open = false)}>
            <Icon name="x" />
          </button>
        </div>
      </header>

      <div class="body">
        {#each row.platforms as platform (platform)}
          {@const app = appOf(platform)}
          {@const fields = row.fields[platform] ?? []}
          {@const pullable = pullableInLocale({ locale: row.locale, fields })}
          {@const reason = pullReasons[platform] ?? null}
          {@const selection = pickedIn(platform, fields)}
          <section class="platform card flush" aria-label="{platformLabel(platform)} listing, locale {row.locale}">
            <div class="phead">
              <h3><PlatformBadge {platform} tinted /></h3>
              <span class="muted">{storeName(platform)} · {localeSummary({ locale: row.locale, fields })}</span>
            </div>
            <div class="dots" aria-label="Status of each field">
              {#each fields as field (field.field)}
                {@const status = cellStatus(field)}
                <span class="dotted"><StatusDot {status} label="{field.label}: {cellInfo(status).label}" /><span>{field.label}</span></span>
              {/each}
            </div>

            {#if app !== undefined && asoKeywords !== undefined && fields.length > 0}
              {@const text = fieldsFromDrift(platform, row.locale, fields, stagedStore.view(app.id))}
              {@const tracked = asoKeywords[app.id] ?? []}
              <div class="budget">
                <AsoBudget
                  {platform}
                  locale={row.locale}
                  fields={text.fields}
                  staged={text.staged}
                  keywords={keywordsForLocale(tracked, row.locale)}
                  countries={countriesForLocale(tracked, row.locale)}
                  listingLocales={allLocales}
                  addHref={coachHref({ to: 'keywords_add', label: 'Add keywords' }, app.id, platform)}
                />
              </div>
            {/if}

            {#if app !== undefined && pullable.length > 0}
              <div class="pullrow">
                {#if reason !== null}
                  <p class="muted note"><Icon name="info" size={14} /> Pulling into the repository is not available. {reason}</p>
                {:else}
                  <Button size="sm" icon="git-pull-request" onclick={() => onpull(app, pullable)}>
                    Pull {row.locale} into repository ({pullable.length})
                  </Button>
                  <Button size="sm" icon="git-pull-request" disabled={selection.length === 0} onclick={() => onpull(app, selection)}>
                    Pull selected{selection.length > 0 ? ` (${selection.length})` : ''}
                  </Button>
                {/if}
              </div>
            {/if}

            {#if fields.length === 0}
              <p class="muted empty">This locale has no fields on this store.</p>
            {/if}
            {#each fields as field (field.field)}
              <FieldCompare
                {field}
                storeLabel={channels[platform] === 'editable' ? 'Editable version' : 'Live store'}
                {now}
                onhistory={(f) => app && onhistory(app, f)}
                pullable={canPullField(field)}
                pullDisabled={reason}
                selected={picked.has(keyOf(platform, field))}
                onselect={(f, on) => select(platform, f, on)}
                onpull={(f) => app && onpull(app, [f])}
                stage={app && locked.indexOf(platform) < 0 ? fieldStage({ role, platform, field, view: stagedStore.view(app.id) }) : undefined}
                stageBusy={app !== undefined && stagingKey === `${app.id}\u0000${field.locale}\u0000${field.field}`}
                onstage={(f) => app && onstage(app, f)}
                onunstage={(id, f) => app && onunstage(app, id, f)}
              />
            {/each}
          </section>
        {/each}

        <p class="muted foot">
          <Icon name="info" size={14} /> "Stage from repo" collects the repository's text of a field that differs for the draft push in the
          staged-changes tray; it changes nothing in a store. Other edits are made in the repository, as change sets.
          {#each members as app (app.id)}
            {#if app.repositoryId !== null}<a href="#/repositories">Open repositories</a>{/if}
          {/each}
        </p>
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog.drawer {
    width: min(720px, 100%);
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    padding: 0;
    margin: 0 0 0 auto;
    overflow: hidden;
    color: var(--ink);
    background: var(--surface);
    border: 0;
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
  }

  dialog.drawer[open] {
    animation: slide var(--duration-slow) var(--ease);
  }

  dialog.drawer::backdrop {
    background: var(--scrim);
  }

  .surface {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-5);
    border-bottom: 1px solid var(--line);
  }

  header h2 {
    font-size: var(--text-lg);
  }

  header p {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .nav {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
  }

  .phead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
  }

  .phead h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    padding: 0 var(--space-4) var(--space-3);
    font-size: var(--text-sm);
  }

  .dotted {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .budget {
    padding: 0 var(--space-4) var(--space-3);
  }

  .pullrow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-4) var(--space-3);
  }

  .note {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  .empty {
    padding: 0 var(--space-4) var(--space-3);
    margin: 0;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    dialog.drawer[open] {
      animation: none;
    }
  }
</style>
