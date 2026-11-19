<!--
  FieldCompare: one listing field of one locale, in three columns: what the repository has, what
  the tool last knew (its database), and what the live store has. Read-only: it never changes a
  store. A field that is identical on both sides starts collapsed.
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
    statusDetail,
    statusExplanation,
    statusTone,
    usage,
    usageText,
    shortRef,
  } from '../../lib/listing-drift.ts';
  import type { FieldStage } from '../../lib/staged.ts';
  import type { DriftField, DriftSide, SideProblem } from '../../lib/types.ts';
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

  const diff = $derived(comparison(field));
  const columns = $derived([
    { key: 'repo', title: 'Repository', side: field.repo, problems: field.problems.repo, hint: 'The listing files in the linked repository, as last read.' },
    { key: 'db', title: 'Last synced', side: field.db, problems: [] as SideProblem[], hint: 'What this tool last knew: the last store sync, or a change set applied since.' },
    { key: 'live', title: storeLabel, side: field.live, problems: field.problems.live, hint: 'What the store had at the last sync.' },
  ]);

  const sourceNote = (side: DriftSide): string => {
    if (side.observedAt === null) return '';
    const ref = side.source ? shortRef(side.source, side.sourceRef) : null;
    return `${side.source === 'change_set' ? 'Change set' : 'Since'} ${timeAgo(side.observedAt, now)}${ref ? ` (${ref})` : ''}`;
  };
</script>

<details class="field" open={field.status !== 'identical'}>
  <summary>
    <span class="chev"><Icon name="chevron-right" size={16} /></span>
    <span class="name">{field.label}</span>
    <Badge tone={statusTone(field.status)}>{statusDetail(field)}</Badge>
    {#if field.problems.repo.length + field.problems.live.length > 0}
      <Badge tone="warn">Limit problem</Badge>
    {/if}
    {#if stage?.staged}
      <Badge tone="accent" icon="layers">Staged</Badge>
    {/if}
  </summary>

  <div class="body">
    <p class="muted explain">{statusExplanation(field.status)}</p>
    <div class="columns">
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
          {#each col.problems as problem (problem.code + problem.message)}
            <p class="problem"><Icon name="alert-triangle" size={14} /> {problem.message}</p>
          {/each}
          {#if col.side.observedAt !== null}
            <p class="meta muted" title={fullTime(col.side.observedAt)}>{sourceNote(col.side)}</p>
          {/if}
        </section>
      {/each}
    </div>
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
      <Button size="sm" variant="ghost" icon="history" onclick={() => onhistory(field)}>History<span class="visually-hidden"> of {field.label} ({field.locale})</span></Button>
    </div>
    {#if extra}{@render extra()}{/if}
  </div>
</details>

<style>
  .field {
    border-top: 1px solid var(--line);
  }

  summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-3) var(--space-4);
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
    font-weight: var(--weight-semibold);
  }

  .body {
    padding: 0 var(--space-4) var(--space-4);
  }

  .explain {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
  }

  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
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
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .value {
    max-height: 16rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .none {
    margin: 0;
    font-style: italic;
  }

  .meta {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
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
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--warn-ink);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
    margin-top: var(--space-2);
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
