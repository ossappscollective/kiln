<!--
  AssetProblems: the problems the checks found, each with the documented rule in words, what was
  found, and the page the rule comes from. A rule whose number is not on an official page is
  marked "Unverified" and is never an error.
  Props: problems, showPath = true (name the file a problem is about), onopenpath? (called with
  the path when the file name is chosen, so a lightbox can open it).
  The checks hold the files against the documented specs. They never ask a store.
-->
<script lang="ts">
  import type { AssetProblem } from '@mrm/core';
  import { fileName, severityLabel, severityTone } from '../../lib/assets.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import Badge from '../ui/Badge.svelte';

  let {
    problems,
    showPath = true,
    onopenpath,
  }: { problems: AssetProblem[]; showPath?: boolean; onopenpath?: (path: string) => void } = $props();

  const safeSource = (url: string) => (url.startsWith('https://') ? url : null);
</script>

<ul class="problems" aria-label="Problems found">
  {#each problems as problem, i (`${problem.rule}|${problem.path ?? ''}|${problem.locale ?? ''}|${problem.device ?? ''}|${i}`)}
    {@const tone = severityTone(problem.severity)}
    <li>
      <span class="head">
        <Badge {tone} icon={toneIcon(tone)}>{severityLabel(problem.severity)}</Badge>
        {#if !problem.verified}<Badge tone="neutral" icon="help">Unverified rule</Badge>{/if}
        {#if showPath && problem.path}
          {#if onopenpath}
            <button type="button" class="link path" onclick={() => onopenpath?.(problem.path as string)} title={problem.path}>{fileName(problem.path)}</button>
          {:else}
            <code class="path" title={problem.path}>{fileName(problem.path)}</code>
          {/if}
        {/if}
      </span>
      <span class="message">{problem.message}</span>
      <span class="meta muted">
        <code>{problem.rule}</code>
        {#if safeSource(problem.source)}
          <a href={safeSource(problem.source)} target="_blank" rel="noopener noreferrer">Source of the rule<span class="visually-hidden"> (opens in a new tab)</span></a>
        {/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  .problems {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-3);
  }
  li {
    display: grid;
    gap: var(--space-1);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .message {
    font-size: var(--text-base);
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    min-height: 0;
    width: auto;
    box-shadow: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
