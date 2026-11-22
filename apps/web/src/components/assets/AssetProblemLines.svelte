<!--
  AssetProblemLines: the blocking problems (errors) of the checks, one line each: the file, what was found against the documented rule, and
  what to do about it (`problemAction`). Never folded (docs/design/readability.md, rule 4); warnings and notes stay in AssetProblems behind
  "Problems found". Props: problems (the errors), onopenpath? (opens the file in the lightbox).
-->
<script lang="ts">
  import type { AssetProblem } from '@kiln/core';
  import { fileName } from '../../lib/assets/assets.ts';
  import { problemAction } from '../../lib/assets/lead.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Badge from '../ui/Badge.svelte';

  let { problems, onopenpath }: { problems: AssetProblem[]; onopenpath?: ((path: string) => void) | undefined } = $props();

  const safeSource = (url: string) => (url.startsWith('https://') ? url : null);
</script>

<ul class="lines" aria-label={t('assets:problems.toFix')}>
  {#each problems as problem, i (`${problem.rule}|${problem.path ?? ''}|${problem.locale ?? ''}|${problem.device ?? ''}|${i}`)}
    {@const action = problemAction(problem.rule)}
    <li>
      <Badge tone="bad" icon="x-circle">{t('assets:severity.error')}</Badge>
      <span class="text">
        {#if problem.path}
          {#if onopenpath}
            <button type="button" class="link path" onclick={() => onopenpath?.(problem.path as string)} title={problem.path}>{fileName(problem.path)}</button>
          {:else}
            <code class="path" title={problem.path}>{fileName(problem.path)}</code>
          {/if}
        {/if}
        <span class="message">{problem.message}</span>
        {#if action}<strong class="do">{action}</strong>{/if}
        {#if safeSource(problem.source)}
          <a class="rule" href={safeSource(problem.source)} target="_blank" rel="noopener noreferrer">{t('assets:problems.rule')}<span class="visually-hidden"> {t('assets:problems.newTab')}</span></a>
        {/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  .lines {
    display: grid;
    gap: 0;
    padding: 0;
    margin: 0;
    list-style: none;
    border: 1px solid var(--bad-line, var(--line));
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  li {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    font-size: 0.9375rem;
    line-height: 1.45;
    border-top: 1px solid var(--line);
  }

  li:first-child {
    border-top: 0;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .path {
    margin-right: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .do {
    margin-left: var(--space-1);
    font-weight: var(--weight-semibold);
  }

  .rule {
    margin-left: var(--space-2);
    font-size: var(--text-sm);
  }

  .link {
    width: auto;
    min-height: 0;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    background: none;
    border: 0;
    box-shadow: none;
  }
</style>
