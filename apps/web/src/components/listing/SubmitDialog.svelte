<!--
  SubmitDialog: the confirmation of ONE submit of a pushed draft to the store's review. It shows what goes to
  review (version, build, contents per locale, the Google Play tracks, read only), what cannot be undone in
  plain words, the checks (a blocking item blocks the button; warnings are listed), a clear statement that this
  goes to the store's review and is NOT released or published by this tool, and a typed phrase that must equal
  the preview's phrase exactly as the server gave it.
  It sends nothing itself: `onconfirm(typed)` is called once per click and the parent sends the preview's hash
  and the typed text. While anything blocks the preview has no hash and no phrase; then there is no input.
  Props: open (bindable), preview, busy, problem (a sentence or ''), notice (why this preview replaced an older
  one, or ''), onconfirm, oncancel.
  Give it a {#key preview.confirmHash} so a new preview starts with an empty confirmation.
-->
<script lang="ts">
  import {
    type SubmitPreview,
    canConfirmSubmit,
    releaseStatement,
    storeLabel,
    versionLine,
  } from '../../lib/store-submit.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import SubmitPreviewBody from '../publish/SubmitPreviewBody.svelte';

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
    preview: SubmitPreview;
    busy: boolean;
    problem: string;
    notice: string;
    onconfirm: (typed: string) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  let typed = $state('');

  const ready = $derived(canConfirmSubmit(preview, typed));
  const blocking = $derived(preview.checks.blocking);
  const ios = $derived(preview.app.platform !== 'android');
</script>

<Modal
  bind:open
  size="lg"
  title="Submit for {storeLabel(preview.app.platform)}: confirm"
  description="{preview.app.name} · {versionLine(preview)}"
  dismissible={!busy}
  onclose={oncancel}
>
  <div class="stack">
    {#if notice}<Alert tone="warn" title="Something changed">{notice}</Alert>{/if}

    <Alert tone="warn" title="This goes to the store's review and cannot be taken back from here.">
      <p class="para">{releaseStatement(preview.app.platform)}</p>
      <p class="para">{ios ? 'A submission is cancelled only in App Store Connect.' : 'A review is cancelled only in Play Console.'} It is recorded in the audit log.</p>
    </Alert>

    <SubmitPreviewBody {preview} />

    {#if preview.confirmation !== null && blocking.length === 0}
      <div class="field">
        <label for="{uid}-typed">Type <strong class="phrase">{preview.confirmation.phrase}</strong> to confirm</label>
        {#if preview.confirmation.instruction}<p class="muted small">{preview.confirmation.instruction}</p>{/if}
        <input id="{uid}-typed" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={busy} />
      </div>
    {/if}

    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{blocking.length > 0 ? 'Close' : 'Cancel'}</Button>
    <Button
      variant="danger-solid"
      icon="upload"
      loading={busy}
      disabled={!ready || busy}
      onclick={() => onconfirm(typed)}
    >Submit for review</Button>
  {/snippet}
</Modal>

<style>
  .para {
    margin: var(--space-1) 0 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .phrase {
    overflow-wrap: anywhere;
  }
</style>
