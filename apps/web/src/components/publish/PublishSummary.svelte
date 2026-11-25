<!--
  PublishSummary: "What will be published", the block at the top of the publish dialog that says WHAT goes out and WHERE before the
  steps do: the app and the store, the track and the share of users (or the App Store submission), the version and the build it
  names, the release notes, the assets and texts, and one plain sentence on what Publish does for the ticked steps. Display only: the
  words come from lib/publish-summary.ts (a pure function of the plan), so it follows the ticks and the Track and Share fields.
  While the plan is being made it shows a quiet line and a skeleton (null summary). The long release notes sit behind "Details".
  Props: summary (PublishSummary, or null while the first plan is made), busy (the plan is being made again: the old words stay).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { PublishSummary } from '../../lib/publish-summary.ts';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { summary, busy = false }: { summary: PublishSummary | null; busy?: boolean | undefined } = $props();

  const uid = $props.id();
</script>

<section class="summary" aria-labelledby="{uid}-title" aria-busy={busy || summary === null} data-testid="publish-summary">
  <h3 id="{uid}-title" class="title">{t('publish:summary.title')}</h3>

  {#if summary === null}
    <div class="stack" role="status">
      <p class="muted small">{t('publish:summary.loading')}</p>
      <Skeleton width="80%" height="14px" />
      <Skeleton width="55%" height="14px" />
    </div>
  {:else}
    <dl class="facts">
      {#each summary.rows as row (row.id)}
        <dt>{row.label}</dt>
        <dd data-testid="summary-{row.id}">
          <span class:mono={row.mono}>{row.value}</span>
          {#if row.chip}<span class="chip">{row.chip}</span>{/if}
          {#if row.hint}<span class="hint">{row.hint}</span>{/if}
        </dd>
      {/each}
    </dl>

    {#if summary.notes && (summary.notes.first || summary.notes.others.length > 0)}
      <Disclosure summary={t('publish:summary.notes.details')}>
        <div class="stack notes">
          {#if summary.notes.first}
            <div>
              <p class="locale">{summary.notes.first.locale}</p>
              {#each summary.notes.first.lines as line, i (i)}<p class="line">{line}</p>{/each}
              {#if summary.notes.first.truncated}<p class="line muted" aria-hidden="true">&hellip;</p>{/if}
            </div>
          {/if}
          {#if summary.notes.others.length > 0}
            <div>
              <p class="locale">{t('publish:summary.notes.others')}</p>
              <ul class="locales">
                {#each summary.notes.others as other (other.locale)}
                  <li class="chip">{other.locale}{#if other.empty}<span class="muted"> · {t('publish:summary.notes.empty')}</span>{/if}</li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      </Disclosure>
    {/if}

    {#if summary.footnote}<p class="muted small" data-testid="summary-footnote">{summary.footnote}</p>{/if}
    <p class="outcome" data-testid="summary-outcome"><Icon name="info" size={14} /> <span>{summary.outcome}</span></p>
  {/if}
</section>

<style>
  .summary {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    color: var(--ink);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
  }

  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt {
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.95em;
  }

  .hint {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .chip {
    display: inline-block;
    padding: 0 var(--space-2);
    margin-inline-start: var(--space-2);
    font-size: var(--text-sm);
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-radius: var(--radius-lg, 999px);
  }

  .notes {
    min-width: 0;
  }

  .locale {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .line {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .locales {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .locales .chip {
    margin-inline-start: 0;
  }

  .outcome {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0;
    padding-top: var(--space-3);
    color: var(--ink);
    border-top: 1px solid var(--line);
  }
</style>
