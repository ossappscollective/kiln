<script lang="ts">
  import type { TestResult } from '../../lib/types.ts';
  import { summarizeTest } from '../../lib/credentials.ts';
  import Icon from '../ui/Icon.svelte';
  import Spinner from './Spinner.svelte';
  import type { TesterStatus } from './tester.svelte.ts';

  let {
    status,
    result,
    error,
    onTroubleshoot,
  }: {
    status: TesterStatus;
    result: TestResult | null;
    /** Why the test could not run at all (no connection, rate limit). Not the credential's fault. */
    error: string;
    /** When given, a failed test offers to open the "If something goes wrong" list. */
    onTroubleshoot?: (() => void) | undefined;
  } = $props();

  const summary = $derived(status === 'done' && result ? summarizeTest(result) : null);
  const open = $derived(status !== 'idle');
</script>

<!-- The live region is always in the page, so what appears in it is announced. -->
<div class="slot" class:open>
  <div class="clip">
    <div class="live" role="status" aria-live="polite" aria-atomic="true">
      {#if status === 'testing'}
        <p class="box pending"><Spinner /> Testing the connection…</p>
      {:else if summary}
        <div class="box {summary.tone}">
          <p class="message"><Icon name={summary.ok ? 'check-circle' : 'x-circle'} /> <strong>{summary.ok ? 'Connection works.' : 'Test failed.'}</strong> {summary.message}</p>
          {#if summary.details.length > 0}
            <ul>
              {#each summary.details as line (line)}<li>{line}</li>{/each}
            </ul>
          {/if}
          {#if !summary.ok && onTroubleshoot}
            <p class="next">
              Check the details above, then
              <button type="button" class="link" onclick={onTroubleshoot}>see what to try in “If something goes wrong”</button>.
            </p>
          {/if}
        </div>
      {:else if status === 'error'}
        <p class="box bad"><Icon name="x-circle" /> <strong>Could not run the test.</strong> {error}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  /* The result opens like a drawer, so nothing below it jumps. */
  .slot {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.18s ease;
  }

  .slot.open {
    grid-template-rows: 1fr;
  }

  .clip {
    min-height: 0;
    overflow: hidden;
  }

  .box {
    margin: 10px 0 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
  }

  .box.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
  }

  .box.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
  }

  .box.pending {
    color: var(--muted);
    background: var(--ground);
  }

  .message {
    margin: 0;
  }

  ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }

  .next {
    margin: 8px 0 0;
  }

  .next button.link {
    color: inherit;
    text-decoration: underline;
    text-align: left;
  }

  @media (prefers-reduced-motion: reduce) {
    .slot {
      transition: none;
    }
  }
</style>
