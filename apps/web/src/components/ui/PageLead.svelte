<!--
  PageLead: the top of a page of an app (docs/design/readability.md, "Applied globally"): one headline that says where the page stands
  ("3 reviews need an answer", "All locales are in sync"), one short sentence under it, and the page's actions at the right (ONE primary).
  The page name itself is the app header's; this is the status and the next action, not a second title.
  Props: headline, hint? (one sentence, 15px, muted), tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' (the colour of the left edge and
  the dot), actions? (snippet: the buttons; at most one primary), aside? (snippet under the hint: a small line or a link), testid?.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    headline,
    hint,
    tone = 'neutral',
    actions,
    aside,
    testid,
  }: {
    headline: string;
    hint?: string | undefined;
    tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | undefined;
    actions?: Snippet | undefined;
    aside?: Snippet | undefined;
    testid?: string | undefined;
  } = $props();
</script>

<div class="lead" data-tone={tone} data-testid={testid} role="group" aria-label="Where this page stands">
  <div class="text">
    <p class="headline">{headline}</p>
    {#if hint}<p class="hint">{hint}</p>{/if}
    {#if aside}<div class="aside">{@render aside()}</div>{/if}
  </div>
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</div>

<style>
  .lead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 4px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .lead[data-tone='ok'] {
    border-left-color: var(--ok);
  }

  .lead[data-tone='warn'] {
    border-left-color: var(--warn);
  }

  .lead[data-tone='bad'] {
    border-left-color: var(--bad, var(--danger-solid));
  }

  .lead[data-tone='info'] {
    border-left-color: var(--info, var(--accent));
  }

  .text {
    flex: 1 1 18rem;
    min-width: 0;
  }

  .headline {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    line-height: 1.25;
  }

  .hint {
    max-width: 68ch;
    margin: var(--space-1) 0 0;
    font-size: 0.9375rem;
    line-height: 1.45;
    color: var(--muted);
  }

  .aside {
    margin-top: var(--space-2);
    font-size: 0.9375rem;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
</style>
