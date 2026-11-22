<!--
  SyncAllPanel: progress and per-app results of a "Sync all" run. It only shows; the run itself
  is in Portfolio.svelte.
  Props: running, total, done, current (name of the app being synced, or ''), results
  (BatchResult[], in run order), summary (a sentence for when it is over), canRetry (some apps
  failed or were not run), onstop, onretry, ondismiss.
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import type { BatchResult } from '../../lib/portfolio.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import type { IconName } from '../ui/icons.ts';

  let {
    running,
    total,
    done,
    current,
    results,
    summary,
    canRetry,
    onstop,
    onretry,
    ondismiss,
  }: {
    running: boolean;
    total: number;
    done: number;
    current: string;
    results: BatchResult[];
    summary: string;
    canRetry: boolean;
    onstop: () => void;
    onretry: () => void;
    ondismiss: () => void;
  } = $props();

  const icons: Record<BatchResult['status'], IconName> = {
    pending: 'clock',
    running: 'refresh',
    ok: 'check-circle',
    failed: 'alert',
    busy: 'info',
    skipped: 'minus',
  };

  const words: Record<BatchResult['status'], string> = {
    pending: k('portfolio:batch.word.pending'),
    running: k('portfolio:batch.word.running'),
    ok: k('portfolio:batch.word.ok'),
    failed: k('portfolio:batch.word.failed'),
    busy: k('portfolio:batch.word.busy'),
    skipped: k('portfolio:batch.word.skipped'),
  };

  const progress = $derived(
    running
      ? current
        ? t('portfolio:batch.progressApp', { n: Math.min(done + 1, total), total, name: current })
        : t('portfolio:batch.progress', { n: Math.min(done + 1, total), total })
      : summary,
  );
</script>

<section class="card panel" aria-labelledby="sync-all-title">
  <div class="head">
    <div>
      <h2 id="sync-all-title" class="title">{t('portfolio:batch.title')}</h2>
      <p class="progress-text" role="status">{progress}</p>
    </div>
    <div class="row">
      {#if running}
        <Button size="sm" onclick={onstop}>{t('portfolio:batch.stop')}</Button>
      {:else}
        {#if canRetry}<Button size="sm" icon="refresh" onclick={onretry}>{t('portfolio:batch.retry')}</Button>{/if}
        <Button size="sm" variant="ghost" onclick={ondismiss}>{t('common:action.dismiss')}</Button>
      {/if}
    </div>
  </div>

  <progress max={total} value={done} aria-label={t('portfolio:batch.progressLabel')}></progress>

  <ul class="results">
    {#each results as result (result.appId)}
      <li class="result {result.status}">
        <span class="mark" class:spin={result.status === 'running'}><Icon name={icons[result.status]} size={16} /></span>
        <div>
          <p class="name"><strong>{result.name}</strong> <span class="state">{t(words[result.status])}</span></p>
          {#if result.message}<p class="message">{result.message}</p>{/if}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-6);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
  }

  .title {
    font-size: var(--text-md);
  }

  .progress-text {
    margin: var(--space-1) 0 0;
    color: var(--muted);
  }

  progress {
    width: 100%;
    height: var(--space-2);
    accent-color: var(--accent);
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .result {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .mark {
    display: inline-flex;
    margin-top: 2px;
    color: var(--muted);
  }

  .result.ok .mark {
    color: var(--ok-ink);
  }

  .result.failed .mark {
    color: var(--bad-ink);
  }

  .result.busy .mark,
  .result.skipped .mark {
    color: var(--warn-ink);
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  .name,
  .message {
    margin: 0;
  }

  .state {
    color: var(--muted);
  }

  .message {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .result.failed .message {
    color: var(--bad-ink);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
