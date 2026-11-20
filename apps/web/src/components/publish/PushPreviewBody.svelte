<!--
  PushPreviewBody: what a push of staged changes would write to the store's DRAFT, as the confirmation of the push shows it: the
  summary line, the warnings and checks of the server, and per item what the draft holds now and after (texts, release fields,
  graphics). Display only: it sends nothing and asks for nothing. Used by StagedPushDialog and by the batch publish dialog, so a
  push looks the same in both.
  Props: preview (the draft preview of the server).
-->
<script lang="ts">
  import {
    type DraftPreview,
    previewFieldStatus,
    previewSetText,
    previewSummaryText,
    previewTextStatus,
  } from '../../lib/staged.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';

  let { preview }: { preview: DraftPreview } = $props();

  /** The warnings of the server and the store's warning checks, in ONE list under ONE heading (never two alerts that say the same). */
  const readFirst = $derived(
    [...preview.warnings, ...(preview.checks ? preview.checks.warnings.map((c) => c.message) : [])].filter((w, i, all) => w.trim() !== '' && all.indexOf(w) === i),
  );
</script>

<div class="stack">
  <p class="summary" data-testid="push-summary">{previewSummaryText(preview.summary)}</p>

  {#if preview.checks && preview.checks.blocking.length > 0}
    <Alert tone="error" title="The store says this cannot be written as it is">
      <ul class="plain">
        {#each preview.checks.blocking as check (check.code + (check.item ?? ''))}<li>{check.message}</li>{/each}
      </ul>
      Nothing can be pushed until that is fixed. Close this, fix it in the release steps, then preview again.
    </Alert>
  {/if}
  {#if readFirst.length > 0}
    <Alert tone="warn" title="Read before you confirm">
      <ul class="plain">
        {#each readFirst as text (text)}<li>{text}</li>{/each}
      </ul>
    </Alert>
  {/if}

  {#if (preview.release ?? []).length > 0}
    <section aria-label="Release" class="stack">
      <h3>Release ({(preview.release ?? []).length})</h3>
      {#each preview.release ?? [] as r (r.id)}
        {@const status = previewFieldStatus(r)}
        <div class="item">
          <p class="item-head">
            <strong>{r.label}</strong>{#if r.locale} <span class="muted">{r.locale}</span>{/if}
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          {#if r.status === 'local'}
            <p class="small">Kept here only: {r.after}. It is never written to the store by a push. You name the share again when you release.</p>
          {:else if r.status !== 'unchanged'}
            <div class="compare">
              <div>
                <p class="label">In the draft now</p>
                <p class="text">{#if r.before === null || r.before === ''}<span class="muted">Not set</span>{:else}{r.before}{/if}</p>
              </div>
              <div>
                <p class="label">After the push</p>
                <p class="text">{r.after}</p>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if preview.text.length > 0}
    <section aria-label="Texts" class="stack">
      <h3>Texts ({preview.text.length})</h3>
      {#each preview.text as t (t.id || `${t.locale}/${t.field}`)}
        {@const status = previewTextStatus(t)}
        <div class="item">
          <p class="item-head">
            <strong>{t.field}</strong> <span class="muted">{t.locale}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          {#if t.status !== 'unchanged'}
            <div class="compare">
              <div>
                <p class="label">In the draft now</p>
                <p class="text">{#if t.before === null}<span class="muted">{t.localeExists ? 'Not set' : 'The locale is not in the draft'}</span>{:else}{t.before}{/if}</p>
              </div>
              <div>
                <p class="label">After the push</p>
                <p class="text">{t.after}</p>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if preview.assets.length > 0}
    <section aria-label="Graphics" class="stack">
      <h3>Graphics ({preview.assets.length})</h3>
      {#each preview.assets as set (set.id)}
        <div class="item">
          <p class="item-head">
            <strong>{set.target}</strong> <span class="muted">{set.locale}</span>
            <Badge tone={set.status === 'unchanged' ? 'neutral' : 'info'}>{set.status === 'unchanged' ? 'Already the same' : 'Will change'}</Badge>
          </p>
          <p class="small">
            In the draft now: {set.before.setExists ? `${set.before.files.length} ${set.before.files.length === 1 ? 'file' : 'files'}` : 'no set'}.
            After the push: {set.after.files.length} {set.after.files.length === 1 ? 'file' : 'files'}.
            {previewSetText(set)}
          </p>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .summary {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }

  .item {
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .item-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 var(--space-2);
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .text {
    margin: 0;
    max-height: 9rem;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
