<!--
  StoreGraphicsNotes: what the store-side checks found, in as few lines as possible. One row per rule (never one per image): the
  rule in words, how many images it concerns and which ones as chips, and ONE link to the rule's page per group. Problems (errors and
  warnings) first, then one collapsed line for the notes, then one collapsed line for the images that could not be checked. Everything
  is collapsed by default; a row opens to the images and what was found for each.
  Props: problems (the list `checkStoreImages` gives).
-->
<script lang="ts">
  import type { AssetProblem } from '@kiln/core';
  import { severityLabel, severityTone } from '../../lib/assets/assets.ts';
  import { type ProblemGroup, splitGroups } from '../../lib/assets/problem-groups.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import Badge from '../ui/Badge.svelte';

  let { problems }: { problems: AssetProblem[] } = $props();

  const split = $derived(splitGroups(problems));
  const notesTotal = $derived(split.counts.notes);
  const safeSource = (url: string) => (url.startsWith('https://') ? url : null);
</script>

{#snippet detail(group: ProblemGroup)}
  <div class="body">
    {#if group.text}<p class="text">{group.text}</p>{/if}
    <ul class="chips" aria-label={t('assets:store.notesImages')}>
      {#each group.items as item, i (`${item.path}|${i}`)}
        <li><span class="chip" title={item.found || item.path}>{item.chip || item.path}</span>{#if item.found}<span class="found muted">{item.found}</span>{/if}</li>
      {/each}
    </ul>
    <p class="meta muted">
      {#if !group.verified}{t('assets:problems.unverified')} · {/if}
      {#if safeSource(group.source)}
        <a href={safeSource(group.source)} target="_blank" rel="noopener noreferrer">{t('assets:store.ruleSourceShort')}<span class="visually-hidden"> {t('assets:problems.newTab')}</span></a>
      {/if}
    </p>
  </div>
{/snippet}

<div class="notes" aria-label={t('assets:problems.label')}>
  {#each split.problems as group (`${group.rule}|${group.severity}`)}
    {@const tone = severityTone(group.severity)}
    <details class="group">
      <summary>
        <Badge {tone} icon={toneIcon(tone)}>{severityLabel(group.severity)}</Badge>
        <span class="title">{group.text}</span>
        <span class="count muted">{t('assets:store.groupCount', { count: group.count })}</span>
      </summary>
      {@render detail(group)}
    </details>
  {/each}

  {#if split.notes.length > 0}
    <details class="group">
      <summary>
        <Badge tone="info" icon={toneIcon('info')}>{t('assets:store.notesLabel')}</Badge>
        <span class="title">{t('assets:store.notesLine', { count: notesTotal })}</span>
      </summary>
      <div class="inner">
        {#each split.notes as group (`${group.rule}|${group.severity}`)}
          <div class="sub">
            <p class="text"><strong>{group.count}×</strong> {group.text}</p>
            {@render detail({ ...group, text: '' })}
          </div>
        {/each}
      </div>
    </details>
  {/if}

  {#if split.unread}
    <details class="group">
      <summary>
        <Badge tone="neutral" icon="help">{t('assets:store.unreadLabel')}</Badge>
        <span class="title">{t('assets:store.unreadLine', { count: split.counts.unread })}</span>
      </summary>
      <div class="body">
        <p class="text">{t('assets:store.unreadCause')}</p>
        <ul class="chips" aria-label={t('assets:store.notesImages')}>
          {#each split.unread.items as item, i (`${item.path}|${i}`)}
            <li><span class="chip">{item.chip || item.path}</span></li>
          {/each}
        </ul>
      </div>
    </details>
  {/if}
</div>

<style>
  .notes {
    display: grid;
    gap: var(--space-1);
  }
  .group {
    border-top: 1px solid var(--line);
    padding: var(--space-2) 0;
  }
  .group:first-child {
    border-top: 0;
    padding-top: 0;
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }
  .count,
  .muted {
    color: var(--muted);
  }
  .count {
    flex: none;
    font-size: var(--text-sm);
  }
  .body,
  .inner {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-2) 0 0 var(--space-1);
  }
  .sub {
    display: grid;
    gap: var(--space-1);
  }
  .text {
    margin: 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chips li {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }
  .chip {
    padding: 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-radius: var(--radius-sm);
  }
  .found {
    font-size: var(--text-xs);
  }
  .meta {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
