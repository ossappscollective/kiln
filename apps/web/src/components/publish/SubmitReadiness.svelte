<!--
  SubmitReadiness: whether the draft could be submitted for review once the staged push is made, known BEFORE anything is sent
  (lib/publish-readiness.ts, docs/api/pending.md "Readiness"). "Ready to submit for review" (green), or "Submit would not run yet: N things
  to fix" with the list: the sentence the submit itself would give, "How to fix it", and a link to the place it is fixed. The codes only the
  store can tell after the push are a neutral note ("Checked after the push: image processing."). Display only.
  Props: view (ReadinessView, or null: the plan said nothing and nothing is drawn), onnavigate (called when a link to a place in Kiln is
  followed, so a dialog can close), compact (no "judged from ..." line), api + workspaceId + appId (optional: with them a language the push
  ADDS to the draft gets its one-click "Unstage fr-FR", which removes everything staged for that language of this app; the staged store and
  every staged screen read again).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { stagedStore } from '../../lib/app-state/pending-facade.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { ReadinessView } from '../../lib/publish-readiness.ts';
  import { isReviewCode } from '../../lib/review-information.ts';
  import { stagingError } from '../../lib/staged.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import ReviewInfoCopy from './ReviewInfoCopy.svelte';

  let {
    view,
    onnavigate,
    compact = false,
    api,
    workspaceId,
    appId,
  }: {
    view: ReadinessView | null;
    onnavigate?: (() => void) | undefined;
    compact?: boolean | undefined;
    api?: Api | undefined;
    workspaceId?: string | undefined;
    appId?: string | undefined;
  } = $props();

  const uid = $props.id();
  let confirming = $state('');
  let removing = $state('');
  let problem = $state('');

  async function unstage(locale: string) {
    if (api === undefined || workspaceId === undefined || appId === undefined || removing !== '') return;
    removing = locale;
    problem = '';
    try {
      const done = await api.unstageLocale(workspaceId, appId, locale);
      stagedStore.set(done.staged);
      confirming = '';
    } catch (e) {
      problem = stagingError(e);
    } finally {
      removing = '';
    }
  }
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
    {#if view.adds.length > 0 && api !== undefined && workspaceId !== undefined && appId !== undefined}
      <ul class="adds" aria-label={t('publish:readiness.adds.title')}>
        {#each view.adds as added (added.locale)}
          <li class="add small" data-testid="submit-readiness-adds" data-locale={added.locale}>
            <span>{t('publish:readiness.adds.line', { locale: added.locale })}</span>
            {#if confirming === added.locale}
              <span class="muted">{t('publish:readiness.adds.confirm', { locale: added.locale })}</span>
              <Button size="sm" variant="danger" disabled={removing !== ''} onclick={() => unstage(added.locale)} data-testid="submit-readiness-unstage-confirm">{t('publish:readiness.adds.unstage', { locale: added.locale })}</Button>
              <Button size="sm" disabled={removing !== ''} onclick={() => (confirming = '')}>{t('publish:readiness.adds.keep')}</Button>
            {:else}
              <Button size="sm" icon="x" disabled={removing !== ''} onclick={() => (confirming = added.locale)} data-testid="submit-readiness-unstage">{t('publish:readiness.adds.unstage', { locale: added.locale })}</Button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if problem !== ''}<p class="small bad-ink" role="alert">{problem}</p>{/if}
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

  .adds {
    display: grid;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .bad-ink {
    color: var(--bad-ink);
  }

  .where {
    justify-self: start;
    color: var(--link, var(--ink));
    text-decoration: underline;
  }
</style>
