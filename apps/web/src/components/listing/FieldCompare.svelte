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
  import { k, t } from '../../lib/i18n/t.ts';
  import {
    comparison,
    statusExplanation,
    usage,
    usageText,
    shortRef,
  } from '../../lib/listing/drift.ts';
  import { blockingLines, fieldLimitNote, fieldWord } from '../../lib/listing/locale-drawer.ts';
  import { useCompare } from '../../lib/listing/compare-context.ts';
  import { cellInfo, cellStatus } from '../../lib/listing/matrix.ts';
  import type { FieldStage } from '../../lib/staged.ts';
  import type { DriftField, DriftSide } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import DiffText from './DiffText.svelte';

  let {
    field,
    storeLabel,
    now,
    onhistory,
    pullable = false,
    pullDisabled = null,
    selected = false,
    onselect,
    onpull,
    stage: stageProp,
    stageBusy = false,
    onstage,
    onunstage,
    extra,
  }: {
    field: DriftField;
    storeLabel?: string | undefined;
    now: number;
    onhistory: (field: DriftField) => void;
    pullable?: boolean | undefined;
    pullDisabled?: string | null | undefined;
    selected?: boolean | undefined;
    onselect?: ((field: DriftField, selected: boolean) => void) | undefined;
    onpull?: ((field: DriftField) => void) | undefined;
    stage?: FieldStage | undefined;
    stageBusy?: boolean | undefined;
    onstage?: ((field: DriftField) => void) | undefined;
    onunstage?: ((id: string, field: DriftField) => void) | undefined;
    extra?: Snippet | undefined;
  } = $props();

  const uid = $props.id();
  const compare = useCompare();
  // With the repository comparison off the field is judged on the store's value alone: no repository column, no "stage from repo".
  const repoOn = $derived(compare().repo);
  const stage = $derived(repoOn ? stageProp : undefined);
  // A staged text is shown (badge, Discard) whatever the comparison switch says: it exists in the pending changes either way.
  const stagedNow = $derived(stageProp?.staged ?? null);
  let showCompare = $state(false);
  const diff = $derived(comparison(field));
  const status = $derived(cellStatus(field));
  const info = $derived(cellInfo(status, !repoOn));
  const note = $derived(fieldLimitNote(field));
  const lines = $derived(blockingLines(field));
  const columns = $derived([
    ...(repoOn ? [{ key: 'repo', title: t('listing:compare.col.repo'), side: field.repo, hint: t('listing:compare.col.repoHint') }] : []),
    { key: 'db', title: t('listing:compare.col.db'), side: field.db, hint: t('listing:compare.col.dbHint') },
    { key: 'live', title: storeLabel ?? t('listing:compare.liveStore'), side: field.live, hint: t('listing:compare.col.liveHint') },
  ]);

  const SOURCE_KEYS = {
    changeSet: k('listing:compare.source.changeSet'),
    changeSetRef: k('listing:compare.source.changeSetRef'),
    since: k('listing:compare.source.since'),
    sinceRef: k('listing:compare.source.sinceRef'),
  };
  const sourceNote = (side: DriftSide): string => {
    if (side.observedAt === null) return '';
    const ref = side.source ? shortRef(side.source, side.sourceRef) : null;
    const changeSet = side.source === 'change_set';
    const key = changeSet ? (ref ? SOURCE_KEYS.changeSetRef : SOURCE_KEYS.changeSet) : ref ? SOURCE_KEYS.sinceRef : SOURCE_KEYS.since;
    return t(key, { when: timeAgo(side.observedAt, now), ref: ref ?? '' });
  };
  const who = $derived({ label: field.label, locale: field.locale });
</script>

<details class="field" open={status !== 'sync'}>
  <summary>
    <span class="chev"><Icon name="chevron-right" size={16} /></span>
    <span class="name">{field.label}</span>
    <Badge tone={info.tone} icon={info.icon}>{fieldWord(status, !repoOn)}</Badge>
    {#if lines.length > 0 && status !== 'over'}
      <Badge tone="warn">{t('listing:compare.limitProblem')}</Badge>
    {/if}
    {#if stagedNow}
      <Badge tone="accent" icon="layers">{t('listing:compare.staged')}</Badge>
    {/if}
    {#if note}<span class="count" class:over={note.over}>{note.text}</span>{/if}
  </summary>

  <div class="body">
    {#if repoOn}<p class="muted explain">{statusExplanation(field.status)}</p>{/if}
    {#each lines as line, i (i)}
      <p class="problem" class:over={status === 'over'}><Icon name="alert-triangle" size={14} /> {line}</p>
    {/each}
    <div class="actions">
      {#if pullable}
        <label class="check pick">
          <input
            type="checkbox"
            checked={selected}
            aria-label={t('listing:compare.selectFor', who)}
            disabled={pullDisabled !== null}
            onchange={(e) => onselect?.(field, e.currentTarget.checked)}
          />
          <span>{t('listing:compare.select')}</span>
        </label>
        <Button size="sm" icon="git-pull-request" disabled={pullDisabled !== null} aria-label={t('listing:compare.pullFor', who)} onclick={() => onpull?.(field)}>{t('listing:compare.pull')}</Button>
      {/if}
      {#if stage && stage.staged}
        <span class="staged-note">
          {stage.upToDate ? t('listing:compare.stagedUpToDate') : t('listing:compare.stagedOutdated')}
        </span>
      {/if}
      {#if stage && stage.state === 'available'}
        <Button
          size="sm"
          icon="layers"
          loading={stageBusy}
          disabled={stageBusy || stage.upToDate}
          aria-label={stage.staged ? (stage.upToDate ? t('listing:compare.stagedFromRepoFor', who) : t('listing:compare.stageAgainFor', who)) : t('listing:compare.stageFor', who)}
          onclick={() => onstage?.(field)}
        >
          {stage.staged ? (stage.upToDate ? t('listing:compare.stagedFromRepo') : t('listing:compare.stageAgain')) : t('listing:compare.stageFromRepo')}
        </Button>
      {:else if stage && stage.state === 'disabled'}
        <Button size="sm" icon="layers" disabled title={stage.reason ?? undefined} aria-label={t('listing:compare.stageDisabledFor', { ...who, reason: stage.reason ?? '' })}>{t('listing:compare.stageFromRepo')}</Button>
      {:else if stage && stage.state === 'not_pushable'}
        <span class="muted small" title={stage.reason ?? undefined}>{t('listing:compare.notPartOfPush')}</span>
      {/if}
      {#if stagedNow}
        <Button size="sm" variant="ghost" icon="x" disabled={stageBusy} aria-label={t('listing:compare.discardFor', who)} onclick={() => onunstage?.(stagedNow.id, field)}>{t('listing:compare.discard')}</Button>
      {/if}
    </div>
    {#if extra}{@render extra()}{/if}
    <div class="quiet">
      <button type="button" class="link" aria-expanded={showCompare} aria-controls="{uid}-compare" aria-label={showCompare ? t('listing:compare.hideFor', who) : t('listing:compare.showFor', who)} onclick={() => (showCompare = !showCompare)}>
        {showCompare ? t('listing:compare.hide') : t('listing:compare.show')}
      </button>
      <Button size="sm" variant="ghost" icon="history" aria-label={t('listing:compare.historyFor', who)} onclick={() => onhistory(field)}>{t('listing:compare.history')}</Button>
    </div>
    <div class="columns" id="{uid}-compare" hidden={!showCompare}>
      {#each columns as col (col.key)}
        {@const u = usage(col.side.value, field.limit, field.unit)}
        <section class="col" aria-label={t('listing:compare.colAria', { field: field.label, column: col.title })}>
          <h4 title={col.hint}>{col.title}</h4>
          {#if col.side.value === null}
            <p class="none muted">{col.side.observedAt === null ? t('listing:compare.noValue') : t('listing:compare.removed')}</p>
          {:else}
            <div class="value">
              {#if diff && col.key === 'repo'}
                <DiffText from={diff.fromValue} to={diff.toValue} side="to" fromName={t('listing:diff.name.store')} toName={t('listing:diff.name.repository')} />
              {:else if diff && col.key === 'live'}
                <DiffText from={diff.fromValue} to={diff.toValue} side="from" fromName={t('listing:diff.name.store')} toName={t('listing:diff.name.repository')} />
              {:else}
                {col.side.value}
              {/if}
            </div>
            <p class="meta" class:over={u.over}>
              {usageText(u)}{#if u.over}<span class="visually-hidden"> {t('listing:history.overLimit')}</span>{/if}
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
