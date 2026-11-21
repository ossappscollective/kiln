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
    storeName,
    versionText,
  } from '../../lib/staged.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PushPreviewBody from '../publish/PushPreviewBody.svelte';
import { platformMeta } from '@kiln/core';

  let {
    open = $bindable(false),
    preview,
    busy,
    problem,
    notice,
    onconfirm,
    oncancel,
  }: {
    open?: boolean | undefined;
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
  title="Push to the {platformMeta(preview.app.platform).storeName} draft: confirm"
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

    <PushPreviewBody {preview} />

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
