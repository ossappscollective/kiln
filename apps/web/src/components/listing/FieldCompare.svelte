<!--
  FieldCompare: one listing field of one locale. Reading order (docs/design/readability.md, "Second pass: forms and dialogs"): the name,
  ONE status word and the quiet counter; then one sentence, the blocking problems (always visible) and the actions; last, behind a quiet
  control, the comparison in three columns (what the repository has, what the tool last knew, what the live store has) and the history.
  Read-only: it never changes a store. A field that is in sync and within its limit starts collapsed.
  Props: field (DriftField), storeLabel ("Live store", or "Editable version" for an app that is not
  live yet), now (ms, for relative times), onhistory (opens the history of this field).
  Pulling (optional): pullable (the store is ahead or the two diverged, so this field can be pulled
  into the repository), pullDisabled (why pulling is not available now, or null), selected and
  onselect (the checkbox for "Pull selected into repository"), onpull (pull just this field).
  extra? (a snippet drawn at the end of the open field: the AI "Improve" of the locale drawer).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { timeAgo, fullTime } from '../../lib/format.ts';
  import {
    comparison,
    statusExplanation,
    usage,
    usageText,
    shortRef,
  } from '../../lib/listing/drift.ts';
  import { blockingLines, fieldLimitNote, fieldWord } from '../../lib/listing/locale-drawer.ts';
  import { cellInfo, cellStatus } from '../../lib/listing/matrix.ts';
  import type { FieldStage } from '../../lib/staged.ts';
  import type { DriftField, DriftSide } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import DiffText from './DiffText.svelte';

  let {
    field,
    storeLabel = 'Live store',
    now,
    onhistory,
    pullable = false,
    pullDisabled = null,
    selected = false,
    onselect,
    onpull,
    stage,
    stageBusy = false,
    onstage,
    onunstage,
    extra,
  }: {
    field: DriftField;
    storeLabel?: string;
    now: number;
    onhistory: (field: DriftField) => void;
    pullable?: boolean;
    pullDisabled?: string | null;
    selected?: boolean;
    onselect?: (field: DriftField, selected: boolean) => void;
    onpull?: (field: DriftField) => void;
    stage?: FieldStage;
    stageBusy?: boolean;
    onstage?: (field: DriftField) => void;
    onunstage?: (id: string, field: DriftField) => void;
    extra?: Snippet;
  } = $props();

  const uid = $props.id();
  let showCompare = $state(false);
  const diff = $derived(comparison(field));
  const status = $derived(cellStatus(field));
  const info = $derived(cellInfo(status));
  const note = $derived(fieldLimitNote(field));
  const lines = $derived(blockingLines(field));
  const columns = $derived([
    { key: 'repo', title: 'Repository', side: field.repo, hint: 'The listing files in the linked repository, as last read.' },
    { key: 'db', title: 'Last synced', side: field.db, hint: 'What this tool last knew: the last store sync, or a change set applied since.' },
    { key: 'live', title: storeLabel, side: field.live, hint: 'What the store had at the last sync.' },
  ]);

  const sourceNote = (side: DriftSide): string => {
    if (side.observedAt === null) return '';
    const ref = side.source ? shortRef(side.source, side.sourceRef) : null;
    return `${side.source === 'change_set' ? 'Change set' : 'Since'} ${timeAgo(side.observedAt, now)}${ref ? ` (${ref})` : ''}`;
  };
</script>

<details class="field" open={status !== 'sync'}>
  <summary>
    <span class="chev"><Icon name="chevron-right" size={16} /></span>
    <span class="name">{field.label}</span>
    <Badge tone={info.tone} icon={info.icon}>{fieldWord(status)}</Badge>
    {#if lines.length > 0 && status !== 'over'}
      <Badge tone="warn">Limit problem</Badge>
    {/if}
    {#if stage?.staged}
      <Badge tone="accent" icon="layers">Staged</Badge>
    {/if}
    {#if note}<span class="count" class:over={note.over}>{note.text}</span>{/if}
  </summary>

  <div class="body">
    <p class="muted explain">{statusExplanation(field.status)}</p>
    {#each lines as line, i (i)}
      <p class="problem" class:over={status === 'over'}><Icon name="alert-triangle" size={14} /> {line}</p>
    {/each}
    <div class="actions">
      {#if pullable}
        <label class="check pick">
          <input
            type="checkbox"
            checked={selected}
            disabled={pullDisabled !== null}
            onchange={(e) => onselect?.(field, e.currentTarget.checked)}
          />
          <span>Select<span class="visually-hidden"> {field.label} ({field.locale}) to pull into the repository</span></span>
        </label>
        <Button size="sm" icon="git-pull-request" disabled={pullDisabled !== null} onclick={() => onpull?.(field)}>Pull into repository<span class="visually-hidden">: {field.label} ({field.locale})</span></Button>
      {/if}
      {#if stage && stage.staged}
        <span class="staged-note">
          {stage.upToDate ? 'Staged: the repository text, for the draft push.' : 'Staged, but not the repository text as it is now.'}
        </span>
      {/if}
      {#if stage && stage.state === 'available'}
        <Button size="sm" icon="layers" loading={stageBusy} disabled={stageBusy || stage.upToDate} onclick={() => onstage?.(field)}>
          {stage.staged ? (stage.upToDate ? 'Staged from repo' : 'Stage from repo again') : 'Stage from repo'}<span class="visually-hidden">: {field.label} ({field.locale})</span>
        </Button>
      {:else if stage && stage.state === 'disabled'}
        <Button size="sm" icon="layers" disabled title={stage.reason ?? undefined}>Stage from repo<span class="visually-hidden">: {field.label} ({field.locale}). {stage.reason}</span></Button>
      {:else if stage && stage.state === 'not_pushable'}
        <span class="muted small" title={stage.reason ?? undefined}>Not part of a draft push</span>
      {/if}
      {#if stage && stage.staged}
        <Button size="sm" variant="ghost" icon="x" disabled={stageBusy} onclick={() => stage.staged && onunstage?.(stage.staged.id, field)}>Unstage<span class="visually-hidden"> {field.label} ({field.locale})</span></Button>
      {/if}
    </div>
    {#if extra}{@render extra()}{/if}
    <div class="quiet">
      <button type="button" class="link" aria-expanded={showCompare} aria-controls="{uid}-compare" onclick={() => (showCompare = !showCompare)}>
        {showCompare ? 'Hide the comparison' : 'Compare repository and store'}<span class="visually-hidden"> for {field.label} ({field.locale})</span>
      </button>
      <Button size="sm" variant="ghost" icon="history" onclick={() => onhistory(field)}>History<span class="visually-hidden"> of {field.label} ({field.locale})</span></Button>
    </div>
    <div class="columns" id="{uid}-compare" hidden={!showCompare}>
      {#each columns as col (col.key)}
        {@const u = usage(col.side.value, field.limit, field.unit)}
        <section class="col" aria-label="{field.label}, {col.title}">
          <h4 title={col.hint}>{col.title}</h4>
          {#if col.side.value === null}
            <p class="none muted">{col.side.observedAt === null ? 'No value' : 'Removed'}</p>
          {:else}
            <div class="value">
              {#if diff && col.key === 'repo'}
                <DiffText from={diff.fromValue} to={diff.toValue} side="to" fromName="the store" toName="the repository" />
              {:else if diff && col.key === 'live'}
                <DiffText from={diff.fromValue} to={diff.toValue} side="from" fromName="the store" toName="the repository" />
              {:else}
                {col.side.value}
              {/if}
            </div>
            <p class="meta" class:over={u.over}>
              {usageText(u)}{#if u.over}<span class="visually-hidden"> (over the limit)</span>{/if}
            </p>
          {/if}
          {#if col.side.observedAt !== null}
            <p class="meta muted" title={fullTime(col.side.observedAt)}>{sourceNote(col.side)}</p>
          {/if}
        </section>
      {/each}
    </div>
  </div>
</details>

<style>
  .field {
    border-top: 1px solid var(--line);
  }

  summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-4);
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover {
    background: var(--surface-hover);
  }

  .chev {
    display: inline-flex;
    color: var(--muted);
    transition: transform var(--duration-fast) var(--ease);
  }

  details[open] > summary .chev {
    transform: rotate(90deg);
  }

  .name {
    font-size: 0.9375rem;
    font-weight: var(--weight-semibold);
  }

  /* The counter is quiet; it turns bold and red only when a side is over the limit. */
  .count {
    margin-left: auto;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .count.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0 var(--space-4) var(--space-4) calc(var(--space-4) + 16px + var(--space-3));
  }

  .explain {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.45;
  }

  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .columns[hidden] {
    display: none;
  }

  .col {
    min-width: 0;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .value {
    max-height: 16rem;
    overflow: auto;
    font-size: 0.9375rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .none {
    margin: 0;
    font-style: italic;
  }

  .meta {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .meta.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .problem {
    display: flex;
    gap: var(--space-1);
    align-items: flex-start;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--warn-ink);
  }

  .problem.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
  }

  .actions:empty {
    display: none;
  }

  .quiet {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .pick {
    margin-right: auto;
    font-size: var(--text-sm);
  }

  .staged-note {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .small {
    font-size: var(--text-sm);
  }
</style>
