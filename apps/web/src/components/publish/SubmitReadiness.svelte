<!--
  SubmitReadiness: whether the draft could be submitted for review once the staged push is made, known BEFORE anything is sent
  (lib/publish-readiness.ts, docs/api/pending.md "Readiness"). "Ready to submit for review" (green), or "Submit would not run yet: N things
  to fix" with the list: the sentence the submit itself would give, "How to fix it", and a link to the place it is fixed. The codes only the
  store can tell after the push are a neutral note ("Checked after the push: image processing."). Display only.
  Props: view (ReadinessView, or null: the plan said nothing and nothing is drawn), onnavigate (called when a link to a place in Kiln is
  followed, so a dialog can close), compact (no "judged from ..." line).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { ReadinessView } from '../../lib/publish-readiness.ts';
  import { isReviewCode } from '../../lib/review-information.ts';
  import Icon from '../ui/Icon.svelte';
  import ReviewInfoCopy from './ReviewInfoCopy.svelte';

  let {
    view,
    onnavigate,
    compact = false,
  }: {
    view: ReadinessView | null;
    onnavigate?: (() => void) | undefined;
    compact?: boolean | undefined;
  } = $props();

  const uid = $props.id();
</script>

{#if view}
  <section class="readiness" class:ok={view.state === 'ready'} class:bad={view.state === 'blocked'} aria-labelledby="{uid}-title" data-testid="submit-readiness" data-state={view.state}>
    <p id="{uid}-title" class="head">
      <Icon name={view.state === 'ready' ? 'check-circle' : 'alert-triangle'} size={16} />
      <strong data-testid="submit-readiness-title">{view.title}</strong>
    </p>
    {#if view.state === 'ready'}
      <p class="small muted">{t('publish:readiness.readyHint')}</p>
    {:else}
      {#if view.submitLeftOut}<p class="small" data-testid="submit-readiness-left-out">{t('publish:readiness.leftOut')}</p>{/if}
      <ul class="lines" aria-label={view.title}>
        {#each view.lines as line (line.id)}
          <li class="line" data-testid="submit-readiness-line" data-code={line.code}>
            <span class="said">{line.message}</span>
            {#if line.origin !== null}<span class="origin small muted" data-testid="submit-readiness-origin">{line.origin}</span>{/if}
            <span class="how small"><strong>{t('publish:readiness.how')}</strong> {line.fix}</span>
            {#if line.href !== null && line.where !== null}
              {#if line.external}
                <a class="where small" href={line.href} target="_blank" rel="noopener noreferrer">{line.where} <Icon name="external-link" size={12} /></a>
              {:else}
                <a class="where small" href={line.href} onclick={() => onnavigate?.()}>{line.where}</a>
              {/if}
            {/if}
            {#if isReviewCode(line.code)}<ReviewInfoCopy from={line.reviewFrom} />{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if view.note}<p class="small muted" data-testid="submit-readiness-note"><Icon name="info" size={12} /> {view.note}</p>{/if}
    {#if !compact && view.predicted}<p class="small muted">{t('publish:readiness.predicted')}</p>{/if}
  </section>
{/if}

<style>
  .readiness {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .readiness.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .readiness.bad {
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .readiness.bad .head {
    color: var(--bad-ink);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .muted {
    color: var(--muted);
  }

  .readiness.ok .muted {
    color: inherit;
  }

  .lines {
    display: grid;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .line {
    display: grid;
    gap: var(--space-1);
    color: var(--ink);
  }

  .where {
    justify-self: start;
    color: var(--link, var(--ink));
    text-decoration: underline;
  }
</style>
