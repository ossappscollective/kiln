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
  platforms whose version is locked: their fields are read-only here, with no stage control, and no AI "Improve"), asoKeywords? (the
  tracked ASO keywords by app id; given when the role can read ASO, it shows the keyword budget of each platform's
  fields: the store text with the staged text on top, see AsoBudget), allLocales? (every locale of the grid), api? and workspaceId? (given: each field of a platform that can be edited offers the AI "Improve", see ImproveField).
  Reading order (docs/design/readability.md, "Second pass: forms and dialogs"): the lead says what must be done for THIS locale ("3 fields differ
  from the store") with the one primary action; each platform lists its fields with the ones that differ or are blocked first, each with ONE
  status word and a quiet counter; the fields that are in sync are folded; the comparison and the history of a field sit behind quiet controls
  (FieldCompare); the keyword budget and the long note about staging come last.
  A native <dialog> shown as a side panel, so the focus trap, Escape and the focus return come from
  the browser. A pull or history dialog opened from here stacks above it.
-->
<script lang="ts">
  import { type Platform, type Role, platformLabel } from '@kiln/core';
  import { coachHref, countriesForLocale, fieldsFromDrift, keywordsForLocale } from '../../lib/aso/budget.ts';
  import type { Api } from '../../lib/api.ts';
  import type { AsoKeyword } from '../../lib/aso/aso.ts';
  import { localeSummary } from '../../lib/listing/drift.ts';
  import type { MatrixRow } from '../../lib/listing/matrix.ts';
  import { canPullField, pullKey, pullableInLocale } from '../../lib/listing/pull.ts';
  import { type LeadActionInput, leadAction, localeLead, splitFields } from '../../lib/listing/locale-drawer.ts';
  import { storeName } from '../../lib/portfolio.ts';
  import { fieldInfo } from '../../lib/listing/edit.ts';
  import { fieldStage } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import type { AppSummary, DriftField } from '../../lib/types.ts';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import AsoBudget from '../aso/AsoBudget.svelte';
  import ImproveField from '../ai/ImproveField.svelte';
  import FieldCompare from './FieldCompare.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import PageLead from '../ui/PageLead.svelte';

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
    api,
    workspaceId,
    onedit,
  }: {
    open?: boolean | undefined;
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
    stagingKey?: string | undefined;
    locked?: Platform[] | undefined;
    asoKeywords?: Record<string, AsoKeyword[] | undefined> | undefined;
    allLocales?: string[] | undefined;
    api?: Api | undefined;
    workspaceId?: string | undefined;
    onedit?: ((app: AppSummary, field: DriftField) => void) | undefined;
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

  /** What the drawer opens on: how many fields differ in this locale, and what to do about it. */
  const lead = $derived.by(() => {
    const r = row;
    return r ? localeLead(r.platforms.map((p) => ({ fields: r.fields[p] ?? [] }))) : null;
  });

  /** The ONE primary action, from the actions the drawer already has (shorten, pull, stage). */
  const primary = $derived.by(() => {
    const r = row;
    if (!r) return null;
    const inputs: LeadActionInput[] = r.platforms.map((platform) => {
      const app = appOf(platform);
      const fields = r.fields[platform] ?? [];
      const readOnly = locked.indexOf(platform) >= 0;
      return {
        platform,
        fields,
        pullable: pullableInLocale({ locale: r.locale, fields }),
        canPull: app !== undefined && (pullReasons[platform] ?? null) === null,
        canEdit: (f: DriftField) => app !== undefined && onedit !== undefined && !readOnly && fieldInfo(platform, f.field) !== null,
        canStage: (f: DriftField) => {
          if (app === undefined || readOnly) return false;
          const st = fieldStage({ role, platform, field: f, view: stagedStore.view(app.id) });
          return st.state === 'available' && !st.upToDate;
        },
      };
    });
    return leadAction(inputs);
  });

  const primaryBusy = $derived.by(() => {
    const a = primary;
    if (!a || a.kind !== 'stage') return false;
    const app = appOf(a.platform);
    return app !== undefined && stagingKey === `${app.id}\u0000${a.field.locale}\u0000${a.field.field}`;
  });

  function runPrimary() {
    const a = primary;
    const r = row;
    if (!a || !r) return;
    const app = appOf(a.platform);
    if (!app) return;
    if (a.kind === 'edit') onedit?.(app, a.field);
    else if (a.kind === 'pull') onpull(app, pullableInLocale({ locale: r.locale, fields: r.fields[a.platform] ?? [] }));
    else onstage(app, a.field);
  }
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
        {#if lead}
          <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="locale-lead">
            {#snippet actions()}
              {#if primary}
                <Button
                  variant="primary"
                  icon={primary.kind === 'edit' ? 'edit' : primary.kind === 'pull' ? 'git-pull-request' : 'layers'}
                  loading={primaryBusy}
                  disabled={primaryBusy}
                  onclick={runPrimary}
                >
                  {primary.label}
                </Button>
              {/if}
            {/snippet}
          </PageLead>
        {/if}

        {#each row.platforms as platform (platform)}
          {@const app = appOf(platform)}
          {@const fields = row.fields[platform] ?? []}
          {@const pullable = pullableInLocale({ locale: row.locale, fields })}
          {@const reason = pullReasons[platform] ?? null}
          {@const selection = pickedIn(platform, fields)}
          {@const split = splitFields(fields)}
          {#snippet fieldRow(field: DriftField)}
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
            >
              {#snippet extra()}
                {#if app && onedit && locked.indexOf(platform) < 0 && fieldInfo(platform, field.field) !== null}
                  <div class="editrow">
                    <Button size="sm" icon="edit" onclick={() => onedit(app, field)}>Edit {field.label.toLowerCase()}</Button>
                  </div>
                {/if}
                {#if app && api && workspaceId && locked.indexOf(platform) < 0}
                  <ImproveField
                    {api}
                    {workspaceId}
                    {role}
                    {app}
                    {field}
                    current={field.live.value ?? field.db.value ?? ''}
                    buttonLabel="Suggest with AI"
                    onaccepted={async () => {
                      await stagedStore.load(api, workspaceId, app.id);
                    }}
                  />
                {/if}
              {/snippet}
            </FieldCompare>
          {/snippet}
          <section class="platform card flush" aria-label="{platformLabel(platform)} listing, locale {row.locale}">
            <div class="phead">
              <h3><PlatformBadge {platform} tinted /></h3>
              <span class="muted">{storeName(platform)} · {localeSummary({ locale: row.locale, fields })}</span>
            </div>

            {#if app !== undefined && pullable.length > 0}
              <div class="pullrow">
                {#if reason !== null}
                  <p class="muted note"><Icon name="info" size={14} /> Pulling into the repository is not available. {reason}</p>
                {:else}
                  {#if !(primary?.kind === 'pull' && primary.platform === platform)}
                    <Button size="sm" icon="git-pull-request" onclick={() => onpull(app, pullable)}>
                      Pull {row.locale} into repository ({pullable.length})
                    </Button>
                  {/if}
                  <Button size="sm" variant="ghost" icon="git-pull-request" disabled={selection.length === 0} onclick={() => onpull(app, selection)}>
                    Pull selected{selection.length > 0 ? ` (${selection.length})` : ''}
                  </Button>
                {/if}
              </div>
            {/if}

            {#if fields.length === 0}
              <p class="muted empty">This locale has no fields on this store.</p>
            {/if}
            <div class="fields" role="group" aria-label="Status of each field">
              {#each split.attention as field (field.field)}
                {@render fieldRow(field)}
              {/each}
              {#if split.inSync.length > 0}
                <details class="insync" open={split.attention.length === 0}>
                  <summary>
                    <span class="chev"><Icon name="chevron-right" size={16} /></span>
                    {split.inSync.length === fields.length ? 'All' : ''}
                    {split.inSync.length}
                    {split.inSync.length === 1 ? 'field' : 'fields'} in sync
                  </summary>
                  {#each split.inSync as field (field.field)}
                    {@render fieldRow(field)}
                  {/each}
                </details>
              {/if}
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
          </section>
        {/each}

        <Disclosure summary="How staging and pulling work">
          <p class="muted foot">
            "Stage from repo" collects the repository's text of a field that differs for the draft push in the staged-changes tray; it
            changes nothing in a store. Other edits are made in the repository, as change sets.
            {#if members.some((m) => m.repositoryId !== null)}<a href="#/repositories">Open repositories</a>{/if}
          </p>
        </Disclosure>
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
    font-size: 0.9375rem;
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
    gap: var(--space-5);
    padding: var(--space-5) var(--space-5) var(--space-6);
    overflow: auto;
  }

  .phead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    padding: var(--space-4);
  }

  .phead h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .phead .muted {
    font-size: 0.9375rem;
  }

  .budget {
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--line);
  }

  .editrow {
    display: flex;
  }

  .pullrow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: 0 var(--space-4) var(--space-3);
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

  .insync {
    border-top: 1px solid var(--line);
  }

  .insync > summary {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    font-size: 0.9375rem;
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }

  .insync > summary::-webkit-details-marker {
    display: none;
  }

  .insync > summary:hover {
    background: var(--surface-hover);
  }

  .insync > summary .chev {
    display: inline-flex;
    transition: transform var(--duration-fast) var(--ease);
  }

  .insync[open] > summary .chev {
    transform: rotate(90deg);
  }

  .foot {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.45;
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
