<!--
  PublishFailure: why a publish did not go through, from the run the server kept (docs/api/pending.md "Why a publish failed"): the
  line "Stopped at: Push the draft. 0 done, 1 failed, 2 not run.", then each step with its status and, under the failed one, the
  reason: what the error code means, what to do when the server named a known cause, the store's own words (cut to 300 characters
  with "Show more") and the technical line (code, HTTP status, the store's reason). "Copy details" puts a redacted plain-text report
  on the clipboard. Draws nothing it was not given; sends nothing.
  Props: run (the kept run), appName (for the report), platform, ondismiss? (adds the close button of the alert; the caller tells the
  server), compact? (no heading: the dialog already has one), onpushsubmit? (Google Play would not keep a draft: "Push and submit for
  review in one step" opens the plan with that one step, which still asks for the confirmation and the step-up; no button without it;
  "Make the change in Play Console" is a link that is always shown for that refusal).
-->
<script lang="ts">
  import type { Platform } from '@kiln/core';
  import { t } from '../../lib/i18n/t.ts';
  import type { LastPublish } from '../../lib/pending.ts';
  import { clip, failureActions, failureReport, runSummary, stepLines } from '../../lib/publish-failure.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';

  let {
    run,
    appName,
    platform,
    ondismiss = undefined,
    compact = false,
    onpushsubmit = undefined,
  }: {
    run: LastPublish;
    appName: string;
    platform: Platform;
    ondismiss?: (() => void) | undefined;
    compact?: boolean | undefined;
    onpushsubmit?: (() => void) | undefined;
  } = $props();

  const uid = $props.id();
  const summary = $derived(runSummary(run));
  const lines = $derived(stepLines(run));
  const report = $derived(failureReport({ appName, platform, run }));
  const actions = $derived(failureActions(run, platform));
  let open = $state<Record<string, boolean>>({});
</script>

<Alert tone="error" {ondismiss}>
  <div class="failure" data-testid="publish-last-failed">
    {#if !compact}<strong>{t('publish:failure.heading')}</strong>{/if}
    <p class="small summary">{summary.title} {summary.text}</p>
    <ol class="steps" aria-label={t('publish:failure.stepsAria')}>
      {#each lines as line (line.key)}
        <li class="step" data-status={line.status}>
          <div class="step-head">
            <span class="step-name">{line.label}</span>
            <Badge tone={line.tone === 'ok' ? 'ok' : line.tone === 'bad' ? 'bad' : 'neutral'}>{line.word}</Badge>
          </div>
          {#if line.note !== ''}<p class="small muted">{line.note}</p>{/if}
          {#if line.reason}
            {@const r = line.reason}
            {@const said = clip(r.said)}
            <div class="reason" data-testid="publish-failure-reason">
              <p class="title">{r.title}</p>
              {#if r.advice !== ''}<p class="advice">{r.advice}</p>{/if}
              {#if r.said !== ''}
                <p class="said">
                  <span class="said-label">{t('publish:failure.storeSaid')}</span>
                  <q id="{uid}-{line.key}-said">{open[line.key] || !said.cut ? r.said : said.text}</q>
                  {#if said.cut}
                    <button type="button" class="link" aria-expanded={open[line.key] === true} aria-controls="{uid}-{line.key}-said" onclick={() => (open[line.key] = !open[line.key])}>
                      {open[line.key] ? t('publish:failure.showLess') : t('publish:failure.showMore')}
                    </button>
                  {/if}
                </p>
              {/if}
              {#if r.outcome !== ''}<p class="small muted">{r.outcome}</p>{/if}
              <p class="technical small" data-testid="publish-failure-technical"><span class="visually-hidden">{t('publish:failure.technical')}: </span><code>{r.technical}</code></p>
            </div>
            {#if line.type === 'push_draft' && actions.playConsoleUrl !== null}
              <div class="actions" data-testid="publish-failure-actions">
                {#if actions.pushAndSubmit && onpushsubmit}
                  <Button size="sm" variant="primary" onclick={onpushsubmit}>{t('publish:failure.pushAndSubmit')}</Button>
                {/if}
                <a class="link-button" href={actions.playConsoleUrl} target="_blank" rel="noreferrer noopener">{t('publish:failure.openPlayConsole')}</a>
              </div>
              {#if actions.pushAndSubmit && onpushsubmit}<p class="small muted">{t('publish:failure.pushAndSubmitHint')}</p>{/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
    <div class="copy"><CopyButton value={report} label={t('publish:failure.copy')} copiedLabel={t('publish:failure.copied')} size="sm" variant="secondary" /></div>
  </div>
</Alert>

<style>
  .failure {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .summary {
    margin: 0;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .step-name {
    font-weight: var(--weight-semibold);
  }

  .reason {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    margin-top: var(--space-1);
    background: var(--surface);
    border-left: 3px solid var(--bad);
    border-radius: var(--radius-sm);
  }

  .reason p {
    margin: 0;
  }

  .title {
    font-weight: var(--weight-semibold);
  }

  .said q {
    quotes: none;
    overflow-wrap: anywhere;
  }

  .said-label {
    color: var(--muted);
  }

  .technical code {
    overflow-wrap: anywhere;
  }

  button.link {
    padding: 0;
    font: inherit;
    color: var(--link, var(--accent));
    text-decoration: underline;
    cursor: pointer;
    background: none;
    border: 0;
  }

  .copy {
    align-self: flex-start;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    margin-top: var(--space-2);
  }

  a.link-button {
    color: var(--link, var(--accent));
    text-decoration: underline;
  }
</style>
