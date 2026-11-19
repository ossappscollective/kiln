<!--
  StagedPushDialog: the confirmation of one push of staged changes to a store's DRAFT: what the draft holds
  now and what it will hold after, per item; the warnings of the server; and a clear statement that nothing is
  submitted or published (a separate step, not built yet). The push needs a typed name and an acknowledgement.
  It sends nothing itself: `onconfirm` is called once, and the parent sends the preview's hash.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an
  older one, or ''), onconfirm, oncancel.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import {
    NOT_SUBMITTED,
    type DraftPreview,
    canConfirmPush,
    confirmPhrase,
    previewFieldStatus,
    previewSetText,
    previewSummaryText,
    previewTextStatus,
    storeName,
    versionText,
  } from '../../lib/staged.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    open = $bindable(false),
    preview,
    busy,
    problem,
    notice,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    preview: DraftPreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  let typed = $state('');
  let ack = $state(false);

  const phrase = $derived(confirmPhrase(preview));
  const ready = $derived(canConfirmPush(preview, typed, ack));
  const store = $derived(storeName(preview.app.platform));
  const version = $derived(versionText(preview));
</script>

<Modal
  bind:open
  size="lg"
  title="Push to the {preview.app.platform === 'android' ? 'Google Play' : preview.app.platform === 'macos' ? 'Mac App Store' : 'App Store'} draft: confirm"
  description="{preview.app.name}{version ? ` · ${version}` : ''}"
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title="Something changed">{notice}</Alert>{/if}

    <Alert tone="info" title="This writes a draft. It does not submit anything.">
      {NOT_SUBMITTED}
      The items below replace what the draft in {store} holds for those fields. If someone else is editing the draft there, their edit
      to these fields is replaced. It is recorded in the audit log.
    </Alert>

    <p class="summary" data-testid="push-summary">{previewSummaryText(preview.summary)}</p>

    {#if preview.warnings.length > 0}
      <Alert tone="warn" title="Read before you confirm">
        <ul class="plain">
          {#each preview.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if preview.checks && preview.checks.blocking.length > 0}
      <Alert tone="error" title="The store says this cannot be written as it is">
        <ul class="plain">
          {#each preview.checks.blocking as check (check.code + (check.item ?? ''))}<li>{check.message}</li>{/each}
        </ul>
        Nothing can be pushed until that is fixed. Close this, fix it in the release steps, then preview again.
      </Alert>
    {/if}
    {#if preview.checks && preview.checks.warnings.length > 0}
      <Alert tone="warn" title="Read before you confirm">
        <ul class="plain">
          {#each preview.checks.warnings as check (check.code + (check.item ?? ''))}<li>{check.message}</li>{/each}
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

    <div class="field">
      <label for="{uid}-typed">Type <strong>{phrase}</strong> to confirm</label>
      <input id="{uid}-typed" type="text" autocomplete="off" spellcheck="false" bind:value={typed} disabled={busy || preview.summary.nothingToDo} />
    </div>

    <label class="check">
      <input type="checkbox" bind:checked={ack} disabled={busy || preview.summary.nothingToDo} />
      <span>
        I have read the changes above. I want them written to the {store} draft now, and I know that nothing is submitted or published by this.
      </span>
    </label>

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{preview.summary.nothingToDo ? 'Close' : 'Cancel'}</Button>
    <Button variant="danger-solid" icon="upload" loading={busy} disabled={!ready || busy} onclick={onconfirm}>Push to the draft</Button>
  {/snippet}
</Modal>

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
