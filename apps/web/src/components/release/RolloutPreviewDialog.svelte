<!--
  RolloutPreviewDialog: the confirmation of one store rollout change: what the store shows now, what it will
  show after, the warnings of the server, and for a change that cannot be undone (release to all, release to
  100%) a typed confirmation. It sends nothing itself: `onconfirm` is called once, with the preview's hash.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an
  older one, or ''), onconfirm, oncancel.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import {
    IRREVERSIBLE_WARNING,
    LIVE_STORE_WARNING,
    type RolloutPreview,
    actionLabel,
    canConfirm,
    confirmPhrase,
    describeState,
  } from '../../lib/store-rollout.ts';
  import Alert from '../ui/Alert.svelte';
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
    preview: RolloutPreview;
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
  const ready = $derived(canConfirm(preview, typed, ack));
  const storeName = $derived(preview.app.platform === 'android' ? 'Google Play' : preview.app.platform === 'macos' ? 'the Mac App Store' : 'the App Store');
</script>

<Modal
  bind:open
  size="lg"
  title="{actionLabel(preview.action, preview.app.platform)}: confirm"
  description="{preview.app.name} · {storeName}"
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title="The store changed">{notice}</Alert>{/if}

    <Alert tone="warn" title={LIVE_STORE_WARNING}>
      This sends the change to {storeName} for {preview.app.name}. It is recorded in the audit log.
    </Alert>

    <p class="summary" data-testid="rollout-summary">{preview.summary}</p>

    <div class="compare" aria-label="Before and after">
      <div>
        <p class="label">Now, in the store</p>
        <p class="state">{describeState(preview.current)}</p>
      </div>
      <div>
        <p class="label">After this change</p>
        <p class="state">{describeState(preview.proposed)}</p>
      </div>
    </div>

    {#if preview.warnings.length > 0}
      <ul class="warnings">
        {#each preview.warnings as warning (warning)}<li>{warning}</li>{/each}
      </ul>
    {/if}

    {#if preview.irreversible}
      <Alert tone="error" title="This cannot be undone">{IRREVERSIBLE_WARNING}</Alert>
      <div class="field">
        <label for="{uid}-typed">Type <strong>{phrase}</strong> to confirm</label>
        <input id="{uid}-typed" type="text" autocomplete="off" spellcheck="false" bind:value={typed} disabled={busy} />
      </div>
    {/if}

    <label class="check">
      <input type="checkbox" bind:checked={ack} disabled={busy} />
      <span>I have read the change above and I want it made in {storeName} now.</span>
    </label>

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger-solid" loading={busy} disabled={!ready || busy} onclick={onconfirm}>
      {actionLabel(preview.action, preview.app.platform)}
    </Button>
  {/snippet}
</Modal>

<style>
  .summary {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .compare > div {
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .state {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .warnings {
    margin: 0;
    padding-left: var(--space-5);
    font-size: var(--text-sm);
  }
</style>
